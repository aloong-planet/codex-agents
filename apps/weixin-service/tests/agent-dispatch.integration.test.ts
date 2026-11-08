import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { TeamRegistry } from "../src/team-registry.js";
import { PRODUCTION_TOOL_IDS } from "./support/production-tools.js";
import { dispatchConfig, groupMessage, start } from "./support/real-main.js";

// Real main composition through the fixture-only Feishu ingress; the model and every Feishu application are fixtures.
// Fixture mode substitutes the Coordinator's decisions, so its runtime's tool-free construction is covered by agent-profile.test.ts
// and agent-dispatch-classifier.test.ts, not here. Registry versions are saved through TeamRegistry, the store's own public class.

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
    const alice = inputs.filter((input) => input.includes("你是 Alice")), bill = inputs.filter((input) => input.includes("你是 Bill"));
    expect([alice.length, bill.length]).toEqual([1, 1]);
    for (const input of [alice[0]!, bill[0]!]) expect(input).toContain("交付文件前复核其事实与来源是否相符");
    expect(alice[0]).not.toContain("出行路线");
    expect(alice[0]).not.toContain("预算和时间安排");
    expect(bill[0]).toContain("出行路线须逐段核对站名、线路和换乘站");
    expect(bill[0]).toContain("交付文件前复核预算和时间安排是否自洽");
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
