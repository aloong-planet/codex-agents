import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LeaderPlan } from "../src/agent-dispatch-leader.js";
import type { DispatchDecision, DispatchExecutionResult, PrerequisiteResult } from "../src/agent-dispatch-types.js";
import type { DispatchTurnRecord } from "../src/fixture-dispatch-recorder.js";
import type { CoordinatorRequestView, LeaderRequestView, PrivateTurnInput } from "../src/private-conversations.js";
import { runningPrograms, stopRunningPrograms, testServerArgs, testServerFiles, writeTools } from "./fixtures/mcp-test-server-control.js";
import type { State } from "./support/real-main.js";
import { atRest, deliveredFiles, groupPosts, realModelDispatch, realModelScenario, type ScenarioRun, type TeamId } from "./support/real-model-dispatch.js";

// Dispatch on the real model (agent-dispatch Testing Decisions: real-model suite). Opt-in: `pnpm test:dispatch-real-model` sets
// DISPATCH_REAL_MODEL_TEST=1; without it every scenario is skipped, so no default run and no CI run reaches a model. One scenario
// reruns alone with `-t`. Messages enter real main through the fixture Feishu ingress and every platform is a fixture; only the
// Coordinator, the Team Leaders and the Executors are real.
//
// Assertions are structural: who decided what, which team leads, what was posted under which identity and in which order, which
// files reached the group. What the model wrote is judged from each scenario's run record, which is written also when the
// scenario fails and keeps each Executor's thread rollouts. A failure here is a finding about the model's decision or the
// product, not a reason to loosen the assertion.
//
// Not covered here:
// - Whether a deliverable's content meets its criterion (missing facts marked, sources named, no claim that tests ran): the
//   reviewed run record.
// - Whether a plan's Brief asks its Executor to send the deliverable to the group: the reviewed run record. The delivered file is
//   asserted, and an Executor can also send it on the original message alone.
// - Decision posts (agent-dispatch::US-003/AC-03): a plan may hold none, so no scenario checks for one and none lists the item.
//   A record shows the decisions a plan held and the posts that carried them; a run without any gives no evidence for the item.
// - A plan that passed only after its correction turn looks like one that passed at once: the correction stays inside the plan turn.
// - The over-ceiling correction turn (agent-dispatch::REQ-011/AC-02), multi-turn controls and cross-team work (ticket 35).
// - Application permissions, ingress and receipt in a real group: live acceptance.
//
// Private conversations (agent-console::US-006): the owner's console messages to Sam and to a request's lead Team Leader, about a
// request their group finished. Asserted: a reply came, what each reply turn was given (Sam never an Assignment, a Brief or an
// Executor's result), and that the conversation created no request and posted nothing. Whether a reply says only what its input
// holds, and answers the question, is judged from the run record.

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

/**
 * A warehouse lookup served by the local MCP test server. Its description says what it is for, which is all a Team Leader is told
 * of it. The answer names a bin and a stock count that are in neither the request nor that description, so they reach an
 * Executor only through a call to the tool.
 */
const STOCK_TOOL = { name: "stock_lookup", description: "查询仓库系统里某个货号的当前库存，返回库存数量和所在仓位。",
  inputSchema: { type: "object", properties: { sku: { type: "string", description: "货号" } }, required: ["sku"] },
  _meta: { "test/answer": "货号 KP5-BLK：库存 37 件，仓位 B-12-04。" } };
const STOCK_BIN = "B-12-04";
type McpTeamsView = { version: number; mcpServers: Array<{ name: string; state: string; launchLine: string }>;
  teams: Array<{ id: string; teamName: string; responsibility: string; leader: unknown; bindings: Array<{ chatId: string }>;
    profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[]; mcpServers: string[] }> }> };

/**
 * A skill for answering a second-hand buyer's bargaining. Its description says what it is for, which is all a Team Leader is told
 * of it. The reference mark is asked for in the body alone, so it reaches an Executor only through the SKILL.md its turns carry.
 */
const BARGAIN_DESCRIPTION = "回复二手交易买家的议价：先确认成色与配件，再给出可接受的价格和理由。";
const BARGAIN_MARK = "BR-7Q2";
const BARGAIN_SKILL = `---
name: bargain-reply
description: ${BARGAIN_DESCRIPTION}
---

# 议价回复

给买家写议价回复时：

1. 先感谢买家，并用一句话确认商品的成色与配件。
2. 给出一个明确的价格，不低于挂牌价的 85%，并说明理由。
3. 回复正文之后单独写一行口径编号：口径 ${BARGAIN_MARK}。交回的结果里必须原样保留这一行。
`;
type TeamsView = { version: number; teams: Array<{ id: string; teamName: string; responsibility: string; leader: unknown; bindings: Array<{ chatId: string }>;
  profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }> }> };

type Turn<Input, Output> = Omit<DispatchTurnRecord, "input" | "output"> & { input: Input; output?: Output };
type ExecutorRun = Turn<{ assignmentId: string; prerequisites: PrerequisiteResult[] }, DispatchExecutionResult>;
const turns = (state: State, turn: DispatchTurnRecord["turn"]) => (state.fixtureDispatchTurns ?? []).filter((item) => item.turn === turn);
// The group's posts and files are read as the run record reads them, so what a scenario asserts is what its record shows.
const posts = groupPosts;
const textsBy = (state: State, identity: "sam" | TeamId) => groupPosts(state).filter((post) => post.identity === identity);

/** The Coordinator's decision on a message, which its turn must have produced without failing. */
function decisionOn(state: State, messageId: string): DispatchDecision {
  const turn = turns(state, "classify").find((item) => item.messageId === messageId);
  expect(turn?.error, "the Coordinator's turn failed, so the host's fallback answered instead of a decision").toBeUndefined();
  expect(turn?.output, "the Coordinator's decision").toBeDefined();
  return turn!.output as DispatchDecision;
}

/**
 * A request in one team's domain, from its message to its closing: the Coordinator routes it to `team`, whose Team Leader's plan
 * passes host validation with one Executor per Assignment and asks for no other team's help, a file reaches the group under that
 * Team Leader's identity only, and its closing follows the last Assignment's end.
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
  // The team's own Executors can save and send, so the plan asks the Coordinator for no other team's part.
  expect(plan!.help, "the plan asks another team for a part of its own team's request").toEqual([]);
  expect(request.assignments.map(({ teamId, profileId, title }) => ({ teamId, profileId, title }))).toEqual(plan!.assignments.map(({ profileId, title }) => ({ teamId: team, profileId, title })));
  expect(new Set(request.assignments.map(({ executor }) => executor)).size).toBe(request.assignments.length);
  expect(request.status).toBe("completed");
  // agent-dispatch::REQ-006: the deliverable reached the originating group as a file, under the team's Team Leader and no other identity.
  const files = deliveredFiles(state);
  expect(files.length).toBeGreaterThanOrEqual(1);
  for (const file of files) expect({ identity: file.identity, chatId: file.chatId }).toEqual({ identity: team, chatId: GROUP });
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

  it.each([
    // Battery condition and the shipping city are left out on purpose: the reviewed package must mark them as missing, not invent them.
    // The platform is left to the team, which invites a decision post; none is required.
    { name: "has Alice's team deliver a listing package for a commerce request", id: "alice-listing-package", team: "alice", deliverable: "agent-dispatch::REQ-006/AC-01", messageId: "om_real_alice",
      text: "帮我给要出手的 Kindle 准备一套上架材料：Kindle Paperwhite 5，8GB，黑色，2023 年 6 月在京东自营购买，屏幕无划痕、边框有轻微使用痕迹，功能正常，" +
        "带原装充电线、没有包装盒，想卖 550 元左右，不包邮。挂闲鱼还是淘宝你们团队定。要标题、描述、成色说明和买家常见问答，整理成一份文档保存好发到群里。" +
        "有些信息我没写全，缺的先标待补充，不用等我确认。" },
    { name: "has Bill's team deliver a one-day itinerary for an everyday-life request", id: "bill-itinerary", team: "bill", deliverable: "agent-dispatch::REQ-006/AC-02", messageId: "om_real_bill",
      text: `帮我规划 ${saturdayAhead()}南京一日游：两个大人，从南京南站出发，喜欢历史古迹和本地小吃，不想太赶，总预算 600 元以内。` +
        "要交通、用餐、预算估算和备选方案，整理成一份行程文档保存好发到群里。" },
  ] as const)("$name", async ({ id, team, deliverable, messageId, text }) => {
    await realModelScenario({ id, acceptance: ["agent-dispatch::US-001/AC-03", deliverable, "agent-dispatch::REQ-011/AC-01", "agent-dispatch::US-003/AC-02"] }, async (run) => {
      await deliversUnderItsTeam(run, messageId, text, team);
    });
  }, REQUEST_LIMIT_MS);

  it("has Jack's team deliver a patch for a TypeScript problem without changing the source", () => realModelScenario(
    { id: "jack-patch", acceptance: ["agent-dispatch::US-001/AC-03", "agent-dispatch::REQ-006/AC-03", "agent-dispatch::REQ-011/AC-01", "agent-dispatch::US-003/AC-02"], files: DISCOUNT_PROJECT }, async (run) => {
      await deliversUnderItsTeam(run, "om_real_jack", "授权目录 demo-vault 里的 discount-project 有个问题：src/discount.ts 的 applyDiscount(price, off) 在 off 大于 price 时返回负数，应该最低为 0。" +
        "复现：applyDiscount(100, 150) 现在得到 -50。请检查相关源码，给出可审阅的补丁（不要直接改源文件）、回归测试用例和说明，保存成文件发到群里，并如实说明验证情况。", "jack");
      // The request asked for a reviewable patch, so the source the Executor inspected is as the case wrote it.
      expect(readFileSync(join(run.grantedDirectory, "discount-project", "src", "discount.ts"), "utf8")).toBe(DISCOUNT_SOURCE);
    }), REQUEST_LIMIT_MS);

  // What an attached MCP server gives a profile's Executors. The Team Leader is told, for the preset that attaches the server,
  // what the server's tools do, and puts work that needs them on that preset without asking another team
  // (agent-dispatch::REQ-011/AC-01). The Executor created from it is offered the server's proxy tools and calls one
  // (agent-dispatch::REQ-016/AC-03, mcp-catalog::REQ-003/AC-02): the bin its result names is only in the tool's answer. The run also
  // shows whether the model's provider takes the namespace the tools are offered under.
  it("has a Team Leader put work an attached MCP server is for on the preset that attaches it, and its Executor call the server", async () => {
    // The server's files are outside the granted directory; the service starts the program and stops it when it stops.
    const servers = mkdtempSync(join(tmpdir(), "real-model-mcp-"));
    try {
      await realModelScenario({ id: "attached-mcp-server", acceptance: ["agent-dispatch::REQ-011/AC-01", "agent-dispatch::REQ-016/AC-03", "mcp-catalog::REQ-003/AC-02"] }, async (run) => {
        const files = testServerFiles(servers, "warehouse");
        writeTools(files.tools, [STOCK_TOOL]);
        const server = { name: "warehouse", command: process.execPath, args: testServerArgs(files) };
        const { launchLine } = await run.post<{ launchLine: string }>("/api/mcp/preview", { server });
        await run.post("/api/mcp/servers", { server, confirmed: launchLine });
        let view = await run.get<McpTeamsView>("/api/teams");
        for (const until = Date.now() + 15_000; view.mcpServers[0]?.state !== "connected" && Date.now() < until;) view = await run.get<McpTeamsView>("/api/teams");
        expect(view.mcpServers).toMatchObject([{ name: "warehouse", state: "connected" }]);
        // Alice's team gets a second preset, which attaches the server and has no host tool; her seeded preset attaches none. Its
        // responsibility says what the team now also does, as the owner writes it: the Coordinator routes by the responsibility
        // alone and is told nothing of any preset or server.
        const alice = view.teams.find(({ id }) => id === "alice")!;
        const saved = await run.post<{ view: McpTeamsView }>("/api/teams/save", { basedOn: view.version, team: { id: "alice", teamName: alice.teamName,
          responsibility: `${alice.responsibility}另外负责查询仓库里商品的库存和仓位。`,
          leader: alice.leader, groups: alice.bindings.map(({ chatId }) => chatId), executorProfiles: [
            ...alice.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools, mcpServers: [] })),
            { name: "仓库查询", noun: "仓库执行者", instructions: "", hostTools: [], mcpServers: [{ name: "warehouse", confirmed: launchLine }] }] } });
        const attaching = saved.view.teams.find(({ id }) => id === "alice")!.profiles.find(({ name }) => name === "仓库查询")!.id;

        await run.send("om_real_mcp", "闲鱼上有买家要拍那台黑色 Kindle，帮我查一下货号 KP5-BLK 仓库里现在还有多少库存、放在哪个仓位，直接在群里回我就行，不用存成文件。");
        const state = await run.until("the request's end", (current) => atRest(current, "om_real_mcp"), REQUEST_WAIT_MS);
        expect(decisionOn(state, "om_real_mcp")).toMatchObject({ kind: "dispatch", agentId: "alice" });
        expect(state.agentDispatch?.jobs).toHaveLength(1);
        const request = state.agentDispatch!.jobs[0]!;
        // The Team Leader was told what the server gives that preset's Executors, and nothing of the tool's answer.
        const plan = turns(state, "plan").find((item) => item.teamId === "alice") as Turn<{ profiles: Array<{ id: string; capabilities: string[] }> }, LeaderPlan> | undefined;
        expect(plan?.output, "the Team Leader's plan").toBeDefined();
        expect(plan!.input.profiles.find(({ id }) => id === attaching)?.capabilities.find((capability) => capability.startsWith("通过 MCP 服务器「warehouse」：")))
          .toContain(`stock_lookup（${STOCK_TOOL.description}）`);
        expect(plan!.input.profiles.filter(({ id }) => id !== attaching).flatMap(({ capabilities }) => capabilities).join("\n")).not.toContain("MCP 服务器");
        expect(JSON.stringify(plan!.input)).not.toContain(STOCK_BIN);
        // It put the lookup on that preset and asked no other team for it.
        expect(plan!.output!.help, "the plan asks another team for what its own preset's server gives").toEqual([]);
        const chosen = request.assignments.filter(({ profileId }) => profileId === attaching);
        expect(chosen.length, "no Assignment was put on the preset that attaches the server").toBeGreaterThanOrEqual(1);
        // That preset's Executor called the server: its result names the bin that only the tool's answer holds.
        const runs = turns(state, "run") as ExecutorRun[];
        const results = chosen.map((assignment) => runs.find(({ input }) => input.assignmentId === assignment.id)?.output);
        expect(results.map((result) => result?.status)).toEqual(chosen.map(() => "completed"));
        expect(results.some((result) => result!.message.includes(STOCK_BIN)), "no result of that preset's Executors names the bin from the tool's answer").toBe(true);
        expect(request.status).toBe("completed");
        // The closing, under Alice's identity, carries the answer to the group.
        expect(textsBy(state, "alice").at(-1)?.message).toContain(STOCK_BIN);
      });
      expect(runningPrograms(servers)).toEqual([]);
    } finally { stopRunningPrograms(servers); rmSync(servers, { recursive: true, force: true }); }
  }, REQUEST_LIMIT_MS);

  // What a profile's skill gives its Executors. The Team Leader is told the skill of a preset by name and description, and puts
  // work the skill is for on that preset (agent-dispatch::REQ-011/AC-01). The Executor created from it works by the skill's
  // SKILL.md, which only its own turns carry (agent-dispatch::REQ-016/AC-04, skill-library::REQ-002): the mark its result must
  // show is in neither the request nor anything its Team Leader was told.
  it("has a Team Leader put the work a skill is for on the preset that selects it, and its Executor work by that skill", () => realModelScenario(
    { id: "profile-skill", acceptance: ["agent-dispatch::REQ-011/AC-01", "agent-dispatch::REQ-016/AC-04", "skill-library::REQ-002"] }, async (run) => {
      // The skill's folder is outside the granted directory: no file tool of an Executor can read it there.
      const sources = mkdtempSync(join(tmpdir(), "real-model-skill-"));
      try {
        const source = join(sources, "bargain-reply");
        mkdirSync(source);
        writeFileSync(join(source, "SKILL.md"), BARGAIN_SKILL);
        const { preview } = await run.post<{ preview: { fingerprint: string } }>("/api/skills/read", { folder: source });
        const { id: skill } = await run.post<{ id: string }>("/api/skills/import", { folder: source, confirmed: preview.fingerprint });
        // Alice's team gets a second preset, which selects the skill; her seeded preset selects none.
        const view = await run.get<TeamsView>("/api/teams");
        const alice = view.teams.find(({ id }) => id === "alice")!;
        const saved = await run.post<{ view: TeamsView }>("/api/teams/save", { basedOn: view.version, team: { id: "alice", teamName: alice.teamName, responsibility: alice.responsibility,
          leader: alice.leader, groups: alice.bindings.map(({ chatId }) => chatId), executorProfiles: [
            ...alice.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools, skills: [] })),
            { name: "议价回复", noun: "议价执行者", instructions: "", hostTools: [], skills: [skill] }] } });
        const skilled = saved.view.teams.find(({ id }) => id === "alice")!.profiles.find(({ name }) => name === "议价回复")!.id;

        await run.send("om_real_skill", "闲鱼上有个买家问那台 Kindle 400 能不能出，我挂的是 550。帮我拟一条回复买家的议价话术，直接在群里回我就行，不用存成文件。");
        const state = await run.until("the request's end", (current) => atRest(current, "om_real_skill"), REQUEST_WAIT_MS);
        expect(decisionOn(state, "om_real_skill")).toMatchObject({ kind: "dispatch", agentId: "alice" });
        expect(state.agentDispatch?.jobs).toHaveLength(1);
        const request = state.agentDispatch!.jobs[0]!;
        // The Team Leader was told the preset's skill, by its name and what its SKILL.md says it is for, and nothing of its body.
        const plan = turns(state, "plan").find((item) => item.teamId === "alice") as Turn<{ profiles: Array<{ id: string; capabilities: string[] }> }, LeaderPlan> | undefined;
        expect(plan?.output, "the Team Leader's plan").toBeDefined();
        expect(plan!.input.profiles.find(({ id }) => id === skilled)?.capabilities).toContain(`技能「bargain-reply」：${BARGAIN_DESCRIPTION}`);
        expect(JSON.stringify(plan!.input)).not.toContain(BARGAIN_MARK);
        // It put the bargaining reply on that preset.
        const chosen = request.assignments.filter(({ profileId }) => profileId === skilled);
        expect(chosen.length, "no Assignment was put on the preset that selects the skill").toBeGreaterThanOrEqual(1);
        // That preset's Executor worked by the SKILL.md: its result carries the mark only the SKILL.md asks for.
        const runs = turns(state, "run") as ExecutorRun[];
        for (const assignment of chosen) {
          const own = runs.find(({ input }) => input.assignmentId === assignment.id);
          expect(own?.output?.status).toBe("completed");
          expect(own!.output!.message, "the Executor's result lacks the mark its skill asks for").toContain(BARGAIN_MARK);
        }
        // An Executor of the preset without the skill, if the plan made one, was not given it.
        for (const assignment of request.assignments.filter(({ profileId }) => profileId !== skilled)) {
          expect(runs.find(({ input }) => input.assignmentId === assignment.id)?.output?.message ?? "").not.toContain(BARGAIN_MARK);
        }
        expect(request.status).toBe("completed");
      } finally { rmSync(sources, { recursive: true, force: true }); }
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

describe.skipIf(!realModelDispatch)("private conversations on the real model", () => {
  const PRIVATE_WAIT_MS = 180_000;
  /** A request Alice's team finished in the group, for a private conversation to discuss: its ID and the state at its end. */
  async function finishedRequest(run: ScenarioRun, messageId: string): Promise<{ requestId: string; state: State }> {
    await run.send(messageId, "帮我写一句闲鱼上架二手 iPad 的标题，不超过 30 个字，直接在群里告诉我就行，不用做成文件。");
    const state = await run.until("the request's end", (current) => atRest(current, messageId), REQUEST_WAIT_MS);
    expect(decisionOn(state, messageId)).toMatchObject({ kind: "dispatch", agentId: "alice" });
    expect(state.agentDispatch?.jobs).toHaveLength(1);
    expect(state.agentDispatch!.jobs[0]).toMatchObject({ agentId: "alice", status: "completed" });
    return { requestId: state.agentDispatch!.jobs[0]!.id, state };
  }
  /** The private reply turn the conversation with `agentId` ran last, which must have produced a reply without failing. */
  function privateTurn(state: State, agentId: string): PrivateTurnInput {
    const turn = turns(state, "private").filter((item) => (item.input as PrivateTurnInput).agent.id === agentId).at(-1);
    expect(turn?.error, "the private reply turn failed").toBeUndefined();
    expect(turn?.output, "the private reply turn's output").toBeDefined();
    return turn!.input as PrivateTurnInput;
  }
  /** The conversation's reply came and nothing of it reached the group: no request was created and no post was sent. */
  async function answeredPrivately(run: ScenarioRun, before: State, chat: Awaited<ReturnType<ScenarioRun["converse"]>>): Promise<State> {
    expect(chat.messages.map(({ role, state }) => [role, state])).toEqual([["owner", "answered"], ["agent", undefined]]);
    expect(chat.messages[1]!.text.trim().length).toBeGreaterThan(0);
    const after = await run.state();
    expect(after.agentDispatch?.jobs).toHaveLength(before.agentDispatch!.jobs.length);
    expect(posts(after)).toEqual(posts(before));
    return after;
  }

  it("has Sam answer the owner privately about a finished request from its state, teams and reports, never an Executor's content", () => realModelScenario(
    { id: "private-coordinator", acceptance: ["agent-console::US-006/AC-01", "agent-console::REQ-002/AC-03", "agent-console::CON-002"] }, async (run) => {
      const { requestId, state: before } = await finishedRequest(run, "om_real_private_sam");
      const chat = await run.converse("sam", "刚才那件 iPad 标题的事办完了吗？是哪个团队做的？", requestId, PRIVATE_WAIT_MS);
      const after = await answeredPrivately(run, before, chat);
      const input = privateTurn(after, "sam");
      expect(input.selected).not.toBeNull();
      const shown = input.requests.find(({ id }) => id === input.selected) as CoordinatorRequestView | undefined;
      expect(shown).toMatchObject({ state: "completed", lead: "Alice" });
      expect(shown!.reports.length).toBeGreaterThanOrEqual(1);
      // Sam reads what was posted, never an Assignment, the Brief its Executor got or the Executor's own result.
      const given = JSON.stringify(input);
      expect(given).not.toContain("\"assignments\"");
      const plan = (turns(after, "plan")[0] as Turn<unknown, LeaderPlan> | undefined)?.output;
      for (const { brief } of plan!.assignments) expect(given).not.toContain(brief.slice(0, 40));
      for (const executorRun of turns(after, "run") as ExecutorRun[]) {
        const posted = posts(after).some(({ message }) => message.includes(executorRun.output!.message.slice(0, 40)));
        // An Executor's result may reach Sam only as far as its Team Leader posted it in the group.
        if (!posted) expect(given).not.toContain(executorRun.output!.message.slice(0, 40));
      }
    }), REQUEST_LIMIT_MS + 240_000);

  it("has the lead Team Leader answer the owner privately about its finished request from its own Executor's result", () => realModelScenario(
    { id: "private-lead", acceptance: ["agent-console::US-006/AC-01", "agent-console::CON-002"] }, async (run) => {
      const { requestId, state: before } = await finishedRequest(run, "om_real_private_lead");
      const chat = await run.converse("alice", "你们最后写的标题是什么？我想再看一眼原文。", requestId, PRIVATE_WAIT_MS);
      const after = await answeredPrivately(run, before, chat);
      const input = privateTurn(after, "alice");
      const shown = input.requests.find(({ id }) => id === input.selected) as LeaderRequestView | undefined;
      expect(shown, "the selected request is in Alice's input").toBeDefined();
      const results = (turns(after, "run") as ExecutorRun[]).map(({ output }) => output!.message);
      expect(shown!.assignments.map(({ result }) => result.slice(0, 40))).toEqual(results.map((result) => result.slice(0, 40)));
    }), REQUEST_LIMIT_MS + 240_000);
});
