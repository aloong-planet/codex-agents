import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { ChannelTurnAdapter } from "../src/channel-turn-adapter.js";
import type { AppServerMessage, AppServerTransport } from "../src/codex-app-server-client.js";

// External App Server protocol shape is from the installed 0.166.0-alpha.5.1
// schema and the isolated live interruption probe. Fake clocks control only
// the documented recovery deadline. Real model and phone receipt are separate.
class Peer implements AppServerTransport {
  sent: AppServerMessage[] = [];
  message: (message: AppServerMessage) => void = () => {};
  exit: (error?: Error) => void = () => {};
  closed = false;
  turns = 0;
  missingContext = false;
  disconnectOnResume = false;
  initializationError = false;
  constructor(readonly index: number, readonly initialize = true) {}
  send(message: AppServerMessage): void {
    this.sent.push(message);
    if (message.method === "turn/start") this.turns++;
    queueMicrotask(() => {
      if (this.closed) return;
      if (message.method === "thread/resume" && this.disconnectOnResume) { this.disconnect(); return; }
      if (message.method === "initialize" && this.initialize) this.message(this.initializationError
        ? { id: message.id!, error: { code: -32600, message: "authentication required" } }
        : { id: message.id!, result: {} });
      if (message.method === "thread/resume") this.message(this.missingContext
        ? { id: message.id!, error: { code: -32600, message: "no rollout found for thread id" } }
        : { id: message.id!, result: { thread: { id: message.params!.threadId } } });
      if (message.method === "thread/read") this.message({ id: message.id!, result: { thread: { status: { type: "idle" } } } });
      if (message.method === "turn/start") this.message({ id: message.id!, result: { turn: { id: this.turnId } } });
    });
  }
  get turnId() { return `turn-${this.index}-${this.turns}`; }
  onMessage(listener: (message: AppServerMessage) => void) { this.message = listener; return () => {}; }
  onExit(listener: (error?: Error) => void) { this.exit = listener; return () => {}; }
  close() { this.closed = true; }
  disconnect() { this.closed = true; this.exit(new Error("process exited")); }
  complete(text: string) {
    this.message({ method: "item/completed", params: { threadId: "thread", turnId: this.turnId,
      item: { id: "answer", type: "agentMessage", phase: "final_answer", text } } });
    this.message({ method: "turn/completed", params: { threadId: "thread", turn: { id: this.turnId, status: "completed" } } });
  }
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe("automatic recovery lifecycle", () => {
  it("does not apply a retired turn's late error to the next request's recovery clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp");
      const first = agent.reply("thread", "first"); await flush(); peers[0]!.complete("done"); await first;
      peers[0]!.message({ method: "error", params: { threadId: "thread", turnId: peers[0]!.turnId, willRetry: false,
        error: { message: "late stream failure", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } });
      await vi.advanceTimersByTimeAsync(60_001);
      const second = agent.reply("thread", "second").catch(e => e); await flush();
      peers[0]!.disconnect(); await flush(); peers[1]!.complete("new request recovered");
      await expect(second).resolves.toBe("new request recovered");
    } finally { await agent.close(); }
  });
  it("does not restart after an explicit session receives an initialization error", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => {
      const p = new Peer(peers.length); p.initializationError = peers.length > 0; peers.push(p); return p;
    }, 600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp"); await agent.close();
      await expect(agent.startOrResume("thread", "/tmp")).rejects.toThrow("authentication required");
      await flush(); expect(peers).toHaveLength(2);
    } finally { await agent.close(); }
  });
  it("continues after another disconnect while restoring the saved thread", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => {
      const p = new Peer(peers.length); p.disconnectOnResume = peers.length === 1; peers.push(p); return p;
    }, 600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp");
      const result = agent.reply("thread", "first").catch(e => e); await flush();
      peers[0]!.disconnect(); await flush();
      expect(peers).toHaveLength(3);
      peers[2]!.complete("recovered after restoration failure");
      await expect(result).resolves.toBe("recovered after restoration failure");
      expect(peers.flatMap(p => p.sent).filter(m => m.method === "turn/start")).toHaveLength(2);
    } finally { await agent.close(); }
  });

  it("rechecks authorization after waiting for the replacement connection", async () => {
    const peers: Peer[] = []; let allowed = true;
    const agent = new CodexConversation(() => { const p = new Peer(peers.length, peers.length === 0); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp");
      const result = agent.runTurn("thread", new ChannelTurnAdapter("thread", {
        key: "event", accountId: "account", target: "target", messageId: "message", source: "text", text: "read file", receivedAt: 1,
      }, { accountMemory: "", outboundRoots: [], channelLabel: "微信", outboundDelivery: false,
        isClosing: () => false, recoveryAllowed: () => allowed })).catch(e => e);
      await flush(); peers[0]!.disconnect(); await flush();
      allowed = false;
      const initialize = peers[1]!.sent.find(m => m.method === "initialize")!;
      peers[1]!.message({ id: initialize.id!, result: {} }); await flush();
      expect(peers[1]!.sent.filter(m => m.method === "turn/start")).toEqual([]);
      await expect(result).resolves.toMatchObject({ message: "model_recovery_authorization_changed" });
    } finally { await agent.close(); }
  });
  it("reconnects while idle without user input and does not restart during close", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    await agent.startOrResume("thread", "/tmp");
    peers[0]!.disconnect(); await flush();
    expect(peers).toHaveLength(2);
    expect(peers[1]!.sent.map(m => m.method)).toEqual(["initialize", "initialized"]);
    await agent.close(); await flush(); expect(peers).toHaveLength(2);
  });

  it("bounds hung reconnects at three attempts within sixty seconds and permits a new explicit request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const peers: Peer[] = []; let available = true;
    const agent = new CodexConversation(() => { const p = new Peer(peers.length, available); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp");
      const outcome = agent.reply("thread", "first").catch(e => e as Error); await flush();
      available = false; peers[0]!.disconnect(); await flush();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(peers).toHaveLength(4);
      let settled = false; void outcome.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ message: "model_recovery_exhausted" });
      await vi.advanceTimersByTimeAsync(60_000); expect(peers).toHaveLength(4);
      available = true; await agent.startOrResume("thread", "/tmp");
      const next = agent.reply("thread", "new explicit message"); await flush(); peers.at(-1)!.complete("new result");
      await expect(next).resolves.toBe("new result");
    } finally { await agent.close(); }
  });

  it("stops an active recovery when the service closes", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length, peers.length === 0); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    await agent.startOrResume("thread", "/tmp");
    const outcome = agent.reply("thread", "first").catch(e => e as Error); await flush();
    peers[0]!.disconnect(); await flush();
    await agent.close(); await expect(outcome).resolves.toBeInstanceOf(Error);
    expect(peers).toHaveLength(2); expect(peers[1]!.closed).toBe(true);
  });

  it.each(["unauthorized", "usageLimitExceeded", "badRequest", "misalignmentPolicyViolation"])("does not retry %s", async code => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp");
      const outcome = agent.reply("thread", "first").catch(e => e as Error); await flush();
      peers[0]!.message({ method: "error", params: { threadId: "thread", turnId: peers[0]!.turnId, willRetry: false,
        error: { message: "reported failure", codexErrorInfo: code } } });
      await expect(outcome).resolves.toMatchObject({ message: "reported failure" });
      expect(peers).toHaveLength(1); expect(peers[0]!.sent.filter(m => m.method === "turn/start")).toHaveLength(1);
    } finally { await agent.close(); }
  });

  it("leaves upstream retry in progress alone and rejects old connection frames after recovery", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp");
      const result = agent.reply("thread", "first"); await flush();
      peers[0]!.message({ method: "error", params: { threadId: "thread", turnId: peers[0]!.turnId, willRetry: true,
        error: { message: "retrying", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } });
      await flush(); expect(peers).toHaveLength(1);
      peers[0]!.disconnect(); await flush(); expect(peers).toHaveLength(2);
      peers[0]!.complete("stale"); peers[0]!.exit(new Error("late exit"));
      peers[1]!.complete("recovered"); await expect(result).resolves.toBe("recovered");
    } finally { await agent.close(); }
  });

  it("does not continue after an untracked native tool has started", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length); peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp"); const result = agent.reply("thread", "first").catch(e => e); await flush();
      peers[0]!.message({ method: "item/started", params: { threadId: "thread", turnId: peers[0]!.turnId, item: { id: "mcp", type: "mcpToolCall" } } });
      peers[0]!.disconnect(); await expect(result).resolves.toBeInstanceOf(Error); await flush();
      expect(peers[1]!.sent.filter(m => m.method === "turn/start")).toEqual([]);
    } finally { await agent.close(); }
  });
  it("continues a terminal stream disconnect on the existing connection without duplicate upstream retries", async () => {
    const peer = new Peer(0);
    const agent = new CodexConversation(() => peer, 600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp"); const result = agent.reply("thread", "stream request"); await flush();
      peer.message({ method: "turn/completed", params: { threadId: "thread", turn: { id: peer.turnId, status: "failed",
        error: { message: "stream lost", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } } });
      await flush(); expect(peer.sent.filter(m => m.method === "turn/start")).toHaveLength(2);
      peer.complete("continued stream"); await expect(result).resolves.toBe("continued stream");
    } finally { await agent.close(); }
  });

  it("does not replace missing saved context with a new thread during automatic continuation", async () => {
    const peers: Peer[] = [];
    const agent = new CodexConversation(() => { const p = new Peer(peers.length); p.missingContext = peers.length > 0; peers.push(p); return p; },
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    try {
      await agent.startOrResume("thread", "/tmp"); const result = agent.reply("thread", "first").catch(e => e); await flush();
      peers[0]!.disconnect(); await expect(result).resolves.toMatchObject({ message: "no rollout found for thread id" });
      expect(peers).toHaveLength(2); expect(peers[1]!.sent.filter(m => m.method === "thread/start" || m.method === "turn/start")).toEqual([]);
    } finally { await agent.close(); }
  });

});
