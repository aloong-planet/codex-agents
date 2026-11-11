import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDispatch, boundedPrerequisites, failureCause, requestOutcome, type AssignmentFailure } from "../src/agent-dispatch.js";
import { CodexDispatchExecutor, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import { CodexTeamLeader, type TeamLeader } from "../src/agent-dispatch-leader.js";
import type { CrossTeamInput, DispatchAgent, DispatchAssignment, DispatchClassifier, DispatchDelivery, DispatchExecutionResult, DispatchExecutor, DispatchJob, DispatchPendingResult } from "../src/agent-dispatch-types.js";
import { FixtureTeamLeader } from "../src/fixture-team-leader.js";
import type { DispatchMemoryTurn } from "../src/agent-dispatch.js";
import type { AgentMemoryScope } from "../src/agent-profile.js";
import type { InboundContent, SendTextResult } from "../src/channel-contract.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { conversation } from "./support/dispatch-runtime.js";

// The request lifecycle at the AgentDispatch boundary. Durable stores are real; external conversations, deliveries and the
// Coordinator's decisions are substitutes. The nested-wait case runs the production Team Leader wrapper and Executor over a
// real pool, because holding a slot while waiting for another one would span all three.
// Gap: each group post that reports a state change (a pending choice, a failure, a choice's cancel reply) is queued in the
// same transaction as that change. No case shows it: nothing awaits between the two writes, so only a process kill could fall
// between them, and a test can stop an instance only at an await; failing the post's insert instead would need a storage seam
// the product does not have. Code review covers it (ticket 07, R-1).
// Gap: a storage failure inside a cross-team closing that runs while other Executors still run is reported, and the request's own
// close closes that team again, instead of failing the attempt. No case shows it, for the same lack of a storage seam; a failed
// closing turn is covered, because the closing turn's own fallback catches it. Code review covers it (ticket 08, R-3).
// Not driven, by decision: the cancel of a queued or proposed request, and a cancel recovered at a start, are recorded before the
// request's choices are closed, so a stop between the two leaves them open and no later start closes them (agent-dispatch
// Implementation Decisions). No case pins that outcome.
const agents: DispatchAgent[] = [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
  { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" },
  { id: "bill", name: "Bill", responsibility: "衣食住行", senderAccountId: "cli_bill" }, { id: "jack", name: "Jack", responsibility: "技术", senderAccountId: "cli_jack" }];
/** A team as definitions version `version` defines it; version 2 renames the presets, so a case can tell which version a team came from. */
const team = (id: string, version = 1) => {
  const agent = agents.find((candidate) => candidate.id === id);
  const name = (index: number) => version === 1 ? `能力档 ${index}` : `新能力档 ${index}`;
  return agent && id !== "sam" ? { leader: { id, name: agent.name, teamName: `${agent.name} 团队`, responsibility: agent.responsibility, instructions: "" },
    profiles: [{ id: "executor-1", name: name(1), capabilities: [] }, { id: "executor-2", name: name(2), capabilities: [] }], memoryScope: { kind: "leader", teamId: id } as const } : undefined;
};
const event = (key: string, text: string, extra: Partial<InboundContent> = {}): InboundContent => ({ key, accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner",
  conversationType: "group", messageId: `om_${key}`, source: "text", text, receivedAt: 1, ...extra });
const plan = JSON.stringify({ assignments: [{ profileId: "executor-1", title: "处理请求", brief: "按原消息处理", dependsOn: [] }], decisions: [], help: [] });
/** A supplement answer affecting the request's first Assignment. */
const affectFirst = async () => ({ affected: [1], assignments: [], decisions: [], parts: [], help: [] });
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const directories: string[] = [];
const open: AgentDispatch[] = [];
const classified: string[] = [];
afterEach(async () => {
  classified.splice(0);
  for (const dispatch of open.splice(0)) await dispatch.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const created = mkdtempSync(join(tmpdir(), "agent-dispatch-")); directories.push(created); return created; }
/** Alice's and Bill's teams accept work in the test group unless a case narrows the roster. */
const accepting = ["alice", "bill"];
type Capture = { scope: AgentMemoryScope } & DispatchMemoryTurn;
/**
 * A message `<kind>:<request ID>` controls that request (`propose:<team>` proposes work for the team); any other text is a
 * request for the team it names. `rejected` lists delivery operations refused once; `outcome` answers any other delivery it
 * returns a result for, and the rest are accepted; `failingCapture` names a memory scope kind whose captures reject; `pending`
 * stands in for the workflow's pending-choice handling; a send whose message `sending` gives a promise for ends only when that
 * promise does.
 */
function dispatchWith(path: string, leader: TeamLeader, executor: DispatchExecutor, deliveries: Array<{ sender: string; message: string; id: string }>,
  options: { roster?: readonly string[]; captures?: Capture[]; rejected?: Set<string>; failingCapture?: AgentMemoryScope["kind"]; sending?: (message: string) => Promise<void> | undefined;
    outcome?: (delivery: Parameters<DispatchDelivery>[0]) => SendTextResult | Promise<SendTextResult> | undefined;
    pending?: (event: InboundContent, held: (runRef: string) => boolean) => Promise<DispatchPendingResult>; closeChoices?: (job: DispatchJob, assignments: readonly DispatchAssignment[]) => Promise<void>;
    profile?: { name: string; noun?: string }; completedWork?: string;
    delivered?: (message: string) => void; assign?: DispatchClassifier["assign"]; definitionsVersion?: () => number; agents?: DispatchAgent[]; team?: typeof team;
    revision?: () => string; teams?: (definitionsVersion: number) => readonly string[] } = {}) {
  const roster = options.roster ?? accepting;
  const dispatch = new AgentDispatch(join(path, "agent-dispatch.sqlite"), {
    agents: () => options.agents ?? agents, leader, executor, definitionsVersion: options.definitionsVersion ?? (() => 1), revision: options.revision ?? (() => "r1"),
    teams: options.teams ?? (() => ["alice", "bill", "jack"]),
    team: (id, version) => { const view = (options.team ?? team)(id, version); return view && options.profile ? { ...view, profiles: [{ id: "executor-1", capabilities: [], ...options.profile }] } : view; },
    roster: () => roster.map((id) => ({ id, name: team(id)!.leader.teamName, responsibility: team(id)!.leader.responsibility })),
    classifier: { classify: async ({ event: inbound }) => {
      const [kind, argument] = inbound.text.split(":");
      classified.push(argument === undefined ? "dispatch" : kind!);
      if (argument === undefined) return { kind: "dispatch", agentId: inbound.text, requestId: null, summary: `${inbound.text} 的请求`, message: "" };
      if (kind === "propose") return { kind: "propose", agentId: argument, requestId: null, summary: "整理商品文案", message: "" };
      return { kind: kind as "cancel", agentId: null, requestId: argument, summary: "", message: "" };
    }, assign: options.assign ?? (async () => { throw new Error("cross_team_not_expected"); }) },
    delivery: async (delivery) => {
      const { senderAccountId, message, operationId } = delivery;
      deliveries.push({ sender: senderAccountId, message, id: operationId }); options.delivered?.(message);
      const sent = options.sending?.(message);
      if (sent) await sent;
      if (options.rejected?.delete(operationId)) return { ok: false, reason: "rejected", acceptedSegments: 0 };
      return await options.outcome?.(delivery) ?? { ok: true, acceptedSegments: 1 };
    },
    memoryScope: { kind: "group" }, memory: { recall: () => "", capture: async (scope, turn) => {
      if (scope.kind === options.failingCapture) throw new Error("memory_state_write_failed");
      options.captures?.push({ scope, ...turn });
    } },
    ...(options.pending ? { pending: options.pending } : {}), ...(options.closeChoices ? { closeChoices: options.closeChoices } : {}),
    authorized: () => true, bindingHash: () => "binding-alpha", completedWork: () => options.completedWork ?? "",
    presentation: () => undefined, presented: () => {}, report: () => {},
  });
  open.push(dispatch);
  return dispatch;
}

it("completes every request when Team Leaders fill the pool and each needs an Executor", async () => {
  const state = directory();
  let live = 0, maxLive = 0, plansStarted = 0;
  const barrier = deferred(), executors: Array<ReturnType<typeof conversation>> = [];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: ({ agent }) => agent.close() });
  const created = (agent: ReturnType<typeof conversation>, scope: string) => {
    live += 1; maxLive = Math.max(maxLive, live);
    agent.close.mockImplementation(async () => { live -= 1; });
    return { agent, cwd: `/isolated/${scope}` };
  };
  const leader = new CodexTeamLeader(join(state, "agent-sessions.sqlite"), {
    model: () => ({ model: "fixture-model", effort: "low" }),
    runtime: (scope, work) => runtimes.use(scope, () => {
      const agent = conversation(`thread-${scope.slice(-6)}`);
      agent.runTurn.mockImplementation(async (_thread, prompt) => {
        if (String(prompt).includes("分工已经结束")) return { owner: "model_owned", finalText: '{"message":"已收尾。"}' };
        // Each plan turn waits until both Team Leaders hold a runtime, so the pool is full of Team Leaders.
        plansStarted += 1; if (plansStarted === 2) barrier.resolve();
        await barrier.promise;
        return { owner: "model_owned", finalText: plan };
      });
      return created(agent, scope);
    }, ({ agent, cwd }) => work(agent, cwd)),
  });
  const executor = new CodexDispatchExecutor(join(state, "agent-sessions.sqlite"), {
    agents: () => agents, runtimes, tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    createRuntime: (_job, scope) => { const agent = conversation(`executor-${executors.length}`); executors.push(agent); return created(agent, scope); },
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: () => "contract-1",
      execute: async () => { throw new Error("tool calls are not part of this case"); } } }),
    contextRevision: () => "r1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(state, leader, executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  dispatch.admit(event("two", "bill"));
  await vi.waitFor(() => expect(dispatch.getState().jobs.map(({ status }) => status)).toEqual(["completed", "completed"]), { timeout: 5000, interval: 20 });
  expect(plansStarted).toBe(2);
  expect(maxLive).toBe(2);
  expect(deliveries.filter(({ message }) => message === "已收尾。").map(({ sender }) => sender).sort()).toEqual(["cli_alice", "cli_bill"]);
  expect(executors).toHaveLength(2);
  for (const agent of executors) expect(agent.close).toHaveBeenCalledOnce();
  expect(dispatch.getState().jobs.flatMap(({ assignments }) => assignments.map(({ status }) => status))).toEqual(["completed", "completed"]);
});

it.each(["plan", "closing"] as const)("resumes a request cut off in its Team Leader's %s turn after a restart", async (cutOff) => {
  const state = directory();
  const hung = deferred<never>();
  const runs: string[] = [];
  const executor = (name: string): DispatchExecutor => ({ run: async () => { runs.push(name); return { status: "completed", message: "已整理好。" }; }, close: () => {} });
  const firstLeader: TeamLeader = {
    plan: async () => cutOff === "plan" ? hung.promise : JSON.parse(plan),
    supplement: affectFirst,
    close: () => hung.promise,
  };
  const before: Array<{ sender: string; message: string; id: string }> = [];
  const first = dispatchWith(state, firstLeader, executor("first"), before);
  await first.start();
  first.admit(event("one", "alice"));
  // The first instance stops inside the Team Leader turn and never writes again, as a crash leaves it.
  await vi.waitFor(() => expect(first.getState().jobs[0]?.status).toBe("running"), { timeout: 2000, interval: 10 });
  if (cutOff === "closing") await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1);

  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, { plan: async () => JSON.parse(plan), supplement: affectFirst, close: async () => "已收尾。" }, executor("second"), after);
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(runs).toEqual(cutOff === "plan" ? ["second"] : ["first"]);
  expect(after.filter(({ message }) => message === "已收尾。")).toEqual([expect.objectContaining({ sender: "cli_alice" })]);
  expect(second.getState().jobs[0]?.assignments).toEqual([expect.objectContaining({ status: "completed", executor: "执行者 1" })]);
  hung.reject(new Error("abandoned")); await first.close();
});

it("keeps a request cancelled while its Team Leader planned it cancelled after a restart", async () => {
  const state = directory();
  const hung = deferred<never>();
  const runs: string[] = [];
  const executor = (name: string): DispatchExecutor => ({ run: async () => { runs.push(name); return { status: "completed", message: "已整理好。" }; }, close: () => {} });
  const first = dispatchWith(state, { plan: () => hung.promise, supplement: affectFirst, close: () => hung.promise }, executor("first"), []);
  await first.start();
  first.admit(event("one", "alice"));
  await vi.waitFor(() => expect(first.getState().jobs[0]?.status).toBe("running"), { timeout: 2000, interval: 10 });
  // The requester cancels while the plan turn is still running; the process then stops before that turn ends.
  first.admit(event("two", `cancel:${first.getState().jobs[0]!.id}`));
  // The cancel is recorded synchronously once its decision returns; one macrotask later intake has finished with it.
  await vi.waitFor(() => expect(classified).toContain("cancel"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  open.splice(open.indexOf(first), 1);

  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, { plan: async () => JSON.parse(plan), supplement: affectFirst, close: async () => "已收尾。" }, executor("second"), after);
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(runs).toEqual([]);
  expect(after.map(({ message }) => message)).toEqual(["已停止继续处理。已经完成的操作不会自动撤销。"]);
  hung.reject(new Error("abandoned")); await first.close();
});

it("gives a request no new Assignment after a restart once its team no longer accepts work in the group", async () => {
  const state = directory();
  const hung = deferred<never>();
  const plans: string[] = [];
  const executor: DispatchExecutor = { run: async () => ({ status: "completed", message: "已整理好。" }), close: () => {} };
  const first = dispatchWith(state, { plan: () => { plans.push("first"); return hung.promise; }, supplement: affectFirst, close: () => hung.promise }, executor, []);
  await first.start();
  first.admit(event("one", "alice"));
  // The first instance stops inside the plan turn, as a crash leaves it; the owner then changes Alice's binding in this group.
  await vi.waitFor(() => expect(plans).toEqual(["first"]), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1);

  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, { plan: async () => { plans.push("second"); return JSON.parse(plan); }, supplement: affectFirst, close: async () => "已收尾。" }, executor, after, { roster: ["bill"] });
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  expect(plans).toEqual(["first"]);
  expect(second.getState().jobs[0]?.assignments).toEqual([]);
  expect(after.map(({ sender, message }) => ({ sender, message }))).toEqual([
    { sender: "cli_alice", message: "负责团队当前不可用，本次未能继续处理。已完成的操作不会自动重复，请补充信息后明确让我重试。" }]);
  hung.reject(new Error("abandoned")); await first.close();
});

// An Executor is named after its profile's noun plus its number, and the start message names it so (ticket 11, decision D6).
it("names the Executor after its profile's noun in the Team Leader's start message", async () => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const executor: DispatchExecutor = { run: async () => ({ status: "completed", message: "文案已写好" }), close: () => {} };
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { profile: { name: "商品文案", noun: "文案执行者" } });
  try {
    await dispatch.start();
    dispatch.admit(event("noun", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
    expect(deliveries[0]).toMatchObject({ sender: "cli_alice", message: "我安排文案执行者 1（商品文案）处理：处理请求。完成后会在本群汇报。" });
    expect(dispatch.getState().jobs[0]?.assignments.map(({ executor: name, profileId }) => [name, profileId])).toEqual([["文案执行者 1", "executor-1"]]);
  } finally { await dispatch.close(); }
});

// The capture of finished requests into the group memory (agent-dispatch::REQ-012/AC-01, AC-04).
const start = (executor: number) => `我安排执行者 ${executor}（能力档 1）处理：处理请求。完成后会在本群汇报。`;
/** A Team Leader whose n-th closing is `LEADER_CLOSING_<n>`. */
function closingLeader(): TeamLeader {
  let closings = 0;
  return { plan: async () => JSON.parse(plan), supplement: affectFirst, close: async () => `LEADER_CLOSING_${++closings}` };
}
const groupCaptures = (captures: Capture[]) => captures.filter(({ scope }) => scope.kind === "group")
  .map(({ senderAccountId, userId, userText, assistantText }) => ({ senderAccountId, userId, userText, assistantText }));

it("captures each finished attempt with everything posted for it into the group memory, and its division into its Team Leader's", async () => {
  const captures: Capture[] = [];
  const gate = deferred();
  let runs = 0;
  const executor: DispatchExecutor = { run: async () => { runs += 1; if (runs === 1) await gate.promise; return { status: "completed", message: `EXECUTOR_RESULT_${runs}` }; }, close: () => {} };
  const dispatch = dispatchWith(directory(), closingLeader(), executor, [], { captures });
  await dispatch.start();
  dispatch.admit(event("one", "propose:alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("proposed"), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "confirm:one"));
  await vi.waitFor(() => expect(runs).toBe(1), { timeout: 2000, interval: 10 });
  // A supplement while the first attempt runs starts a second attempt once the first completes; the affected Assignment reruns with its Executor.
  dispatch.admit(event("three", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(2), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)).toEqual([
    { senderAccountId: "cli_alice", userId: "one:user:0", userText: "propose:alice\n确认与要求：confirm:one",
      assistantText: ["要不要请 Alice 帮你整理商品文案？请回复这条建议确认，或告诉我暂时不用。", start(1), "LEADER_CLOSING_1"].join("\n") },
    // An attempt started by a supplement still carries the request's message (agent-dispatch::REQ-012/AC-01).
    { senderAccountId: "cli_alice", userId: "one:user:1", userText: "propose:alice\n补充要求：supplement:one", assistantText: [start(1), "LEADER_CLOSING_2"].join("\n") },
  ]);
  expect(JSON.stringify(groupCaptures(captures))).not.toContain("EXECUTOR_RESULT");
  // The Team Leader keeps its Brief, with the latest requirement when it differs, its division and its closing.
  expect(captures.filter(({ scope }) => scope.kind === "leader").map(({ scope, userText, assistantText }) => ({ scope, userText, assistantText }))).toEqual([
    { scope: { kind: "leader", teamId: "alice" }, userText: "请求：propose:alice\n最新要求：propose:alice\n确认与要求：confirm:one\n协调摘要：整理商品文案",
      assistantText: "分工：执行者 1（能力档 1）处理请求\n收尾：LEADER_CLOSING_1" },
    { scope: { kind: "leader", teamId: "alice" }, userText: "请求：propose:alice\n最新要求：supplement:one\n协调摘要：整理商品文案",
      assistantText: "分工：执行者 1（能力档 1）处理请求\n收尾：LEADER_CLOSING_2" },
  ]);
});

it.each([
  ["a failed attempt with its closing", { status: "failed", message: "执行失败" }, [{ userText: "alice", assistantText: [start(1), "LEADER_CLOSING_1"].join("\n") }]],
  ["no waiting attempt", { status: "waiting", message: "请选择要发送的文件。" }, []],
] as const)("captures %s", async (_case, result, expected) => {
  const captures: Capture[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ ...result }) as DispatchExecutionResult, close: () => {} }, deliveries, { captures });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(deliveries.map(({ message }) => message)).toContain(result.status === "failed" ? "LEADER_CLOSING_1" : result.message), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(groupCaptures(captures).map(({ userText, assistantText }) => ({ userText, assistantText }))).toEqual(expected);
});

it.each([
  ["while it is still a proposal", "propose:alice", false],
  ["while its Executor runs", "alice", true],
] as const)("never captures a request cancelled %s", async (_case, text, running) => {
  const captures: Capture[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const executor: DispatchExecutor = { run: (_job, _assignment, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ status: "cancelled", message: "已取消" }));
  }), close: () => {} };
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { captures });
  await dispatch.start();
  dispatch.admit(event("one", text));
  await vi.waitFor(() => expect(running ? deliveries.map(({ message }) => message) : dispatch.getState().jobs.map(({ status }) => status))
    .toEqual(running ? [start(1)] : ["proposed"]), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "cancel:one"));
  await vi.waitFor(() => expect(deliveries.map(({ message }) => message)).toContain("已停止继续处理。已经完成的操作不会自动撤销。"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dispatch.getState().jobs[0]?.status).toBe("cancelled");
  expect(groupCaptures(captures)).toEqual([]);
});

it("captures a rejected closing once, when its re-sent copy is accepted", async () => {
  const captures: Capture[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, deliveries,
    { captures, rejected: new Set(["dispatch:one:closing:0"]) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().notices.find(({ id }) => id === "one:closing:0")?.state).toBe("rejected"), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)).toEqual([]);
  dispatch.admit(event("two", "retry_report:one"));
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(groupCaptures(captures).map(({ assistantText }) => assistantText)).toEqual([[start(1), "LEADER_CLOSING_1"].join("\n")]);
});

it("keeps a request's outcome and posts when its Team Leader's memory capture fails", async () => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, deliveries,
    { failingCapture: "leader" });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(deliveries.map(({ message }) => message)).toContain("LEADER_CLOSING_1"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dispatch.getState().jobs[0]?.status).toBe("completed");
  expect(deliveries.map(({ sender, message }) => ({ sender, message }))).toEqual([{ sender: "cli_alice", message: start(1) }, { sender: "cli_alice", message: "LEADER_CLOSING_1" }]);
});

it("reports an Assignment cut off at shutdown at the next start, and closes the request even when its group capture fails", async () => {
  const state = directory();
  // The Executor's connection drops at shutdown, so the attempt fails and its report is one the group memory captures.
  const first = dispatchWith(state, closingLeader(), { run: (_job, _assignment, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("executor_connection_closed")));
  }), close: () => {} }, []);
  await first.start();
  first.admit(event("one", "alice"));
  await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments[0]?.status).toBe("running"), { timeout: 2000, interval: 10 });
  // Closing while the Executor runs leaves its Assignment running; the next start reports it interrupted and closes the request.
  open.splice(open.indexOf(first), 1); await first.close();
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, after,
    { failingCapture: "group" });
  await expect(second.start()).resolves.toBeUndefined();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  expect(after.map(({ sender, message }) => ({ sender, message }))).toEqual([
    { sender: "cli_alice", message: "服务中断，执行者 1（能力档 1）的分工「处理请求」已中断，无法确认已完成的内容，不会自动重放。" },
    { sender: "cli_alice", message: "LEADER_CLOSING_1" }]);
  expect(second.getState().jobs[0]?.assignments).toEqual([expect.objectContaining({ status: "interrupted" })]);
});

it("keeps a failed group capture out of the Coordinator's replies when a rejected report is re-sent", async () => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, deliveries,
    { rejected: new Set(["dispatch:one:closing:0"]), failingCapture: "group" });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().notices.find(({ id }) => id === "one:closing:0")?.state).toBe("rejected"), { timeout: 2000, interval: 10 });
  const before = deliveries.length;
  dispatch.admit(event("two", "retry_report:one"));
  await vi.waitFor(() => expect(dispatch.getState().notices.find(({ id }) => id === "one:closing:0:retry:two")?.state).toBe("accepted"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(deliveries.slice(before).map(({ sender, message }) => ({ sender, message }))).toEqual([{ sender: "cli_alice", message: "LEADER_CLOSING_1" }]);
});

it("captures a reassigned request with the mentioned team's explanation and the Coordinator's notice, but not a refused control", async () => {
  const captures: Capture[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const gate = deferred();
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => { await gate.promise; return { status: "completed", message: "EXECUTOR_RESULT" }; }, close: () => {} },
    deliveries, { captures });
  await dispatch.start();
  dispatch.admit(event("one", "alice", { mentionedAgentIds: ["bill"] }));
  await vi.waitFor(() => expect(deliveries.map(({ message }) => message)).toContain(start(1)), { timeout: 2000, interval: 10 });
  // Nothing failed yet, so the Coordinator refuses the retry; that reply belongs to no request.
  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(deliveries.map(({ message }) => message)).toContain("这项请求没有可重试的失败处理；已完成的操作不会重新执行。"), { timeout: 2000, interval: 10 });
  gate.resolve();
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)[0]?.assistantText).toBe(["这项需求属于 Alice 的职责。我请 Sam 重新分派，由他独立处理。", "已将这项需求转派给 Alice。", start(1), "LEADER_CLOSING_1"].join("\n"));
});

it("captures a confirmed proposal with the acknowledgement of its supplement", async () => {
  const captures: Capture[] = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, [], { captures });
  await dispatch.start();
  dispatch.admit(event("one", "propose:alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("proposed"), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  dispatch.admit(event("three", "confirm:one"));
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)[0]).toEqual({ senderAccountId: "cli_alice", userId: "one:user:0", userText: "propose:alice\n补充要求：supplement:one\n确认与要求：confirm:one",
    assistantText: ["要不要请 Alice 帮你整理商品文案？请回复这条建议确认，或告诉我暂时不用。", "已补充到建议中。请确认是否开始处理。", start(1), "LEADER_CLOSING_1"].join("\n") });
});

it("captures a request that waited for a choice with its pending choice, once its closing is accepted", async () => {
  const captures: Capture[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" }), close: () => {} },
    deliveries, { captures, pending: async (inbound) => inbound.text === "choose:1"
      ? { handled: true, senderAccountId: "cli_alice", runRef: "run-1", result: { status: "completed", message: "已发送所选文件。" } } : { handled: false } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(groupCaptures(captures)).toEqual([]);
  dispatch.admit(event("two", "choose:1"));
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)[0]?.assistantText).toBe([start(1), "请选择要发送的文件。", "LEADER_CLOSING_1"].join("\n"));
});

it.each([
  ["asks which one when both mentioned teams accept work in the group", ["alice", "bill"],
    [{ sender: "cli_sam", message: "你点名了多个 Agent。这项事务希望由谁独立负责？" }], []],
  ["routes to the one accepting team when the other mentioned team does not accept work there", ["alice"],
    [{ sender: "cli_alice", message: start(1) }, { sender: "cli_alice", message: "LEADER_CLOSING_1" }], ["completed"]],
] as const)("%s", async (_case, roster, expected, statuses) => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, deliveries,
    { roster });
  await dispatch.start();
  dispatch.admit(event("one", "alice", { mentionedAgentIds: ["alice", "bill"] }));
  await vi.waitFor(() => expect(deliveries).toHaveLength(expected.length), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(deliveries.map(({ sender, message }) => ({ sender, message }))).toEqual(expected);
  expect(dispatch.getState().jobs.map(({ status }) => status)).toEqual(statuses);
});

// Several Assignments per request (agent-dispatch::REQ-011, REQ-008/AC-01, REQ-007/AC-03, AC-04, US-003/AC-03).
const three = { assignments: [{ profileId: "executor-1", title: "整理文案", brief: "按原消息整理文案", dependsOn: [] as number[] },
  { profileId: "executor-2", title: "核对价格", brief: "核对竞品价格", dependsOn: [] as number[] }, { profileId: "executor-1", title: "准备问答", brief: "准备买家问答", dependsOn: [] as number[] }],
decisions: [] as string[], help: [] as Array<{ title: string; brief: string }> };
const startThree = "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格\n执行者 3（能力档 1）处理：准备问答\n完成后会在本群汇报。";
type Reports = Parameters<TeamLeader["close"]>[1];
/** A Team Leader planning `division`, recording each closing turn's reports and answering supplements with `supplement`. */
function dividingLeader(division: typeof three, reports: Reports[] = [], supplement: TeamLeader["supplement"] = affectFirst): TeamLeader {
  return { plan: async () => structuredClone(division), supplement, close: async (_input, assignments) => { reports.push(structuredClone(assignments)); return "已收尾。"; } };
}
const messages = (deliveries: Array<{ message: string }>) => deliveries.map(({ message }) => message);

it.each([
  ["an Executor's own report", { kind: "reported", toolRefused: false }, "执行者报告无法完成"],
  ["a refused tool call", { kind: "reported", toolRefused: true }, "有工具调用被拒绝"],
  ["a turn with no progress", { kind: "error", error: new Error("Codex 回合无进展超时") }, "执行超时"],
  ["an unavailable model", { kind: "error", error: new Error("dispatch_model_unavailable") }, "运行环境不可用"],
  ["an unbound group", { kind: "error", error: new Error("dispatch_group_unbound") }, "运行环境不可用"],
  ["a changed authorization", { kind: "error", error: new Error("dispatch_authorization_changed") }, "权限或可用上下文发生变化"],
  ["a result report failing its schema", { kind: "error", error: new Error("main_reply_invalid_schema") }, "执行者未返回有效的结果报告"],
  ["an invalid result record", { kind: "error", error: new Error("main_reply_record_invalid") }, "执行者未返回有效的结果报告"],
  ["a stop of the service", { kind: "shutdown" }, "服务中断"],
  ["another error", { kind: "error", error: new Error("executor_connection_closed") }, "执行连接中断或处理出错"],
] satisfies Array<[string, AssignmentFailure, string]>)("names the host-known cause of %s", (_case, failure, cause) => {
  expect(failureCause(failure)).toBe(cause);
});

// A part no team took ranks below a failure and above completion (agent-dispatch::REQ-013/AC-02, owner decision of 2026-11-08).
it.each([
  [["completed", "completed", "completed"], false, "completed"],
  [["completed", "failed", "interrupted"], false, "partially_failed"],
  [["failed", "interrupted"], false, "failed"],
  [["completed", "cancelled"], false, "completed"],
  [["cancelled"], false, "cancelled"],
  [["completed", "failed", "blocked"], false, "partially_failed"],
  [["failed", "blocked"], false, "failed"],
  [["completed", "cancelled"], true, "partially_unassigned"],
  [["completed", "failed"], true, "partially_failed"],
  // Not started counts as not completed, so it outranks a part no team took as a failure does.
  [["completed", "cancelled", "blocked"], true, "partially_failed"],
  [["failed"], true, "failed"],
  [["cancelled"], true, "cancelled"],
] satisfies Array<[DispatchAssignment["status"][], boolean, string]>)("settles a request whose Assignments ended %j, with a part no team took: %s, as %s", (statuses, untaken, outcome) => {
  expect(requestOutcome(statuses, untaken)).toBe(outcome);
});

it("runs every Assignment of a plan at once, announces them in one start message, posts its decisions and closes with every result", async () => {
  const started: string[] = [];
  const all = deferred();
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    // Each run waits until all three have started, so a plan run one Assignment at a time never finishes.
    started.push(assignment.title); if (started.length === 3) all.resolve();
    await all.promise;
    return { status: "completed", message: `${assignment.title}完成` };
  }, close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader({ ...three, decisions: ["先出文案再定价", "价格区间等你确认"] }, reports), executor, deliveries,
    { rejected: new Set(["dispatch:one:decision:0:0"]) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // The rejected decision post has its own delivery state and stops nothing.
  expect(deliveries.map(({ sender, message }) => ({ sender, message }))).toEqual([startThree, "先出文案再定价", "价格区间等你确认", "已收尾。"]
    .map((message) => ({ sender: "cli_alice", message })));
  expect(dispatch.getState().notices.find(({ id }) => id === "one:decision:0:0")?.state).toBe("rejected");
  expect(reports).toEqual([[{ position: 1, title: "整理文案", executor: "执行者 1", status: "completed", result: "整理文案完成", dependsOn: [] },
    { position: 2, title: "核对价格", executor: "执行者 2", status: "completed", result: "核对价格完成", dependsOn: [] },
    { position: 3, title: "准备问答", executor: "执行者 3", status: "completed", result: "准备问答完成", dependsOn: [] }]]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ executor, profileId, status }) => ({ executor, profileId, status }))).toEqual([
    { executor: "执行者 1", profileId: "executor-1", status: "completed" }, { executor: "执行者 2", profileId: "executor-2", status: "completed" },
    { executor: "执行者 3", profileId: "executor-1", status: "completed" }]);
});

it("keeps the others running when one fails, posts the failure, ends partially failed and retries only the failed one", async () => {
  const runs: string[] = [];
  const failurePosted = deferred();
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    runs.push(`${assignment.title}:${assignment.attempt}`);
    if (assignment.title === "核对价格" && assignment.attempt === 0) return { status: "failed", message: "价格页无法访问" };
    // The other two finish only after the failure was posted, so it is posted while they still run.
    if (assignment.attempt === 0) await failurePosted.promise;
    return { status: "completed", message: `${assignment.title}完成` };
  }, close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(three, reports), executor, deliveries,
    { delivered: (message) => { if (message.includes("未能完成")) failurePosted.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(messages(deliveries)).toEqual([startThree, "执行者 2（能力档 2）的分工「核对价格」未能完成：执行者报告无法完成。其余分工继续处理。", "已收尾。"]);
  expect(reports[0]?.map(({ status }) => status)).toEqual(["completed", "failed", "completed"]);
  expect(reports[0]?.[1]?.result).toBe("价格页无法访问");

  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(runs).toEqual(["整理文案:0", "核对价格:0", "准备问答:0", "核对价格:1"]);
  expect(messages(deliveries).slice(3)).toEqual(["我安排执行者 2（能力档 2）处理：核对价格。完成后会在本群汇报。", "已收尾。"]);
  // The retry's closing still covers every Assignment of the request.
  expect(reports[1]?.map(({ executor, status }) => `${executor}:${status}`)).toEqual(["执行者 1:completed", "执行者 2:completed", "执行者 3:completed"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ id, executor, attempt }) => ({ id, executor, attempt }))).toEqual([
    { id: "one:assignment:0:1", executor: "执行者 1", attempt: 0 }, { id: "one:assignment:0:2", executor: "执行者 2", attempt: 1 },
    { id: "one:assignment:0:3", executor: "执行者 3", attempt: 0 }]);
});

it.each([
  ["the completed one", ["整理文案"], [], ["completed", "cancelled", "cancelled"],
    "已停止继续处理：\n执行者 1「整理文案」已完成\n执行者 2「核对价格」已停止\n执行者 3「准备问答」已停止\n已确认完成 1 次本地文件修改。已经完成的操作不会自动撤销。"],
  ["none completed", [], [], ["cancelled", "cancelled", "cancelled"],
    "已停止继续处理：\n执行者 1「整理文案」已停止\n执行者 2「核对价格」已停止\n执行者 3「准备问答」已停止\n已确认完成 1 次本地文件修改。已经完成的操作不会自动撤销。"],
  // The failed Assignment keeps its failure: the report must not call it stopped.
  ["one that failed before the cancel", [], ["核对价格"], ["cancelled", "failed", "cancelled"],
    "已停止继续处理：\n执行者 1「整理文案」已停止\n执行者 2「核对价格」未能完成\n执行者 3「准备问答」已停止\n已确认完成 1 次本地文件修改。已经完成的操作不会自动撤销。"],
] as const)("cancels every unfinished Assignment of a request and names %s", async (_case, completes, fails, statuses, report) => {
  const stopped: string[] = [];
  const executor: DispatchExecutor = { run: (_job, assignment, signal) => (completes as readonly string[]).includes(assignment.title)
    ? Promise.resolve({ status: "completed", message: "文案完成" })
    : (fails as readonly string[]).includes(assignment.title) ? Promise.resolve({ status: "failed", message: "价格页无法访问" })
    : new Promise((resolve) => signal.addEventListener("abort", () => { stopped.push(assignment.title); resolve({ status: "cancelled", message: "已取消" }); })), close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(three, reports), executor, deliveries, { completedWork: "已确认完成 1 次本地文件修改。" });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  const running = statuses.map((status) => status === "cancelled" ? "running" : status);
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(running), { timeout: 2000, interval: 10 });
  const failurePosts = (fails as readonly string[]).map((title) => `执行者 2（能力档 2）的分工「${title}」未能完成：执行者报告无法完成。其余分工继续处理。`);
  await vi.waitFor(() => expect(messages(deliveries)).toEqual([startThree, ...failurePosts]), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "cancel:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stopped).toEqual(three.assignments.map(({ title }) => title).filter((title) => !([...completes, ...fails] as readonly string[]).includes(title)));
  expect(messages(deliveries)).toEqual([startThree, ...failurePosts, report]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(statuses);
  expect(reports).toEqual([]);
});

it("reruns only the Assignments its Team Leader marks affected, each receiving the supplement", async () => {
  const gate = deferred();
  const runs: string[] = [];
  const executor: DispatchExecutor = { run: async (job, assignment) => {
    runs.push(`${assignment.title}:${assignment.attempt}:${(assignment.input ?? job.executionEvent ?? job.event).text}`);
    if (assignment.attempt === 0) await gate.promise;
    return { status: "completed", message: `${assignment.title}完成` };
  }, close: () => {} };
  const answers: Array<{ assignments: unknown; supplement: string }> = [];
  const reports: Reports[] = [];
  const two = { assignments: three.assignments.slice(0, 2), decisions: [], help: [] };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(two, reports, async (_input, assignments, supplement) => {
    answers.push({ assignments: structuredClone(assignments), supplement }); return { affected: [2], assignments: [], decisions: ["只重新核对价格"], parts: [], help: [] };
  }), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(reports).toHaveLength(2), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(answers).toEqual([{ supplement: "supplement:one", assignments: [
    { position: 1, executor: "执行者 1", profileName: "能力档 1", title: "整理文案", status: "completed", dependsOn: [] },
    { position: 2, executor: "执行者 2", profileName: "能力档 2", title: "核对价格", status: "completed", dependsOn: [] }] }]);
  expect(runs).toEqual(["整理文案:0:alice", "核对价格:0:alice", "核对价格:1:supplement:one"]);
  expect(messages(deliveries)).toEqual(["我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格\n完成后会在本群汇报。", "已收尾。",
    "我安排执行者 2（能力档 2）处理：核对价格。完成后会在本群汇报。", "只重新核对价格", "已收尾。"]);
  expect(reports[1]?.map(({ executor }) => executor)).toEqual(["执行者 1", "执行者 2"]);
});

it("reports each interrupted Assignment after a restart, then closes the request with its Team Leader", async () => {
  const state = directory();
  const hung = deferred<never>();
  const first = dispatchWith(state, dividingLeader(three), { run: (_job, assignment) => assignment.title === "整理文案"
    ? Promise.resolve({ status: "completed", message: "文案完成" }) : hung.promise, close: () => {} }, []);
  await first.start();
  first.admit(event("one", "alice"));
  // The first instance stops while two Executors still run, and never writes again, as a crash leaves it.
  await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "running", "running"]), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1);

  const runs: string[] = [];
  const reports: Reports[] = [];
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, dividingLeader(three, reports), { run: async (_job, assignment) => { runs.push(assignment.title); return { status: "completed", message: "" }; },
    close: () => {} }, after);
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(after.map(({ sender, message }) => ({ sender, message }))).toEqual([
    "服务中断，执行者 2（能力档 2）的分工「核对价格」已中断，无法确认已完成的内容，不会自动重放。",
    "服务中断，执行者 3（能力档 1）的分工「准备问答」已中断，无法确认已完成的内容，不会自动重放。", "已收尾。"].map((message) => ({ sender: "cli_alice", message })));
  expect(reports[0]?.map(({ status }) => status)).toEqual(["completed", "interrupted", "interrupted"]);
  expect(runs).toEqual([]);
  hung.reject(new Error("abandoned")); await first.close();
});

it("captures an attempt with its decision and failure posts into the group memory", async () => {
  const captures: Capture[] = [];
  const failurePosted = deferred();
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    if (assignment.title === "核对价格") return { status: "failed", message: "价格页无法访问" };
    await failurePosted.promise;
    return { status: "completed", message: `${assignment.title}完成` };
  }, close: () => {} };
  const dispatch = dispatchWith(directory(), dividingLeader({ ...three, decisions: ["先出文案再定价"] }), executor, [],
    { captures, delivered: (message) => { if (message.includes("未能完成")) failurePosted.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)[0]?.assistantText).toBe([startThree, "先出文案再定价",
    "执行者 2（能力档 2）的分工「核对价格」未能完成：执行者报告无法完成。其余分工继续处理。", "已收尾。"].join("\n"));
});

// A pending choice of one of several Assignments (agent-dispatch failure mode "One of several Assignments raises a pending choice
// while the others run"): it goes out at once, and only its own resolution ends it.
function choosing(answer: DispatchExecutionResult["status"]) {
  return async (inbound: InboundContent): Promise<DispatchPendingResult> => {
    // `choose:<n>` answers the choice of run-<n>.
    const run = /^choose:(\d+)$/u.exec(inbound.text)?.[1];
    return run ? { handled: true, senderAccountId: "cli_alice", runRef: `run-${run}`,
      result: { status: answer, message: answer === "cancelled" ? "已取消这次选择。" : "已发送所选文件。" } } : { handled: false };
  };
}
const two = { assignments: three.assignments.slice(0, 2), decisions: [] as string[], help: [] };
const startTwo = "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格\n完成后会在本群汇报。";

it("posts one Assignment's pending choice while another runs, then closes the request once the choice is resolved", async () => {
  const choicePosted = deferred();
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    if (assignment.title === "整理文案") return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" };
    // The second Assignment ends only after the first one's choice was posted, and starts a run of its own.
    await choicePosted.promise;
    return { status: "completed", message: "价格已核对。", runRef: "run-2" };
  }, close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(two, reports), executor, deliveries,
    { pending: choosing("completed"), delivered: (message) => { if (message === "请选择要发送的文件。") choicePosted.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  expect(messages(deliveries)).toEqual([startTwo, "请选择要发送的文件。"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["waiting", "completed"]);
  expect(reports).toEqual([]);
  dispatch.admit(event("two", "choose:1"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(reports[0]?.map(({ executor, status, result }) => ({ executor, status, result }))).toEqual([
    { executor: "执行者 1", status: "completed", result: "已发送所选文件。" }, { executor: "执行者 2", status: "completed", result: "价格已核对。" }]);
  expect(messages(deliveries).at(-1)).toBe("已收尾。");
});

it("ends only the Assignment whose choice the requester cancels, and closes the request with the others", async () => {
  const executor: DispatchExecutor = { run: async (_job, assignment) => assignment.title === "整理文案"
    ? { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" } : { status: "completed", message: "价格已核对。", runRef: "run-2" }, close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(two, reports), executor, deliveries, { pending: choosing("cancelled") });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "choose:1"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["cancelled", "completed"]);
  expect(messages(deliveries).slice(2)).toEqual(["已取消这次选择。", "已收尾。"]);
  expect(reports[0]?.map(({ status }) => status)).toEqual(["cancelled", "completed"]);
});

// A cancelled request's open choice (agent-dispatch failure mode "Requester cancels a request while one of its Assignments waits
// on a choice, then answers that choice"). The host closes the choice with the cancel. In these cases it fails to, so the answer
// is still handed over, and the engine holds on its own.
const ENDED = "这项请求已经结束或无法继续，请说明新的需求。";
const unclosable = async () => { throw new Error("workflow_pending_cancel_conflict"); };

it.each(["completed", "failed", "waiting", "cancelled"] as const)("keeps a cancelled request cancelled when its choice is answered with %s, and refuses a later retry and supplement", async (answer) => {
  const turns: string[] = [];
  const leader: TeamLeader = { plan: async () => { turns.push("plan"); return JSON.parse(plan); }, supplement: async () => { turns.push("supplement"); return affectFirst(); },
    close: async () => { turns.push("close"); return "已收尾。"; } };
  let runs = 0;
  const executor: DispatchExecutor = { run: async () => { runs += 1; return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" }; }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, executor, deliveries, { pending: choosing(answer), closeChoices: unclosable });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  const expected = [`cli_alice: ${start(1)}`, "cli_alice: 请选择要发送的文件。", "cli_alice: 已停止继续处理。已经完成的操作不会自动撤销。"];
  // Each message's post marks the end of its processing, so the next one is sent only after it.
  for (const [key, text, reply] of [["two", "cancel:one", undefined], ["three", "choose:1", ENDED],
    ["four", "retry:one", "这项请求没有可重试的失败处理；已完成的操作不会重新执行。"], ["five", "supplement:one", ENDED]] as const) {
    if (reply) expected.push(`cli_sam: ${reply}`);
    dispatch.admit(event(key, text));
    await vi.waitFor(() => expect(posts(deliveries)).toEqual(expected), { timeout: 2000, interval: 10 });
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "cancelled", assignments: [{ status: "cancelled" }] });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posts(deliveries)).toEqual(expected);
  expect(turns).toEqual(["plan"]);
  expect(runs).toBe(1);
});

const STOPPED_TWO = "已停止继续处理：\n执行者 1「整理文案」已停止\n执行者 2「核对价格」已停止\n已经完成的操作不会自动撤销。";
const STOPPED_THREE = "已停止继续处理：\n执行者 1「整理文案」已停止\n执行者 2「核对价格」已停止\n执行者 3「准备问答」已停止\n已经完成的操作不会自动撤销。";
/**
 * The Executors of `three`: the first raises the choice of run-1 at once; the second raises that of run-2 only once `late`
 * resolves; the third ends, cancelled, only once `stopped` resolves, however early it is cancelled. `raised` sees each choice.
 */
function choosingExecutors(late: Promise<void>, stopped: Promise<void>, raised: (runRef: string) => void = () => {}): DispatchExecutor {
  return { run: async (_job, assignment) => {
    if (assignment.title === "准备问答") { await stopped; return { status: "cancelled", message: "已取消" }; }
    const runRef = assignment.title === "整理文案" ? "run-1" : "run-2";
    if (runRef === "run-2") await late;
    raised(runRef);
    return { status: "waiting", message: `请选择（${runRef}）。`, runRef };
  }, close: () => {} };
}

it("holds the answers to a cancelled request's choices while another of its Executors is still stopping", async () => {
  const late = deferred(), stopped = deferred();
  let asked = 0;
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(three), choosingExecutors(late.promise, stopped.promise), deliveries,
    { pending: choosing("completed"), closeChoices: async () => { asked += 1; return unclosable(); } });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(messages(deliveries)).toEqual([startThree, "请选择（run-1）。"]), { timeout: 2000, interval: 10 });
    dispatch.admit(event("two", "cancel:one"));
    // The host is asked once when the cancel is taken in. Only then does the second Executor raise its choice, while it stops,
    // and the host is asked again.
    await vi.waitFor(() => expect(asked).toBe(1), { timeout: 2000, interval: 10 });
    late.resolve();
    await vi.waitFor(() => expect(asked).toBe(2), { timeout: 2000, interval: 10 });
    dispatch.admit(event("three", "choose:1"));
    dispatch.admit(event("four", "choose:2"));
    await vi.waitFor(() => expect(posts(deliveries).slice(2)).toEqual([`cli_sam: ${ENDED}`, `cli_sam: ${ENDED}`]), { timeout: 2000, interval: 10 });
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", assignments: [{ status: "waiting" }, { status: "running" }, { status: "running" }] });
  } finally { late.resolve(); stopped.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(messages(deliveries)).toEqual([startThree, "请选择（run-1）。", ENDED, ENDED, STOPPED_THREE]);
});

it("has an open choice closed as soon as the requester cancels, and one an Executor raises while it stops as soon as that Executor has ended", async () => {
  const late = deferred(), stopped = deferred();
  // The host's choices, by run: `raised` holds every one an Executor raised, `openChoices` those not closed yet. The host closes
  // the choices of the runs that the Assignments it is given name.
  const raised: string[] = [], openChoices = new Set<string>();
  const executor = choosingExecutors(late.promise, stopped.promise, (runRef) => { raised.push(runRef); openChoices.add(runRef); });
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(three), executor, deliveries,
    { closeChoices: async (_job, assignments) => { for (const { runRef } of assignments) if (runRef) openChoices.delete(runRef); } });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(messages(deliveries)).toEqual([startThree, "请选择（run-1）。"]), { timeout: 2000, interval: 10 });
    expect([...openChoices]).toEqual(["run-1"]);
    dispatch.admit(event("two", "cancel:one"));
    await vi.waitFor(() => expect([...openChoices]).toEqual([]), { timeout: 2000, interval: 10 });
    late.resolve();
    await vi.waitFor(() => { expect(raised).toEqual(["run-1", "run-2"]); expect([...openChoices]).toEqual([]); }, { timeout: 2000, interval: 10 });
    // Both are closed while the third Executor still runs.
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", assignments: [{ status: "waiting" }, { status: "running" }, { status: "running" }] });
  } finally { late.resolve(); stopped.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(messages(deliveries)).toEqual([startThree, "请选择（run-1）。", STOPPED_THREE]);
});

it("has a waiting Assignment's choice closed when a supplement supersedes it, so a later answer goes to the Coordinator and leaves the request alone", async () => {
  // The host's choice of run-1 takes an answer only while it is open. Once it is closed the answer is a message for the
  // Coordinator; the substitute Coordinator cannot classify it, so the engine posts the reply for a message it cannot place.
  let choiceOpen = true;
  const UNPLACED = "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。";
  const rerun = deferred();
  let runs = 0;
  const executor: DispatchExecutor = { run: async () => {
    runs += 1;
    if (runs === 1) return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" };
    await rerun.promise;
    return { status: "completed", message: "已按补充处理。" };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { closeChoices: async () => { choiceOpen = false; },
    pending: async (inbound) => inbound.text === "choose:1" && choiceOpen
      ? { handled: true, senderAccountId: "cli_alice", runRef: "run-1", result: { status: "completed", message: "已发送所选文件。" } } : { handled: false } });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    dispatch.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(runs).toBe(2), { timeout: 2000, interval: 10 });
    dispatch.admit(event("three", "choose:1"));
    await vi.waitFor(() => expect(posts(deliveries).at(-1)).toBe(`cli_sam: ${UNPLACED}`), { timeout: 2000, interval: 10 });
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", assignments: [{ status: "running" }] });
  } finally { rerun.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(messages(deliveries)).toEqual([start(1), "请选择要发送的文件。", start(1), UNPLACED, "LEADER_CLOSING_1"]);
});

it("has a choice that a failed close left open closed when its request is cancelled while it is queued", async () => {
  // The host's close fails once, when the supplement supersedes the choice, and works afterwards.
  const openChoices = new Set(["run-1"]);
  let failing = true;
  const other = deferred();
  const executor: DispatchExecutor = { run: async (job) => {
    if (job.id === "one") return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" };
    await other.promise;
    return { status: "completed", message: "EXECUTOR_RESULT" };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { closeChoices: async () => {
    if (failing) { failing = false; return unclosable(); }
    openChoices.clear();
  } });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    // Another request of the same team runs, so the supplemented request stays queued behind it.
    dispatch.admit(event("two", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[1]?.assignments.map(({ status }) => status)).toEqual(["running"]), { timeout: 2000, interval: 10 });
    dispatch.admit(event("three", "supplement:one"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("queued"), { timeout: 2000, interval: 10 });
    expect([...openChoices]).toEqual(["run-1"]);
    dispatch.admit(event("four", "cancel:one"));
    await vi.waitFor(() => expect(messages(deliveries).at(-1)).toBe("已停止继续处理。已经完成的操作不会自动撤销。"), { timeout: 2000, interval: 10 });
    expect([...openChoices]).toEqual([]);
    expect(dispatch.getState().jobs.map(({ status }) => status)).toEqual(["cancelled", "running"]);
  } finally { other.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[1]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
});

// A superseded choice that could not be closed (agent-dispatch failure mode "Requester supplements a request that waits on a choice,
// the superseded choice cannot be closed, and the requester then answers it").
const SUPERSEDED = "这次选择已被你的补充取代，不再生效；这项请求会按补充后的要求继续处理。";
/** An Executor that raises the choice of run-1, then, rerun for a supplement, ends once `rerun` resolves with `result`. */
function supersededExecutor(rerun: Promise<void>, result: DispatchExecutionResult = { status: "completed", message: "已按补充处理。" }) {
  const executor = { runs: 0, run: async (): Promise<DispatchExecutionResult> => {
    executor.runs += 1;
    if (executor.runs === 1) return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" };
    await rerun;
    return result;
  }, close: () => {} };
  return executor;
}

it("leaves a request that goes on with a supplement as it is when an answer to its superseded choice is still handed over", async () => {
  const rerun = deferred();
  const executor = supersededExecutor(rerun.promise);
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  // This host acts on the answer whatever the dispatch says of its run, and hands the result over.
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { pending: choosing("completed"), closeChoices: unclosable });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    dispatch.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(executor.runs).toBe(2), { timeout: 2000, interval: 10 });
    dispatch.admit(event("three", "choose:1"));
    await vi.waitFor(() => expect(posts(deliveries).at(-1)).toBe(`cli_sam: ${SUPERSEDED}`), { timeout: 2000, interval: 10 });
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", attempt: 1, assignments: [{ status: "running", attempt: 1 }] });
  } finally { rerun.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posts(deliveries)).toEqual([`cli_alice: ${start(1)}`, "cli_alice: 请选择要发送的文件。", `cli_alice: ${start(1)}`, `cli_sam: ${SUPERSEDED}`, "cli_alice: LEADER_CLOSING_1"]);
});

it("leaves a request that goes on with a supplement as it is when the host reports its superseded choice's run as replaced by a new goal", async () => {
  const rerun = deferred();
  const executor = supersededExecutor(rerun.promise);
  // This host lets a new goal replace the open choice whatever the dispatch says of its run, and reports the run it cancelled.
  const dispatch = dispatchWith(directory(), closingLeader(), executor, [], { closeChoices: unclosable,
    pending: async (inbound) => inbound.text === "bill" ? { handled: false, cancelledRunRef: "run-1" } : { handled: false } });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    dispatch.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(executor.runs).toBe(2), { timeout: 2000, interval: 10 });
    // The new goal is a request for Bill's team, which runs beside the supplemented one.
    dispatch.admit(event("three", "bill"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[1]?.status).toBe("running"), { timeout: 2000, interval: 10 });
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", attempt: 1, assignments: [{ status: "running", attempt: 1 }] });
  } finally { rerun.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs.map(({ status }) => status)).toEqual(["completed", "completed"]), { timeout: 2000, interval: 10 });
});

/**
 * A host with the choices of `openChoices`, by run: `choose:<n>` answers the choice of run-<n> while it is open. It asks the
 * dispatch before it acts: an answer to a run the dispatch holds is reported as held, and any other is resumed, which `resumed` records.
 */
function answering(openChoices: ReadonlySet<string>, resumed: string[]) {
  return async (inbound: InboundContent, held: (runRef: string) => boolean): Promise<DispatchPendingResult> => {
    const runRef = `run-${/^choose:(\d+)$/u.exec(inbound.text)?.[1]}`;
    if (!openChoices.has(runRef)) return { handled: false };
    if (held(runRef)) return { handled: true, held: true, runRef };
    resumed.push(runRef);
    return { handled: true, senderAccountId: "cli_alice", runRef, result: { status: "completed", message: "已发送所选文件。" } };
  };
}
/** The host's close of the choices of the runs it is given, the request's Assignments' and its superseded ones; its first `failures` closes fail. */
function closingChoices(openChoices: Set<string>, failures: number) {
  return async (job: DispatchJob, assignments: readonly DispatchAssignment[]) => {
    if (failures-- > 0) return unclosable();
    for (const runRef of [...assignments.map((assignment) => assignment.runRef), ...(job.supersededRuns ?? [])]) if (runRef) openChoices.delete(runRef);
  };
}

it("names a superseded choice's run to the host before the host acts on its answer, has the choice closed again and replies once to each answer", async () => {
  const rerun = deferred();
  const executor = supersededExecutor(rerun.promise);
  const turns: string[] = [];
  const leader: TeamLeader = { plan: async () => { turns.push("plan"); return JSON.parse(plan); }, supplement: async () => { turns.push("supplement"); return affectFirst(); },
    close: async () => { turns.push("close"); return "已收尾。"; } };
  // The close fails when the supplement supersedes the choice and again at the first answer; at the second answer it works.
  const openChoices = new Set(["run-1"]), resumed: string[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [], captures: Capture[] = [];
  const dispatch = dispatchWith(directory(), leader, executor, deliveries, { pending: answering(openChoices, resumed), closeChoices: closingChoices(openChoices, 2), captures });
  const expected = [`cli_alice: ${start(1)}`, "cli_alice: 请选择要发送的文件。", `cli_alice: ${start(1)}`];
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    dispatch.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(executor.runs).toBe(2), { timeout: 2000, interval: 10 });
    for (const [key, stillOpen] of [["three", ["run-1"]], ["four", []]] as const) {
      expected.push(`cli_sam: ${SUPERSEDED}`);
      dispatch.admit(event(key, "choose:1"));
      await vi.waitFor(() => expect(posts(deliveries)).toEqual(expected), { timeout: 2000, interval: 10 });
      expect([...openChoices]).toEqual(stillOpen);
      expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", attempt: 1, assignments: [{ status: "running", attempt: 1 }] });
    }
  } finally { rerun.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posts(deliveries)).toEqual([...expected, "cli_alice: 已收尾。"]);
  expect(resumed).toEqual([]);
  expect(turns).toEqual(["plan", "supplement", "close"]);
  expect(executor.runs).toBe(2);
  // The two replies belong to no request: the request's records hold only its Team Leader's posts, and so does the group memory.
  const requestPosts = [start(1), "请选择要发送的文件。", start(1), "已收尾。"];
  expect(dispatch.records()[0]?.posts.map(({ text }) => text)).toEqual(requestPosts);
  expect(groupCaptures(captures).map(({ assistantText }) => assistantText)).toEqual([requestPosts.join("\n")]);
});

it.each([
  ["is queued behind another request of its team", "queued"],
  ["waits again, on a question of its rerun Executor", "waiting"],
] as const)("tells the requester that the request goes on when its superseded choice is answered while the request %s", async (_name, state) => {
  const rerun = deferred();
  // Waiting: the rerun asks back, with no run of its own. Queued: the team's other request runs, held, when the supplement arrives.
  const executor = supersededExecutor(rerun.promise, state === "waiting" ? { status: "waiting", message: "请补充要发送的版本。" } : undefined);
  const openChoices = new Set(["run-1"]), resumed: string[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { pending: answering(openChoices, resumed), closeChoices: unclosable });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    if (state === "queued") {
      dispatch.admit(event("other", "alice"));
      await vi.waitFor(() => expect(dispatch.getState().jobs[1]?.assignments.map(({ status }) => status)).toEqual(["running"]), { timeout: 2000, interval: 10 });
    } else rerun.resolve();
    dispatch.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]).toMatchObject({ status: state, attempt: 1 }), { timeout: 2000, interval: 10 });
    dispatch.admit(event("three", "choose:1"));
    await vi.waitFor(() => expect(posts(deliveries).at(-1)).toBe(`cli_sam: ${SUPERSEDED}`), { timeout: 2000, interval: 10 });
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: state, attempt: 1 });
    expect(resumed).toEqual([]);
  } finally { rerun.resolve(); }
});

it("replies as for an ended request when a superseded choice is answered while its request is being cancelled", async () => {
  const rerun = deferred();
  // The rerun's Executor ends, cancelled, only once `rerun` resolves, however early it is cancelled.
  const executor = supersededExecutor(rerun.promise, { status: "cancelled", message: "已取消" });
  const openChoices = new Set(["run-1"]), resumed: string[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { pending: answering(openChoices, resumed), closeChoices: unclosable });
  try {
    await dispatch.start();
    dispatch.admit(event("one", "alice"));
    await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    dispatch.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(executor.runs).toBe(2), { timeout: 2000, interval: 10 });
    // The cancel is taken in while the rerun's Executor is still stopping; the answer follows it.
    dispatch.admit(event("three", "cancel:one"));
    dispatch.admit(event("four", "choose:1"));
    await vi.waitFor(() => expect(posts(deliveries).at(-1)).toBe(`cli_sam: ${ENDED}`), { timeout: 2000, interval: 10 });
    expect(classified).toEqual(["dispatch", "supplement", "cancel"]);
    expect(dispatch.getState().jobs[0]).toMatchObject({ status: "running", assignments: [{ status: "running" }] });
    expect(resumed).toEqual([]);
  } finally { rerun.resolve(); }
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  expect(messages(deliveries)).toEqual([start(1), "请选择要发送的文件。", start(1), ENDED, "已停止继续处理。已经完成的操作不会自动撤销。"]);
});

it("keeps answering an Assignment's choice after a supplement superseded another Assignment that waited on no run", async () => {
  // The first Assignment raises the choice of run-1, also when it runs again; the second asks back, with no workflow run.
  const executor: DispatchExecutor = { run: async (_job, assignment) => assignment.title === "整理文案"
    ? { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" } : { status: "waiting", message: "请确认要核对的版本。" }, close: () => {} };
  const openChoices = new Set(["run-1"]), resumed: string[] = [];
  const host = answering(openChoices, resumed);
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  // `miss:1` is a selection that matches no open choice: the host reports the open choice's run as failed and leaves the choice open.
  // The Team Leader's answer to the supplement affects nothing and adds nothing.
  const dispatch = dispatchWith(directory(), dividingLeader(two, [], async () => ({ affected: [], assignments: [], decisions: [], parts: [], help: [] })), executor, deliveries, {
    closeChoices: unclosable,
    pending: async (inbound, held) => inbound.text === "miss:1"
      ? { handled: true, senderAccountId: "cli_alice", runRef: "run-1", result: { status: "failed", message: "之前的待选任务已经结束，请重新发起。" } } : host(inbound, held) });
  const request = () => dispatch.getState().jobs[0];
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(request()).toMatchObject({ status: "waiting", assignments: [{ status: "waiting" }, { status: "waiting" }] }), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "miss:1"));
  await vi.waitFor(() => expect(request()).toMatchObject({ status: "waiting", assignments: [{ status: "failed" }, { status: "waiting" }] }), { timeout: 2000, interval: 10 });
  // The supplement supersedes only the second Assignment, and the request ends with the first one failed.
  dispatch.admit(event("three", "supplement:one"));
  await vi.waitFor(() => expect(request()).toMatchObject({ status: "failed", attempt: 1, assignments: [{ status: "failed" }, { status: "cancelled" }] }), { timeout: 2000, interval: 10 });
  // The retry reruns the first Assignment, which waits on its choice again.
  dispatch.admit(event("four", "retry:one"));
  await vi.waitFor(() => expect(request()).toMatchObject({ status: "waiting", attempt: 2, assignments: [{ status: "waiting", attempt: 2 }, { status: "cancelled" }] }), { timeout: 2000, interval: 10 });
  dispatch.admit(event("five", "choose:1"));
  await vi.waitFor(() => expect(request()).toMatchObject({ status: "completed", assignments: [{ status: "completed" }, { status: "cancelled" }] }), { timeout: 2000, interval: 10 });
  expect(resumed).toEqual(["run-1"]);
  expect(messages(deliveries)).not.toContain(SUPERSEDED);
});

it("still holds an answer to a superseded choice after the rerun reported a run of its own and the request has ended, with the reply of an ended request", async () => {
  // The rerun ends with its own run, so no Assignment names run-1 any more; only the request's record of its superseded runs does.
  const executor = supersededExecutor(Promise.resolve(), { status: "completed", message: "已按补充处理。", runRef: "run-2" });
  const openChoices = new Set(["run-1"]), resumed: string[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), executor, deliveries, { pending: answering(openChoices, resumed), closeChoices: closingChoices(openChoices, 1) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  const ended = { status: "completed", result: "LEADER_CLOSING_1", runRef: "run-2", assignments: [{ status: "completed", attempt: 1 }] };
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]).toMatchObject(ended), { timeout: 2000, interval: 10 });
  expect([...openChoices]).toEqual(["run-1"]);
  dispatch.admit(event("three", "choose:1"));
  await vi.waitFor(() => expect(posts(deliveries).at(-1)).toBe(`cli_sam: ${ENDED}`), { timeout: 2000, interval: 10 });
  expect([...openChoices]).toEqual([]);
  expect(resumed).toEqual([]);
  expect(dispatch.getState().jobs[0]).toMatchObject(ended);
  expect(messages(deliveries)).toEqual([start(1), "请选择要发送的文件。", start(1), "LEADER_CLOSING_1", ENDED]);
});

it("does not post the reply to a superseded choice's answer again when a stop cut off its first send and the answer is taken in again", async () => {
  const state = directory();
  const rerun = deferred(), hung = deferred<never>();
  const executor = supersededExecutor(rerun.promise);
  const openChoices = new Set(["run-1"]);
  const before: Array<{ sender: string; message: string; id: string }> = [];
  const first = dispatchWith(state, closingLeader(), executor, before, { pending: answering(openChoices, []), closeChoices: unclosable,
    sending: (message) => message === SUPERSEDED ? hung.promise : undefined });
  try {
    await first.start();
    first.admit(event("one", "alice"));
    await vi.waitFor(() => expect(first.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    first.admit(event("two", "supplement:one"));
    await vi.waitFor(() => expect(executor.runs).toBe(2), { timeout: 2000, interval: 10 });
    first.admit(event("three", "choose:1"));
    // The process stops while the reply is being sent.
    await vi.waitFor(() => expect(posts(before).at(-1)).toBe(`cli_sam: ${SUPERSEDED}`), { timeout: 2000, interval: 10 });
    const reply = (dispatch: AgentDispatch) => dispatch.getState().notices.find(({ id }) => id === "three:coordination")?.state;
    expect(reply(first)).toBe("sending");

    // The next start takes the answer in again, with its choice still open, and reports the request that the stop cut off.
    const after: Array<{ sender: string; message: string; id: string }> = [];
    const taken: string[] = [], host = answering(openChoices, []);
    const second = dispatchWith(state, closingLeader(), executor, after, { closeChoices: unclosable,
      pending: (inbound, held) => { taken.push(inbound.key); return host(inbound, held); } });
    await second.start();
    await vi.waitFor(() => { expect(taken).toEqual(["three"]); expect(second.getState().jobs[0]?.status).toBe("failed"); }, { timeout: 2000, interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reply(second)).toBe("unknown");
    expect(messages(after).filter((message) => message === SUPERSEDED || message === ENDED)).toEqual([]);
    expect(messages(before).filter((message) => message === SUPERSEDED)).toHaveLength(1);
  // The abandoned first instance is closed and released whatever the outcome, so it writes nothing more and its close cannot hang.
  } finally { const stopped = first.close(); hung.reject(new Error("abandoned")); rerun.reject(new Error("abandoned")); await stopped; }
});

it("takes a waiting request's cancel again at the next start when a stop fell between closing its choice and recording the cancel", async () => {
  const state = directory();
  const hung = deferred<never>();
  const executor: DispatchExecutor = { run: async () => ({ status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" }), close: () => {} };
  let closing = false;
  const first = dispatchWith(state, closingLeader(), executor, [], { closeChoices: () => { closing = true; return hung.promise; } });
  try {
    await first.start();
    first.admit(event("one", "alice"));
    await vi.waitFor(() => expect(first.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    first.admit(event("two", "cancel:one"));
    // The process stops while the host is still closing the choice: the cancel is not recorded yet.
    await vi.waitFor(() => expect(closing).toBe(true), { timeout: 2000, interval: 10 });
    expect(first.getState().jobs[0]).toMatchObject({ status: "waiting", assignments: [{ status: "waiting" }] });

    const closed: string[] = [];
    const after: Array<{ sender: string; message: string; id: string }> = [];
    const second = dispatchWith(state, closingLeader(), executor, after, { closeChoices: async (job) => { closed.push(job.id); } });
    await second.start();
    await vi.waitFor(() => expect(messages(after)).toEqual(["已停止继续处理。已经完成的操作不会自动撤销。"]), { timeout: 2000, interval: 10 });
    expect(closed).toEqual(["one"]);
    expect(second.getState().jobs[0]).toMatchObject({ status: "cancelled", assignments: [{ status: "cancelled" }] });
  // The abandoned first instance is closed and released whatever the outcome, so it writes nothing more and its close cannot hang.
  } finally { const stopped = first.close(); hung.reject(new Error("abandoned")); await stopped; }
});

it("takes a waiting request's supplement again at the next start when a stop fell between closing its choice and recording the supplement", async () => {
  const state = directory();
  const hung = deferred<never>();
  let runs = 0;
  const executor: DispatchExecutor = { run: async () => {
    runs += 1;
    return runs === 1 ? { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" } : { status: "completed", message: "已按补充处理。" };
  }, close: () => {} };
  let closing = false;
  const first = dispatchWith(state, closingLeader(), executor, [], { closeChoices: () => { closing = true; return hung.promise; } });
  try {
    await first.start();
    first.admit(event("one", "alice"));
    await vi.waitFor(() => expect(first.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
    first.admit(event("two", "supplement:one"));
    // The process stops while the host is still closing the choice: the supplement is not recorded yet.
    await vi.waitFor(() => expect(closing).toBe(true), { timeout: 2000, interval: 10 });
    expect(first.getState().jobs[0]).toMatchObject({ status: "waiting", attempt: 0, assignments: [{ status: "waiting" }] });

    const closed: string[] = [];
    const after: Array<{ sender: string; message: string; id: string }> = [];
    const second = dispatchWith(state, closingLeader(), executor, after, { closeChoices: async (job) => { closed.push(job.id); } });
    await second.start();
    await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
    expect(closed).toEqual(["one"]);
    expect(second.getState().jobs[0]).toMatchObject({ attempt: 1, assignments: [{ status: "completed", attempt: 1 }] });
    expect(messages(after)).toEqual([start(1), "LEADER_CLOSING_1"]);
  // The abandoned first instance is closed and released whatever the outcome, so it writes nothing more and its close cannot hang.
  } finally { const stopped = first.close(); hung.reject(new Error("abandoned")); await stopped; }
});

it("has a request's choices closed at the next start when a stop cut off its cancel", async () => {
  const state = directory();
  const hung = deferred<never>();
  const executor: DispatchExecutor = { run: (_job, assignment) => assignment.title === "整理文案"
    ? Promise.resolve({ status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" }) : hung.promise, close: () => {} };
  const first = dispatchWith(state, dividingLeader(two), executor, [], { closeChoices: unclosable });
  try {
    await first.start();
    first.admit(event("one", "alice"));
    await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["waiting", "running"]), { timeout: 2000, interval: 10 });
    // The requester cancels while the second Executor still runs; the process then stops before it has stopped.
    first.admit(event("two", "cancel:one"));
    await vi.waitFor(() => expect(classified).toContain("cancel"), { timeout: 2000, interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const asked: string[] = [];
    const after: Array<{ sender: string; message: string; id: string }> = [];
    const second = dispatchWith(state, dividingLeader(two), executor, after, { closeChoices: async (job) => { asked.push(job.id); } });
    await second.start();
    expect(asked).toEqual(["one"]);
    await vi.waitFor(() => expect(messages(after)).toEqual([STOPPED_TWO]), { timeout: 2000, interval: 10 });
    expect(second.getState().jobs[0]).toMatchObject({ status: "cancelled", assignments: [{ status: "cancelled" }, { status: "cancelled" }] });
  // The abandoned first instance is closed and released whatever the outcome, so it writes nothing more and its close cannot hang.
  } finally { const stopped = first.close(); hung.reject(new Error("abandoned")); await stopped; }
});

// Which Team Leader sessions stored requests can still use (agent-dispatch::QR-003/AC-02): their runtime homes stay whole, and
// every other Team Leader home is superseded. Each request below runs in its own group, so a session's group tells which
// request keeps it.
const GROUPS = ["running", "waiting", "failed", "partial", "unassigned", "completed", "cancelled"] as const;
const group = (name: string) => `feishu.group.oc_${name}`;

it("keeps in use the sessions of the current definitions version, and of an older one only while a request under it runs or waits", async () => {
  let version = 1, revision = "r1";
  const held = deferred<DispatchExecutionResult>();
  const executor: DispatchExecutor = { run: async (job, assignment) => {
    if (job.event.target === group("running")) return held.promise;
    if (job.event.target === group("waiting") || job.event.target === group("cancelled")) return { status: "waiting", message: "请选择要发送的文件。", runRef: `run-${job.id}` };
    if (job.event.target === group("failed") || (job.event.target === group("partial") && assignment.title === "核对价格")) return { status: "failed", message: "无法完成。" };
    return { status: "completed", message: "已完成。" };
  }, close: () => {} };
  // One request asks for another team's help, and the Coordinator places the part with no team: it ends partially unassigned.
  const leader: TeamLeader = { plan: async (input) => ({ ...structuredClone(two), help: input.session.target === group("unassigned") ? [HELP] : [] }),
    supplement: affectFirst, close: async () => "已收尾。" };
  const dispatch = dispatchWith(directory(), leader, executor, [], { definitionsVersion: () => version, revision: () => revision,
    teams: (definitionsVersion) => definitionsVersion === 1 ? ["alice", "bill"] : ["alice", "bill", "jack"],
    assign: async ({ parts }) => parts.map(({ part }) => ({ part, agentId: null, summary: "" })) });
  await dispatch.start();
  for (const name of GROUPS) dispatch.admit(event(name, "alice", { target: group(name) }));
  dispatch.admit(event("proposed", "propose:alice", { target: group("proposed") }));
  const statuses = () => Object.fromEntries(dispatch.getState().jobs.map(({ id, status }) => [id, status]));
  await vi.waitFor(() => expect(statuses()).toEqual({ running: "running", waiting: "waiting", failed: "failed", partial: "partially_failed", unassigned: "partially_unassigned",
    completed: "completed", cancelled: "waiting", proposed: "proposed" }), { timeout: 2000, interval: 10 });
  dispatch.admit(event("stop", "cancel:cancelled", { target: group("cancelled") }));
  await vi.waitFor(() => expect(statuses().cancelled).toBe("cancelled"), { timeout: 2000, interval: 10 });
  const sessions = () => dispatch.leaderSessions().map(({ leaderId, target, revision: used, definitionsVersion, accountId, bindingHash }) =>
    `${target} ${leaderId} ${used} v${definitionsVersion} ${accountId} ${bindingHash}`).sort();
  const of = (names: readonly string[], used: string) => names.flatMap((name) => ["alice", "bill"].map((leaderId) =>
    `${group(name)} ${leaderId} ${used} v1 cli_sam binding-alpha`)).sort();
  // Version 1 is current: every request that ran under it keeps its group's sessions; the proposal never ran and has none.
  expect(sessions()).toEqual(of(GROUPS, "r1"));
  // Version 2 takes effect and the access revision changes: only the running and the waiting request still keep version 1,
  // for each of its teams, under the revision a turn would use now.
  version = 2; revision = "r2";
  expect(sessions()).toEqual(of(["running", "waiting"], "r2"));
  held.resolve({ status: "completed", message: "已完成。" });
  await vi.waitFor(() => expect(statuses().running).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(sessions()).toEqual(of(["waiting"], "r2"));
});

it("stops keeping a failed request's version in use, and keeps it again once a retry queues the request", async () => {
  let version = 1;
  const held = deferred<DispatchExecutionResult>();
  const executor: DispatchExecutor = { run: async (job) => job.id === "one" && job.attempt === 0 ? { status: "failed", message: "无法完成。" } : held.promise, close: () => {} };
  const dispatch = dispatchWith(directory(), dividingLeader(two), executor, [], { definitionsVersion: () => version, teams: () => ["alice"] });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  const versions = () => dispatch.leaderSessions().map(({ definitionsVersion }) => definitionsVersion).sort();
  expect(versions()).toEqual([1]);
  version = 2;
  expect(versions()).toEqual([]);
  // A request of the same team in the same group holds the worker, so the retried request stays queued behind it.
  dispatch.admit(event("two", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[1]?.status).toBe("running"), { timeout: 2000, interval: 10 });
  expect(versions()).toEqual([2]);
  dispatch.admit(event("three", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("queued"), { timeout: 2000, interval: 10 });
  expect(versions()).toEqual([1, 2]);
  held.resolve({ status: "completed", message: "已完成。" });
  await vi.waitFor(() => expect(dispatch.getState().jobs.map(({ status }) => status)).toEqual(["completed", "completed"]), { timeout: 2000, interval: 10 });
  expect(versions()).toEqual([2]);
});

// Cross-team work through the Coordinator (agent-dispatch::REQ-013, US-003/AC-02, US-003/AC-04, REQ-007/AC-03, AC-04, REQ-008/AC-01).
// The Team Leaders are the production fixture class, so each team's injected outputs still pass the production parsers and the
// correction loop; the Coordinator's cross-team turn is a fake that records its input.
const HELP = { title: "自动上架脚本", brief: "只交付代码，不运行" };
const leadPlan = { assignments: three.assignments.slice(0, 2), decisions: [] as string[], help: [HELP] };
const billPlan = { assignments: [{ profileId: "executor-1", title: "编写脚本", brief: "写上架脚本" }, { profileId: "executor-2", title: "核对接口", brief: "核对上架接口" }],
  decisions: [] as string[], help: [] as Array<{ title: string; brief: string }> };
type TeamTurns = Record<string, { plans?: unknown[]; supplement?: unknown; closing?: unknown }>;
/** Fixture Team Leaders answering from `turns` by team; `onPlan` sees each plan turn's team as it starts. */
function teamLeaders(turns: TeamTurns, onPlan?: (teamId: string) => void) {
  return new FixtureTeamLeader({
    leaderPlan: (_message, teamId) => { onPlan?.(teamId); const plans = turns[teamId]?.plans; return plans?.length ? structuredClone(plans.length > 1 ? plans.shift() : plans[0]) : undefined; },
    leaderSupplement: (_message, teamId) => next(turns[teamId]?.supplement), leaderClosing: (_message, teamId) => next(turns[teamId]?.closing) });
}
/** The next of a list of injected outputs, one per turn, the last repeating; a single value repeats. */
function next(value: unknown) {
  return structuredClone(Array.isArray(value) ? (value.length > 1 ? value.shift() : value[0]) : value);
}
const crossTurns = (): TeamTurns => ({ alice: { plans: [structuredClone(leadPlan)], closing: { message: "ALICE_CLOSING" } }, bill: { plans: [structuredClone(billPlan)], closing: { message: "BILL_CLOSING" } } });
const toBill = async () => [{ part: 1, agentId: "bill", summary: "SAM_SUMMARY" }];
const LEAD_START = "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格\n自动上架脚本需要其他团队支持，已请 Sam 协调。\n完成后会在本群汇报。";
const ANNOUNCED = "应 Alice 请求，自动上架脚本交给 Bill 队；完成后经 Sam 交回 Alice 汇总。";
const BILL_START = "我安排：\n执行者 3（能力档 1）处理：编写脚本\n执行者 4（能力档 2）处理：核对接口\n完成后经 Sam 交回 Alice 汇总。";
const BILL_CLOSED = "BILL_CLOSING\n结果经 Sam 交回 Alice 汇总。";
const posts = (deliveries: Array<{ sender: string; message: string }>) => deliveries.map(({ sender, message }) => `${sender}: ${message}`);
const leaderTurns = (leader: FixtureTeamLeader, phase: string, teamId: string) => leader.requests.filter((request) => request.phase === phase && request.teamId === teamId)
  .map(({ input }) => input as Record<string, unknown>);

it("places a part with another team, whose Team Leader starts and closes it, and closes the request with the report the Coordinator relays", async () => {
  let version = 1;
  // Bill's plan has a team-internal decision, posted under Bill after every start message (agent-dispatch::US-003/AC-03).
  const turns = crossTurns();
  turns.bill!.plans = [{ ...billPlan, decisions: ["先写脚本，再核对接口"] }];
  const leader = teamLeaders(turns, (teamId) => { if (teamId === "alice") version = 2; });
  const assigned: CrossTeamInput[] = [];
  const billClosed = deferred();
  const runs: string[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    runs.push(`${assignment.teamId}:${assignment.title}:${assignment.profileName}`);
    // The lead's Executors end only after Bill's team closed, so Bill's closing is posted while the request still runs.
    if (assignment.teamId === "alice") await billClosed.promise;
    return { status: "completed", message: `RESULT_${assignment.title}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, executor, deliveries, { definitionsVersion: () => version, rejected: new Set(["dispatch:one:cross-team:0"]),
    assign: async (input) => { assigned.push(structuredClone(input)); return toBill(); }, delivered: (message) => { if (message === BILL_CLOSED) billClosed.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // The Coordinator's rejected announcement has its own delivery state and holds no work up (agent-dispatch::REQ-008/AC-03).
  expect(posts(deliveries)).toEqual([`cli_alice: ${LEAD_START}`, `cli_sam: ${ANNOUNCED}`, `cli_bill: ${BILL_START}`, "cli_bill: 先写脚本，再核对接口", `cli_bill: ${BILL_CLOSED}`,
    "cli_alice: ALICE_CLOSING"]);
  expect(dispatch.getState().notices.find(({ id }) => id === "one:cross-team:0")?.state).toBe("rejected");
  // One request holds every team's Assignments; Bill's presets come from the request's definitions version, not the current one.
  expect(dispatch.getState().jobs[0]?.assignments.map(({ teamId, executor: name }) => `${teamId}:${name}`)).toEqual(["alice:执行者 1", "alice:执行者 2", "bill:执行者 3", "bill:执行者 4"]);
  expect(runs.filter((run) => run.startsWith("bill:")).sort()).toEqual(["bill:核对接口:能力档 2", "bill:编写脚本:能力档 1"]);
  // The Coordinator sees only what the lead reported: no Executor content (agent-dispatch::REQ-012/AC-04).
  expect(assigned).toEqual([{ requestId: "one", coordinator: "Sam", message: "alice", summary: "alice 的请求", lead: { id: "alice", name: "Alice", responsibility: "商品运营" },
    parts: [{ part: 1, ...HELP }], teams: [{ id: "bill", name: "Bill", responsibility: "衣食住行" }], fixtureMessageId: "om_one" }]);
  // Bill's Brief comes from the Coordinator; the lead's closing gets Bill's report, never Bill's Executor results (agent-dispatch::REQ-013/AC-03).
  expect(leaderTurns(leader, "plan", "bill")).toEqual([expect.objectContaining({ brief: { message: "alice", summary: "alice 的请求" },
    relay: { requestedBy: "Alice", parts: [{ ...HELP, summary: "SAM_SUMMARY" }] } })]);
  const [closing] = leaderTurns(leader, "close", "alice");
  expect(closing).toEqual(expect.objectContaining({ relay: { parts: [{ title: HELP.title, team: "Bill 团队", report: "BILL_CLOSING" }] },
    assignments: [expect.objectContaining({ executor: "执行者 1" }), expect.objectContaining({ executor: "执行者 2" })] }));
  expect(JSON.stringify(closing)).not.toContain("RESULT_编写脚本");
});

it.each([
  ["no team for the part", 1, async () => [{ part: 1, agentId: null, summary: "" }], accepting],
  ["an invalid cross-team decision", 1, async () => { throw new Error("dispatch_cross_team_invalid"); }, accepting],
  ["a decision naming the lead team, which the host refuses", 1, async () => [{ part: 1, agentId: "alice", summary: "自己做" }], accepting],
  ["no other team accepting work in the group", 0, toBill, ["alice"]],
  ["a team the request's definitions version does not know", 0, toBill, accepting, (id: string, version?: number) => id === "bill" ? undefined : team(id, version)],
] as Array<[string, number, () => Promise<unknown>, readonly string[], (typeof team)?]>)("leaves a part untaken with %s: no other team posts, and the request is partially unassigned", async (_case, asked, assign, roster, view) => {
  const leader = teamLeaders(crossTurns());
  let calls = 0;
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, { run: async () => ({ status: "completed", message: "完成" }), close: () => {} }, deliveries,
    { roster, ...(view ? { team: view } : {}), assign: async () => { calls += 1; return assign() as never; } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_unassigned"), { timeout: 2000, interval: 10 });
  expect(calls).toBe(asked);
  expect(posts(deliveries)).toEqual(["cli_alice: 我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格\n完成后会在本群汇报。",
    "cli_alice: ALICE_CLOSING\n自动上架脚本没有团队承接，本次未处理；有团队可以承接后，可以明确要求重试。"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ teamId }) => teamId)).toEqual(["alice", "alice"]);
  expect(leaderTurns(leader, "close", "alice")[0]?.relay).toEqual({ parts: [{ title: HELP.title, team: null }] });
});

it.each([
  ["a team takes the part now", [{ part: 1, agentId: "bill", summary: "SAM_SUMMARY" }], "completed",
    [`cli_sam: ${ANNOUNCED}`, `cli_bill: ${BILL_START}`, "cli_bill: 先写脚本", `cli_bill: ${BILL_CLOSED}`, "cli_alice: ALICE_CLOSING"]],
  ["still no team takes it", [{ part: 1, agentId: null, summary: "" }], "partially_unassigned",
    ["cli_alice: ALICE_CLOSING\n自动上架脚本仍没有团队承接，本次未处理；有团队可以承接后，可以明确要求重试。"]],
] as const)("asks the Coordinator again on a retry when %s, and redoes no completed Assignment", async (_case, second, outcome, retried) => {
  const decisions = [[{ part: 1, agentId: null, summary: "" }], second];
  const runs: string[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  // The plan of a part placed on the retry carries a decision, posted under Bill.
  const turns = crossTurns();
  turns.bill!.plans = [{ ...billPlan, decisions: ["先写脚本"] }];
  const dispatch = dispatchWith(directory(), teamLeaders(turns), { run: async (_job, assignment) => { runs.push(assignment.title); return { status: "completed", message: "完成" }; },
    close: () => {} }, deliveries, { assign: async () => structuredClone(decisions.shift()!) as never });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_unassigned"), { timeout: 2000, interval: 10 });
  const before = deliveries.length;
  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(posts(deliveries.slice(before))).toEqual(retried), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe(outcome), { timeout: 2000, interval: 10 });
  expect(decisions).toEqual([]);
  expect(runs).toEqual(["整理文案", "核对价格", ...(outcome === "completed" ? ["编写脚本", "核对接口"] : [])]);
});

it.each([
  ["merges its plan in a correction turn to fit the ceiling", [5, 4], "completed", 10],
  ["fails the request with no Executor when its plan stays over the ceiling", [5, 5], "failed", 0],
] as const)("counts the request's Assignments of every team: a cross-team Team Leader %s", async (_case, sizes, outcome, count) => {
  const many = (n: number, title: string) => Array.from({ length: n }, (_unused, index) => ({ profileId: "executor-1", title: `${title} ${index + 1}`, brief: "说明" }));
  const turns: TeamTurns = { alice: { plans: [{ assignments: many(6, "文案"), decisions: [], help: [HELP] }], closing: { message: "ALICE_CLOSING" } },
    bill: { plans: sizes.map((size) => ({ assignments: many(size, "脚本"), decisions: [], help: [] })), closing: { message: "BILL_CLOSING" } } };
  const leader = teamLeaders(turns);
  let runs = 0;
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, { run: async () => { runs += 1; return { status: "completed", message: "完成" }; }, close: () => {} }, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe(outcome), { timeout: 2000, interval: 10 });
  expect(leaderTurns(leader, "plan", "bill").map(({ refusal }) => refusal)).toEqual([undefined, "这件事务共有 11 项分工，超过上限 10 项；请合并相近的分工"]);
  expect(dispatch.getState().jobs[0]?.assignments).toHaveLength(count);
  expect(runs).toBe(count);
  if (outcome === "failed") expect(posts(deliveries)).toEqual(["cli_alice: 我暂时无法形成有效分工，本次尚未开始处理。请补充需求后明确重试。"]);
});

it("returns a cross-team Team Leader's own help request to the lead instead of placing it", async () => {
  const turns = crossTurns();
  turns.bill!.plans = [{ ...billPlan, help: [{ title: "拍商品照片", brief: "白底三张" }] }];
  const leader = teamLeaders(turns);
  let calls = 0;
  const dispatch = dispatchWith(directory(), leader, { run: async () => ({ status: "completed", message: "完成" }), close: () => {} }, [],
    { assign: async () => { calls += 1; return toBill(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(calls).toBe(1);
  expect(leaderTurns(leader, "close", "alice")[0]?.relay).toEqual({ parts: [{ title: HELP.title, team: "Bill 团队", report: "BILL_CLOSING" }],
    needs: [{ team: "Bill 团队", title: "拍商品照片", brief: "白底三张" }] });
});

it("stops the other team's Assignments too when the requester cancels the request", async () => {
  const stopped: string[] = [];
  const executor: DispatchExecutor = { run: (_job, assignment, signal) => new Promise((resolve) => signal.addEventListener("abort", () => {
    stopped.push(assignment.title); resolve({ status: "cancelled", message: "已取消" }); })), close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(crossTurns()), executor, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["running", "running", "running", "running"]), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "cancel:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stopped.sort()).toEqual(["整理文案", "核对价格", "核对接口", "编写脚本"].sort());
  expect(posts(deliveries).slice(3)).toEqual(["cli_alice: 已停止继续处理：\n执行者 1「整理文案」已停止\n执行者 2「核对价格」已停止\n执行者 3「编写脚本」已停止\n执行者 4「核对接口」已停止\n已经完成的操作不会自动撤销。"]);
});

it("relays a supplement affecting the other team's part to its Team Leader, each shown only its own Assignments", async () => {
  const turns = crossTurns();
  turns.alice!.supplement = { affected: [], assignments: [], decisions: [], parts: [1], help: [] };
  turns.bill!.supplement = { affected: [2], assignments: [], decisions: [], parts: [], help: [] };
  const leader = teamLeaders(turns);
  const gate = deferred();
  const runs: string[] = [];
  const executor: DispatchExecutor = { run: async (job, assignment) => {
    runs.push(`${assignment.title}:${assignment.attempt}:${(assignment.input ?? job.executionEvent ?? job.event).text}`);
    if (assignment.attempt === 0) await gate.promise;
    return { status: "completed", message: "完成" };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, executor, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(runs).toHaveLength(4), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(runs).toHaveLength(5), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(runs[4]).toBe("核对接口:1:supplement:one");
  // Positions number what each Team Leader is shown (agent-dispatch::REQ-007/AC-04).
  const [lead] = leaderTurns(leader, "supplement", "alice"), [other] = leaderTurns(leader, "supplement", "bill");
  expect(lead?.assignments).toEqual([expect.objectContaining({ position: 1, executor: "执行者 1" }), expect.objectContaining({ position: 2, executor: "执行者 2" })]);
  expect(lead?.relay).toEqual({ parts: [{ title: HELP.title, team: "Bill 团队", report: "BILL_CLOSING" }] });
  expect(other?.assignments).toEqual([expect.objectContaining({ position: 1, executor: "执行者 3" }), expect.objectContaining({ position: 2, executor: "执行者 4" })]);
  expect(other?.relay).toEqual(expect.objectContaining({ requestedBy: "Alice" }));
  // The relay itself has no post; only the rerun's start and the closings go out.
  await vi.waitFor(() => expect(posts(deliveries).slice(5)).toEqual(["cli_bill: 我安排执行者 4（能力档 2）处理：核对接口。完成后经 Sam 交回 Alice 汇总。", `cli_bill: ${BILL_CLOSED}`,
    "cli_alice: ALICE_CLOSING"]), { timeout: 2000, interval: 10 });
});

it("posts a cross-team failure under its own Team Leader, and a retry reruns it there without a new announcement", async () => {
  const failurePosted = deferred();
  const runs: string[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    runs.push(`${assignment.title}:${assignment.attempt}`);
    if (assignment.title === "编写脚本" && assignment.attempt === 0) return { status: "failed", message: "接口文档无法访问" };
    if (assignment.attempt === 0) await failurePosted.promise;
    return { status: "completed", message: "完成" };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(crossTurns()), executor, deliveries,
    { assign: toBill, delivered: (message) => { if (message.includes("未能完成")) failurePosted.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(posts(deliveries).slice(3)).toEqual(["cli_bill: 执行者 3（能力档 1）的分工「编写脚本」未能完成：执行者报告无法完成。其余分工继续处理。", `cli_bill: ${BILL_CLOSED}`,
    "cli_alice: ALICE_CLOSING"]);
  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(runs.slice(4)).toEqual(["编写脚本:1"]);
  expect(posts(deliveries).slice(6)).toEqual(["cli_bill: 我安排执行者 3（能力档 1）处理：编写脚本。完成后经 Sam 交回 Alice 汇总。", `cli_bill: ${BILL_CLOSED}`, "cli_alice: ALICE_CLOSING"]);
});

it("posts a cross-team Assignment's pending choice under its own Team Leader, who closes its part once the choice is resolved", async () => {
  const executor: DispatchExecutor = { run: async (_job, assignment) => assignment.title === "编写脚本"
    ? { status: "waiting", message: "请选择要发送的脚本。", runRef: "run-1" } : { status: "completed", message: "完成" }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(crossTurns()), executor, deliveries, { assign: toBill,
    pending: async (inbound) => inbound.text === "choose:1" ? { handled: true, senderAccountId: "cli_bill", runRef: "run-1", result: { status: "completed", message: "已发送所选脚本。" } }
      : { handled: false } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  expect(posts(deliveries).slice(3)).toEqual(["cli_bill: 请选择要发送的脚本。"]);
  dispatch.admit(event("two", "choose:1"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(posts(deliveries).slice(4)).toEqual([`cli_bill: ${BILL_CLOSED}`, "cli_alice: ALICE_CLOSING"]);
});

it("reports a cross-team Assignment cut off by a restart under its own Team Leader, who closes its part before the lead closes", async () => {
  const state = directory();
  const hung = deferred<never>();
  const first = dispatchWith(state, teamLeaders(crossTurns()), { run: (_job, assignment) => assignment.title === "编写脚本" ? hung.promise
    : Promise.resolve({ status: "completed", message: "完成" }), close: () => {} }, [], { assign: toBill });
  await first.start();
  first.admit(event("one", "alice"));
  await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "completed", "running", "completed"]), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1);
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, teamLeaders(crossTurns()), { run: async () => ({ status: "completed", message: "完成" }), close: () => {} }, after, { assign: toBill });
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(posts(after)).toEqual(["cli_bill: 服务中断，执行者 3（能力档 1）的分工「编写脚本」已中断，无法确认已完成的内容，不会自动重放。", `cli_bill: ${BILL_CLOSED}`, "cli_alice: ALICE_CLOSING"]);
  hung.reject(new Error("abandoned")); await first.close();
});

it("starts no Executor when a cross-team Team Leader's start message is not confirmed as sent", async () => {
  let runs = 0;
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(crossTurns()), { run: async () => { runs += 1; return { status: "completed", message: "完成" }; }, close: () => {} }, deliveries,
    { assign: toBill, rejected: new Set(["dispatch:one:receipt:0:bill"]) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  expect(runs).toBe(0);
  expect(posts(deliveries)).toEqual([`cli_alice: ${LEAD_START}`, `cli_sam: ${ANNOUNCED}`, `cli_bill: ${BILL_START}`,
    "cli_alice: 接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。"]);
});

it("posts each Assignment's own result as a cross-team closing when its Team Leader's closing turn fails, and relays that report", async () => {
  const turns = crossTurns();
  // An empty closing message fails the production closing parser, as an invalid model output does.
  turns.bill!.closing = { message: "  " };
  const leader = teamLeaders(turns);
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, { run: async (_job, assignment) => ({ status: "completed", message: `${assignment.title}已完成。` }), close: () => {} }, deliveries,
    { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  const fallback = "执行者 3「编写脚本」已完成。编写脚本已完成。\n执行者 4「核对接口」已完成。核对接口已完成。";
  expect(posts(deliveries).slice(3)).toEqual([`cli_bill: ${fallback}\n结果经 Sam 交回 Alice 汇总。`, "cli_alice: ALICE_CLOSING"]);
  expect(leaderTurns(leader, "close", "alice")[0]?.relay).toEqual({ parts: [{ title: HELP.title, team: "Bill 团队", report: fallback }] });
});

const PHOTO = { title: "商品拍照", brief: "白底三张" };
const done: DispatchExecutor = { run: async () => ({ status: "completed", message: "完成" }), close: () => {} };

it.each([
  ["with two teams", [{ part: 1, agentId: "bill", summary: "S1" }, { part: 2, agentId: "jack", summary: "S2" }],
    "应 Alice 请求：\n自动上架脚本交给 Bill 队\n商品拍照交给 Jack 队\n完成后经 Sam 交回 Alice 汇总。", [{ ...HELP, summary: "S1" }], 1,
    [`cli_bill: ${BILL_START}`, "cli_jack: 我安排执行者 5（能力档 1）处理：拍摄商品。完成后经 Sam 交回 Alice 汇总。"]],
  ["with one team, which plans once for both", [{ part: 1, agentId: "bill", summary: "S1" }, { part: 2, agentId: "bill", summary: "S2" }],
    "应 Alice 请求：\n自动上架脚本交给 Bill 队\n商品拍照交给 Bill 队\n完成后经 Sam 交回 Alice 汇总。", [{ ...HELP, summary: "S1" }, { ...PHOTO, summary: "S2" }], 0,
    [`cli_bill: ${BILL_START}`]],
] as const)("places two parts %s, naming each in the lead's start and the Coordinator's announcement", async (_case, decisions, announced, billParts, jackPlans, starts) => {
  const turns = crossTurns();
  turns.alice!.plans = [{ ...leadPlan, help: [HELP, PHOTO] }];
  turns.jack = { plans: [{ assignments: [{ profileId: "executor-1", title: "拍摄商品", brief: "白底" }], decisions: [], help: [] }], closing: { message: "JACK_CLOSING" } };
  const leader = teamLeaders(turns);
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, done, deliveries, { roster: ["alice", "bill", "jack"], assign: async () => structuredClone(decisions) as never });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(posts(deliveries).slice(0, 2)).toEqual(["cli_alice: 我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格\n" +
    "自动上架脚本需要其他团队支持，已请 Sam 协调。\n商品拍照需要其他团队支持，已请 Sam 协调。\n完成后会在本群汇报。", `cli_sam: ${announced}`]);
  // Each cross-team Team Leader's start names only its own team's Assignments (agent-dispatch::US-003/AC-01).
  expect(posts(deliveries).slice(2, 2 + starts.length)).toEqual(starts);
  // Each team plans once, for its own parts only (agent-dispatch::REQ-013/AC-03).
  expect(leaderTurns(leader, "plan", "bill").map(({ relay }) => relay)).toEqual([{ requestedBy: "Alice", parts: billParts }]);
  expect(leaderTurns(leader, "plan", "jack")).toHaveLength(jackPlans);
});

it("counts every team's Assignments against the ceiling when the lead's supplement adds more, with a correction turn", async () => {
  const many = (n: number, title: string) => Array.from({ length: n }, (_unused, index) => ({ profileId: "executor-1", title: `${title} ${index + 1}`, brief: "说明" }));
  const turns: TeamTurns = { alice: { plans: [{ assignments: many(6, "文案"), decisions: [], help: [HELP] }], closing: { message: "ALICE_CLOSING" },
    supplement: [{ affected: [], assignments: many(2, "补充"), decisions: [], parts: [], help: [] }, { affected: [], assignments: many(1, "补充"), decisions: [], parts: [], help: [] }] },
    bill: { plans: [{ assignments: many(3, "脚本"), decisions: [], help: [] }], closing: { message: "BILL_CLOSING" } } };
  const leader = teamLeaders(turns);
  const gate = deferred();
  const dispatch = dispatchWith(directory(), leader, { run: async (_job, assignment) => { if (assignment.attempt === 0) await gate.promise; return { status: "completed", message: "完成" }; },
    close: () => {} }, [], { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.assignments).toHaveLength(9), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.assignments).toHaveLength(10), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(leaderTurns(leader, "supplement", "alice").map(({ refusal }) => refusal)).toEqual([undefined, "这件事务共有 11 项分工，超过上限 10 项；请合并相近的分工"]);
});

it("places a part the lead's supplement asks for, and runs what the other team's relayed answer adds, returning its need to the lead", async () => {
  const turns = crossTurns();
  turns.alice!.supplement = { affected: [], assignments: [], decisions: [], parts: [1], help: [PHOTO] };
  turns.bill!.plans = [structuredClone(billPlan), { assignments: [{ profileId: "executor-1", title: "拍摄商品", brief: "白底" }], decisions: ["再拍照"], help: [] }];
  turns.bill!.supplement = { affected: [], assignments: [{ profileId: "executor-2", title: "补充脚本说明", brief: "写清运行方式" }], decisions: ["先补说明"], parts: [],
    help: [{ title: "申请接口权限", brief: "上架接口需要授权" }] };
  const leader = teamLeaders(turns);
  const gate = deferred();
  const runs: string[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, { run: async (_job, assignment) => { runs.push(assignment.title); if (assignment.attempt === 0) await gate.promise;
    return { status: "completed", message: "完成" }; }, close: () => {} }, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(runs).toHaveLength(4), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(runs).toHaveLength(6), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(runs.slice(4).sort()).toEqual(["拍摄商品", "补充脚本说明"].sort());
  // Bill's decisions from his relayed answer and from his plan for the new part are both posted, under Bill (agent-dispatch::US-003/AC-03).
  expect(posts(deliveries).filter((post) => ["cli_bill: 先补说明", "cli_bill: 再拍照"].includes(post))).toEqual(["cli_bill: 先补说明", "cli_bill: 再拍照"]);
  expect(posts(deliveries).filter((post) => post.startsWith("cli_sam: "))).toEqual([`cli_sam: ${ANNOUNCED}`, "cli_sam: 应 Alice 请求，商品拍照交给 Bill 队；完成后经 Sam 交回 Alice 汇总。"]);
  expect(leaderTurns(leader, "close", "alice").at(-1)?.relay).toEqual({ parts: [{ title: HELP.title, team: "Bill 团队", report: "BILL_CLOSING" },
    { title: PHOTO.title, team: "Bill 团队", report: "BILL_CLOSING" }], needs: [{ team: "Bill 团队", title: "申请接口权限", brief: "上架接口需要授权" }] });
});

it("falls back to its own results and each relayed report when the lead's closing turn fails", async () => {
  const turns = crossTurns();
  turns.alice!.closing = { message: "  " };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(turns), done, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(posts(deliveries).at(-1)).toBe("cli_alice: 执行者 1「整理文案」已完成。完成\n执行者 2「核对价格」已完成。完成\n自动上架脚本（Bill 队，经 Sam 转交）：BILL_CLOSING");
});

it("captures a cross-team request with every post into the group memory, and each Team Leader's own division into its memory", async () => {
  const captures: Capture[] = [];
  const dispatch = dispatchWith(directory(), teamLeaders(crossTurns()), done, [], { assign: toBill, captures });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)[0]?.assistantText).toBe([LEAD_START, ANNOUNCED, BILL_START, BILL_CLOSED, "ALICE_CLOSING"].join("\n"));
  // A cross-team Team Leader remembers the Brief it got from the Coordinator: who asked and the part it took (agent-dispatch::REQ-012/AC-02).
  expect(captures.filter(({ scope }) => scope.kind === "leader").map(({ scope, senderAccountId, userText, assistantText }) => ({ scope, senderAccountId, userText, assistantText })))
    .toEqual([
    { scope: { kind: "leader", teamId: "bill" }, senderAccountId: "cli_bill", userText: "请求：alice\n协调摘要：alice 的请求\n应 Alice 请求承接：自动上架脚本（SAM_SUMMARY）",
      assistantText: "分工：执行者 3（能力档 1）编写脚本；执行者 4（能力档 2）核对接口\n收尾：BILL_CLOSING" },
    { scope: { kind: "leader", teamId: "alice" }, senderAccountId: "cli_alice", userText: "请求：alice\n协调摘要：alice 的请求",
      assistantText: "分工：执行者 1（能力档 1）整理文案；执行者 2（能力档 2）核对价格\n收尾：ALICE_CLOSING" }]);
});

it("keeps a cross-team team's frozen application when a later division adds to its work, so a replaced application sends nothing", async () => {
  const state = directory();
  const decisions = [[{ part: 1, agentId: "bill", summary: "S1" }, { part: 2, agentId: null, summary: "" }], [{ part: 1, agentId: "bill", summary: "S2" }]];
  const turns = crossTurns();
  turns.alice!.plans = [{ ...leadPlan, help: [HELP, PHOTO] }];
  turns.bill!.plans = [structuredClone(billPlan), { assignments: [{ profileId: "executor-1", title: "拍摄商品", brief: "白底" }], decisions: [], help: [] }];
  const first = dispatchWith(state, teamLeaders(turns), done, [], { assign: async () => structuredClone(decisions.shift()!) as never });
  await first.start();
  first.admit(event("one", "alice"));
  await vi.waitFor(() => expect(first.getState().jobs[0]?.status).toBe("partially_unassigned"), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1); await first.close();
  // Bill's application is replaced; the retry places the untaken part with Bill again.
  let runs = 0;
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const replaced = agents.map((agent) => agent.id === "bill" ? { ...agent, senderAccountId: "cli_bill_new" } : agent);
  const second = dispatchWith(state, teamLeaders(turns), { run: async () => { runs += 1; return { status: "completed", message: "完成" }; }, close: () => {} }, after,
    { agents: replaced, assign: async () => structuredClone(decisions.shift()!) as never });
  await second.start();
  second.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  expect(runs).toBe(0);
  expect(after.map(({ sender }) => sender)).not.toContain("cli_bill_new");
  expect(posts(after).at(-1)).toBe("cli_alice: 接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。");
});

// The Coordinator's sentence for a rejected lead start message, the one post another identity makes for a team
// (agent-dispatch::REQ-008/AC-04, AC-03). A cross-team Team Leader's start message gets none: "starts no Executor when a
// cross-team Team Leader's start message is not confirmed as sent" above pins every post of that case.
// Gap: a storage failure while the sentence is stored is not driven, for the lack of a storage seam named at the top of this file.
const NOT_STARTED = "Alice 队的接单通知未能发出，本次尚未开始处理。请检查 Alice 是否可在本群发言后明确重试。";
const RECEIPT_FAILED = "接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。";
const WAIT = { timeout: 2000, interval: 10 };
const noticeStates = (dispatch: AgentDispatch) => dispatch.getState().notices.map(({ id, state }) => `${String(id)} ${String(state)}`);

// A start message the platform rejects is driven by the cases below that refuse `dispatch:one:receipt:0`.
it.each([
  ["refused by the channel, which has no sender for the application", { ok: false, reason: "unavailable", acceptedSegments: 0 }, "rejected"],
  ["of unknown outcome", { ok: false, reason: "unknown", acceptedSegments: 0 }, "unknown"],
  ["accepted in part", { ok: false, reason: "rejected", acceptedSegments: 1, totalSegments: 2 }, "unknown"],
] as const)("has the Coordinator tell the group once that the attempt has not started only for a lead start message recorded as rejected: one %s", async (_case, receipt, recorded) => {
  let runs = 0;
  const deliveries: Array<{ sender: string; message: string; id: string }> = [], destinations: string[] = [];
  // The request comes from a group of its own, and the lead's failure report is refused too, as when its application cannot post.
  const dispatch = dispatchWith(directory(), closingLeader(), { run: async () => { runs += 1; return { status: "completed", message: "EXECUTOR_RESULT" }; }, close: () => {} }, deliveries,
    { rejected: new Set(["dispatch:one:closing:0"]), outcome: ({ accountId, target, senderAccountId, operationId }) => {
      if (senderAccountId === "cli_sam") destinations.push(`${accountId} ${target}`);
      return operationId === "dispatch:one:receipt:0" ? { ...receipt } : undefined;
    } });
  await dispatch.start();
  dispatch.admit(event("one", "alice", { target: "feishu.group.oc_beta" }));
  await vi.waitFor(() => expect(noticeStates(dispatch).at(-1)).toBe("one:closing:0 rejected"), WAIT);
  const told = recorded === "rejected";
  expect(noticeStates(dispatch)).toEqual([`one:receipt:0 ${recorded}`, ...(told ? ["one:receipt-rejected:0 accepted"] : []), "one:closing:0 rejected"]);
  expect(posts(deliveries)).toEqual([`cli_alice: ${start(1)}`, ...(told ? [`cli_sam: ${NOT_STARTED}`] : []), `cli_alice: ${RECEIPT_FAILED}`]);
  expect(destinations).toEqual(told ? ["cli_sam feishu.group.oc_beta"] : []);
  expect([dispatch.getState().jobs[0]?.status, runs]).toEqual(["failed", 0]);
});

// The stored state decides, not the delivery's answer: a start message that was never submitted answers like one the channel
// refused (agent-dispatch failure modes "Remove member/group or replace a Team Leader's application credentials with queued work").
it("leaves the Coordinator silent when the lead's start message was never submitted because the lead's application was replaced", async () => {
  const roster = structuredClone(agents);
  const leader: TeamLeader = { ...closingLeader(), plan: async () => { roster.find(({ id }) => id === "alice")!.senderAccountId = "cli_alice_new"; return JSON.parse(plan); } };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, done, deliveries, { agents: roster });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(noticeStates(dispatch)).toEqual(["one:receipt:0 cancelled", "one:closing:0 cancelled"]), WAIT);
  expect([dispatch.getState().jobs[0]?.status, deliveries]).toEqual(["failed", []]);
});

it("leaves the Coordinator silent when the requester cancelled the request while the lead's start message was being sent", async () => {
  const sending = deferred<SendTextResult>(), cancelTakenIn = deferred();
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), done, deliveries,
    { outcome: ({ operationId }) => operationId === "dispatch:one:receipt:0" ? sending.promise : undefined, closeChoices: async () => { cancelTakenIn.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(noticeStates(dispatch)).toEqual(["one:receipt:0 sending"]), WAIT);
  // The host is asked to close the request's choices once the cancel of a running request is recorded.
  dispatch.admit(event("two", "cancel:one"));
  await cancelTakenIn.promise;
  sending.resolve({ ok: false, reason: "rejected", acceptedSegments: 0 });
  await vi.waitFor(() => expect(noticeStates(dispatch)).toEqual(["one:receipt:0 rejected", "one:closing:0 accepted"]), WAIT);
  expect(posts(deliveries)).toEqual([`cli_alice: ${start(1)}`, "cli_alice: 已停止继续处理。已经完成的操作不会自动撤销。"]);
  expect(dispatch.getState().jobs[0]?.status).toBe("cancelled");
});

it("tries nothing else when the Coordinator's own sentence is rejected, and sends only the lead's report again when the requester asks for it", async () => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), done, deliveries,
    { rejected: new Set(["dispatch:one:receipt:0", "dispatch:one:receipt-rejected:0", "dispatch:one:closing:0"]) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(noticeStates(dispatch)).toEqual(["one:receipt:0 rejected", "one:receipt-rejected:0 rejected", "one:closing:0 rejected"]), WAIT);
  expect(posts(deliveries)).toEqual([`cli_alice: ${start(1)}`, `cli_sam: ${NOT_STARTED}`, `cli_alice: ${RECEIPT_FAILED}`]);
  dispatch.admit(event("two", "retry_report:one"));
  await vi.waitFor(() => expect(noticeStates(dispatch).at(-1)).toBe("one:closing:0:retry:two accepted"), WAIT);
  expect(posts(deliveries).slice(3)).toEqual([`cli_alice: ${RECEIPT_FAILED}`]);
});

it("does not send the Coordinator's sentence again at the start after a stop cut its send off", async () => {
  const state = directory();
  const hung = deferred<never>();
  const first = dispatchWith(state, closingLeader(), done, [],
    { rejected: new Set(["dispatch:one:receipt:0"]), outcome: ({ operationId }) => operationId === "dispatch:one:receipt-rejected:0" ? hung.promise : undefined });
  open.splice(open.indexOf(first), 1);
  try {
    await first.start();
    first.admit(event("one", "alice"));
    await vi.waitFor(() => expect(noticeStates(first)).toEqual(["one:receipt:0 rejected", "one:receipt-rejected:0 sending"]), WAIT);
    const after: Array<{ sender: string; message: string; id: string }> = [];
    const second = dispatchWith(state, closingLeader(), done, after);
    await second.start();
    await vi.waitFor(() => expect(noticeStates(second)).toEqual(["one:receipt:0 rejected", "one:receipt-rejected:0 unknown", "one:closing:0 accepted"]), WAIT);
    expect(posts(after)).toEqual([`cli_alice: ${RECEIPT_FAILED}`]);
    expect(second.getState().jobs[0]?.status).toBe("failed");
  } finally { hung.reject(new Error("abandoned")); await first.close(); }
});

it("has the Coordinator's sentence posted at the next start when the service stopped as the lead's start message was rejected", async () => {
  const state = directory();
  const before: Array<{ sender: string; message: string; id: string }> = [];
  let stopped: Promise<void> | undefined;
  const first: AgentDispatch = dispatchWith(state, closingLeader(), done, before, { outcome: ({ operationId }) => {
    if (operationId !== "dispatch:one:receipt:0") return undefined;
    open.splice(open.indexOf(first), 1); stopped = first.close();
    return { ok: false, reason: "rejected", acceptedSegments: 0 };
  } });
  await first.start();
  first.admit(event("one", "alice"));
  await vi.waitFor(() => expect(stopped).toBeDefined(), WAIT);
  await stopped;
  expect(posts(before)).toEqual([`cli_alice: ${start(1)}`]);
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, closingLeader(), done, after);
  await second.start();
  await vi.waitFor(() => expect(noticeStates(second)).toEqual(["one:receipt:0 rejected", "one:receipt-rejected:0 accepted", "one:closing:0 accepted"]), WAIT);
  expect(posts(after)).toEqual([`cli_sam: ${NOT_STARTED}`, `cli_alice: ${RECEIPT_FAILED}`]);
});

it("has the Coordinator tell the group again when a retry's start message is rejected too, once for each attempt", async () => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), closingLeader(), done, deliveries,
    { rejected: new Set(["dispatch:one:receipt:0", "dispatch:one:closing:0", "dispatch:one:receipt:1"]) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(noticeStates(dispatch).at(-1)).toBe("one:closing:0 rejected"), WAIT);
  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(noticeStates(dispatch).at(-1)).toBe("one:closing:1 accepted"), WAIT);
  const attempt = [`cli_alice: ${start(1)}`, `cli_sam: ${NOT_STARTED}`, `cli_alice: ${RECEIPT_FAILED}`];
  expect(posts(deliveries)).toEqual([...attempt, ...attempt]);
  expect(noticeStates(dispatch).filter((notice) => notice.includes(":receipt-rejected:"))).toEqual(["one:receipt-rejected:0 accepted", "one:receipt-rejected:1 accepted"]);
});

it("keeps the Coordinator's sentence among the request's posts, and captures it into the group memory with the request's next accepted report", async () => {
  const captures: Capture[] = [];
  const dispatch = dispatchWith(directory(), closingLeader(), done, [], { captures, rejected: new Set(["dispatch:one:receipt:0", "dispatch:one:closing:0"]) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(noticeStates(dispatch).at(-1)).toBe("one:closing:0 rejected"), WAIT);
  expect(dispatch.records()[0]?.posts.map(({ id, agentId, text, state }) => ({ id, agentId, text, state }))).toEqual([
    { id: "one:receipt:0", agentId: "alice", text: start(1), state: "rejected" },
    { id: "one:receipt-rejected:0", agentId: "sam", text: NOT_STARTED, state: "accepted" },
    { id: "one:closing:0", agentId: "alice", text: RECEIPT_FAILED, state: "rejected" }]);
  // Nothing of the failed attempt was captured, because its report was rejected; the retry's accepted closing captures what was accepted since.
  expect(groupCaptures(captures)).toEqual([]);
  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(1), WAIT);
  expect(groupCaptures(captures).map(({ assistantText }) => assistantText)).toEqual([[NOT_STARTED, start(1), "LEADER_CLOSING_1"].join("\n")]);
});

// Dependencies between Assignments (ticket 31: agent-dispatch::REQ-011, REQ-008/AC-01, REQ-007/AC-04, US-003/AC-01).
const titles = ["整理文案", "核对价格", "准备问答", "发布商品"];
/** A plan whose n-th Assignment depends on the positions in `dependsOn[n]`; even positions use the second preset. */
const dependent = (dependsOn: number[][]) => ({ assignments: dependsOn.map((positions, index) => ({ profileId: index % 2 ? "executor-2" : "executor-1", title: titles[index]!,
  brief: `${titles[index]}，按原消息`, dependsOn: positions })), decisions: [] as string[], help: [] as Array<{ title: string; brief: string }> });
type Seen = { run: string; prerequisites: unknown };
const awaiting = "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n执行者 3（能力档 1）处理：准备问答\n完成后会在本群汇报。";

it("bounds each prerequisite result and all of them together, in plan order", () => {
  const result = (length: number) => "结".repeat(length);
  const bounded = boundedPrerequisites([100, 5000, 5000, 5000].map((length, index) => ({ position: index + 1, title: `分工 ${index + 1}`, executor: `执行者 ${index + 1}`, result: result(length) })));
  const mark = "…（结果过长，以下已截断）";
  // 100 + 4,000 + 4,000 leaves 3,900 of the 12,000 for the last one.
  expect(bounded.map(({ result: text }) => text)).toEqual([result(100), result(4000) + mark, result(4000) + mark, result(3900) + mark]);
  expect(bounded.map(({ position, title, executor }) => `${position}:${title}:${executor}`)).toEqual(["1:分工 1:执行者 1", "2:分工 2:执行者 2", "3:分工 3:执行者 3", "4:分工 4:执行者 4"]);
});

it("starts a dependent Assignment only after its prerequisite completes, with that prerequisite's bounded final result and no post of its own", async () => {
  const gate = deferred();
  const seen: Seen[] = [];
  // The prerequisite's result is longer than one prerequisite may pass on.
  const long = `整理文案完成${"长".repeat(4100)}`;
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: assignment.title, prerequisites: structuredClone(prerequisites) });
    if (assignment.title === "整理文案") { await gate.promise; return { status: "completed", message: long }; }
    return { status: "completed", message: `${assignment.title}完成` };
  }, close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1], []]), reports), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["running", "queued", "completed"]), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen.map(({ run }) => run)).toEqual(["整理文案", "准备问答"]);
  gate.resolve();
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(seen).toEqual([{ run: "整理文案", prerequisites: [] }, { run: "准备问答", prerequisites: [] },
    { run: "核对价格", prerequisites: [{ position: 1, title: "整理文案", executor: "执行者 1", result: `整理文案完成${"长".repeat(3994)}…（结果过长，以下已截断）` }] }]);
  expect(messages(deliveries)).toEqual([awaiting, "已收尾。"]);
  expect(reports[0]?.map(({ position, status, dependsOn }) => ({ position, status, dependsOn }))).toEqual([
    { position: 1, status: "completed", dependsOn: [] }, { position: 2, status: "completed", dependsOn: [1] }, { position: 3, status: "completed", dependsOn: [] }]);
});

it("leaves a dependent of a failed Assignment not started, then a retry redoes the failed one before starting it", async () => {
  const failurePosted = deferred();
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}`, prerequisites: structuredClone(prerequisites) });
    if (assignment.title === "整理文案" && assignment.attempt === 0) return { status: "failed", message: "素材缺失" };
    if (assignment.title === "准备问答") await failurePosted.promise;
    return { status: "completed", message: `${assignment.title}完成${assignment.attempt}` };
  }, close: () => {} };
  const reports: Reports[] = [];
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1], []]), reports), executor, deliveries,
    { delivered: (message) => { if (message.includes("未能完成")) failurePosted.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["failed", "blocked", "completed"]);
  expect(seen.map(({ run }) => run)).toEqual(["整理文案:0", "准备问答:0"]);
  expect(messages(deliveries)).toEqual([awaiting, "执行者 1（能力档 1）的分工「整理文案」未能完成：执行者报告无法完成。其余分工继续处理。", "已收尾。"]);
  expect(reports[0]?.[1]).toEqual({ position: 2, title: "核对价格", executor: "执行者 2", status: "blocked", result: "未开始：它等待的第 1 项未能完成。", dependsOn: [1] });

  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // The dependent receives the retry's result, so it started only after the redone prerequisite completed.
  expect(seen.slice(2)).toEqual([{ run: "整理文案:1", prerequisites: [] },
    { run: "核对价格:1", prerequisites: [{ position: 1, title: "整理文案", executor: "执行者 1", result: "整理文案完成1" }] }]);
  expect(messages(deliveries).slice(3)).toEqual(["我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n完成后会在本群汇报。", "已收尾。"]);
});

it("names every Assignment a failure left not started, and the retry order, when the Team Leader's closing turn fails", async () => {
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const executor: DispatchExecutor = { run: async () => ({ status: "failed", message: "素材缺失" }), close: () => {} };
  const leader: TeamLeader = { plan: async () => dependent([[], [1], [2]]), supplement: affectFirst, close: async () => { throw new Error("leader_closing_invalid"); } };
  const dispatch = dispatchWith(directory(), leader, executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  // The failure left nothing else unfinished, so it gets no post of its own.
  expect(messages(deliveries)).toEqual([
    "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n执行者 3（能力档 1）处理：准备问答（等 2 完成后开始）\n完成后会在本群汇报。",
    "执行者 1「整理文案」未能完成。素材缺失\n执行者 2「核对价格」未开始：它等待的第 1 项未能完成。\n执行者 3「准备问答」未开始：它等待的第 2 项未能完成。\n" +
      "需要时请明确要求重试，会先重做第 1 项，再开始第 2、3 项。"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["failed", "blocked", "blocked"]);
});

it("leaves the dependent of an Assignment interrupted by a restart not started", async () => {
  const state = directory();
  const hung = deferred<never>();
  const first = dispatchWith(state, dividingLeader(dependent([[], [1], []])), { run: () => hung.promise, close: () => {} }, []);
  await first.start();
  first.admit(event("one", "alice"));
  // The first instance stops while both independent Executors run, and never writes again, as a crash leaves it.
  await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["running", "queued", "running"]), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1);

  const runs: string[] = [];
  const reports: Reports[] = [];
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, dividingLeader(dependent([[], [1], []]), reports), { run: async (_job, assignment) => { runs.push(assignment.title); return { status: "completed", message: "" }; },
    close: () => {} }, after);
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  expect(messages(after)).toEqual(["服务中断，执行者 1（能力档 1）的分工「整理文案」已中断，无法确认已完成的内容，不会自动重放。",
    "服务中断，执行者 3（能力档 1）的分工「准备问答」已中断，无法确认已完成的内容，不会自动重放。", "已收尾。"]);
  expect(reports[0]?.map(({ status, result }) => `${status}:${result}`)).toEqual(["interrupted:服务中断，本次处理已停止。", "blocked:未开始：它等待的第 1 项未能完成。",
    "interrupted:服务中断，本次处理已停止。"]);
  expect(runs).toEqual([]);
  hung.reject(new Error("abandoned")); await first.close();
});

it.each([
  ["completed", ["completed", "completed"], "completed"],
  ["cancelled", ["cancelled", "blocked"], "failed"],
] as const)("starts or leaves not started the dependent of an Assignment whose choice the requester %s", async (answer, statuses, outcome) => {
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: assignment.title, prerequisites: structuredClone(prerequisites) });
    return assignment.title === "整理文案" ? { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" } : { status: "completed", message: "价格已核对。" };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1]])), executor, deliveries, { pending: choosing(answer) });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["waiting", "queued"]);
  expect(messages(deliveries)).toEqual(["我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n完成后会在本群汇报。", "请选择要发送的文件。"]);
  dispatch.admit(event("two", "choose:1"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe(outcome), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(statuses);
  expect(seen.slice(1)).toEqual(answer === "completed"
    ? [{ run: "核对价格", prerequisites: [{ position: 1, title: "整理文案", executor: "执行者 1", result: "已发送所选文件。" }] }] : []);
  expect(messages(deliveries).at(-1)).toBe("已收尾。");
});

it("reruns a supplement's affected Assignment, then its dependents and the new ones that wait for it, with its new result", async () => {
  const gate = deferred();
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}:${(assignment.input ?? job.executionEvent ?? job.event).text}`, prerequisites: structuredClone(prerequisites) });
    if (assignment.title === "整理文案" && assignment.attempt === 0) await gate.promise;
    return { status: "completed", message: `${assignment.title}完成${assignment.attempt}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1], []]), [], async () => ({ affected: [1],
    assignments: [{ profileId: "executor-2", title: "发布商品", brief: "发布到闲鱼", dependsOn: [1] }], decisions: [], parts: [], help: [] })), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.attempt).toBe(1), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  const fresh = [{ position: 1, title: "整理文案", executor: "执行者 1", result: "整理文案完成1" }];
  expect(seen.slice(3)).toEqual([{ run: "整理文案:1:supplement:one", prerequisites: [] }, { run: "核对价格:1:supplement:one", prerequisites: fresh },
    { run: "发布商品:1:supplement:one", prerequisites: fresh }]);
  expect(messages(deliveries).slice(2)).toEqual([
    "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n执行者 4（能力档 2）处理：发布商品（等 1 完成后开始）\n完成后会在本群汇报。", "已收尾。"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ title, attempt }) => `${title}:${attempt}`)).toEqual(["整理文案:1", "核对价格:1", "准备问答:0", "发布商品:1"]);
});

it("reruns a dependent that failed when a supplement reruns its prerequisite, and keeps a superseded dependent cancelled", async () => {
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}:${(assignment.input ?? job.executionEvent ?? job.event).text}`, prerequisites: structuredClone(prerequisites) });
    if (assignment.title === "核对价格") return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" };
    if (assignment.title === "准备问答" && assignment.attempt === 0) return { status: "failed", message: "问答模板缺失" };
    return { status: "completed", message: `${assignment.title}完成${assignment.attempt}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1], [1]])), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "waiting", "failed"]);
  // The supplement supersedes the waiting Assignment; the Team Leader's answer (affectFirst) reruns the first one.
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(seen.slice(3)).toEqual([{ run: "整理文案:1:supplement:one", prerequisites: [] },
    { run: "准备问答:1:supplement:one", prerequisites: [{ position: 1, title: "整理文案", executor: "执行者 1", result: "整理文案完成1" }] }]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status, attempt }) => `${status}:${attempt}`)).toEqual(["completed:1", "cancelled:0", "completed:1"]);
  expect(messages(deliveries).slice(-2)).toEqual(["我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 3（能力档 1）处理：准备问答（等 1 完成后开始）\n完成后会在本群汇报。", "已收尾。"]);
});

it("cancels the running and waiting Assignments of a request and names the one a failure left not started", async () => {
  const executor: DispatchExecutor = { run: (_job, assignment, signal) => assignment.title === "整理文案" ? Promise.resolve({ status: "failed", message: "素材缺失" })
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "cancelled", message: "已取消" }))), close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1], [], [3]])), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["failed", "blocked", "running", "queued"]), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(messages(deliveries)).toHaveLength(2), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "cancel:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("cancelled"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(messages(deliveries)).toEqual([
    "我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n执行者 3（能力档 1）处理：准备问答\n执行者 4（能力档 2）处理：发布商品（等 3 完成后开始）\n完成后会在本群汇报。",
    "执行者 1（能力档 1）的分工「整理文案」未能完成：执行者报告无法完成。其余分工继续处理。",
    "已停止继续处理：\n执行者 1「整理文案」未能完成\n执行者 2「核对价格」未开始\n执行者 3「准备问答」已停止\n执行者 4「发布商品」已停止\n已经完成的操作不会自动撤销。"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["failed", "blocked", "cancelled", "cancelled"]);
});

it("names in a retry's start message only the prerequisites a dependent still waits for", async () => {
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}`, prerequisites: structuredClone(prerequisites) });
    if (assignment.title === "核对价格" && assignment.attempt === 0) return { status: "failed", message: "价格页无法访问" };
    return { status: "completed", message: `${assignment.title}完成${assignment.attempt}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [], [1, 2]])), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "failed", "blocked"]);
  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // Position 1 completed in the first attempt, so the retry's line names only position 2.
  expect(messages(deliveries).at(-2)).toBe("我安排：\n执行者 2（能力档 2）处理：核对价格\n执行者 3（能力档 1）处理：准备问答（等 2 完成后开始）\n完成后会在本群汇报。");
  expect(seen.at(-1)).toEqual({ run: "准备问答:1", prerequisites: [{ position: 1, title: "整理文案", executor: "执行者 1", result: "整理文案完成0" },
    { position: 2, title: "核对价格", executor: "执行者 2", result: "核对价格完成1" }] });
});

it("keeps not started, on a retry, a dependent whose prerequisite's choice the requester cancelled", async () => {
  const runs: string[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment) => {
    runs.push(assignment.title);
    return assignment.title === "整理文案" ? { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" } : { status: "completed", message: "价格已核对。" };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1]])), executor, deliveries, { pending: choosing("cancelled") });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "choose:1"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  const before = deliveries.length;
  dispatch.admit(event("three", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.attempt).toBe(1), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // No start message names an Assignment that cannot start; only the closing follows.
  expect(messages(deliveries).slice(before)).toEqual(["已收尾。"]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["cancelled", "blocked"]);
  expect(runs).toEqual(["整理文案"]);
});

it("reruns a dependent that never started when a supplement reruns its superseded prerequisite", async () => {
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}:${(assignment.input ?? job.executionEvent ?? job.event).text}`, prerequisites: structuredClone(prerequisites) });
    if (assignment.title === "整理文案" && assignment.attempt === 0) return { status: "waiting", message: "请选择要发送的文件。", runRef: "run-1" };
    return { status: "completed", message: `${assignment.title}完成${assignment.attempt}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(dependent([[], [1]])), executor, deliveries);
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("waiting"), { timeout: 2000, interval: 10 });
  // The supplement supersedes the waiting prerequisite, leaving its dependent not started; the answer (affectFirst) reruns the prerequisite.
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  expect(seen).toEqual([{ run: "整理文案:0:alice", prerequisites: [] }, { run: "整理文案:1:supplement:one", prerequisites: [] },
    { run: "核对价格:1:supplement:one", prerequisites: [{ position: 1, title: "整理文案", executor: "执行者 1", result: "整理文案完成1" }] }]);
  expect(messages(deliveries).slice(-2)).toEqual(["我安排：\n执行者 1（能力档 1）处理：整理文案\n执行者 2（能力档 2）处理：核对价格（等 1 完成后开始）\n完成后会在本群汇报。", "已收尾。"]);
});

// Dependencies in cross-team work: every position a Team Leader writes or reads numbers its own team's Assignments, so a
// dependency, the prerequisite results it passes on and the closing stay within one team (agent-dispatch::REQ-011/AC-05, REQ-013).
const billDepending = () => ({ ...billPlan, assignments: [billPlan.assignments[0]!, { ...billPlan.assignments[1]!, dependsOn: [1] }] });
const BILL_AWAITING = "我安排：\n执行者 3（能力档 1）处理：编写脚本\n执行者 4（能力档 2）处理：核对接口（等 1 完成后开始）\n完成后经 Sam 交回 Alice 汇总。";

it("numbers a cross-team Team Leader's dependency among its own Assignments, in its start, its Executor's prerequisites and its closing", async () => {
  const turns = crossTurns();
  turns.bill!.plans = [billDepending()];
  const leader = teamLeaders(turns);
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: assignment.title, prerequisites: structuredClone(prerequisites) });
    return { status: "completed", message: `RESULT_${assignment.title}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), leader, executor, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // Bill's 编写脚本 is his first Assignment and the request's third.
  expect(posts(deliveries).slice(0, 3)).toEqual([`cli_alice: ${LEAD_START}`, `cli_sam: ${ANNOUNCED}`, `cli_bill: ${BILL_AWAITING}`]);
  expect(seen.find(({ run }) => run === "核对接口")?.prerequisites).toEqual([{ position: 1, title: "编写脚本", executor: "执行者 3", result: "RESULT_编写脚本" }]);
  expect(dispatch.getState().jobs[0]?.assignments.map(({ dependsOn }) => dependsOn)).toEqual([[], [], [], ["one:assignment:0:3"]]);
  expect(leaderTurns(leader, "close", "bill")[0]?.assignments).toEqual([expect.objectContaining({ position: 1, title: "编写脚本", dependsOn: [] }),
    expect.objectContaining({ position: 2, title: "核对接口", dependsOn: [1] })]);
});

it("leaves a cross-team dependent of a failed Assignment not started, names it with the retry order in its Team Leader's fallback closing, and a retry redoes both", async () => {
  const turns = crossTurns();
  turns.bill!.plans = [billDepending()];
  // An empty closing message fails the production closing parser, so Bill's closing falls back to his Assignments' own results.
  turns.bill!.closing = { message: "  " };
  const billClosed = deferred();
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}`, prerequisites: structuredClone(prerequisites) });
    // The lead's Executors end only after Bill's closing, so Bill's failure is posted while the request still runs.
    if (assignment.teamId === "alice") await billClosed.promise;
    if (assignment.title === "编写脚本" && assignment.attempt === 0) return { status: "failed", message: "接口文档无法访问" };
    return { status: "completed", message: `${assignment.title}完成${assignment.attempt}` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(turns), executor, deliveries,
    { assign: toBill, delivered: (message) => { if (message.endsWith("结果经 Sam 交回 Alice 汇总。")) billClosed.resolve(); } });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("partially_failed"), { timeout: 2000, interval: 10 });
  expect(dispatch.getState().jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "completed", "failed", "blocked"]);
  // Numbered among Bill's Assignments, not the request's (3 and 4).
  const fallback = "执行者 3「编写脚本」未能完成。接口文档无法访问\n执行者 4「核对接口」未开始：它等待的第 1 项未能完成。\n需要时请明确要求重试，会先重做第 1 项，再开始第 2 项。";
  expect(posts(deliveries).filter((post) => post.startsWith("cli_bill: "))).toEqual([`cli_bill: ${BILL_AWAITING}`,
    "cli_bill: 执行者 3（能力档 1）的分工「编写脚本」未能完成：执行者报告无法完成。其余分工继续处理。", `cli_bill: ${fallback}\n结果经 Sam 交回 Alice 汇总。`]);
  expect(seen.map(({ run }) => run).filter((run) => run === "核对接口:0")).toEqual([]);
  const before = deliveries.length;

  dispatch.admit(event("two", "retry:one"));
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // The retry redoes Bill's failed Assignment first, then starts its dependent with the new result, under Bill.
  expect(seen.filter(({ run }) => run.endsWith(":1"))).toEqual([{ run: "编写脚本:1", prerequisites: [] },
    { run: "核对接口:1", prerequisites: [{ position: 1, title: "编写脚本", executor: "执行者 3", result: "编写脚本完成1" }] }]);
  expect(posts(deliveries).slice(before)).toEqual([`cli_bill: ${BILL_AWAITING}`,
    "cli_bill: 执行者 3「编写脚本」已完成。编写脚本完成1\n执行者 4「核对接口」已完成。核对接口完成1\n结果经 Sam 交回 Alice 汇总。", "cli_alice: ALICE_CLOSING"]);
});

it("numbers a new Assignment's dependency among the lead's own Assignments when the lead's supplement adds it to a cross-team request", async () => {
  const turns = crossTurns();
  // Alice's two Assignments, then the two her answer adds: the second new one waits for the first, at position 3 of hers.
  turns.alice!.supplement = { affected: [], assignments: [{ profileId: "executor-1", title: "准备问答", brief: "准备买家问答", dependsOn: [] },
    { profileId: "executor-2", title: "发布商品", brief: "发布到闲鱼", dependsOn: [3] }], decisions: [], parts: [], help: [] };
  const gate = deferred();
  const seen: Seen[] = [];
  const executor: DispatchExecutor = { run: async (_job, assignment, _signal, prerequisites) => {
    seen.push({ run: `${assignment.title}:${assignment.attempt}`, prerequisites: structuredClone(prerequisites) });
    if (assignment.attempt === 0) await gate.promise;
    return { status: "completed", message: `${assignment.title}完成` };
  }, close: () => {} };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), teamLeaders(turns), executor, deliveries, { assign: toBill });
  await dispatch.start();
  dispatch.admit(event("one", "alice"));
  await vi.waitFor(() => expect(seen).toHaveLength(4), { timeout: 2000, interval: 10 });
  dispatch.admit(event("two", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(seen).toHaveLength(6), { timeout: 2000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.getState().jobs[0]?.status).toBe("completed"), { timeout: 2000, interval: 10 });
  // Numbered over the request, position 3 would be Bill's 编写脚本, and 准备问答 position 5.
  expect(seen.slice(4)).toEqual([{ run: "准备问答:1", prerequisites: [] },
    { run: "发布商品:1", prerequisites: [{ position: 3, title: "准备问答", executor: "执行者 5", result: "准备问答完成" }] }]);
  expect(posts(deliveries)).toContain("cli_alice: 我安排：\n执行者 5（能力档 1）处理：准备问答\n执行者 6（能力档 2）处理：发布商品（等 3 完成后开始）\n完成后会在本群汇报。");
});
