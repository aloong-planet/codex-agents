import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as lark from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { fetchRequest, FeishuHttpOnboardingPlatform, FixtureOnboardingPlatform, TeamOnboarding, type PlatformRequest } from "../src/team-onboarding.js";
import { TeamRegistry, type TeamEdit } from "../src/team-registry.js";

// Onboarding of an existing application (team-management::US-002/AC-02, REQ-003) against the fixture platform, the fake of the
// Feishu platform APIs that fixture mode also uses. The answers it gives follow the official API documentation read on
// 2026-11-07 (~/research/codex-weixin-agent-team/feishu-onboarding.md): error 20069 for an application not yet published or
// enabled, bot activate_status 2 for an enabled bot, 232017 for a group where only owners and admins add members, and
// pending_approval_id_list for a join awaiting approval.
// Coverage gap: no real tenant is called, so whether these codes and permissions behave as documented is live acceptance
// (team-management spec, Pending). The HTTP client's mapping of the documented response bodies is covered below, and its transport
// (bearer token, JSON body, reply parsing) against a local HTTP server.
const SAM = { appId: "cli_0123456789abcdef", appSecret: "sam-secret" };
const DAISY_APP = "cli_5555555555555555";
const daisy: TeamEdit = { teamName: "设计团队", responsibility: "视觉方案", leader: { name: "Daisy", appId: DAISY_APP, instructions: "" },
  executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: [] }], groups: ["oc_alpha", "oc_beta"] };

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function registryWithDaisy(secret: string | null = "daisy-secret") {
  const directory = mkdtempSync(join(tmpdir(), "team-onboarding-"));
  directories.push(directory);
  const path = join(directory, "team-registry.sqlite");
  const registry = new TeamRegistry(path);
  const parsed = parseChannelStartupConfiguration({ channel: "feishu",
    owner: { memoryAccountId: "owner-memory", bindings: [{ channel: "feishu", accountId: SAM.appId, target: "oc_private", senderId: "ou_owner" }] },
    taskScope: { accountId: "owner-memory", target: "oc_private" },
    feishu: { ...SAM, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
      dispatch: { groupChatIds: ["oc_alpha", "oc_beta"], agents: [{ id: "sam" }, { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
        { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" }, { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }] } } });
  const feishu = parsed.entries.find((entry) => entry.channel === "feishu");
  if (!feishu?.dispatch) throw new Error("expected_dispatch_configuration");
  registry.importLocalConfiguration(feishu.dispatch, { executorHostTools: [] });
  const { teamId } = registry.saveTeam(daisy, { basedOn: 1, ...(secret === null ? {} : { secret }) });
  return { registry, teamId, path };
}
const statuses = (registry: TeamRegistry) => {
  const record = registry.onboarding(DAISY_APP);
  return { credentials: record.credentials && [record.credentials.status, record.credentials.reason],
    joins: Object.fromEntries(Object.entries(record.joins).map(([chatId, outcome]) => [chatId, [outcome.status, outcome.reason]])) };
};

describe("checking an existing application's credentials (step 4)", () => {
  it.each([
    ["an enabled bot", { application: "enabled" }, ["done", undefined]],
    ["an application not yet published or enabled (20069)", { application: "not_enabled" }, ["review", "not_enabled"]],
    ["a bot installed but not yet enabled (activate_status 3)", { application: "inactive" }, ["review", "not_enabled"]],
    ["a secret that does not match the App ID (20002)", { application: "bad_credentials" }, ["action", "bad_credentials"]],
    ["the platform unreachable", { application: "unreachable" }, ["action", "unreachable"]],
  ] as const)("records %s", async (_case, answer, expected) => {
    const { registry, teamId } = registryWithDaisy();
    try {
      const platform = new FixtureOnboardingPlatform();
      platform.configure({ applications: { [DAISY_APP]: answer.application } });
      await new TeamOnboarding(registry, platform, SAM).run(teamId);
      expect(statuses(registry).credentials).toEqual(expected);
      // Group joining waits for verified credentials (team-management::US-002/AC-03, step order).
      if (expected[0] !== "done") expect(statuses(registry).joins).toEqual({});
    } finally { registry.close(); }
  });

  it("asks for the secret before calling the platform when none is stored", async () => {
    const { registry, teamId } = registryWithDaisy(null);
    try {
      const platform = new FixtureOnboardingPlatform();
      await new TeamOnboarding(registry, platform, SAM).run(teamId);
      expect([statuses(registry).credentials, platform.calls]).toEqual([["action", "secret_missing"], []]);
    } finally { registry.close(); }
  });

  // Ticket 11, decision D7: the checks run again after a save that changes the credentials, a replaced secret included.
  it("checks the credentials again after the secret is replaced, keeping the groups already joined", async () => {
    const { registry, teamId } = registryWithDaisy();
    try {
      const platform = new FixtureOnboardingPlatform();
      await new TeamOnboarding(registry, platform, SAM).run(teamId);
      platform.configure({ applications: { [DAISY_APP]: "bad_credentials" } });
      registry.saveTeam({ ...daisy, id: teamId }, { basedOn: registry.current()!.version, secret: "daisy-wrong-secret" });
      await new TeamOnboarding(registry, platform, SAM).run(teamId);
      expect(statuses(registry)).toEqual({ credentials: ["action", "bad_credentials"], joins: { oc_alpha: ["done", undefined], oc_beta: ["done", undefined] } });
      // A secret-only change keeps the team accepting work where it did; only a replaced App ID starts onboarding again.
      expect(registry.current()!.definitions.teams.find(({ id }) => id === teamId)!.bindings).toEqual([{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }]);
    } finally { registry.close(); }
  });
});

describe("joining the bot to each bound group (step 5)", () => {
  it("joins each group on its own: an owner-only group needs action while the other group accepts the team", async () => {
    const { registry, teamId } = registryWithDaisy();
    try {
      const platform = new FixtureOnboardingPlatform();
      platform.configure({ chats: { oc_alpha: { add: "owner_only" } } });
      const started = await new TeamOnboarding(registry, platform, SAM).run(teamId);
      expect(statuses(registry)).toEqual({ credentials: ["done", undefined], joins: { oc_alpha: ["action", "owner_only"], oc_beta: ["done", undefined] } });
      expect(started).toEqual([{ teamId, chatId: "oc_beta" }]);
      // Sam adds the bot by its App ID; the membership check uses the team's own application (research notes, § 3–4).
      expect(platform.calls.filter(({ call }) => call !== "check")).toEqual([
        { call: "add", chatId: "oc_alpha", appId: DAISY_APP, as: SAM.appId },
        { call: "add", chatId: "oc_beta", appId: DAISY_APP, as: SAM.appId }, { call: "in_chat", chatId: "oc_beta", as: DAISY_APP }]);
    } finally { registry.close(); }
  });

  it.each([
    ["a join awaiting the group's approval", { add: "pending_approval" }, ["action", "pending_approval"]],
    ["an added bot that is not in the group", { add: "added", inChat: false }, ["action", "not_joined"]],
  ] as const)("records %s as needing action", async (_case, chat, expected) => {
    const { registry, teamId } = registryWithDaisy();
    try {
      const platform = new FixtureOnboardingPlatform();
      platform.configure({ chats: { oc_alpha: chat } });
      await new TeamOnboarding(registry, platform, SAM).run(teamId);
      expect(statuses(registry).joins.oc_alpha).toEqual(expected);
    } finally { registry.close(); }
  });

  // A save starts a run and 重新检查 starts another; they must not both add the bot and overwrite each other's outcome.
  it("runs one team's steps once when two runs overlap", async () => {
    const { registry, teamId } = registryWithDaisy();
    try {
      const platform = new FixtureOnboardingPlatform();
      const onboarding = new TeamOnboarding(registry, platform, SAM);
      await Promise.all([onboarding.run(teamId), onboarding.run(teamId)]);
      expect(platform.calls.map(({ call, chatId }) => chatId ? `${call} ${chatId}` : call))
        .toEqual(["check", "add oc_alpha", "in_chat oc_alpha", "add oc_beta", "in_chat oc_beta"]);
    } finally { registry.close(); }
  });

  // team-management failure modes: "Service restarts during … onboarding — no step reruns without its recorded outcome".
  it("resumes after a restart without repeating finished steps", async () => {
    const { registry, teamId, path } = registryWithDaisy();
    const first = new FixtureOnboardingPlatform();
    first.configure({ chats: { oc_alpha: { add: "owner_only" } } });
    await new TeamOnboarding(registry, first, SAM).run(teamId);
    registry.close();
    const reopened = new TeamRegistry(path);
    try {
      const platform = new FixtureOnboardingPlatform();
      const started = await new TeamOnboarding(reopened, platform, SAM).resume();
      expect(started).toEqual([{ teamId, chatId: "oc_alpha" }]);
      expect(platform.calls).toEqual([{ call: "add", chatId: "oc_alpha", appId: DAISY_APP, as: SAM.appId }, { call: "in_chat", chatId: "oc_alpha", as: DAISY_APP }]);
    } finally { reopened.close(); }
  });
});

// The HTTP client's reading of the documented response bodies. Bodies follow the response examples of the official pages listed
// in the research notes (token: the endpoint the pinned SDK itself uses; bot info; chat members create; is_in_chat; chat get).
describe("the Feishu HTTP platform", () => {
  type Answer = { status?: number; body?: unknown; fail?: true };
  function platform(answers: Record<string, Answer>) {
    const requests: Array<{ method: string; url: string; authorization?: string; body?: unknown }> = [];
    const request: PlatformRequest = async ({ method, url, token, body }) => {
      requests.push({ method, url, ...(token ? { authorization: token } : {}), ...(body === undefined ? {} : { body }) });
      const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
      const answer = key ? answers[key]! : { status: 404, body: { code: 404 } };
      if (answer.fail) throw new Error("network down");
      return { status: answer.status ?? 200, body: answer.body };
    };
    return { requests, platform: new FeishuHttpOnboardingPlatform(request) };
  }
  const TOKEN = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
  const BOT = "https://open.feishu.cn/open-apis/bot/v3/info";
  const token = (value: string) => ({ body: { code: 0, msg: "ok", tenant_access_token: value, expire: 7200 } });
  const bot = (activateStatus: number) => ({ body: { code: 0, msg: "ok", bot: { activate_status: activateStatus, app_name: "设计助手", avatar_url: "https://example.invalid/a.png", ip_white_list: [], open_id: "ou_daisy" } } });

  it.each([
    ["an enabled bot", { [TOKEN]: token("t-daisy"), [BOT]: bot(2) }, "enabled"],
    ["a bot awaiting enabling", { [TOKEN]: token("t-daisy"), [BOT]: bot(3) }, "inactive"],
    ["a token refused for an application not enabled", { [TOKEN]: { status: 400, body: { code: 20069, msg: "The specified app is not enabled" } } }, "not_enabled"],
    ["a token refused for a wrong secret", { [TOKEN]: { status: 400, body: { code: 10014, msg: "app secret invalid" } } }, "bad_credentials"],
    ["bot information refused", { [TOKEN]: token("t-daisy"), [BOT]: { status: 400, body: { code: 99991672, msg: "Access denied" } } }, "not_enabled"],
    ["no connection", { [TOKEN]: { fail: true } }, "unreachable"],
    // A gateway's HTML error page is no answer from the platform, not a refusal of the secret (review item R1).
    ["a token answer that is not JSON", { [TOKEN]: { status: 502 } }, "unreachable"],
  ] as const)("reads %s", async (_case, answers, expected) => {
    const { platform: http, requests } = platform(answers as Record<string, Answer>);
    expect(await http.checkApplication({ appId: DAISY_APP, appSecret: "daisy-secret" })).toBe(expected);
    expect(requests[0]).toEqual({ method: "POST", url: TOKEN, body: { app_id: DAISY_APP, app_secret: "daisy-secret" } });
  });

  it("adds a bot as the Coordinator and checks membership and names with the right application", async () => {
    const members = "https://open.feishu.cn/open-apis/im/v1/chats/oc_alpha/members";
    const { platform: http, requests } = platform({
      [TOKEN]: token("t-any"),
      [`${members}?member_id_type=app_id`]: { body: { code: 0, msg: "success", data: { invalid_id_list: [], not_existed_id_list: [], pending_approval_id_list: [] } } },
      [`${members}/is_in_chat`]: { body: { code: 0, msg: "success", data: { is_in_chat: true } } },
      ["https://open.feishu.cn/open-apis/im/v1/chats/oc_alpha"]: { body: { code: 0, msg: "success", data: { name: "银河护卫队", chat_mode: "group" } } },
    });
    expect(await http.addBot("oc_alpha", DAISY_APP, SAM)).toBe("added");
    expect(await http.isInChat("oc_alpha", { appId: DAISY_APP, appSecret: "daisy-secret" })).toBe(true);
    expect(await http.chatName("oc_alpha", SAM)).toBe("银河护卫队");
    expect(requests.filter(({ url }) => url !== TOKEN)).toEqual([
      { method: "POST", url: `${members}?member_id_type=app_id`, authorization: "t-any", body: { id_list: [DAISY_APP] } },
      { method: "GET", url: `${members}/is_in_chat`, authorization: "t-any" },
      { method: "GET", url: "https://open.feishu.cn/open-apis/im/v1/chats/oc_alpha", authorization: "t-any" }]);
    expect(requests.filter(({ url }) => url === TOKEN).map(({ body }) => (body as { app_id: string }).app_id)).toEqual([SAM.appId, DAISY_APP, SAM.appId]);
  });

  const CHATS = "https://open.feishu.cn/open-apis/im/v1/chats/";
  it.each([
    ["a group where only owners and admins add members (232017)", { [TOKEN]: token("t-sam"), [CHATS]: { status: 400, body: { code: 232017, msg: "No permission" } } }, "owner_only"],
    ["a join awaiting approval", { [TOKEN]: token("t-sam"), [CHATS]: { body: { code: 0, msg: "success", data: { invalid_id_list: [], not_existed_id_list: [], pending_approval_id_list: [DAISY_APP] } } } }, "pending_approval"],
    ["another refusal (232025, bot not activated)", { [TOKEN]: token("t-sam"), [CHATS]: { status: 400, body: { code: 232025, msg: "Bot ability is not activated" } } }, "refused"],
    ["no connection", { [TOKEN]: token("t-sam"), [CHATS]: { fail: true } }, "unreachable"],
    // A gateway's HTML error page for the Coordinator's token is no answer from the platform, not a refusal (review item R1).
    ["a Coordinator token answer that is not JSON", { [TOKEN]: { status: 502 } }, "unreachable"],
  ] as const)("reads %s when adding a bot", async (_case, answers, expected) => {
    const { platform: http } = platform(answers as Record<string, Answer>);
    expect(await http.addBot("oc_alpha", DAISY_APP, SAM)).toBe(expected);
  });

  // Steps 2 and 3 of QR creation. Request and response bodies follow the official pages read on 2026-11-11
  // (~/research/codex-weixin-agent-team/feishu-onboarding-api-shapes.md): application-v7 ability, config and publish.
  const APP = `https://open.feishu.cn/open-apis/application/v7/applications/${DAISY_APP}`;
  const accepted = { body: { code: 0, msg: "success", data: {} } };
  const daisyApplication = { appId: DAISY_APP, appSecret: "daisy-secret" };

  it("enables the bot capability and adds the permissions, as the application itself", async () => {
    const { platform: http, requests } = platform({ [TOKEN]: token("t-daisy"), [`${APP}/ability`]: accepted, [`${APP}/config`]: accepted });
    expect(await http.configureApplication(daisyApplication)).toBe("done");
    expect(requests).toEqual([
      { method: "POST", url: TOKEN, body: { app_id: DAISY_APP, app_secret: "daisy-secret" } },
      { method: "PATCH", url: `${APP}/ability`, authorization: "t-daisy", body: { bot: { enable: true, allow_invited_to_group_by_other_app_switch_open: true } } },
      { method: "PATCH", url: `${APP}/config`, authorization: "t-daisy", body: { scope: { add_scopes: [
        { scope_name: "im:message:send_as_bot", token_type: "tenant" }, { scope_name: "im:resource", token_type: "tenant" },
        { scope_name: "im:chat:readonly", token_type: "tenant" }, { scope_name: "application:application:patch", token_type: "tenant" },
        { scope_name: "application:bot.basic_info:read", token_type: "tenant" }] } } }]);
  });

  it.each([
    ["the capability change refused during a review (210020)", { [TOKEN]: token("t-daisy"), [`${APP}/ability`]: { status: 400, body: { code: 210020, msg: "Unable to update configurations, as the app is currently under review." } } }, "under_review"],
    ["the permissions refused during a review (210040)", { [TOKEN]: token("t-daisy"), [`${APP}/ability`]: accepted, [`${APP}/config`]: { status: 403, body: { code: 210040, msg: "Unable to update configurations, as the app is currently under review." } } }, "under_review"],
    ["no permission to change the configuration (210017)", { [TOKEN]: token("t-daisy"), [`${APP}/ability`]: { status: 403, body: { code: 210017, msg: "The current user has no permission to modify the app configurations" } } }, "refused"],
    ["a permission refused after the capability was accepted (210041)", { [TOKEN]: token("t-daisy"), [`${APP}/ability`]: accepted, [`${APP}/config`]: { status: 400, body: { code: 210041, msg: "The scope that parameter indicated needs robot ability to be enable first." } } }, "refused"],
    ["a token refused for an application not enabled", { [TOKEN]: { status: 400, body: { code: 20069, msg: "The specified app is not enabled" } } }, "refused"],
    ["no connection", { [TOKEN]: token("t-daisy"), [`${APP}/ability`]: { fail: true } }, "unreachable"],
    ["a reply that is not JSON", { [TOKEN]: token("t-daisy"), [`${APP}/ability`]: accepted, [`${APP}/config`]: { status: 502 } }, "unreachable"],
  ] as const)("reads %s when configuring a created application", async (_case, answers, expected) => {
    const { platform: http } = platform(answers as Record<string, Answer>);
    expect(await http.configureApplication(daisyApplication)).toBe(expected);
  });

  it("submits a release with the bot as the default capability, as the application itself", async () => {
    const { platform: http, requests } = platform({ [TOKEN]: token("t-daisy"),
      [`${APP}/publish`]: { body: { code: 0, msg: "success", data: { version_id: "oav_d317f090b7258ad0372aa53963cda70d", version: "1.0.0" } } } });
    expect(await http.publishApplication(daisyApplication)).toBe("submitted");
    expect(requests[1]).toEqual({ method: "POST", url: `${APP}/publish`, authorization: "t-daisy", body: { mobile_default_ability: "bot", pc_default_ability: "bot",
      remark: "团队负责人机器人：在派单群里以自己的身份发言。", changelog: "开启机器人能力，申请发送消息、上传文件和读取群信息的权限。" } });
  });

  it.each([
    ["a release already under review (210302)", { [TOKEN]: token("t-daisy"), [`${APP}/publish`]: { status: 400, body: { code: 210302, msg: "Unable to submit the release request, as the app is currently under review." } } }, "submitted"],
    ["an application the release API does not support (210001)", { [TOKEN]: token("t-daisy"), [`${APP}/publish`]: { status: 400, body: { code: 210001, msg: "As the app was not created in our developer console, it cannot be released using this API." } } }, "refused"],
    ["a token refused for an application not enabled", { [TOKEN]: { status: 400, body: { code: 20069, msg: "The specified app is not enabled" } } }, "refused"],
    ["no connection", { [TOKEN]: token("t-daisy"), [`${APP}/publish`]: { fail: true } }, "unreachable"],
    ["a reply that is not JSON", { [TOKEN]: token("t-daisy"), [`${APP}/publish`]: { status: 502 } }, "unreachable"],
  ] as const)("reads %s when releasing a created application", async (_case, answers, expected) => {
    const { platform: http } = platform(answers as Record<string, Answer>);
    expect(await http.publishApplication(daisyApplication)).toBe(expected);
  });
});

// The transport every real platform call goes through: what it sends, and how it reads a reply that is or is not JSON.
describe("the platform's HTTP transport", () => {
  it("sends a bearer token and a JSON body, and reads a JSON reply or none", async () => {
    const received: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined; type: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, type: req.headers["content-type"], body });
        if (req.url === "/gateway") { res.writeHead(502, { "content-type": "text/html" }); res.end("<html>Bad Gateway</html>"); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ code: 0, data: { name: "银河护卫队" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await fetchRequest({ method: "POST", url: `${origin}/members`, token: "t-sam", body: { id_list: [DAISY_APP] } }))
        .toEqual({ status: 200, body: { code: 0, data: { name: "银河护卫队" } } });
      expect(await fetchRequest({ method: "GET", url: `${origin}/gateway` })).toEqual({ status: 502, body: undefined });
      expect(received).toEqual([
        { method: "POST", url: "/members", authorization: "Bearer t-sam", type: "application/json; charset=utf-8", body: JSON.stringify({ id_list: [DAISY_APP] }) },
        { method: "GET", url: "/gateway", authorization: undefined, type: undefined, body: "" }]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

// QR creation (team-management::US-002/AC-01, AC-04) through the pinned SDK's own registration flow; only the SDK's HTTP instance
// is replaced, so the link the QR code carries and the polling are the SDK's. The answers carry the fields the pinned SDK reads
// (the RFC 8628 device-flow names in its registration source), not a captured reply: no registration is started against Feishu.
describe("creating an application by QR code (step 1)", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const REGISTRATION = "https://accounts.feishu.cn/oauth/v1/app/registration";
  const CREATED = { client_id: "cli_9f8e7d6c5b4a3210", client_secret: "created-secret", user_info: { open_id: "ou_owner", tenant_brand: "feishu" } };
  type Poll = Record<string, unknown> | Error | "never";
  /** The registration endpoint: `begin` answers with a link (or fails), then each poll takes the next answer; the last one repeats. */
  function registration(polls: Poll[], begin: Record<string, unknown> | Error | "never" = { verification_uri_complete: "https://accounts.feishu.cn/oauth/v1/app/confirm?user_code=WXYZ-1234",
    device_code: "device-code-1", interval: 0, expires_in: 600 }) {
    const requests: Array<Record<string, string>> = [];
    vi.spyOn(lark.defaultHttpInstance, "post").mockImplementation(async (url, data) => {
      const form = Object.fromEntries(new URLSearchParams(String(data)));
      requests.push({ url: String(url), ...form });
      const answer = form.action === "begin" ? begin : polls.length > 1 ? polls.shift()! : polls[0]!;
      if (answer === "never") return new Promise<never>(() => {});
      if (answer instanceof Error) throw answer;
      return answer as never;
    });
    return requests;
  }
  const PRESET = { name: "Daisy", description: "设计团队" };

  it("shows a link that only creates a new application, and returns its credentials once the owner confirms", async () => {
    const requests = registration([{ error: "authorization_pending" }, CREATED]);
    const creation = await new FeishuHttpOnboardingPlatform().createApplication(PRESET, new AbortController().signal);
    if (typeof creation === "string") throw new Error(`expected a link, got ${creation}`);
    const link = new URL(creation.url);
    // createOnly hides "select an existing application" on the scan page (US-002/AC-01).
    expect([link.origin + link.pathname, link.searchParams.get("user_code"), link.searchParams.get("createOnly"), link.searchParams.get("name"), link.searchParams.get("desc"), creation.expiresInSeconds])
      .toEqual(["https://accounts.feishu.cn/oauth/v1/app/confirm", "WXYZ-1234", "true", "Daisy", "设计团队", 600]);
    // The minimal template plus what a Team Leader application needs; the SDK packs it as gzip in URL-safe base64.
    const addons = JSON.parse(gunzipSync(Buffer.from(link.searchParams.get("addons")!.replace(/-/g, "+").replace(/_/g, "/"), "base64")).toString("utf8"));
    expect(addons).toEqual({ preset: false, scopes: { tenant: ["im:message:send_as_bot", "im:resource", "im:chat:readonly", "application:application:patch", "application:bot.basic_info:read"] } });
    expect(await creation.result).toEqual({ appId: "cli_9f8e7d6c5b4a3210", appSecret: "created-secret" });
    expect(requests.map(({ url, action, device_code }) => [url, action, device_code])).toEqual([
      [REGISTRATION, "begin", undefined], [REGISTRATION, "poll", "device-code-1"], [REGISTRATION, "poll", "device-code-1"]]);
  });

  it.each([
    ["the code ran out", { error: "expired_token", error_description: "expired" }, "expired"],
    ["the owner declined on the phone", { error: "access_denied", error_description: "denied" }, "denied"],
    ["the connection dropped while waiting", new Error("socket hang up"), "unreachable"],
    ["the platform answered another refusal", { error: "invalid_request", error_description: "bad device code" }, "failed"],
  ] as const)("creates no application when %s", async (_case, poll, expected) => {
    registration([poll]);
    const creation = await new FeishuHttpOnboardingPlatform().createApplication(PRESET, new AbortController().signal);
    if (typeof creation === "string") throw new Error(`expected a link, got ${creation}`);
    expect(await creation.result).toBe(expected);
  });

  it("stops waiting for the scan when the wait is cancelled", async () => {
    const requests = registration(["never"]);
    const controller = new AbortController();
    const creation = await new FeishuHttpOnboardingPlatform().createApplication(PRESET, controller.signal);
    if (typeof creation === "string") throw new Error(`expected a link, got ${creation}`);
    controller.abort();
    expect(await creation.result).toBe("cancelled");
    expect(requests.filter(({ action }) => action === "poll")).toHaveLength(1);
  });

  it.each([
    ["cannot be reached", new Error("getaddrinfo ENOTFOUND accounts.feishu.cn")],
    ["answers without a link", { error: "invalid_request" }],
    ["does not answer in time", "never"],
  ] as const)("gives no link when the platform %s", async (_case, begin) => {
    registration([CREATED], begin);
    expect(await new FeishuHttpOnboardingPlatform(undefined, { linkTimeoutMs: 50 }).createApplication(PRESET, new AbortController().signal)).toBe("unreachable");
  });
});
