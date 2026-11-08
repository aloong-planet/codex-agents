import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FeishuDispatchConfiguration } from "./feishu-agent-config.js";

/** The Coordinator's fixed identity: Sam cannot be replaced, deleted or unbound (team-management::REQ-001/AC-01). */
export const COORDINATOR_ID = "sam";

/** Today's domain paragraph for every specialist turn; the seeded Executor profiles carry it verbatim. */
export const INITIAL_EXECUTOR_INSTRUCTIONS = "需要实时信息时先检索并读取可靠来源，来源必须支持对应事实，不能只把链接列在文末冒充查证。搜索摘要可能缓存旧内容，天气等持续更新的信息必须打开官方页面核对发布时间，注明来源发布时点；无法取得当前内容时明确标注未核实，不把旧预报写成最新预报。出行路线须逐段核对站名、线路和换乘站，不能凭记忆拼接；区分景区名称与地铁站名称。步行入口、方位、距离和耗时没有地图或官方资料支持时，不猜测具体数值或地点，标注需现场导航并预留弹性时间。开放时间、预约要求和天气须附本轮查证来源；未核实的明确标注并提供可行备选，不写成确定事实。交付文件前复核其事实与来源是否相符、预算和时间安排是否自洽。";

/** An agent's instructions and host-tool allowlist. MCP servers and skills join with their catalogs. */
export type AgentProfile = Readonly<{ instructions: string; hostTools: readonly string[] }>;
/** One of a team's preset Agent Profiles for its Executors; `id` stays stable across renames. */
export type ExecutorProfile = AgentProfile & Readonly<{ id: string; name: string }>;
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
export type DefinitionsVersion = Readonly<{ version: number; basedOn: number | null; source: "local_configuration" | "console"; definitions: TeamDefinitions }>;

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
      CREATE TABLE IF NOT EXISTS application_secret (app_id TEXT PRIMARY KEY, secret TEXT NOT NULL);`);
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
   * The current version as today's fixed-roster readers consume it: dispatch groups plus the Coordinator and every Team Leader
   * with its application. Refuses definitions those readers cannot represent rather than widening any team's reach.
   */
  roster(connection: Readonly<{ appId: string; appSecret: string }>): Readonly<FeishuDispatchConfiguration> {
    const current = this.current();
    if (!current) throw new Error("team_registry_empty");
    const { coordinator, dispatchGroups, teams } = current.definitions;
    const groups = JSON.stringify([...dispatchGroups].sort());
    if (coordinator.appId !== connection.appId ||
        teams.some(({ bindings }) => bindings.some(({ state }) => state !== "accepting") || JSON.stringify(bindings.map(({ chatId }) => chatId).sort()) !== groups) ||
        new Set([coordinator.id, ...teams.map(({ id }) => id)]).size !== teams.length + 1 ||
        new Set([coordinator.appId, ...teams.map(({ leader }) => leader.appId)]).size !== teams.length + 1) throw new Error("team_registry_roster_unsupported");
    return deepFreeze({ groupChatIds: [...dispatchGroups], agents: [
      { id: coordinator.id, name: coordinator.name, responsibility: coordinator.responsibility, appId: coordinator.appId, appSecret: connection.appSecret },
      ...teams.map(({ id, responsibility, leader }) => {
        const secret = this.database.prepare("SELECT secret FROM application_secret WHERE app_id = ?").get(leader.appId);
        if (!secret) throw new Error("team_registry_secret_missing");
        return { id, name: leader.name, responsibility, appId: leader.appId, appSecret: String(secret.secret) };
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

function seededDefinitions(local: Readonly<FeishuDispatchConfiguration>, executorHostTools: readonly string[]): TeamDefinitions {
  const coordinator = local.agents.find(({ id }) => id === COORDINATOR_ID);
  if (!coordinator) throw new Error("team_registry_coordinator_missing");
  return {
    coordinator: { id: COORDINATOR_ID, name: coordinator.name, teamName: "总协调", responsibility: coordinator.responsibility, appId: coordinator.appId, profile: EMPTY_PROFILE },
    dispatchGroups: [...local.groupChatIds],
    teams: local.agents.filter(({ id }) => id !== COORDINATOR_ID).map((agent) => ({
      id: agent.id, teamName: SEEDED_TEAM_NAMES[agent.id] ?? `${agent.name} 团队`, responsibility: agent.responsibility,
      leader: { name: agent.name, appId: agent.appId, profile: EMPTY_PROFILE },
      executorProfiles: [{ id: "executor-1", name: "能力档 1", instructions: INITIAL_EXECUTOR_INSTRUCTIONS, hostTools: [...executorHostTools] }],
      bindings: local.groupChatIds.map((chatId) => ({ chatId, state: "accepting" as const })),
    })),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
