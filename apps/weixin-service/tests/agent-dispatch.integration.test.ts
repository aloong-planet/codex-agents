import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { TeamRegistry } from "../src/team-registry.js";
import { PRODUCTION_TOOL_IDS } from "./support/production-tools.js";
import { dispatchConfig, groupMessage, start } from "./support/real-main.js";

// Real main composition through the fixture-only Feishu ingress; the model and every Feishu application are fixtures.
// Registry versions are saved through TeamRegistry, the store's own public class. Fixture mode injects already-decoded Coordinator
// decisions and Team Leader plans (agent-dispatch Testing Decisions); main still passes them through the production correction loop,
// validation and effects. The Coordinator's and Team Leaders' real runtime construction is driven by the case that sets
// WORKFLOW_FIXTURE_COORDINATION_RUNTIME, where the fixture App Server answers their turns with the same injected outputs.
// Gap: a live run is still needed for real model semantics and for the default Team Leader runtimes outside that seam.

it("keeps travel rules in Bill's turn only, with the shared facts-and-sources check in every turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-profile-text-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_profile_alice", "帮我整理闲鱼商品描述", { kind: "dispatch", agentId: "alice", requestId: null, summary: "整理闲鱼商品描述", message: "" }));
    await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    await running.post("/api/fixture/inbound", groupMessage("om_profile_bill", "请帮我规划周末一日行程", { kind: "dispatch", agentId: "bill", requestId: null, summary: "规划周末一日行程", message: "" }));
    const result = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    console.log(JSON.stringify({ kind: "dispatch_profile_text", commands: ["帮我整理闲鱼商品描述", "请帮我规划周末一日行程"], jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    const inputs = result.fixtureModelRequests!.map(({ input }) => JSON.stringify(input));
    const alice = inputs.filter((input) => input.includes("你是 Alice 团队的执行者")), bill = inputs.filter((input) => input.includes("你是 Bill 团队的执行者"));
    expect([alice.length, bill.length]).toEqual([1, 1]);
    for (const input of [alice[0]!, bill[0]!]) expect(input).toContain("交付文件前复核其事实与来源是否相符");
    // One fragment from each Bill-only rule group: weather, route, walking, opening hours, budget and schedule.
    for (const fragment of ["天气等持续更新的信息", "出行路线", "步行入口", "开放时间、预约要求", "预算和时间安排"]) {
      expect(alice[0]).not.toContain(fragment);
      expect(bill[0]).toContain(fragment);
    }
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
      reply: "商品文案已整理：标题、描述和买家问答，电池健康度标为待确认。", closing: "闲鱼商品文案已整理好，电池健康度请你补充确认。" },
    { team: "bill", messageId: "om_team_bill", text: "帮我规划周六南京一日游，两人，预算 400 元", summary: "规划南京一日游",
      reply: "南京一日行程已规划：交通、餐饮和预算估算，天气按官方预报核对。", closing: "南京一日行程已规划好，预算估算与已核实信息分开标注。" },
    { team: "jack", messageId: "om_team_jack", text: "TypeScript 函数 discount 可能返回负数，请给出补丁和回归测试", summary: "修复 discount 负数问题",
      reply: "补丁与 3 个回归用例已给出，测试尚未运行。", closing: "discount 补丁和 3 个回归用例已给出，测试尚未运行。" },
  ];
  try {
    dispatchConfig(directory);
    running = await start(directory);
    for (const [index, request] of requests.entries()) {
      const message = groupMessage(request.messageId, request.text, decision(request.team, request.summary),
        { modelReply: executorReply(request.reply, request.summary), leaderClosing: { message: request.closing } });
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
        { chatId: "oc_alpha", message: `我安排执行者 ${index + 1}（能力档 1）处理：${request.summary}。完成后会在本群汇报。` },
        { chatId: "oc_alpha", message: request.closing },
      ]);
      expect(result.agentDispatch?.jobs[index]).toMatchObject({ agentId: request.team, status: "completed", requester: "ou_owner", definitionsVersion: 1,
        assignments: [{ teamId: request.team, profileId: "executor-1", executor: `执行者 ${index + 1}`, title: request.summary, status: "completed", attempt: 0 }] });
      expect(JSON.stringify(result.fixtureModelRequests![index]!.input)).toContain(`你是 ${request.team[0]!.toUpperCase()}${request.team.slice(1)} 团队的执行者 ${index + 1}`);
      expect(JSON.stringify(result.fixtureModelRequests![index]!.input)).toContain(request.summary);
    }
    expect(result.fixtureTextOutbox).toEqual([]);
    const posted = JSON.stringify([result.agentFixtureOutboxes, result.fixtureTextOutbox]);
    for (const { reply } of requests) expect(posted).not.toContain(reply);
    expect(result.fixtureLeaderRequests?.map(({ phase, teamId }) => `${phase}:${teamId}`)).toEqual(["plan:alice", "close:alice", "plan:bill", "close:bill", "plan:jack", "close:jack"]);
    for (const [index, request] of requests.entries()) {
      const [plan, close] = [result.fixtureLeaderRequests![index * 2]!, result.fixtureLeaderRequests![index * 2 + 1]!];
      expect(plan.input.brief).toEqual({ message: request.text, summary: request.summary });
      expect(close.input.assignments).toEqual([{ title: request.summary, executor: `执行者 ${index + 1}`, status: "completed", result: request.reply }]);
    }
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("corrects a plan once, and fails a request whose plan stays invalid", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-leader-correction-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const foreign = { assignments: [{ profileId: "jack-only", title: "规划行程", brief: "南京一日游" }] };
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_corrected_plan", "帮我规划周末一日行程", decision("bill", "规划行程"),
      { leaderPlan: [foreign, { assignments: [{ profileId: "executor-1", title: "规划行程", brief: "南京一日游" }] }] }));
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
      { status: "completed", definitionsVersion: 1, assignments: 1 },
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
    expect(controlled.agentDispatch?.jobs[2]).toMatchObject({ definitionsVersion: 1, assignments: [expect.objectContaining({ teamId: "jack", status: "completed" })] });
    expect(controlled.agentDispatch?.jobs[4]).toMatchObject({ definitionsVersion: null, assignments: [] });
    expect(controlled.agentFixtureOutboxes?.alice?.media).toEqual([expect.objectContaining({ chatId: "oc_alpha", fileName: "Agent Beta.md" })]);
    expect(controlled.agentDispatch?.jobs[3]).toMatchObject({ definitionsVersion: 1, assignments: [expect.objectContaining({ teamId: "jack", status: "completed" })] });
    expect(readFileSync(join(business, "demo-vault", "sample.txt"), "utf8")).toBe("xx\n");
    // Plans only for the requests the new code ran: the queued one, the confirmed proposal and the retried failure. The choice ran no Team Leader turn.
    expect(controlled.fixtureLeaderRequests?.filter(({ phase }) => phase === "plan").map(({ teamId }) => teamId)).toEqual(["bill", "jack", "jack"]);
  } finally {
    await running?.close();
    for (const path of [directory, business, checkout]) rmSync(path, { recursive: true, force: true });
  }
}, 90000);
