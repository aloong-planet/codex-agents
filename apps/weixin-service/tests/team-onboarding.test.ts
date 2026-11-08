import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { FeishuHttpOnboardingPlatform, FixtureOnboardingPlatform, TeamOnboarding, type PlatformRequest } from "../src/team-onboarding.js";
import { TeamRegistry, type TeamEdit } from "../src/team-registry.js";

// Onboarding of an existing application (team-management::US-002/AC-02, REQ-003) against the fixture platform, the fake of the
// Feishu platform APIs that fixture mode also uses. The answers it gives follow the official API documentation read on
// 2026-11-07 (~/research/codex-weixin-agent-team/feishu-onboarding.md): error 20069 for an application not yet published or
// enabled, bot activate_status 2 for an enabled bot, 232017 for a group where only owners and admins add members, and
// pending_approval_id_list for a join awaiting approval.
// Coverage gap: no real tenant is called, so whether these codes and permissions behave as documented is live acceptance
// (team-management spec, Pending). The HTTP client's mapping of the documented response bodies is covered below.
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

  it.each([
    ["a group where only owners and admins add members (232017)", { status: 400, body: { code: 232017, msg: "No permission" } }, "owner_only"],
    ["a join awaiting approval", { body: { code: 0, msg: "success", data: { invalid_id_list: [], not_existed_id_list: [], pending_approval_id_list: [DAISY_APP] } } }, "pending_approval"],
    ["another refusal (232025, bot not activated)", { status: 400, body: { code: 232025, msg: "Bot ability is not activated" } }, "refused"],
    ["no connection", { fail: true }, "unreachable"],
  ] as const)("reads %s when adding a bot", async (_case, answer, expected) => {
    const { platform: http } = platform({ [TOKEN]: token("t-sam"), ["https://open.feishu.cn/open-apis/im/v1/chats/"]: answer as Answer });
    expect(await http.addBot("oc_alpha", DAISY_APP, SAM)).toBe(expected);
  });
});
