import { expect, it, vi } from "vitest";
import { CodexDispatchClassifier, parseCrossTeamDecision } from "../src/agent-dispatch-classifier.js";
import type { CrossTeamInput, DispatchClassificationInput } from "../src/agent-dispatch-types.js";
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
  const classifier = new CodexDispatchClassifier((work) => work(external, "/isolated/coordinator"), () => ({ model: "fixture-model", effort: "low" }));
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
  const classifier = new CodexDispatchClassifier((work) => work(external, "/isolated/coordinator"), () => ({ model: "fixture-model", effort: "low" }));
  await expect(classifier.classify(input)).rejects.toThrow(error);
  expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("coordinator-thread");
});

it("preserves an external model failure and releases the temporary coordinator thread", async () => {
  const external = runtime({ owner: "model_owned", finalText: "" });
  external.runTurn.mockRejectedValueOnce(new Error("model_transport_disconnected"));
  const classifier = new CodexDispatchClassifier((work) => work(external, "/isolated/coordinator"), () => ({ model: "fixture-model", effort: "low" }));
  await expect(classifier.classify(input)).rejects.toThrow("model_transport_disconnected");
  expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("coordinator-thread");
});

const ignore: AppServerTurnResult = { owner: "model_owned", finalText: '{"kind":"ignore","agentId":null,"requestId":null,"summary":"","message":""}' };
const contract = (prompt: string) => prompt.split("\n").slice(0, -1).join("\n"); // the prompt without its trailing input JSON

it("names the Coordinator from the roster and adds its profile instructions", async () => {
  const external = runtime(ignore);
  const classifier = new CodexDispatchClassifier((work) => work(external, "/isolated/coordinator"), () => ({ model: "fixture-model", effort: "low" }), "协调规则 X");
  await classifier.classify({ ...input, agents: [{ id: "sam", name: "Lin", responsibility: "协调" }, ...input.agents.slice(1)] });
  const prompt = contract(String(external.runTurn.mock.calls[0]![1]));
  expect(prompt).toContain("你是 Lin，");
  expect(prompt).toContain("Lin 永不作为业务执行者");
  expect(prompt).toContain("协调规则 X");
  expect(prompt).not.toContain("Sam");
});

it("keeps the shared Coordinator prompt free of team-domain examples", async () => {
  const external = runtime(ignore);
  await new CodexDispatchClassifier((work) => work(external, "/isolated/coordinator"), () => ({ model: "fixture-model", effort: "low" })).classify(input);
  const prompt = contract(String(external.runTurn.mock.calls[0]![1]));
  expect(prompt).toContain("不得捏造对话中没有的事实、条件或位置");
  for (const term of ["商品", "旅行", "项目位置"]) expect(prompt).not.toContain(term);
});


// The Coordinator's cross-team turn (agent-dispatch::REQ-013/AC-02): one placement per requested part, with an offered team or
// none (agent-dispatch::REQ-008/AC-05, REQ-015/AC-01). Its JSON has no real model sample yet; ticket 21's live run checks it.
const crossTeam: CrossTeamInput = {
  requestId: "request-one", coordinator: "Sam", message: "商品 D 要上架，再弄个脚本以后自动上架", summary: "商品 D 上架", lead: { id: "alice", name: "Alice", responsibility: "商品运营" },
  parts: [{ part: 1, title: "自动上架脚本", brief: "只交付代码，不运行" }, { part: 2, title: "拍照", brief: "白底" }],
  teams: [{ id: "jack", name: "Jack", responsibility: "技术" }, { id: "bill", name: "Bill", responsibility: "衣食住行" }], fixtureMessageId: "om_one",
};
const placed = (...assignments: Array<[number, string | null, string]>) => ({ assignments: assignments.map(([part, agentId, summary]) => ({ part, agentId, summary })) });

it.each([
  ["each part with an offered team or none, in part order", placed([2, null, ""], [1, "jack", " 编写自动上架脚本 "]),
    [{ part: 1, agentId: "jack", summary: "编写自动上架脚本" }, { part: 2, agentId: null, summary: "" }]],
  ["the lead team", placed([1, "alice", "脚本"], [2, null, ""]), "dispatch_cross_team_invalid"],
  ["the Coordinator", placed([1, "sam", "脚本"], [2, null, ""]), "dispatch_cross_team_invalid"],
  ["a team not offered", placed([1, "penny", "脚本"], [2, null, ""]), "dispatch_cross_team_invalid"],
  ["a part left out", placed([1, "jack", "脚本"]), "dispatch_cross_team_invalid"],
  ["a part placed twice", placed([1, "jack", "脚本"], [1, "bill", "脚本"]), "dispatch_cross_team_invalid"],
  ["a part past the requested ones", placed([1, "jack", "脚本"], [3, null, ""]), "dispatch_cross_team_invalid"],
  ["an empty summary for a placed part", placed([1, "jack", "  "], [2, null, ""]), "dispatch_cross_team_invalid"],
  ["a malformed value", { assignments: [{ part: 1, team: "jack" }] }, "dispatch_cross_team_invalid"],
])("decodes or refuses a cross-team decision naming %s", (_case, value, expected) => {
  if (typeof expected === "string") expect(() => parseCrossTeamDecision(value, crossTeam)).toThrow(expected);
  else expect(parseCrossTeamDecision(value, crossTeam)).toEqual(expected);
});

it("places parts through a tool-free constrained Coordinator turn and releases its thread", async () => {
  const external = runtime({ owner: "model_owned", finalText: JSON.stringify(placed([1, "jack", "编写自动上架脚本"], [2, null, ""])) });
  const classifier = new CodexDispatchClassifier((work) => work(external, "/isolated/coordinator"), () => ({ model: "fixture-model", effort: "low" }), "协调规则");
  await expect(classifier.assign(crossTeam)).resolves.toEqual([{ part: 1, agentId: "jack", summary: "编写自动上架脚本" }, { part: 2, agentId: null, summary: "" }]);
  expect(external.startOrResume).toHaveBeenCalledWith(undefined, "/isolated/coordinator", []);
  expect(external.runTurn).toHaveBeenCalledWith("coordinator-thread", expect.any(String), undefined, undefined, expect.objectContaining({
    model: "fixture-model", effort: "low", outputSchema: expect.objectContaining({ required: ["assignments"] }) }));
  for (const fragment of ["你是 Sam", "协调规则", "自动上架脚本", "只交付代码，不运行", '"id":"jack"']) expect(external.runTurn.mock.calls[0]![1]).toContain(fragment);
  expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("coordinator-thread");
});
