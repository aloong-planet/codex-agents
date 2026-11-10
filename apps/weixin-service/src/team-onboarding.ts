import * as lark from "@larksuiteoapi/node-sdk";
import type { OnboardingOutcome, TeamRegistry } from "./team-registry.js";

/** An application's credentials, used only for the service's own platform calls. */
export type ApplicationCredentials = Readonly<{ appId: string; appSecret: string }>;
/** What the scan page first shows for the new application; the owner can change both there. */
export type ApplicationPreset = Readonly<{ name: string; description: string }>;
/**
 * Why a QR creation produced no application: the code ran out (`expired`), the owner declined on the phone (`denied`), the
 * wait was cancelled, the platform could not be reached, or it answered another refusal (`failed`).
 */
export type CreationFailure = "expired" | "denied" | "cancelled" | "unreachable" | "failed";
/** One QR creation (step 1): the link its QR code carries, valid for `expiresInSeconds` and for one scan, and how it ends. */
export type ApplicationCreation = Readonly<{
  url: string; expiresInSeconds: number;
  /** Settles once: with the new application's credentials after the owner confirmed in Feishu, or with why none was created. */
  result: Promise<ApplicationCredentials | CreationFailure>;
}>;
/**
 * What the platform says to the automatic configuration (step 2): accepted; the application is under review, so a release
 * carrying its configuration has already been submitted (210020, 210040); refused for another reason; or no answer.
 */
export type ConfigureAnswer = "done" | "under_review" | "refused" | "unreachable";
/** What the platform says to the automatic release (step 3): submitted, also when one is already under review (210302); refused; or no answer. */
export type PublishAnswer = "submitted" | "refused" | "unreachable";
/**
 * The permissions a Team Leader application needs: posting as the bot, uploading images and files, reading the groups it is in
 * (the membership check), changing its own configuration (steps 2 and 3) and reading its bot information (step 4). QR creation
 * asks for them on the minimal template, which has the bot capability and no other permission, and step 2 adds them again,
 * because the scan page may ignore what creation asked for (team-management Implementation Decisions: Onboarding).
 */
export const TEAM_LEADER_SCOPES: readonly string[] = ["im:message:send_as_bot", "im:resource", "im:chat:readonly", "application:application:patch", "application:bot.basic_info:read"];
/** The reason and the description of the release step 3 submits, as the tenant's admin reads them when reviewing it. */
const RELEASE_REMARK = "团队负责人机器人：在派单群里以自己的身份发言。";
const RELEASE_CHANGELOG = "开启机器人能力，申请发送消息、上传文件和读取群信息的权限。";
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
  /**
   * Starts the creation of a new agent application by QR code, in create-only mode: the scan page never offers an existing
   * application. Resolves with the creation once its link is known, or with `unreachable` when the platform gave none.
   * Aborting `signal` ends the wait as `cancelled`.
   */
  createApplication(preset: ApplicationPreset, signal: AbortSignal): Promise<ApplicationCreation | "unreachable" | "cancelled">;
  /** Enables the bot capability of a created application and adds the permissions it needs (step 2), as the application itself. */
  configureApplication(application: ApplicationCredentials): Promise<ConfigureAnswer>;
  /** Submits a release of a created application (step 3), as the application itself. */
  publishApplication(application: ApplicationCredentials): Promise<PublishAnswer>;
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
type FixtureSettings = Readonly<{
  applications?: Record<string, ApplicationCheck>; chats?: Record<string, FixtureChat>;
  /** Whether a QR creation gets its link. */
  link?: "ready" | "unreachable";
  /** Ends the oldest QR creation that waits for its scan: the owner confirmed, or one of the failures. */
  scan?: "confirmed" | CreationFailure;
  configure?: Record<string, ConfigureAnswer>; publish?: Record<string, PublishAnswer>;
}>;
/**
 * The fake of the platform for tests and fixture mode. By default a QR creation gets a link and waits for `scan`, every
 * application is enabled, its configuration and release are accepted, every add succeeds and the bot is then in the group;
 * `configure` changes the answers per application and per group. Every call is recorded, without any secret.
 * The nth application it creates is `cli_c0de` followed by n as 12 digits, with the secret `fixture-created-secret-<n>`.
 */
export class FixtureOnboardingPlatform implements OnboardingPlatform {
  readonly calls: Array<Record<string, string>> = [];
  private applications: Record<string, ApplicationCheck> = {};
  private chats: Record<string, FixtureChat> = {};
  private link: "ready" | "unreachable" = "ready";
  private configured: Record<string, ConfigureAnswer> = {};
  private published: Record<string, PublishAnswer> = {};
  private readonly waiting: Array<(result: ApplicationCredentials | CreationFailure) => void> = [];
  private created = 0;

  configure(settings: FixtureSettings): void {
    if (settings.applications) this.applications = { ...this.applications, ...settings.applications };
    if (settings.chats) this.chats = { ...this.chats, ...settings.chats };
    if (settings.link) this.link = settings.link;
    if (settings.configure) this.configured = { ...this.configured, ...settings.configure };
    if (settings.publish) this.published = { ...this.published, ...settings.publish };
    if (settings.scan) {
      const finish = this.waiting.shift();
      if (!finish) throw new Error("fixture_onboarding_no_creation_waiting");
      if (settings.scan !== "confirmed") finish(settings.scan);
      else { this.created++; finish({ appId: `cli_c0de${String(this.created).padStart(12, "0")}`, appSecret: `fixture-created-secret-${this.created}` }); }
    }
  }
  async createApplication(preset: ApplicationPreset, signal: AbortSignal): Promise<ApplicationCreation | "unreachable" | "cancelled"> {
    this.calls.push({ call: "create", name: preset.name, description: preset.description });
    if (signal.aborted) return "cancelled";
    if (this.link === "unreachable") return "unreachable";
    const result = new Promise<ApplicationCredentials | CreationFailure>((settle) => {
      const finish = (value: ApplicationCredentials | CreationFailure) => {
        const index = this.waiting.indexOf(finish);
        if (index >= 0) this.waiting.splice(index, 1);
        settle(value);
      };
      this.waiting.push(finish);
      signal.addEventListener("abort", () => finish("cancelled"), { once: true });
    });
    return { url: `https://accounts.feishu.cn/fixture/registration?create=${this.calls.filter(({ call }) => call === "create").length}`, expiresInSeconds: 600, result };
  }
  async configureApplication({ appId }: ApplicationCredentials): Promise<ConfigureAnswer> {
    this.calls.push({ call: "configure", appId });
    return this.configured[appId] ?? "done";
  }
  async publishApplication({ appId }: ApplicationCredentials): Promise<PublishAnswer> {
    this.calls.push({ call: "publish", appId });
    return this.published[appId] ?? "submitted";
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
export type PlatformRequest = (request: Readonly<{ method: "GET" | "POST" | "PATCH"; url: string; token?: string; body?: unknown }>) => Promise<Readonly<{ status: number; body: unknown }>>;
const OPEN_API = "https://open.feishu.cn/open-apis";
const NO_ANSWER = -1;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** The application-management APIs an application calls on itself with its own tenant token. */
const applicationApi = (appId: string) => `${OPEN_API}/application/v7/applications/${encodeURIComponent(appId)}`;
/** The SDK ends a registration with `{ code, description }`; anything else it throws is a request that got no answer. */
function creationFailure(error: unknown): CreationFailure {
  const code = error instanceof Error ? undefined : record(error).code;
  if (typeof code !== "string") return "unreachable";
  return code === "expired_token" ? "expired" : code === "access_denied" ? "denied" : code === "abort" ? "cancelled" : "failed";
}

/**
 * The platform over the Feishu open APIs, as the official documentation describes them (team-management Further Notes). Tokens
 * come from the same tenant-token endpoint the pinned SDK uses. Response bodies are read whatever the HTTP status, because the
 * platform reports refusals as JSON with a `code`. Nothing here logs a request, a token or a secret.
 */
export class FeishuHttpOnboardingPlatform implements OnboardingPlatform {
  private readonly linkTimeoutMs: number;

  /** `linkTimeoutMs` bounds the wait for a QR creation's link, which the SDK requests without a limit of its own. */
  constructor(private readonly request: PlatformRequest = fetchRequest, options: Readonly<{ linkTimeoutMs?: number }> = {}) {
    this.linkTimeoutMs = options.linkTimeoutMs ?? 15_000;
  }

  /**
   * QR creation through the pinned SDK's application registration (a device-authorization flow): the SDK asks for a link,
   * then polls until the owner has confirmed on the scan page, declined, or the link has run out. `createOnly` makes that
   * page create a new application only.
   */
  createApplication(preset: ApplicationPreset, signal: AbortSignal): Promise<ApplicationCreation | "unreachable" | "cancelled"> {
    return new Promise((resolve) => {
      // The SDK watches its signal only while it polls; this one also ends a request for a link that gets no answer.
      const waiting = new AbortController();
      const cancel = () => waiting.abort();
      let linked = false;
      const noLink = setTimeout(() => { waiting.abort(); unlinked(); }, this.linkTimeoutMs);
      const settled = () => { clearTimeout(noLink); signal.removeEventListener("abort", cancel); };
      const unlinked = () => { settled(); resolve(signal.aborted ? "cancelled" : "unreachable"); };
      let finish!: (result: ApplicationCredentials | CreationFailure) => void;
      const result = new Promise<ApplicationCredentials | CreationFailure>((settle) => { finish = settle; });
      if (signal.aborted) { unlinked(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      lark.registerApp({ createOnly: true, signal: waiting.signal, appPreset: { name: preset.name, desc: preset.description },
        addons: { preset: false, scopes: { tenant: [...TEAM_LEADER_SCOPES] } },
        onQRCodeReady: ({ url, expireIn }) => {
          // A link that arrives after the wait for it ended is not shown: its creation was already reported as not started.
          if (waiting.signal.aborted) return;
          linked = true;
          clearTimeout(noLink);
          resolve({ url, expiresInSeconds: expireIn, result });
        },
      }).then(({ client_id, client_secret }) => { settled(); finish({ appId: client_id, appSecret: client_secret }); },
        (error: unknown) => { if (linked) { settled(); finish(creationFailure(error)); } else unlinked(); });
    });
  }

  async configureApplication(application: ApplicationCredentials): Promise<ConfigureAnswer> {
    try {
      const token = await this.token(application);
      if (typeof token === "number") return token === NO_ANSWER ? "unreachable" : "refused";
      const calls = [
        ["ability", { bot: { enable: true, allow_invited_to_group_by_other_app_switch_open: true } }],
        ["config", { scope: { add_scopes: TEAM_LEADER_SCOPES.map((scope) => ({ scope_name: scope, token_type: "tenant" })) } }],
      ] as const;
      for (const [part, body] of calls) {
        const answer = record((await this.request({ method: "PATCH", url: `${applicationApi(application.appId)}/${part}`, token, body })).body);
        if (typeof answer.code !== "number") return "unreachable";
        // 210020 and 210040: the application is under review, which only a submitted release makes it.
        if (answer.code === 210020 || answer.code === 210040) return "under_review";
        if (answer.code !== 0) return "refused";
      }
      return "done";
    } catch { return "unreachable"; }
  }

  async publishApplication(application: ApplicationCredentials): Promise<PublishAnswer> {
    try {
      const token = await this.token(application);
      if (typeof token === "number") return token === NO_ANSWER ? "unreachable" : "refused";
      const answer = record((await this.request({ method: "POST", url: `${applicationApi(application.appId)}/publish`, token,
        body: { mobile_default_ability: "bot", pc_default_ability: "bot", remark: RELEASE_REMARK, changelog: RELEASE_CHANGELOG } })).body);
      if (typeof answer.code !== "number") return "unreachable";
      // 210302: a release is already under review, so the one this step asks for has been submitted.
      return answer.code === 0 || answer.code === 210302 ? "submitted" : "refused";
    } catch { return "unreachable"; }
  }

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

/** The platform's HTTP transport: a bearer token when given, a JSON body, and the reply parsed as JSON or left undefined. */
export const fetchRequest: PlatformRequest = async ({ method, url, token, body }) => {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(15_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: response.status, body: parsed };
};
