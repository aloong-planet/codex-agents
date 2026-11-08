import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FeishuDispatchConfiguration } from "./feishu-agent-config.js";

/** The Coordinator's fixed identity: Sam cannot be replaced, deleted or unbound (team-management::REQ-001/AC-01). */
export const COORDINATOR_ID = "sam";

/**
 * Seeded Executor instructions by team. Bill's team owns the weather, route, walking, opening-hours and budget-and-schedule
 * rules that every specialist turn carried before profiles; Jack's team owns the code-and-tests example of the goal-scope
 * rule, which private chat keeps in shared text. The domain-neutral source rules stay in shared prompt assembly.
 */
const SEEDED_EXECUTOR_INSTRUCTIONS: Readonly<Record<string, string>> = {
  jack: "代码与测试任务的结果报告：只要求提供代码和测试用例、明确不要运行时，交付代码和用例即可分别记 completed；测试尚未运行应在 message 中如实说明，不新增运行测试的失败项。若用户实际要求运行而未能运行，则该目标必须如实记为未完成，不能用代码审阅替代执行。",
  bill: "搜索摘要可能缓存旧内容，天气等持续更新的信息必须打开官方页面核对发布时间，注明来源发布时点；无法取得当前内容时明确标注未核实，不把旧预报写成最新预报。出行路线须逐段核对站名、线路和换乘站，不能凭记忆拼接；区分景区名称与地铁站名称。步行入口、方位、距离和耗时没有地图或官方资料支持时，不猜测具体数值或地点，标注需现场导航并预留弹性时间。开放时间、预约要求和天气须附本轮查证来源；未核实的明确标注并提供可行备选，不写成确定事实。交付文件前复核预算和时间安排是否自洽。",
};

/** An agent's instructions and host-tool allowlist. MCP servers and skills join with their catalogs. */
export type AgentProfile = Readonly<{ instructions: string; hostTools: readonly string[] }>;
/** What an Executor is called in its group when a profile names none, and in versions saved before profiles had a noun. */
export const DEFAULT_EXECUTOR_NOUN = "执行者";
/**
 * One of a team's preset Agent Profiles for its Executors; `id` stays stable across renames. Its Executors are named
 * `<noun> <n>`; versions saved before the noun existed omit it and read as DEFAULT_EXECUTOR_NOUN.
 */
export type ExecutorProfile = AgentProfile & Readonly<{ id: string; name: string; noun?: string }>;
export type BindingState = "onboarding" | "accepting" | "draining" | "removed";
export type TeamBinding = Readonly<{ chatId: string; state: BindingState }>;
export type TeamDefinition = Readonly<{
  /** Stable agent ID of the team's Team Leader, as used by requests and senders. */
  id: string;
  teamName: string;
  /** The team's entry in the Coordinator's dispatch list and every Team Directory. */
  responsibility: string;
  leader: Readonly<{ name: string; appId: string; profile: AgentProfile }>;
  executorProfiles: readonly ExecutorProfile[];
  bindings: readonly TeamBinding[];
}>;
export type CoordinatorDefinition = Readonly<{
  id: typeof COORDINATOR_ID; name: string; teamName: string; responsibility: string;
  /** The canonical application; its secret stays with the channel connection. */
  appId: string;
  profile: AgentProfile;
}>;
/** Everything one definitions version holds. Application secrets are never part of it. */
export type TeamDefinitions = Readonly<{ coordinator: CoordinatorDefinition; dispatchGroups: readonly string[]; teams: readonly TeamDefinition[] }>;
export type DefinitionsVersion = Readonly<{ version: number; basedOn: number | null; source: "local_configuration" | "console" | "onboarding"; definitions: TeamDefinitions }>;
/** An Executor profile as the console edits it; a profile without `id` is new. */
export type ExecutorProfileEdit = Readonly<{ id?: string; name: string; noun: string; instructions: string; hostTools: readonly string[] }>;
/**
 * One team as the console saves it: its editable fields and the dispatch groups it is checked into. A team without `id` is new.
 * Binding states are the registry's: the console only says which groups are checked (team-management Implementation Decisions).
 */
export type TeamEdit = Readonly<{
  id?: string; teamName: string; responsibility: string;
  leader: Readonly<{ name: string; appId: string; instructions: string }>;
  executorProfiles: readonly ExecutorProfileEdit[];
  groups: readonly string[];
}>;
/** A console save refused under team-management::REQ-002, with the reasons the save bar lists. */
export class TeamDefinitionError extends Error {
  constructor(readonly reasons: readonly string[]) { super("team_definition_invalid"); }
}
const APPLICATION_ID = /^cli_[a-f0-9]{16}$/;
/**
 * The recorded outcome of an onboarding step: done; awaiting the application's review or enabling ("review"); or needing
 * the owner's action ("action"). Step 4 checks the credentials and the bot; step 5 joins the bot to one group.
 */
export type OnboardingOutcome = Readonly<{ status: "done" | "review" | "action"; reason?: string; at: number }>;
export type OnboardingStep = Readonly<{ step: "credentials" }> | Readonly<{ step: "join"; chatId: string }>;
export type OnboardingRecord = Readonly<{ credentials?: OnboardingOutcome; joins: Readonly<Record<string, OnboardingOutcome>> }>;

const SEEDED_TEAM_NAMES: Readonly<Record<string, string>> = { alice: "运营团队", bill: "生活团队", jack: "技术团队" };
const EMPTY_PROFILE: AgentProfile = { instructions: "", hostTools: [] };

/**
 * The single store of the Coordinator, the Agent Teams, their group bindings and their Agent Profiles
 * (agent-dispatch and team-management Implementation Decisions). Every save appends an immutable definitions version.
 */
export class TeamRegistry {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS definitions_version (version INTEGER PRIMARY KEY, based_on INTEGER, source TEXT NOT NULL, definitions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS application_secret (app_id TEXT PRIMARY KEY, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS onboarding_outcome (app_id TEXT NOT NULL, step TEXT NOT NULL, chat_id TEXT NOT NULL, status TEXT NOT NULL,
        reason TEXT, at INTEGER NOT NULL, PRIMARY KEY (app_id, step, chat_id));`);
  }

  /**
   * Imports the parsed local `feishu.dispatch` configuration, with the production host tools for the seeded Executor profiles.
   * Until the first console save, each start imports again and appends a version only when the definitions differ;
   * leader secrets follow the import without a new version. After a console save the console is the only editor and this returns the current version unchanged.
   */
  importLocalConfiguration(local: Readonly<FeishuDispatchConfiguration>, seed: Readonly<{ executorHostTools: readonly string[] }>): DefinitionsVersion {
    const definitions = seededDefinitions(local, seed.executorHostTools);
    this.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM definitions_version WHERE source = 'console' LIMIT 1").get()) return;
      const latest = this.database.prepare("SELECT version, definitions FROM definitions_version ORDER BY version DESC LIMIT 1").get();
      const serialized = JSON.stringify(definitions);
      if (latest?.definitions !== serialized) {
        this.database.prepare("INSERT INTO definitions_version (version, based_on, source, definitions) VALUES (?, ?, 'local_configuration', ?)")
          .run(latest ? Number(latest.version) + 1 : 1, latest ? Number(latest.version) : null, serialized);
      }
      const secrets = new Map(local.agents.filter(({ id }) => id !== COORDINATOR_ID).map(({ appId, appSecret }) => [appId, appSecret]));
      for (const row of this.database.prepare("SELECT app_id FROM application_secret").all()) {
        if (!secrets.has(String(row.app_id))) this.database.prepare("DELETE FROM application_secret WHERE app_id = ?").run(String(row.app_id));
      }
      for (const [appId, secret] of secrets) {
        this.database.prepare("INSERT INTO application_secret (app_id, secret) VALUES (?, ?) ON CONFLICT(app_id) DO UPDATE SET secret = excluded.secret").run(appId, secret);
      }
    });
    return this.current()!;
  }

  /**
   * Appends a console-originated version based on `basedOn`, refusing a save whose base is no longer current.
   * The first console save ends local-configuration imports. Validation of definitions (team-management::REQ-002) arrives with the console.
   */
  save(definitions: TeamDefinitions, options: Readonly<{ basedOn: number }>): DefinitionsVersion {
    this.transaction(() => {
      const latest = this.database.prepare("SELECT version FROM definitions_version ORDER BY version DESC LIMIT 1").get();
      if (!latest || Number(latest.version) !== options.basedOn) throw new Error("team_registry_version_stale");
      this.database.prepare("INSERT INTO definitions_version (version, based_on, source, definitions) VALUES (?, ?, 'console', ?)")
        .run(options.basedOn + 1, options.basedOn, JSON.stringify(definitions));
    });
    return this.current()!;
  }

  /**
   * Saves one team from the console (team-management::REQ-002, REQ-001). The save is refused as stale when the team's own
   * editable fields changed since `basedOn`, so another team's save or an onboarding step never refuses it. Binding states
   * follow the checked groups: a newly checked group starts onboarding; an unchecked group drains when the team accepts work
   * there and is dropped otherwise; a changed application starts onboarding again in every group it does not drain.
   * `secret` is written beside the versions, never into one, and the application's credentials are then checked again
   * (ticket 11, decision D7). Returns the saved version and the team's ID.
   */
  saveTeam(edit: TeamEdit, options: Readonly<{ basedOn: number; secret?: string; reserved?: Readonly<Record<string, string>> }>): Readonly<{ version: DefinitionsVersion; teamId: string }> {
    let teamId = edit.id ?? "";
    this.transaction(() => {
      const latest = this.current(), base = this.version(options.basedOn);
      if (!latest || !base) throw new Error("team_registry_version_stale");
      const definitions = latest.definitions;
      const existing = edit.id === undefined ? undefined : definitions.teams.find(({ id }) => id === edit.id);
      if (edit.id !== undefined) {
        if (edit.id === COORDINATOR_ID) throw new Error("team_registry_coordinator_fixed");
        const before = base.definitions.teams.find(({ id }) => id === edit.id);
        if (!existing || !before) throw new Error("team_registry_team_unknown");
        if (JSON.stringify(editable(before)) !== JSON.stringify(editable(existing))) throw new Error("team_registry_version_stale");
      }
      if (edit.groups.some((chatId) => !definitions.dispatchGroups.includes(chatId))) throw new Error("team_registry_group_unknown");
      const reasons = teamReasons(edit, definitions, options.reserved ?? {});
      if (reasons.length) throw new TeamDefinitionError(reasons);
      teamId = existing?.id ?? `team-${randomUUID().slice(0, 8)}`;
      const appId = edit.leader.appId.trim(), replaced = existing !== undefined && existing.leader.appId !== appId;
      const kept = new Map((existing?.bindings ?? []).map((binding) => [binding.chatId, binding.state]));
      const bindings: TeamBinding[] = [];
      for (const chatId of definitions.dispatchGroups) {
        const state = kept.get(chatId), checked = edit.groups.includes(chatId);
        if (state === "draining") bindings.push({ chatId, state });
        else if (checked) bindings.push({ chatId, state: state === undefined || state === "removed" || replaced ? "onboarding" : state });
        else if (state === "accepting") bindings.push({ chatId, state: "draining" });
      }
      const ids = new Set(edit.executorProfiles.flatMap(({ id }) => id ? [id] : []));
      let next = 1;
      const freshId = () => { while (ids.has(`executor-${next}`)) next++; ids.add(`executor-${next}`); return `executor-${next}`; };
      const team: TeamDefinition = { id: teamId, teamName: edit.teamName.trim(), responsibility: edit.responsibility.trim(),
        leader: { name: edit.leader.name.trim(), appId, profile: { instructions: edit.leader.instructions, hostTools: existing?.leader.profile.hostTools ?? [] } },
        executorProfiles: edit.executorProfiles.map((profile) => ({ id: profile.id ?? freshId(), name: profile.name.trim(),
          noun: profile.noun.trim() || DEFAULT_EXECUTOR_NOUN, instructions: profile.instructions, hostTools: [...new Set(profile.hostTools)] })),
        bindings };
      const teams = existing ? definitions.teams.map((candidate) => candidate.id === teamId ? team : candidate) : [...definitions.teams, team];
      this.append({ ...definitions, teams }, latest.version, "console");
      if (options.secret !== undefined && appId) {
        this.database.prepare("INSERT INTO application_secret (app_id, secret) VALUES (?, ?) ON CONFLICT(app_id) DO UPDATE SET secret = excluded.secret").run(appId, options.secret);
        this.database.prepare("DELETE FROM onboarding_outcome WHERE app_id = ? AND step = 'credentials'").run(appId);
      }
      this.forgetUnusedApplications();
    });
    return { version: this.current()!, teamId };
  }

  /** Saves the Coordinator's responsibility and instructions, the only parts of Sam the console edits (team-management::REQ-001/AC-01). */
  saveCoordinator(edit: Readonly<{ responsibility: string; instructions: string }>, options: Readonly<{ basedOn: number }>): DefinitionsVersion {
    this.transaction(() => {
      const latest = this.current(), base = this.version(options.basedOn);
      if (!latest || !base) throw new Error("team_registry_version_stale");
      const before = base.definitions.coordinator, now = latest.definitions.coordinator;
      if (before.responsibility !== now.responsibility || before.profile.instructions !== now.profile.instructions) throw new Error("team_registry_version_stale");
      this.append({ ...latest.definitions, coordinator: { ...now, responsibility: edit.responsibility.trim(), profile: { ...now.profile, instructions: edit.instructions } } },
        latest.version, "console");
    });
    return this.current()!;
  }

  /** Records one onboarding step's outcome for an application; a later outcome of the same step replaces it. */
  recordOnboarding(appId: string, step: OnboardingStep, outcome: OnboardingOutcome): void {
    this.database.prepare(`INSERT INTO onboarding_outcome (app_id, step, chat_id, status, reason, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, step, chat_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at`)
      .run(appId, step.step, step.step === "join" ? step.chatId : "", outcome.status, outcome.reason ?? null, outcome.at);
  }

  /** The recorded onboarding outcomes of an application, so that a restart resumes without repeating finished steps. */
  onboarding(appId: string): OnboardingRecord {
    const record: { credentials?: OnboardingOutcome; joins: Record<string, OnboardingOutcome> } = { joins: {} };
    for (const row of this.database.prepare("SELECT * FROM onboarding_outcome WHERE app_id = ? ORDER BY chat_id").all(appId)) {
      const outcome: OnboardingOutcome = { status: String(row.status) as OnboardingOutcome["status"], ...(row.reason === null ? {} : { reason: String(row.reason) }), at: Number(row.at) };
      if (row.step === "credentials") record.credentials = outcome; else record.joins[String(row.chat_id)] = outcome;
    }
    return record;
  }

  /**
   * Turns every onboarding binding whose credentials are verified and whose bot has joined that group into an accepting one
   * (team-management::REQ-003), in one new version. Returns the bindings that started accepting, for their announcements.
   */
  settleOnboarding(): ReadonlyArray<Readonly<{ teamId: string; chatId: string }>> {
    const started: Array<{ teamId: string; chatId: string }> = [];
    this.transaction(() => {
      const latest = this.current();
      if (!latest) return;
      const teams = latest.definitions.teams.map((team) => {
        const record = team.leader.appId ? this.onboarding(team.leader.appId) : { joins: {} } as OnboardingRecord;
        if (record.credentials?.status !== "done") return team;
        const bindings = team.bindings.map((binding) => {
          if (binding.state !== "onboarding" || record.joins[binding.chatId]?.status !== "done") return binding;
          started.push({ teamId: team.id, chatId: binding.chatId });
          return { ...binding, state: "accepting" as const };
        });
        return { ...team, bindings };
      });
      if (started.length) this.append({ ...latest.definitions, teams }, latest.version, "onboarding");
    });
    return started;
  }

  /** Whether a secret is stored for `appId`; the secret itself is never read back through the console (team-management::CON-001). */
  hasSecret(appId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM application_secret WHERE app_id = ?").get(appId));
  }

  /** The stored secret of a team application, for the service's own calls to the platform only. */
  secret(appId: string): string | undefined {
    const row = this.database.prepare("SELECT secret FROM application_secret WHERE app_id = ?").get(appId);
    return row ? String(row.secret) : undefined;
  }

  /**
   * The current version as today's fixed-roster readers consume it: dispatch groups plus the Coordinator and every Team Leader
   * with its application, whatever its group bindings. Which teams take work in a group comes from `acceptingTeams`.
   * Refuses definitions those readers cannot represent rather than widening any team's reach.
   */
  roster(connection: Readonly<{ appId: string; appSecret: string }>): Readonly<FeishuDispatchConfiguration> {
    const current = this.current();
    if (!current) throw new Error("team_registry_empty");
    const { coordinator, dispatchGroups, teams } = current.definitions;
    // A team may be bound to some dispatch groups and in any binding state; dispatch routes per group (agent-dispatch::REQ-015/AC-01).
    if (coordinator.appId !== connection.appId ||
        teams.some(({ bindings }) => bindings.some(({ chatId }) => !dispatchGroups.includes(chatId))) ||
        new Set([coordinator.id, ...teams.map(({ id }) => id)]).size !== teams.length + 1 ||
        new Set([coordinator.appId, ...teams.flatMap(({ leader }) => leader.appId ? [leader.appId] : [])]).size !== teams.filter(({ leader }) => leader.appId).length + 1) throw new Error("team_registry_roster_unsupported");
    return deepFreeze({ groupChatIds: [...dispatchGroups], agents: [
      { id: coordinator.id, name: coordinator.name, responsibility: coordinator.responsibility, appId: coordinator.appId, appSecret: connection.appSecret },
      // A team without an application or a stored secret has no identity to post with yet; it is onboarding, not a startup failure.
      ...teams.flatMap(({ id, responsibility, leader }) => {
        const secret = leader.appId ? this.secret(leader.appId) : undefined;
        return secret === undefined ? [] : [{ id, name: leader.name, responsibility, appId: leader.appId, appSecret: secret }];
      }),
    ] });
  }

  /** The latest definitions version, or undefined before the first import. */
  current(): DefinitionsVersion | undefined {
    return this.row(this.database.prepare("SELECT * FROM definitions_version ORDER BY version DESC LIMIT 1").get());
  }

  /** A stored definitions version; versions are never changed once saved. */
  version(version: number): DefinitionsVersion | undefined {
    return this.row(this.database.prepare("SELECT * FROM definitions_version WHERE version = ?").get(version));
  }

  close(): void { this.database.close(); }

  /** Appends a version unless it equals the latest; a save that changes nothing leaves the version as it is. */
  private append(definitions: TeamDefinitions, latest: number, source: DefinitionsVersion["source"]): void {
    const serialized = JSON.stringify(definitions);
    if (this.database.prepare("SELECT definitions FROM definitions_version WHERE version = ?").get(latest)?.definitions === serialized) return;
    this.database.prepare("INSERT INTO definitions_version (version, based_on, source, definitions) VALUES (?, ?, ?, ?)").run(latest + 1, latest, source, serialized);
  }

  /** Drops the secrets of applications no team uses any more. */
  private forgetUnusedApplications(): void {
    const used = new Set(this.current()!.definitions.teams.map(({ leader }) => leader.appId));
    for (const table of ["application_secret", "onboarding_outcome"]) {
      for (const row of this.database.prepare(`SELECT DISTINCT app_id FROM ${table}`).all()) {
        if (!used.has(String(row.app_id))) this.database.prepare(`DELETE FROM ${table} WHERE app_id = ?`).run(String(row.app_id));
      }
    }
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { action(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private row(row: Record<string, unknown> | undefined): DefinitionsVersion | undefined {
    if (!row) return undefined;
    return deepFreeze({ version: Number(row.version), basedOn: row.based_on === null ? null : Number(row.based_on),
      source: row.source as DefinitionsVersion["source"], definitions: JSON.parse(String(row.definitions)) as TeamDefinitions });
  }
}

/**
 * The teams that accept work in a group, in registry order, as the Coordinator routes to them and every Team Leader's Team
 * Directory lists them there: team name and responsibility (agent-dispatch::REQ-015, team-management::REQ-004/AC-02).
 */
export function acceptingTeams(definitions: TeamDefinitions, chatId: string): Array<{ id: string; name: string; responsibility: string }> {
  return definitions.teams.filter(({ bindings }) => bindings.some((binding) => binding.chatId === chatId && binding.state === "accepting"))
    .map(({ id, teamName, responsibility }) => ({ id, name: teamName, responsibility }));
}

/** The parts of a team the console edits; binding states are the registry's own, so they are not compared. */
function editable(team: TeamDefinition) {
  return { teamName: team.teamName, responsibility: team.responsibility, leader: { name: team.leader.name, appId: team.leader.appId, instructions: team.leader.profile.instructions },
    profiles: team.executorProfiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun: noun ?? DEFAULT_EXECUTOR_NOUN, instructions, hostTools })),
    groups: team.bindings.filter(({ state }) => state !== "draining" && state !== "removed").map(({ chatId }) => chatId) };
}

/** Why a team cannot be saved (team-management::REQ-002), in the order the save bar lists them. */
function teamReasons(edit: TeamEdit, definitions: TeamDefinitions, reserved: Readonly<Record<string, string>>): string[] {
  const reasons: string[] = [];
  if (!edit.leader.name.trim()) reasons.push("缺少负责人名称");
  if (!edit.teamName.trim()) reasons.push("缺少团队名称");
  if (!edit.executorProfiles.length) reasons.push("至少需要一个执行者能力档");
  const names = edit.executorProfiles.map(({ name }) => name.trim());
  if (names.some((name) => !name)) reasons.push("能力档名称不能为空");
  const duplicate = names.find((name, index) => name && names.indexOf(name) !== index);
  if (duplicate) reasons.push(`两个能力档同名：「${duplicate}」`);
  const appId = edit.leader.appId.trim();
  if (appId && !APPLICATION_ID.test(appId)) reasons.push(`App ID ${appId} 格式不正确，应为 cli_ 加 16 位十六进制字符`);
  const user = appId === definitions.coordinator.appId ? definitions.coordinator.name
    : definitions.teams.find(({ id, leader }) => id !== edit.id && leader.appId === appId)?.leader.name;
  if (appId && user) reasons.push(`App ID ${appId} 已被 ${user} 使用，每个团队需要自己的飞书应用`);
  // An application reserved outside the registry, such as Penny's private financial bot, never posts for a team (ADR-0025).
  if (appId && Object.hasOwn(reserved, appId)) reasons.push(reserved[appId]!);
  return reasons;
}

function seededDefinitions(local: Readonly<FeishuDispatchConfiguration>, executorHostTools: readonly string[]): TeamDefinitions {
  const coordinator = local.agents.find(({ id }) => id === COORDINATOR_ID);
  if (!coordinator) throw new Error("team_registry_coordinator_missing");
  return {
    coordinator: { id: COORDINATOR_ID, name: coordinator.name, teamName: "总协调", responsibility: coordinator.responsibility, appId: coordinator.appId, profile: EMPTY_PROFILE },
    dispatchGroups: [...local.groupChatIds],
    teams: local.agents.filter(({ id }) => id !== COORDINATOR_ID).map((agent) => ({
      id: agent.id, teamName: SEEDED_TEAM_NAMES[agent.id] ?? `${agent.name} 团队`, responsibility: agent.responsibility,
      leader: { name: agent.name, appId: agent.appId, profile: EMPTY_PROFILE },
      executorProfiles: [{ id: "executor-1", name: "能力档 1", noun: DEFAULT_EXECUTOR_NOUN, instructions: SEEDED_EXECUTOR_INSTRUCTIONS[agent.id] ?? "", hostTools: [...executorHostTools] }],
      bindings: local.groupChatIds.map((chatId) => ({ chatId, state: "accepting" as const })),
    })),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
