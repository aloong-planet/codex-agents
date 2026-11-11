// The team-management API at the HTTP boundary of the real local status server, behind the real console guard with a browser
// authorized by a login link (team-management spec, Testing Decisions "Console"). The registry, announcements and audit are the
// real stores; the onboarding platform is the fixture fake (team-onboarding.test.ts covers its answers).
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exchangeLoginLink } from "../e2e/console-session.js";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { createChannelStatusServer } from "../src/channel-status-server.js";
import { ConsoleAccess } from "../src/console-access.js";
import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import { createConsoleRoutes } from "../src/console-routes.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { TeamAnnouncements } from "../src/team-announcements.js";
import { TeamManagement } from "../src/team-management.js";
import { FixtureOnboardingPlatform } from "../src/team-onboarding.js";
import { TeamRegistry } from "../src/team-registry.js";
import { PRODUCTION_TOOL_IDS } from "./support/production-tools.js";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAM = { appId: "cli_0123456789abcdef", appSecret: "sam-secret" };
const SECRET_SENTINEL = "api-secret-SENTINEL-41c9";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/**
 * Starts the service's team management on a new state directory, or on `work`, the directory of an earlier start that was
 * stopped, as a restart does. `stop` ends this start; whatever is still running when the case ends is stopped then.
 */
async function start({ work: earlier, ...options }: { now?: () => number; reservedApplications?: () => Record<string, string>; work?: string } = {}) {
  const work = earlier ?? fs.mkdtempSync(path.join(os.tmpdir(), "team-api-"));
  if (!earlier) cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const steps: Array<() => Promise<void> | void> = [];
  const stop = async () => { for (const step of steps.splice(0).reverse()) await step(); };
  cleanup.push(stop);
  const state = path.join(work, "state");
  const home = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  const audit = new ConsoleAudit({ directory: state });
  const access = new ConsoleAccess({ directory: state, audit });
  const catalog = new McpCatalog({ stateDirectory: state, homeDirectory: home, audit, retryMs: 60_000, refreshMs: 0 });
  steps.push(() => catalog.close());
  const registry = new TeamRegistry(path.join(state, "team-registry.sqlite"));
  const announcements = new TeamAnnouncements(path.join(state, "team-announcements.sqlite"));
  steps.push(() => { registry.close(); announcements.close(); });
  const parsed = parseChannelStartupConfiguration({ channel: "feishu",
    owner: { memoryAccountId: "owner-memory", bindings: [{ channel: "feishu", accountId: SAM.appId, target: "oc_private", senderId: "ou_owner" }] },
    taskScope: { accountId: "owner-memory", target: "oc_private" },
    feishu: { ...SAM, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
      dispatch: { groupChatIds: ["oc_alpha", "oc_beta"], agents: [{ id: "sam" }, { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
        { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" }, { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }] } } });
  const feishu = parsed.entries.find((entry) => entry.channel === "feishu");
  if (!feishu?.dispatch) throw new Error("expected_dispatch_configuration");
  registry.importLocalConfiguration(feishu.dispatch, { executorHostTools: PRODUCTION_TOOL_IDS });
  const platform = new FixtureOnboardingPlatform();
  platform.configure({ chats: { oc_alpha: { name: "银河护卫队" } } });
  const teams = new TeamManagement({ registry, coordinator: SAM, platform, announcements, audit, catalogToolIds: PRODUCTION_TOOL_IDS,
    moduleScopes: () => [{ read: true, write: false }], activeAssignments: () => ({}), rosterChanged: () => {}, report: () => {}, ...options });
  steps.push(() => teams.close());
  const server: Server = createChannelStatusServer(() => ({}), undefined, access, createConsoleRoutes({ catalog, teams }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  steps.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const cookie = await exchangeLoginLink(access.issueLoginLink(address.port).url, CHROME_MAC);
  const bodies: string[] = [];
  const request = async (pathname: string, payload?: unknown, headers: Record<string, string> = { cookie }) => {
    const response = await fetch(`${origin}${pathname}`, payload === undefined ? { headers }
      : { method: "POST", headers: { ...headers, origin, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  /** A GET whose answer is not JSON: the status, the content type and the text, which also joins `bodies`. */
  const fetched = async (pathname: string) => {
    const response = await fetch(`${origin}${pathname}`, { headers: { cookie } });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, type: response.headers.get("content-type"), text };
  };
  const auditEntries = () => fs.readFileSync(path.join(state, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { request, fetched, bodies, auditEntries, state, work, platform, teams, stop };
}

const daisy = { teamName: "设计团队", responsibility: "视觉方案", groups: ["oc_alpha"], leader: { name: "Daisy", appId: "cli_dddddddddddddddd", instructions: "" },
  executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: ["files.read", "files.write", "schedules.list"] }] };

describe("team management API", () => {
  it("never returns the App Secret, and audits each change by kind with the browser and without the secret", async () => {
    const { request, bodies, auditEntries } = await start();
    const first = (await request("/api/teams")).body;
    expect(first).toMatchObject({ configured: true, version: 1, groups: [{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "oc_beta" }] });
    const saved = await request("/api/teams/save", { basedOn: first.version, team: { ...daisy, secret: SECRET_SENTINEL } });
    expect(saved.status).toBe(200);
    const teamId = saved.body.teamId as string;
    await vi.waitFor(async () => expect((await request("/api/teams")).body.preview.oc_alpha).toContain(teamId), { timeout: 5000, interval: 20 });
    const view = (await request("/api/teams")).body;
    // The effective tools are the checked tools that module permissions grant: here read is granted and write is not.
    expect(view.teams.find(({ id }: { id: string }) => id === teamId)).toMatchObject({ secretStored: true,
      profiles: [{ name: "视觉方案", noun: "视觉执行者", effective: ["files.read", "schedules.list"], ungranted: ["files.write"] }] });
    const edit = { ...daisy, id: teamId, groups: ["oc_beta"], executorProfiles: [{ ...daisy.executorProfiles[0]!, id: "executor-1", instructions: "按品牌规范出图" }] };
    expect((await request("/api/teams/save", { basedOn: view.version, team: edit })).status).toBe(200);
    expect((await request("/api/teams/recheck", { teamId })).status).toBe(200);
    for (const body of bodies) expect(body).not.toContain(SECRET_SENTINEL);
    const entries = auditEntries();
    expect(JSON.stringify(entries)).not.toContain(SECRET_SENTINEL);
    const ours = entries.filter(({ event }) => String(event).startsWith("team_"));
    expect(ours.map(({ event, by }) => [event, by])).toEqual(expect.arrayContaining([["team_changed", "browser"], ["team_secret_written", "browser"],
      ["team_binding_changed", "browser"], ["team_profile_saved", "browser"], ["team_onboarding_checked", "browser"]]));
    expect(ours.filter(({ event }) => event === "team_binding_changed").map(({ group, from, to }) => [group, from, to]))
      .toEqual([["oc_alpha", null, "onboarding"], ["oc_alpha", "accepting", "draining"], ["oc_beta", null, "onboarding"]]);
    for (const entry of ours.filter(({ by }) => by === "browser")) expect(entry.browser).toMatchObject({ id: expect.any(String), label: expect.any(String) });
  });

  it("refuses invalid, stale and out-of-bounds saves with reasons the save bar can show, and anyone without a login", async () => {
    const { request } = await start();
    const view = (await request("/api/teams")).body;
    expect(await request("/api/teams/save", { basedOn: view.version, team: { ...daisy, teamName: "", executorProfiles: [] } }))
      .toEqual({ status: 400, body: { error: "无法保存", reasons: ["缺少团队名称", "至少需要一个执行者能力档"] } });
    const bill = view.teams.find(({ id }: { id: string }) => id === "bill");
    const billEdit = (responsibility: string) => ({ id: "bill", teamName: bill.teamName, responsibility, leader: bill.leader, groups: ["oc_alpha", "oc_beta"],
      executorProfiles: bill.profiles.map(({ id, name, noun, instructions, hostTools }: Record<string, unknown>) => ({ id, name, noun, instructions, hostTools })) });
    expect((await request("/api/teams/save", { basedOn: view.version, team: billEdit("第一处修改") })).status).toBe(200);
    expect(await request("/api/teams/save", { basedOn: view.version, team: billEdit("另一页的修改") }))
      .toEqual({ status: 409, body: { error: "这个团队已在其他页面保存过新版本；为避免覆盖，本次保存没有生效。", stale: true } });
    // Sam: only the responsibility and instructions; no profiles, application or groups, and it cannot be saved as a team.
    expect((await request("/api/teams/coordinator", { basedOn: view.version, coordinator: { responsibility: "只协调", instructions: "先澄清" } })).status).toBe(200);
    expect((await request("/api/teams/coordinator", { basedOn: view.version, coordinator: { responsibility: "只协调", instructions: "", groups: [] } })).body)
      .toEqual({ error: "Sam 只能修改职责与提示词" });
    expect((await request("/api/teams/save", { basedOn: view.version, team: { ...daisy, id: "sam" } })).body).toEqual({ error: "Sam 只能修改职责与提示词" });
    expect((await request("/api/teams/save", { basedOn: view.version, team: { ...daisy, executorProfiles: [{ ...daisy.executorProfiles[0]!, hostTools: ["shell.exec"] }] } })).body)
      .toEqual({ error: "工具格式无效" });
    expect((await request("/api/teams", undefined, {})).status).toBe(401);
  });

  // Group names (ticket 11, decision D4): a name the platform cannot give is asked for again after 10 minutes, concurrent views share
  // one lookup, and 重新检查 or a save of a team asks again at once for that team's groups, so a fix the owner just made shows (review R2).
  it.each([
    ["重新检查", (request: Requester) => request("/api/teams/recheck", { teamId: "bill" })],
    ["a save", (request: Requester, view: { version: number; teams: Array<Record<string, unknown>> }) => request("/api/teams/save", { basedOn: view.version, team: unchangedBill(view) })],
  ] as const)("looks up a group name the platform could not give again only after 10 minutes, or at once on %s", async (_case, act) => {
    let clock = 1_000_000;
    const { request, platform } = await start({ now: () => clock });
    const lookups = () => platform.calls.filter(({ call, chatId }) => call === "chat_name" && chatId === "oc_beta").length;
    const names = async () => ((await request("/api/teams")).body.groups as Array<{ name: string }>).map(({ name }) => name);
    await Promise.all([request("/api/teams"), request("/api/teams")]);
    expect(lookups()).toBe(1);
    platform.configure({ chats: { oc_beta: { name: "产品讨论组" } } });
    expect(await names()).toEqual(["银河护卫队", "oc_beta"]);
    clock += 9 * 60_000;
    expect([await names(), lookups()]).toEqual([["银河护卫队", "oc_beta"], 1]);
    expect((await act(request, (await request("/api/teams")).body)).status).toBe(200);
    expect([await names(), lookups()]).toEqual([["银河护卫队", "产品讨论组"], 2]);
  });

  it("looks up a group name the platform could not give again once 10 minutes have passed", async () => {
    let clock = 1_000_000;
    const { request, platform } = await start({ now: () => clock });
    await request("/api/teams");
    platform.configure({ chats: { oc_beta: { name: "产品讨论组" } } });
    clock += 10 * 60_000;
    expect(((await request("/api/teams")).body.groups as Array<{ name: string }>).map(({ name }) => name)).toEqual(["银河护卫队", "产品讨论组"]);
  });
});

// QR creation and the test message at the HTTP boundary (team-management::US-002/AC-01, AC-03, AC-04, CON-001; agent-console::REQ-004).
// The fixture platform creates `cli_c0de000000000001` with the secret `fixture-created-secret-1` when its scan is confirmed.
describe("QR creation through the team management API", () => {
  const CREATED_APP = "cli_c0de000000000001";
  const CREATED_SECRET = "fixture-created-secret";
  const qrDaisy = { ...daisy, method: "qr", groups: ["oc_alpha", "oc_beta"], leader: { ...daisy.leader, appId: "" } };
  type Team = { id: string; method: string; leader: { appId: string }; secretStored: boolean; creation?: Record<string, unknown>; configure?: { status: string; reason?: string };
    publish?: { status: string; reason?: string }; credentials?: { status: string }; bindings: Array<{ chatId: string; state: string; join?: { status: string; reason?: string } }>;
    tests: Record<string, { status: string }> };
  /** Polls the view until the team satisfies `ready`; the service works on a creation and its steps after the request that started them. */
  async function teamWhen(request: Requester, teamId: string, ready: (team: Team) => boolean): Promise<Team> {
    return vi.waitFor(async () => {
      const team = ((await request("/api/teams")).body.teams as Team[]).find(({ id }) => id === teamId)!;
      expect(ready(team), JSON.stringify(team)).toBe(true);
      return team;
    }, { timeout: 5000, interval: 20 });
  }

  it("creates a saved team's application by scan, shows its App ID and its six steps, and never returns or audits the secret", async () => {
    const { request, fetched, bodies, auditEntries, platform } = await start();
    // The created application's release awaits the admin's review, and oc_beta lets only its owner and admins add members.
    platform.configure({ applications: { [CREATED_APP]: "not_enabled" }, chats: { oc_beta: { add: "owner_only" } } });
    const first = (await request("/api/teams")).body;
    expect((first.teams as Team[]).map(({ id, method }) => [id, method])).toEqual([["alice", "existing"], ["bill", "existing"], ["jack", "existing"]]);
    const teamId = (await request("/api/teams/save", { basedOn: first.version, team: qrDaisy })).body.teamId as string;
    // Step 1: the code waits for the scan, as an image the page can show.
    const waiting = await teamWhen(request, teamId, ({ creation }) => typeof creation?.codeExpiresAt === "number");
    expect([waiting.method, waiting.creation?.status, waiting.leader.appId, waiting.secretStored]).toEqual(["qr", "waiting", "", false]);
    const code = await fetched(`/api/teams/qr?team=${teamId}`);
    expect([code.status, code.type, code.text.startsWith("<svg")]).toEqual([200, "image/svg+xml; charset=utf-8", true]);
    // The scan: the App ID fills in, the secret is stored, and steps 2 and 3 leave the release awaiting review.
    platform.configure({ scan: "confirmed" });
    const review = await teamWhen(request, teamId, ({ publish }) => publish !== undefined);
    expect({ creation: review.creation, appId: review.leader.appId, secretStored: review.secretStored, configure: review.configure?.status, publish: [review.publish?.status, review.publish?.reason],
      credentials: review.credentials, bindings: review.bindings.map(({ state, join }) => [state, join]) }).toEqual({ creation: { status: "done", appId: CREATED_APP }, appId: CREATED_APP,
      secretStored: true, configure: "done", publish: ["review", "submitted"], credentials: undefined, bindings: [["onboarding", undefined], ["onboarding", undefined]] });
    expect((await fetched(`/api/teams/qr?team=${teamId}`)).status).toBe(404);
    // The admin approved: 重新检查 finishes steps 3 to 5. The team takes work in oc_alpha; oc_beta needs the owner's action.
    platform.configure({ applications: { [CREATED_APP]: "enabled" } });
    const checked = (await request("/api/teams/recheck", { teamId })).body.view;
    const done = (checked.teams as Team[]).find(({ id }) => id === teamId)!;
    expect({ publish: done.publish?.status, credentials: done.credentials?.status, bindings: done.bindings.map(({ chatId, state, join }) => [chatId, state, join?.status, join?.reason]) })
      .toEqual({ publish: "done", credentials: "done", bindings: [["oc_alpha", "accepting", "done", undefined], ["oc_beta", "onboarding", "action", "owner_only"]] });
    expect([checked.preview.oc_alpha.includes(teamId), checked.preview.oc_beta.includes(teamId)]).toEqual([true, false]);
    // team-management::CON-001: the secret the scan returned is in no response and no audit entry.
    expect(bodies.length).toBeGreaterThan(5);
    for (const body of bodies) expect(body).not.toContain(CREATED_SECRET);
    const entries = auditEntries();
    expect(JSON.stringify(entries)).not.toContain(CREATED_SECRET);
    const ours = entries.filter(({ team }) => team === teamId);
    expect(ours.find(({ event }) => event === "team_changed")).toMatchObject({ by: "browser", changed: ["created"], method: "qr" });
    expect(ours.find(({ event }) => event === "team_application_qr_requested")).toMatchObject({ by: "browser", browser: { id: expect.any(String) } });
    expect(ours.find(({ event }) => event === "team_application_created")).toMatchObject({ by: "service", appId: CREATED_APP });
    expect(ours.filter(({ event }) => event === "team_onboarding_checked").map(({ by, configure, publish, credentials }) => [by, configure, publish, credentials]))
      .toEqual([["service", "done", "review:submitted", null], ["browser", "done", "done", "done"]]);
  });

  it("needs action after a code that ran out, shows a new code on request, and says when no code could be obtained", async () => {
    const { request, fetched, auditEntries, platform } = await start();
    const first = (await request("/api/teams")).body;
    const teamId = (await request("/api/teams/save", { basedOn: first.version, team: qrDaisy })).body.teamId as string;
    await teamWhen(request, teamId, ({ creation }) => typeof creation?.codeExpiresAt === "number");
    const before = (await fetched(`/api/teams/qr?team=${teamId}`)).text;
    platform.configure({ scan: "expired" });
    expect((await teamWhen(request, teamId, ({ creation }) => creation?.status === "action")).creation).toEqual({ status: "action", reason: "expired" });
    expect((await fetched(`/api/teams/qr?team=${teamId}`)).status).toBe(404);
    // 刷新二维码 answers once the new code is known.
    const refreshed = (await request("/api/teams/qr", { teamId })).body.view;
    expect((refreshed.teams as Team[]).find(({ id }) => id === teamId)!.creation).toMatchObject({ status: "waiting", codeExpiresAt: expect.any(Number) });
    const after = await fetched(`/api/teams/qr?team=${teamId}`);
    expect([after.status, after.text === before]).toEqual([200, false]);
    platform.configure({ link: "unreachable" });
    const unreachable = (await request("/api/teams/qr", { teamId })).body.view;
    expect((unreachable.teams as Team[]).find(({ id }) => id === teamId)!.creation).toEqual({ status: "action", reason: "unreachable" });
    // A code is asked for only where one can be used: not for a team with an existing application, nor after the scan.
    expect(await request("/api/teams/qr", { teamId: "bill" })).toEqual({ status: 400, body: { error: "这个团队不在扫码创建中" } });
    platform.configure({ link: "ready" });
    await request("/api/teams/qr", { teamId });
    platform.configure({ scan: "confirmed" });
    await teamWhen(request, teamId, ({ creation }) => creation?.status === "done");
    expect(await request("/api/teams/qr", { teamId })).toEqual({ status: 400, body: { error: "应用已经创建，不需要新的二维码" } });
    expect(auditEntries().filter(({ team, event }) => team === teamId && String(event).startsWith("team_application_")).map(({ event, by, reason }) => [event, by, reason])).toEqual([
      ["team_application_qr_requested", "browser", undefined], ["team_application_qr_failed", "service", "expired"], ["team_application_qr_requested", "browser", undefined],
      ["team_application_qr_requested", "browser", undefined], ["team_application_qr_failed", "service", "unreachable"], ["team_application_qr_requested", "browser", undefined],
      ["team_application_created", "service", undefined]]);
  });

  it("ends a team's QR creation when it is saved as an existing application, and names an application its code creates afterwards as unused", async () => {
    const { request, fetched, bodies, auditEntries, platform } = await start();
    const first = (await request("/api/teams")).body;
    const teamId = (await request("/api/teams/save", { basedOn: first.version, team: qrDaisy })).body.teamId as string;
    await teamWhen(request, teamId, ({ creation }) => typeof creation?.codeExpiresAt === "number");
    const version = (await request("/api/teams")).body.version;
    const saved = await request("/api/teams/save", { basedOn: version, team: { ...daisy, id: teamId, groups: ["oc_alpha", "oc_beta"], method: "existing", secret: SECRET_SENTINEL,
      executorProfiles: [{ ...daisy.executorProfiles[0]!, id: "executor-1" }] } });
    expect(saved.status).toBe(200);
    const team = (saved.body.view.teams as Team[]).find(({ id }) => id === teamId)!;
    expect([team.method, team.creation, team.leader.appId, (await fetched(`/api/teams/qr?team=${teamId}`)).status]).toEqual(["existing", undefined, "cli_dddddddddddddddd", 404]);
    // The code is still valid at Feishu. The owner confirms it on the phone: the team keeps the application it was saved with.
    platform.configure({ scan: "confirmed" });
    const unused = await vi.waitFor(() => {
      const entry = auditEntries().find(({ team: audited, event }) => audited === teamId && event === "team_application_qr_failed");
      expect(entry).toBeDefined();
      return entry!;
    }, { timeout: 5000, interval: 20 });
    expect([unused.by, unused.reason, unused.appId]).toEqual(["service", "abandoned", CREATED_APP]);
    const after = ((await request("/api/teams")).body.teams as Team[]).find(({ id }) => id === teamId)!;
    expect([after.method, after.creation, after.leader.appId]).toEqual(["existing", undefined, "cli_dddddddddddddddd"]);
    for (const body of bodies) expect(body).not.toContain(CREATED_SECRET);
    expect(JSON.stringify(auditEntries())).not.toContain(CREATED_SECRET);
    expect(auditEntries().filter(({ team: audited, event }) => audited === teamId && event === "team_changed").map(({ changed, method }) => [changed, method]))
      .toEqual([[["created"], "qr"], [["leader.appId", "method"], "existing"]]);
  });

  // Owner decision D2 (2026-11-11): the scan replaces the application a team already has, and the audit names both.
  it("audits the application a scan replaced", async () => {
    const { request, auditEntries, platform } = await start();
    const first = (await request("/api/teams")).body;
    expect((await request("/api/teams/save", { basedOn: first.version, team: { ...unchangedBill(first), method: "qr" } })).status).toBe(200);
    await teamWhen(request, "bill", ({ creation }) => typeof creation?.codeExpiresAt === "number");
    platform.configure({ scan: "confirmed" });
    await teamWhen(request, "bill", ({ creation }) => creation?.status === "done");
    expect(auditEntries().filter(({ event }) => event === "team_application_created").map(({ team, by, appId, replaced }) => [team, by, appId, replaced]))
      .toEqual([["bill", "service", CREATED_APP, "cli_2222222222222222"]]);
  });

  // An application reserved outside the registry, as Penny's is (ADR-0025), never becomes a team's, even when a scan created it.
  it("does not give a team a created application that is reserved, and audits it as unused", async () => {
    const { request, auditEntries, platform } = await start({ reservedApplications: () => ({ [CREATED_APP]: "该飞书应用已用于 Penny，不能用于团队" }) });
    const first = (await request("/api/teams")).body;
    const teamId = (await request("/api/teams/save", { basedOn: first.version, team: qrDaisy })).body.teamId as string;
    await teamWhen(request, teamId, ({ creation }) => typeof creation?.codeExpiresAt === "number");
    platform.configure({ scan: "confirmed" });
    const refused = await teamWhen(request, teamId, ({ creation }) => creation?.status === "action");
    expect([refused.creation, refused.leader.appId, refused.secretStored]).toEqual([{ status: "action", reason: "unusable" }, "", false]);
    expect(auditEntries().filter(({ team, event }) => team === teamId && event === "team_application_qr_failed").map(({ by, reason, appId }) => [by, reason, appId]))
      .toEqual([["service", "unusable", CREATED_APP]]);
  });

  // A code's wait ends with the process. Whether the owner confirmed it afterwards cannot be learned, so the next start says
  // so in the audit. That start does not get as far as resuming onboarding here, as when its Feishu channel fails to start.
  it("audits a code that waited when the service stopped, at the next start, even one that never resumes onboarding", async () => {
    const before = await start();
    const first = (await before.request("/api/teams")).body;
    const teamId = (await before.request("/api/teams/save", { basedOn: first.version, team: qrDaisy })).body.teamId as string;
    await teamWhen(before.request, teamId, ({ creation }) => typeof creation?.codeExpiresAt === "number");
    await before.stop();
    const restarted = await start({ work: before.work });
    expect(((await restarted.request("/api/teams")).body.teams as Team[]).find(({ id }) => id === teamId)!.creation).toEqual({ status: "action", reason: "interrupted" });
    expect(restarted.auditEntries().filter(({ team, event }) => team === teamId && event === "team_application_qr_failed").map(({ by, reason, appId }) => [by, reason, appId]))
      .toEqual([["service", "interrupted", undefined]]);
  });

  // Step 6 (owner decision of 2026-11-11): the team's own application posts one message to each group it accepts work in, only
  // after the confirmation, and a failed or unknown send is not repeated.
  it("sends the test message only when confirmed, once to each group the team accepts work in, and records each result", async () => {
    const { request, auditEntries, teams } = await start();
    const sent: Array<Record<string, string>> = [];
    const answers: Record<string, "accepted" | "rejected" | "unknown" | Error> = { oc_alpha: "accepted", oc_beta: "rejected" };
    teams.deliverTestMessagesWith(async (message) => {
      sent.push({ ...message, operationId: message.operationId.replace(/[0-9a-f-]{36}$/, "<uuid>") });
      const answer = answers[message.chatId]!;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    expect(await request("/api/teams/test-message", { teamId: "bill" })).toEqual({ status: 400, body: { error: "发送测试消息前需要确认" } });
    expect(await request("/api/teams/test-message", { teamId: "bill", confirmed: "yes" })).toEqual({ status: 400, body: { error: "发送测试消息前需要确认" } });
    expect(sent).toEqual([]);
    const tests = async () => ((await request("/api/teams/test-message", { teamId: "bill", confirmed: true })).body.view.teams as Team[]).find(({ id }) => id === "bill")!.tests;
    expect(Object.fromEntries(Object.entries(await tests()).map(([chatId, { status }]) => [chatId, status]))).toEqual({ oc_alpha: "accepted", oc_beta: "failed" });
    const text = "这是 Bill（生活团队）的测试消息，用来确认可以在本群发言。";
    expect(sent).toEqual([{ teamId: "bill", appId: "cli_2222222222222222", chatId: "oc_alpha", text, operationId: "team-test-message:<uuid>" },
      { teamId: "bill", appId: "cli_2222222222222222", chatId: "oc_beta", text, operationId: "team-test-message:<uuid>" }]);
    // The owner sends again: the latest result of each group replaces the earlier one. A send that breaks off is unknown.
    answers.oc_alpha = new Error("socket hang up");
    answers.oc_beta = "unknown";
    expect(Object.fromEntries(Object.entries(await tests()).map(([chatId, { status }]) => [chatId, status]))).toEqual({ oc_alpha: "unknown", oc_beta: "unknown" });
    expect(sent).toHaveLength(4);
    expect(auditEntries().filter(({ event }) => event === "team_test_message_sent").map(({ by, team, appId, groups }) => [by, team, appId, groups])).toEqual([
      ["browser", "bill", "cli_2222222222222222", { oc_alpha: "accepted", oc_beta: "failed" }], ["browser", "bill", "cli_2222222222222222", { oc_alpha: "unknown", oc_beta: "unknown" }]]);
    // A team whose bot is in no group yet has nowhere to send it.
    const view = (await request("/api/teams")).body;
    const teamId = (await request("/api/teams/save", { basedOn: view.version, team: { ...daisy, groups: [] } })).body.teamId as string;
    expect(await request("/api/teams/test-message", { teamId, confirmed: true })).toEqual({ status: 400, body: { error: "机器人还没有加入所绑定的群" } });
  });
});

type Requester = Awaited<ReturnType<typeof start>>["request"];
/** Bill's team as the console saves it, unchanged. */
function unchangedBill(view: { teams: Array<Record<string, unknown>> }) {
  const bill = view.teams.find(({ id }) => id === "bill") as { teamName: string; responsibility: string; leader: unknown; bindings: Array<{ chatId: string }>;
    profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }> };
  return { id: "bill", teamName: bill.teamName, responsibility: bill.responsibility, leader: bill.leader, groups: bill.bindings.map(({ chatId }) => chatId),
    executorProfiles: bill.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools })) };
}
