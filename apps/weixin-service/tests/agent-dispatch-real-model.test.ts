import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LeaderPlan } from "../src/agent-dispatch-leader.js";
import type { DispatchDecision, DispatchExecutionResult, PrerequisiteResult } from "../src/agent-dispatch-types.js";
import type { DispatchTurnRecord } from "../src/fixture-dispatch-recorder.js";
import type { State } from "./support/real-main.js";
import { atRest, realModelDispatch, realModelScenario, type ScenarioRun, type TeamId } from "./support/real-model-dispatch.js";

// Dispatch on the real model (agent-dispatch Testing Decisions: real-model suite). Opt-in: `pnpm test:dispatch-real-model` sets
// DISPATCH_REAL_MODEL_TEST=1; without it every scenario is skipped, so no default run and no CI run reaches a model. One scenario
// reruns alone with `-t`. Messages enter real main through the fixture Feishu ingress and every platform is a fixture; only the
// Coordinator, the Team Leaders and the Executors are real.
//
// Assertions are structural: who decided what, which team leads, what was posted under which identity and in which order, which
// files reached the group. What the model wrote is judged from each scenario's run record, which is written also when the
// scenario fails. A failure here is a finding about the model's decision or the product, not a reason to loosen the assertion.
//
// Not covered here:
// - Whether a deliverable's content meets its criterion (missing facts marked, sources named, no claim that tests ran): the
//   reviewed run record.
// - Decision posts (agent-dispatch::US-003/AC-03): a plan may hold none, so no scenario requires one; the record shows those posted.
// - A plan that passed only after its correction turn looks like one that passed at once: the correction stays inside the plan turn.
// - The over-ceiling correction turn (agent-dispatch::REQ-011/AC-02), multi-turn controls and cross-team work (ticket 35).
// - Application permissions, ingress and receipt in a real group: live acceptance.

const DECISION_WAIT_MS = 180_000, DECISION_LIMIT_MS = 240_000;
const REQUEST_WAIT_MS = 1_200_000, REQUEST_LIMIT_MS = 1_320_000;
const GROUP = "oc_alpha";
/** Every seeded team presets this one Executor profile (team-registry's seeded definitions). */
const PRESETS = ["executor-1"];
const ENDED = ["completed", "failed", "cancelled", "interrupted", "blocked"];

const DISCOUNT_SOURCE = `/** Returns the price after taking \`off\` away. */
export function applyDiscount(price: number, off: number): number {
  return price - off;
}

/** Returns the price after a percentage discount, rounded to cents. */
export function applyPercentage(price: number, percent: number): number {
  return Math.round(price * (100 - percent)) / 100;
}
`;
/** A small TypeScript project in the granted directory, with the reproducible problem of Jack's scenario in src/discount.ts. */
const DISCOUNT_PROJECT = {
  "discount-project/package.json": `${JSON.stringify({ name: "discount-project", private: true, type: "module", scripts: { test: "node --test" }, devDependencies: { typescript: "^5.8.0" } }, null, 2)}\n`,
  "discount-project/tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist" }, include: ["src", "test"] }, null, 2)}\n`,
  "discount-project/src/discount.ts": DISCOUNT_SOURCE,
  "discount-project/src/cart.ts": `import { applyDiscount } from "./discount.js";

export type CartItem = { name: string; price: number; quantity: number };

/** The cart's total after a coupon worth \`coupon\`. */
export function cartTotal(items: CartItem[], coupon = 0): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return applyDiscount(subtotal, coupon);
}
`,
  "discount-project/test/discount.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount } from "../src/discount.js";

test("takes the discount off the price", () => { assert.equal(applyDiscount(100, 30), 70); });
`,
};

type Turn<Input, Output> = Omit<DispatchTurnRecord, "input" | "output"> & { input: Input; output?: Output };
type ExecutorRun = Turn<{ assignmentId: string; prerequisites: PrerequisiteResult[] }, DispatchExecutionResult>;
type Text = { chatId: string; message: string; acceptedAt: number };
const turns = (state: State, turn: DispatchTurnRecord["turn"]) => (state.fixtureDispatchTurns ?? []).filter((item) => item.turn === turn);
const textsBy = (state: State, identity: "sam" | TeamId) => (identity === "sam" ? state.feishuFixtureTextOutbox ?? [] : state.agentFixtureOutboxes?.[identity]?.text ?? []) as Text[];
/** Every post the group received, in the order received, with the identity that sent it. */
const posts = (state: State) => (["sam", "alice", "bill", "jack"] as const).flatMap((identity) => textsBy(state, identity).map((post) => ({ identity, ...post })))
  .sort((left, right) => left.acceptedAt - right.acceptedAt);
const filesBy = (state: State, identity: TeamId) => (state.agentFixtureOutboxes?.[identity]?.media ?? []) as Array<{ chatId: string; fileName: string }>;

/** The Coordinator's decision on a message, which its turn must have produced without failing. */
function decisionOn(state: State, messageId: string): DispatchDecision {
  const turn = turns(state, "classify").find((item) => item.messageId === messageId);
  expect(turn?.error, "the Coordinator's turn failed, so the host's fallback answered instead of a decision").toBeUndefined();
  expect(turn?.output, "the Coordinator's decision").toBeDefined();
  return turn!.output as DispatchDecision;
}

/**
 * A request in one team's domain, from its message to its closing: the Coordinator routes it to `team`, whose Team Leader's plan
 * passes host validation with one Executor per Assignment, a file reaches the group under that Team Leader's identity only, and
 * its closing follows the last Assignment's end.
 */
async function deliversUnderItsTeam(run: ScenarioRun, messageId: string, text: string, team: TeamId): Promise<State> {
  await run.send(messageId, text);
  const state = await run.until("the request's end", (current) => atRest(current, messageId), REQUEST_WAIT_MS);
  expect(decisionOn(state, messageId)).toMatchObject({ kind: "dispatch", agentId: team });
  expect(state.agentDispatch?.jobs).toHaveLength(1);
  const request = state.agentDispatch!.jobs[0]!;
  expect(request).toMatchObject({ agentId: team, requester: "ou_owner" });
  // agent-dispatch::REQ-011/AC-01: the plan the host accepted, every Assignment on a preset of the team, one Executor each.
  const plan = (turns(state, "plan").find((item) => item.teamId === team) as Turn<unknown, LeaderPlan> | undefined)?.output;
  expect(plan, "the Team Leader's plan").toBeDefined();
  expect(plan!.assignments.length).toBeGreaterThanOrEqual(1);
  for (const assignment of plan!.assignments) expect(PRESETS).toContain(assignment.profileId);
  expect(request.assignments.map(({ teamId, profileId, title }) => ({ teamId, profileId, title }))).toEqual(plan!.assignments.map(({ profileId, title }) => ({ teamId: team, profileId, title })));
  expect(new Set(request.assignments.map(({ executor }) => executor)).size).toBe(request.assignments.length);
  expect(request.status).toBe("completed");
  // agent-dispatch::REQ-006: the deliverable reached the originating group as a file, under the team's Team Leader and no other identity.
  expect(filesBy(state, team).length).toBeGreaterThanOrEqual(1);
  for (const file of filesBy(state, team)) expect(file.chatId).toBe(GROUP);
  for (const other of (["alice", "bill", "jack"] as const).filter((id) => id !== team)) expect(filesBy(state, other)).toEqual([]);
  expect(state.feishuFixtureMediaOutbox).toEqual([]);
  // agent-dispatch::US-003/AC-02: the closing is the group's last post, under the lead's identity, after the last Assignment ended.
  expect(state.agentDispatch!.notices).toContainEqual({ id: `${request.id}:closing:0`, state: "accepted" });
  const runs = turns(state, "run");
  expect(runs).toHaveLength(request.assignments.length);
  const closing = posts(state).at(-1)!;
  expect(closing.identity).toBe(team);
  expect(closing.acceptedAt).toBeGreaterThanOrEqual(Math.max(...runs.map(({ endedAt }) => endedAt!)));
  return state;
}

/** The Saturday at least a week ahead, as a group member would write it. */
function saturdayAhead(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + 7);
  while (date.getDay() !== 6) date.setDate(date.getDate() + 1);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日（周六）`;
}

describe.skipIf(!realModelDispatch)("dispatch on the real model", () => {
  it("creates no request and posts nothing for ordinary chat", () => realModelScenario({ id: "ignore", acceptance: ["agent-dispatch::US-001/AC-02"] }, async (run) => {
    await run.send("om_real_ignore", "今天中午食堂的红烧肉不错，就是排队排了快二十分钟。");
    const state = await run.until("the Coordinator's decision", (current) => atRest(current, "om_real_ignore"), DECISION_WAIT_MS);
    expect(decisionOn(state, "om_real_ignore").kind).toBe("ignore");
    expect(state.agentDispatch?.jobs).toEqual([]);
    expect(posts(state)).toEqual([]);
    expect((state.fixtureDispatchTurns ?? []).map(({ turn }) => turn)).toEqual(["classify"]);
  }), DECISION_LIMIT_MS);

  it("proposes work implied by a discussion to its author and dispatches nothing before the author confirms", () => realModelScenario(
    { id: "propose", acceptance: ["agent-dispatch::US-001/AC-04", "agent-dispatch::US-001/AC-06"] }, async (run) => {
      await run.send("om_real_propose", "唉，闲鱼上那台旧相机挂了两周都没人问，估计是标题和描述写得不行。");
      const state = await run.until("the Coordinator's proposal", (current) => atRest(current, "om_real_propose"), DECISION_WAIT_MS);
      expect(decisionOn(state, "om_real_propose")).toMatchObject({ kind: "propose", agentId: "alice" });
      expect(state.agentDispatch?.jobs).toEqual([expect.objectContaining({ agentId: "alice", status: "proposed", requester: "ou_owner", assignments: [] })]);
      // The proposal is the Coordinator's own post; no Team Leader or Executor has had a turn.
      expect(posts(state).map(({ identity, chatId }) => ({ identity, chatId }))).toEqual([{ identity: "sam", chatId: GROUP }]);
      expect((state.fixtureDispatchTurns ?? []).map(({ turn }) => turn)).toEqual(["classify"]);
    }), DECISION_LIMIT_MS);

  it("clarifies a request no team clearly owns and creates no Assignment", () => realModelScenario({ id: "clarify", acceptance: ["agent-dispatch::REQ-001"] }, async (run) => {
    await run.send("om_real_clarify", "那件事帮我跟进一下，今天之内要有个结果。");
    const state = await run.until("the Coordinator's clarification", (current) => atRest(current, "om_real_clarify"), DECISION_WAIT_MS);
    expect(decisionOn(state, "om_real_clarify").kind).toBe("clarify");
    expect(state.agentDispatch?.jobs).toEqual([]);
    expect(posts(state).map(({ identity, chatId }) => ({ identity, chatId }))).toEqual([{ identity: "sam", chatId: GROUP }]);
    expect((state.fixtureDispatchTurns ?? []).map(({ turn }) => turn)).toEqual(["classify"]);
  }), DECISION_LIMIT_MS);

  // The case ends once the reassignment is observed, which stops the service, so Bill's team does not produce the itinerary.
  it("has a mentioned Team Leader explain a request outside its role, and gives the request to the responsible team", () => realModelScenario(
    { id: "out-of-role-mention", acceptance: ["agent-dispatch::REQ-004"] }, async (run) => {
      await run.send("om_real_mention", "帮我规划这周六杭州一日游，两个人，预算 600 元。", { mention: "jack" });
      const state = await run.until("the reassigned request", (current) => (current.agentDispatch?.jobs.length ?? 0) > 0 || atRest(current, "om_real_mention"), DECISION_WAIT_MS);
      expect(decisionOn(state, "om_real_mention")).toMatchObject({ kind: "dispatch", agentId: "bill" });
      expect(state.agentDispatch?.jobs).toEqual([expect.objectContaining({ agentId: "bill", requester: "ou_owner" })]);
      // Jack's explanation comes first, under Jack's identity, then the Coordinator's reassignment notice.
      expect(posts(state).slice(0, 2).map(({ identity, chatId }) => ({ identity, chatId }))).toEqual([{ identity: "jack", chatId: GROUP }, { identity: "sam", chatId: GROUP }]);
      expect(textsBy(state, "jack")).toHaveLength(1);
      expect(textsBy(state, "sam").map(({ message }) => message)).toEqual(["已将这项需求转派给 Bill。"]);
    }), DECISION_LIMIT_MS);

  it("has Alice's team deliver a listing package for a commerce request", () => realModelScenario(
    { id: "alice-listing-package", acceptance: ["agent-dispatch::US-001/AC-03", "agent-dispatch::REQ-006/AC-01", "agent-dispatch::REQ-011/AC-01", "agent-dispatch::US-003/AC-02", "agent-dispatch::US-003/AC-03"] },
    async (run) => {
      // Battery condition and the shipping city are left out on purpose: the reviewed package must mark them as missing, not invent them.
      await deliversUnderItsTeam(run, "om_real_alice", "帮我给要出手的 Kindle 准备一套上架材料：Kindle Paperwhite 5，8GB，黑色，2023 年 6 月在京东自营购买，屏幕无划痕、边框有轻微使用痕迹，功能正常，" +
        "带原装充电线、没有包装盒，想卖 550 元左右，不包邮。挂闲鱼还是淘宝你们团队定。要标题、描述、成色说明和买家常见问答，整理成一份文档保存好发到群里。" +
        "有些信息我没写全，缺的先标待补充，不用等我确认。", "alice");
    }), REQUEST_LIMIT_MS);

  it("has Bill's team deliver a one-day itinerary for an everyday-life request", () => realModelScenario(
    { id: "bill-itinerary", acceptance: ["agent-dispatch::US-001/AC-03", "agent-dispatch::REQ-006/AC-02", "agent-dispatch::REQ-011/AC-01", "agent-dispatch::US-003/AC-02"] }, async (run) => {
      await deliversUnderItsTeam(run, "om_real_bill", `帮我规划 ${saturdayAhead()}南京一日游：两个大人，从南京南站出发，喜欢历史古迹和本地小吃，不想太赶，总预算 600 元以内。` +
        "要交通、用餐、预算估算和备选方案，整理成一份行程文档保存好发到群里。", "bill");
    }), REQUEST_LIMIT_MS);

  it("has Jack's team deliver a patch for a TypeScript problem without changing the source", () => realModelScenario(
    { id: "jack-patch", acceptance: ["agent-dispatch::US-001/AC-03", "agent-dispatch::REQ-006/AC-03", "agent-dispatch::REQ-011/AC-01", "agent-dispatch::US-003/AC-02"], files: DISCOUNT_PROJECT }, async (run) => {
      await deliversUnderItsTeam(run, "om_real_jack", "授权目录 demo-vault 里的 discount-project 有个问题：src/discount.ts 的 applyDiscount(price, off) 在 off 大于 price 时返回负数，应该最低为 0。" +
        "复现：applyDiscount(100, 150) 现在得到 -50。请检查相关源码，给出可审阅的补丁（不要直接改源文件）、回归测试用例和说明，保存成文件发到群里，并如实说明验证情况。", "jack");
      // The request asked for a reviewable patch, so the source the Executor inspected is as the case wrote it.
      expect(readFileSync(join(run.grantedDirectory, "discount-project", "src", "discount.ts"), "utf8")).toBe(DISCOUNT_SOURCE);
    }), REQUEST_LIMIT_MS);

  it("starts an Assignment that depends on another after it, with that Assignment's result", () => realModelScenario(
    { id: "dependency", acceptance: ["agent-dispatch::REQ-011/AC-05"], files: DISCOUNT_PROJECT }, async (run) => {
      await run.send("om_real_dependency", "授权目录 demo-vault 的 discount-project 里，先梳理 src 下每个源文件导出了哪些函数、各自做什么；再根据梳理结果写一份模块说明文档草稿。" +
        "两步分开做，文档必须基于第一步的梳理结果。");
      const state = await run.until("the request's end", (current) => atRest(current, "om_real_dependency"), REQUEST_WAIT_MS);
      expect(decisionOn(state, "om_real_dependency").kind).toBe("dispatch");
      expect(state.agentDispatch?.jobs).toHaveLength(1);
      const { assignments } = state.agentDispatch!.jobs[0]!;
      const dependents = assignments.filter(({ dependsOn }) => dependsOn.length > 0);
      expect(dependents.length, "the plan marks no Assignment as depending on another").toBeGreaterThanOrEqual(1);
      const runs = turns(state, "run") as ExecutorRun[];
      const runOf = (assignmentId: string) => runs.find(({ input }) => input.assignmentId === assignmentId);
      for (const dependent of dependents) {
        const own = runOf(dependent.id);
        expect(own, `the dependent Assignment「${dependent.title}」never started`).toBeDefined();
        expect(own!.input.prerequisites).toHaveLength(dependent.dependsOn.length);
        for (const prerequisiteId of dependent.dependsOn) {
          const earlier = runOf(prerequisiteId);
          expect(earlier?.output?.status).toBe("completed");
          // It started after its prerequisite ended, and was given that prerequisite's final result (cut to 4,000 characters at most).
          expect(own!.startedAt).toBeGreaterThanOrEqual(earlier!.endedAt!);
          expect(own!.input.prerequisites.map(({ result }) => result.slice(0, 200))).toContain(earlier!.output!.message.slice(0, 200));
        }
      }
      for (const assignment of assignments) expect(ENDED).toContain(assignment.status);
    }), REQUEST_LIMIT_MS);
});
