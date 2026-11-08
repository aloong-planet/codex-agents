import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDispatch } from "../src/agent-dispatch.js";
import { CodexDispatchExecutor, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import { CodexTeamLeader, type TeamLeader } from "../src/agent-dispatch-leader.js";
import type { DispatchAgent, DispatchExecutor } from "../src/agent-dispatch-types.js";
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
    profiles: [{ id: "executor-1", name: "能力档 1" }] } : undefined;
};
const event = (key: string, text: string): InboundContent => ({ key, accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner",
  conversationType: "group", messageId: `om_${key}`, source: "text", text, receivedAt: 1 });
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
function dispatchWith(path: string, leader: TeamLeader, executor: DispatchExecutor, deliveries: Array<{ sender: string; message: string; id: string }>) {
  const dispatch = new AgentDispatch(join(path, "agent-dispatch.sqlite"), {
    agents, leader, executor, definitionsVersion: () => 1, team: (id) => team(id), revision: () => "r1",
    classifier: { classify: async ({ event: inbound }) => {
      const cancel = inbound.text.startsWith("cancel:");
      classified.push(cancel ? "cancel" : "dispatch");
      return cancel ? { kind: "cancel", agentId: null, requestId: inbound.text.slice("cancel:".length), summary: "", message: "" }
        : { kind: "dispatch", agentId: inbound.text, requestId: null, summary: `${inbound.text} 的请求`, message: "" };
    } },
    delivery: async ({ senderAccountId, message, operationId }) => { deliveries.push({ sender: senderAccountId, message, id: operationId }); return { ok: true, acceptedSegments: 1 }; },
    authorized: () => true, bindingHash: () => "binding-alpha", memory: () => "", completedWork: () => "",
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
    profile: () => ({ instructions: "", memoryScope: "group", tools: { definitions: () => [], contractHash: () => "contract-1",
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
