import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTeamLeader, LeaderOutputError, parseLeaderClosing, parseLeaderPlan, parseLeaderSupplement, planWithCorrection,
  type LeaderSessionKey, type LeaderTurnInput } from "../src/agent-dispatch-leader.js";
import { closeDispatchRuntime, DISPATCH_RUNTIME_EXIT_WAIT_MS, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import type { AppServerTurnResult } from "../src/app-server-turn-driver.js";
import { compactRuntimeHome } from "../src/runtime-home-compaction.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { conversation } from "./support/dispatch-runtime.js";
import { homeListing, keptListing, rolloutPath, seedExecutorHome } from "./support/runtime-home.js";

// Plan validation is a pure rule. The Team Leader wrapper is the production class with only the external runtime response
// substituted, as in agent-dispatch-classifier.test.ts (agent-dispatch Testing Decisions). Its plan JSON and supplement answer
// JSON have no real model sample yet; ticket 21's live run checks real output.
const bill = { executorProfiles: [{ id: "trip" }, { id: "meal" }] };
const plan = (profileId: string, count = 1) => ({ assignments: Array.from({ length: count }, (_, index) => ({ profileId, title: `规划行程 ${index + 1}`, brief: "南京一日游，预算 300 元", dependsOn: [] as number[] })),
  decisions: [] as string[] });

/** A plan whose n-th Assignment depends on the positions in `dependsOn[n]`. */
const depending = (dependsOn: number[][]) => ({ assignments: dependsOn.map((positions, index) => ({ profileId: "trip", title: `分工 ${index + 1}`, brief: "南京一日游", dependsOn: positions })),
  decisions: [] as string[] });

describe("Team Leader plan validation", () => {
  it("accepts a plan of several Assignments with their dependencies and its decisions", () => {
    expect(parseLeaderPlan({ assignments: [{ profileId: "meal", title: " 采购清单 ", brief: "三人份晚餐", dependsOn: [] },
      { profileId: "trip", title: "规划行程", brief: " 南京一日游 ", dependsOn: [1] }, { profileId: "meal", title: "预订午餐", brief: "两人", dependsOn: [1, 2] }],
    decisions: [" 先定行程再订餐 ", "预算按 300 元控制"] }, bill))
      .toEqual({ assignments: [{ profileId: "meal", title: "采购清单", brief: "三人份晚餐", dependsOn: [] }, { profileId: "trip", title: "规划行程", brief: "南京一日游", dependsOn: [1] },
        { profileId: "meal", title: "预订午餐", brief: "两人", dependsOn: [1, 2] }], decisions: ["先定行程再订餐", "预算按 300 元控制"], help: [] });
  });

  it("accepts a plan with five decisions", () => {
    expect(parseLeaderPlan({ ...plan("trip"), decisions: ["一", "二", "三", "四", "五"] }, bill).decisions).toHaveLength(5);
  });

  // agent-dispatch::REQ-013/AC-01: the plan names up to three parts for the Coordinator to place with other teams.
  it("accepts a plan asking for help with up to three parts", () => {
    const help = [{ title: " 自动上架脚本 ", brief: " 只交付代码，不运行 " }, { title: "竞品比价", brief: "三家" }, { title: "拍照", brief: "白底" }];
    expect(parseLeaderPlan({ ...plan("trip"), help }, bill).help).toEqual([{ title: "自动上架脚本", brief: "只交付代码，不运行" }, { title: "竞品比价", brief: "三家" },
      { title: "拍照", brief: "白底" }]);
  });

  // agent-dispatch::REQ-011/AC-02: the ceiling counts every Assignment the request already holds, whichever team planned it.
  it.each([
    ["accepts four more on six planned", 6, 4, undefined],
    ["refuses five more on six planned", 6, 5, "这件事务共有 11 项分工，超过上限 10 项；请合并相近的分工"],
  ])("%s", (_case, existing, count, reason) => {
    if (reason) expect(() => parseLeaderPlan(plan("trip", count), bill, existing)).toThrow(expect.objectContaining({ code: "leader_plan_invalid", reason }));
    else expect(parseLeaderPlan(plan("trip", count), bill, existing).assignments).toHaveLength(count);
  });

  // A plan's positions number its own Assignments, whatever other teams already planned, so a cross-team Team Leader's plan
  // depends only on its own (agent-dispatch::REQ-011/AC-05, REQ-013/AC-02). Numbered over the request, [3] would be valid here.
  it.each([
    ["accepts a dependency on an earlier Assignment of its own plan", [[], [1]], undefined],
    ["refuses a dependency counted past its own plan", [[], [3]], "第 2 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 1）"],
  ])("on six planned by other teams, %s", (_case, dependsOn, reason) => {
    if (reason) expect(() => parseLeaderPlan(depending(dependsOn), bill, 6)).toThrow(expect.objectContaining({ code: "leader_plan_invalid", reason }));
    else expect(parseLeaderPlan(depending(dependsOn), bill, 6).assignments.map(({ dependsOn: after }) => after)).toEqual(dependsOn);
  });

  it.each([
    ["a missing brief", { assignments: [{ profileId: "trip", title: "规划行程", dependsOn: [] }], decisions: [] }],
    ["an extra property", { assignments: [{ profileId: "trip", title: "规划行程", brief: "南京", dependsOn: [], tools: ["files.write"] }], decisions: [] }],
    ["a missing dependsOn, which only fixture mode fills", { assignments: [{ profileId: "trip", title: "规划行程", brief: "南京" }], decisions: [] }],
    ["a profile only another team presets", plan("code")],
    ["an empty title", { assignments: [{ profileId: "trip", title: "  ", brief: "南京", dependsOn: [] }], decisions: [] }],
    ["missing decisions", { assignments: plan("trip").assignments }],
    ["six decisions", { ...plan("trip"), decisions: ["一", "二", "三", "四", "五", "六"] }],
    ["an empty decision", { ...plan("trip"), decisions: ["  "] }],
    ["eleven Assignments, over the ceiling", plan("trip", 11)],
    ["four help items", { ...plan("trip"), help: ["一", "二", "三", "四"].map((title) => ({ title, brief: "说明" })) }],
    ["a help item with an empty title", { ...plan("trip"), help: [{ title: "  ", brief: "说明" }] }],
    ["a help item with an empty brief", { ...plan("trip"), help: [{ title: "拍照", brief: "  " }] }],
    ["a dependency on position 0", depending([[], [0]])],
    ["a dependency on a position past the plan", depending([[], [], [4]])],
    // A cycle needs a later reference, so this row is also the cycle case: the earlier-only rule refuses it through that reference.
    ["a dependency on a later position", depending([[], [3], []]), "第 2 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 1）"],
    ["a dependency on its own position", depending([[1], []]), "第 1 项分工的 dependsOn 只能为空"],
    ["a repeated dependency", depending([[], [], [1, 1]]), "第 3 项分工的 dependsOn 不能重复"],
  ])("refuses %s", (_case, value, reason?: string) => {
    expect(() => parseLeaderPlan(value, bill)).toThrow(expect.objectContaining({ code: "leader_plan_invalid", ...(reason ? { reason } : {}) }));
  });

  const supplementOf = (affected: number[], assignments = plan("trip").assignments.slice(0, 0), extra: { parts?: number[]; help?: Array<{ title: string; brief: string }> } = {}) =>
    ({ affected, assignments, decisions: [] as string[], ...extra });
  const decoded = (affected: number[], assignments: unknown[] = [], extra: { parts?: number[]; help?: unknown[] } = {}) =>
    ({ affected, assignments, decisions: [], parts: [], help: [], ...extra });
  // The turn was shown three Assignments, so new ones start at position 4.
  const newDepending = (dependsOn: number[][]) => depending(dependsOn).assignments;
  // Positions number what the turn was shown: three Assignments, and two requested parts where a row passes them; the ceiling
  // counts every Assignment of the request (agent-dispatch::REQ-007/AC-04, REQ-011/AC-02).
  it.each([
    ["an answer naming one of three Assignments", supplementOf([2]), decoded([2])],
    ["an answer adding an Assignment", supplementOf([], plan("meal").assignments), decoded([], plan("meal").assignments)],
    ["an answer bringing the request to the ceiling of ten", supplementOf([], plan("meal", 7).assignments), decoded([], plan("meal", 7).assignments)],
    ["position 0", supplementOf([0]), "leader_plan_invalid"],
    ["a position past the request's Assignments", supplementOf([4]), "leader_plan_invalid"],
    ["a repeated position", supplementOf([1, 1]), "leader_plan_invalid"],
    ["an answer affecting nothing", supplementOf([]), "leader_plan_invalid"],
    ["a new Assignment on another team's preset", supplementOf([], plan("code").assignments), "leader_plan_invalid"],
    ["new Assignments taking the request past the ceiling of ten", supplementOf([], plan("meal", 8).assignments), "leader_plan_invalid",
      "这件事务共有 11 项分工，超过上限 10 项；请合并相近的分工"],
    ["an answer naming one of two requested parts", supplementOf([], undefined, { parts: [2] }), decoded([], [], { parts: [2] }), undefined, { total: 3, parts: 2 }],
    ["a part past the requested parts", supplementOf([], undefined, { parts: [3] }), "leader_plan_invalid", "parts 只能取 1 到 2", { total: 3, parts: 2 }],
    ["a repeated part", supplementOf([], undefined, { parts: [1, 1] }), "leader_plan_invalid", "parts 不能重复", { total: 3, parts: 2 }],
    ["a part named by a turn shown no requested parts", supplementOf([1], undefined, { parts: [1] }), "leader_plan_invalid", "parts 必须为空"],
    ["an answer asking only for help", supplementOf([], undefined, { help: [{ title: " 拍照 ", brief: "白底" }] }), decoded([], [], { help: [{ title: "拍照", brief: "白底" }] })],
    ["new Assignments depending on an existing one and on an earlier new one", supplementOf([1], newDepending([[2], [1, 4]])), decoded([1], newDepending([[2], [1, 4]]))],
    ["a new Assignment depending on its own position", supplementOf([], newDepending([[4]])), "leader_plan_invalid",
      "第 4 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 3）"],
    ["a new Assignment depending on a later new one", supplementOf([], newDepending([[5], []])), "leader_plan_invalid",
      "第 4 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 3）"],
    // Shown one Assignment of a request holding two: the new one is at position 2 of what the turn was shown.
    ["a new Assignment depending on itself, counted among the Assignments the turn was shown", supplementOf([], newDepending([[2]])), "leader_plan_invalid",
      "第 2 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 1）", { total: 2, parts: 1 }, 1],
  ])("decodes or refuses a supplement answer: %s", (_case, value, expected, reason?: string, view?: { total: number; parts: number }, shown = 3) => {
    if (typeof expected === "string") expect(() => parseLeaderSupplement(value, bill, shown, view)).toThrow(expect.objectContaining({ code: expected, ...(reason ? { reason } : {}) }));
    else expect(parseLeaderSupplement(value, bill, shown, view)).toEqual(expected);
  });

  it.each([
    ["a valid closing", '{"message":" 行程已整理好。 "}', "行程已整理好。"],
    ["an empty message", '{"message":"  "}', "leader_closing_invalid"],
    ["an oversized message", JSON.stringify({ message: "长".repeat(2001) }), "leader_closing_invalid"],
    ["an extra property", '{"message":"好","files":[]}', "leader_closing_invalid"],
  ])("decodes or refuses %s", (_case, text, expected) => {
    if (expected === "leader_closing_invalid") expect(() => parseLeaderClosing(text)).toThrow(expected);
    else expect(parseLeaderClosing(text)).toBe(expected);
  });

  it.each([
    ["corrects an invalid plan once", [JSON.stringify(plan("code")), JSON.stringify(plan("trip"))], { result: { ...plan("trip"), help: [] } }, 2],
    ["refuses a plan still invalid after one correction", ["{broken", "{broken"], { error: "leader_plan_invalid" }, 2],
    ["has a plan over the ceiling merged in its correction turn", [JSON.stringify(plan("trip", 11)), JSON.stringify(plan("trip", 10))], { result: { ...plan("trip", 10), help: [] } }, 2],
  ])("%s", async (_case, outputs, expected, turns) => {
    const refusals: Array<string | undefined> = [];
    const turn = vi.fn(async (refusal?: LeaderOutputError) => { refusals.push(refusal?.reason); return outputs[refusals.length - 1]!; });
    const outcome = planWithCorrection(turn, bill);
    if ("result" in expected) await expect(outcome).resolves.toEqual(expected.result);
    else await expect(outcome).rejects.toThrow(expected.error);
    expect(turn).toHaveBeenCalledTimes(turns);
    expect(refusals[0]).toBeUndefined();
    if (turns === 2) expect(refusals[1]).toMatch(/profileId "code" 不是本团队的预设能力档|输出不是有效的 JSON|这件事务共有 11 项分工，超过上限 10 项；请合并相近的分工/u);
  });
});

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const input = (revision = "r1", definitionsVersion = 1): LeaderTurnInput => ({
  requestId: "request-one",
  leader: { id: "bill", name: "Bill", teamName: "生活团队", responsibility: "衣食住行", instructions: "负责人规则" },
  profiles: [{ id: "trip", name: "行程" }, { id: "meal", name: "餐饮" }],
  brief: { message: "帮我规划周末一日行程", summary: "规划周末一日行程" },
  directory: [{ name: "生活团队", responsibility: "衣食住行" }],
  memory: "",
  session: { accountId: "cli_sam", target: "feishu.group.oc_alpha", bindingHash: "binding-alpha", revision, definitionsVersion },
  fixtureMessageId: "om_one",
});
function leaderWith(access: ConstructorParameters<typeof CodexTeamLeader>[1]["runtime"]) {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-leader-")); directories.push(directory);
  return new CodexTeamLeader(join(directory, "agent-sessions.sqlite"), { runtime: access, model: () => ({ model: "fixture-model", effort: "low" }) });
}
const reply = (value: unknown): AppServerTurnResult => ({ owner: "model_owned", finalText: JSON.stringify(value) });

describe("Team Leader wrapper", () => {
  it("plans through a tool-free constrained turn on a persisted thread and releases it", async () => {
    const external = conversation("leader-thread", JSON.stringify(plan("meal")));
    const leader = leaderWith((_scope, work) => work(external, "/isolated/leader"));
    await expect(leader.plan(input())).resolves.toEqual({ ...plan("meal"), help: [] });
    expect(external.startOrResume).toHaveBeenCalledWith(undefined, "/isolated/leader", []);
    expect(external.runTurn).toHaveBeenCalledWith("leader-thread", expect.any(String), undefined, undefined, expect.objectContaining({
      model: "fixture-model", effort: "low", outputSchema: expect.objectContaining({ required: ["assignments", "decisions", "help"] }) }));
    const prompt = external.runTurn.mock.calls[0]![1] as string;
    for (const fragment of ["你是 Bill，生活团队的负责人", "负责人规则", "帮我规划周末一日行程", "规划周末一日行程", '"id":"trip"', '"id":"meal"']) expect(prompt).toContain(fragment);
    expect(external.releaseThread).toHaveBeenCalledExactlyOnceWith("leader-thread");
    leader.dispose();
  });

  it.each([
    { name: "malformed JSON", response: { owner: "model_owned", finalText: "{broken" } },
    { name: "oversized valid JSON", response: { owner: "model_owned", finalText: JSON.stringify(plan("trip")) + " ".repeat(16_001) } },
    { name: "workflow ownership", response: { owner: "workflow_owned", receipt: { outcome: "accepted", reply: "not a plan" } } },
  ] satisfies Array<{ name: string; response: AppServerTurnResult }>)("rejects $name after its correction turn and releases the thread each time", async ({ response }) => {
    const external = conversation("leader-thread");
    external.runTurn.mockResolvedValue(response);
    const leader = leaderWith((_scope, work) => work(external, "/isolated/leader"));
    await expect(leader.plan(input())).rejects.toThrow("leader_plan_invalid");
    expect(external.runTurn).toHaveBeenCalledTimes(2);
    expect(external.releaseThread.mock.calls).toEqual([["leader-thread"], ["leader-thread"]]);
    leader.dispose();
  });

  it("runs the correction turn on the same Team Leader thread, told why the plan was refused", async () => {
    const external = conversation("leader-thread");
    external.runTurn.mockResolvedValueOnce(reply(plan("code"))).mockResolvedValueOnce(reply(plan("trip")));
    const leader = leaderWith((_scope, work) => work(external, "/isolated/leader"));
    await expect(leader.plan(input())).resolves.toEqual({ ...plan("trip"), help: [] });
    expect(external.runTurn.mock.calls.map(([threadId]) => threadId)).toEqual(["leader-thread", "leader-thread"]);
    expect(external.startOrResume.mock.calls[1]![0]).toBe("leader-thread");
    expect(external.runTurn.mock.calls[1]![1]).toContain('上一次输出未通过校验：profileId "code" 不是本团队的预设能力档');
    leader.dispose();
  });

  it("answers a supplement through a tool-free constrained turn on the same thread, corrected once", async () => {
    const external = conversation("leader-thread");
    external.runTurn.mockResolvedValueOnce(reply({ affected: [3], assignments: [], decisions: [] })).mockResolvedValueOnce(reply({ affected: [2], assignments: [], decisions: ["只调整行程"] }));
    const leader = leaderWith((_scope, work) => work(external, "/isolated/leader"));
    const assignments = [{ position: 1, executor: "执行者 7", profileName: "餐饮", title: "预订午餐", status: "completed", dependsOn: [] },
      { position: 2, executor: "执行者 8", profileName: "行程", title: "规划行程", status: "completed", dependsOn: [1] }];
    await expect(leader.supplement(input(), assignments, "改成下午出发")).resolves.toEqual({ affected: [2], assignments: [], decisions: ["只调整行程"], parts: [], help: [] });
    expect(external.runTurn).toHaveBeenCalledTimes(2);
    expect(external.runTurn.mock.calls.map(([threadId, , , , options]) => [threadId, (options as unknown as { outputSchema: { required: string[] } }).outputSchema.required]))
      .toEqual([["leader-thread", ["affected", "assignments", "decisions", "parts", "help"]], ["leader-thread", ["affected", "assignments", "decisions", "parts", "help"]]]);
    for (const fragment of ["改成下午出发", "执行者 8", "规划行程"]) expect(external.runTurn.mock.calls[0]![1]).toContain(fragment);
    expect(external.runTurn.mock.calls[1]![1]).toContain("上一次输出未通过校验：affected 只能取 1 到 2");
    expect(external.releaseThread.mock.calls).toEqual([["leader-thread"], ["leader-thread"]]);
    leader.dispose();
  });

  it("resumes the released Team Leader session from its persisted thread for the closing turn", async () => {
    vi.useFakeTimers();
    const runtimes = [conversation("leader-thread", JSON.stringify(plan("trip"))), conversation("leader-thread", '{"message":"行程已整理好。"}')];
    let created = 0;
    const pool = new RuntimePool<{ agent: ReturnType<typeof conversation>; cwd: string }>({ limit: 1, idleMs: 1000, close: ({ agent }) => agent.close() });
    const leader = leaderWith((scope, work) => pool.use(scope, () => ({ agent: runtimes[created++]!, cwd: "/isolated/leader" }), ({ agent, cwd }) => work(agent, cwd)));
    await leader.plan(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtimes[0]!.close).toHaveBeenCalledOnce();
    await expect(leader.close(input(), [{ position: 1, title: "规划行程 1", executor: "执行者 1", status: "completed", result: "已整理行程", dependsOn: [] }])).resolves.toBe("行程已整理好。");
    expect(created).toBe(2);
    expect(runtimes[1]!.startOrResume.mock.calls[0]![0]).toBe("leader-thread");
    const prompt = runtimes[1]!.runTurn.mock.calls[0]![1] as string;
    expect(prompt).toContain("规划行程 1");
    expect(prompt).toContain("已整理行程");
    leader.dispose(); await pool.close();
  });

  it("asks for the runtime that its leader, conversation, binding, access revision and definitions version name", async () => {
    const scopes: string[] = [];
    const external = conversation("leader-thread", JSON.stringify(plan("trip")));
    const leader = leaderWith((scope, work) => { scopes.push(scope); return work(external, "/isolated/leader"); });
    await leader.plan(input("r1", 1));
    await leader.plan(input("r1", 2));
    await leader.plan(input("r2", 1));
    // The names the service gave these sessions before superseded homes were compacted: under any other name a stored
    // session would start again on a fresh thread, and its home would count as superseded.
    expect(scopes).toEqual(["dispatch-leader-e07e3004a3d9732c5cefe746695cf901b7aab54c14da126110cab1386572dea0",
      "dispatch-leader-53c589f619bbdfdf1c6b20bfae546e7b47f43c4f4d14d2251024722ff1412385",
      "dispatch-leader-bd863fcf6e2a922cd863b8458dac3ecf0b62ed414402eeb1fa200cf0e0c5ff2b"]);
    leader.dispose();
  });

  it("starts a new Team Leader session after the access revision changes", async () => {
    const external = conversation("leader-thread", JSON.stringify(plan("trip")));
    const leader = leaderWith((_scope, work) => work(external, "/isolated/leader"));
    await leader.plan(input("r1"));
    await leader.plan(input("r1"));
    await leader.plan(input("r2"));
    expect(external.startOrResume.mock.calls.map(([threadId]) => threadId)).toEqual([undefined, "leader-thread", undefined]);
    leader.dispose();
  });
});

// Compaction of superseded Team Leader homes (agent-dispatch::QR-003). Each runtime leaves in its home the file set a real App
// Server turn leaves (tests/support/runtime-home.ts). The compaction rule is covered by runtime-home-compaction.test.ts, and
// which sessions stored requests keep in use by agent-dispatch.test.ts; here `inUse` stands in for that answer.
// Gaps:
// - Compaction must not interleave with creating a runtime on the same home. The creation side has a case (a sweep that runs
//   while a runtime is being created). The other side has none: finding a home superseded and removing its files run
//   synchronously, so no case can place anything between them; code review covers that no await separates the two.
// - `dispatch_leader_homes_unreadable` for an unreadable runtimes root has no case, as for Executor homes: listing a directory
//   that cannot be read needs a file-permission setup the sweep's other cases do not share. It only reports and removes nothing.
const session = (revision: string, definitionsVersion: number): LeaderSessionKey => ({ leaderId: input().leader.id, ...input(revision, definitionsVersion).session });
const threadOf = (scope: string) => `thread-${scope.slice(-8)}`;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const WHOLE = "codex-home/state_5.sqlite-wal";
/** The runtime of the home `scope` names under `root`: its first runtime leaves the home a turn leaves, with a rollout of `rollout`. */
function runtimeOn(root: string, scope: string, rollout = threadOf(scope)) {
  const home = join(root, scope);
  if (!existsSync(home)) seedExecutorHome(home, [{ threadId: rollout }]);
  const agent = conversation(threadOf(scope));
  agent.runTurn.mockImplementation(async (_thread, prompt) => reply(String(prompt).includes("分工已经结束") ? { message: "已收尾。" } : plan("trip")));
  return { agent, cwd: join(home, "workspace") };
}
/** A Team Leader whose runtimes live only for their turn; `scopes` lists the homes its turns asked for, in order. */
function homesLeader(inUse: () => readonly LeaderSessionKey[], options: { rollout?: string; compact?: typeof compactRuntimeHome } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dispatch-leader-homes-")), state = mkdtempSync(join(tmpdir(), "dispatch-leader-")); directories.push(root, state);
  const reports: string[] = [], scopes: string[] = [];
  const leader = new CodexTeamLeader(join(state, "agent-sessions.sqlite"), { model: () => ({ model: "fixture-model", effort: "low" }),
    runtime: (scope, work) => { if (!scopes.includes(scope)) scopes.push(scope); const runtime = runtimeOn(root, scope, options.rollout); return work(runtime.agent, runtime.cwd); },
    homes: { root, compact: options.compact ?? compactRuntimeHome, inUse }, report: (code) => reports.push(code) });
  return { leader, root, reports, scopes };
}

/**
 * A Team Leader whose runtimes stay in a pool with the production close, each created through `tracked` as main creates them.
 * `exited` is each runtime's process exit; `creating` runs while a runtime is being created, after its home exists.
 */
function pooledLeader(inUse: () => readonly LeaderSessionKey[], options: { root?: string; database?: string; exited?: () => Promise<void>; creating?: (home: string) => void } = {}) {
  const made = mkdtempSync(join(tmpdir(), "dispatch-leader-pooled-")); directories.push(made);
  const root = options.root ?? join(made, "homes"), database = options.database ?? join(made, "agent-sessions.sqlite");
  const reports: string[] = [], scopes: string[] = [], atCreation: string[][] = [], agents: Array<ReturnType<typeof conversation>> = [];
  const pool = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: closeDispatchRuntime });
  const leader: CodexTeamLeader = new CodexTeamLeader(database, { model: () => ({ model: "fixture-model", effort: "low" }),
    runtime: (scope, work) => pool.use(scope, () => leader.tracked(scope, () => {
      const home = join(root, scope);
      if (!scopes.includes(scope)) scopes.push(scope);
      atCreation.push(existsSync(home) ? homeListing(home) : []);
      const runtime = runtimeOn(root, scope);
      agents.push(runtime.agent);
      options.creating?.(home);
      return { ...runtime, exited: options.exited ?? (() => Promise.resolve()) };
    }), ({ agent, cwd }) => work(agent, cwd)),
    homes: { root, compact: compactRuntimeHome, inUse }, report: (code) => reports.push(code) });
  return { leader, pool, root, database, reports, scopes, atCreation, agents };
}
const CLOSED = [{ position: 1, title: "规划行程 1", executor: "执行者 1", status: "completed", result: "已整理行程", dependsOn: [] }];

describe("Team Leader home compaction", () => {
  it("compacts superseded homes to their rollouts, byte for byte, and leaves the homes of sessions in use whole", async () => {
    let inUse = [session("r1", 1), session("r1", 2)];
    const run = homesLeader(() => inUse);
    await run.leader.plan(input("r1", 1));
    await run.leader.plan(input("r1", 2));
    const [older, current] = run.scopes.map((scope) => join(run.root, scope)) as [string, string];
    // A home no session records, as an earlier revision left it, and homes that are not a Team Leader's.
    const unrecorded = join(run.root, `dispatch-leader-${"b".repeat(64)}`);
    seedExecutorHome(unrecorded, [{ threadId: "thread-unrecorded" }]);
    const others = [`dispatch-${"a".repeat(64)}`, "dispatch-coordinator", "feishu.group.oc_alpha", `dispatch-leader-${"c".repeat(63)}`].map((name) => join(run.root, name));
    for (const home of others) seedExecutorHome(home, [{ threadId: "thread-other" }]);
    const untouched = () => Object.fromEntries([current, ...others].map((home) => [home, homeListing(home)]));
    const before = untouched(), rollout = join(older, rolloutPath(threadOf(run.scopes[0]!))), hash = sha256(rollout);
    expect(before[current]).toContain(WHOLE);
    // Definitions version 2 is current and no request keeps version 1.
    inUse = [session("r1", 2)];
    run.leader.compactSupersededHomes();
    expect(homeListing(older)).toEqual(keptListing(threadOf(run.scopes[0]!)));
    expect(sha256(rollout)).toBe(hash);
    expect(homeListing(unrecorded)).toEqual(keptListing("thread-unrecorded"));
    expect(untouched()).toEqual(before);
    expect(run.reports).toEqual([]);
    run.leader.dispose();
  });

  it("keeps a superseded home whole and reports it when its session's thread has no rollout there", async () => {
    let inUse = [session("r1", 1)];
    // The home holds another thread's rollout only: compacting without the session's thread would remove its files.
    const run = homesLeader(() => inUse, { rollout: "thread-older" });
    await run.leader.plan(input("r1", 1));
    const home = join(run.root, run.scopes[0]!), before = homeListing(home);
    inUse = [];
    run.leader.compactSupersededHomes();
    expect(homeListing(home)).toEqual(before);
    expect(run.reports).toEqual([`dispatch_leader_home_kept:rollout_missing:${run.scopes[0]}`]);
    run.leader.dispose();
  });

  it("reports a home whose compaction throws, and goes on with the turn that swept", async () => {
    const run = homesLeader(() => [session("r1", 1)], { compact: () => { throw new Error("session_store_unreadable"); } });
    const unrecorded = `dispatch-leader-${"b".repeat(64)}`;
    seedExecutorHome(join(run.root, unrecorded), [{ threadId: "thread-unrecorded" }]);
    // The plan turn starts a session, so it sweeps; the failure stays with the home it happened on.
    await expect(run.leader.plan(input("r1", 1))).resolves.toEqual({ ...plan("trip"), help: [] });
    expect(homeListing(join(run.root, unrecorded))).toContain(WHOLE);
    expect(run.reports).toEqual([`dispatch_leader_home_kept:compaction_failed:${unrecorded}`]);
    run.leader.dispose();
  });

  it("removes nothing, at a sweep or at a release, when it cannot tell which sessions are in use", async () => {
    vi.useFakeTimers();
    let readable = true;
    const run = pooledLeader(() => { if (!readable) throw new Error("dispatch_store_closed"); return []; });
    // A home no session records, for the sweep, and the home of a released runtime, for the release.
    const unrecorded = join(run.root, `dispatch-leader-${"b".repeat(64)}`);
    seedExecutorHome(unrecorded, [{ threadId: "thread-unrecorded" }]);
    readable = false;
    await run.leader.plan(input());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.agents[0]!.close).toHaveBeenCalledOnce();
    expect(homeListing(unrecorded)).toContain(WHOLE);
    expect(homeListing(join(run.root, run.scopes[0]!))).toContain(WHOLE);
    // The turn that started the session swept once, and the release asked once.
    expect(run.reports).toEqual(["dispatch_leader_homes_unreadable", "dispatch_leader_homes_unreadable"]);
    await run.pool.close(); run.leader.dispose();
  });

  it("sweeps when a turn starts a session with none recorded, and not on a later turn of that session", async () => {
    let inUse = [session("r1", 1)];
    const run = homesLeader(() => inUse);
    await run.leader.plan(input("r1", 1));
    const older = join(run.root, run.scopes[0]!);
    // Definitions version 2 takes effect; nothing is swept until a turn starts a session under it.
    inUse = [session("r1", 2)];
    expect(homeListing(older)).toContain(WHOLE);
    await run.leader.plan(input("r1", 2));
    expect(homeListing(older)).toEqual(keptListing(threadOf(run.scopes[0]!)));
    expect(homeListing(join(run.root, run.scopes[1]!))).toContain(WHOLE);
    // The closing turn of that session finds it recorded: a home superseded since then waits for the next sweep.
    const later = join(run.root, `dispatch-leader-${"c".repeat(64)}`);
    seedExecutorHome(later, [{ threadId: "thread-later" }]);
    await expect(run.leader.close(input("r1", 2), CLOSED)).resolves.toBe("已收尾。");
    expect(homeListing(later)).toContain(WHOLE);
    expect(run.reports).toEqual([]);
    run.leader.dispose();
  });

  it("leaves a superseded home alone while its runtime exists, compacts it once the released runtime's process has exited, and resumes its thread there", async () => {
    vi.useFakeTimers();
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    // No stored request keeps the session, as after its request failed and a later definitions version took effect.
    const run = pooledLeader(() => [], { exited: () => exited });
    await run.leader.plan(input());
    const home = join(run.root, run.scopes[0]!), thread = threadOf(run.scopes[0]!);
    run.leader.compactSupersededHomes();
    expect(homeListing(home)).toContain(WHOLE);
    // The idle runtime is released. A retry's closing turn waits for that close, and the home is compacted only at the exit.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.agents[0]!.close).toHaveBeenCalledOnce();
    const closing = run.leader.close(input(), CLOSED);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.atCreation).toHaveLength(1);
    expect(homeListing(home)).toContain(WHOLE);
    exit();
    await expect(closing).resolves.toBe("已收尾。");
    expect(run.atCreation[1]).toEqual(keptListing(thread));
    expect(run.agents[1]!.startOrResume.mock.calls[0]![0]).toBe(thread);
    expect(run.reports).toEqual([]);
    await run.pool.close(); run.leader.dispose();
  });

  it("leaves a released runtime's home whole while a stored request keeps its session in use", async () => {
    vi.useFakeTimers();
    const run = pooledLeader(() => [session("r1", 1)]);
    await run.leader.plan(input("r1", 1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.agents[0]!.close).toHaveBeenCalledOnce();
    expect(homeListing(join(run.root, run.scopes[0]!))).toContain(WHOLE);
    expect(run.reports).toEqual([]);
    await run.pool.close(); run.leader.dispose();
  });

  it("leaves a superseded home whose process does not exit to the next start's sweep", async () => {
    vi.useFakeTimers();
    const run = pooledLeader(() => [], { exited: () => new Promise<void>(() => {}) });
    await run.leader.plan(input());
    const home = join(run.root, run.scopes[0]!);
    await vi.advanceTimersByTimeAsync(60_000 + DISPATCH_RUNTIME_EXIT_WAIT_MS);
    expect(homeListing(home)).toContain(WHOLE);
    expect(run.reports).toEqual([`dispatch_leader_home_deferred:process_running:${run.scopes[0]}`]);
    // A later sweep of the same service leaves it too: its process may still run.
    run.leader.compactSupersededHomes();
    expect(homeListing(home)).toContain(WHOLE);
    await run.pool.close(); run.leader.dispose();
    vi.useRealTimers();
    // The next start: a new Team Leader on the same session store sweeps before any work.
    const restarted = pooledLeader(() => [], { root: run.root, database: run.database });
    restarted.leader.compactSupersededHomes();
    expect(homeListing(home)).toEqual(keptListing(threadOf(run.scopes[0]!)));
    expect([run.reports.length, restarted.reports]).toEqual([1, []]);
    await restarted.pool.close(); restarted.leader.dispose();
  });

  it("leaves a home alone at a later runtime's release too, once a process on it has not exited", async () => {
    vi.useFakeTimers();
    let released = 0;
    // The first runtime's process never exits; the second runtime's exits at once.
    const run = pooledLeader(() => [], { exited: () => released++ === 0 ? new Promise<void>(() => {}) : Promise.resolve() });
    await run.leader.plan(input());
    const home = join(run.root, run.scopes[0]!);
    await vi.advanceTimersByTimeAsync(60_000 + DISPATCH_RUNTIME_EXIT_WAIT_MS);
    // A later turn of the session gets a second runtime on the same home, which is released with its process gone.
    await expect(run.leader.close(input(), CLOSED)).resolves.toBe("已收尾。");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.agents.map((agent) => agent.close.mock.calls.length)).toEqual([1, 1]);
    // The first process may still run on the home, so it stays whole until the next start.
    expect(homeListing(home)).toContain(WHOLE);
    expect(run.reports).toEqual([`dispatch_leader_home_deferred:process_running:${run.scopes[0]}`]);
    await run.pool.close(); run.leader.dispose();
  });

  it("stops treating a home as occupied when creating its runtime fails", async () => {
    const run = pooledLeader(() => [], { creating: () => { throw new Error("isolated_runtime_catalog_unavailable"); } });
    await expect(run.leader.plan(input())).rejects.toThrow("isolated_runtime_catalog_unavailable");
    // No runtime exists on the home the failed creation left, so a sweep compacts it like any superseded home.
    run.leader.compactSupersededHomes();
    expect(homeListing(join(run.root, run.scopes[0]!))).toEqual(keptListing(threadOf(run.scopes[0]!)));
    expect(run.reports).toEqual([]);
    await run.pool.close(); run.leader.dispose();
  });

  it("does not compact a home from a sweep that runs while its runtime is being created", async () => {
    const during: string[][] = [];
    const run = pooledLeader(() => [], { creating: (home) => { run.leader.compactSupersededHomes(); during.push(homeListing(home)); } });
    await run.leader.plan(input());
    expect(during).toHaveLength(1);
    expect(during[0]).toContain(WHOLE);
    await run.pool.close(); run.leader.dispose();
  });
});
