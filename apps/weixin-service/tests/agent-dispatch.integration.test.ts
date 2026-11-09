import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CodexDispatchExecutor, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { TeamRegistry } from "../src/team-registry.js";
import { conversation } from "./support/dispatch-runtime.js";
import { PRODUCTION_TOOL_IDS } from "./support/production-tools.js";
import { processWaitLimitMs } from "./support/process-wait.js";
import { dispatchConfig, groupMessage, start } from "./support/real-main.js";
import { seedMemory } from "./support/memory.js";
import { memoryAccountId } from "../src/agent-profile.js";
import { homeListing, keptListing, seedExecutorHome } from "./support/runtime-home.js";
import { LocalFileOperationStore } from "../src/local-file-operation-store.js";

// Real main composition through the fixture-only Feishu ingress; the model and every Feishu application are fixtures.
// Registry versions are saved through TeamRegistry, the store's own public class. Fixture mode injects already-decoded Coordinator
// decisions and Team Leader plans (agent-dispatch Testing Decisions); main still passes them through the production correction loop,
// validation and effects. The Coordinator's and Team Leaders' real runtime construction is driven by the case that sets
// WORKFLOW_FIXTURE_COORDINATION_RUNTIME, where the fixture App Server answers their turns with the same injected outputs.
// Gaps:
// - A live run is still needed for real model semantics and for the default Team Leader runtimes outside that seam.
// - The upgrade case covers the stored states the pre-05 fixture mode can produce. A state reached only in production, such as
//   an old request whose team was later removed from the local configuration, keeps the existing authorization fencing,
//   which channel-startup's "fails closed for an unavailable assignee" cases drive; no case here builds it.
// - Memory recall queries (a Team Leader's Brief text, an Executor's title and Brief) only rank memories in a large store with a
//   search index. Fixture mode has no index and the seeded memories are small, so no case tells queries apart; a live run does.
// - Outside fixture mode the dispatch curator commits through a memory tool host with no notification route and no reminder
//   ownership, so a planned event in a Team Leader's or Executor's memory creates no reminder. Fixture mode replaces both
//   curators with recorders, so only code review and a live run cover that tool host.
// - Whether a real Team Leader divides work sensibly, and which Assignments it marks affected by a supplement, needs a live run;
//   the fixture injects both.
// - Main records an Executor's memory capture with its Assignment's frozen sender. Fixture mode's curators record only the account
//   and the turns, so no case observes that sender. Retest condition: a fixture curator that records each turn's source sender.
// - Whether the real Coordinator places a cross-team part with a sensible team needs a live run; the fixture injects its decision.
//   Under WORKFLOW_FIXTURE_COORDINATION_RUNTIME the fixture App Server answers the Coordinator's cross-team turn too; no case drives
//   that seam's answer, which is fixture-only code.

it("keeps travel rules in Bill's turn and the code-and-tests example in Jack's, with the shared rules in every turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-profile-text-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const commands = [["alice", "om_profile_alice", "帮我整理闲鱼商品描述"], ["bill", "om_profile_bill", "请帮我规划周末一日行程"],
    ["jack", "om_profile_jack", "请给出 discount 的补丁和测试用例，不要运行"]] as const;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    for (const [team, messageId, text] of commands) {
      await running.post("/api/fixture/inbound", groupMessage(messageId, text, { kind: "dispatch", agentId: team, requestId: null, summary: text, message: "" }));
      await running.until((state) => state.agentFixtureOutboxes?.[team]?.text.length === 2);
    }
    const result = await running.state();
    console.log(JSON.stringify({ kind: "dispatch_profile_text", commands: commands.map(([, , text]) => text), jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    const inputs = result.fixtureModelRequests!.map(({ input }) => JSON.stringify(input));
    const [alice, bill, jack] = ["Alice", "Bill", "Jack"].map((name) => inputs.filter((input) => input.includes(`你是 ${name} 团队的执行者`)));
    expect([alice!.length, bill!.length, jack!.length]).toEqual([1, 1, 1]);
    for (const input of [alice![0]!, bill![0]!, jack![0]!]) {
      expect(input).toContain("交付文件前复核其事实与来源是否相符");
      expect(input).toContain("results 只列用户本轮实际要求完成的目标");
    }
    // One fragment from each Bill-only rule group: weather, route, walking, opening hours, budget and schedule.
    for (const fragment of ["天气等持续更新的信息", "出行路线", "步行入口", "开放时间、预约要求", "预算和时间安排"]) {
      expect(alice![0]).not.toContain(fragment);
      expect(bill![0]).toContain(fragment);
    }
    // The code-and-tests example of the goal-scope rule reaches only Jack's team's Executor.
    expect(jack![0]).toContain("交付代码和用例即可分别记 completed");
    for (const input of [alice![0]!, bill![0]!]) expect(input).not.toContain("交付代码和用例即可分别记 completed");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("refuses a tool outside the Executor profile while allowed tools still run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-profile-tools-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-profile-tools-files-"));
  mkdirSync(join(business, "demo-vault", ".obsidian"), { recursive: true }); writeFileSync(join(business, "demo-vault", "sample.txt"), "x\n");
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory, true);
    const local = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"))).entries.find((entry) => entry.channel === "feishu")?.dispatch;
    if (!local) throw new Error("expected_dispatch_configuration");
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(local, { executorHostTools: PRODUCTION_TOOL_IDS });
      registry.save({ ...seeded.definitions, teams: seeded.definitions.teams.map((team) => team.id === "jack" ? { ...team,
        executorProfiles: team.executorProfiles.map((profile) => ({ ...profile, hostTools: profile.hostTools.filter((id) => id !== "files.edit") })) } : team) },
      { basedOn: seeded.version });
    } finally { registry.close(); }
    running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_profile_refused", "把 sample.txt 的 x 改为 xx", { kind: "dispatch", agentId: "jack", requestId: null, summary: "修改样例", message: "" }, {
      modelToolCalls: [
        { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "sample.txt", kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
        { namespace: "files", tool: "read", arguments: { fileRef: { $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } } } },
        { namespace: "files", tool: "edit", arguments: { fileRef: { $fixtureToolResult: { call: 1, path: ["fileRef"] } }, expectedSha256: { $fixtureToolResult: { call: 1, path: ["sha256"] } }, oldText: "x", newText: "xx", replaceAll: true } },
        { namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: "refused.txt", content: { $fixtureToolResult: { call: 2, path: ["error", "code"] } }, overwrite: false } },
      ],
      modelReply: JSON.stringify({ message: "修改工具不可用，未修改样例。", results: [{ subject: "修改样例", status: "blocked" }] }),
    }));
    const result = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 2);
    console.log(JSON.stringify({ kind: "dispatch_profile_tool_refused", command: "把 sample.txt 的 x 改为 xx", jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    expect(readFileSync(join(business, "demo-vault", "sample.txt"), "utf8")).toBe("x\n");
    expect(readFileSync(join(business, "demo-vault", "refused.txt"), "utf8")).toBe("agent_profile_tool_refused");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("names the Coordinator from the registry in its default reassignment explanation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-coordinator-name-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    const configuration = JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"));
    configuration.feishu.dispatch.agents[0] = { id: "sam", name: "Lin" };
    writeFileSync(join(directory, "channel.json"), JSON.stringify(configuration));
    running = await start(directory);
    await running.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_coordinator_name", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
          mentions: [{ key: "@_user_0", id: { open_id: "ou_samview0" }, name: "Bill" }], content: JSON.stringify({ text: "@_user_0 帮我修复代码" }) } },
      messageDetails: { message_id: "om_coordinator_name", chat_id: "oc_alpha", msg_type: "text", body: { content: '{"text":"帮我修复代码"}' },
        mentions: [{ key: "@_user_0", id: "cli_bbbbbbbbbbbbbbbb", id_type: "app_id", name: "Bill" }] },
      dispatchDecision: { kind: "dispatch", agentId: "jack", requestId: null, summary: "修复代码", message: "" },
    });
    const result = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 2);
    console.log(JSON.stringify({ kind: "dispatch_coordinator_name", command: "@Bill 帮我修复代码", outboxes: result.agentFixtureOutboxes, coordinator: result.fixtureTextOutbox }));
    expect(result.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual(["这项需求属于 Jack 的职责。我请 Lin 重新分派，由他独立处理。"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

const decision = (agentId: string, summary: string) => ({ kind: "dispatch", agentId, requestId: null, summary, message: "" });
const executorReply = (message: string, subject: string) => JSON.stringify({ message, results: [{ subject, status: "completed" }] });

it("routes an explicit request to its team, whose Team Leader starts, delegates and closes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-team-leader-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const requests = [
    { team: "alice", messageId: "om_team_alice", text: "帮我整理闲鱼商品描述：九成新 iPad，128G，无维修", summary: "整理闲鱼商品描述",
      title: "撰写 iPad 闲鱼文案", brief: "成色九成新、128G、无维修；电池健康度未知，标为待补", reply: "商品文案已整理：标题、描述和买家问答，电池健康度标为待确认。",
      closing: "闲鱼商品文案已整理好，电池健康度请你补充确认。" },
    { team: "bill", messageId: "om_team_bill", text: "帮我规划周六南京一日游，两人，预算 400 元", summary: "规划南京一日游",
      title: "排南京周六行程", brief: "两人，预算 400 元；交通与天气注明来源，估算单列", reply: "南京一日行程已规划：交通、餐饮和预算估算，天气按官方预报核对。",
      closing: "南京一日行程已规划好，预算估算与已核实信息分开标注。" },
    { team: "jack", messageId: "om_team_jack", text: "TypeScript 函数 discount 可能返回负数，请给出补丁和回归测试", summary: "修复 discount 负数问题",
      title: "给 discount 出补丁", brief: "结果不得为负；附 3 个回归用例，不声称测试已运行", reply: "补丁与 3 个回归用例已给出，测试尚未运行。",
      closing: "discount 补丁和 3 个回归用例已给出，测试尚未运行。" },
  ];
  try {
    dispatchConfig(directory);
    running = await start(directory);
    for (const [index, request] of requests.entries()) {
      const message = groupMessage(request.messageId, request.text, decision(request.team, request.summary),
        { modelReply: executorReply(request.reply, request.summary), leaderClosing: { message: request.closing },
          leaderPlan: { assignments: [{ profileId: "executor-1", title: request.title, brief: request.brief }], decisions: [] } });
      await running.post("/api/fixture/inbound", message);
      if (index === 0) await running.post("/api/fixture/inbound", message);
      await running.until((state) => state.agentFixtureOutboxes?.[request.team]?.text.length === 2);
    }
    const result = await running.state();
    console.log(JSON.stringify({ kind: "dispatch_team_leader", commands: requests.map(({ text }) => text), jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes,
      leader: result.fixtureLeaderRequests }));
    expect(result.agentDispatch?.jobs).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      expect(result.agentFixtureOutboxes?.[request.team]?.text.map(({ chatId, message }) => ({ chatId, message }))).toEqual([
        { chatId: "oc_alpha", message: `我安排执行者 ${index + 1}（能力档 1）处理：${request.title}。完成后会在本群汇报。` },
        { chatId: "oc_alpha", message: request.closing },
      ]);
      expect(result.agentDispatch?.jobs[index]).toMatchObject({ agentId: request.team, status: "completed", requester: "ou_owner", definitionsVersion: 1,
        assignments: [{ teamId: request.team, profileId: "executor-1", executor: `执行者 ${index + 1}`, title: request.title, status: "completed", attempt: 0 }] });
      expect(JSON.stringify(result.fixtureModelRequests![index]!.input)).toContain(`你是 ${request.team[0]!.toUpperCase()}${request.team.slice(1)} 团队的执行者 ${index + 1}`);
      // The plan's title and Brief differ from the Coordinator's summary and the message, so only the Team Leader's division can supply them.
      for (const fragment of [request.title, request.brief]) expect(JSON.stringify(result.fixtureModelRequests![index]!.input)).toContain(fragment);
    }
    expect(result.fixtureTextOutbox).toEqual([]);
    const posted = JSON.stringify([result.agentFixtureOutboxes, result.fixtureTextOutbox]);
    for (const { reply } of requests) expect(posted).not.toContain(reply);
    expect(result.fixtureLeaderRequests?.map(({ phase, teamId }) => `${phase}:${teamId}`)).toEqual(["plan:alice", "close:alice", "plan:bill", "close:bill", "plan:jack", "close:jack"]);
    for (const [index, request] of requests.entries()) {
      const [plan, close] = [result.fixtureLeaderRequests![index * 2]!, result.fixtureLeaderRequests![index * 2 + 1]!];
      expect(plan.input.brief).toEqual({ message: request.text, summary: request.summary });
      expect(close.input.assignments).toEqual([{ title: request.title, executor: `执行者 ${index + 1}`, status: "completed", result: request.reply }]);
    }
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("corrects a plan once, and fails a request whose plan stays invalid", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-leader-correction-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const foreign = { assignments: [{ profileId: "jack-only", title: "规划行程", brief: "南京一日游" }], decisions: [] };
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_corrected_plan", "帮我规划周末一日行程", decision("bill", "规划行程"),
      { leaderPlan: [foreign, { assignments: [{ profileId: "executor-1", title: "规划行程", brief: "南京一日游" }], decisions: [] }] }));
    await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    await running.post("/api/fixture/inbound", groupMessage("om_invalid_plan", "帮我修复代码", decision("jack", "修复代码"), { leaderPlan: [{ kind: "x" }, foreign] }));
    const result = await running.until((state) => state.agentDispatch?.jobs[1]?.status === "failed" && state.agentFixtureOutboxes?.jack?.text.length === 1);
    console.log(JSON.stringify({ kind: "dispatch_leader_correction", commands: ["帮我规划周末一日行程", "帮我修复代码"], jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes,
      leader: result.fixtureLeaderRequests }));
    const bill = result.fixtureLeaderRequests!.filter(({ teamId, phase }) => teamId === "bill" && phase === "plan");
    expect(bill.map(({ input }) => input.refusal)).toEqual([undefined, 'profileId "jack-only" 不是本团队的预设能力档']);
    expect(result.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual([
      "我安排执行者 1（能力档 1）处理：规划行程。完成后会在本群汇报。", "这是 fixture Codex 回复。"]);
    expect(result.agentDispatch?.jobs[1]).toMatchObject({ agentId: "jack", status: "failed", assignments: [] });
    expect(result.agentFixtureOutboxes?.jack?.text.map(({ message }) => message)).toEqual(["我暂时无法形成有效分工，本次尚未开始处理。请补充需求后明确重试。"]);
    expect(result.fixtureModelRequests).toHaveLength(1);
    expect(result.fixtureTextOutbox).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("runs the preset the plan names, and refuses a preset of another team", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-plan-profile-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const plan = (profileId: string) => ({ assignments: [{ profileId, title: "准备周末晚餐", brief: "三人份，列出采购清单" }], decisions: [] });
  try {
    dispatchConfig(directory);
    const local = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"))).entries.find((entry) => entry.channel === "feishu")?.dispatch;
    if (!local) throw new Error("expected_dispatch_configuration");
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(local, { executorHostTools: PRODUCTION_TOOL_IDS });
      // Bill's second preset differs from his first in instructions and tools; Jack's preset ID exists in no other team.
      registry.save({ ...seeded.definitions, teams: seeded.definitions.teams.map((team) => team.id === "bill"
        ? { ...team, executorProfiles: [...team.executorProfiles, { id: "meal", name: "餐饮采购", instructions: "餐饮采购规则 R4", hostTools: ["schedules.list"] }] }
        : team.id === "jack" ? { ...team, executorProfiles: [{ id: "code", name: "代码与脚本", instructions: "代码规则 R4", hostTools: PRODUCTION_TOOL_IDS }] } : team) },
      { basedOn: seeded.version });
    } finally { registry.close(); }
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_plan_second_preset", "帮我准备周末晚餐", decision("bill", "准备周末晚餐"), { leaderPlan: plan("meal") }));
    await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    await running.post("/api/fixture/inbound", groupMessage("om_plan_foreign_preset", "再帮我准备周日晚餐", decision("bill", "准备周日晚餐"), { leaderPlan: plan("code") }));
    const result = await running.until((state) => state.agentDispatch?.jobs[1]?.status === "failed" && state.agentFixtureOutboxes?.bill?.text.length === 3);
    console.log(JSON.stringify({ kind: "dispatch_plan_profile", commands: ["帮我准备周末晚餐", "再帮我准备周日晚餐"], jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    expect(result.agentDispatch?.jobs[0]?.assignments).toEqual([expect.objectContaining({ teamId: "bill", profileId: "meal", status: "completed" })]);
    expect(result.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual([
      "我安排执行者 1（餐饮采购）处理：准备周末晚餐。完成后会在本群汇报。", "这是 fixture Codex 回复。", "我暂时无法形成有效分工，本次尚未开始处理。请补充需求后明确重试。"]);
    // The Executor ran with the named preset's instructions and tools, not with the team's first preset.
    expect(result.fixtureModelRequests).toHaveLength(1);
    expect(JSON.stringify(result.fixtureModelRequests![0]!.input)).toContain("餐饮采购规则 R4");
    expect(JSON.stringify(result.fixtureModelRequests![0]!.input)).not.toContain("出行路线须逐段核对站名");
    expect(result.fixtureThreadStarts?.filter(({ serviceName }) => serviceName === "feishu_agent_bill").map(({ dynamicTools }) => dynamicTools)).toEqual([["schedules.list"]]);
    // A preset of another team is refused for Bill's plan: no Assignment, no Executor.
    expect(result.agentDispatch?.jobs[1]).toMatchObject({ agentId: "bill", status: "failed", assignments: [] });
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("fails a request whose start message was uncertain at a crash, without sending it again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-held-start-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    // Bill's application holds the start message: it reaches the outbox, but the send never completes before the crash.
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["held"] } });
    await running.post("/api/fixture/inbound", groupMessage("om_held_start", "帮我规划周末一日行程", decision("bill", "规划周末一日行程")));
    const held = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 1 && state.agentDispatch?.jobs[0]?.assignments[0]?.status === "queued");
    expect(held.agentDispatch?.jobs[0]?.status).toBe("running");
    await running.crash(); running = undefined;
    running = await start(directory);
    const recovered = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed" && state.agentFixtureOutboxes?.bill?.text.length === 1);
    console.log(JSON.stringify({ kind: "dispatch_held_start", command: "帮我规划周末一日行程", jobs: recovered.agentDispatch, outboxes: recovered.agentFixtureOutboxes }));
    expect(recovered.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual(["接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。"]);
    expect(recovered.agentDispatch?.notices?.find(({ id }) => id.endsWith(":receipt:0"))?.state).toBe("unknown");
    expect(recovered.agentDispatch?.jobs[0]?.assignments).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(recovered.fixtureModelRequests).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("builds the Coordinator's and the Team Leader's runtimes from their resolved profiles, without tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-coordination-runtime-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    const local = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"))).entries.find((entry) => entry.channel === "feishu")?.dispatch;
    if (!local) throw new Error("expected_dispatch_configuration");
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(local, { executorHostTools: PRODUCTION_TOOL_IDS });
      registry.save({ ...seeded.definitions, coordinator: { ...seeded.definitions.coordinator, profile: { instructions: "协调规则 R3", hostTools: ["files.write"] } },
        teams: seeded.definitions.teams.map((team) => team.id === "bill" ? { ...team, leader: { ...team.leader, profile: { instructions: "负责人规则 R3", hostTools: ["files.write"] } } } : team) },
      { basedOn: seeded.version });
    } finally { registry.close(); }
    running = await start(directory, { WORKFLOW_FIXTURE_COORDINATION_RUNTIME: "1" });
    await running.post("/api/fixture/inbound", groupMessage("om_coordination_runtime", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"),
      { leaderClosing: { message: "周末一日行程已规划好。" } }));
    const result = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    console.log(JSON.stringify({ kind: "dispatch_coordination_runtime", command: "请帮我规划周末一日行程", threads: result.fixtureThreadStarts, outboxes: result.agentFixtureOutboxes }));
    const started = (service: string) => result.fixtureThreadStarts!.filter(({ serviceName }) => serviceName === service);
    expect(started("feishu_dispatch_coordinator").map(({ dynamicTools }) => dynamicTools)).toEqual([null]);
    expect(started("feishu_dispatch_leader").map(({ dynamicTools }) => dynamicTools)).toEqual([null]);
    expect(started("feishu_agent_bill")).toHaveLength(1);
    expect(started("feishu_agent_bill")[0]!.dynamicTools).toContain("files.write");
    const turns = result.fixtureCoordinationRequests!.map(({ input }) => JSON.stringify(input));
    expect(turns.filter((input) => input.includes("协调规则 R3"))).toHaveLength(1);
    expect(turns.filter((input) => input.includes("负责人规则 R3"))).toHaveLength(2);
    expect(result.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual([
      "我安排执行者 1（能力档 1）处理：规划周末一日行程。完成后会在本群汇报。", "周末一日行程已规划好。"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

const RESPONSIBILITIES = { alice: "闲鱼、淘宝等网站运营，包括商品文案、上架材料和经营分析。", bill: "日常生活事务，包括吃穿住行的规划和安排。",
  jack: "技术事务和开发需求，包括代码分析、补丁、测试设计和技术研究。" };

it("routes and assigns only to teams accepting work in the group, and gives each Team Leader that group's Team Directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-group-roster-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const inBeta = <T extends { event: { message: { chat_id: string } } }>(message: T): T => { message.event.message.chat_id = "oc_beta"; return message; };
  try {
    dispatchConfig(directory);
    const configuration = JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"));
    configuration.feishu.groups.push({ chatId: "oc_beta", allowedSenderIds: ["ou_owner"] });
    configuration.feishu.dispatch.groupChatIds.push("oc_beta");
    writeFileSync(join(directory, "channel.json"), JSON.stringify(configuration));
    const local = parseChannelStartupConfiguration(configuration).entries.find((entry) => entry.channel === "feishu")?.dispatch;
    if (!local) throw new Error("expected_dispatch_configuration");
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(local, { executorHostTools: PRODUCTION_TOOL_IDS });
      // Alice accepts in both groups, Bill is bound to oc_alpha only, and Jack's onboarding in oc_beta is not complete.
      registry.save({ ...seeded.definitions, teams: seeded.definitions.teams.map((team) => team.id === "bill" ? { ...team, bindings: [{ chatId: "oc_alpha", state: "accepting" as const }] }
        : team.id === "jack" ? { ...team, bindings: [{ chatId: "oc_alpha", state: "accepting" as const }, { chatId: "oc_beta", state: "onboarding" as const }] } : team) },
      { basedOn: seeded.version });
    } finally { registry.close(); }
    running = await start(directory);
    await running.post("/api/fixture/inbound", inBeta(groupMessage("om_beta_jack", "帮我修复代码", decision("jack", "修复代码"))));
    const refused = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    expect(refused.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。"]);
    expect(refused.agentDispatch?.jobs).toEqual([]);
    // A genuine mention of Jack in oc_beta confers no priority there, and Jack's bot posts nothing.
    await running.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_beta_mention", create_time: String(Date.now()), chat_id: "oc_beta", chat_type: "group", message_type: "text",
          mentions: [{ key: "@_user_0", id: { open_id: "ou_jackview0" }, name: "Jack" }], content: JSON.stringify({ text: "@_user_0 帮我整理闲鱼商品描述" }) } },
      messageDetails: { message_id: "om_beta_mention", chat_id: "oc_beta", msg_type: "text", body: { content: '{"text":"帮我整理闲鱼商品描述"}' },
        mentions: [{ key: "@_user_0", id: "cli_cccccccccccccccc", id_type: "app_id", name: "Jack" }] },
      dispatchDecision: decision("alice", "整理闲鱼商品描述"),
    });
    await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    await running.post("/api/fixture/inbound", groupMessage("om_alpha_jack", "帮我修复代码", decision("jack", "修复代码")));
    const result = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 2);
    console.log(JSON.stringify({ kind: "dispatch_group_roster", commands: ["oc_beta 帮我修复代码", "oc_beta @Jack 帮我整理闲鱼商品描述", "oc_alpha 帮我修复代码"],
      jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes, coordinator: result.fixtureTextOutbox, leader: result.fixtureLeaderRequests }));
    expect(result.agentDispatch?.jobs.map(({ agentId, status }) => ({ agentId, status }))).toEqual([{ agentId: "alice", status: "completed" }, { agentId: "jack", status: "completed" }]);
    expect(result.agentFixtureOutboxes?.jack?.text.map(({ chatId }) => chatId)).toEqual(["oc_alpha", "oc_alpha"]);
    expect(result.fixtureTextOutbox).toHaveLength(1);
    const plans = result.fixtureLeaderRequests!.filter(({ phase }) => phase === "plan");
    expect(plans.map(({ teamId }) => teamId)).toEqual(["alice", "jack"]);
    expect(plans.map(({ input }) => input.directory)).toEqual([
      [{ name: "运营团队", responsibility: RESPONSIBILITIES.alice }],
      [{ name: "运营团队", responsibility: RESPONSIBILITIES.alice }, { name: "生活团队", responsibility: RESPONSIBILITIES.bill }, { name: "技术团队", responsibility: RESPONSIBILITIES.jack }],
    ]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("gives the Coordinator the group memory, and each Team Leader only its Brief, its own memory and the Team Directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-recall-scopes-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    const configuration = JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"));
    const binding = parseChannelStartupConfiguration(configuration).entries.find((entry) => entry.channel === "feishu")!;
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(binding.dispatch!, { executorHostTools: PRODUCTION_TOOL_IDS });
      // Instruction markers tell the Coordinator's and each Team Leader's turns apart in the recorded runtime requests.
      registry.save({ ...seeded.definitions, coordinator: { ...seeded.definitions.coordinator, profile: { instructions: "协调规则 R6", hostTools: [] } },
        teams: seeded.definitions.teams.map((team) => ({ ...team, leader: { ...team.leader, profile: { instructions: `负责人规则 R6 ${team.id}`, hostTools: [] } } })) },
      { basedOn: seeded.version });
    } finally { registry.close(); }
    const alpha = binding.owner.groupAddress("oc_alpha")!, group = binding.owner.memoryScope(alpha.accountId, alpha.target);
    await seedMemory(directory, group, alpha.target, "group-seed", "GROUP_FACT_R6");
    await seedMemory(directory, memoryAccountId(group, { kind: "leader", teamId: "alice" }), alpha.target, "alice-leader-seed", "ALICE_LEADER_FACT_R6");
    await seedMemory(directory, memoryAccountId(group, { kind: "profile", teamId: "alice", profileId: "executor-1" }), alpha.target, "alice-profile-seed", "ALICE_PROFILE_FACT_R6");
    running = await start(directory, { WORKFLOW_FIXTURE_COORDINATION_RUNTIME: "1" });
    await running.post("/api/fixture/inbound", groupMessage("om_recall_discussion", "DISCUSSION_MARKER_R6，周末大家有空吗", { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" }));
    await running.until((state) => (state.fixtureCoordinationRequests?.length ?? 0) === 1);
    await running.post("/api/fixture/inbound", groupMessage("om_recall_alice", "帮我整理闲鱼商品描述", decision("alice", "整理闲鱼商品描述")));
    await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    await running.post("/api/fixture/inbound", groupMessage("om_recall_bill", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程")));
    const result = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    console.log(JSON.stringify({ kind: "dispatch_recall_scopes", commands: ["DISCUSSION_MARKER_R6，周末大家有空吗", "帮我整理闲鱼商品描述", "请帮我规划周末一日行程"],
      jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    const turns = result.fixtureCoordinationRequests!.map(({ input }) => JSON.stringify(input));
    const coordinator = turns.filter((input) => input.includes("协调规则 R6"));
    const [alice, bill] = ["alice", "bill"].map((id) => turns.filter((input) => input.includes(`负责人规则 R6 ${id}`)));
    expect([coordinator.length, alice!.length, bill!.length]).toEqual([3, 2, 2]);
    for (const input of coordinator) expect(input).toContain("GROUP_FACT_R6");
    // The group discussion reaches the Coordinator with each later message.
    for (const input of coordinator.slice(1)) expect(input).toContain("DISCUSSION_MARKER_R6");
    for (const input of alice!) {
      expect(input).toContain("ALICE_LEADER_FACT_R6");
      for (const [name, responsibility] of [["运营团队", RESPONSIBILITIES.alice], ["生活团队", RESPONSIBILITIES.bill], ["技术团队", RESPONSIBILITIES.jack]]) {
        expect(input).toContain(name); expect(input).toContain(responsibility);
      }
    }
    for (const input of [...alice!, ...bill!]) for (const outside of ["GROUP_FACT_R6", "ALICE_PROFILE_FACT_R6", "DISCUSSION_MARKER_R6"]) expect(input).not.toContain(outside);
    for (const input of bill!) expect(input).not.toContain("ALICE_LEADER_FACT_R6");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("captures the group memory from what was posted, each Team Leader's from its division and closing, and one memory per Executor profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-capture-scopes-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const requests = [
    { team: "alice", messageId: "om_capture_1", text: "帮我整理闲鱼商品描述：九成新 iPad", title: "撰写 iPad 文案", brief: "九成新、128G" },
    { team: "alice", messageId: "om_capture_2", text: "再帮我整理二手台灯的描述", title: "撰写台灯文案", brief: "黑色，灯座有划痕" },
    { team: "bill", messageId: "om_capture_3", text: "帮我规划周六南京一日游", title: "排南京行程", brief: "两人，预算 400 元" },
  ];
  try {
    dispatchConfig(directory);
    running = await start(directory);
    for (const [index, request] of requests.entries()) {
      const before = (await running.state()).agentFixtureOutboxes?.[request.team]?.text.length ?? 0;
      await running.post("/api/fixture/inbound", groupMessage(request.messageId, request.text, decision(request.team, request.title),
        { modelReply: executorReply(`EXEC_R2_${index + 1}`, request.title), leaderClosing: { message: `CLOSE_R2_${index + 1}` },
          leaderPlan: { assignments: [{ profileId: "executor-1", title: request.title, brief: request.brief }], decisions: [] } }));
      await running.until((state) => state.agentFixtureOutboxes?.[request.team]?.text.length === before + 2);
    }
    const result = await running.until((state) => (state.fixtureMemoryCurations?.length ?? 0) === 9);
    console.log(JSON.stringify({ kind: "dispatch_capture_scopes", commands: requests.map(({ text }) => text), curations: result.fixtureMemoryCurations }));
    const configuration = JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"));
    const owner = parseChannelStartupConfiguration(configuration).entries.find((entry) => entry.channel === "feishu")!.owner;
    const alpha = owner.groupAddress("oc_alpha")!, group = owner.memoryScope(alpha.accountId, alpha.target);
    const curations = result.fixtureMemoryCurations!;
    const groupTurns = curations.filter(({ accountId }) => accountId === group);
    // Every team's request lands in the one canonical group memory, curated by the group curator, with what was posted and no Executor result.
    expect(groupTurns.every(({ curator }) => curator === "group")).toBe(true);
    expect(groupTurns.flatMap(({ turns }) => turns)).toEqual(requests.map(({ text, title }, index) => ({ user: text,
      assistant: `我安排执行者 ${index + 1}（能力档 1）处理：${title}。完成后会在本群汇报。\nCLOSE_R2_${index + 1}` })));
    expect(JSON.stringify(groupTurns)).not.toContain("EXEC_R2");
    const others = curations.filter(({ accountId }) => accountId !== group);
    expect(others).toHaveLength(6);
    for (const { curator, accountId } of others) { expect(curator).toBe("dispatch"); expect(accountId).toMatch(/^feishu\.dispatch\./); }
    const accountOf = (match: (turn: { user: string; assistant?: string }) => boolean) => {
      const found = others.filter(({ turns }) => turns.some(match));
      expect(found).toHaveLength(1);
      return found[0]!.accountId;
    };
    const profiles = requests.map((_request, index) => accountOf(({ assistant }) => assistant === `EXEC_R2_${index + 1}`));
    const leaders = requests.map((_request, index) => accountOf(({ assistant }) => assistant?.startsWith("分工：") === true && assistant.endsWith(`CLOSE_R2_${index + 1}`)));
    expect([profiles[0] === profiles[1], profiles[0] === profiles[2], leaders[0] === leaders[1], leaders[0] === leaders[2]]).toEqual([true, false, true, false]);
    expect(new Set([...profiles, ...leaders]).size).toBe(4);
    // An Executor's memory holds the Assignment it received; a Team Leader's holds its Brief, division and closing.
    expect(others.find(({ accountId, turns }) => accountId === profiles[0] && turns.some(({ assistant }) => assistant === "EXEC_R2_1"))!.turns)
      .toEqual([{ user: "撰写 iPad 文案\n九成新、128G", assistant: "EXEC_R2_1" }]);
    expect(others.find(({ accountId, turns }) => accountId === leaders[2] && turns.some(({ assistant }) => assistant?.endsWith("CLOSE_R2_3")))!.turns).toEqual([{
      user: "请求：帮我规划周六南京一日游\n协调摘要：排南京行程", assistant: "分工：执行者 3（能力档 1）排南京行程\n收尾：CLOSE_R2_3" }]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// The last commit whose dispatch stored requests without Assignments (ticket 05's base). The owner may retire the upgrade case
// once a deployment has migrated production's pre-05 requests (agent-dispatch Testing Decisions).
const PRE_TEAM_COMMIT = "71ff31d";
/** Materializes this package at PRE_TEAM_COMMIT, sharing the current install. Each failing step names itself; the case never skips. */
function preTeamService(root: string): string {
  const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
  const step = <T>(name: string, action: () => T): T => {
    try { return action(); } catch (error) { throw new Error(`pre-05 service ${name} failed at ${PRE_TEAM_COMMIT}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const repository = step("archive", () => execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: packageDirectory, encoding: "utf8" }).trim());
  step("archive", () => {
    execFileSync("git", ["cat-file", "-e", `${PRE_TEAM_COMMIT}^{commit}`], { cwd: repository });
    const archive = execFileSync("git", ["archive", PRE_TEAM_COMMIT, "apps/weixin-service"], { cwd: repository, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
  });
  const service = join(root, "apps", "weixin-service");
  step("build", () => {
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    symlinkSync(join(packageDirectory, "node_modules"), join(service, "node_modules"));
    execFileSync(process.execPath, ["scripts/build-sandbox-telemetry.mjs"], { cwd: service, stdio: "pipe" });
  });
  return service;
}

it("upgrades a dispatch database written by the pre-05 code without losing a request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-pre-team-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-pre-team-files-"));
  const checkout = mkdtempSync(join(tmpdir(), "dispatch-pre-team-service-"));
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const post = (messageId: string, sender: string, text: string, dispatchDecision: unknown, extra: Record<string, unknown> = {}) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } },
    dispatchDecision, ...extra });
  const edit = [
    { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "sample.txt", kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
    { namespace: "files", tool: "read", arguments: { fileRef: { $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } } } },
    { namespace: "files", tool: "edit", arguments: { fileRef: { $fixtureToolResult: { call: 1, path: ["fileRef"] } }, expectedSha256: { $fixtureToolResult: { call: 1, path: ["sha256"] } }, oldText: "x", newText: "xx", replaceAll: true } },
  ];
  try {
    dispatchConfig(directory, true);
    // The pre-05 code writes one request in each state, then stops without warning.
    const service = preTeamService(checkout);
    try { running = await start(directory, env, { packageRoot: service }); }
    catch (error) { throw new Error(`pre-05 service boot failed at ${PRE_TEAM_COMMIT}: ${error instanceof Error ? error.message : String(error)}`); }
    await running.until((state) => state.channels?.feishu?.ready === true);
    // The fixture seeds its demo vault, including the notes the file choice offers, only when the vault is absent.
    writeFileSync(join(business, "demo-vault", "sample.txt"), "x\n");
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    await post("om_old_completed", "ou_owner", "帮我整理闲鱼商品描述", decision("alice", "整理闲鱼商品描述"));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    await post("om_old_declined", "ou_owner", "周末可能想出去玩", { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" });
    const declinedId = (await running.until((state) => state.agentDispatch?.jobs[1]?.status === "proposed")).agentDispatch!.jobs[1]!.id;
    await post("om_old_decline", "ou_owner", "暂时不用", { kind: "decline", agentId: null, requestId: declinedId, summary: "", message: "" });
    await post("om_old_proposed", "ou_owner", "这段代码以后可能要整理", { kind: "propose", agentId: "jack", requestId: null, summary: "整理代码", message: "" });
    await running.until((state) => state.agentDispatch?.jobs[1]?.status === "cancelled" && state.agentDispatch?.jobs[2]?.status === "proposed");
    await post("om_old_failed", "ou_owner", "把 sample.txt 的 x 改为 xx，并整理报告", decision("jack", "修改样例并整理报告"),
      { modelToolCalls: edit, modelReply: JSON.stringify({ message: "已修改样例，但报告生成失败。", results: [{ subject: "修改样例并整理报告", status: "partial" }] }) });
    await running.until((state) => state.agentDispatch?.jobs[3]?.status === "failed");
    await post("om_old_waiting", "ou_owner", "列出 Agent 笔记让我选发哪个", decision("alice", "选择并发送运营笔记"), { modelToolCalls: [
      { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
    ] });
    await running.until((state) => state.agentDispatch?.jobs[4]?.status === "waiting");
    await post("om_old_running", "ou_owner", "安排周末出行", decision("bill", "安排周末出行"), { modelHold: true });
    await running.until((state) => state.agentDispatch?.jobs[5]?.status === "running" && (state.fixtureModelRequests?.length ?? 0) === 4);
    await post("om_old_queued", "ou_owner", "再安排周日的晚餐", decision("bill", "安排周日晚餐"));
    const stored = await running.until((state) => state.agentDispatch?.jobs[6]?.status === "queued");
    await running.crash(); running = undefined;
    const storedIds = stored.agentDispatch!.jobs.map(({ id }) => id);

    // The new code starts on the same state. Only the running request's interruption report is new before anyone acts.
    // Its seeded definitions differ from the pre-05 commit's (Jack's Executor profile, ticket 06), so this start appends version 2.
    running = await start(directory, env);
    const upgraded = await running.until((state) => state.agentDispatch?.jobs[6]?.status === "completed" && state.agentFixtureOutboxes?.bill?.text.length === 3);
    console.log(JSON.stringify({ kind: "dispatch_pre_team_upgrade", jobs: upgraded.agentDispatch, outboxes: upgraded.agentFixtureOutboxes, coordinator: upgraded.feishuFixtureTextOutbox }));
    expect(upgraded.agentDispatch?.jobs.map(({ id }) => id)).toEqual(storedIds);
    expect(upgraded.agentDispatch?.jobs.map(({ status, definitionsVersion, assignments }) => ({ status, definitionsVersion, assignments: assignments.length }))).toEqual([
      { status: "completed", definitionsVersion: null, assignments: 0 },
      { status: "cancelled", definitionsVersion: null, assignments: 0 },
      { status: "proposed", definitionsVersion: null, assignments: 0 },
      { status: "failed", definitionsVersion: null, assignments: 0 },
      { status: "waiting", definitionsVersion: null, assignments: 0 },
      { status: "failed", definitionsVersion: null, assignments: 0 },
      { status: "completed", definitionsVersion: 2, assignments: 1 },
    ]);
    expect(upgraded.agentDispatch?.jobs[0]?.result).toBe("这是 fixture Codex 回复。");
    expect(upgraded.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual([
      expect.stringContaining("服务中断，本次处理已停止。"), "我安排执行者 1（能力档 1）处理：安排周日晚餐。完成后会在本群汇报。", "这是 fixture Codex 回复。"]);
    expect([upgraded.agentFixtureOutboxes?.alice?.text, upgraded.agentFixtureOutboxes?.jack?.text, upgraded.feishuFixtureTextOutbox]).toEqual([[], [], []]);
    expect(upgraded.fixtureModelRequests).toHaveLength(1);

    // The stored proposal, file choice and failed request still answer their original requester's controls.
    await post("om_new_confirm", "ou_owner", "确认", { kind: "confirm", agentId: null, requestId: storedIds[2], summary: "", message: "" });
    await running.until((state) => state.agentDispatch?.jobs[2]?.status === "completed" && state.agentFixtureOutboxes?.jack?.text.length === 2);
    await post("om_new_choice", "ou_owner", "2", { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" });
    await running.until((state) => state.agentDispatch?.jobs[4]?.status === "completed");
    await post("om_new_retry", "ou_owner", "重试", { kind: "retry", agentId: null, requestId: storedIds[3], summary: "", message: "" },
      { modelReply: JSON.stringify({ message: "已保留修改并补齐报告。", results: [{ subject: "修改样例并整理报告", status: "completed" }] }) });
    const controlled = await running.until((state) => state.agentDispatch?.jobs[3]?.status === "completed" && state.agentFixtureOutboxes?.jack?.text.length === 4);
    console.log(JSON.stringify({ kind: "dispatch_pre_team_controls", jobs: controlled.agentDispatch, outboxes: controlled.agentFixtureOutboxes, leader: controlled.fixtureLeaderRequests }));
    expect(controlled.agentDispatch?.jobs[2]).toMatchObject({ definitionsVersion: 2, assignments: [expect.objectContaining({ teamId: "jack", status: "completed" })] });
    expect(controlled.agentDispatch?.jobs[4]).toMatchObject({ definitionsVersion: null, assignments: [] });
    expect(controlled.agentFixtureOutboxes?.alice?.media).toEqual([expect.objectContaining({ chatId: "oc_alpha", fileName: "Agent Beta.md" })]);
    expect(controlled.agentDispatch?.jobs[3]).toMatchObject({ definitionsVersion: 2, assignments: [expect.objectContaining({ teamId: "jack", status: "completed" })] });
    expect(readFileSync(join(business, "demo-vault", "sample.txt"), "utf8")).toBe("xx\n");
    // Plans only for the requests the new code ran: the queued one, the confirmed proposal and the retried failure. The choice ran no Team Leader turn.
    expect(controlled.fixtureLeaderRequests?.filter(({ phase }) => phase === "plan").map(({ teamId }) => teamId)).toEqual(["bill", "jack", "jack"]);
  } finally {
    await running?.close();
    for (const path of [directory, business, checkout]) rmSync(path, { recursive: true, force: true });
  }
}, 90000);

// Executor home compaction (agent-dispatch::QR-002). In fixture mode the fixture App Server writes a rollout for each Executor
// thread it starts, so homes compact as in production. Gap: it does not resume from that rollout; resume after compaction is
// shown on the installed App Server in isolated-runtime-compaction.test.ts, which CI cannot run.
// Gap: the startup sweep is shown to finish before the service is ready, with no queued work at start; no case orders it
// against `agentDispatch.start()`. Retest condition: a restart case with a queued retry whose failed attempt's home was left
// uncompacted, asserting the sweep compacts that home before the retry's Executor runtime is created on it.
const executorHomes = (directory: string) => readdirSync(join(directory, "group-model-runtimes")).filter((name) => /^dispatch-[0-9a-f]{64}$/u.test(name))
  .map((name) => join(directory, "group-model-runtimes", name));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** Waits until home holds only one rollout (of `threadId` when given) and the directories leading to it; returns that rollout. */
async function onlyRolloutRemains(home: string, threadId?: string): Promise<string> {
  const rollout = new RegExp(`^codex-home/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-.+-${threadId ?? "[0-9a-f-]{36}"}\\.jsonl$`, "u");
  const deadline = Date.now() + processWaitLimitMs;
  for (;;) {
    const listing = homeListing(home), files = listing.filter((entry) => !entry.endsWith("/"));
    const ancestors = files.length === 1 ? files[0]!.split("/").slice(0, -1).map((_part, index, parts) => `${parts.slice(0, index + 1).join("/")}/`) : [];
    if (files.length === 1 && rollout.test(files[0]!) && JSON.stringify(listing.filter((entry) => entry.endsWith("/"))) === JSON.stringify(ancestors)) return files[0]!;
    if (Date.now() > deadline) throw new Error(`home not compacted: ${JSON.stringify(listing)}`);
    await delay(25);
  }
}

it("compacts an ended Executor's home to its rollout, and reruns the retried Assignment on the same thread", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-home-compaction-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_compaction_failed", "帮我整理闲鱼商品描述", decision("alice", "整理闲鱼商品描述"),
      { modelReply: JSON.stringify({ message: "缺少商品照片，文案未完成。", results: [{ subject: "整理闲鱼商品描述", status: "failed" }] }) }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed" && state.agentFixtureOutboxes?.alice?.text.length === 2);
    const thread = failed.fixtureModelRequests![0]!.threadId, homes = executorHomes(directory);
    expect(homes).toHaveLength(1);
    const kept = await onlyRolloutRemains(homes[0]!, thread);
    await running.post("/api/fixture/inbound", groupMessage("om_compaction_retry", "重试", { kind: "retry", agentId: null, requestId: failed.agentDispatch!.jobs[0]!.id, summary: "", message: "" },
      { modelReply: executorReply("商品文案已整理好。", "整理闲鱼商品描述") }));
    const completed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && state.agentFixtureOutboxes?.alice?.text.length === 4);
    console.log(JSON.stringify({ kind: "dispatch_home_compaction_retry", commands: ["帮我整理闲鱼商品描述", "重试"], jobs: completed.agentDispatch,
      outboxes: completed.agentFixtureOutboxes, threads: completed.fixtureModelRequests!.map(({ threadId }) => threadId), home: homeListing(homes[0]!) }));
    expect(completed.fixtureModelRequests!.map(({ threadId }) => threadId)).toEqual([thread, thread]);
    expect(completed.agentDispatch?.jobs[0]?.assignments).toEqual([expect.objectContaining({ executor: "执行者 1", status: "completed", attempt: 1 })]);
    expect(executorHomes(directory)).toEqual(homes);
    expect(await onlyRolloutRemains(homes[0]!, thread)).toBe(kept);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("finishes on the next start a compaction that a crash cut off, with the rollout intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-home-compaction-crash-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    // The fixture-only hold stops compaction after its first removal and blocks the service until it is killed.
    running = await start(directory, { WORKFLOW_FIXTURE_COMPACTION_HOLD: "1" });
    await running.post("/api/fixture/inbound", groupMessage("om_compaction_held", "帮我整理闲鱼商品描述", decision("alice", "整理闲鱼商品描述"),
      { modelReply: executorReply("商品文案已整理好。", "整理闲鱼商品描述") }));
    const deadline = Date.now() + processWaitLimitMs;
    while (!existsSync(join(directory, "fixture-compaction-held"))) {
      if (Date.now() > deadline) throw new Error("compaction hold not reached");
      await delay(25);
    }
    await running.crash(); running = undefined;
    const [home] = executorHomes(directory);
    const cut = homeListing(home!), rollout = cut.find((entry) => /\/rollout-[^/]+\.jsonl$/u.test(entry))!;
    expect(cut).toEqual(expect.arrayContaining(["codex-home/config.toml", "workspace/", rollout]));
    const hash = sha256(join(home!, rollout));
    running = await start(directory);
    console.log(JSON.stringify({ kind: "dispatch_home_compaction_crash", command: "帮我整理闲鱼商品描述", cut, home: homeListing(home!) }));
    expect(await onlyRolloutRemains(home!)).toBe(rollout);
    expect(sha256(join(home!, rollout))).toBe(hash);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("compacts the Executor homes left before the upgrade at the first start, and no other runtime home", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-home-compaction-upgrade-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    // Session rows as the executor before compaction wrote them: the production class without homes, over a fake App Server conversation.
    const scopes: string[] = [];
    const recorder = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
      agents: [{ id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_aaaaaaaaaaaaaaaa" }],
      runtimes: new RuntimePool<DispatchRuntime>({ limit: 1, idleMs: 1000, close: ({ agent }) => agent.close() }),
      createRuntime: (_job, scope) => { scopes.push(scope); return { agent: conversation(scopes.length === 1 ? "thread-ended" : "thread-recorded"), cwd: join(directory, scope) }; },
      tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
      profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: () => "contract-1", execute: async () => { throw new Error("no tool calls"); } } }),
      contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
      memory: () => "", capture: async () => {}, existingResult: () => undefined,
    });
    const job = { id: "om_before_upgrade", bindingHash: "binding", agentId: "alice", senderAccountId: "cli_aaaaaaaaaaaaaaaa", summary: "整理商品文案", status: "running" as const, attempt: 0,
      event: { key: "om_before_upgrade", accountId: "cli_0123456789abcdef", target: "feishu.group.oc_alpha", senderId: "ou_owner", conversationType: "group" as const,
        messageId: "om_before_upgrade", source: "text" as const, text: "帮我整理商品文案", receivedAt: 1 } };
    for (const id of ["om_before_upgrade:assignment:0", "om_before_upgrade:assignment:1"]) {
      await recorder.run(job, { id, requestId: job.id, teamId: "alice", profileId: "executor-1", profileName: "能力档 1", executor: "执行者 1",
        title: "整理商品文案", brief: "整理闲鱼商品描述", status: "running", attempt: 0 }, new AbortController().signal);
    }
    await recorder.close();
    const root = join(directory, "group-model-runtimes"), home = (name: string) => join(root, name);
    seedExecutorHome(home(scopes[0]!), [{ threadId: "thread-ended" }]);
    seedExecutorHome(home(scopes[1]!), [{ threadId: "thread-other" }]);
    seedExecutorHome(home(`dispatch-${"0".repeat(64)}`), [{ threadId: "thread-pre05" }]);
    const others = [`dispatch-leader-${"b".repeat(64)}`, "dispatch-coordinator", "feishu.group.seeded-elsewhere"];
    for (const name of others) seedExecutorHome(home(name), [{ threadId: "thread-other" }]);
    const unchanged = Object.fromEntries([scopes[1]!, ...others].map((name) => [name, homeListing(home(name))]));
    running = await start(directory);
    console.log(JSON.stringify({ kind: "dispatch_home_compaction_upgrade", homes: Object.fromEntries(readdirSync(root).map((name) => [name, homeListing(home(name))])),
      diagnostics: running.output().split("\n").filter((line) => line.startsWith("dispatch_executor_home")) }));
    expect(homeListing(home(scopes[0]!))).toEqual(keptListing("thread-ended"));
    expect(homeListing(home(`dispatch-${"0".repeat(64)}`))).toEqual(keptListing("thread-pre05"));
    expect(Object.fromEntries(Object.keys(unchanged).map((name) => [name, homeListing(home(name))]))).toEqual(unchanged);
    expect(running.output().split("\n").filter((line) => line.startsWith("dispatch_executor_home"))).toEqual([`dispatch_executor_home_kept:rollout_missing:${scopes[1]}`]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// Several Assignments per request. Each Assignment's Executor turn takes its own injected fixture turn by title
// (`executorTurns`), so the cases can hold, release and script each Executor apart (agent-dispatch Testing Decisions).
type Running = Awaited<ReturnType<typeof start>>;
async function allowNotes(running: Running) {
  await running.until((state) => state.channels?.feishu?.ready === true);
  const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
  await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
    scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
}
const writeFile = (file: string) => ({ namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: file, content: `内容 ${file}`, overwrite: false } });
const writeAndSend = (file: string) => [writeFile(file),
  { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 0, path: ["fileRef"] } }] } }];
const divided = (titles: readonly string[], decisions: string[] = []) => ({ assignments: titles.map((title) => ({ profileId: "executor-1", title, brief: `${title}，按原消息要求` })), decisions });
const blocked = (message: string, subject: string) => JSON.stringify({ message, results: [{ subject, status: "blocked" }] });
const control = (requestId: string, kind: string) => ({ kind, agentId: null, requestId, summary: "", message: "" });
const jackTexts = (state: Awaited<ReturnType<Running["state"]>>) => state.agentFixtureOutboxes?.jack?.text.map(({ message }) => message) ?? [];
const sendRuns = (state: Awaited<ReturnType<Running["state"]>>) => state.workflows?.runs.filter(({ workflowId }) => workflowId === "weixin.send-files") ?? [];

it("runs a plan's three Assignments with one Executor each, each with its own workflow run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-three-")), business = mkdtempSync(join(tmpdir(), "dispatch-three-files-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_three", "写周报和月报并发给我，再整理要点", decision("jack", "写周报、月报和要点"), {
      leaderPlan: divided(["写周报", "写月报", "整理要点"], ["先写周报和月报，再整理要点"]),
      executorTurns: { 写周报: { modelToolCalls: writeAndSend("weekly.txt") }, 写月报: { modelToolCalls: writeAndSend("monthly.txt") },
        整理要点: { modelReply: executorReply("要点已整理。", "要点") } } }));
    const result = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && jackTexts(state).length === 3);
    console.log(JSON.stringify({ kind: "dispatch_three_assignments", command: "写周报和月报并发给我，再整理要点", jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes,
      runs: sendRuns(result) }));
    expect(jackTexts(result).slice(0, 2)).toEqual(["我安排：\n执行者 1（能力档 1）处理：写周报\n执行者 2（能力档 1）处理：写月报\n执行者 3（能力档 1）处理：整理要点\n完成后会在本群汇报。",
      "先写周报和月报，再整理要点"]);
    // Each Executor's send is its own workflow run; one shared key would make the second a duplicate of the first.
    expect(sendRuns(result).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    expect(new Set(sendRuns(result).map(({ runRef }) => runRef)).size).toBe(2);
    expect(result.agentFixtureOutboxes?.jack?.media.map((item) => (item as { fileName: string }).fileName).sort()).toEqual(["monthly.txt", "weekly.txt"]);
    expect(result.fixtureModelRequests).toHaveLength(3);
    for (const title of ["写周报", "写月报", "整理要点"]) {
      expect(result.fixtureModelRequests!.filter(({ input }) => JSON.stringify(input).includes(`${title}，按原消息要求`))).toHaveLength(1);
    }
    expect(result.agentDispatch?.jobs[0]?.assignments.map(({ executor, status }) => `${executor}:${status}`)).toEqual(["执行者 1:completed", "执行者 2:completed", "执行者 3:completed"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("keeps the others when one fails, and reruns only it on retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-partial-")), business = mkdtempSync(join(tmpdir(), "dispatch-partial-files-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_partial", "写周报，核对数据，再整理要点", decision("jack", "周报、核对和要点"), {
      leaderPlan: divided(["写周报", "核对数据", "整理要点"]),
      executorTurns: { 写周报: { modelToolCalls: [writeFile("weekly.txt")], modelReply: executorReply("周报已保存。", "周报"), modelHold: true },
        核对数据: { modelReply: blocked("数据源不可读，无法核对。", "核对数据") }, 整理要点: { modelReply: executorReply("要点已整理。", "要点"), modelHold: true } } }));
    // The failure is posted while the other two are still held.
    const failing = await running.until((state) => jackTexts(state).length === 2);
    expect(jackTexts(failing)[1]).toBe("执行者 2（能力档 1）的分工「核对数据」未能完成：执行者报告无法完成。其余分工继续处理。");
    for (const title of ["写周报", "整理要点"]) await running.post("/api/fixture/feishu/inbound", { modelControl: { messageId: "om_partial", title, action: "release" } });
    const partial = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "partially_failed" && jackTexts(state).length === 3);
    expect(jackTexts(partial)[2]).toContain("已确认完成 1 次本地文件修改");
    const requestId = partial.agentDispatch!.jobs[0]!.id;
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_partial_retry", "重试核对数据", control(requestId, "retry"), {
      executorTurns: { 核对数据: { modelReply: executorReply("数据已核对。", "核对数据") } } }));
    const retried = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && jackTexts(state).length === 5);
    console.log(JSON.stringify({ kind: "dispatch_partial_failure_retry", commands: ["写周报，核对数据，再整理要点", "重试核对数据"], jobs: retried.agentDispatch, outboxes: retried.agentFixtureOutboxes }));
    expect(jackTexts(retried)[3]).toBe("我安排执行者 2（能力档 1）处理：核对数据。完成后会在本群汇报。");
    expect(retried.fixtureModelRequests).toHaveLength(4);
    expect(JSON.stringify(retried.fixtureModelRequests![3]!.input)).toContain("核对数据，按原消息要求");
    const journal = new LocalFileOperationStore(join(directory, "local-file-operations.sqlite"));
    try { expect(journal.dispatchEvidence(requestId)).toEqual({ completed: 1, unknown: 0 }); } finally { journal.close(); }
    expect(retried.agentDispatch?.jobs[0]?.assignments.map(({ executor, status, attempt }) => `${executor}:${status}:${attempt}`))
      .toEqual(["执行者 1:completed:0", "执行者 2:completed:1", "执行者 3:completed:0"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("cancels the unfinished Assignments of a request and reports the completed one's effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-cancel-three-")), business = mkdtempSync(join(tmpdir(), "dispatch-cancel-three-files-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_cancel_three", "写周报，核对数据，再整理要点", decision("jack", "周报、核对和要点"), {
      leaderPlan: divided(["写周报", "核对数据", "整理要点"]),
      // The completed Assignment writes and sends its file, so its evidence is found by its own workflow key.
      executorTurns: { 写周报: { modelToolCalls: writeAndSend("weekly.txt") },
        核对数据: { modelHold: true }, 整理要点: { modelHold: true } } }));
    const busy = await running.until((state) => state.agentDispatch?.jobs[0]?.assignments.map(({ status }) => status).join() === "completed,running,running" &&
      state.fixtureModelRequests?.length === 3);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_cancel_three_stop", "都停下", control(busy.agentDispatch!.jobs[0]!.id, "cancel")));
    const cancelled = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "cancelled" && jackTexts(state).length === 2);
    console.log(JSON.stringify({ kind: "dispatch_cancel_three", commands: ["写周报，核对数据，再整理要点", "都停下"], jobs: cancelled.agentDispatch, outboxes: cancelled.agentFixtureOutboxes }));
    expect(jackTexts(cancelled)[1]).toBe("已停止继续处理：\n执行者 1「写周报」已完成\n执行者 2「核对数据」已停止\n执行者 3「整理要点」已停止\n" +
      "已确认完成 1 次本地文件修改。已确认提交 1 个文件或媒体附件。已经完成的操作不会自动撤销。");
    expect(cancelled.agentDispatch?.jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "cancelled", "cancelled"]);
    expect(readFileSync(join(business, "demo-vault", "weekly.txt"), "utf8")).toBe("内容 weekly.txt");
    expect(cancelled.fixtureModelRequests).toHaveLength(3);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("reruns the Assignments a supplement affects, each with the supplement and its own workflow run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-supplement-keys-")), business = mkdtempSync(join(tmpdir(), "dispatch-supplement-keys-files-"));
  let running: Running | undefined;
  const titles = ["写周报", "写月报", "整理要点"];
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_supplied", "写周报和月报，再整理要点", decision("jack", "周报、月报和要点"), {
      leaderPlan: divided(titles), executorTurns: Object.fromEntries(titles.map((title) => [title, { modelReply: executorReply(`${title}完成。`, title), modelHold: true }])) }));
    const busy = await running.until((state) => state.fixtureModelRequests?.length === 3);
    const requestId = busy.agentDispatch!.jobs[0]!.id;
    // The supplement arrives while all three run; the Coordinator's clarification afterwards shows it was taken in.
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_supplied_more", "补充：周报和月报都另存为文件发给我", control(requestId, "supplement"), {
      leaderSupplement: { affected: [1, 2], assignments: [], decisions: [] },
      executorTurns: { 写周报: { modelToolCalls: writeAndSend("weekly.txt") }, 写月报: { modelToolCalls: writeAndSend("monthly.txt") } } }));
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_supplied_barrier", "另一个问题", { kind: "clarify", agentId: null, requestId: null, summary: "", message: "请说明另一个问题。" }));
    await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    for (const title of titles) await running.post("/api/fixture/feishu/inbound", { modelControl: { messageId: "om_supplied", title, action: "release" } });
    const done = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && state.agentDispatch.jobs[0].assignments.some(({ attempt }) => attempt === 1) && jackTexts(state).length === 4);
    console.log(JSON.stringify({ kind: "dispatch_supplement_keys", commands: ["写周报和月报，再整理要点", "补充：周报和月报都另存为文件发给我"], jobs: done.agentDispatch,
      outboxes: done.agentFixtureOutboxes, leader: done.fixtureLeaderRequests, runs: sendRuns(done) }));
    expect(jackTexts(done)[2]).toBe("我安排：\n执行者 1（能力档 1）处理：写周报\n执行者 2（能力档 1）处理：写月报\n完成后会在本群汇报。");
    // Only the two affected Executors ran again, each on the supplement; the third received nothing.
    const reruns = done.fixtureModelRequests!.slice(3).map(({ input }) => JSON.stringify(input));
    expect(reruns).toHaveLength(2);
    for (const rerun of reruns) expect(rerun).toContain("用户消息：\\n补充：周报和月报都另存为文件发给我");
    expect(reruns.filter((rerun) => rerun.includes("写周报，按原消息要求"))).toHaveLength(1);
    expect(reruns.filter((rerun) => rerun.includes("写月报，按原消息要求"))).toHaveLength(1);
    expect(sendRuns(done).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    expect(new Set(sendRuns(done).map(({ runRef }) => runRef)).size).toBe(2);
    expect(done.fixtureLeaderRequests?.map(({ phase }) => phase)).toEqual(["plan", "close", "supplement", "close"]);
    expect(done.agentDispatch?.jobs[0]?.assignments.map(({ executor, attempt }) => `${executor}:${attempt}`)).toEqual(["执行者 1:1", "执行者 2:1", "执行者 3:0"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("reports interrupted Assignments after a crash and closes the request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-crash-three-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_crash_three", "写周报，核对数据，再整理要点", decision("jack", "周报、核对和要点"), {
      leaderPlan: divided(["写周报", "核对数据", "整理要点"]),
      executorTurns: { 写周报: { modelReply: executorReply("周报已写好。", "周报") }, 核对数据: { modelHold: true }, 整理要点: { modelHold: true } } }));
    await running.until((state) => state.agentDispatch?.jobs[0]?.assignments.map(({ status }) => status).join() === "completed,running,running" &&
      state.fixtureModelRequests?.length === 3);
    await running.crash(); running = undefined;
    running = await start(directory);
    const recovered = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "partially_failed" && jackTexts(state).length === 3);
    console.log(JSON.stringify({ kind: "dispatch_crash_three", command: "写周报，核对数据，再整理要点", jobs: recovered.agentDispatch, outboxes: recovered.agentFixtureOutboxes }));
    expect(jackTexts(recovered).slice(0, 2)).toEqual([
      "服务中断，执行者 2（能力档 1）的分工「核对数据」已中断，无法确认已完成的内容，不会自动重放。",
      "服务中断，执行者 3（能力档 1）的分工「整理要点」已中断，无法确认已完成的内容，不会自动重放。"]);
    expect(recovered.agentDispatch?.jobs[0]?.assignments.map(({ status }) => status)).toEqual(["completed", "interrupted", "interrupted"]);
    expect(recovered.fixtureModelRequests).toEqual([]);
    expect(recovered.fixtureLeaderRequests?.map(({ phase }) => phase)).toEqual(["close"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// Cross-team work through the Coordinator (agent-dispatch::REQ-013, US-003/AC-04, REQ-010/AC-01). The engine's rules are covered at
// the AgentDispatch boundary; this case shows main's wiring: the injected cross-team decision and per-team plans reach the production
// turns, and the other team's Executor runs, sends and remembers under its own team.
it("places a part with another team through main, whose Executor sends its file under its own Team Leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-cross-team-")), business = mkdtempSync(join(tmpdir(), "dispatch-cross-team-files-"));
  let running: Running | undefined;
  const texts = (state: Awaited<ReturnType<Running["state"]>>, team: string) => state.agentFixtureOutboxes?.[team]?.text.map(({ message }) => message) ?? [];
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_cross_team", "商品 D 要上架：写详情，再弄个脚本以后自动上架", decision("alice", "商品 D 上架"), {
      leaderPlan: { assignments: [{ profileId: "executor-1", title: "撰写商品详情", brief: "九成新，128G" }], decisions: [], help: [{ title: "自动上架脚本", brief: "只交付代码，不运行" }] },
      leaderClosing: { message: "ALICE_CLOSING" },
      crossTeamDecision: { assignments: [{ part: 1, agentId: "jack", summary: "编写自动上架脚本" }] },
      teamTurns: { jack: { leaderPlan: { assignments: [{ profileId: "executor-1", title: "编写上架脚本", brief: "保存为 listing.txt 并发到本群" }], decisions: [], help: [] },
        leaderClosing: { message: "JACK_CLOSING" } } },
      executorTurns: { 撰写商品详情: { modelReply: executorReply("详情已写好。", "详情") }, 编写上架脚本: { modelToolCalls: writeAndSend("listing.txt") } } }));
    const result = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && texts(state, "alice").length === 2 && texts(state, "jack").length === 2);
    console.log(JSON.stringify({ kind: "dispatch_cross_team", command: "商品 D 要上架：写详情，再弄个脚本以后自动上架", jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes,
      coordinator: result.feishuFixtureTextOutbox, leader: result.fixtureLeaderRequests }));
    expect(texts(result, "alice")).toEqual(["我安排：\n执行者 1（能力档 1）处理：撰写商品详情\n自动上架脚本需要其他团队支持，已请 Sam 协调。\n完成后会在本群汇报。", "ALICE_CLOSING"]);
    expect(result.feishuFixtureTextOutbox?.map(({ message }) => message)).toEqual(["应 Alice 请求，自动上架脚本交给 Jack 队；完成后经 Sam 交回 Alice 汇总。"]);
    expect(texts(result, "jack")).toEqual(["我安排执行者 2（能力档 1）处理：编写上架脚本。完成后经 Sam 交回 Alice 汇总。", "JACK_CLOSING\n结果经 Sam 交回 Alice 汇总。"]);
    // The file of Jack's Executor goes out under Jack's application, in the original group (agent-dispatch::REQ-010/AC-01).
    expect(result.agentFixtureOutboxes?.jack?.media.map((item) => item as { chatId: string; fileName: string }).map(({ chatId, fileName }) => ({ chatId, fileName })))
      .toEqual([{ chatId: "oc_alpha", fileName: "listing.txt" }]);
    expect(result.agentFixtureOutboxes?.alice?.media).toEqual([]);
    expect(result.agentDispatch?.jobs[0]?.assignments.map(({ teamId, executor }) => `${teamId}:${executor}`)).toEqual(["alice:执行者 1", "jack:执行者 2"]);
    expect(result.fixtureModelRequests!.filter(({ input }) => JSON.stringify(input).includes("你是 Jack 团队的执行者 2"))).toHaveLength(1);
    // Each Executor's runtime is created for its own team's Team Leader.
    expect(result.fixtureThreadStarts!.map(({ serviceName }) => serviceName).filter((name) => String(name).startsWith("feishu_agent_")).sort()).toEqual(["feishu_agent_alice", "feishu_agent_jack"]);
    // Jack's Executor remembers into Jack's profile scope in this conversation (agent-dispatch::REQ-012/AC-03).
    const owner = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"))).entries.find((entry) => entry.channel === "feishu")!.owner;
    const alpha = owner.groupAddress("oc_alpha")!, jackProfile = memoryAccountId(owner.memoryScope(alpha.accountId, alpha.target), { kind: "profile", teamId: "jack", profileId: "executor-1" });
    const curated = await running.until((state) => state.fixtureMemoryCurations?.some(({ accountId }) => accountId === jackProfile) === true);
    expect(curated.fixtureMemoryCurations!.find(({ accountId }) => accountId === jackProfile)!.turns).toEqual([expect.objectContaining({ user: "编写上架脚本\n保存为 listing.txt 并发到本群" })]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

// agent-dispatch::REQ-010/AC-01 and REQ-008/AC-01 through main: a retried cross-team Assignment whose workflow run already exists
// reports that run under its own team instead of running again, which reaches main's check of the run's sending application.
it("reports a retried cross-team Assignment's existing workflow run instead of running it again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-cross-team-retry-")), business = mkdtempSync(join(tmpdir(), "dispatch-cross-team-retry-files-"));
  let running: Running | undefined;
  const texts = (state: Awaited<ReturnType<Running["state"]>>, team: string) => state.agentFixtureOutboxes?.[team]?.text.map(({ message }) => message) ?? [];
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    // Jack's application refuses the file, so the send run fails after it exists, and so does Jack's Assignment.
    await running.post("/api/fixture/feishu/inbound", { applicationControl: { agentId: "jack", mediaOutcomes: ["rejected"] } });
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_cross_retry", "商品 D 要上架：写详情，再弄个脚本以后自动上架", decision("alice", "商品 D 上架"), {
      leaderPlan: { assignments: [{ profileId: "executor-1", title: "撰写商品详情", brief: "九成新" }], decisions: [], help: [{ title: "自动上架脚本", brief: "只交付代码，不运行" }] },
      crossTeamDecision: { assignments: [{ part: 1, agentId: "jack", summary: "编写自动上架脚本" }] },
      teamTurns: { jack: { leaderPlan: { assignments: [{ profileId: "executor-1", title: "编写上架脚本", brief: "保存为 listing.txt 并发到本群" }], decisions: [], help: [] } } },
      executorTurns: { 撰写商品详情: { modelReply: executorReply("详情已写好。", "详情") }, 编写上架脚本: { modelToolCalls: writeAndSend("listing.txt") } } }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "partially_failed" && texts(state, "jack").length === 2);
    const requestId = failed.agentDispatch!.jobs[0]!.id, turns = failed.fixtureModelRequests!.length;
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_cross_retry_again", "重试", control(requestId, "retry")));
    const retried = await running.until((state) => texts(state, "jack").length === 4 && state.agentDispatch?.jobs[0]?.assignments.some(({ attempt }) => attempt === 1) === true &&
      ["partially_failed", "completed"].includes(state.agentDispatch.jobs[0]!.status));
    console.log(JSON.stringify({ kind: "dispatch_cross_team_retry", commands: ["商品 D 要上架：写详情，再弄个脚本以后自动上架", "重试"], jobs: retried.agentDispatch, outboxes: retried.agentFixtureOutboxes }));
    expect(retried.fixtureModelRequests).toHaveLength(turns);
    expect(texts(retried, "jack")[2]).toBe("我安排执行者 2（能力档 1）处理：编写上架脚本。完成后经 Sam 交回 Alice 汇总。");
    // The closing reports the run's own result, under Jack's identity; a failed identity check would name a changed authority instead.
    expect(texts(retried, "jack")[3]).not.toContain("权限或可用上下文发生变化");
    expect(texts(retried, "jack")[3]).toBe(texts(failed, "jack")[1]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);
