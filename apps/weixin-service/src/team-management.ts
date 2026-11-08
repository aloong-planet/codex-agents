import { effectiveHostTools } from "./agent-profile.js";
import type { ConsoleBrowser } from "./console-access.js";
import type { ConsoleAudit } from "./console-audit.js";
import type { FeishuDispatchConfiguration } from "./feishu-agent-config.js";
import type { AnnouncementSend, TeamAnnouncements } from "./team-announcements.js";
import { type ApplicationCredentials, type OnboardingPlatform, TeamOnboarding } from "./team-onboarding.js";
import { acceptingTeams, COORDINATOR_ID, DEFAULT_EXECUTOR_NOUN, type DefinitionsVersion, type OnboardingOutcome, type TeamDefinition,
  TeamDefinitionError, type TeamEdit, type TeamRegistry } from "./team-registry.js";

/** A console input that is not a team definition at all; the page never sends one. */
export class TeamInputError extends Error {}

/** Who made a change: an authorized browser, or the service itself (startup onboarding). */
export type TeamActor = Readonly<{ browser?: ConsoleBrowser }>;

export type TeamManagementOptions = Readonly<{
  registry: TeamRegistry;
  /** The Coordinator's application: it adds bots to groups and reads group names. */
  coordinator: ApplicationCredentials;
  platform: OnboardingPlatform;
  announcements: TeamAnnouncements;
  audit: ConsoleAudit;
  /** Every host tool of the production catalog. */
  catalogToolIds: readonly string[];
  /** The scopes of the saved module permissions the file tools use, for the effective tools. */
  moduleScopes(): ReadonlyArray<Readonly<{ read: boolean; write: boolean }>>;
  /** A team's active Assignments (queued, running or waiting). */
  activeAssignments(teamId: string): number;
  /** Called when the roster (applications and their secrets) changes, so that main can start new sending applications. */
  rosterChanged(roster: Readonly<FeishuDispatchConfiguration>): void;
  /** Applications no team may use, such as Penny's, each with the reason the save bar shows. */
  reservedApplications?(): Readonly<Record<string, string>>;
  report(code: string): void;
  now?: () => number;
}>;

const joinText = (team: TeamDefinition) => `${team.leader.name}（${team.teamName}）已加入本群，负责：${team.responsibility}`;
const leaveText = (team: TeamDefinition) => `${team.leader.name}（${team.teamName}）已离开本群，不再接新的事务；进行中的事务会做完。`;

/**
 * Team management as the running service applies it (team-management spec): console saves and their audit, onboarding of
 * existing applications, the Coordinator's join and leave announcements, and the live roster every dispatch reader takes.
 * A saved change applies to requests admitted afterwards; requests keep their definitions version (agent-dispatch::REQ-017).
 */
export class TeamManagement {
  private readonly onboarding: TeamOnboarding;
  private roster_: Readonly<FeishuDispatchConfiguration>;
  private send: AnnouncementSend | undefined;
  private readonly groupNames = new Map<string, string>();

  constructor(private readonly options: TeamManagementOptions) {
    this.onboarding = new TeamOnboarding(options.registry, options.platform, options.coordinator, options.now);
    this.roster_ = options.registry.roster(options.coordinator);
  }

  /** The current definitions version; every new request and routing decision reads it. */
  current(): DefinitionsVersion { return this.options.registry.current()!; }
  /** A stored definitions version, as a request admitted under it uses it. */
  version(version: number): DefinitionsVersion | undefined { return this.options.registry.version(version); }
  /** The Coordinator and the Team Leaders with a sending application, with their secrets. */
  roster(): Readonly<FeishuDispatchConfiguration> { return this.roster_; }

  /** Starts announcement delivery through the Coordinator's group channel, and sends what is pending. */
  deliverAnnouncementsWith(send: AnnouncementSend): void {
    this.send = send;
    this.deliver();
  }

  /** Resumes onboarding at startup without repeating finished steps. */
  async resume(): Promise<void> {
    this.announceJoins(await this.onboarding.resume());
  }

  /** Saves one team from the console; returns the team's ID. Onboarding of its application continues in the background. */
  saveTeam(input: unknown, options: Readonly<{ basedOn: unknown; actor: TeamActor }>): string {
    const { edit, secret } = parseTeamEdit(input, this.options.catalogToolIds);
    const basedOn = parseVersion(options.basedOn);
    const before = edit.id === undefined ? undefined : this.current().definitions.teams.find(({ id }) => id === edit.id);
    const { version, teamId } = this.options.registry.saveTeam(edit, { basedOn, reserved: this.options.reservedApplications?.() ?? {}, ...(secret === undefined ? {} : { secret }) });
    const after = version.definitions.teams.find(({ id }) => id === teamId)!;
    this.auditTeamSave(before, after, secret !== undefined, version.version, options.actor);
    // Removing a team from a group starts at once: the Coordinator announces that it left (team-management::REQ-004/AC-01).
    for (const binding of after.bindings) {
      if (binding.state === "draining" && before?.bindings.some(({ chatId, state }) => chatId === binding.chatId && state === "accepting")) {
        this.options.announcements.enqueue({ chatId: binding.chatId, teamId, kind: "leave", text: leaveText(after) });
      }
    }
    this.refreshRoster();
    this.deliver();
    void this.runOnboarding(teamId, options.actor, false);
    return teamId;
  }

  /** Saves Sam's responsibility and instructions, the only parts the console may change (team-management::REQ-001/AC-01). */
  saveCoordinator(input: unknown, options: Readonly<{ basedOn: unknown; actor: TeamActor }>): void {
    const value = object(input);
    const responsibility = text(value.responsibility, "职责"), instructions = text(value.instructions, "提示词");
    const keys = Object.keys(value).filter((key) => key !== "responsibility" && key !== "instructions");
    if (keys.length) throw new TeamInputError("Sam 只能修改职责与提示词");
    const before = this.current().definitions.coordinator;
    const saved = this.options.registry.saveCoordinator({ responsibility, instructions }, { basedOn: parseVersion(options.basedOn) });
    const changed = [...(before.responsibility !== saved.definitions.coordinator.responsibility ? ["responsibility"] : []),
      ...(before.profile.instructions !== saved.definitions.coordinator.profile.instructions ? ["instructions"] : [])];
    if (changed.length) this.audit(options.actor, { event: "team_changed", team: COORDINATOR_ID, version: saved.version, changed });
    this.refreshRoster();
  }

  /** Runs a team's onboarding steps again, as 「重新检查」 does, and waits for the outcome. */
  async recheck(teamId: unknown, actor: TeamActor): Promise<void> {
    if (typeof teamId !== "string" || !this.current().definitions.teams.some(({ id }) => id === teamId)) throw new TeamInputError("团队不存在");
    await this.runOnboarding(teamId, actor, true);
  }

  /** The console's view: no secret value ever appears in it (team-management::CON-001). */
  async view(): Promise<TeamsView> {
    const current = this.current(), { definitions } = current;
    await Promise.all(definitions.dispatchGroups.filter((chatId) => !this.groupNames.has(chatId)).map(async (chatId) => {
      // A name the platform cannot give falls back to the chat ID, without blocking the page (ticket 11, decision D4).
      const name = await this.options.platform.chatName(chatId, this.options.coordinator).catch(() => undefined);
      if (name) this.groupNames.set(chatId, name);
    }));
    const scopes = this.options.moduleScopes();
    const latest = new Map<string, TeamsView["teams"][number]["announcements"][string]>();
    for (const { chatId, teamId, kind, state, text: message } of this.options.announcements.list()) latest.set(`${teamId}\n${chatId}`, { kind, state, text: message });
    return {
      configured: true, version: current.version,
      groups: definitions.dispatchGroups.map((chatId) => ({ chatId, name: this.groupNames.get(chatId) ?? chatId })),
      tools: effectiveHostTools(this.options.catalogToolIds, scopes).offered.reduce((granted, id) => ({ ...granted, [id]: true }),
        Object.fromEntries(this.options.catalogToolIds.map((id) => [id, false])) as Record<string, boolean>),
      coordinator: { id: COORDINATOR_ID, name: definitions.coordinator.name, teamName: definitions.coordinator.teamName,
        responsibility: definitions.coordinator.responsibility, instructions: definitions.coordinator.profile.instructions, appId: definitions.coordinator.appId },
      teams: definitions.teams.map((team) => {
        const record = team.leader.appId ? this.options.registry.onboarding(team.leader.appId) : { joins: {} };
        return { id: team.id, teamName: team.teamName, responsibility: team.responsibility,
          leader: { name: team.leader.name, appId: team.leader.appId, instructions: team.leader.profile.instructions },
          secretStored: Boolean(team.leader.appId) && this.options.registry.hasSecret(team.leader.appId),
          ...(record.credentials ? { credentials: record.credentials } : {}),
          bindings: team.bindings.filter(({ state }) => state !== "removed").map(({ chatId, state }) => ({ chatId, state, ...(record.joins[chatId] ? { join: record.joins[chatId] } : {}) })),
          profiles: team.executorProfiles.map(({ id, name, noun, instructions, hostTools }) => {
            const effective = effectiveHostTools(hostTools, scopes);
            return { id, name, noun: noun || DEFAULT_EXECUTOR_NOUN, instructions, hostTools: [...hostTools], effective: effective.offered, ungranted: effective.ungranted };
          }),
          activeAssignments: this.options.activeAssignments(team.id),
          announcements: Object.fromEntries(team.bindings.flatMap(({ chatId }) => latest.has(`${team.id}\n${chatId}`) ? [[chatId, latest.get(`${team.id}\n${chatId}`)!]] : [])) };
      }),
      preview: Object.fromEntries(definitions.dispatchGroups.map((chatId) => [chatId, acceptingTeams(definitions, chatId).map(({ id }) => id)])),
    };
  }

  private async runOnboarding(teamId: string, actor: TeamActor, requested: boolean): Promise<void> {
    try {
      const started = await this.onboarding.run(teamId);
      const team = this.current().definitions.teams.find(({ id }) => id === teamId);
      if (requested || team?.leader.appId) {
        const record = team?.leader.appId ? this.options.registry.onboarding(team.leader.appId) : { joins: {} };
        this.audit(actor, { event: "team_onboarding_checked", team: teamId, ...(team?.leader.appId ? { appId: team.leader.appId } : {}),
          credentials: record.credentials ? outcome(record.credentials) : null,
          groups: Object.fromEntries(Object.entries(record.joins).map(([chatId, value]) => [chatId, outcome(value)])) });
      }
      this.announceJoins(started);
    } catch (error) {
      this.options.report(`team_onboarding_failed: ${error instanceof Error ? error.message : "error"}`);
    }
  }

  private announceJoins(started: ReadonlyArray<Readonly<{ teamId: string; chatId: string }>>): void {
    if (!started.length) return;
    const { definitions, version } = this.current();
    for (const { teamId, chatId } of started) {
      const team = definitions.teams.find(({ id }) => id === teamId);
      if (!team) continue;
      this.options.announcements.enqueue({ chatId, teamId, kind: "join", text: joinText(team) });
      this.audit({}, { event: "team_binding_accepting", team: teamId, group: chatId, version });
    }
    this.refreshRoster();
    this.deliver();
  }

  private deliver(): void {
    if (!this.send) return;
    this.options.announcements.deliver(this.send).catch(() => this.options.report("team_announcement_delivery_failed"));
  }

  private refreshRoster(): void {
    const next = this.options.registry.roster(this.options.coordinator);
    if (JSON.stringify(next) === JSON.stringify(this.roster_)) return;
    this.roster_ = next;
    this.options.rosterChanged(next);
  }

  /** One audit entry per kind of change, naming what changed and never a secret value (agent-console::REQ-004). */
  private auditTeamSave(before: TeamDefinition | undefined, after: TeamDefinition, secretWritten: boolean, version: number, actor: TeamActor): void {
    const changed = before === undefined ? ["created"] : [
      ...(before.teamName !== after.teamName ? ["teamName"] : []), ...(before.responsibility !== after.responsibility ? ["responsibility"] : []),
      ...(before.leader.name !== after.leader.name ? ["leader.name"] : []), ...(before.leader.appId !== after.leader.appId ? ["leader.appId"] : []),
      ...(before.leader.profile.instructions !== after.leader.profile.instructions ? ["leader.instructions"] : [])];
    if (changed.length) this.audit(actor, { event: "team_changed", team: after.id, version, changed, ...(before === undefined ? { teamName: after.teamName } : {}) });
    if (secretWritten) this.audit(actor, { event: "team_secret_written", team: after.id, appId: after.leader.appId, version });
    const states = (team: TeamDefinition | undefined) => new Map((team?.bindings ?? []).map(({ chatId, state }) => [chatId, state]));
    const old = states(before), now = states(after);
    for (const chatId of new Set([...old.keys(), ...now.keys()])) {
      if (old.get(chatId) !== now.get(chatId)) this.audit(actor, { event: "team_binding_changed", team: after.id, group: chatId, version,
        from: old.get(chatId) ?? null, to: now.get(chatId) ?? null });
    }
    const profiles = new Map((before?.executorProfiles ?? []).map((profile) => [profile.id, JSON.stringify(profile)]));
    for (const profile of after.executorProfiles) {
      if (profiles.get(profile.id) !== JSON.stringify(profile)) this.audit(actor, { event: "team_profile_saved", team: after.id, profile: profile.id, version });
      profiles.delete(profile.id);
    }
    for (const profile of profiles.keys()) this.audit(actor, { event: "team_profile_removed", team: after.id, profile, version });
  }

  private audit(actor: TeamActor, entry: Record<string, unknown>): void {
    this.options.audit.tryAppend({ by: actor.browser ? "browser" : "service", ...(actor.browser ? { browser: { id: actor.browser.id, label: actor.browser.label } } : {}), ...entry });
  }
}

export type TeamsView = Readonly<{
  configured: true; version: number;
  groups: Array<{ chatId: string; name: string }>;
  /** Each catalog host tool and whether module permissions grant it. */
  tools: Record<string, boolean>;
  coordinator: { id: string; name: string; teamName: string; responsibility: string; instructions: string; appId: string };
  teams: Array<{
    id: string; teamName: string; responsibility: string; leader: { name: string; appId: string; instructions: string }; secretStored: boolean;
    credentials?: OnboardingOutcome; bindings: Array<{ chatId: string; state: string; join?: OnboardingOutcome }>;
    profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[]; effective: string[]; ungranted: string[] }>;
    activeAssignments: number;
    announcements: Record<string, { kind: "join" | "leave"; state: string; text: string }>;
  }>;
  /** Per group, the teams the Coordinator can dispatch to there (team-management::US-001/AC-03). */
  preview: Record<string, string[]>;
}>;

const outcome = ({ status, reason }: OnboardingOutcome) => reason ? `${status}:${reason}` : status;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TeamInputError("团队定义格式无效");
  return value as Record<string, unknown>;
}
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > 20_000) throw new TeamInputError(`${what}格式无效`);
  return value;
}
function parseVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TeamInputError("版本无效");
  return value as number;
}
/** The team the console sends, checked for shape only; the registry judges its content (team-management::REQ-002). */
function parseTeamEdit(input: unknown, catalogToolIds: readonly string[]): Readonly<{ edit: TeamEdit; secret?: string }> {
  const value = object(input), leader = object(value.leader);
  if (value.id !== undefined && typeof value.id !== "string") throw new TeamInputError("团队编号无效");
  if (!Array.isArray(value.executorProfiles) || value.executorProfiles.length > 20) throw new TeamInputError("能力档格式无效");
  if (!Array.isArray(value.groups) || !value.groups.every((group) => typeof group === "string")) throw new TeamInputError("所属群格式无效");
  const secret = value.secret === undefined ? undefined : text(value.secret, "App Secret");
  if (secret !== undefined && (!secret.trim() || secret.length > 256)) throw new TeamInputError("App Secret 格式无效");
  const executorProfiles = value.executorProfiles.map((item) => {
    const profile = object(item);
    if (profile.id !== undefined && typeof profile.id !== "string") throw new TeamInputError("能力档编号无效");
    if (!Array.isArray(profile.hostTools) || !profile.hostTools.every((tool) => typeof tool === "string" && catalogToolIds.includes(tool))) throw new TeamInputError("工具格式无效");
    return { ...(profile.id === undefined ? {} : { id: profile.id as string }), name: text(profile.name, "能力档名称"), noun: text(profile.noun, "执行者称呼"),
      instructions: text(profile.instructions, "执行者提示词"), hostTools: profile.hostTools as string[] };
  });
  const edit: TeamEdit = { ...(value.id === undefined ? {} : { id: value.id as string }), teamName: text(value.teamName, "团队名称"),
    responsibility: text(value.responsibility, "职责"),
    leader: { name: text(leader.name, "负责人名称"), appId: text(leader.appId, "App ID"), instructions: text(leader.instructions, "负责人提示词") },
    executorProfiles, groups: value.groups as string[] };
  return { edit, ...(secret === undefined ? {} : { secret }) };
}

export { TeamDefinitionError };
