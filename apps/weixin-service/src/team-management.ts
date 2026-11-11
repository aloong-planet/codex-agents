import { effectiveHostTools } from "./agent-profile.js";
import type { ConsoleBrowser } from "./console-access.js";
import type { ConsoleAudit } from "./console-audit.js";
import type { FeishuDispatchConfiguration } from "./feishu-agent-config.js";
import { GroupNames } from "./group-names.js";
import type { AnnouncementSend, TeamAnnouncements } from "./team-announcements.js";
import { type ApplicationCredentials, type OnboardingPlatform, TeamOnboarding } from "./team-onboarding.js";
import { acceptingTeams, COORDINATOR_ID, DEFAULT_EXECUTOR_NOUN, type DefinitionsVersion, type OnboardingOutcome, type TeamDefinition,
  TeamDefinitionError, type TeamEdit, type TeamRegistry } from "./team-registry.js";

/** A console input that is not a team definition at all; the page never sends one. */
export class TeamInputError extends Error {}

/** A scheduled task that cannot be moved or deleted now, because it is executing or sending. */
export class TeamTaskBusyError extends Error {}

/** Who made a change: an authorized browser, or the service itself (startup onboarding, a removal that completes). */
export type TeamActor = Readonly<{ browser?: ConsoleBrowser }>;

/** A request, or a group post still to be sent, that involves a team in a chat (agent-dispatch's `TeamWork`, as the console names it). */
export type TeamWorkItem = Readonly<{ chatId: string; requestId: string; label: string; summary: string; requester: "owner" | "member";
  active: number; awaitingRequester: number; waitingFor: readonly string[] | null }>;
/** A scheduled task as a removal lists it. */
export type SenderTask = Readonly<{ id: string; name: string; when: string; chatId: string }>;

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
  /** Active Assignments (queued, running or waiting) by team, counted once per view. */
  activeAssignments(): Readonly<Record<string, number>>;
  /** What still involves a team, one entry per request (team-management::US-004/AC-02, AC-04). */
  work(teamId: string): readonly TeamWorkItem[];
  /** Scheduled tasks by the application they send with (team-management::US-004/AC-03, REQ-005). */
  tasks: Readonly<{
    sentBy(appId: string): readonly SenderTask[];
    move(taskId: string, fromAppId: string, toAppId: string): "moved" | "busy" | "unknown";
    delete(taskId: string, fromAppId: string): "deleted" | "busy" | "unknown";
  }>;
  /** Called when the roster (applications and their secrets) changes, so that main can start new sending applications. */
  rosterChanged(roster: Readonly<FeishuDispatchConfiguration>): void;
  /** Applications no team may use, such as Penny's, each with the reason the save bar shows. */
  reservedApplications?(): Readonly<Record<string, string>>;
  report(code: string): void;
  now?: () => number;
  /** Group names shared with the dispatch-group form; without it, team management reads names on its own. */
  groupNames?: GroupNames;
}>;

const joinText = (team: TeamDefinition) => `${team.leader.name}（${team.teamName}）已加入本群，负责：${team.responsibility}`;
const leaveText = (team: TeamDefinition) => `${team.leader.name}（${team.teamName}）已离开本群，不再接新的事务；进行中的事务会做完。`;
// Why a deletion or a removal's task action was refused. The page shows each after naming the action that did not happen.
const TEAM_GONE = "这个团队已不存在，请刷新页面。", TASK_GONE = "这项定时任务已不存在，请刷新页面。";

/**
 * Team management as the running service applies it (team-management spec): console saves and their audit, onboarding of
 * existing applications, the Coordinator's join and leave announcements, and the live roster every dispatch reader takes.
 * A saved change applies to requests admitted afterwards; requests keep their definitions version (agent-dispatch::REQ-017).
 */
export class TeamManagement {
  private readonly onboarding: TeamOnboarding;
  private roster_: Readonly<FeishuDispatchConfiguration>;
  private send: AnnouncementSend | undefined;
  private readonly groupNames: GroupNames;

  constructor(private readonly options: TeamManagementOptions) {
    this.onboarding = new TeamOnboarding(options.registry, options.platform, options.coordinator, options.now);
    this.roster_ = options.registry.roster(options.coordinator);
    this.groupNames = options.groupNames ?? new GroupNames(options.platform, options.coordinator, options.now);
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
    this.groupNames.forgetFailed(edit.groups);
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
    this.settle();
    void this.runOnboarding(teamId, options.actor, false);
    return teamId;
  }

  /**
   * Starts deleting a team (team-management::US-004/AC-01): it stops accepting work in every group at once, the Coordinator
   * announces in each that it left, and the team leaves the definitions when its last removal completes.
   */
  deleteTeam(teamId: unknown, actor: TeamActor): void {
    const before = this.current().definitions.teams.find(({ id }) => id === teamId);
    if (typeof teamId !== "string" || (!before && teamId !== COORDINATOR_ID)) throw new TeamInputError(TEAM_GONE);
    const { version, started, removed } = this.options.registry.deleteTeam(teamId);
    if (before && !before.deleting) {
      this.audit(actor, { event: "team_delete_started", team: teamId, teamName: before.teamName, version: version.version, groups: started });
      this.auditBindings(before, version.definitions.teams.find(({ id }) => id === teamId), version.version, actor);
      if (removed) this.audit(actor, { event: "team_deleted", team: teamId, teamName: before.teamName, version: version.version });
      for (const chatId of started) this.options.announcements.enqueue({ chatId, teamId, kind: "leave", text: leaveText(before) });
    }
    this.refreshRoster();
    this.deliver();
    this.settle();
  }

  /**
   * Completes every removal nothing holds any more (team-management::US-004/AC-02): a team is unbound from a group it drains in
   * once no request, group post or scheduled task of its own is left there, and a team being deleted then leaves the definitions.
   * Called whenever that may have changed: after a save or a deletion, when dispatch work ends, after a scheduler round, at startup.
   */
  settle(): void {
    const draining = this.current().definitions.teams.filter(({ bindings }) => bindings.some(({ state }) => state === "draining"));
    if (!draining.length) return;
    const held = new Map(draining.map((team) => [team.id, new Set([...this.options.work(team.id), ...this.tasksOf(team)].map(({ chatId }) => chatId))]));
    const { unbound, deleted } = this.options.registry.settleRemovals((teamId, chatId) => held.get(teamId)?.has(chatId) === false);
    if (!unbound.length && !deleted.length) return;
    const { version } = this.current();
    for (const { teamId, chatId } of unbound) this.audit({}, { event: "team_binding_changed", team: teamId, group: chatId, version, from: "draining", to: "removed" });
    for (const teamId of deleted) this.audit({}, { event: "team_deleted", team: teamId, teamName: draining.find(({ id }) => id === teamId)?.teamName, version });
    this.refreshRoster();
  }

  /** Moves a scheduled task a removal lists to another team that accepts work in the task's group (team-management::REQ-005). */
  moveTask(teamId: unknown, taskId: unknown, to: unknown, actor: TeamActor): void {
    const { team, task } = this.removalTask(teamId, taskId);
    const { definitions } = this.current();
    const target = definitions.teams.find(({ id }) => id === to);
    if (!target) throw new TeamInputError("所选团队已不存在，请重新选择。");
    if (target.id === team.id || !acceptingTeams(definitions, task.chatId).some(({ id }) => id === target.id)) throw new TeamInputError(`${target.leader.name} 已不在该群接单，请重新选择。`);
    this.taskChanged(this.options.tasks.move(task.id, team.leader.appId, target.leader.appId));
    this.audit(actor, { event: "team_task_moved", team: team.id, task: task.id, name: task.name, group: task.chatId, to: target.id });
    this.settle();
  }

  /** Deletes a scheduled task a removal lists; its execution history stays (team-management::US-004/AC-03). */
  deleteTask(teamId: unknown, taskId: unknown, actor: TeamActor): void {
    const { team, task } = this.removalTask(teamId, taskId);
    this.taskChanged(this.options.tasks.delete(task.id, team.leader.appId));
    this.audit(actor, { event: "team_task_deleted", team: team.id, task: task.id, name: task.name, group: task.chatId });
    this.settle();
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
    const team = typeof teamId === "string" ? this.current().definitions.teams.find(({ id }) => id === teamId) : undefined;
    if (!team) throw new TeamInputError("团队不存在");
    this.groupNames.forgetFailed(team.bindings.map(({ chatId }) => chatId));
    await this.runOnboarding(team.id, actor, true);
  }

  /** The console's view: no secret value ever appears in it (team-management::CON-001). */
  async view(): Promise<TeamsView> {
    const current = this.current(), { definitions } = current;
    const names = await this.groupNames.of(definitions.dispatchGroups);
    const scopes = this.options.moduleScopes();
    const active = this.options.activeAssignments();
    const removal = (team: TeamDefinition, work: readonly TeamWorkItem[], tasks: readonly SenderTask[], chatId: string) => {
      const here = work.filter((item) => item.chatId === chatId);
      return { active: here.reduce((sum, item) => sum + item.active, 0), awaitingRequester: here.reduce((sum, item) => sum + item.awaitingRequester, 0), closing: here.filter((item) => !item.active && !item.waitingFor).length,
        tasks: tasks.filter((task) => task.chatId === chatId).map(({ id, name, when }) => ({ id, name, when })),
        waiting: here.flatMap(({ requestId, label, summary, requester, waitingFor }) => waitingFor ? [{ requestId, label, summary, requester, waitingFor: [...waitingFor] }] : []) };
    };
    const latest = new Map<string, TeamsView["teams"][number]["announcements"][string]>();
    for (const { chatId, teamId, kind, state, text: message } of this.options.announcements.list()) latest.set(`${teamId}\n${chatId}`, { kind, state, text: message });
    return {
      configured: true, version: current.version,
      groups: definitions.dispatchGroups.map((chatId) => ({ chatId, name: names[chatId] ?? chatId })),
      tools: effectiveHostTools(this.options.catalogToolIds, scopes).offered.reduce((granted, id) => ({ ...granted, [id]: true }),
        Object.fromEntries(this.options.catalogToolIds.map((id) => [id, false])) as Record<string, boolean>),
      coordinator: { id: COORDINATOR_ID, name: definitions.coordinator.name, teamName: definitions.coordinator.teamName,
        responsibility: definitions.coordinator.responsibility, instructions: definitions.coordinator.profile.instructions, appId: definitions.coordinator.appId },
      teams: definitions.teams.map((team) => {
        const record = team.leader.appId ? this.options.registry.onboarding(team.leader.appId) : { joins: {} };
        const draining = team.bindings.some(({ state }) => state === "draining");
        const work = draining ? this.options.work(team.id) : [], tasks = draining ? this.tasksOf(team) : [];
        return { id: team.id, teamName: team.teamName, responsibility: team.responsibility, deleting: team.deleting === true,
          leader: { name: team.leader.name, appId: team.leader.appId, instructions: team.leader.profile.instructions },
          secretStored: Boolean(team.leader.appId) && this.options.registry.hasSecret(team.leader.appId),
          ...(record.credentials ? { credentials: record.credentials } : {}),
          bindings: team.bindings.filter(({ state }) => state !== "removed").map(({ chatId, state }) => ({ chatId, state, ...(record.joins[chatId] ? { join: record.joins[chatId] } : {}),
            ...(state === "draining" ? { removal: removal(team, work, tasks, chatId) } : {}) })),
          profiles: team.executorProfiles.map(({ id, name, noun, instructions, hostTools }) => {
            const effective = effectiveHostTools(hostTools, scopes);
            return { id, name, noun: noun || DEFAULT_EXECUTOR_NOUN, instructions, hostTools: [...hostTools], effective: effective.offered, ungranted: effective.ungranted };
          }),
          activeAssignments: active[team.id] ?? 0,
          announcements: Object.fromEntries(team.bindings.flatMap(({ chatId }) => latest.has(`${team.id}\n${chatId}`) ? [[chatId, latest.get(`${team.id}\n${chatId}`)!]] : [])) };
      }),
      preview: Object.fromEntries(definitions.dispatchGroups.map((chatId) => [chatId, acceptingTeams(definitions, chatId).map(({ id }) => id)])),
    };
  }

  /** The scheduled tasks that send with the team's identity. */
  private tasksOf(team: TeamDefinition): readonly SenderTask[] {
    return team.leader.appId ? this.options.tasks.sentBy(team.leader.appId) : [];
  }

  /** A task one of the team's removals lists: it sends with the team's identity in a group the team drains in. */
  private removalTask(teamId: unknown, taskId: unknown): Readonly<{ team: TeamDefinition; task: SenderTask }> {
    const team = this.current().definitions.teams.find(({ id }) => id === teamId);
    if (!team) throw new TeamInputError(TEAM_GONE);
    const task = this.tasksOf(team).find(({ id, chatId }) => id === taskId && team.bindings.some((binding) => binding.chatId === chatId && binding.state === "draining"));
    if (!task) throw new TeamInputError(TASK_GONE);
    return { team, task };
  }

  private taskChanged(result: "moved" | "deleted" | "busy" | "unknown"): void {
    if (result === "busy") throw new TeamTaskBusyError("team_task_busy");
    if (result === "unknown") throw new TeamInputError(TASK_GONE);
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
    this.auditBindings(before, after, version, actor);
    const profiles = new Map((before?.executorProfiles ?? []).map((profile) => [profile.id, JSON.stringify(profile)]));
    for (const profile of after.executorProfiles) {
      if (profiles.get(profile.id) !== JSON.stringify(profile)) this.audit(actor, { event: "team_profile_saved", team: after.id, profile: profile.id, version });
      profiles.delete(profile.id);
    }
    for (const profile of profiles.keys()) this.audit(actor, { event: "team_profile_removed", team: after.id, profile, version });
  }

  /** One entry per binding whose state differs; a team that is new, or gone, has no binding on that side. */
  private auditBindings(before: TeamDefinition | undefined, after: TeamDefinition | undefined, version: number, actor: TeamActor): void {
    const states = (team: TeamDefinition | undefined) => new Map((team?.bindings ?? []).map(({ chatId, state }) => [chatId, state]));
    const old = states(before), now = states(after);
    for (const chatId of new Set([...old.keys(), ...now.keys()])) {
      if (old.get(chatId) !== now.get(chatId)) this.audit(actor, { event: "team_binding_changed", team: (after ?? before)!.id, group: chatId, version,
        from: old.get(chatId) ?? null, to: now.get(chatId) ?? null });
    }
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
    /** The team is being deleted: it is saved no more and leaves the list with its last removal (team-management::US-004). */
    deleting: boolean;
    credentials?: OnboardingOutcome; bindings: Array<{ chatId: string; state: string; join?: OnboardingOutcome; removal?: RemovalView }>;
    profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[]; effective: string[]; ungranted: string[] }>;
    activeAssignments: number;
    announcements: Record<string, { kind: "join" | "leave"; state: string; text: string }>;
  }>;
  /** Per group, the teams the Coordinator can dispatch to there (team-management::US-001/AC-03). */
  preview: Record<string, string[]>;
}>;

/**
 * What a removal still waits for in one group (team-management::US-004/AC-02 to AC-05): the team's queued and running
 * Assignments, its own Assignments that wait for their requester, the requests it has yet to close or whose group post is yet
 * to go out, the scheduled tasks that send with its identity, and the requests that wait for their requester, each with the
 * titles of the waiting Assignments. `active` and `awaitingRequester` together are the group's share of the team's
 * `activeAssignments`.
 */
export type RemovalView = { active: number; awaitingRequester: number; closing: number; tasks: Array<{ id: string; name: string; when: string }>;
  waiting: Array<{ requestId: string; label: string; summary: string; requester: "owner" | "member"; waitingFor: string[] }> };

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
