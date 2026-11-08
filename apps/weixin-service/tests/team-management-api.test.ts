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

async function start() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "team-api-"));
  cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const state = path.join(work, "state");
  const home = path.join(work, "home");
  fs.mkdirSync(home);
  const audit = new ConsoleAudit({ directory: state });
  const access = new ConsoleAccess({ directory: state, audit });
  const catalog = new McpCatalog({ stateDirectory: state, homeDirectory: home, audit, retryMs: 60_000, refreshMs: 0 });
  cleanup.push(() => catalog.close());
  const registry = new TeamRegistry(path.join(state, "team-registry.sqlite"));
  const announcements = new TeamAnnouncements(path.join(state, "team-announcements.sqlite"));
  cleanup.push(() => { registry.close(); announcements.close(); });
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
    moduleScopes: () => [{ read: true, write: false }], activeAssignments: () => 0, rosterChanged: () => {}, report: () => {} });
  const server: Server = createChannelStatusServer(() => ({}), undefined, access, createConsoleRoutes({ catalog, teams }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
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
  const auditEntries = () => fs.readFileSync(path.join(state, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { request, bodies, auditEntries, state };
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
});
