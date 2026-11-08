import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDispatch, failureCause, requestOutcome, type AssignmentFailure } from "../src/agent-dispatch.js";
import { CodexDispatchExecutor, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import { CodexTeamLeader, type TeamLeader } from "../src/agent-dispatch-leader.js";
import type { DispatchAgent, DispatchAssignment, DispatchExecutionResult, DispatchExecutor, DispatchPendingResult } from "../src/agent-dispatch-types.js";
import type { DispatchMemoryTurn } from "../src/agent-dispatch.js";
import type { AgentMemoryScope } from "../src/agent-profile.js";
import type { InboundContent } from "../src/channel-contract.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { conversation } from "./support/dispatch-runtime.js";

// The request lifecycle at the AgentDispatch boundary. Durable stores are real; external conversations, deliveries and the
// Coordinator's decisions are substitutes. The nested-wait case runs the production Team Leader wrapper and Executor over a
// real pool, because holding a slot while waiting for another one would span all three.
// Gap: each group post that reports a state change (a pending choice, a failure, a choice's cancel reply) is queued in the
// same transaction as that change. No case shows it: nothing awaits between the two writes, so only a process kill could fall
// between them, and a test can stop an instance only at an await; failing the post's insert instead would need a storage seam
// the product does not have. Code review covers it (ticket 07, R-1).
const agents: DispatchAgent[] = [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
  { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" },
  { id: "bill", name: "Bill", responsibility: "衣食住行", senderAccountId: "cli_bill" }];
const team = (id: string) => {
  const agent = agents.find((candidate) => candidate.id === id);
  return agent && id !== "sam" ? { leader: { id, name: agent.name, teamName: `${agent.name} 团队`, responsibility: agent.responsibility, instructions: "" },
    profiles: [{ id: "executor-1", name: "能力档 1" }, { id: "executor-2", name: "能力档 2" }], memoryScope: { kind: "leader", teamId: id } as const } : undefined;
};
const event = (key: string, text: string, extra: Partial<InboundContent> = {}): InboundContent => ({ key, accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner",
  conversationType: "group", messageId: `om_${key}`, source: "text", text, receivedAt: 1, ...extra });
const plan = JSON.stringify({ assignments: [{ profileId: "executor-1", title: "处理请求", brief: "按原消息处理" }], decisions: [] });
/** A supplement answer affecting the request's first Assignment. */
const affectFirst = async () => ({ affected: [1], assignments: [], decisions: [] });
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
 * request for the team it names. `rejected` lists delivery operations refused once; `failingCapture` names a memory scope
 * kind whose captures reject; `pending` stands in for the workflow's pending-choice handling.
 */
function dispatchWith(path: string, leader: TeamLeader, executor: DispatchExecutor, deliveries: Array<{ sender: string; message: string; id: string }>,
  options: { roster?: readonly string[]; captures?: Capture[]; rejected?: Set<string>; failingCapture?: AgentMemoryScope["kind"];
    pending?: (event: InboundContent) => Promise<DispatchPendingResult>; profile?: { name: string; noun?: string }; completedWork?: string;
    delivered?: (message: string) => void } = {}) {
  const roster = options.roster ?? accepting;
  const dispatch = new AgentDispatch(join(path, "agent-dispatch.sqlite"), {
    agents: () => agents, leader, executor, definitionsVersion: () => 1, revision: () => "r1",
    team: (id) => { const view = team(id); return view && options.profile ? { ...view, profiles: [{ id: "executor-1", ...options.profile }] } : view; },
    roster: () => roster.map((id) => ({ id, name: team(id)!.leader.teamName, responsibility: team(id)!.leader.responsibility })),
    classifier: { classify: async ({ event: inbound }) => {
      const [kind, argument] = inbound.text.split(":");
      classified.push(argument === undefined ? "dispatch" : kind!);
      if (argument === undefined) return { kind: "dispatch", agentId: inbound.text, requestId: null, summary: `${inbound.text} 的请求`, message: "" };
      if (kind === "propose") return { kind: "propose", agentId: argument, requestId: null, summary: "整理商品文案", message: "" };
      return { kind: kind as "cancel", agentId: null, requestId: argument, summary: "", message: "" };
    } },
    delivery: async ({ senderAccountId, message, operationId }) => {
      deliveries.push({ sender: senderAccountId, message, id: operationId }); options.delivered?.(message);
      if (options.rejected?.delete(operationId)) return { ok: false, reason: "rejected", acceptedSegments: 0 };
      return { ok: true, acceptedSegments: 1 };
    },
    memoryScope: { kind: "group" }, memory: { recall: () => "", capture: async (scope, turn) => {
      if (scope.kind === options.failingCapture) throw new Error("memory_state_write_failed");
      options.captures?.push({ scope, ...turn });
    } },
    ...(options.pending ? { pending: options.pending } : {}),
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
const three = { assignments: [{ profileId: "executor-1", title: "整理文案", brief: "按原消息整理文案" }, { profileId: "executor-2", title: "核对价格", brief: "核对竞品价格" },
  { profileId: "executor-1", title: "准备问答", brief: "准备买家问答" }], decisions: [] as string[] };
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

it.each([
  [["completed", "completed", "completed"], "completed"],
  [["completed", "failed", "interrupted"], "partially_failed"],
  [["failed", "interrupted"], "failed"],
  [["completed", "cancelled"], "completed"],
  [["cancelled"], "cancelled"],
] satisfies Array<[DispatchAssignment["status"][], string]>)("settles a request whose Assignments ended %j as %s", (statuses, outcome) => {
  expect(requestOutcome(statuses)).toBe(outcome);
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
  expect(reports).toEqual([[{ title: "整理文案", executor: "执行者 1", status: "completed", result: "整理文案完成" },
    { title: "核对价格", executor: "执行者 2", status: "completed", result: "核对价格完成" }, { title: "准备问答", executor: "执行者 3", status: "completed", result: "准备问答完成" }]]);
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
  const two = { assignments: three.assignments.slice(0, 2), decisions: [] };
  const deliveries: Array<{ sender: string; message: string; id: string }> = [];
  const dispatch = dispatchWith(directory(), dividingLeader(two, reports, async (_input, assignments, supplement) => {
    answers.push({ assignments: structuredClone(assignments), supplement }); return { affected: [2], assignments: [], decisions: ["只重新核对价格"] };
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
    { position: 1, executor: "执行者 1", profileName: "能力档 1", title: "整理文案", status: "completed" },
    { position: 2, executor: "执行者 2", profileName: "能力档 2", title: "核对价格", status: "completed" }] }]);
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
  return async (inbound: InboundContent): Promise<DispatchPendingResult> => inbound.text === "choose:1"
    ? { handled: true, senderAccountId: "cli_alice", runRef: "run-1", result: { status: answer, message: answer === "cancelled" ? "已取消这次选择。" : "已发送所选文件。" } }
    : { handled: false };
}
const two = { assignments: three.assignments.slice(0, 2), decisions: [] as string[] };
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
