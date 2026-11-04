import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexConversationClient, type ServerRequestHandle } from "../src/codex-conversation-client.js";
import type { AppServerMessage, AppServerTransport } from "../src/codex-app-server-client.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StdioAppServerTransport, type AppServerProcess } from "../src/stdio-app-server-transport.js";

class ProcessStreams extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}

class ProtocolTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  message: (message: AppServerMessage) => void = () => {};
  exit: (error?: Error) => void = () => {};
  failSend = false;
  closed = false;
  send(message: AppServerMessage): void {
    if (this.failSend) throw new Error("transport-write-failed");
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
}

async function initialize(client: CodexConversationClient, transport: ProtocolTransport): Promise<void> {
  const pending = client.initialize();
  await Promise.resolve();
  const message = [...transport.sent].reverse().find((value) => value.method === "initialize")!;
  transport.message({ id: message.id!, result: {} });
  await pending;
}

const clients: CodexConversationClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

function harness(transports = [new ProtocolTransport()]) {
  const requests: ServerRequestHandle[] = [];
  const failures: Error[] = [];
  const notifications: AppServerMessage[] = [];
  const queue = [...transports];
  const client = new CodexConversationClient(() => queue.shift()!, {
    notification: (value) => notifications.push(value),
    serverRequest: (value) => requests.push(value),
    failure: (value) => failures.push(value),
  });
  clients.push(client);
  return { client, requests, failures, notifications, transport: transports[0]! };
}

describe("CodexConversationClient protocol", () => {
  it("P04 rejects all waiters on actual JSONL parse failure without accepting later frames", async () => {
    const child = new ProcessStreams();
    const failures: Error[] = [];
    const requests: ServerRequestHandle[] = [];
    const client = new CodexConversationClient(() => new StdioAppServerTransport(child), {
      notification: () => {}, serverRequest: (value) => requests.push(value), failure: (error) => failures.push(error),
    });
    clients.push(client);
    const initialized = client.initialize();
    await Promise.resolve();
    child.stdout.write('{"id":1,"result":{}}\n');
    await initialized;
    const waiting = [client.request("one", {}), client.request("two", {})]
      .map((value) => value.catch((error: unknown) => error));
    child.stdout.write('not-json\n{"id":2,"result":"stale"}\n');
    child.emit("exit", 1, null);
    for (const pending of waiting) await expect(pending).resolves.toMatchObject({ message: "Codex App Server 返回了无效 JSONL 消息" });
    expect(failures).toHaveLength(1);
    expect(requests).toEqual([]);
    expect(client.ready).toBe(false);
    expect(child.killed).toBe(true);
  });

  it("P01 preserves an initialization error for all callers, including its original capabilities", async () => {
    const { client, transport, failures } = harness();
    const waiting = [client.initialize(), client.initialize()].map((value) => value.catch((error: unknown) => error));
    await Promise.resolve();
    expect(transport.sent).toEqual([{ id: 1, method: "initialize", params: {
      clientInfo: { name: "weixin_direct_demo", title: "Weixin Direct Demo", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } }]);
    transport.message({ id: 1, error: { message: "handshake-rejected" } });
    for (const pending of waiting) await expect(pending).resolves.toMatchObject({ message: "handshake-rejected" });
    expect(failures).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });

  it("P01 shares initialization, fails all callers at 20s and only reconnects on an explicit call", async () => {
    vi.useFakeTimers();
    const next = new ProtocolTransport();
    const { client, transport, failures } = harness([new ProtocolTransport(), next]);
    const first = client.initialize().catch((error: unknown) => error);
    const second = client.initialize().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(transport.sent.filter((value) => value.method === "initialize")).toHaveLength(1);
    expect(failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    for (const pending of [first, second]) {
      await expect(pending).resolves.toMatchObject({ message: "Codex App Server 请求超时：initialize" });
    }
    expect(failures).toHaveLength(1);
    expect(next.sent).toEqual([]);
    expect(transport.closed).toBe(true);
    await initialize(client, next);
    transport.exit(new Error("old-exit"));
    expect(client.ready).toBe(true);
    expect(next.sent.map((value) => value.method)).toEqual(["initialize", "initialized"]);
  });

  it("P02/P03 isolates both directions and number/string IDs, retaining duplicate protection after RPC settlement", async () => {
    const { client, transport, requests } = harness();
    await initialize(client, transport);
    const first = client.request("first", {}).catch((error: unknown) => error);
    const second = client.request("second", {}).catch((error: unknown) => error);
    expect(transport.sent.filter((value) => value.method === "first").map((value) => value.id)).toEqual([2]);
    const numberRequest = { id: 2, method: "item/tool/call", params: { tool: "read" } };
    transport.message(numberRequest);
    transport.message({ ...numberRequest, id: "2" });
    transport.message(numberRequest);
    expect(requests).toHaveLength(2);
    transport.message({ id: 3, error: { code: -1, message: "second-rejected" } });
    transport.message({ id: 2, result: "first-result" });
    transport.message({ id: 2, error: { message: "late-response" } });
    await expect(first).resolves.toBe("first-result");
    await expect(second).resolves.toMatchObject({ message: "second-rejected" });
    expect(requests[1]!.respond({ id: "wrong-id", result: "string-response" })).toBe(true);
    expect(requests[0]!.respond({ result: "number-response" })).toBe(true);
    transport.message(numberRequest);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.respond({ result: "duplicate-response" })).toBe(false);
    expect(transport.sent.filter((value) => !value.method)).toEqual([
      { id: "2", result: "string-response" }, { id: 2, result: "number-response" },
    ]);
  });

  it("P04 settles every outstanding request once on response delivery failure without redispatch", async () => {
    const { client, transport, requests, failures } = harness();
    await initialize(client, transport);
    const waiting = [client.request("first", {}), client.request("second", {})]
      .map((value) => value.catch((error: unknown) => error));
    const request = { id: "effect", method: "item/tool/call", params: {} };
    transport.message(request);
    transport.failSend = true;
    expect(requests[0]!.respond({ result: "effect-already-completed" })).toBe(false);
    transport.message(request);
    transport.exit(new Error("second-failure"));
    for (const pending of waiting) await expect(pending).resolves.toMatchObject({ message: "transport-write-failed" });
    expect(requests).toHaveLength(1);
    expect(failures.map((error) => error.message)).toEqual(["transport-write-failed"]);
    expect(requests[0]!.respond({ result: "retry" })).toBe(false);
    expect(client.ready).toBe(false);
  });

  it("P04 closes and rejects outstanding RPCs when sending a new request throws", async () => {
    const { client, transport, failures } = harness();
    await initialize(client, transport);
    const waiting = client.request("waiting", {}).catch((error: unknown) => error);
    transport.failSend = true;
    await expect(client.request("cannot-send", {})).rejects.toThrow("transport-write-failed");
    await expect(waiting).resolves.toMatchObject({ message: "transport-write-failed" });
    expect(failures).toHaveLength(1);
    expect(transport.closed).toBe(true);
  });

  it("P06 expires RPCs at 600s independently and removes settled deadlines", async () => {
    vi.useFakeTimers();
    const { client, transport, failures } = harness();
    await initialize(client, transport);
    const completed = client.request("completed", {});
    transport.message({ id: 2, result: "done" });
    await expect(completed).resolves.toBe("done");
    let settled = false;
    const stalled = client.request("stalled", {}).catch((error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stalled).resolves.toMatchObject({ message: "Codex App Server 请求超时：stalled" });
    transport.message({ id: 3, result: "late" });
    expect(failures).toEqual([]);
    expect(client.ready).toBe(true);
    expect(transport.sent.map((value) => value.method)).toEqual(["initialize", "initialized", "completed", "stalled"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
