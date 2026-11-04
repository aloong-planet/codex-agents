import { afterEach, expect, it, vi } from "vitest";
import { CodexConversation, type CodexTurnEvent } from "../src/codex-conversation.js";
import type { AppServerMessage, AppServerTransport } from "../src/codex-app-server-client.js";

// The production facade and protocol transport are the seam; no private state mutation.
class ControlledTransport implements AppServerTransport {
  sent: AppServerMessage[] = [];
  emit: (message: AppServerMessage) => void = () => {};
  exit: (error?: Error) => void = () => {};
  send(message: AppServerMessage): void {
    this.sent.push(message);
    if (message.method === "initialize" || message.method === "thread/start") {
      queueMicrotask(() => this.emit({ id: message.id!, result: message.method === "initialize" ? {} : { thread: { id: "thread" } } }));
    }
  }
  onMessage(listener: (message: AppServerMessage) => void): () => void { this.emit = listener; return () => {}; }
  onExit(listener: (error?: Error) => void): () => void { this.exit = listener; return () => {}; }
  close(): void {}
  accept(id = "turn"): void {
    const start = this.sent.filter((message) => message.method === "turn/start").at(-1)!;
    this.emit({ id: start.id!, result: { turn: { id } } });
  }
  final(text = "answer", turnId = "turn", phase = "final_answer"): void {
    this.emit({ method: "item/completed", params: { threadId: "thread", turnId, item: { type: "agentMessage", text, phase } } });
  }
  complete(status = "completed", id = "turn"): void {
    this.emit({ method: "turn/completed", params: { threadId: "thread", turn: { id, status } } });
  }
}

afterEach(() => vi.useRealTimers());

it("D05/D06 preparation cleanup failure is diagnosed and prevents reuse of the unsafe lease", async () => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  const events: CodexTurnEvent[] = [];
  await conversation.startOrResume(undefined, "/workspace");
  try {
    await expect(conversation.runTurn("thread", { prepare: async () => {
      throw new AggregateError([new Error("bind failed"), new Error("release failed")], "partial cleanup failed");
    } }, undefined, (event) => events.push(event))).rejects.toThrow("partial cleanup failed");
    expect(events).toContainEqual({ kind: "binding_cleanup", phase: "end", errorCode: "workflow_tool_release_failed" });
    await expect(conversation.runTurn("thread", "next")).rejects.toThrow();
    expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(0);
  } finally { await conversation.close(); }
});

it("D04/D10 closing during preparation waits for and releases late resources without starting a turn", async () => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => { ready = resolve; });
  const order: string[] = [];
  const result = conversation.runTurn("thread", {
    prepare: async () => {
      order.push("prepare"); await waiting;
      return { input: [{ type: "text" as const, text: "hello" }],
        binding: {
          seal: () => { order.push("seal"); }, drain: async () => { order.push("drain"); },
          snapshot: () => ({ owner: "model" as const }),
          release: async () => { order.push("release"); },
        } };
    },
  }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(order).toEqual(["prepare"]));
  let closed = false;
  const closing = conversation.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  ready();
  expect(await result).toBeInstanceOf(Error);
  await closing;
  expect(order).toEqual(["prepare", "seal", "drain", "release"]);
  expect(transport.sent.filter((message) => message.method === "turn/start")).toEqual([]);
});

it("F1 public runTurn returns typed model output rather than an empty-string ownership sentinel", async () => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  try {
    expect(typeof conversation.runTurn).toBe("function");
    const result = conversation.runTurn("thread", "hello");
    transport.accept(); transport.final(); transport.complete();
    await expect(result).resolves.toEqual({ owner: "model_owned", finalText: "answer" });
  } finally { await conversation.close(); }
});

it("D13 observer failures cannot alter progress, cleanup, or the final result", async () => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  const observed: CodexTurnEvent[] = [];
  await conversation.startOrResume(undefined, "/workspace");
  try {
    const reply = conversation.reply("thread", "hello", undefined, (event) => {
      observed.push(event);
      throw new Error("diagnostic observer unavailable");
    });
    transport.accept(); transport.final(); transport.complete();
    await expect(reply).resolves.toBe("answer");
    expect(observed).toEqual(expect.arrayContaining([
      { kind: "turn_submitted" }, { kind: "turn_accepted" },
      { kind: "turn_cleanup", phase: "start" }, { kind: "turn_cleanup", phase: "end" },
      { kind: "turn_completed", status: "completed" },
    ]));
  } finally { await conversation.close(); }
});

it("D03 rejects retired-turn tool requests while a new start identity is still pending", async () => {
  const transport = new ControlledTransport();
  const executed: string[] = [];
  const conversation = new CodexConversation(() => transport, 600_000, {
    definitions: () => [], execute: async (name) => { executed.push(name); return { success: true, contentItems: [] }; },
  });
  await conversation.startOrResume(undefined, "/workspace");
  const first = conversation.reply("thread", "first");
  transport.accept(); transport.final(); transport.complete();
  await first;
  const second = conversation.reply("thread", "second").catch((error: unknown) => error);
  transport.emit({ id: "late-old-tool", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", namespace: "files", tool: "write", arguments: {} } });
  transport.final("old tail"); transport.complete();
  transport.accept("new-turn");
  await Promise.resolve();
  transport.final("new answer", "new-turn"); transport.complete("completed", "new-turn");
  try {
    expect(executed).toEqual([]);
    await expect(second).resolves.toBe("new answer");
    expect(transport.sent.filter((message) => message.id === "late-old-tool")).toEqual([{ id: "late-old-tool", result: { success: false, contentItems: [] } }]);
  } finally { await conversation.close(); }
});

it("D03 retains matching early completion and ignores late callbacks after idle cleanup", async () => {
  vi.useFakeTimers();
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  const early = conversation.reply("thread", "hello");
  transport.final(); transport.complete(); transport.accept();
  await expect(early).resolves.toBe("answer");
  const events: CodexTurnEvent[] = [];
  const stalled = conversation.reply("thread", "again", undefined, (event) => events.push(event)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(300_000);
  await expect(stalled).resolves.toMatchObject({ message: "Codex 回合无进展超时" });
  transport.accept("late"); transport.final("late", "late"); transport.complete("completed", "late");
  await vi.advanceTimersByTimeAsync(600_000);
  expect(events.filter((event) => event.kind === "turn_accepted")).toEqual([]);
  expect(events.filter((event) => event.kind === "turn_completed")).toEqual([{ kind: "turn_completed", status: "failed" }]);
  expect(transport.sent.filter((message) => message.method === "turn/interrupt")).toEqual([]);
  await conversation.close();
});

it("D11 supports progress beyond 300 seconds but unrelated events cannot renew idle", async () => {
  vi.useFakeTimers();
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  let settled = false;
  const outcome = conversation.reply("thread", "long task").catch((error: unknown) => error).finally(() => { settled = true; });
  transport.emit({ method: "thread/status/changed", params: { threadId: "thread", turnId: "not-a-turn" } });
  transport.accept();
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(250_000);
    transport.emit({ method: "item/reasoning/textDelta", params: { threadId: "thread", turnId: "turn", delta: "progress" } });
    expect(settled).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(299_999);
  for (const params of [{ threadId: "other", turnId: "turn" }, { threadId: "thread", turnId: "old-turn" }, { threadId: "thread" }]) {
    transport.emit({ method: "item/completed", params: { ...params, item: { type: "reasoning" } } });
  }
  transport.emit({ method: "thread/status/changed", params: { threadId: "thread", turnId: "turn" } });
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(outcome).resolves.toMatchObject({ message: "Codex 回合无进展超时" });
  expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
  expect(transport.sent.filter((message) => message.method === "turn/interrupt")).toEqual([]);
  await conversation.close();
});

it.each(["completed", "failed", "interrupted", "disconnected"])("D18 final text is only a candidate until authoritative %s", async (status) => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  let settled = false;
  const outcome = conversation.reply("thread", "hello").catch((error: unknown) => error).finally(() => { settled = true; });
  transport.accept(); transport.final();
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  if (status === "disconnected") transport.exit(new Error("peer disconnected"));
  else transport.complete(status);
  try {
    if (status === "completed") await expect(outcome).resolves.toBe("answer");
    else await expect(outcome).resolves.toBeInstanceOf(Error);
  } finally { await conversation.close(); }
});

it("D17 an explicit non-retry error cannot become a successful turn", async () => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  const outcome = conversation.reply("thread", "hello").catch((error: unknown) => error);
  transport.accept(); await Promise.resolve();
  transport.emit({ method: "error", params: { threadId: "thread", turnId: "turn", willRetry: false, error: { message: "model failed" } } });
  transport.final(); transport.complete();
  try { await expect(outcome).resolves.toBeInstanceOf(Error); }
  finally { await conversation.close(); }
});

it("D03 retains an early final and completion but rejects a conflicting start identity", async () => {
  const transport = new ControlledTransport();
  const conversation = new CodexConversation(() => transport);
  await conversation.startOrResume(undefined, "/workspace");
  const events: CodexTurnEvent[] = [];
  const outcome = conversation.reply("thread", "hello", undefined, (event) => events.push(event)).catch((error: unknown) => error);
  transport.final();
  transport.complete();
  await Promise.resolve();
  transport.accept("different-turn");
  try {
    await expect(outcome).resolves.toMatchObject({ message: "Codex turn 启动身份冲突" });
    expect(events.filter((event) => event.kind === "turn_completed")).toEqual([{ kind: "turn_completed", status: "failed" }]);
  } finally { await conversation.close(); }
});
