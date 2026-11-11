import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { acceptingTeams, TeamDefinitionError, TeamRegistry, type TeamDefinitions, type TeamEdit } from "../src/team-registry.js";

// Registry seam only. The local configuration follows the documented shape in docs/ops/feishu-agent-dispatch.md;
// the owner's real channel.json is production data and is not read. Real-main wiring is in team-management.integration.test.ts.
// Bill's seed: sentences 2–5 of the specialist paragraph at 3601e19, plus the budget-and-schedule half of its last sentence (ticket 04, decision D2).
const BILL_EXECUTOR_INSTRUCTIONS = "搜索摘要可能缓存旧内容，天气等持续更新的信息必须打开官方页面核对发布时间，注明来源发布时点；无法取得当前内容时明确标注未核实，不把旧预报写成最新预报。出行路线须逐段核对站名、线路和换乘站，不能凭记忆拼接；区分景区名称与地铁站名称。步行入口、方位、距离和耗时没有地图或官方资料支持时，不猜测具体数值或地点，标注需现场导航并预留弹性时间。开放时间、预约要求和天气须附本轮查证来源；未核实的明确标注并提供可行备选，不写成确定事实。交付文件前复核预算和时间安排是否自洽。";
// Jack's seed: the code-and-tests example of the goal-scope rule, moved out of shared Executor text (ticket 06, Q5).
const JACK_EXECUTOR_INSTRUCTIONS = "代码与测试任务的结果报告：只要求提供代码和测试用例、明确不要运行时，交付代码和用例即可分别记 completed；测试尚未运行应在 message 中如实说明，不新增运行测试的失败项。若用户实际要求运行而未能运行，则该目标必须如实记为未完成，不能用代码审阅替代执行。";
const HOST_TOOLS = ["files.read", "schedules.create"];
const SAM = { appId: "cli_0123456789abcdef", appSecret: "sam-secret" };

type Agent = { id: string; name?: string; responsibility?: string; appId?: string; appSecret?: string };
const defaultAgents = (): Agent[] => [{ id: "sam" },
  { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
  { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" },
  { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }];
/** The parsed `feishu.dispatch` section; `agents: null` gives a groups-only section, as the console writes it. */
function local(agents: Agent[] | null = defaultAgents(), groupChatIds = ["oc_alpha", "oc_beta"], sam = SAM) {
  const parsed = parseChannelStartupConfiguration({ channel: "feishu",
    owner: { memoryAccountId: "owner-memory", bindings: [{ channel: "feishu", accountId: sam.appId, target: "oc_private", senderId: "ou_owner" }] },
    taskScope: { accountId: "owner-memory", target: "oc_private" },
    feishu: { ...sam, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
      dispatch: agents === null ? { groupChatIds } : { groupChatIds, agents } } });
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
      // Every seeded profile names its Executors 「执行者 <n>」 (ticket 11, decision D6).
      const executorProfiles = [{ id: "executor-1", name: "能力档 1", noun: "执行者", instructions: "", hostTools: HOST_TOOLS }];
      const billProfiles = [{ id: "executor-1", name: "能力档 1", noun: "执行者", instructions: BILL_EXECUTOR_INSTRUCTIONS, hostTools: HOST_TOOLS }];
      const jackProfiles = [{ id: "executor-1", name: "能力档 1", noun: "执行者", instructions: JACK_EXECUTOR_INSTRUCTIONS, hostTools: HOST_TOOLS }];
      const leaderProfile = { instructions: "", hostTools: [] };
      expect(registry.current()).toEqual({ version: 1, basedOn: null, source: "local_configuration", definitions: {
        coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调、澄清和分派任务，不执行具体业务事务。",
          appId: SAM.appId, profile: { instructions: "", hostTools: [] } },
        dispatchGroups: ["oc_alpha", "oc_beta"],
        teams: [
          { id: "alice", teamName: "运营团队", responsibility: "闲鱼、淘宝等网站运营，包括商品文案、上架材料和经营分析。",
            leader: { name: "Alice", appId: "cli_1111111111111111", profile: leaderProfile }, executorProfiles, bindings },
          { id: "bill", teamName: "生活团队", responsibility: "日常生活事务，包括吃穿住行的规划和安排。",
            leader: { name: "Bill", appId: "cli_2222222222222222", profile: leaderProfile }, executorProfiles: billProfiles, bindings },
          { id: "jack", teamName: "技术团队", responsibility: "技术事务和开发需求，包括代码分析、补丁、测试设计和技术研究。",
            leader: { name: "Jack", appId: "cli_3333333333333333", profile: leaderProfile }, executorProfiles: jackProfiles, bindings },
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

  it("after the first console save, follows only the file's dispatch groups and drops bindings to groups it no longer lists", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const saved = registry.save(renameBill(seeded.definitions, "Bella"), { basedOn: 1 });
      expect({ version: saved.version, basedOn: saved.basedOn, source: saved.source }).toEqual({ version: 2, basedOn: 1, source: "console" });
      // A roster in the file no longer changes the teams; its group list still applies.
      const replaced = defaultAgents();
      replaced[2] = { id: "bill", appId: "cli_6666666666666666", appSecret: "bill-replaced" };
      const followed = registry.importLocalConfiguration(local(replaced, ["oc_alpha"]), { executorHostTools: HOST_TOOLS });
      expect({ version: followed.version, basedOn: followed.basedOn, source: followed.source }).toEqual({ version: 3, basedOn: 2, source: "local_configuration" });
      expect(followed.definitions.dispatchGroups).toEqual(["oc_alpha"]);
      expect(followed.definitions.teams.map(({ id, bindings }) => ({ id, bindings }))).toEqual(["alice", "bill", "jack"]
        .map((id) => ({ id, bindings: [{ chatId: "oc_alpha", state: "accepting" }] })));
      expect(registry.roster(SAM).agents.find(({ id }) => id === "bill")).toMatchObject({ name: "Bella", appId: "cli_2222222222222222", appSecret: "bill-secret" });
      expect(registry.importLocalConfiguration(local(null, ["oc_alpha"]), { executorHostTools: HOST_TOOLS }).version).toBe(3);
    } finally { registry.close(); }
  });

  it("starts an empty registry from a groups-only section with the Coordinator alone", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      registry.importLocalConfiguration(local(null, ["oc_beta"]), { executorHostTools: HOST_TOOLS, coordinatorAppId: SAM.appId });
      expect(registry.current()).toEqual({ version: 1, basedOn: null, source: "local_configuration", definitions: {
        coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调、澄清和分派任务，不执行具体业务事务。",
          appId: SAM.appId, profile: { instructions: "", hostTools: [] } },
        dispatchGroups: ["oc_beta"], teams: [] } });
      expect(registry.roster(SAM)).toEqual({ groupChatIds: ["oc_beta"], agents: [
        { id: "sam", name: "Sam", responsibility: "协调、澄清和分派任务，不执行具体业务事务。", appId: SAM.appId, appSecret: "sam-secret" }] });
    } finally { registry.close(); }
  });

  it("never changes the teams or their secrets from a groups-only section, before any console save too", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const followed = registry.importLocalConfiguration(local(null, ["oc_beta"]), { executorHostTools: HOST_TOOLS, coordinatorAppId: SAM.appId });
      expect({ version: followed.version, source: followed.source }).toEqual({ version: 2, source: "local_configuration" });
      expect(followed.definitions).toEqual({ ...seeded.definitions, dispatchGroups: ["oc_beta"],
        teams: seeded.definitions.teams.map((team) => ({ ...team, bindings: [{ chatId: "oc_beta", state: "accepting" }] })) });
      expect(registry.roster(SAM).agents.map(({ id, appSecret }) => ({ id, appSecret }))).toEqual([
        { id: "sam", appSecret: "sam-secret" }, { id: "alice", appSecret: "alice-secret" }, { id: "bill", appSecret: "bill-secret" }, { id: "jack", appSecret: "jack-secret" }]);
    } finally { registry.close(); }
  });

  // Re-pairing replaces feishu.appId; Sam follows it at the next start (ticket 32). The seeded registry is set up as each variant reaches it.
  const REPAIRED = { appId: "cli_9999999999999999", appSecret: "sam-repaired" };
  it.each([
    ["after a console save, with a roster still in the file", (registry: TeamRegistry) => {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      registry.save(renameBill(seeded.definitions, "Bella"), { basedOn: seeded.version });
      return local(defaultAgents(), undefined, REPAIRED);
    }],
    ["with a groups-only section", (registry: TeamRegistry) => {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      return local(null, undefined, REPAIRED);
    }],
  ] as const)("moves Sam to a re-paired application %s, in a new version that keeps the teams and their secrets", (_case, prepare) => {
    const registry = new TeamRegistry(databasePath());
    try {
      const repaired = prepare(registry);
      const before = registry.current()!;
      const after = registry.importLocalConfiguration(repaired, { executorHostTools: HOST_TOOLS, coordinatorAppId: REPAIRED.appId });
      expect({ version: after.version, basedOn: after.basedOn, source: after.source }).toEqual({ version: before.version + 1, basedOn: before.version, source: "local_configuration" });
      expect(after.definitions).toEqual({ ...before.definitions, coordinator: { ...before.definitions.coordinator, appId: "cli_9999999999999999" } });
      expect(registry.roster(REPAIRED).agents.map(({ id, appId, appSecret }) => ({ id, appId, appSecret }))).toEqual([
        { id: "sam", appId: "cli_9999999999999999", appSecret: "sam-repaired" },
        { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
        { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" },
        { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }]);
    } finally { registry.close(); }
  });

  it("refuses to move Sam onto an application a team uses, recording no version", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const before = registry.current();
      const onBill = { appId: "cli_2222222222222222", appSecret: "bill-secret" };
      expect(() => registry.importLocalConfiguration(local(null, undefined, onBill), { executorHostTools: HOST_TOOLS, coordinatorAppId: onBill.appId }))
        .toThrow(/^team_registry_roster_unsupported$/);
      expect(registry.current()).toEqual(before);
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
    ["a binding to a chat outside the dispatch groups", (definitions: TeamDefinitions) => bill(definitions, (team) => ({ ...team, bindings: [...team.bindings, { chatId: "oc_gamma", state: "accepting" }] })), SAM, "team_registry_roster_unsupported"],
    ["two teams sharing one application", (definitions: TeamDefinitions) => bill(definitions, (team) => ({ ...team, leader: { ...team.leader, appId: "cli_3333333333333333" } })), SAM, "team_registry_roster_unsupported"],
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

  it.each([
    ["bound to only some dispatch groups", [{ chatId: "oc_alpha", state: "accepting" }]],
    ["onboarding in one group", [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "onboarding" }]],
    ["draining in one group", [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "draining" }]],
  ] as const)("serves a roster view for a team %s", (_case, bindings) => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      registry.save(bill(seeded.definitions, (team) => ({ ...team, bindings })), { basedOn: 1 });
      const roster = registry.roster(SAM);
      expect([roster.agents.map(({ id }) => id), roster.groupChatIds]).toEqual([["sam", "alice", "bill", "jack"], ["oc_alpha", "oc_beta"]]);
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
        executorProfiles: [{ id: "executor-1", name: "能力档 1", noun: "执行者", instructions: "", hostTools: HOST_TOOLS }],
        bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }] });
    } finally { registry.close(); }
  });
});

/** The console's edit of a stored team: its editable fields and the groups it is checked into. */
function editOf(definitions: TeamDefinitions, id: string): TeamEdit {
  const team = definitions.teams.find((candidate) => candidate.id === id)!;
  return { id, teamName: team.teamName, responsibility: team.responsibility,
    leader: { name: team.leader.name, appId: team.leader.appId, instructions: team.leader.profile.instructions },
    executorProfiles: team.executorProfiles.map(({ id: profileId, name, noun, instructions, hostTools }) => ({ id: profileId, name, noun: noun ?? "执行者", instructions, hostTools })),
    groups: team.bindings.map(({ chatId }) => chatId) };
}

describe("console saves of a team", () => {
  const profile = (name: string) => ({ name, noun: "执行者", instructions: "", hostTools: [] });
  // team-management::REQ-002: the reasons the save bar lists under 「无法保存」.
  it.each([
    ["no leader name", (edit: TeamEdit) => ({ ...edit, leader: { ...edit.leader, name: " " } }), ["缺少负责人名称"]],
    ["no team name", (edit: TeamEdit) => ({ ...edit, teamName: "" }), ["缺少团队名称"]],
    ["no Executor profile", (edit: TeamEdit) => ({ ...edit, executorProfiles: [] }), ["至少需要一个执行者能力档"]],
    ["two profiles with one name", (edit: TeamEdit) => ({ ...edit, executorProfiles: [profile("行程规划"), profile("行程规划")] }), ["两个能力档同名：「行程规划」"]],
    ["the Coordinator's application", (edit: TeamEdit) => ({ ...edit, leader: { ...edit.leader, appId: SAM.appId } }), [`App ID ${SAM.appId} 已被 Sam 使用，每个团队需要自己的飞书应用`]],
    ["another team's application", (edit: TeamEdit) => ({ ...edit, leader: { ...edit.leader, appId: "cli_3333333333333333" } }), ["App ID cli_3333333333333333 已被 Jack 使用，每个团队需要自己的飞书应用"]],
    ["a profile without a name", (edit: TeamEdit) => ({ ...edit, executorProfiles: [profile(" ")] }), ["能力档名称不能为空"]],
    ["a malformed App ID", (edit: TeamEdit) => ({ ...edit, leader: { ...edit.leader, appId: "cli_../../x" } }), ["App ID cli_../../x 格式不正确，应为 cli_ 加 16 位十六进制字符"]],
    ["several problems at once", (edit: TeamEdit) => ({ ...edit, teamName: "", leader: { ...edit.leader, name: "" }, executorProfiles: [] }), ["缺少负责人名称", "缺少团队名称", "至少需要一个执行者能力档"]],
  ] as const)("refuses a team with %s and lists the reasons", (_case, change, reasons) => {
    const registry = new TeamRegistry(databasePath());
    try {
      const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      let refused: unknown;
      try { registry.saveTeam(change(editOf(seeded.definitions, "bill")), { basedOn: 1 }); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(TeamDefinitionError);
      expect((refused as TeamDefinitionError).reasons).toEqual(reasons);
      expect(registry.current()).toEqual(seeded);
    } finally { registry.close(); }
  });
});

// ADR-0025: Penny's private financial bot never posts for a team; the service passes its application as reserved.
it("refuses a team on an application reserved outside the registry, with the reason it was given", () => {
  const registry = new TeamRegistry(databasePath());
  try {
    const seeded = registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
    const edit = editOf(seeded.definitions, "bill");
    let refused: unknown;
    try { registry.saveTeam({ ...edit, leader: { ...edit.leader, appId: "cli_eeeeeeeeeeeeeeee" } }, { basedOn: 1, reserved: { cli_eeeeeeeeeeeeeeee: "该飞书应用已用于 Penny，不能用于团队" } }); }
    catch (error) { refused = error; }
    expect((refused as TeamDefinitionError).reasons).toEqual(["该飞书应用已用于 Penny，不能用于团队"]);
    expect(registry.current()).toEqual(seeded);
  } finally { registry.close(); }
});

describe("console saves and binding states", () => {
  function seeded() {
    const registry = new TeamRegistry(databasePath());
    return { registry, seeded: registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS }) };
  }
  const team = (version: { definitions: TeamDefinitions }, id: string) => version.definitions.teams.find((candidate) => candidate.id === id)!;

  it("refuses a second save of a team based on an outdated version, but not another team's save", () => {
    const { registry, seeded: first } = seeded();
    try {
      registry.saveTeam({ ...editOf(first.definitions, "bill"), responsibility: "新职责" }, { basedOn: 1 });
      expect(() => registry.saveTeam({ ...editOf(first.definitions, "bill"), leader: { ...editOf(first.definitions, "bill").leader, instructions: "新提示词" } }, { basedOn: 1 }))
        .toThrow(/^team_registry_version_stale$/);
      const alice = registry.saveTeam({ ...editOf(first.definitions, "alice"), responsibility: "运营新职责" }, { basedOn: 1 }).version;
      expect([team(alice, "bill").responsibility, team(alice, "bill").leader.profile.instructions, team(alice, "alice").responsibility]).toEqual(["新职责", "", "运营新职责"]);
      expect({ version: alice.version, basedOn: alice.basedOn, source: alice.source }).toEqual({ version: 3, basedOn: 2, source: "console" });
    } finally { registry.close(); }
  });

  it("starts onboarding in a newly checked group, drains an accepting one that is unchecked and drops an onboarding one", () => {
    const { registry, seeded: first } = seeded();
    try {
      // Bill accepts in oc_alpha and oc_beta (seeded). Unchecking oc_beta drains it; checking it again keeps it draining until the drain completes.
      const drained = registry.saveTeam({ ...editOf(first.definitions, "bill"), groups: ["oc_alpha"] }, { basedOn: 1 }).version;
      expect(team(drained, "bill").bindings).toEqual([{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "draining" }]);
      const again = registry.saveTeam({ ...editOf(drained.definitions, "bill"), groups: ["oc_alpha", "oc_beta"] }, { basedOn: drained.version }).version;
      expect(team(again, "bill").bindings).toEqual([{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "draining" }]);
      // A new team starts onboarding in every checked group; unchecking a group it does not accept work in drops it at once.
      const created = registry.saveTeam({ teamName: "设计团队", responsibility: "视觉方案", leader: { name: "Daisy", appId: "cli_5555555555555555", instructions: "" },
        executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: ["files.read"] }], groups: ["oc_alpha", "oc_beta"] }, { basedOn: again.version });
      const daisy = team(created.version, created.teamId);
      expect({ id: created.teamId.startsWith("team-"), profiles: daisy.executorProfiles, bindings: daisy.bindings }).toEqual({ id: true,
        profiles: [{ id: "executor-1", name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: ["files.read"] }],
        bindings: [{ chatId: "oc_alpha", state: "onboarding" }, { chatId: "oc_beta", state: "onboarding" }] });
      const dropped = registry.saveTeam({ ...editOf(created.version.definitions, created.teamId), groups: ["oc_alpha"] }, { basedOn: created.version.version }).version;
      expect(team(dropped, created.teamId).bindings).toEqual([{ chatId: "oc_alpha", state: "onboarding" }]);
    } finally { registry.close(); }
  });

  it("starts onboarding again in every group when an accepting team's application is replaced", () => {
    const { registry, seeded: first } = seeded();
    try {
      const edit = editOf(first.definitions, "bill");
      const replaced = registry.saveTeam({ ...edit, leader: { ...edit.leader, appId: "cli_6666666666666666" } }, { basedOn: 1, secret: "bill-new" }).version;
      expect(team(replaced, "bill").bindings).toEqual([{ chatId: "oc_alpha", state: "onboarding" }, { chatId: "oc_beta", state: "onboarding" }]);
      expect([registry.hasSecret("cli_6666666666666666"), registry.hasSecret("cli_2222222222222222")]).toEqual([true, false]);
    } finally { registry.close(); }
  });

  it("changes only Sam's responsibility and instructions, and refuses any other change to Sam", () => {
    const { registry, seeded: first } = seeded();
    try {
      const saved = registry.saveCoordinator({ responsibility: "只协调", instructions: "先澄清" }, { basedOn: 1 });
      expect(saved.definitions.coordinator).toEqual({ ...first.definitions.coordinator, responsibility: "只协调", profile: { instructions: "先澄清", hostTools: [] } });
      expect(saved.definitions.teams).toEqual(first.definitions.teams);
      expect(() => registry.saveTeam({ ...editOf(first.definitions, "bill"), id: "sam" }, { basedOn: saved.version })).toThrow(/^team_registry_coordinator_fixed$/);
      expect(() => registry.saveCoordinator({ responsibility: "再改", instructions: "" }, { basedOn: 1 })).toThrow(/^team_registry_version_stale$/);
    } finally { registry.close(); }
  });

  // team-management::US-004/AC-02: a drain completes per group, once that group is reported cleared of the team's work.
  it("unbinds the draining groups reported cleared and leaves the others draining", () => {
    const { registry, seeded: first } = seeded();
    try {
      registry.saveTeam({ ...editOf(first.definitions, "bill"), groups: [] }, { basedOn: 1 });
      const asked: string[] = [];
      const settled = registry.settleRemovals((teamId, chatId) => { asked.push(`${teamId}:${chatId}`); return chatId === "oc_beta"; });
      // Only draining bindings are asked about: Alice and Jack accept work in both groups.
      expect([settled, asked]).toEqual([{ unbound: [{ teamId: "bill", chatId: "oc_beta" }], deleted: [] }, ["bill:oc_alpha", "bill:oc_beta"]]);
      const current = registry.current()!;
      expect([team(current, "bill").bindings, current.source]).toEqual([[{ chatId: "oc_alpha", state: "draining" }, { chatId: "oc_beta", state: "removed" }], "removal"]);
      expect(registry.settleRemovals(() => false)).toEqual({ unbound: [], deleted: [] });
      expect(registry.current()!.version).toBe(current.version);
      // An unbound team keeps its application and its secret: only its work in that group ended.
      expect(registry.roster(SAM).agents.map(({ id }) => id)).toEqual(["sam", "alice", "bill", "jack"]);
    } finally { registry.close(); }
  });

  it.each([
    ["checked again starts onboarding", ["oc_beta"], [{ chatId: "oc_alpha", state: "draining" }, { chatId: "oc_beta", state: "onboarding" }]],
    ["left unchecked is dropped at the next save", [], [{ chatId: "oc_alpha", state: "draining" }]],
  ] as const)("an unbound group %s", (_name, groups, bindings) => {
    const { registry, seeded: first } = seeded();
    try {
      registry.saveTeam({ ...editOf(first.definitions, "bill"), groups: [] }, { basedOn: 1 });
      registry.settleRemovals((_teamId, chatId) => chatId === "oc_beta");
      const current = registry.current()!;
      const saved = registry.saveTeam({ ...editOf(current.definitions, "bill"), groups: [...groups] }, { basedOn: current.version }).version;
      expect(team(saved, "bill").bindings).toEqual(bindings);
    } finally { registry.close(); }
  });

  // team-management::US-004/AC-01 and AC-02: deletion drains every group the team accepts work in and completes with its last drain.
  it("deletes a team by draining its groups, refuses to save it meanwhile and removes it when the last drain completes", () => {
    const { registry, seeded: first } = seeded();
    try {
      // Alice already drains in oc_beta; deleting her starts a drain only in oc_alpha.
      const unchecked = registry.saveTeam({ ...editOf(first.definitions, "alice"), groups: ["oc_alpha"] }, { basedOn: 1 }).version;
      const started = registry.deleteTeam("alice");
      expect({ started: started.started, removed: started.removed, source: started.version.source, alice: team(started.version, "alice") }).toEqual({
        started: ["oc_alpha"], removed: false, source: "console",
        alice: { ...team(unchecked, "alice"), deleting: true, bindings: [{ chatId: "oc_alpha", state: "draining" }, { chatId: "oc_beta", state: "draining" }] } });
      expect(() => registry.saveTeam({ ...editOf(started.version.definitions, "alice"), responsibility: "新职责" }, { basedOn: started.version.version }))
        .toThrow(/^team_registry_team_deleting$/);
      // A second deletion of the same team starts nothing.
      const again = registry.deleteTeam("alice");
      expect([again.started, again.removed, again.version.version]).toEqual([[], false, started.version.version]);
      // Her application keeps posting until the last drain completes.
      expect(registry.settleRemovals((_teamId, chatId) => chatId === "oc_beta")).toEqual({ unbound: [{ teamId: "alice", chatId: "oc_beta" }], deleted: [] });
      expect([registry.roster(SAM).agents.map(({ id }) => id), registry.hasSecret("cli_1111111111111111")]).toEqual([["sam", "alice", "bill", "jack"], true]);
      expect(registry.settleRemovals(() => true)).toEqual({ unbound: [{ teamId: "alice", chatId: "oc_alpha" }], deleted: ["alice"] });
      const current = registry.current()!;
      expect([current.definitions.teams.map(({ id }) => id), registry.roster(SAM).agents.map(({ id }) => id), registry.hasSecret("cli_1111111111111111")])
        .toEqual([["bill", "jack"], ["sam", "bill", "jack"], false]);
      // History resolves her identity through the versions her requests were frozen at.
      expect(team(registry.version(started.version.version)!, "alice").leader).toEqual(team(first, "alice").leader);
      // A restart with the local configuration that seeded her does not bring her back.
      expect(registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS }).definitions.teams.map(({ id }) => id)).toEqual(["bill", "jack"]);
      expect(() => registry.deleteTeam("alice")).toThrow(/^team_registry_team_unknown$/);
    } finally { registry.close(); }
  });

  it("drops the groups a deleted team was still onboarding in, and removes at once a team that accepts work nowhere", () => {
    const { registry } = seeded();
    try {
      const daisy: TeamEdit = { teamName: "设计团队", responsibility: "视觉方案", leader: { name: "Daisy", appId: "cli_5555555555555555", instructions: "" },
        executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: [] }], groups: ["oc_alpha", "oc_beta"] };
      const half = registry.saveTeam(daisy, { basedOn: 1, secret: "daisy-secret" }).teamId;
      registry.recordOnboarding("cli_5555555555555555", { step: "credentials" }, { status: "done", at: 1 });
      registry.recordOnboarding("cli_5555555555555555", { step: "join", chatId: "oc_alpha" }, { status: "done", at: 1 });
      registry.settleOnboarding();
      const draining = registry.deleteTeam(half);
      expect([draining.started, draining.removed, team(draining.version, half).bindings]).toEqual([["oc_alpha"], false, [{ chatId: "oc_alpha", state: "draining" }]]);
      const fresh = registry.saveTeam({ ...daisy, teamName: "内容团队", leader: { ...daisy.leader, name: "Eve", appId: "cli_6666666666666666" } },
        { basedOn: draining.version.version, secret: "eve-secret" }).teamId;
      const gone = registry.deleteTeam(fresh);
      expect([gone.started, gone.removed, gone.version.definitions.teams.map(({ id }) => id), registry.hasSecret("cli_6666666666666666")])
        .toEqual([[], true, ["alice", "bill", "jack", half], false]);
    } finally { registry.close(); }
  });

  // team-management::REQ-001/AC-01: Sam has no delete action.
  it.each([["sam", /^team_registry_coordinator_fixed$/], ["team-unknown", /^team_registry_team_unknown$/]] as const)("refuses to delete %s", (id, refusal) => {
    const { registry, seeded: first } = seeded();
    try {
      expect(() => registry.deleteTeam(id)).toThrow(refusal);
      expect(registry.current()).toEqual(first);
    } finally { registry.close(); }
  });
});

describe("onboarding and acceptance", () => {
  const daisy: TeamEdit = { teamName: "设计团队", responsibility: "视觉方案", leader: { name: "Daisy", appId: "cli_5555555555555555", instructions: "" },
    executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: [] }], groups: ["oc_alpha", "oc_beta"] };
  const DONE = { status: "done", at: 1 } as const;

  // team-management::REQ-003: credentials verified (with the published, enabled bot) and the bot in that group; the test message never gates.
  it("accepts work in a group only once the credentials are verified and the bot has joined that group", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const { teamId } = registry.saveTeam(daisy, { basedOn: 1, secret: "daisy-secret" });
      const accepting = () => ["oc_alpha", "oc_beta"].map((chatId) => acceptingTeams(registry.current()!.definitions, chatId).map(({ id }) => id).includes(teamId));
      registry.recordOnboarding("cli_5555555555555555", { step: "join", chatId: "oc_alpha" }, DONE);
      expect([registry.settleOnboarding(), accepting()]).toEqual([[], [false, false]]);
      registry.recordOnboarding("cli_5555555555555555", { step: "credentials" }, DONE);
      registry.recordOnboarding("cli_5555555555555555", { step: "join", chatId: "oc_beta" }, { status: "action", reason: "仅群主和管理员可添加成员", at: 2 });
      const settled = registry.settleOnboarding();
      expect([settled, accepting()]).toEqual([[{ teamId, chatId: "oc_alpha" }], [true, false]]);
      expect(registry.current()!.source).toBe("onboarding");
      // The Team Directory of each group lists exactly the teams accepting work there (team-management::REQ-004/AC-02).
      expect(acceptingTeams(registry.current()!.definitions, "oc_beta").map(({ name }) => name)).toEqual(["运营团队", "生活团队", "技术团队"]);
      expect(acceptingTeams(registry.current()!.definitions, "oc_alpha").at(-1)).toEqual({ id: teamId, name: "设计团队", responsibility: "视觉方案" });
      expect(registry.onboarding("cli_5555555555555555")).toEqual({ credentials: DONE,
        joins: { oc_alpha: DONE, oc_beta: { status: "action", reason: "仅群主和管理员可添加成员", at: 2 } } });
    } finally { registry.close(); }
  });

  it("keeps recorded onboarding outcomes across a restart and forgets them when the application is replaced", () => {
    const path = databasePath();
    const first = new TeamRegistry(path);
    first.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
    const { teamId } = first.saveTeam(daisy, { basedOn: 1, secret: "daisy-secret" });
    first.recordOnboarding("cli_5555555555555555", { step: "credentials" }, DONE);
    first.close();
    const registry = new TeamRegistry(path);
    try {
      expect(registry.onboarding("cli_5555555555555555")).toEqual({ credentials: DONE, joins: {} });
      const current = registry.current()!;
      const edit = editOf(current.definitions, teamId);
      registry.saveTeam({ ...edit, leader: { ...edit.leader, appId: "cli_7777777777777777" } }, { basedOn: current.version, secret: "daisy-new" });
      expect([registry.onboarding("cli_5555555555555555"), registry.onboarding("cli_7777777777777777")]).toEqual([{ joins: {} }, { joins: {} }]);
    } finally { registry.close(); }
  });

  // Ticket 03's guard refused a team without a stored secret at startup; such a team is onboarding instead (ticket 11, D7).
  it("serves the roster while a saved team has no secret yet, leaving that team out of it", () => {
    const registry = new TeamRegistry(databasePath());
    try {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      const { version } = registry.saveTeam({ ...daisy, leader: { ...daisy.leader, appId: "" } }, { basedOn: 1 });
      const eve = registry.saveTeam({ ...daisy, teamName: "内容团队", leader: { ...daisy.leader, name: "Eve", appId: "cli_5555555555555555" } }, { basedOn: version.version });
      expect(registry.roster(SAM).agents.map(({ id }) => id)).toEqual(["sam", "alice", "bill", "jack"]);
      // Given its secret, the team joins the roster; the secret stays beside the versions, never inside one (team-management::CON-001).
      const edit = editOf(registry.current()!.definitions, eve.teamId);
      registry.saveTeam(edit, { basedOn: registry.current()!.version, secret: "eve-secret-SENTINEL" });
      expect(registry.roster(SAM).agents.map(({ id, appSecret }) => [id, appSecret]).at(-1)).toEqual([eve.teamId, "eve-secret-SENTINEL"]);
      const versions = Array.from({ length: registry.current()!.version }, (_, index) => registry.version(index + 1));
      expect(versions.length).toBeGreaterThan(2);
      for (const stored of versions) expect(JSON.stringify(stored)).not.toContain("eve-secret-SENTINEL");
    } finally { registry.close(); }
  });
});

// QR creation of a team's application (team-management::US-002/AC-01, AC-03; Implementation Decisions: Onboarding).
describe("QR creation of a team's application", () => {
  const CREATED = { appId: "cli_9f8e7d6c5b4a3210", appSecret: "created-secret-SENTINEL" };
  const BILL_APP = "cli_2222222222222222";
  function seeded() {
    const path = databasePath();
    const registry = new TeamRegistry(path);
    return { path, registry, seeded: registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS }) };
  }
  const bill = (registry: TeamRegistry) => registry.current()!.definitions.teams.find(({ id }) => id === "bill")!;
  const ACCEPTING = [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }];

  it("starts one creation when a team is saved as QR creation, and leaves the team's application as it is", () => {
    const { registry, seeded: first } = seeded();
    try {
      const edit = editOf(first.definitions, "bill");
      // The page sends no App ID in QR creation; the application is the service's to set.
      const saved = registry.saveTeam({ ...edit, method: "qr", leader: { ...edit.leader, appId: "" } }, { basedOn: 1, at: 100 });
      expect([saved.creation, bill(registry).leader.appId, bill(registry).bindings, registry.creation("bill")])
        .toEqual(["started", BILL_APP, ACCEPTING, { status: "waiting", at: 100 }]);
      // Only the save that chooses QR creation starts one; afterwards a new code is asked for explicitly.
      const again = registry.saveTeam({ ...edit, method: "qr", responsibility: "新职责" }, { basedOn: saved.version.version, at: 200 });
      expect([again.creation, registry.creation("bill")]).toEqual([undefined, { status: "waiting", at: 100 }]);
      expect(registry.creation("alice")).toBeUndefined();
    } finally { registry.close(); }
  });

  it("replaces the team's application with the created one, keeps its secret, and starts onboarding again in its groups", () => {
    const { registry, seeded: first } = seeded();
    try {
      // Bill drains in oc_beta and accepts in oc_alpha, with a recorded check of its old application.
      const drained = registry.saveTeam({ ...editOf(first.definitions, "bill"), method: "qr", groups: ["oc_alpha"] }, { basedOn: 1, at: 100 }).version;
      registry.recordOnboarding(BILL_APP, { step: "credentials" }, { status: "done", at: 101 });
      const attached = registry.attachCreatedApplication("bill", CREATED, { at: 300 });
      expect(attached).toEqual({ version: registry.current(), replaced: BILL_APP });
      expect({ source: registry.current()!.source, basedOn: registry.current()!.basedOn, appId: bill(registry).leader.appId, bindings: bill(registry).bindings }).toEqual({
        source: "onboarding", basedOn: drained.version, appId: CREATED.appId,
        bindings: [{ chatId: "oc_alpha", state: "onboarding" }, { chatId: "oc_beta", state: "draining" }] });
      expect(registry.creation("bill")).toEqual({ status: "done", appId: CREATED.appId, at: 300 });
      // The secret is stored beside the versions and serves the roster; the replaced application's secret and outcomes are gone.
      expect(registry.roster(SAM).agents.find(({ id }) => id === "bill")).toMatchObject({ appId: CREATED.appId, appSecret: CREATED.appSecret });
      expect([registry.hasSecret(BILL_APP), registry.onboarding(BILL_APP), registry.onboarding(CREATED.appId)]).toEqual([false, { joins: {} }, { joins: {} }]);
      const versions = Array.from({ length: registry.current()!.version }, (_, index) => registry.version(index + 1));
      for (const stored of versions) expect(JSON.stringify(stored)).not.toContain(CREATED.appSecret);
    } finally { registry.close(); }
  });

  it("accepts a save made before the scan in QR creation, and refuses it as stale as an existing application", () => {
    const { registry, seeded: first } = seeded();
    try {
      const edit = editOf(first.definitions, "bill");
      const before = registry.saveTeam({ ...edit, method: "qr" }, { basedOn: 1, at: 100 }).version.version;
      registry.attachCreatedApplication("bill", CREATED, { at: 300 });
      // An onboarding step never refuses a save: the page still shows the old application, and the team keeps the created one.
      registry.saveTeam({ ...edit, method: "qr", responsibility: "扫码期间改的职责" }, { basedOn: before, at: 400 });
      expect([bill(registry).leader.appId, bill(registry).responsibility]).toEqual([CREATED.appId, "扫码期间改的职责"]);
      // As an existing application the page's App ID would replace the created one, so that save is stale.
      expect(() => registry.saveTeam({ ...edit, method: "existing", responsibility: "再改" }, { basedOn: before, at: 500 })).toThrow(/^team_registry_version_stale$/);
      expect([bill(registry).leader.appId, registry.creation("bill")?.status]).toEqual([CREATED.appId, "done"]);
    } finally { registry.close(); }
  });

  // Two pages hold the team (team-management failure modes: "Two browser tabs edit the same team"). The 接入方式 is one of the
  // team's editable fields: a page that still shows the old one must reload before it can end, or start, a QR creation.
  it.each([
    ["chose QR creation", "existing", "qr", "existing", { status: "waiting", at: 200 }],
    ["chose an existing application", "qr", "existing", "qr", undefined],
  ] as const)("refuses a save from a page that loaded the team before another page %s", (_case, first, second, stale, creation) => {
    const { registry, seeded: seededVersion } = seeded();
    try {
      const edit = editOf(seededVersion.definitions, "bill");
      const loaded = registry.saveTeam({ ...edit, method: first }, { basedOn: 1, at: 100 }).version.version;
      registry.saveTeam({ ...edit, method: second }, { basedOn: loaded, at: 200 });
      const before = registry.current();
      expect(() => registry.saveTeam({ ...edit, method: stale, responsibility: "另一页的修改" }, { basedOn: loaded, at: 300 })).toThrow(/^team_registry_version_stale$/);
      expect([registry.current(), registry.creation("bill")]).toEqual([before, creation]);
    } finally { registry.close(); }
  });

  it.each([
    ["a malformed App ID", { appId: "cli_not-an-app", appSecret: "created-secret-SENTINEL" }, {}],
    ["another team's application", { appId: "cli_3333333333333333", appSecret: "created-secret-SENTINEL" }, {}],
    ["the Coordinator's application", { appId: SAM.appId, appSecret: "created-secret-SENTINEL" }, {}],
    ["an application reserved outside the registry", CREATED, { [CREATED.appId]: "该飞书应用已用于 Penny，不能用于团队" }],
  ] as const)("does not attach %s", (_case, credentials, reserved) => {
    const { registry, seeded: first } = seeded();
    try {
      const saved = registry.saveTeam({ ...editOf(first.definitions, "bill"), method: "qr" }, { basedOn: 1, at: 100 }).version;
      expect(registry.attachCreatedApplication("bill", credentials, { at: 300, reserved })).toBeUndefined();
      expect([registry.current(), registry.creation("bill"), registry.secret(credentials.appId) === credentials.appSecret])
        .toEqual([saved, { status: "action", reason: "unusable", at: 300 }, false]);
    } finally { registry.close(); }
  });

  it("ends the creation when the team is saved as an existing application", () => {
    const { registry, seeded: first } = seeded();
    try {
      const edit = editOf(first.definitions, "bill");
      const qr = registry.saveTeam({ ...edit, method: "qr" }, { basedOn: 1, at: 100 });
      const existing = registry.saveTeam({ ...edit, method: "existing" }, { basedOn: qr.version.version, at: 200 });
      expect([existing.creation, registry.creation("bill"), bill(registry).leader.appId]).toEqual(["ended", undefined, BILL_APP]);
      // Nothing waits for a scan any more, so a created application has no team to go to.
      expect(registry.attachCreatedApplication("bill", CREATED, { at: 300 })).toBeUndefined();
      expect(registry.saveTeam({ ...edit, method: "existing", responsibility: "新职责" }, { basedOn: registry.current()!.version, at: 400 }).creation).toBeUndefined();
    } finally { registry.close(); }
  });

  it("records a failed creation and a new request only while the team is in QR creation and has no created application", () => {
    const { registry, seeded: first } = seeded();
    try {
      expect(registry.recordCreation("bill", { status: "action", reason: "expired" }, 50)).toBe(false);
      registry.saveTeam({ ...editOf(first.definitions, "bill"), method: "qr" }, { basedOn: 1, at: 100 });
      expect([registry.recordCreation("bill", { status: "action", reason: "expired" }, 150), registry.creation("bill")]).toEqual([true, { status: "action", reason: "expired", at: 150 }]);
      expect([registry.recordCreation("bill", { status: "waiting" }, 160), registry.creation("bill")]).toEqual([true, { status: "waiting", at: 160 }]);
      registry.attachCreatedApplication("bill", CREATED, { at: 300 });
      expect([registry.recordCreation("bill", { status: "waiting" }, 400), registry.creation("bill")]).toEqual([false, { status: "done", appId: CREATED.appId, at: 300 }]);
    } finally { registry.close(); }
  });

  // team-management failure modes: "Service restarts during … onboarding — no step reruns without its recorded outcome". A code's
  // wait and a send in flight end with the process, so a restart records what the owner has to look at.
  it("turns a creation that waited for its scan, and a test message that was being sent, into outcomes after a restart", () => {
    const { path, registry: first, seeded: version } = seeded();
    first.saveTeam({ ...editOf(version.definitions, "bill"), method: "qr" }, { basedOn: 1, at: 100 });
    first.saveTeam({ ...editOf(version.definitions, "alice"), method: "qr" }, { basedOn: 1, at: 100 });
    first.attachCreatedApplication("alice", CREATED, { at: 300 });
    first.recordTestMessage(BILL_APP, "oc_alpha", { status: "sending", at: 310 });
    first.recordTestMessage(BILL_APP, "oc_beta", { status: "accepted", at: 311 });
    first.close();
    const registry = new TeamRegistry(path);
    try {
      expect(registry.testMessages(BILL_APP)).toEqual({ oc_alpha: { status: "unknown", at: 310 }, oc_beta: { status: "accepted", at: 311 } });
      // The start reports each team whose code waited before the creation is recorded as interrupted. When the report
      // cannot be made, the creation stays as it was, so that the next start reports it.
      expect(() => registry.interruptCreations(() => { throw new Error("audit unavailable"); })).toThrow("audit unavailable");
      expect(registry.creation("bill")).toEqual({ status: "waiting", at: 100 });
      const reported: string[] = [];
      registry.interruptCreations((teamId) => reported.push(`${teamId}:${registry.creation(teamId)?.status}`));
      expect([reported, registry.creation("bill"), registry.creation("alice")])
        .toEqual([["bill:waiting"], { status: "action", reason: "interrupted", at: 100 }, { status: "done", appId: CREATED.appId, at: 300 }]);
    } finally { registry.close(); }
    // A later start has nothing left to report.
    const later = new TeamRegistry(path);
    try {
      const reported: string[] = [];
      later.interruptCreations((teamId) => reported.push(teamId));
      expect([reported, later.creation("bill")?.status]).toEqual([[], "action"]);
    } finally { later.close(); }
  });

  it("keeps the outcomes of configuration, release and test messages per application, and forgets them with it", () => {
    const { registry, seeded: first } = seeded();
    try {
      registry.recordOnboarding(BILL_APP, { step: "configure" }, { status: "done", at: 1 });
      registry.recordOnboarding(BILL_APP, { step: "publish" }, { status: "review", reason: "submitted", at: 2 });
      registry.recordTestMessage(BILL_APP, "oc_alpha", { status: "failed", at: 3 });
      expect([registry.onboarding(BILL_APP), registry.testMessages(BILL_APP)]).toEqual([
        { configure: { status: "done", at: 1 }, publish: { status: "review", reason: "submitted", at: 2 }, joins: {} }, { oc_alpha: { status: "failed", at: 3 } }]);
      const edit = editOf(first.definitions, "bill");
      registry.saveTeam({ ...edit, leader: { ...edit.leader, appId: "cli_6666666666666666" } }, { basedOn: 1, secret: "bill-new" });
      expect([registry.onboarding(BILL_APP), registry.testMessages(BILL_APP)]).toEqual([{ joins: {} }, {}]);
    } finally { registry.close(); }
  });

  // Until the console's first save each start imports the local roster again, which would put Bill back on the application in the file.
  it("counts a save that only chooses QR creation as a console save, so the next start keeps the created application", () => {
    const { path, registry: first, seeded: version } = seeded();
    first.saveTeam({ ...editOf(version.definitions, "bill"), method: "qr" }, { basedOn: 1, at: 100 });
    first.attachCreatedApplication("bill", CREATED, { at: 300 });
    first.close();
    const registry = new TeamRegistry(path);
    try {
      registry.importLocalConfiguration(local(), { executorHostTools: HOST_TOOLS });
      expect([bill(registry).leader.appId, registry.hasSecret(CREATED.appId)]).toEqual([CREATED.appId, true]);
    } finally { registry.close(); }
  });
});

describe("teams accepting work in a group", () => {
  const team = (id: string, teamName: string, bindings: TeamDefinitions["teams"][number]["bindings"]): TeamDefinitions["teams"][number] => ({
    id, teamName, responsibility: `${teamName}的职责`, leader: { name: id, appId: `cli_${id}`, profile: { instructions: "", hostTools: [] } },
    executorProfiles: [{ id: "executor-1", name: "能力档 1", instructions: "", hostTools: [] }], bindings });
  const definitions: TeamDefinitions = {
    coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调", appId: SAM.appId, profile: { instructions: "", hostTools: [] } },
    dispatchGroups: ["oc_alpha", "oc_beta", "oc_gamma"],
    teams: [
      team("alice", "运营团队", [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }]),
      team("bill", "生活团队", [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "onboarding" }]),
      team("jack", "技术团队", [{ chatId: "oc_beta", state: "draining" }]),
      team("lily", "设计团队", [{ chatId: "oc_alpha", state: "removed" }]),
    ],
  };
  it.each([
    ["oc_alpha", [{ id: "alice", name: "运营团队", responsibility: "运营团队的职责" }, { id: "bill", name: "生活团队", responsibility: "生活团队的职责" }]],
    ["oc_beta", [{ id: "alice", name: "运营团队", responsibility: "运营团队的职责" }]],
    ["oc_gamma", []],
  ] as const)("lists only the teams accepting work in %s, by team name and responsibility", (chatId, expected) => {
    expect(acceptingTeams(definitions, chatId)).toEqual(expected);
  });
});
