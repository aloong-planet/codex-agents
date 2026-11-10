import { expect, it } from "vitest";
import { LeaderOutputError, type LeaderTurnInput, type TeamLeader } from "../src/agent-dispatch-leader.js";
import type { DispatchAssignment, DispatchClassifier, DispatchExecutionResult, DispatchExecutor, DispatchJob } from "../src/agent-dispatch-types.js";
import type { InboundContent } from "../src/channel-contract.js";
import { recordDispatchTurns } from "../src/fixture-dispatch-recorder.js";

// The recorder at its own boundary: the three dispatch seams it wraps are substitutes that return literals.
const event: InboundContent = { key: "feishu:om_one", accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner", conversationType: "group",
  messageId: "om_one", source: "text", text: "整理商品文案", receivedAt: 1, mentionedAgentIds: ["alice"] };
const classification = { event, agents: [{ id: "sam", name: "Sam", responsibility: "协调" }, { id: "alice", name: "Alice", responsibility: "商品运营" }], requests: [], memory: "GROUP_MEMORY" };
const decision = { kind: "dispatch", agentId: "alice", requestId: null, summary: "整理商品文案", message: "" } as const;
const leaderInput: LeaderTurnInput = { requestId: "feishu:om_one", leader: { id: "alice", name: "Alice", teamName: "运营团队", responsibility: "商品运营", instructions: "LEADER_INSTRUCTIONS" },
  profiles: [{ id: "executor-1", name: "能力档 1" }], brief: { message: "整理商品文案", summary: "整理商品文案" }, directory: [{ name: "运营团队", responsibility: "商品运营" }], memory: "LEADER_MEMORY",
  session: { accountId: "cli_sam", target: "feishu.group.oc_alpha", bindingHash: "binding", revision: "r1", definitionsVersion: 1 }, fixtureMessageId: "om_one" };
const plan = { assignments: [{ profileId: "executor-1", title: "撰写文案", brief: "九成新，128G", dependsOn: [] }], decisions: ["按闲鱼撰写"], help: [] };
const job: DispatchJob = { id: "feishu:om_one", event, bindingHash: "binding", agentId: "alice", senderAccountId: "cli_alice", summary: "整理商品文案", status: "running", attempt: 0 };
const assignment: DispatchAssignment = { id: "feishu:om_one:assignment:0:1", requestId: job.id, teamId: "alice", profileId: "executor-1", profileName: "能力档 1", executor: "执行者 1",
  title: "撰写文案", brief: "九成新，128G", status: "running", attempt: 0 };
const result: DispatchExecutionResult = { status: "completed", message: "文案已写好。" };
const closingView = [{ position: 1, title: "撰写文案", executor: "执行者 1", status: "completed", result: "文案已写好。", dependsOn: [] }];

function substitutes(overrides: { classify?: DispatchClassifier["classify"]; run?: DispatchExecutor["run"]; plan?: TeamLeader["plan"] } = {}) {
  const classifier: DispatchClassifier = { classify: overrides.classify ?? (async () => ({ ...decision })), assign: async () => [{ part: 1, agentId: "jack", summary: "写脚本" }] };
  const leader: TeamLeader = { plan: overrides.plan ?? (async () => structuredClone(plan)), supplement: async () => ({ affected: [1], assignments: [], decisions: [], parts: [], help: [] }),
    close: async () => "文案已整理好。" };
  const executor: DispatchExecutor = { run: overrides.run ?? (async () => ({ ...result })), close: async () => {} };
  return { classifier, leader, executor };
}
/** A clock that advances by one on every reading, so each start and end has its own time. */
const ticking = () => { let time = 0; return () => ++time; };

it("returns each turn's result unchanged and records the turns in the order they started, with what each was given", async () => {
  const recorded = recordDispatchTurns(substitutes(), { now: ticking() });
  expect(await recorded.classifier.classify(classification)).toEqual(decision);
  expect(await recorded.leader.plan(leaderInput, 0)).toEqual(plan);
  expect(await recorded.executor.run(job, assignment, new AbortController().signal, [{ position: 1, title: "调研", executor: "执行者 9", result: "调研结论" }])).toEqual(result);
  expect(await recorded.leader.close(leaderInput, closingView)).toBe("文案已整理好。");
  expect(recorded.turns()).toEqual([
    { role: "coordinator", turn: "classify", messageId: "om_one", startedAt: 1, endedAt: 2, output: decision,
      input: { text: "整理商品文案", mentionedAgentIds: ["alice"], agents: classification.agents, requests: [] } },
    { role: "leader", turn: "plan", requestId: "feishu:om_one", teamId: "alice", startedAt: 3, endedAt: 4, output: plan,
      input: { brief: leaderInput.brief, profiles: leaderInput.profiles } },
    { role: "executor", turn: "run", requestId: "feishu:om_one", teamId: "alice", startedAt: 5, endedAt: 6, output: result,
      input: { assignmentId: assignment.id, executor: "执行者 1", profileId: "executor-1", title: "撰写文案", brief: "九成新，128G", attempt: 0,
        prerequisites: [{ position: 1, title: "调研", executor: "执行者 9", result: "调研结论" }] } },
    { role: "leader", turn: "close", requestId: "feishu:om_one", teamId: "alice", startedAt: 7, endedAt: 8, output: "文案已整理好。", input: { assignments: closingView } },
  ]);
});

it("records the cross-team and supplement turns with the parts and the Assignments they were shown", async () => {
  const recorded = recordDispatchTurns(substitutes(), { now: ticking() });
  const parts = [{ part: 1, title: "自动上架脚本", brief: "只交付代码" }], teams = [{ id: "jack", name: "Jack", responsibility: "技术" }];
  const lead = { id: "alice", name: "Alice", responsibility: "商品运营" };
  await recorded.classifier.assign({ requestId: job.id, coordinator: "Sam", message: "商品 D 上架", summary: "商品 D 上架", lead, parts, teams, fixtureMessageId: "om_one" });
  const shown = [{ position: 1, executor: "执行者 1", profileName: "能力档 1", title: "撰写文案", status: "completed", dependsOn: [] }];
  await recorded.leader.supplement(leaderInput, shown, "改成淘宝", 1);
  expect(recorded.turns()).toEqual([
    { role: "coordinator", turn: "assign", requestId: "feishu:om_one", startedAt: 1, endedAt: 2, input: { lead, parts, teams }, output: [{ part: 1, agentId: "jack", summary: "写脚本" }] },
    { role: "leader", turn: "supplement", requestId: "feishu:om_one", teamId: "alice", startedAt: 3, endedAt: 4, input: { brief: leaderInput.brief, assignments: shown, supplement: "改成淘宝" },
      output: { affected: [1], assignments: [], decisions: [], parts: [], help: [] } },
  ]);
});

it("records why a turn failed, with the host's refusal reason, and rethrows the same error", async () => {
  const invalid = new Error("dispatch_decision_invalid"), refused = new LeaderOutputError("leader_plan_invalid", "profileId \"x\" 不是本团队的预设能力档");
  const recorded = recordDispatchTurns(substitutes({ classify: async () => { throw invalid; }, plan: async () => { throw refused; } }), { now: ticking() });
  await expect(recorded.classifier.classify(classification)).rejects.toBe(invalid);
  await expect(recorded.leader.plan(leaderInput)).rejects.toBe(refused);
  expect(recorded.turns().map(({ turn, error, output, endedAt }) => ({ turn, error, output, endedAt }))).toEqual([
    { turn: "classify", error: "dispatch_decision_invalid", output: undefined, endedAt: 2 },
    { turn: "plan", error: "leader_plan_invalid: profileId \"x\" 不是本团队的预设能力档", output: undefined, endedAt: 4 },
  ]);
});

it("shows a turn that is still running without an end, and its end once it returns", async () => {
  let finish!: (value: DispatchExecutionResult) => void;
  const recorded = recordDispatchTurns(substitutes({ run: () => new Promise((resolve) => { finish = resolve; }) }), { now: ticking() });
  const running = recorded.executor.run(job, assignment, new AbortController().signal);
  expect(recorded.turns()).toEqual([expect.objectContaining({ turn: "run", startedAt: 1 })]);
  expect(recorded.turns()[0]).not.toHaveProperty("endedAt");
  finish(result);
  await running;
  expect(recorded.turns()[0]).toMatchObject({ startedAt: 1, endedAt: 2, output: result });
});

it("keeps only its latest turns", async () => {
  const recorded = recordDispatchTurns(substitutes(), { now: ticking(), limit: 2 });
  await recorded.classifier.classify(classification);
  await recorded.leader.plan(leaderInput);
  await recorded.leader.close(leaderInput, closingView);
  expect(recorded.turns().map(({ turn }) => turn)).toEqual(["plan", "close"]);
});
