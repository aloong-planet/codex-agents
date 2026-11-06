import { expect, it, vi } from "vitest";
import { CodexDispatchClassifier } from "../src/agent-dispatch-classifier.js";
import type { DispatchClassificationInput } from "../src/agent-dispatch-types.js";
import type { CodexConversation } from "../src/codex-conversation.js";
import type { AppServerTurnResult } from "../src/app-server-turn-driver.js";

// Exercise the production coordinator wrapper; only the external runtime response is substituted.
// Response shape follows observed Codex model_owned JSON output. Live role semantics and platform receipt remain separate acceptance.
const input: DispatchClassificationInput = {
  event: { key: "request-one", accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_owner",
    conversationType: "group", messageId: "om_one", source: "text", text: "帮我整理商品文案", receivedAt: 1 },
  agents: [{ id: "sam", name: "Sam", responsibility: "协调" }, { id: "alice", name: "Alice", responsibility: "商品运营" }],
  requests: [], memory: "",
};
function runtime(response: AppServerTurnResult) {
  return {
    startOrResume: vi.fn<CodexConversation["startOrResume"]>().mockResolvedValue("coordinator-thread"),
    runTurn: vi.fn<CodexConversation["runTurn"]>().mockResolvedValue(response),
    releaseThread: vi.fn<CodexConversation["releaseThread"]>(),
    close: vi.fn<CodexConversation["close"]>().mockResolvedValue(undefined),
  };
}

it("decodes a real coordinator JSON result through a tool-free constrained turn and releases its thread", async () => {
  const external = runtime({ owner: "model_owned", finalText: '{"kind":"dispatch","agentId":"alice","requestId":null,"summary":"整理商品文案","message":""}' });
  const classifier = new CodexDispatchClassifier(external, "/isolated/coordinator", () => ({ model: "fixture-model", effort: "low" }));
  await expect(classifier.classify(input)).resolves.toEqual({ kind: "dispatch", agentId: "alice", requestId: null, summary: "整理商品文案", message: "" });
  expect(external.startOrResume).toHaveBeenCalledWith(undefined, "/isolated/coordinator", []);
  expect(external.runTurn).toHaveBeenCalledWith("coordinator-thread", expect.any(String), undefined, undefined, expect.objectContaining({
    model: "fixture-model", effort: "low", outputSchema: expect.objectContaining({ type: "object", additionalProperties: false,
      required: ["kind", "agentId", "requestId", "summary", "message"] }),
  }));
  expect(external.runTurn.mock.calls[0]![1]).toContain("帮我整理商品文案");
  expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("coordinator-thread");
});

it.each([
  { name: "malformed JSON", response: { owner: "model_owned", finalText: "{broken" }, error: SyntaxError },
  { name: "oversized valid JSON", response: { owner: "model_owned", finalText: '{"kind":"ignore","agentId":null,"requestId":null,"summary":"","message":""}' + " ".repeat(16_001) }, error: "dispatch_decision_invalid" },
  { name: "workflow ownership", response: { owner: "workflow_owned", receipt: { outcome: "accepted", reply: "not a coordinator decision" } }, error: "dispatch_decision_invalid" },
] satisfies Array<{ name: string; response: AppServerTurnResult; error: string | typeof SyntaxError }>)("rejects $name and releases the coordinator thread", async ({ response, error }) => {
  const external = runtime(response);
  const classifier = new CodexDispatchClassifier(external, "/isolated/coordinator", () => ({ model: "fixture-model", effort: "low" }));
  await expect(classifier.classify(input)).rejects.toThrow(error);
  expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("coordinator-thread");
});

it("preserves an external model failure and releases the temporary coordinator thread", async () => {
  const external = runtime({ owner: "model_owned", finalText: "" });
  external.runTurn.mockRejectedValueOnce(new Error("model_transport_disconnected"));
  const classifier = new CodexDispatchClassifier(external, "/isolated/coordinator", () => ({ model: "fixture-model", effort: "low" }));
  await expect(classifier.classify(input)).rejects.toThrow("model_transport_disconnected");
  expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("coordinator-thread");
});
