import { describe, expect, it } from "vitest";
import { CodexConversation, type CodexTurnEvent } from "../src/codex-conversation.js";
import { FixtureAppServerTransport, type FixtureModelToolCall } from "../src/fixture-app-server-transport.js";
import type { AppServerMessage } from "../src/codex-app-server-client.js";

function fixture(calls: FixtureModelToolCall[] = []) {
  const sent: AppServerMessage[] = [];
  const received: AppServerMessage[] = [];
  const transport = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => calls.shift() });
  const conversation = new CodexConversation(() => ({
    send(message) { sent.push(structuredClone(message)); transport.send(message); },
    onMessage(listener) { return transport.onMessage((message) => { received.push(structuredClone(message)); listener(message); }); },
    onExit: (listener) => transport.onExit(listener),
    close: () => transport.close(),
  }));
  return { conversation, sent, received };
}

// A real installed App Server sample (2026-09-16) supplies namespace/tool/arguments,
// numeric request IDs, final_answer items and turn/completed. This peer retains
// those consumed fields and also exercises string IDs; it does not test model
// semantics, network streaming, or real WeChat receipt (use the opt-in live suites).
describe("fixture model through the production conversation", () => {
  it("collects authoritative completion through the production protocol entry", async () => {
    const { conversation, sent, received } = fixture();
    try {
      const events: CodexTurnEvent[] = [];
      const thread = await conversation.startOrResume(undefined, "/tmp");
      const reply = await conversation.runTurn(thread, "你好", undefined, (event) => { events.push(event); });
      expect(reply).toEqual({ owner: "model_owned", finalText: JSON.stringify({ message: "这是 fixture Codex 回复。", results: [] }) });
      expect(events.map((event) => event.kind)).toContain("agent_message_delta");
      expect(events.filter((event) => event.kind === "turn_completed")).toEqual([{ kind: "turn_completed", status: "completed" }]);
      expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
      expect(received.at(-1)).toMatchObject({ method: "turn/completed", params: { threadId: thread, turn: { status: "completed" } } });
    } finally { await conversation.close(); }
  });

  it("uses the production input and policy serialization on every turn and isolates observer failure", async () => {
    const { conversation, sent } = fixture();
    try {
      const thread = await conversation.startOrResume(undefined, "/tmp");
      const input = [{ type: "text" as const, text: "用户消息" }, { type: "localImage" as const, path: "/tmp/input.png" }];
      for (let n = 0; n < 2; n++) {
        await expect(conversation.runTurn(thread, input, { revision: 3, approvalPolicy: "never", permissions: ":read-only" },
          () => { throw new Error("observer unavailable"); },
          { model: "fixture-model", effort: "low", outputSchema: { type: "object" } })).resolves.toMatchObject({ owner: "model_owned", finalText: expect.stringContaining("fixture Codex") });
      }
      expect(sent.filter((message) => message.method === "turn/start").map((message) => message.params)).toEqual([
        { threadId: thread, input: [{ type: "text", text: "用户消息" }, { type: "localImage", path: "/tmp/input.png" }], model: "fixture-model", effort: "low", outputSchema: { type: "object" }, approvalPolicy: "never", permissions: ":read-only" },
        { threadId: thread, input: [{ type: "text", text: "用户消息" }, { type: "localImage", path: "/tmp/input.png" }], model: "fixture-model", effort: "low", outputSchema: { type: "object" }, approvalPolicy: "never", permissions: ":read-only" },
      ]);
    } finally { await conversation.close(); }
  });

  it("returns unsupported tool failures under the original request IDs without ending the scripted model turn", async () => {
    const { conversation, sent, received } = fixture([
      { namespace: "missing", tool: "one", arguments: {} },
      { namespace: "missing", tool: "two", arguments: {} },
    ]);
    try {
      const thread = await conversation.startOrResume(undefined, "/tmp");
      await expect(conversation.runTurn(thread, "继续处理")).resolves.toMatchObject({ owner: "model_owned", finalText: expect.stringContaining("fixture Codex") });
      const requests = received.filter((message) => message.method === "item/tool/call");
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => typeof request.id)).toEqual(["number", "string"]);
      for (const request of requests) expect(sent.filter((message) => message.id === request.id)).toEqual([
        { id: request.id, result: { contentItems: [], success: false } },
      ]);
      expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
      expect(received.at(-1)).toMatchObject({ method: "turn/completed", params: { turn: { status: "completed" } } });
    } finally { await conversation.close(); }
  });
});
