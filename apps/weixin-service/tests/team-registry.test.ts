import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { TeamRegistry, type TeamDefinitions } from "../src/team-registry.js";

// Registry seam only. The local configuration follows the documented shape in docs/ops/feishu-agent-dispatch.md;
// the owner's real channel.json is production data and is not read. Real-main wiring is in team-management.integration.test.ts.
const TODAY_EXECUTOR_INSTRUCTIONS = "需要实时信息时先检索并读取可靠来源，来源必须支持对应事实，不能只把链接列在文末冒充查证。搜索摘要可能缓存旧内容，天气等持续更新的信息必须打开官方页面核对发布时间，注明来源发布时点；无法取得当前内容时明确标注未核实，不把旧预报写成最新预报。出行路线须逐段核对站名、线路和换乘站，不能凭记忆拼接；区分景区名称与地铁站名称。步行入口、方位、距离和耗时没有地图或官方资料支持时，不猜测具体数值或地点，标注需现场导航并预留弹性时间。开放时间、预约要求和天气须附本轮查证来源；未核实的明确标注并提供可行备选，不写成确定事实。交付文件前复核其事实与来源是否相符、预算和时间安排是否自洽。";
const HOST_TOOLS = ["files.read", "schedules.create"];
const SAM = { appId: "cli_0123456789abcdef", appSecret: "sam-secret" };

type Agent = { id: string; name?: string; responsibility?: string; appId?: string; appSecret?: string };
const defaultAgents = (): Agent[] => [{ id: "sam" },
  { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
  { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" },
  { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }];
function local(agents: Agent[] = defaultAgents(), groupChatIds = ["oc_alpha", "oc_beta"]) {
  const parsed = parseChannelStartupConfiguration({ channel: "feishu",
    owner: { memoryAccountId: "owner-memory", bindings: [{ channel: "feishu", accountId: SAM.appId, target: "oc_private", senderId: "ou_owner" }] },
    taskScope: { accountId: "owner-memory", target: "oc_private" },
    feishu: { ...SAM, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
      dispatch: { groupChatIds, agents } } });
  const feishu = parsed.entries.find((entry) => entry.channel === "feishu");
  if (!feishu?.dispatch) throw new Error("expected_dispatch_configuration");
  return feishu.dispatch;
}

function renameBill(definitions: TeamDefinitions, name: string): TeamDefinitions {
  return { ...definitions, teams: definitions.teams.map((team) => team.id === "bill" ? { ...team, leader: { ...team.leader, name } } : team) };
}

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "team-registry-"));
  directories.push(directory);
  return join(directory, "state", "team-registry.sqlite");
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("team registry", () => {
  it("seeds Sam and the three teams with today's responsibilities, applications and one Executor profile each", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const bindings = [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }];
      const executorProfiles = [{ id: "executor-1", name: "能力档 1", instructions: TODAY_EXECUTOR_INSTRUCTIONS, hostTools: HOST_TOOLS }];
      const leaderProfile = { instructions: "", hostTools: [] };
      expect(registry.current()).toEqual({ version: 1, basedOn: null, source: "local_configuration", definitions: {
        coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调、澄清和分派任务，不执行具体业务事务。",
          appId: SAM.appId, profile: { instructions: "", hostTools: [] } },
        dispatchGroups: ["oc_alpha", "oc_beta"],
        teams: [
          { id: "alice", teamName: "运营团队", responsibility: "闲鱼、淘宝等网站运营，包括商品文案、上架材料和经营分析。",
            leader: { name: "Alice", appId: "cli_1111111111111111", profile: leaderProfile }, executorProfiles, bindings },
          { id: "bill", teamName: "生活团队", responsibility: "日常生活事务，包括吃穿住行的规划和安排。",
            leader: { name: "Bill", appId: "cli_2222222222222222", profile: leaderProfile }, executorProfiles, bindings },
          { id: "jack", teamName: "技术团队", responsibility: "技术事务和开发需求，包括代码分析、补丁、测试设计和技术研究。",
            leader: { name: "Jack", appId: "cli_3333333333333333", profile: leaderProfile }, executorProfiles, bindings },
        ],
      } });
      expect(registry.version(1)).toEqual(registry.current());
    } finally { registry.close(); }
  });

  it("keeps application secrets out of every definitions version and serves them to the roster view", () => {
    const path = databasePath();
    const registry = new TeamRegistry(path);
    try {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      expect(JSON.stringify(registry.current())).not.toMatch(/sam-secret|alice-secret|bill-secret|jack-secret/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(registry.roster(SAM)).toEqual({ groupChatIds: ["oc_alpha", "oc_beta"], agents: [
        { id: "sam", name: "Sam", responsibility: "协调、澄清和分派任务，不执行具体业务事务。", appId: SAM.appId, appSecret: "sam-secret" },
        { id: "alice", name: "Alice", responsibility: "闲鱼、淘宝等网站运营，包括商品文案、上架材料和经营分析。", appId: "cli_1111111111111111", appSecret: "alice-secret" },
        { id: "bill", name: "Bill", responsibility: "日常生活事务，包括吃穿住行的规划和安排。", appId: "cli_2222222222222222", appSecret: "bill-secret" },
        { id: "jack", name: "Jack", responsibility: "技术事务和开发需求，包括代码分析、补丁、测试设计和技术研究。", appId: "cli_3333333333333333", appSecret: "jack-secret" },
      ] });
      const rotated = defaultAgents();
      rotated[2]!.appSecret = "bill-rotated";
      registry.importLocalConfiguration(local(rotated), { executorHostTools: HOST_TOOLS });
      expect(registry.current()?.version).toBe(1);
      expect(registry.roster(SAM).agents.find(({ id }) => id === "bill")?.appSecret).toBe("bill-rotated");
      expect(JSON.stringify(registry.current())).not.toContain("bill-rotated");
    } finally { registry.close(); }
  });

  it("records a new version on restart only when the imported local configuration differs", () => {
    const path = databasePath();
    const first = new TeamRegistry(path);
    first.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
    first.close();
    const registry = new TeamRegistry(path);
    try {
      expect(registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS }).version).toBe(1);
      const replaced = defaultAgents();
      replaced[1] = { id: "alice", appId: "cli_4444444444444444", appSecret: "alice-replaced" };
      const changed = registry.importLocalConfiguration(local(replaced, ["oc_beta"]), { executorHostTools: HOST_TOOLS });
      expect({ version: changed.version, basedOn: changed.basedOn, source: changed.source }).toEqual({ version: 2, basedOn: 1, source: "local_configuration" });
      expect(changed.definitions.dispatchGroups).toEqual(["oc_beta"]);
      expect(changed.definitions.teams.map(({ id, leader, bindings }) => ({ id, appId: leader.appId, bindings }))).toEqual([
        { id: "alice", appId: "cli_4444444444444444", bindings: [{ chatId: "oc_beta", state: "accepting" }] },
        { id: "bill", appId: "cli_2222222222222222", bindings: [{ chatId: "oc_beta", state: "accepting" }] },
        { id: "jack", appId: "cli_3333333333333333", bindings: [{ chatId: "oc_beta", state: "accepting" }] },
      ]);
      expect(registry.version(1)?.definitions.dispatchGroups).toEqual(["oc_alpha", "oc_beta"]);
      expect(registry.version(1)?.definitions.teams[0]?.leader.appId).toBe("cli_1111111111111111");
      expect(registry.roster(SAM).agents.find(({ id }) => id === "alice")).toMatchObject({ appId: "cli_4444444444444444", appSecret: "alice-replaced" });
    } finally { registry.close(); }
  });

  it("stops importing the local configuration after the first console save", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const saved = registry.save(renameBill(seeded.definitions, "Bella"), { basedOn: 1 });
      expect({ version: saved.version, basedOn: saved.basedOn, source: saved.source }).toEqual({ version: 2, basedOn: 1, source: "console" });
      const replaced = defaultAgents();
      replaced[2] = { id: "bill", appId: "cli_6666666666666666", appSecret: "bill-replaced" };
      expect(registry.importLocalConfiguration(local(replaced, ["oc_alpha"]), { executorHostTools: HOST_TOOLS })).toEqual(saved);
      expect(registry.current()).toEqual(saved);
      expect(registry.roster(SAM).agents.find(({ id }) => id === "bill")).toMatchObject({ name: "Bella", appId: "cli_2222222222222222", appSecret: "bill-secret" });
    } finally { registry.close(); }
  });

  it("refuses a save based on an outdated version", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const saved = registry.save(renameBill(seeded.definitions, "Bella"), { basedOn: 1 });
      expect(() => registry.save(renameBill(seeded.definitions, "Bob"), { basedOn: 1 })).toThrow(/^team_registry_version_stale$/);
      expect(registry.current()).toEqual(saved);
    } finally { registry.close(); }
  });

  const bill = (definitions: TeamDefinitions, change: (team: TeamDefinitions["teams"][number]) => TeamDefinitions["teams"][number]) =>
    ({ ...definitions, teams: definitions.teams.map((team) => team.id === "bill" ? change(team) : team) });
  it.each([
    ["a team bound to only some dispatch groups", (definitions: TeamDefinitions) => bill(definitions, (team) => ({ ...team, bindings: [{ chatId: "oc_alpha", state: "accepting" }] })), SAM, "team_registry_roster_unsupported"],
    ["a draining binding", (definitions: TeamDefinitions) => bill(definitions, (team) => ({ ...team, bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "draining" }] })), SAM, "team_registry_roster_unsupported"],
    ["two teams sharing one application", (definitions: TeamDefinitions) => bill(definitions, (team) => ({ ...team, leader: { ...team.leader, appId: "cli_3333333333333333" } })), SAM, "team_registry_roster_unsupported"],
    ["an application without a stored secret", (definitions: TeamDefinitions) => bill(definitions, (team) => ({ ...team, leader: { ...team.leader, appId: "cli_7777777777777777" } })), SAM, "team_registry_secret_missing"],
    ["a connection that is not the Coordinator's application", undefined, { appId: "cli_8888888888888888", appSecret: "other" }, "team_registry_roster_unsupported"],
    ["two teams sharing one agent ID", (definitions: TeamDefinitions) => ({ ...definitions, teams: definitions.teams.map((team) => team.id === "jack" ? { ...team, id: "bill" } : team) }), SAM, "team_registry_roster_unsupported"],
    ["a team using the Coordinator's agent ID", (definitions: TeamDefinitions) => ({ ...definitions, teams: definitions.teams.map((team) => team.id === "jack" ? { ...team, id: "sam" } : team) }), SAM, "team_registry_roster_unsupported"],
  ] as const)("refuses a roster view for %s", (_case, change, connection, code) => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const current = change ? registry.save(change(seeded.definitions), { basedOn: 1 }) : seeded;
      expect(() => registry.roster(connection)).toThrow(new RegExp(`^${code}$`));
      expect(registry.current()).toEqual(current);
    } finally { registry.close(); }
  });

  it("refuses a roster view before the first import", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      expect(registry.current()).toBeUndefined();
      expect(() => registry.roster(SAM)).toThrow(/^team_registry_empty$/);
    } finally { registry.close(); }
  });

  it("names an extra configured role's team after its leader", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      const definitions = registry.importLocalConfiguration(local([...defaultAgents(),
        { id: "lily", name: "Lily", responsibility: "视觉设计和品牌素材。", appId: "cli_5555555555555555", appSecret: "lily-secret" }]), { executorHostTools: HOST_TOOLS }).definitions;
      expect(definitions.teams.at(-1)).toEqual({ id: "lily", teamName: "Lily 团队", responsibility: "视觉设计和品牌素材。",
        leader: { name: "Lily", appId: "cli_5555555555555555", profile: { instructions: "", hostTools: [] } },
        executorProfiles: [{ id: "executor-1", name: "能力档 1", instructions: TODAY_EXECUTOR_INSTRUCTIONS, hostTools: HOST_TOOLS }],
        bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }] });
    } finally { registry.close(); }
  });
});
