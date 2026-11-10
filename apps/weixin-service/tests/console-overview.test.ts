import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDispatch } from "../src/agent-dispatch.js";
import type { CrossTeamDecision, DispatchAgent, DispatchAssignment, DispatchExecutionResult, DispatchExecutor } from "../src/agent-dispatch-types.js";
import type { InboundContent } from "../src/channel-contract.js";
import { ConsoleOverview, type OverviewView } from "../src/console-overview.js";
import { FixtureTeamLeader } from "../src/fixture-team-leader.js";
import type { TeamDefinitions } from "../src/team-registry.js";

// The console's read projection (agent-console Implementation Decisions: read projections) at its public interface, over durable
// records that a real AgentDispatch wrote: the Team Leaders are the production fixture class and the Executors are scripted by
// Assignment title, so every record is one the dispatch lifecycle reaches.
const agents: DispatchAgent[] = [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
  { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }, { id: "bill", name: "Bill", responsibility: "衣食住行", senderAccountId: "cli_bill" }];
const profile = (id: string, name: string, noun: string) => ({ id, name, noun, instructions: "", hostTools: [] });
const definitions: TeamDefinitions = {
  coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调、澄清和分派任务", appId: "cli_sam", profile: { instructions: "", hostTools: [] } },
  dispatchGroups: ["oc_alpha", "oc_beta"],
  teams: [
    { id: "alice", teamName: "运营团队", responsibility: "商品运营", leader: { name: "Alice", appId: "cli_alice", profile: { instructions: "", hostTools: [] } },
      executorProfiles: [profile("executor-1", "商品文案", "文案执行者"), profile("executor-2", "经营分析", "分析执行者")],
      bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }] },
    { id: "bill", teamName: "生活团队", responsibility: "衣食住行", leader: { name: "Bill", appId: "cli_bill", profile: { instructions: "", hostTools: [] } },
      executorProfiles: [profile("executor-1", "行程规划", "行程执行者")], bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "removed" }] },
  ],
};
const teamView = (id: string) => {
  const team = definitions.teams.find((candidate) => candidate.id === id);
  return team ? { leader: { id, name: team.leader.name, teamName: team.teamName, responsibility: team.responsibility, instructions: "" },
    profiles: team.executorProfiles.map(({ id: profileId, name, noun }) => ({ id: profileId, name, noun: noun ?? "执行者" })), memoryScope: { kind: "leader", teamId: id } as const } : undefined;
};
const event = (key: string, chatId: string, extra: Partial<InboundContent> = {}): InboundContent => ({ key, accountId: "cli_sam", target: `feishu.group.${chatId}`,
  senderId: "ou_owner", conversationType: "group", messageId: `om_${key}`, source: "text", text: `${key} 的原始消息`, receivedAt: 1_700_000_000_000, ...extra });
const one = (title: string, profileId = "executor-1") => ({ profileId, title, brief: `${title}的交办`, dependsOn: [] as number[] });

const directories: string[] = [];
const open: AgentDispatch[] = [];
afterEach(async () => {
  for (const dispatch of open.splice(0)) await dispatch.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const created = mkdtempSync(join(tmpdir(), "console-overview-")); directories.push(created); return created; }

/**
 * A dispatch whose Team Leaders plan from `plans` by message and team, close with `<TEAM>_CLOSING`, and whose Coordinator places
 * parts with `placements`. Each request is dispatched to the team its message key starts with. Deliveries listed in `rejected`
 * are refused by the platform.
 */
function dispatchOn(path: string, executor: DispatchExecutor, options: { plans?: Record<string, unknown>; placements?: CrossTeamDecision[]; rejected?: Set<string> } = {}) {
  const leader = new FixtureTeamLeader({ leaderPlan: (messageId, teamId) => structuredClone(options.plans?.[`${messageId}:${teamId}`]), leaderSupplement: () => undefined,
    leaderClosing: (_messageId, teamId) => ({ message: `${teamId.toUpperCase()}_CLOSING` }) });
  const dispatch = new AgentDispatch(join(path, "agent-dispatch.sqlite"), {
    agents: () => agents, leader, executor, definitionsVersion: () => 1, revision: () => "r1", team: (id) => teamView(id),
    roster: () => ["alice", "bill"].map((id) => ({ id, name: teamView(id)!.leader.teamName, responsibility: teamView(id)!.leader.responsibility })),
    classifier: { classify: async ({ event: inbound }) => ({ kind: "dispatch", agentId: inbound.key.split("-")[0]!, requestId: null, summary: `${inbound.key} 的摘要`, message: "" }),
      assign: async () => options.placements ?? [] },
    delivery: async ({ operationId }) => options.rejected?.has(operationId) ? { ok: false, reason: "rejected", acceptedSegments: 0 } : { ok: true, acceptedSegments: 1 },
    memoryScope: { kind: "group" }, memory: { recall: () => "", capture: async () => {} },
    authorized: () => true, bindingHash: () => "binding", completedWork: () => "", presentation: () => undefined, presented: () => {}, report: () => {},
  });
  open.push(dispatch);
  return dispatch;
}
function overview(dispatch: AgentDispatch | undefined, penny: () => Readonly<{ configured: boolean; ready: boolean }> = () => ({ configured: false, ready: false })) {
  return new ConsoleOverview({ ...(dispatch ? { records: () => dispatch.records(), teams: { current: () => ({ definitions }), version: () => ({ definitions }) } } : {}),
    groups: () => ["oc_alpha", "oc_beta"], names: async () => ({ oc_alpha: "银河护卫队" }),
    chatIdOf: (_accountId, target) => target.startsWith("feishu.group.") ? target.slice("feishu.group.".length) : undefined, owner: (senderId) => senderId === "ou_owner", penny });
}
/** An Executor that answers by Assignment title: `completed` unless `outcomes` names the title; `hold` never answers until aborted. */
function scripted(outcomes: Record<string, DispatchExecutionResult["status"] | "hold"> = {}): DispatchExecutor {
  return { run: async (_job, assignment: DispatchAssignment, signal) => {
    const outcome = outcomes[assignment.title] ?? "completed";
    if (outcome === "hold") return await new Promise<DispatchExecutionResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return { status: outcome, message: `${assignment.title}：${outcome === "completed" ? "已交付" : outcome === "waiting" ? "请选择方案" : "价格页打不开"}` };
  }, close: () => {} };
}
const request = (view: OverviewView, id: string) => view.requests.find((candidate) => candidate.id === id)!;

it("shows a partially failed request with its Executors, the part another team took, the part no team took, its posts and its report's delivery", async () => {
  const dispatch = dispatchOn(directory(), scripted({ 核对价格: "failed" }), {
    plans: { "om_alice-1:alice": { assignments: [one("整理文案"), one("核对价格", "executor-2")], decisions: [], help: [{ title: "自动上架脚本", brief: "只交付代码" }, { title: "拍摄商品照片", brief: "白底三张" }] },
      "om_alice-1:bill": { assignments: [one("编写脚本")], decisions: [], help: [] } },
    placements: [{ part: 1, agentId: "bill", summary: "编写自动上架脚本" }, { part: 2, agentId: null, summary: "" }],
    rejected: new Set(["dispatch:alice-1:closing:0"]) });
  await dispatch.start();
  dispatch.admit(event("alice-1", "oc_alpha", { text: "商品 D 上架：写文案、核对价格，再做个脚本，顺便拍照片" }));
  await vi.waitFor(() => expect(dispatch.records()[0]?.posts.at(-1)?.state).toBe("rejected"), { timeout: 5000, interval: 10 });

  const record = request(await overview(dispatch).view(), "alice-1");
  expect(record).toMatchObject({ chatId: "oc_alpha", title: "alice-1 的摘要", lead: "alice", requester: "owner", status: "partially_failed",
    message: { text: "商品 D 上架：写文案、核对价格，再做个脚本，顺便拍照片", source: "text", attachments: [] } });
  // The outcome and the report's delivery are separate (agent-console::US-004/AC-05): a partial failure whose closing the platform refused.
  expect(record.delivery).toBe("rejected");
  expect(record.assignments.map(({ teamId, executor, profile: name, title, brief, status, crossTeam }) => [teamId, executor, name, title, brief, status, crossTeam])).toEqual([
    ["alice", "文案执行者 1", "商品文案", "整理文案", "整理文案的交办", "completed", false],
    ["alice", "分析执行者 2", "经营分析", "核对价格", "核对价格的交办", "failed", false],
    ["bill", "行程执行者 3", "行程规划", "编写脚本", "编写脚本的交办", "completed", true]]);
  expect(record.assignments.find(({ title }) => title === "整理文案")?.result).toContain("已交付");
  expect(record.parts).toEqual([{ title: "自动上架脚本", teamId: "bill" }, { title: "拍摄商品照片", teamId: null }]);
  expect(record.posts.map(({ agentId, kind, state }) => `${agentId}:${kind}:${state}`)).toEqual(["alice:receipt:accepted", "sam:cross_team:accepted",
    "bill:receipt:accepted", "alice:failure:accepted", "bill:closing:accepted", "alice:closing:rejected"]);
  // The lead's closing names the part no team took (agent-dispatch::REQ-013/AC-02).
  expect(record.posts.at(-1)).toMatchObject({ text: "ALICE_CLOSING\n拍摄商品照片没有团队承接，本次未处理；有团队可以承接后，可以明确要求重试。", acceptedAt: null });
  expect(record.posts[0]!.acceptedAt).toEqual(expect.any(Number));
});

it("counts each team's requests in a group once, as running, waiting or history, and keeps groups apart", async () => {
  const dispatch = dispatchOn(directory(), scripted({ 写长文案: "hold", 拍主图: "hold", 选方案: "waiting", 订行程: "hold" }), {
    plans: { "om_alice-run:alice": { assignments: [one("写长文案"), one("拍主图")], decisions: [], help: [{ title: "行程", brief: "订周末行程" }] },
      "om_alice-run:bill": { assignments: [one("订行程")], decisions: [], help: [] },
      "om_alice-wait:alice": { assignments: [one("选方案")], decisions: [], help: [] } },
    placements: [{ part: 1, agentId: "bill", summary: "订周末行程" }] });
  await dispatch.start();
  // A team takes one request at a time in a group, so the held request comes last.
  for (const [key, chatId] of [["alice-done", "oc_alpha"], ["bill-done", "oc_alpha"], ["alice-beta", "oc_beta"], ["alice-gamma", "oc_gamma"], ["alice-wait", "oc_alpha"]] as const) {
    dispatch.admit(event(key, chatId));
    await vi.waitFor(() => expect(dispatch.records().find(({ job }) => job.id === key)?.job.status).toMatch(/^(completed|waiting)$/), { timeout: 3000, interval: 10 });
  }
  dispatch.admit(event("alice-run", "oc_alpha"));
  await vi.waitFor(() => {
    const statuses = Object.fromEntries(dispatch.records().map(({ job, assignments }) => [job.id, assignments.map(({ status }) => status).join(",")]));
    expect(statuses).toEqual({ "alice-run": "running,running,running", "alice-wait": "waiting", "alice-done": "completed", "bill-done": "completed",
      "alice-beta": "completed", "alice-gamma": "completed" });
  }, { timeout: 3000, interval: 10 });

  const view = await overview(dispatch).view();
  // A request outside the dispatch groups has no place in the overview.
  expect(view.requests.map(({ id }) => id).sort()).toEqual(["alice-beta", "alice-done", "alice-run", "alice-wait", "bill-done"]);
  expect(view.groups).toEqual([{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "oc_beta" }]);
  // Two running Assignments of Alice in one request count once; Bill's cross-team Assignment counts the request for Bill too.
  expect(Object.fromEntries(view.teams.map(({ id, groups, counts }) => [id, { groups, counts }]))).toEqual({
    alice: { groups: ["oc_alpha", "oc_beta"], counts: { oc_alpha: { running: 1, waiting: 1, history: 1 }, oc_beta: { running: 0, waiting: 0, history: 1 } } },
    bill: { groups: ["oc_alpha"], counts: { oc_alpha: { running: 1, waiting: 0, history: 1 } } } });
  expect(view.agents).toEqual({ sam: { name: "Sam", teamName: "总协调" }, alice: { name: "Alice", teamName: "运营团队" }, bill: { name: "Bill", teamName: "生活团队" } });
});

it("shows an Assignment interrupted by a restart, and its post", async () => {
  const path = directory();
  const first = dispatchOn(path, scripted({ 整理文案: "hold" }), { plans: { "om_alice-1:alice": { assignments: [one("整理文案")], decisions: [], help: [] } } });
  await first.start();
  first.admit(event("alice-1", "oc_alpha"));
  await vi.waitFor(() => expect(first.records()[0]?.assignments[0]?.status).toBe("running"), { timeout: 5000, interval: 10 });
  await first.close();
  const second = dispatchOn(path, scripted());
  await second.start();
  await vi.waitFor(() => expect(second.records()[0]?.job.status).toBe("failed"), { timeout: 5000, interval: 10 });

  const record = request(await overview(second).view(), "alice-1");
  expect(record.assignments.map(({ status }) => status)).toEqual(["interrupted"]);
  expect(record.posts.map(({ kind }) => kind)).toEqual(["receipt", "interrupted", "closing"]);
});

it("carries only Penny's configured and ready states, whatever else its source holds, and no tree without dispatch", async () => {
  const leaky = () => ({ configured: true, ready: true, amount: 128.5, transactions: 7, note: "午饭 32 元" });
  const view = await overview(undefined, leaky).view();
  expect(view).toEqual({ dispatch: false, groups: [{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "oc_beta" }], agents: {}, coordinator: null,
    teams: [], requests: [], penny: { configured: true, ready: true } });
});
