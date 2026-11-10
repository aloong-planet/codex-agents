import { randomUUID } from "node:crypto";

import QRCode from "qrcode";

import { effectiveHostTools } from "./agent-profile.js";
import type { ConsoleBrowser } from "./console-access.js";
import type { ConsoleAudit } from "./console-audit.js";
import type { FeishuDispatchConfiguration } from "./feishu-agent-config.js";
import { GroupNames } from "./group-names.js";
import type { AnnouncementSend, TeamAnnouncements } from "./team-announcements.js";
import { type ApplicationCredentials, type CreationEnd, type OnboardingPlatform, TeamOnboarding } from "./team-onboarding.js";
import { acceptingTeams, COORDINATOR_ID, DEFAULT_EXECUTOR_NOUN, type DefinitionsVersion, type OnboardingMethod, type OnboardingOutcome, type TeamDefinition,
  TeamDefinitionError, type TeamEdit, type TeamRegistry, type TestMessageOutcome } from "./team-registry.js";

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
  /** Active Assignments (queued, running or waiting) by team, counted once per view. */
  activeAssignments(): Readonly<Record<string, number>>;
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
const testText = (team: TeamDefinition) => `这是 ${team.leader.name}（${team.teamName}）的测试消息，用来确认可以在本群发言。`;

/**
 * Posts a team's test message in one group as the team's own application, once per `operationId`, and says what the platform
 * answered: accepted, rejected, or an outcome that is not known.
 */
export type TestMessageSend = (message: Readonly<{ teamId: string; appId: string; chatId: string; text: string; operationId: string }>) => Promise<"accepted" | "rejected" | "unknown">;

/**
 * Team management as the running service applies it (team-management spec): console saves and their audit, onboarding by QR
 * creation or with an existing application, the test message, the Coordinator's join and leave announcements, and the live
 * roster every dispatch reader takes. A saved change applies to requests admitted afterwards; requests keep their definitions
 * version (agent-dispatch::REQ-017).
 */
export class TeamManagement {
  private readonly onboarding: TeamOnboarding;
  private roster_: Readonly<FeishuDispatchConfiguration>;
  private send: AnnouncementSend | undefined;
  private sendTest: TestMessageSend | undefined;
  /** Teams whose test message is being sent, so that a second confirmation does not post it twice. */
  private readonly testing = new Set<string>();
  private readonly groupNames: GroupNames;
  private readonly now: () => number;

  constructor(private readonly options: TeamManagementOptions) {
    this.now = options.now ?? Date.now;
    // A QR code's wait ended with the previous process, and whether that code was confirmed since cannot be learned. The
    // audit says so before the creation step changes, and here, not once the channels are up: a start that stops early
    // would otherwise leave the step interrupted and the entry never written.
    options.registry.interruptCreations((team) => this.audit({}, { event: "team_application_qr_failed", team, reason: "interrupted" }));
    this.onboarding = new TeamOnboarding(options.registry, options.platform, options.coordinator, options.now,
      { creationEnded: (end) => this.creationEnded(end), reserved: () => options.reservedApplications?.() ?? {} });
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

  /** Posts test messages through each team's own sending application. */
  deliverTestMessagesWith(send: TestMessageSend): void { this.sendTest = send; }

  /** Resumes onboarding at startup without repeating finished steps. */
  async resume(): Promise<void> {
    this.announceJoins(await this.onboarding.resume());
  }

  /** Stops listening to every QR code, as at shutdown. */
  close(): void { this.onboarding.close(); }

  /**
   * Saves one team from the console; returns the team's ID. Onboarding of its application continues in the background. The
   * save that chooses QR creation asks for the team's first QR code; a save as an existing application takes the code off
   * the page.
   */
  saveTeam(input: unknown, options: Readonly<{ basedOn: unknown; actor: TeamActor }>): string {
    const { edit, secret } = parseTeamEdit(input, this.options.catalogToolIds);
    this.groupNames.forgetFailed(edit.groups);
    const basedOn = parseVersion(options.basedOn);
    const before = edit.id === undefined ? undefined : this.current().definitions.teams.find(({ id }) => id === edit.id);
    const { version, teamId, creation } = this.options.registry.saveTeam(edit, { basedOn, reserved: this.options.reservedApplications?.() ?? {}, at: this.now(),
      ...(secret === undefined ? {} : { secret }) });
    const after = version.definitions.teams.find(({ id }) => id === teamId)!;
    const method: OnboardingMethod = edit.method ?? "existing";
    this.auditTeamSave(before, after, secret !== undefined && method === "existing", version.version, options.actor, before === undefined || creation ? method : undefined);
    if (creation === "ended") this.onboarding.endCreation(teamId);
    if (creation === "started") void this.requestCreation(teamId, options.actor);
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
    const team = typeof teamId === "string" ? this.current().definitions.teams.find(({ id }) => id === teamId) : undefined;
    if (!team) throw new TeamInputError("团队不存在");
    this.groupNames.forgetFailed(team.bindings.map(({ chatId }) => chatId));
    await this.runOnboarding(team.id, actor, true);
  }

  /** Asks for a new QR code for a team in QR creation, as 「刷新二维码」 does, and waits until it is shown or could not be obtained. */
  async refreshCreation(teamId: unknown, actor: TeamActor): Promise<void> {
    const state = typeof teamId === "string" ? this.options.registry.creation(teamId) : undefined;
    if (!state) throw new TeamInputError("这个团队不在扫码创建中");
    if (state.status === "done") throw new TeamInputError("应用已经创建，不需要新的二维码");
    await this.requestCreation(teamId as string, actor);
  }

  /** The QR code a team's creation shows while it waits for the scan, as an SVG image; undefined when no code waits. */
  async creationCode(teamId: string): Promise<string | undefined> {
    const link = this.onboarding.creationLink(teamId);
    return link ? QRCode.toString(link.url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }) : undefined;
  }

  /**
   * Sends the test message (step 6) once to each group the team accepts work in, as the team's own application, and records
   * each group's result. It is sent only when the owner confirmed it; a failed or unknown send is never repeated by itself.
   */
  async sendTestMessage(teamId: unknown, confirmed: unknown, actor: TeamActor): Promise<void> {
    const team = typeof teamId === "string" ? this.current().definitions.teams.find(({ id }) => id === teamId) : undefined;
    if (!team) throw new TeamInputError("团队不存在");
    if (confirmed !== true) throw new TeamInputError("发送测试消息前需要确认");
    const appId = team.leader.appId;
    const groups = team.bindings.filter(({ state }) => state === "accepting").map(({ chatId }) => chatId);
    if (!appId || !groups.length) throw new TeamInputError("机器人还没有加入所绑定的群");
    if (this.testing.has(team.id)) throw new TeamInputError("测试消息正在发送");
    this.testing.add(team.id);
    try {
      const operation = randomUUID();
      const results: Record<string, TestMessageOutcome["status"]> = {};
      for (const chatId of groups) {
        // Recorded as being sent first: a send cut off by a restart then reads as unknown, and is not repeated.
        this.options.registry.recordTestMessage(appId, chatId, { status: "sending", at: this.now() });
        let answer: Awaited<ReturnType<TestMessageSend>>;
        try { answer = this.sendTest ? await this.sendTest({ teamId: team.id, appId, chatId, text: testText(team), operationId: `team-test-message:${operation}` }) : "rejected"; }
        catch { answer = "unknown"; }
        results[chatId] = answer === "accepted" ? "accepted" : answer === "rejected" ? "failed" : "unknown";
        this.options.registry.recordTestMessage(appId, chatId, { status: results[chatId], at: this.now() });
      }
      this.audit(actor, { event: "team_test_message_sent", team: team.id, appId, groups: results });
    } finally { this.testing.delete(team.id); }
  }

  /** The console's view: no secret value ever appears in it (team-management::CON-001). */
  async view(): Promise<TeamsView> {
    const current = this.current(), { definitions } = current;
    const names = await this.groupNames.of(definitions.dispatchGroups);
    const scopes = this.options.moduleScopes();
    const active = this.options.activeAssignments();
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
        const creation = this.options.registry.creation(team.id);
        const link = this.onboarding.creationLink(team.id);
        return { id: team.id, teamName: team.teamName, responsibility: team.responsibility,
          leader: { name: team.leader.name, appId: team.leader.appId, instructions: team.leader.profile.instructions },
          secretStored: Boolean(team.leader.appId) && this.options.registry.hasSecret(team.leader.appId),
          method: team.leader.method ?? "existing",
          ...(creation ? { creation: { status: creation.status, ...(creation.status === "action" ? { reason: creation.reason } : {}),
            ...(creation.status === "done" ? { appId: creation.appId } : {}), ...(creation.status === "waiting" && link ? { codeExpiresAt: link.expiresAt } : {}) } } : {}),
          ...(record.configure ? { configure: record.configure } : {}), ...(record.publish ? { publish: record.publish } : {}),
          tests: team.leader.appId ? { ...this.options.registry.testMessages(team.leader.appId) } : {}, testMessage: testText(team),
          ...(record.credentials ? { credentials: record.credentials } : {}),
          bindings: team.bindings.filter(({ state }) => state !== "removed").map(({ chatId, state }) => ({ chatId, state, ...(record.joins[chatId] ? { join: record.joins[chatId] } : {}) })),
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

  /** Asks for a team's QR code on behalf of `actor`; the audit names who asked, and later what the scan led to. */
  private async requestCreation(teamId: string, actor: TeamActor): Promise<void> {
    this.audit(actor, { event: "team_application_qr_requested", team: teamId });
    try { await this.onboarding.requestCreation(teamId); }
    catch (error) { this.options.report(`team_application_qr_failed: ${error instanceof Error ? error.message : "error"}`); }
  }

  /** A QR code of a team was settled: the created application now posts for the team, and its remaining steps run; or the team got none from it. */
  private creationEnded(end: CreationEnd): void {
    // An application a scan created but the team does not use is named, so that the owner can remove it in Feishu.
    if ("failed" in end) { this.audit({}, { event: "team_application_qr_failed", team: end.teamId, reason: end.failed, ...(end.unused ? { appId: end.unused } : {}) }); return; }
    this.audit({}, { event: "team_application_created", team: end.teamId, appId: end.created, ...(end.replaced ? { replaced: end.replaced } : {}), version: this.current().version });
    this.refreshRoster();
    void this.runOnboarding(end.teamId, {}, false);
  }

  private async runOnboarding(teamId: string, actor: TeamActor, requested: boolean): Promise<void> {
    try {
      const started = await this.onboarding.run(teamId);
      const team = this.current().definitions.teams.find(({ id }) => id === teamId);
      if (requested || team?.leader.appId) {
        const record = team?.leader.appId ? this.options.registry.onboarding(team.leader.appId) : { joins: {} };
        this.audit(actor, { event: "team_onboarding_checked", team: teamId, ...(team?.leader.appId ? { appId: team.leader.appId } : {}),
          ...(record.configure ? { configure: outcome(record.configure) } : {}), ...(record.publish ? { publish: outcome(record.publish) } : {}),
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
  private auditTeamSave(before: TeamDefinition | undefined, after: TeamDefinition, secretWritten: boolean, version: number, actor: TeamActor, method?: OnboardingMethod): void {
    const changed = before === undefined ? ["created"] : [
      ...(before.teamName !== after.teamName ? ["teamName"] : []), ...(before.responsibility !== after.responsibility ? ["responsibility"] : []),
      ...(before.leader.name !== after.leader.name ? ["leader.name"] : []), ...(before.leader.appId !== after.leader.appId ? ["leader.appId"] : []),
      ...(before.leader.profile.instructions !== after.leader.profile.instructions ? ["leader.instructions"] : []), ...(method ? ["method"] : [])];
    // `method` is given for a new team and whenever the save changed how the team gets its application.
    if (changed.length) this.audit(actor, { event: "team_changed", team: after.id, version, changed, ...(before === undefined ? { teamName: after.teamName } : {}), ...(method ? { method } : {}) });
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
    /** How the team gets its application, as saved. */
    method: OnboardingMethod;
    /** QR creation (step 1): its state, why it needs action, the created application, and until when the code that waits for its scan is valid. */
    creation?: { status: "waiting" | "action" | "done"; reason?: string; appId?: string; codeExpiresAt?: number };
    /** Steps 2 and 3 of the application the team uses, when QR creation made it. */
    configure?: OnboardingOutcome; publish?: OnboardingOutcome;
    /** Step 6: the latest test message of the team's application in each group it sent one to, and the text a new one would carry. */
    tests: Record<string, TestMessageOutcome>; testMessage: string;
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
  if (value.method !== undefined && value.method !== "qr" && value.method !== "existing") throw new TeamInputError("接入方式无效");
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
    executorProfiles, groups: value.groups as string[], ...(value.method === undefined ? {} : { method: value.method }) };
  return { edit, ...(secret === undefined ? {} : { secret }) };
}

export { TeamDefinitionError };
