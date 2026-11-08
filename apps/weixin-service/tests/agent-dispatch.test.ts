import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDispatch } from "../src/agent-dispatch.js";
import { CodexDispatchExecutor, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import { CodexTeamLeader, type TeamLeader } from "../src/agent-dispatch-leader.js";
import type { DispatchAgent, DispatchExecutionResult, DispatchExecutor, DispatchPendingResult } from "../src/agent-dispatch-types.js";
import type { DispatchMemoryTurn } from "../src/agent-dispatch.js";
import type { AgentMemoryScope } from "../src/agent-profile.js";
import type { InboundContent } from "../src/channel-contract.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { conversation } from "./support/dispatch-runtime.js";

// The request lifecycle at the AgentDispatch boundary. Durable stores are real; external conversations, deliveries and the
// Coordinator's decisions are substitutes. The nested-wait case runs the production Team Leader wrapper and Executor over a
// real pool, because holding a slot while waiting for another one would span all three.
const agents: DispatchAgent[] = [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
  { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" },
  { id: "bill", name: "Bill", responsibility: "衣食住行", senderAccountId: "cli_bill" }];
const team = (id: string) => {
  const agent = agents.find((candidate) => candidate.id === id);
  return agent && id !== "sam" ? { leader: { id, name: agent.name, teamName: `${agent.name} 团队`, responsibility: agent.responsibility, instructions: "" },
    profiles: [{ id: "executor-1", name: "能力档 1" }], memoryScope: { kind: "leader", teamId: id } as const } : undefined;
};
const event = (key: string, text: string, extra: Partial<InboundContent> = {}): InboundContent => ({ key, accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner",
  conversationType: "group", messageId: `om_${key}`, source: "text", text, receivedAt: 1, ...extra });
const plan = JSON.stringify({ assignments: [{ profileId: "executor-1", title: "处理请求", brief: "按原消息处理" }] });
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
    pending?: (event: InboundContent) => Promise<DispatchPendingResult> } = {}) {
  const roster = options.roster ?? accepting;
  const dispatch = new AgentDispatch(join(path, "agent-dispatch.sqlite"), {
    agents, leader, executor, definitionsVersion: () => 1, team: (id) => team(id), revision: () => "r1",
    roster: () => roster.map((id) => ({ id, name: team(id)!.leader.teamName, responsibility: team(id)!.leader.responsibility })),
    classifier: { classify: async ({ event: inbound }) => {
      const [kind, argument] = inbound.text.split(":");
      classified.push(argument === undefined ? "dispatch" : kind!);
      if (argument === undefined) return { kind: "dispatch", agentId: inbound.text, requestId: null, summary: `${inbound.text} 的请求`, message: "" };
      if (kind === "propose") return { kind: "propose", agentId: argument, requestId: null, summary: "整理商品文案", message: "" };
      return { kind: kind as "cancel", agentId: null, requestId: argument, summary: "", message: "" };
    } },
    delivery: async ({ senderAccountId, message, operationId }) => {
      deliveries.push({ sender: senderAccountId, message, id: operationId });
      if (options.rejected?.delete(operationId)) return { ok: false, reason: "rejected", acceptedSegments: 0 };
      return { ok: true, acceptedSegments: 1 };
    },
    memoryScope: { kind: "group" }, memory: { recall: () => "", capture: async (scope, turn) => {
      if (scope.kind === options.failingCapture) throw new Error("memory_state_write_failed");
      options.captures?.push({ scope, ...turn });
    } },
    ...(options.pending ? { pending: options.pending } : {}),
    authorized: () => true, bindingHash: () => "binding-alpha", completedWork: () => "",
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
    agents, runtimes, tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
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
  const second = dispatchWith(state, { plan: async () => JSON.parse(plan), close: async () => "已收尾。" }, executor("second"), after);
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
  const first = dispatchWith(state, { plan: () => hung.promise, close: () => hung.promise }, executor("first"), []);
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
  const second = dispatchWith(state, { plan: async () => JSON.parse(plan), close: async () => "已收尾。" }, executor("second"), after);
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
  const first = dispatchWith(state, { plan: () => { plans.push("first"); return hung.promise; }, close: () => hung.promise }, executor, []);
  await first.start();
  first.admit(event("one", "alice"));
  // The first instance stops inside the plan turn, as a crash leaves it; the owner then changes Alice's binding in this group.
  await vi.waitFor(() => expect(plans).toEqual(["first"]), { timeout: 2000, interval: 10 });
  open.splice(open.indexOf(first), 1);

  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, { plan: async () => { plans.push("second"); return JSON.parse(plan); }, close: async () => "已收尾。" }, executor, after, { roster: ["bill"] });
  await second.start();
  await vi.waitFor(() => expect(second.getState().jobs[0]?.status).toBe("failed"), { timeout: 2000, interval: 10 });
  expect(plans).toEqual(["first"]);
  expect(second.getState().jobs[0]?.assignments).toEqual([]);
  expect(after.map(({ sender, message }) => ({ sender, message }))).toEqual([
    { sender: "cli_alice", message: "负责团队当前不可用，本次未能继续处理。已完成的操作不会自动重复，请补充信息后明确让我重试。" }]);
  hung.reject(new Error("abandoned")); await first.close();
});

// The capture of finished requests into the group memory (agent-dispatch::REQ-012/AC-01, AC-04).
const start = (executor: number) => `我安排执行者 ${executor}（能力档 1）处理：处理请求。完成后会在本群汇报。`;
/** A Team Leader whose n-th closing is `LEADER_CLOSING_<n>`. */
function closingLeader(): TeamLeader {
  let closings = 0;
  return { plan: async () => JSON.parse(plan), close: async () => `LEADER_CLOSING_${++closings}` };
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
  // A supplement while the first attempt runs starts a second attempt once the first completes.
  dispatch.admit(event("three", "supplement:one"));
  await vi.waitFor(() => expect(classified).toContain("supplement"), { timeout: 2000, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await vi.waitFor(() => expect(groupCaptures(captures)).toHaveLength(2), { timeout: 2000, interval: 10 });
  expect(groupCaptures(captures)).toEqual([
    { senderAccountId: "cli_alice", userId: "one:user:0", userText: "propose:alice\n确认与要求：confirm:one",
      assistantText: ["要不要请 Alice 帮你整理商品文案？请回复这条建议确认，或告诉我暂时不用。", start(1), "LEADER_CLOSING_1"].join("\n") },
    // An attempt started by a supplement still carries the request's message (agent-dispatch::REQ-012/AC-01).
    { senderAccountId: "cli_alice", userId: "one:user:1", userText: "propose:alice\n补充要求：supplement:one", assistantText: [start(2), "LEADER_CLOSING_2"].join("\n") },
  ]);
  expect(JSON.stringify(groupCaptures(captures))).not.toContain("EXECUTOR_RESULT");
  // The Team Leader keeps its Brief, with the latest requirement when it differs, its division and its closing.
  expect(captures.filter(({ scope }) => scope.kind === "leader").map(({ scope, userText, assistantText }) => ({ scope, userText, assistantText }))).toEqual([
    { scope: { kind: "leader", teamId: "alice" }, userText: "请求：propose:alice\n最新要求：propose:alice\n确认与要求：confirm:one\n协调摘要：整理商品文案",
      assistantText: "分工：执行者 1（能力档 1）处理请求\n收尾：LEADER_CLOSING_1" },
    { scope: { kind: "leader", teamId: "alice" }, userText: "请求：propose:alice\n最新要求：supplement:one\n协调摘要：整理商品文案",
      assistantText: "分工：执行者 2（能力档 1）处理请求\n收尾：LEADER_CLOSING_2" },
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

it("starts and sends a report left queued at shutdown even when its group capture fails", async () => {
  const state = directory();
  // The Executor's connection drops at shutdown, so the attempt fails and its report is one the group memory captures.
  const first = dispatchWith(state, closingLeader(), { run: (_job, _assignment, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("executor_connection_closed")));
  }), close: () => {} }, []);
  await first.start();
  first.admit(event("one", "alice"));
  await vi.waitFor(() => expect(first.getState().jobs[0]?.assignments[0]?.status).toBe("running"), { timeout: 2000, interval: 10 });
  // Closing while the Executor runs records the interruption report but leaves it queued for the next start.
  open.splice(open.indexOf(first), 1); await first.close();
  const after: Array<{ sender: string; message: string; id: string }> = [];
  const second = dispatchWith(state, closingLeader(), { run: async () => ({ status: "completed", message: "EXECUTOR_RESULT" }), close: () => {} }, after,
    { failingCapture: "group" });
  await expect(second.start()).resolves.toBeUndefined();
  expect(after.map(({ sender, message }) => ({ sender, message }))).toEqual([
    { sender: "cli_alice", message: "服务中断，本次处理已停止。已完成的操作不会自动重复，请补充信息后明确让我重试。" }]);
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
