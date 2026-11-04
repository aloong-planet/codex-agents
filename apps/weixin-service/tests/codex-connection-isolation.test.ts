import { describe, expect, it } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import type { AppServerMessage, AppServerTransport } from "../src/codex-app-server-client.js";
import type { DynamicToolResult } from "../src/dynamic-tool-host.js";

// External protocol seam. Retained callbacks model frames/exit already queued before unsubscribe.
class ControlledTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  message: (message: AppServerMessage) => void = () => {};
  exit: (error?: Error) => void = () => {};
  closed = false;
  failResponses = false;
  send(message: AppServerMessage): void {
    if (this.failResponses && !message.method) throw new Error("response-write-failed");
    this.sent.push(message);
  }
  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.message = listener;
    return () => {};
  }
  onExit(listener: (error?: Error) => void): () => void {
    this.exit = listener;
    return () => {};
  }
  close(): void { this.closed = true; }
  respond(method: string, result: unknown): void {
    const request = [...this.sent].reverse().find((message) => message.method === method);
    if (!request) throw new Error(`Missing request: ${method}`);
    this.message({ id: request.id!, result });
  }
  complete(text: string): void {
    this.message({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
      id: "final", type: "agentMessage", phase: "final_answer", text,
    } } });
    this.message({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  }
}

async function flush(): Promise<void> {
  // Drain promise continuations; no timers or private-state manipulation.
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

async function start(conversation: CodexConversation, transport: ControlledTransport): Promise<void> {
  const starting = conversation.startOrResume("thread", "/workspace");
  await flush();
  transport.respond("initialize", {});
  await flush();
  transport.respond("thread/resume", { thread: { id: "thread" } });
  await starting;
}

describe("connection isolation through CodexConversation", () => {
  it.each(["initialize", "thread/resume"])("D06 observes close during %s and rejects late session acquisition", async (stage) => {
    const old = new ControlledTransport();
    const next = new ControlledTransport();
    const transports = [old, next];
    const conversation = new CodexConversation(() => transports.shift()!);
    try {
      const starting = conversation.startOrResume("thread", "/workspace").catch((error: unknown) => error);
      await flush();
      if (stage === "thread/resume") {
        old.respond("initialize", {});
        await flush();
      }
      const closing = conversation.close();
      expect(conversation.close()).toBe(closing);
      old.respond(stage, stage === "initialize" ? {} : { thread: { id: "thread" } });
      await closing;
      await expect(starting).resolves.toBeInstanceOf(Error);
      expect(old.closed).toBe(true);
      expect(old.sent.filter((message) => message.method === "turn/start")).toEqual([]);
      if (stage === "initialize") expect(old.sent.filter((message) => message.method === "thread/resume")).toEqual([]);
      await expect(conversation.reply("thread", "late")).rejects.toThrow();
      await start(conversation, next);
      const reply = conversation.reply("thread", "fresh");
      next.respond("turn/start", { turn: { id: "turn" } });
      await flush();
      next.complete("fresh-result");
      await expect(reply).resolves.toBe("fresh-result");
    } finally { await conversation.close(); }
  });

  it("D05 retains the final result but prevents permission reuse when finalization fails", async () => {
    const transport = new ControlledTransport();
    const events: unknown[] = [];
    const conversation = new CodexConversation(() => transport, 600_000, undefined, {
      request: async () => ({}), complete: () => { throw new Error("permission release failed"); },
    });
    try {
      await start(conversation, transport);
      const reply = conversation.reply("thread", "done", undefined, (event) => events.push(event));
      void reply.catch(() => {});
      transport.respond("turn/start", { turn: { id: "turn" } });
      await flush();
      transport.complete("actual-result");
      await expect(reply).resolves.toBe("actual-result");
      expect(events).toContainEqual({ kind: "turn_cleanup", phase: "end", errorCode: "permission_cleanup_failed" });
      await expect(conversation.reply("thread", "next")).rejects.toThrow("permission_cleanup_failed");
    } finally { await conversation.close(); }
  });

  it("D04 waits for an admitted permission request and its asynchronous finalization before releasing the turn", async () => {
    const transport = new ControlledTransport();
    let grant!: (value: Record<string, unknown>) => void;
    let finalize!: () => void;
    let finalized = false;
    const conversation = new CodexConversation(() => transport, 600_000, undefined, {
      request: () => new Promise((resolve) => { grant = resolve; }),
      complete: () => new Promise<void>((resolve) => { finalize = () => { finalized = true; resolve(); }; }),
    });
    await start(conversation, transport);
    let settled = false;
    const events: unknown[] = [];
    const reply = conversation.reply("thread", "permission", undefined, (event) => events.push(event));
    void reply.then(() => { settled = true; }, () => { settled = true; });
    transport.respond("turn/start", { turn: { id: "turn" } });
    await flush();
    transport.message({ id: 9, method: "item/permissions/requestApproval", params: { threadId: "thread", turnId: "turn" } });
    transport.complete("done");
    await flush();
    try {
      expect(settled).toBe(false);
      expect(events).toContainEqual({ kind: "turn_cleanup", phase: "start" });
      expect(events).not.toContainEqual({ kind: "turn_cleanup", phase: "end" });
      await expect(conversation.reply("thread", "next")).rejects.toThrow("上一条消息");
      grant({ permissions: {} });
      await flush();
      expect(settled).toBe(false);
      expect(finalized).toBe(false);
      finalize();
      await expect(reply).resolves.toBe("done");
      expect(finalized).toBe(true);
      expect(events).toContainEqual({ kind: "turn_cleanup", phase: "end" });
    } finally {
      grant({ permissions: {} });
      await flush();
      finalize?.();
      await conversation.close();
    }
  });

  it("P04 does not publish completed after a connection fails while settling outstanding tool requests", async () => {
    const transport = new ControlledTransport();
    let finish!: (result: DynamicToolResult) => void;
    const conversation = new CodexConversation(() => transport, 600_000, {
      definitions: () => [], execute: () => new Promise((resolve) => { finish = resolve; }),
    });
    const events: unknown[] = [];
    try {
      await start(conversation, transport);
      const reply = conversation.reply("thread", "tool", undefined, (event) => events.push(event))
        .catch((error: unknown) => error);
      transport.respond("turn/start", { turn: { id: "turn" } });
      await flush();
      transport.message({ id: "pending", method: "item/tool/call", params: {
        threadId: "thread", turnId: "turn", namespace: "files", tool: "find", arguments: {},
      } });
      transport.failResponses = true;
      transport.complete("done");
      finish({ success: true, contentItems: [] });
      await expect(reply).resolves.toMatchObject({ message: "response-write-failed" });
      expect(events).not.toContainEqual({ kind: "turn_completed", status: "completed" });
    } finally { finish?.({ success: true, contentItems: [] }); await conversation.close(); }
  });

  it("P05 keeps late tool completion and queued old frames off a replacement connection with reused IDs", async () => {
    const old = new ControlledTransport();
    const next = new ControlledTransport();
    const transports = [old, next];
    const finishes: Array<(result: DynamicToolResult) => void> = [];
    const conversation = new CodexConversation(() => transports.shift()!, 600_000, {
      definitions: () => [],
      execute: () => new Promise((resolve) => finishes.push(resolve)),
    });
    const request: AppServerMessage = { id: 7, method: "item/tool/call", params: {
      threadId: "thread", turnId: "turn", namespace: "files", tool: "find", arguments: {},
    } };
    try {
      await start(conversation, old);
      const prior = conversation.reply("thread", "old").catch((error: unknown) => error);
      old.respond("turn/start", { turn: { id: "turn" } });
      await flush();
      old.message(request);
      const closing = conversation.close();
      expect(conversation.close()).toBe(closing);
      let closed = false;
      void closing.then(() => { closed = true; });
      await flush();
      expect(closed).toBe(false);
      finishes[0]!({ success: true, contentItems: [{ type: "inputText", text: "old-result" }] });
      await closing;
      await expect(prior).resolves.toBeInstanceOf(Error);

      await start(conversation, next);
      const current = conversation.reply("thread", "new");
      const currentOutcome = current.catch((error: unknown) => error);
      next.respond("turn/start", { turn: { id: "turn" } });
      await flush();
      next.message(request);
      expect(finishes).toHaveLength(2);
      await flush();
      expect(next.sent.filter((message) => message.id === 7 && !message.method)).toEqual([]);
      old.complete("stale-final");
      old.exit(new Error("stale-exit"));
      finishes[1]!({ success: true, contentItems: [{ type: "inputText", text: "new-result" }] });
      await flush();
      expect(next.sent.filter((message) => message.id === 7 && !message.method)).toEqual([
        { id: 7, result: { success: true, contentItems: [{ type: "inputText", text: "new-result" }] } },
      ]);
      next.complete("new-final");
      await expect(currentOutcome).resolves.toBe("new-final");
      expect(next.closed).toBe(false);
    } finally {
      for (const finish of finishes) finish({ success: true, contentItems: [] });
      await conversation.close();
    }
  });
});
