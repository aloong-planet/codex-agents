import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTeamLeader, LeaderOutputError, parseLeaderClosing, parseLeaderPlan, parseLeaderSupplement, planWithCorrection,
  type LeaderTurnInput } from "../src/agent-dispatch-leader.js";
import type { AppServerTurnResult } from "../src/app-server-turn-driver.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { conversation } from "./support/dispatch-runtime.js";

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
        { profileId: "meal", title: "预订午餐", brief: "两人", dependsOn: [1, 2] }], decisions: ["先定行程再订餐", "预算按 300 元控制"] });
  });

  it("accepts a plan with five decisions", () => {
    expect(parseLeaderPlan({ ...plan("trip"), decisions: ["一", "二", "三", "四", "五"] }, bill).decisions).toHaveLength(5);
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
    ["a dependency on position 0", depending([[], [0]])],
    ["a dependency on a position past the plan", depending([[], [], [4]])],
    ["a dependency on a later position", depending([[], [3], []]), "第 2 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 1）"],
    ["a dependency on its own position", depending([[1], []]), "第 1 项分工的 dependsOn 只能为空"],
    // A cycle needs a later reference, so the earlier-only rule refuses it through that reference.
    ["a cycle between positions 1 and 2", depending([[2], [1]]), "第 1 项分工的 dependsOn 只能为空"],
    ["a repeated dependency", depending([[], [], [1, 1]]), "第 3 项分工的 dependsOn 不能重复"],
  ])("refuses %s", (_case, value, reason?: string) => {
    expect(() => parseLeaderPlan(value, bill)).toThrow(expect.objectContaining({ code: "leader_plan_invalid", ...(reason ? { reason } : {}) }));
  });

  const supplementOf = (affected: number[], assignments = plan("trip").assignments.slice(0, 0)) => ({ affected, assignments, decisions: [] as string[] });
  // The request has three Assignments, so new ones start at position 4.
  const newDepending = (dependsOn: number[][]) => depending(dependsOn).assignments;
  it.each([
    ["an answer naming one of three Assignments", supplementOf([2]), { affected: [2], assignments: [], decisions: [] }],
    ["an answer adding an Assignment", supplementOf([], plan("meal").assignments), { affected: [], assignments: plan("meal").assignments, decisions: [] }],
    ["an answer bringing the request to the ceiling of ten", supplementOf([], plan("meal", 7).assignments), { affected: [], assignments: plan("meal", 7).assignments, decisions: [] }],
    ["position 0", supplementOf([0]), "leader_plan_invalid"],
    ["a position past the request's Assignments", supplementOf([4]), "leader_plan_invalid"],
    ["a repeated position", supplementOf([1, 1]), "leader_plan_invalid"],
    ["an answer affecting nothing", supplementOf([]), "leader_plan_invalid"],
    ["a new Assignment on another team's preset", supplementOf([], plan("code").assignments), "leader_plan_invalid"],
    ["new Assignments taking the request past the ceiling of ten", supplementOf([], plan("meal", 8).assignments), "leader_plan_invalid",
      "这件事务共有 11 项分工，超过上限 10 项；请合并相近的分工"],
    ["new Assignments depending on an existing one and on an earlier new one", supplementOf([1], newDepending([[2], [1, 4]])),
      { affected: [1], assignments: newDepending([[2], [1, 4]]), decisions: [] }],
    ["a new Assignment depending on its own position", supplementOf([], newDepending([[4]])), "leader_plan_invalid",
      "第 4 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 3）"],
    ["a new Assignment depending on a later new one", supplementOf([], newDepending([[5], []])), "leader_plan_invalid",
      "第 4 项分工的 dependsOn 只能取排在它之前的分工位置（1 到 3）"],
  ])("decodes or refuses a supplement answer: %s", (_case, value, expected, reason?: string) => {
    if (typeof expected === "string") expect(() => parseLeaderSupplement(value, bill, 3)).toThrow(expect.objectContaining({ code: expected, ...(reason ? { reason } : {}) }));
    else expect(parseLeaderSupplement(value, bill, 3)).toEqual(expected);
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
    ["corrects an invalid plan once", [JSON.stringify(plan("code")), JSON.stringify(plan("trip"))], { result: plan("trip") }, 2],
    ["refuses a plan still invalid after one correction", ["{broken", "{broken"], { error: "leader_plan_invalid" }, 2],
    ["has a plan over the ceiling merged in its correction turn", [JSON.stringify(plan("trip", 11)), JSON.stringify(plan("trip", 10))], { result: plan("trip", 10) }, 2],
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

const input = (revision = "r1"): LeaderTurnInput => ({
  requestId: "request-one",
  leader: { id: "bill", name: "Bill", teamName: "生活团队", responsibility: "衣食住行", instructions: "负责人规则" },
  profiles: [{ id: "trip", name: "行程" }, { id: "meal", name: "餐饮" }],
  brief: { message: "帮我规划周末一日行程", summary: "规划周末一日行程" },
  directory: [{ name: "生活团队", responsibility: "衣食住行" }],
  memory: "",
  session: { accountId: "cli_sam", target: "feishu.group.oc_alpha", bindingHash: "binding-alpha", revision, definitionsVersion: 1 },
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
    await expect(leader.plan(input())).resolves.toEqual(plan("meal"));
    expect(external.startOrResume).toHaveBeenCalledWith(undefined, "/isolated/leader", []);
    expect(external.runTurn).toHaveBeenCalledWith("leader-thread", expect.any(String), undefined, undefined, expect.objectContaining({
      model: "fixture-model", effort: "low", outputSchema: expect.objectContaining({ required: ["assignments", "decisions"] }) }));
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
    await expect(leader.plan(input())).resolves.toEqual(plan("trip"));
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
    await expect(leader.supplement(input(), assignments, "改成下午出发")).resolves.toEqual({ affected: [2], assignments: [], decisions: ["只调整行程"] });
    expect(external.runTurn).toHaveBeenCalledTimes(2);
    expect(external.runTurn.mock.calls.map(([threadId, , , , options]) => [threadId, (options as unknown as { outputSchema: { required: string[] } }).outputSchema.required]))
      .toEqual([["leader-thread", ["affected", "assignments", "decisions"]], ["leader-thread", ["affected", "assignments", "decisions"]]]);
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
