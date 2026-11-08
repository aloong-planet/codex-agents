import type { OnboardingOutcome, TeamRegistry } from "./team-registry.js";

/** An application's credentials, used only for the service's own platform calls. */
export type ApplicationCredentials = Readonly<{ appId: string; appSecret: string }>;
/**
 * What the platform says about an application's credentials and bot (step 4): enabled; not yet published or enabled
 * (`not_enabled`, error 20069); installed but not enabled (`inactive`, bot activate_status other than 2); a secret that does
 * not match (`bad_credentials`); or no answer (`unreachable`).
 */
export type ApplicationCheck = "enabled" | "not_enabled" | "inactive" | "bad_credentials" | "unreachable";
/**
 * What the platform says when the Coordinator adds a bot to a group (step 5): added; refused because only the group's owner
 * and admins add members (232017); waiting for their approval; refused for another reason; or no answer.
 */
export type JoinAnswer = "added" | "owner_only" | "pending_approval" | "refused" | "unreachable";
/**
 * The Feishu platform APIs onboarding uses (team-management Implementation Decisions: Onboarding). The Coordinator adds a bot
 * by its App ID; a bot's membership is checked with its own application, because member lists do not return bots.
 */
export interface OnboardingPlatform {
  checkApplication(application: ApplicationCredentials): Promise<ApplicationCheck>;
  addBot(chatId: string, appId: string, coordinator: ApplicationCredentials): Promise<JoinAnswer>;
  isInChat(chatId: string, application: ApplicationCredentials): Promise<boolean | "unreachable">;
  chatName(chatId: string, coordinator: ApplicationCredentials): Promise<string | undefined>;
}
type Started = ReadonlyArray<Readonly<{ teamId: string; chatId: string }>>;

/**
 * Runs the onboarding steps of an existing application: the credential and bot check, then joining the bot to each group the
 * team is onboarding in. A step whose recorded outcome is done never runs again, so a restart resumes where onboarding stopped;
 * every other step runs again on each run. Each run ends by turning finished bindings accepting (team-management::REQ-003).
 */
export class TeamOnboarding {
  /** Runs one at a time, so that a save's run and a 重新检查 never add a bot twice or overwrite each other's outcome. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly registry: Pick<TeamRegistry, "current" | "onboarding" | "recordOnboarding" | "settleOnboarding" | "secret">,
    private readonly platform: OnboardingPlatform, private readonly coordinator: ApplicationCredentials, private readonly now: () => number = Date.now) {}

  /** Runs the team's pending steps after any run in progress, and returns the bindings that started accepting. */
  run(teamId: string): Promise<Started> {
    const run = this.queue.then(() => this.runNow(teamId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runNow(teamId: string): Promise<Started> {
    const team = this.registry.current()?.definitions.teams.find(({ id }) => id === teamId);
    const appId = team?.leader.appId;
    if (!team || !appId) return this.registry.settleOnboarding();
    const secret = this.registry.secret(appId);
    if (this.registry.onboarding(appId).credentials?.status !== "done") {
      const outcome = secret === undefined ? this.outcome("action", "secret_missing") : CHECK_OUTCOME[await this.platform.checkApplication({ appId, appSecret: secret })];
      this.registry.recordOnboarding(appId, { step: "credentials" }, { ...outcome, at: this.now() });
      if (outcome.status !== "done") return this.registry.settleOnboarding();
    }
    const application = { appId, appSecret: secret! };
    for (const { chatId, state } of team.bindings) {
      if (state !== "onboarding" || this.registry.onboarding(appId).joins[chatId]?.status === "done") continue;
      const answer = await this.platform.addBot(chatId, appId, this.coordinator);
      let outcome: Omit<OnboardingOutcome, "at">;
      if (answer !== "added") outcome = this.outcome("action", answer);
      else {
        const member = await this.platform.isInChat(chatId, application);
        outcome = member === true ? { status: "done" } : this.outcome("action", member === false ? "not_joined" : "unreachable");
      }
      this.registry.recordOnboarding(appId, { step: "join", chatId }, { ...outcome, at: this.now() });
    }
    return this.registry.settleOnboarding();
  }

  /** Runs every team that is still onboarding in some group, as at startup. */
  async resume(): Promise<Started> {
    const teams = this.registry.current()?.definitions.teams.filter(({ bindings }) => bindings.some(({ state }) => state === "onboarding")) ?? [];
    const started: Array<{ teamId: string; chatId: string }> = [];
    for (const { id } of teams) started.push(...await this.run(id));
    return started;
  }

  private outcome(status: OnboardingOutcome["status"], reason: string): Omit<OnboardingOutcome, "at"> { return { status, reason }; }
}

const CHECK_OUTCOME: Record<ApplicationCheck, Omit<OnboardingOutcome, "at">> = {
  enabled: { status: "done" },
  not_enabled: { status: "review", reason: "not_enabled" },
  inactive: { status: "review", reason: "not_enabled" },
  bad_credentials: { status: "action", reason: "bad_credentials" },
  unreachable: { status: "action", reason: "unreachable" },
};

type FixtureChat = Readonly<{ add?: JoinAnswer; inChat?: boolean; name?: string }>;
/**
 * The fake of the platform for tests and fixture mode. By default every application is enabled, every add succeeds and the
 * bot is then in the group; `configure` changes the answers per application and per group. Every call is recorded.
 */
export class FixtureOnboardingPlatform implements OnboardingPlatform {
  readonly calls: Array<Record<string, string>> = [];
  private applications: Record<string, ApplicationCheck> = {};
  private chats: Record<string, FixtureChat> = {};

  configure(settings: Readonly<{ applications?: Record<string, ApplicationCheck>; chats?: Record<string, FixtureChat> }>): void {
    if (settings.applications) this.applications = { ...this.applications, ...settings.applications };
    if (settings.chats) this.chats = { ...this.chats, ...settings.chats };
  }
  async checkApplication({ appId }: ApplicationCredentials): Promise<ApplicationCheck> {
    this.calls.push({ call: "check", appId });
    return this.applications[appId] ?? "enabled";
  }
  async addBot(chatId: string, appId: string, coordinator: ApplicationCredentials): Promise<JoinAnswer> {
    this.calls.push({ call: "add", chatId, appId, as: coordinator.appId });
    return this.chats[chatId]?.add ?? "added";
  }
  async isInChat(chatId: string, application: ApplicationCredentials): Promise<boolean> {
    this.calls.push({ call: "in_chat", chatId, as: application.appId });
    return this.chats[chatId]?.inChat ?? true;
  }
  async chatName(chatId: string): Promise<string | undefined> {
    this.calls.push({ call: "chat_name", chatId });
    return this.chats[chatId]?.name;
  }
}

/** One HTTP call to the platform; `token` is a tenant access token sent as a bearer token. Throws when there is no answer. */
export type PlatformRequest = (request: Readonly<{ method: "GET" | "POST"; url: string; token?: string; body?: unknown }>) => Promise<Readonly<{ status: number; body: unknown }>>;
const OPEN_API = "https://open.feishu.cn/open-apis";
const NO_ANSWER = -1;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * The platform over the Feishu open APIs, as the official documentation describes them (team-management Further Notes). Tokens
 * come from the same tenant-token endpoint the pinned SDK uses. Response bodies are read whatever the HTTP status, because the
 * platform reports refusals as JSON with a `code`. Nothing here logs a request, a token or a secret.
 */
export class FeishuHttpOnboardingPlatform implements OnboardingPlatform {
  constructor(private readonly request: PlatformRequest = fetchRequest) {}

  async checkApplication(application: ApplicationCredentials): Promise<ApplicationCheck> {
    try {
      const token = await this.token(application);
      if (typeof token === "number") return token === NO_ANSWER ? "unreachable" : token === 20069 ? "not_enabled" : "bad_credentials";
      const info = record((await this.request({ method: "GET", url: `${OPEN_API}/bot/v3/info`, token })).body);
      // Bot information exists only for a published, enabled bot capability; 2 means enabled in the tenant.
      if (info.code !== 0) return "not_enabled";
      return record(info.bot).activate_status === 2 ? "enabled" : "inactive";
    } catch { return "unreachable"; }
  }

  async addBot(chatId: string, appId: string, coordinator: ApplicationCredentials): Promise<JoinAnswer> {
    try {
      const token = await this.token(coordinator);
      if (typeof token === "number") return token === NO_ANSWER ? "unreachable" : "refused";
      const answer = record((await this.request({ method: "POST", url: `${OPEN_API}/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=app_id`,
        token, body: { id_list: [appId] } })).body);
      if (answer.code === 232017) return "owner_only";
      if (answer.code !== 0) return "refused";
      const pending = record(answer.data).pending_approval_id_list;
      return Array.isArray(pending) && pending.includes(appId) ? "pending_approval" : "added";
    } catch { return "unreachable"; }
  }

  async isInChat(chatId: string, application: ApplicationCredentials): Promise<boolean | "unreachable"> {
    try {
      const token = await this.token(application);
      if (typeof token === "number") return "unreachable";
      const answer = record((await this.request({ method: "GET", url: `${OPEN_API}/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`, token })).body);
      return answer.code === 0 ? record(answer.data).is_in_chat === true : "unreachable";
    } catch { return "unreachable"; }
  }

  async chatName(chatId: string, coordinator: ApplicationCredentials): Promise<string | undefined> {
    try {
      const token = await this.token(coordinator);
      if (typeof token === "number") return undefined;
      const answer = record((await this.request({ method: "GET", url: `${OPEN_API}/im/v1/chats/${encodeURIComponent(chatId)}`, token })).body);
      const name = record(answer.data).name;
      return answer.code === 0 && typeof name === "string" && name.trim() ? name : undefined;
    } catch { return undefined; }
  }

  /** A tenant access token, the platform's refusal code, or NO_ANSWER when the reply carries no readable answer (such as a gateway's error page). */
  private async token({ appId, appSecret }: ApplicationCredentials): Promise<string | number> {
    const answer = record((await this.request({ method: "POST", url: `${OPEN_API}/auth/v3/tenant_access_token/internal`, body: { app_id: appId, app_secret: appSecret } })).body);
    const token = answer.tenant_access_token;
    if (answer.code === 0 && typeof token === "string" && token) return token;
    return typeof answer.code === "number" && answer.code !== 0 ? answer.code : NO_ANSWER;
  }
}

const fetchRequest: PlatformRequest = async ({ method, url, token, body }) => {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(15_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: response.status, body: parsed };
};
