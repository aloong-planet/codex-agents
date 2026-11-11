import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import * as lark from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { fetchRequest, FeishuHttpOnboardingPlatform, FixtureOnboardingPlatform, TeamOnboarding, type CreationEnd, type PlatformRequest } from "../src/team-onboarding.js";
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
function registryWithDaisy(secret: string | null = "daisy-secret", edit: TeamEdit = daisy) {
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
  const { teamId } = registry.saveTeam(edit, { basedOn: 1, ...(secret === null ? {} : { secret }) });
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

// QR creation and the steps only a created application has (team-management::US-002/AC-01, AC-03, AC-04), against the fixture
// platform. Whether Feishu accepts the automatic configuration and release of a QR-created application is not known without a
// real tenant (team-management spec, Pending); both answers are covered here.
describe("onboarding a team by QR creation (steps 1 to 5)", () => {
  // The fixture platform's first created application and its secret.
  const CREATED_APP = "cli_c0de000000000001";
  const BILL_APP = "cli_2222222222222222";
  const QR_DAISY: TeamEdit = { ...daisy, method: "qr", leader: { ...daisy.leader, appId: "" } };
  function qrOnboarding<Platform extends FixtureOnboardingPlatform = FixtureOnboardingPlatform>(path?: string, platform = new FixtureOnboardingPlatform() as Platform,
    reserved: Record<string, string> = {}) {
    const opened = path === undefined ? registryWithDaisy(null, QR_DAISY) : undefined;
    const registry = opened?.registry ?? new TeamRegistry(path!);
    const ends: CreationEnd[] = [];
    let waiting: (() => void) | undefined;
    const onboarding = new TeamOnboarding(registry, platform, SAM, () => 1_000, { creationEnded: (end) => { ends.push(end); waiting?.(); }, reserved: () => reserved });
    const daisyId = opened?.teamId ?? registry.current()!.definitions.teams.find(({ teamName }) => teamName === "设计团队")!.id;
    return { registry, path: opened?.path ?? path!, platform, onboarding, ends, teamId: daisyId,
      /** Ends the code the page shows, or the nth code the platform gave, and resolves once that has been reported. */
      scan: async (answer: "confirmed" | "expired" | "denied" | "failed" | "unreachable", code?: number) => {
        const ended = new Promise<void>((resolve) => { waiting = resolve; });
        platform.configure({ scan: answer, ...(code === undefined ? {} : { code }) });
        await ended;
      } };
  }
  const team = (registry: TeamRegistry, teamId: string) => registry.current()!.definitions.teams.find(({ id }) => id === teamId)!;
  const calls = (platform: FixtureOnboardingPlatform) => platform.calls.map(({ call, chatId }) => chatId ? `${call} ${chatId}` : call);
  const outcomes = (registry: TeamRegistry, appId = CREATED_APP) => {
    const { configure, publish, credentials, joins } = registry.onboarding(appId);
    const short = (outcome?: { status: string; reason?: string }) => outcome && (outcome.reason ? `${outcome.status}:${outcome.reason}` : outcome.status);
    return { configure: short(configure), publish: short(publish), credentials: short(credentials), joins: Object.fromEntries(Object.entries(joins).map(([chatId, outcome]) => [chatId, short(outcome)])) };
  };
  const ACCEPTING = [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }];
  const ONBOARDING = [{ chatId: "oc_alpha", state: "onboarding" }, { chatId: "oc_beta", state: "onboarding" }];

  it("shows a code for a saved team, prefilled with its leader and team names, and gives the created application to the team", async () => {
    const { registry, platform, onboarding, ends, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      expect([registry.creation(teamId), onboarding.creationLink(teamId), platform.calls]).toEqual([{ status: "waiting", at: 1_000 },
        { url: "https://accounts.feishu.cn/fixture/registration?create=1", expiresAt: 601_000 }, [{ call: "create", name: "Daisy", description: "设计团队" }]]);
      await scan("confirmed");
      expect([ends, registry.creation(teamId), onboarding.creationLink(teamId), team(registry, teamId).leader.appId, registry.secret(CREATED_APP)])
        .toEqual([[{ teamId, created: CREATED_APP }], { status: "done", appId: CREATED_APP, at: 1_000 }, undefined, CREATED_APP, "fixture-created-secret-1"]);
      // The scan is over: asking again shows no new code and changes nothing. Nor is a code asked for a team that does not exist.
      await onboarding.requestCreation(teamId);
      await onboarding.requestCreation("team-unknown");
      expect([onboarding.creationLink(teamId), registry.creation(teamId)?.status, platform.calls.length]).toEqual([undefined, "done", 1]);
    } finally { registry.close(); }
  });

  it.each([
    ["the code ran out", "expired", "expired"],
    ["the owner declined", "denied", "denied"],
    ["the platform refused the scan", "failed", "failed"],
    ["the connection dropped after the code was shown", "unreachable", "connection_lost"],
  ] as const)("creates no application when %s, and records why", async (_case, answer, reason) => {
    const { registry, onboarding, ends, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      await scan(answer);
      expect([ends, registry.creation(teamId), onboarding.creationLink(teamId), team(registry, teamId).leader.appId])
        .toEqual([[{ teamId, failed: reason }], { status: "action", reason, at: 1_000 }, undefined, ""]);
    } finally { registry.close(); }
  });

  class BrokenPlatform extends FixtureOnboardingPlatform {
    override async createApplication(): Promise<never> { throw new Error("socket hang up"); }
  }
  it.each([
    ["cannot be reached", () => { const platform = new FixtureOnboardingPlatform(); platform.configure({ link: "unreachable" }); return platform; }],
    ["fails the request", () => new BrokenPlatform()],
  ] as const)("records that no code was obtained when the platform %s", async (_case, platform) => {
    const { registry, onboarding, ends, teamId } = qrOnboarding(undefined, platform());
    try {
      await onboarding.requestCreation(teamId);
      expect([ends, registry.creation(teamId), onboarding.creationLink(teamId)]).toEqual([[{ teamId, failed: "unreachable" }], { status: "action", reason: "unreachable", at: 1_000 }, undefined]);
    } finally { registry.close(); }
  });

  // 刷新二维码 while a code waits. Feishu keeps the old code valid, so whichever the owner confirms first gives the team its
  // application; the other one, confirmed afterwards, created an application the team does not use.
  it.each([
    ["the new code", 2, 1],
    ["the code it replaced", 1, 2],
  ] as const)("shows a new code in place of one that waits, and gives the team the application of %s when that is confirmed first", async (_case, first, second) => {
    const { registry, onboarding, ends, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      await onboarding.requestCreation(teamId);
      expect([ends, registry.creation(teamId)?.status, onboarding.creationLink(teamId)?.url]).toEqual([[], "waiting", "https://accounts.feishu.cn/fixture/registration?create=2"]);
      await scan("confirmed", first);
      expect([ends, team(registry, teamId).leader.appId, registry.creation(teamId), onboarding.creationLink(teamId)])
        .toEqual([[{ teamId, created: CREATED_APP }], CREATED_APP, { status: "done", appId: CREATED_APP, at: 1_000 }, undefined]);
      await scan("confirmed", second);
      expect([ends.slice(1), team(registry, teamId).leader.appId, registry.hasSecret("cli_c0de000000000002")])
        .toEqual([[{ teamId, failed: "abandoned", unused: "cli_c0de000000000002" }], CREATED_APP, false]);
    } finally { registry.close(); }
  });

  // A replaced code that Feishu settles without an application says nothing about the team. Its lost connection is reported,
  // because a later confirmation of that code can no longer be learned; the code the page shows is not touched.
  it("says nothing when a replaced code runs out, and reports its lost connection without changing the code the page shows", async () => {
    const { registry, platform, onboarding, ends, teamId, scan } = qrOnboarding();
    try {
      for (let code = 1; code <= 3; code++) await onboarding.requestCreation(teamId);
      platform.configure({ scan: "expired", code: 1 });
      await scan("unreachable", 2);
      expect([ends, registry.creation(teamId), onboarding.creationLink(teamId)?.url])
        .toEqual([[{ teamId, failed: "connection_lost" }], { status: "waiting", at: 1_000 }, "https://accounts.feishu.cn/fixture/registration?create=3"]);
    } finally { registry.close(); }
  });

  // 刷新二维码 pressed while the first code's link is still on its way: nobody saw that code, so its request is aborted, and it
  // must not take the second code away when it ends.
  it("aborts a request that was replaced before its link arrived, without touching the new code", async () => {
    class SlowFirstLink extends FixtureOnboardingPlatform {
      release: () => void = () => {};
      private first = true;
      override async createApplication(...[preset, signal]: Parameters<FixtureOnboardingPlatform["createApplication"]>) {
        if (!this.first) return super.createApplication(preset, signal);
        this.first = false;
        await new Promise<void>((resolve) => { this.release = resolve; });
        return signal.aborted ? "cancelled" as const : super.createApplication(preset, signal);
      }
    }
    const { registry, platform, onboarding, ends, teamId } = qrOnboarding(undefined, new SlowFirstLink());
    try {
      const replaced = onboarding.requestCreation(teamId);
      await onboarding.requestCreation(teamId);
      platform.release();
      await replaced;
      // The aborted request never reached the platform: the only code it gave is the second request's.
      expect([ends, registry.creation(teamId), onboarding.creationLink(teamId)?.url, platform.calls.length])
        .toEqual([[], { status: "waiting", at: 1_000 }, "https://accounts.feishu.cn/fixture/registration?create=1", 1]);
    } finally { registry.close(); }
  });

  it("stops listening to every code when the service stops, and records no outcome", async () => {
    const { registry, platform, onboarding, ends, teamId } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      await onboarding.requestCreation(teamId);
      onboarding.close();
      for (const code of [1, 2]) expect(() => platform.configure({ scan: "confirmed", code })).toThrow("fixture_onboarding_no_creation_waiting");
      // Whatever the ended waits still report has been delivered by the next turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve));
      expect([ends, onboarding.creationLink(teamId), registry.creation(teamId)]).toEqual([[], undefined, { status: "waiting", at: 1_000 }]);
    } finally { registry.close(); }
  });

  // The scan created an application in Feishu, and the store refuses to keep it. The application is named, so that the owner
  // can remove it in Feishu. The store is made to fail by real means: a trigger on the secrets table, and a closed database.
  it("needs action and names the created application when it cannot be stored", async () => {
    const { registry, path, onboarding, ends, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      const store = new DatabaseSync(path);
      try { store.exec("CREATE TRIGGER secret_refused BEFORE INSERT ON application_secret BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"); } finally { store.close(); }
      await scan("confirmed");
      expect([ends, registry.creation(teamId), onboarding.creationLink(teamId), team(registry, teamId).leader.appId, registry.hasSecret(CREATED_APP)])
        .toEqual([[{ teamId, failed: "failed", unused: CREATED_APP }], { status: "action", reason: "failed", at: 1_000 }, undefined, "", false]);
    } finally { registry.close(); }
  });

  // What the store could not record stays a creation that waits; the next start records it as interrupted (team-registry.test.ts).
  it("names the created application when the store is unavailable, and leaves the creation waiting for the next start", async () => {
    const { registry, path, onboarding, ends, teamId, scan } = qrOnboarding();
    await onboarding.requestCreation(teamId);
    registry.close();
    await scan("confirmed");
    expect([ends, onboarding.creationLink(teamId)]).toEqual([[{ teamId, failed: "failed", unused: CREATED_APP }], undefined]);
    const reopened = new TeamRegistry(path);
    try {
      expect([reopened.creation(teamId), reopened.hasSecret(CREATED_APP)]).toEqual([{ status: "waiting", at: 1_000 }, false]);
    } finally { reopened.close(); }
  });

  // The store is unavailable when a code runs out: nothing can be recorded or reported, and nothing is left unhandled; the
  // run fails on an unhandled rejection otherwise.
  it("leaves a code whose end cannot be recorded waiting for the next start", async () => {
    const { registry, path, platform, onboarding, ends, teamId } = qrOnboarding();
    await onboarding.requestCreation(teamId);
    registry.close();
    platform.configure({ scan: "expired" });
    await new Promise((resolve) => setImmediate(resolve));
    expect([ends, onboarding.creationLink(teamId)]).toEqual([[], undefined]);
    const reopened = new TeamRegistry(path);
    try { expect(reopened.creation(teamId)).toEqual({ status: "waiting", at: 1_000 }); } finally { reopened.close(); }
  });

  it("does not give the team a created application that is reserved for another use, and reports it as unused", async () => {
    const { registry, onboarding, ends, teamId, scan } = qrOnboarding(undefined, new FixtureOnboardingPlatform(), { [CREATED_APP]: "该飞书应用已用于 Penny，不能用于团队" });
    try {
      await onboarding.requestCreation(teamId);
      await scan("confirmed");
      expect([ends, registry.creation(teamId), team(registry, teamId).leader.appId, registry.hasSecret(CREATED_APP)])
        .toEqual([[{ teamId, failed: "unusable", unused: CREATED_APP }], { status: "action", reason: "unusable", at: 1_000 }, "", false]);
    } finally { registry.close(); }
  });

  it("configures and releases the created application, checks it and joins its groups, in that order", async () => {
    const { registry, platform, onboarding, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      await scan("confirmed");
      expect(team(registry, teamId).bindings).toEqual(ONBOARDING);
      const started = await onboarding.run(teamId);
      expect(calls(platform)).toEqual(["create", "configure", "publish", "check", "add oc_alpha", "in_chat oc_alpha", "add oc_beta", "in_chat oc_beta"]);
      expect(platform.calls.filter(({ call }) => call === "configure" || call === "publish" || call === "check").map(({ appId }) => appId)).toEqual([CREATED_APP, CREATED_APP, CREATED_APP]);
      expect(outcomes(registry)).toEqual({ configure: "done", publish: "done", credentials: "done", joins: { oc_alpha: "done", oc_beta: "done" } });
      expect([started, team(registry, teamId).bindings]).toEqual([[{ teamId, chatId: "oc_alpha" }, { teamId, chatId: "oc_beta" }], ACCEPTING]);
    } finally { registry.close(); }
  });

  // US-002/AC-03 step 3: the release awaits the admin's review. The submitted release is not submitted again, by a later run or after a restart.
  it("waits for the admin's review after submitting the release once, and finishes when the bot is enabled", async () => {
    const first = qrOnboarding();
    await first.onboarding.requestCreation(first.teamId);
    await first.scan("confirmed");
    first.platform.configure({ applications: { [CREATED_APP]: "not_enabled" } });
    expect(await first.onboarding.run(first.teamId)).toEqual([]);
    expect([outcomes(first.registry), calls(first.platform)]).toEqual([{ configure: "done", publish: "review:submitted", credentials: undefined, joins: {} }, ["create", "configure", "publish", "check"]]);
    await first.onboarding.run(first.teamId);
    expect(calls(first.platform).slice(4)).toEqual(["check"]);
    first.registry.close();
    const restarted = qrOnboarding(first.path);
    try {
      restarted.platform.configure({ applications: { [CREATED_APP]: "not_enabled" } });
      await restarted.onboarding.resume();
      expect([calls(restarted.platform), outcomes(restarted.registry).publish]).toEqual([["check"], "review:submitted"]);
      restarted.platform.configure({ applications: { [CREATED_APP]: "enabled" } });
      const started = await restarted.onboarding.run(restarted.teamId);
      expect(calls(restarted.platform).slice(1)).toEqual(["check", "add oc_alpha", "in_chat oc_alpha", "add oc_beta", "in_chat oc_beta"]);
      expect([outcomes(restarted.registry), started.length]).toEqual([{ configure: "done", publish: "done", credentials: "done", joins: { oc_alpha: "done", oc_beta: "done" } }, 2]);
    } finally { restarted.registry.close(); }
  });

  // The automatic calls may be refused: no official page says the application-v7 APIs accept a QR-created application. The step
  // then needs the owner's action, and an enabled bot later completes both steps whoever configured and released it.
  it.each([
    ["the configuration is refused", { configure: { [CREATED_APP]: "refused" } }, { configure: "action:refused", publish: undefined }, ["configure", "check"]],
    ["the configuration gets no answer", { configure: { [CREATED_APP]: "unreachable" } }, { configure: "action:unreachable", publish: undefined }, ["configure", "check"]],
    ["the release is refused", { publish: { [CREATED_APP]: "refused" } }, { configure: "done", publish: "action:refused" }, ["configure", "publish", "check"]],
    ["the release gets no answer", { publish: { [CREATED_APP]: "unreachable" } }, { configure: "done", publish: "action:unreachable" }, ["configure", "publish", "check"]],
  ] as const)("needs the owner's action when %s, and completes both steps once the bot is enabled", async (_case, answers, expected, asked) => {
    const { registry, platform, onboarding, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      await scan("confirmed");
      platform.configure({ ...answers, applications: { [CREATED_APP]: "not_enabled" } });
      await onboarding.run(teamId);
      expect([outcomes(registry), calls(platform).slice(1)]).toEqual([{ ...expected, credentials: undefined, joins: {} }, asked]);
      // The owner configured and released it by hand; the automatic calls are still refused.
      platform.configure({ applications: { [CREATED_APP]: "enabled" } });
      const started = await onboarding.run(teamId);
      expect([outcomes(registry), started.length]).toEqual([{ configure: "done", publish: "done", credentials: "done", joins: { oc_alpha: "done", oc_beta: "done" } }, 2]);
    } finally { registry.close(); }
  });

  it("does not ask for a release that the platform says is already under review", async () => {
    const { registry, platform, onboarding, teamId, scan } = qrOnboarding();
    try {
      await onboarding.requestCreation(teamId);
      await scan("confirmed");
      platform.configure({ configure: { [CREATED_APP]: "under_review" }, applications: { [CREATED_APP]: "not_enabled" } });
      await onboarding.run(teamId);
      expect([outcomes(registry), calls(platform).slice(1)]).toEqual([{ configure: "done", publish: "review:submitted", credentials: undefined, joins: {} }, ["configure", "check"]]);
    } finally { registry.close(); }
  });

  // Owner decision D2 (2026-11-11): a team with an application may be saved as QR creation; its application works until the scan.
  it("keeps a team on the application it has until the scan, then onboards it again with the created one", async () => {
    const { registry, platform, onboarding, ends, scan } = qrOnboarding();
    try {
      const bill = team(registry, "bill");
      registry.saveTeam({ id: "bill", method: "qr", teamName: bill.teamName, responsibility: bill.responsibility, leader: { name: bill.leader.name, appId: "", instructions: "" },
        executorProfiles: bill.executorProfiles.map(({ id, name, instructions, hostTools }) => ({ id, name, noun: "执行者", instructions, hostTools })), groups: ["oc_alpha", "oc_beta"] },
        { basedOn: registry.current()!.version });
      await onboarding.requestCreation("bill");
      await onboarding.run("bill");
      // Before the scan Bill's own application is checked; nothing is configured or released, and Bill keeps accepting work.
      expect([platform.calls.slice(1), team(registry, "bill").bindings]).toEqual([[{ call: "check", appId: BILL_APP }], ACCEPTING]);
      await scan("confirmed");
      expect([ends, team(registry, "bill").leader.appId, team(registry, "bill").bindings, registry.hasSecret(BILL_APP)])
        .toEqual([[{ teamId: "bill", created: CREATED_APP, replaced: BILL_APP }], CREATED_APP, ONBOARDING, false]);
      await onboarding.run("bill");
      expect([outcomes(registry), team(registry, "bill").bindings]).toEqual([{ configure: "done", publish: "done", credentials: "done", joins: { oc_alpha: "done", oc_beta: "done" } }, ACCEPTING]);
    } finally { registry.close(); }
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
  type Poll = Record<string, unknown> | Error | "never" | Promise<Record<string, unknown>>;
  /**
   * The registration endpoint: `begin` answers with a link (or fails), then each poll takes the next answer; the last one repeats.
   * A promise is a poll still in flight, answered when the case resolves it.
   */
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

  // The owner confirms on the phone while the poll that will say so is in flight. Feishu creates the application whatever the
  // service does next, and the SDK stops polling a wait that is aborted: so a code that was shown is listened to until Feishu
  // settles it. These two cases drive the onboarding run with the real adapter, because only the SDK shows what an abort loses.
  function waitingForScan(confirmation: Promise<Record<string, unknown>>) {
    registration([confirmation, "never"]);
    const { registry, teamId } = registryWithDaisy(null, { ...daisy, method: "qr", leader: { ...daisy.leader, appId: "" } });
    const ends: CreationEnd[] = [];
    let ended: () => void = () => {};
    const onboarding = new TeamOnboarding(registry, new FeishuHttpOnboardingPlatform(), SAM, () => 1_000, { creationEnded: (end) => { ends.push(end); ended(); } });
    /** Resolves when a code's end is reported. The limit only lets a case that reports nothing fail on its assertion instead of hanging. */
    const settled = () => new Promise<void>((resolve) => { ended = resolve; setTimeout(resolve, 5_000).unref(); });
    return { registry, teamId, ends, onboarding, settled };
  }
  const appOf = (registry: TeamRegistry, teamId: string) => registry.current()!.definitions.teams.find(({ id }) => id === teamId)!.leader.appId;

  it("gives the team the application of a code that 刷新二维码 had replaced, when that code is the one confirmed", async () => {
    let confirm: (answer: Record<string, unknown>) => void = () => {};
    const { registry, teamId, ends, onboarding, settled } = waitingForScan(new Promise((resolve) => { confirm = resolve; }));
    try {
      await onboarding.requestCreation(teamId);
      await onboarding.requestCreation(teamId);
      const done = settled();
      confirm(CREATED);
      await done;
      expect([ends, appOf(registry, teamId), registry.creation(teamId), onboarding.creationLink(teamId)])
        .toEqual([[{ teamId, created: "cli_9f8e7d6c5b4a3210" }], "cli_9f8e7d6c5b4a3210", { status: "done", appId: "cli_9f8e7d6c5b4a3210", at: 1_000 }, undefined]);
    } finally { onboarding.close(); registry.close(); }
  });

  it("names an application confirmed after the team was saved as an existing application as unused, and does not give it to the team", async () => {
    let confirm: (answer: Record<string, unknown>) => void = () => {};
    const { registry, teamId, ends, onboarding, settled } = waitingForScan(new Promise((resolve) => { confirm = resolve; }));
    try {
      await onboarding.requestCreation(teamId);
      registry.saveTeam({ ...daisy, id: teamId, method: "existing", executorProfiles: [{ ...daisy.executorProfiles[0]!, id: "executor-1" }] }, { basedOn: registry.current()!.version, secret: "daisy-secret" });
      onboarding.endCreation(teamId);
      const done = settled();
      confirm(CREATED);
      await done;
      expect([ends, appOf(registry, teamId), registry.hasSecret("cli_9f8e7d6c5b4a3210")]).toEqual([[{ teamId, failed: "abandoned", unused: "cli_9f8e7d6c5b4a3210" }], DAISY_APP, false]);
    } finally { onboarding.close(); registry.close(); }
  });
});
