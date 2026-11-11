import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentDispatch } from "../src/agent-dispatch.js";
import type { AccountMemoryEntry, AccountMemoryEvent } from "../src/account-memory-store.js";
import { ConsoleOverview, displayId, type OverviewView } from "../src/console-overview.js";
import { closeDispatches, definitions, dispatchOn, event, one, scripted } from "./support/dispatch-records.js";

// The console's read projection (agent-console Implementation Decisions: read projections) at its public interface, over durable
// records that a real AgentDispatch wrote (support/dispatch-records.ts).
const directories: string[] = [];
afterEach(async () => {
  await closeDispatches();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const created = mkdtempSync(join(tmpdir(), "console-overview-")); directories.push(created); return created; }

function overview(dispatch: AgentDispatch | undefined, penny: () => Readonly<{ configured: boolean; ready: boolean }> = () => ({ configured: false, ready: false }),
  groupMemory?: (chatId: string) => { entries: AccountMemoryEntry[]; events: AccountMemoryEvent[] }) {
  return new ConsoleOverview({ ...(dispatch ? { records: () => dispatch.records(), teams: { current: () => ({ definitions }), version: () => ({ definitions }) } } : {}),
    ...(groupMemory ? { groupMemory } : {}),
    storageRoot: "/state", groups: () => ["oc_alpha", "oc_beta"], names: async () => ({ oc_alpha: "银河护卫队" }),
    chatIdOf: (_accountId, target) => target.startsWith("feishu.group.") ? target.slice("feishu.group.".length) : undefined, owner: (senderId) => senderId === "ou_owner", penny });
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
  expect(record.crossTeams).toEqual(["bill"]);
  expect([record.label, ...record.assignments.map(({ label }) => label)]).toEqual(["alice-1", "alice-1-1", "alice-1-2", "alice-1-3"]);
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
  // A proposal waits for its author and has no Assignment yet: its lead counts it by the request's own state.
  dispatch.admit(event("proposal", "oc_alpha", { text: "propose:alice" }));
  await vi.waitFor(() => expect(dispatch.records().find(({ job }) => job.id === "proposal")?.job.status).toBe("proposed"), { timeout: 3000, interval: 10 });
  dispatch.admit(event("alice-run", "oc_alpha"));
  await vi.waitFor(() => {
    const statuses = Object.fromEntries(dispatch.records().map(({ job, assignments }) => [job.id, assignments.map(({ status }) => status).join(",")]));
    expect(statuses).toEqual({ "alice-run": "running,running,running", "alice-wait": "waiting", "alice-done": "completed", "bill-done": "completed",
      "alice-beta": "completed", "alice-gamma": "completed", proposal: "" });
  }, { timeout: 3000, interval: 10 });

  const view = await overview(dispatch).view();
  // A request outside the dispatch groups has no place in the overview.
  expect(view.requests.map(({ id }) => id).sort()).toEqual(["alice-beta", "alice-done", "alice-run", "alice-wait", "bill-done", "proposal"]);
  expect(view.groups).toEqual([{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "oc_beta" }]);
  // Two running Assignments of Alice in one request count once; Bill's cross-team Assignment counts the request for Bill too.
  // A team being deleted keeps its card, marked, in the groups it has yet to leave (US-003/AC-02).
  expect(Object.fromEntries(view.teams.map(({ id, groups, counts, deleting }) => [id, { groups, counts, deleting }]))).toEqual({
    alice: { groups: ["oc_alpha", "oc_beta"], counts: { oc_alpha: { running: 1, waiting: 2, history: 1 }, oc_beta: { running: 0, waiting: 0, history: 1 } }, deleting: false },
    bill: { groups: ["oc_alpha"], counts: { oc_alpha: { running: 1, waiting: 0, history: 1 } }, deleting: false },
    eve: { groups: ["oc_beta"], counts: { oc_beta: { running: 0, waiting: 0, history: 0 } }, deleting: true } });
  // Under each leader, a frame per request with the team's running and waiting Executors: ended ones and other teams' stay out.
  const titles = (id: string) => request(view, id).assignments.map((a) => [a.id, a.title] as const);
  const named = (pairs: ReadonlyArray<readonly [string, string]>, wanted: string[]) => pairs.filter(([, title]) => wanted.includes(title)).map(([id]) => id);
  expect(Object.fromEntries(view.teams.map(({ id, frames }) => [id, frames]))).toEqual({
    alice: { oc_alpha: [{ request: "alice-wait", assignments: named(titles("alice-wait"), ["选方案"]) }, { request: "alice-run", assignments: named(titles("alice-run"), ["写长文案", "拍主图"]) }],
      oc_beta: [] },
    bill: { oc_alpha: [{ request: "alice-run", assignments: named(titles("alice-run"), ["订行程"]) }] }, eve: { oc_beta: [] } });
  expect(view.agents).toEqual({ sam: { name: "Sam", teamName: "总协调" }, alice: { name: "Alice", teamName: "运营团队" }, bill: { name: "Bill", teamName: "生活团队" },
    eve: { name: "Eve", teamName: "内容团队" } });
});

it("takes a request's delivery from its report: a cancellation reply, or a refused closing resent and accepted", async () => {
  const dispatch = dispatchOn(directory(), scripted(), { plans: { "om_alice-1:alice": { assignments: [one("整理文案")], decisions: [], help: [] } },
    rejected: new Set(["dispatch:alice-1:closing:0"]) });
  await dispatch.start();
  dispatch.admit(event("proposal", "oc_alpha", { text: "propose:alice" }));
  await vi.waitFor(() => expect(dispatch.records()[0]?.job.status).toBe("proposed"), { timeout: 5000, interval: 10 });
  dispatch.admit(event("cancel-1", "oc_alpha", { text: "cancel:proposal" }));
  dispatch.admit(event("alice-1", "oc_alpha"));
  await vi.waitFor(() => expect(dispatch.records().map(({ job }) => job.status)).toEqual(["cancelled", "completed"]), { timeout: 5000, interval: 10 });
  await vi.waitFor(() => expect(dispatch.records()[1]?.posts.at(-1)?.state).toBe("rejected"), { timeout: 5000, interval: 10 });
  const cancelled = request(await overview(dispatch).view(), "proposal");
  expect(cancelled.delivery).toBe("accepted");
  expect(cancelled.posts.at(-1)).toMatchObject({ agentId: "alice", kind: "cancelled", state: "accepted" });
  expect(request(await overview(dispatch).view(), "alice-1").delivery).toBe("rejected");

  dispatch.admit(event("resend-1", "oc_alpha", { text: "retry_report:alice-1" }));
  await vi.waitFor(() => expect(dispatch.records()[1]?.posts.at(-1)?.state).toBe("accepted"), { timeout: 5000, interval: 10 });
  const resent = request(await overview(dispatch).view(), "alice-1");
  expect(resent.delivery).toBe("accepted");
  expect(resent.posts.slice(-2).map(({ kind, state }) => `${kind}:${state}`)).toEqual(["closing:rejected", "closing:accepted"]);
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
    teams: [], requests: [], penny: { configured: true, ready: true }, storageRoot: "/state" });
});

it.each([
  ["a long request ID by its first eight characters", "c282668cdb0f4c0e9a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901abcd", "c282668c"],
  ["a short request ID whole", "alice-1", "alice-1"],
  ["an Assignment of the first attempt by its number", "c282668cdb0f4c0e9a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901abcd:assignment:0:2", "c282668c-2"],
  ["an Assignment a later attempt created by attempt and number", "c282668cdb0f4c0e9a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901abcd:assignment:1:3", "c282668c-1.3"],
])("shows %s", (_case, id, shown) => {
  expect(displayId(id)).toBe(shown);
});

const entry = (category: AccountMemoryEntry["category"], value: string, updatedAt: number): AccountMemoryEntry =>
  ({ id: `${category}-${updatedAt}`, category, value, evidenceEntryIds: [], confidence: 1, updatedAt });
const memoryEvent = (localDate: string, summary: string, updatedAt: number, extra: Partial<AccountMemoryEvent>): AccountMemoryEvent =>
  ({ id: `${localDate}-${summary}`, eventKind: "observed", localDate, timezone: "Asia/Shanghai", summary, evidenceEntryIds: [], confidence: 1, createdAt: updatedAt, updatedAt, ...extra });

it("shows a dispatch group's memory, every entry and event with its kind, a plan's state and time of day, and the latest change", () => {
  const read: string[] = [];
  const memory = (chatId: string) => {
    read.push(chatId);
    return { entries: [entry("preferences", "周报周五发", 1_000), entry("constraints", "不发客户手机号", 3_000)],
      events: [memoryEvent("2025-01-15", "商品 C 校对完成", 2_000, {}), memoryEvent("2026-11-08", "团建改到周日", 2_500, { factStatus: "retracted" }),
        memoryEvent("2026-11-09", "补丁已提交", 2_600, { fulfillsPlanId: "plan-1" }),
        memoryEvent("2026-11-12", "检查库存", 4_000, { eventKind: "planned", planStatus: "pending", timePrecision: "afternoon" }),
        memoryEvent("2026-11-13", "上架", 3_500, { eventKind: "planned", planStatus: "occurred", timePrecision: "exact", localTime: "14:30" }),
        memoryEvent("2026-11-15", "彩排", 3_600, { eventKind: "planned", planStatus: "cancelled", timePrecision: "date" })] };
  };
  const view = overview(undefined, undefined, memory).memory("oc_alpha");
  expect(read).toEqual(["oc_alpha"]);
  expect(view).toEqual({ readable: true, updatedAt: 4_000,
    entries: [{ category: "preferences", value: "周报周五发" }, { category: "constraints", value: "不发客户手机号" }],
    events: [
      { date: "2025-01-15", kind: "observed", plan: null, retracted: false, fulfillsPlan: false, time: null, summary: "商品 C 校对完成" },
      { date: "2026-11-08", kind: "observed", plan: null, retracted: true, fulfillsPlan: false, time: null, summary: "团建改到周日" },
      { date: "2026-11-09", kind: "observed", plan: null, retracted: false, fulfillsPlan: true, time: null, summary: "补丁已提交" },
      { date: "2026-11-12", kind: "planned", plan: "pending", retracted: false, fulfillsPlan: false, time: "afternoon", summary: "检查库存" },
      { date: "2026-11-13", kind: "planned", plan: "occurred", retracted: false, fulfillsPlan: false, time: "14:30", summary: "上架" },
      { date: "2026-11-15", kind: "planned", plan: "cancelled", retracted: false, fulfillsPlan: false, time: null, summary: "彩排" }] });
});

it("reaches no memory but a dispatch group's, and says when that memory cannot be read", () => {
  const empty = () => ({ entries: [], events: [] });
  expect(overview(undefined, undefined, empty).memory("oc_gamma")).toBeUndefined();
  expect(overview(undefined, undefined, empty).memory("oc_beta")).toEqual({ readable: true, entries: [], events: [], updatedAt: null });
  expect(overview(undefined).memory("oc_alpha")).toBeUndefined();
  expect(overview(undefined, undefined, () => { throw new Error("memory_integrity_error"); }).memory("oc_alpha")).toEqual({ readable: false });
});

// agent-console::REQ-001: the console's view is never an agent's input. Only the console's routes and main's wiring may read the
// projection, so any other module that imports it fails here and has to make its case.
it("is read by the console's routes and main's wiring only", () => {
  const source = new URL("../src/", import.meta.url);
  const importers = readdirSync(source).filter((name) => name.endsWith(".ts") && name !== "console-overview.ts")
    .filter((name) => /from "\.\/console-overview\.js"/.test(readFileSync(new URL(name, source), "utf8")));
  expect(importers.sort()).toEqual(["console-routes.ts", "main.ts"]);
});
