import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { TeamRegistry } from "../src/team-registry.js";
import { dispatchConfig, start } from "./support/real-main.js";

// Real main composition through the fixture-only Feishu ingress; the model and every Feishu application are fixtures.
// No console API reads the team registry yet, so these cases read and save it through TeamRegistry, the store's own public class,
// on main's state directory. Registry rules themselves are covered in team-registry.test.ts.
const PRODUCTION_TOOL_IDS = ["files.edit", "files.find", "files.grep", "files.read", "files.write", "media.send", "schedules.create", "schedules.delete",
  "schedules.disable", "schedules.edit", "schedules.enable", "schedules.inspect", "schedules.list", "schedules.read_text", "schedules.retry_news",
  "schedules.run_now", "weixin.send_files"];
const groupMessage = (messageId: string, text: string, dispatchDecision: unknown) => ({
  event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text }), mentions: [] } }, dispatchDecision });

it("imports the local configuration into the team registry on first start, and the specialist turn carries its Executor profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-registry-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_registry_seed", "请帮我规划周末一日行程",
      { kind: "dispatch", agentId: "bill", requestId: null, summary: "规划周末一日行程", message: "" }));
    const result = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    console.log(JSON.stringify({ kind: "team_registry_seed", command: "请帮我规划周末一日行程", jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    await running.close(); running = undefined;
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const current = registry.current()!;
      expect({ version: current.version, source: current.source, teams: current.definitions.teams.map(({ id }) => id) })
        .toEqual({ version: 1, source: "local_configuration", teams: ["alice", "bill", "jack"] });
      const profiles = current.definitions.teams.find(({ id }) => id === "bill")!.executorProfiles;
      expect(profiles.map(({ hostTools }) => hostTools)).toEqual([PRODUCTION_TOOL_IDS]);
      expect(profiles[0]!.instructions).toContain("出行路线须逐段核对站名、线路和换乘站");
      expect(result.fixtureModelRequests).toHaveLength(1);
      expect(JSON.stringify(result.fixtureModelRequests![0]!.input)).toContain(profiles[0]!.instructions);
    } finally { registry.close(); }
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("follows a console-saved registry version instead of the local configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-registry-console-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    const parsed = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8")));
    const local = parsed.entries.find((entry) => entry.channel === "feishu")?.dispatch;
    if (!local) throw new Error("expected_dispatch_configuration");
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(local, { executorHostTools: [] });
      registry.save({ ...seeded.definitions, teams: seeded.definitions.teams.map((team) => team.id === "bill"
        ? { ...team, leader: { ...team.leader, name: "Bella" } } : team) }, { basedOn: seeded.version });
    } finally { registry.close(); }
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_registry_console", "周末可能想去附近玩玩",
      { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" }));
    const proposed = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    console.log(JSON.stringify({ kind: "team_registry_console_save", command: "周末可能想去附近玩玩", jobs: proposed.agentDispatch, outbox: proposed.fixtureTextOutbox }));
    expect(proposed.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["要不要请 Bella 帮你安排周末出行？请回复这条建议确认，或告诉我暂时不用。"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);
