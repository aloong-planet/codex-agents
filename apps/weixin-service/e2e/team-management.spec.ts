import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";

import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { test } from "./fixtures.js";

// 团队管理 (docs/specs/team-management.md) in a real browser, against the fixture service with Feishu dispatch and the fake
// onboarding platform. The rules are covered by tests/team-registry.test.ts and tests/team-onboarding.test.ts, the API by
// tests/team-management-api.test.ts and the running service by tests/team-management.integration.test.ts; these journeys
// check that the page, the API and the service are wired together.
// Not built in this ticket (decision D1), so not driven here: QR creation and the test message, MCP binding, and skills.
const SAM_APP = "cli_0123456789abcdef";
const SECRET_SENTINEL = "page-secret-SENTINEL-7d21";
const LONG = { timeout: 15_000 };
const owner = { memoryAccountId: "fixture-bot", bindings: [
  { channel: "weixin", accountId: "fixture-bot", target: "fixture-user@im.wechat", senderId: "fixture-user@im.wechat" },
  { channel: "feishu", accountId: SAM_APP, target: "oc_private", senderId: "ou_owner" },
] };
const feishu = { appId: SAM_APP, appSecret: "fixture-secret",
  groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }] };
const dispatchChannel = { channel: "feishu", owner, taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
  feishu: { ...feishu, dispatch: { groupChatIds: ["oc_alpha", "oc_beta"], agents: [{ id: "sam" },
    { id: "alice", appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "fixture-alice" }, { id: "bill", appId: "cli_bbbbbbbbbbbbbbbb", appSecret: "fixture-bill" },
    { id: "jack", appId: "cli_cccccccccccccccc", appSecret: "fixture-jack" }] } } };
const GROUP_NAMES = { chats: { oc_alpha: { name: "银河护卫队" }, oc_beta: { name: "产品讨论组" } } };

type Server = { url: string; cookie: string; directory: string };
async function post(server: Server, pathname: string, body: unknown) {
  const response = await fetch(`${server.url}${pathname}`, { method: "POST", headers: { cookie: server.cookie, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}
/** Sets the fake onboarding platform's answers, as Feishu would give them. A group's answers replace its whole entry, name included. */
const onboarding = (server: Server, control: unknown) => post(server, "/api/fixture/inbound", { onboardingControl: control });
const editor = (page: Page) => page.locator("[data-editor]");
/** A text field of the editor by its exact label; tip buttons also carry section names in their labels. */
const field = (page: Page, name: string) => editor(page).getByRole("textbox", { name, exact: true });
const listItem = (page: Page, title: string) => page.locator(".atm-list-item", { hasText: title });
const groupRow = (page: Page, name: string) => editor(page).locator(".atm-group-row", { hasText: name });

type Removal = { tasks: Array<{ id: string; name: string }> };
type TeamsView = { version: number; teams: Array<{ id: string; teamName: string; responsibility: string; leader: { name: string; appId: string; instructions: string };
  profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }>; bindings: Array<{ chatId: string; state: string; removal?: Removal }> }> };
type ServiceState = { agentDispatch?: { jobs: Array<{ id: string; status: string; assignments: Array<{ teamId: string; status: string }> }> }; fixtureModelRequests?: unknown[]; channels?: { feishu?: { ready?: boolean } };
  workflowModulePermissions?: { modules: Array<{ moduleId: string; revision: number; scopes: Array<{ scopeId: string }> }> } };
const read = async <T>(server: Server, pathname: string) => await (await fetch(`${server.url}${pathname}`, { headers: { cookie: server.cookie } })).json() as T;
const serviceState = (server: Server) => read<ServiceState>(server, "/api/state");
const jobStatuses = async (server: Server) => (await serviceState(server)).agentDispatch?.jobs.map(({ status }) => status);
/** The fixture Coordinator's decision to dispatch a request to `agentId`. */
const dispatchTo = (agentId: string, summary: string) => ({ kind: "dispatch", agentId, requestId: null, summary, message: "" });
/** A text message in 银河护卫队 with the fixture Coordinator's decision for it; `extra` adds fixture inputs for the turns it starts. */
const groupMessage = (server: Server, messageId: string, text: string, dispatchDecision: unknown, extra: Record<string, unknown> = {},
  from = { sender: "ou_owner", pathname: "/api/fixture/inbound" }) => post(server, from.pathname, {
  event: { app_id: SAM_APP, sender: { sender_type: "user", sender_id: { open_id: from.sender } },
    message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text }), mentions: [] } }, dispatchDecision, ...extra });
/** Saves a team bound to `groups` only, with everything else as the service has it, and returns the view after the save. */
async function bindTo(server: Server, teamId: string, groups: string[]) {
  const view = await read<TeamsView>(server, "/api/teams");
  const team = view.teams.find(({ id }) => id === teamId)!;
  const saved = await post(server, "/api/teams/save", { basedOn: view.version, team: { id: teamId, teamName: team.teamName, responsibility: team.responsibility, leader: team.leader, groups,
    executorProfiles: team.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools })) } });
  return saved.view as TeamsView;
}
/** Has Bill's Executor create a one-time scheduled task in 银河护卫队 that falls due a month from now, long after the case. */
async function scheduleAsBill(server: Server, messageId: string, name: string) {
  const text = `稍后在本群提醒，原文：${name}`;
  await groupMessage(server, messageId, text, dispatchTo("bill", name), { modelToolCalls: [{ namespace: "schedules", tool: "create",
    arguments: { name, instruction: name, reminderText: name, reminderMode: "verbatim", at: new Date(Date.now() + 30 * 86_400_000).toISOString(), sourceText: text } }] });
  await expect.poll(async () => (await jobStatuses(server))?.at(-1), LONG).toBe("completed");
}
/** Sends Bill a request whose Executor turn stays open until `release`, and returns once that turn has started. */
async function holdBill(server: Server, messageId: string) {
  const before = (await serviceState(server)).fixtureModelRequests?.length ?? 0;
  await groupMessage(server, messageId, "请帮我规划周末一日行程", dispatchTo("bill", "规划周末一日行程"), { modelHold: true });
  await expect.poll(async () => {
    const now = await serviceState(server);
    return [now.agentDispatch?.jobs.at(-1)?.status, (now.fixtureModelRequests?.length ?? 0) - before];
  }, LONG).toEqual(["running", 1]);
}
const release = (server: Server, messageId: string, pathname = "/api/fixture/inbound") => post(server, pathname, { modelControl: { messageId, action: "release" } });
const removalSteps = (page: Page) => editor(page).locator(".atm-removal-steps > li");
const ERROR_COLOUR = "rgb(178, 58, 49)";
const colour = (line: Locator) => line.evaluate((element) => getComputedStyle(element).color);

test.describe("with Feishu dispatch", () => {
  test.use({ fixtureStart: { channelConfiguration: dispatchChannel, env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify(GROUP_NAMES) } } });

  test("lists the teams under the 团队管理 entry, narrows them by search and group, and links to MCP 管理 and 团队总览", async ({ page, fixtureServer }, testInfo) => {
    // A team bound only to 产品讨论组, so that the group filter has something to leave out.
    const { version } = await (await fetch(`${fixtureServer.url}/api/teams`, { headers: { cookie: fixtureServer.cookie } })).json() as { version: number };
    await post(fixtureServer, "/api/teams/save", { basedOn: version, team: { teamName: "设计团队", responsibility: "视觉方案", groups: ["oc_beta"],
      leader: { name: "Daisy", appId: "cli_dddddddddddddddd", instructions: "" }, secret: "daisy-secret",
      executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: ["files.read"] }] } });
    await page.goto("/console/teams");
    await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("团队管理");
    const titles = page.locator(".atm-list-item strong");
    await expect(titles).toHaveText(["Sam · 总协调", "Alice · 运营团队", "Bill · 生活团队", "Jack · 技术团队", "Daisy · 设计团队"]);
    await expect(listItem(page, "Bill · 生活团队")).toContainText("正常接单");
    await expect(listItem(page, "Bill · 生活团队").locator(".atm-list-meta")).toHaveText("银河护卫队、产品讨论组 · 1 个能力档 · 0 项分工进行中");
    await expect(listItem(page, "Daisy · 设计团队").locator(".atm-list-meta")).toHaveText("产品讨论组 · 1 个能力档 · 0 项分工进行中");
    await testInfo.attach("team-list", { body: await page.screenshot(), contentType: "image/png" });

    await page.locator("#atm-search").fill("视觉");
    await expect(titles).toHaveText(["Daisy · 设计团队"]);
    await page.locator("#atm-search").fill("");
    await page.locator("#atm-filter").selectOption({ label: "银河护卫队" });
    await expect(titles).toHaveText(["Sam · 总协调", "Alice · 运营团队", "Bill · 生活团队", "Jack · 技术团队"]);

    await page.locator(".atm-heading-actions").getByRole("link", { name: "MCP 管理" }).click();
    await expect(page).toHaveURL(/\/console\/mcp$/);
    // team-management::US-001/AC-04: the page also leads back to the team overview.
    await page.goBack();
    await page.locator(".atm-heading-actions").getByRole("link", { name: "返回团队总览" }).click();
    await expect(page).toHaveURL(/\/console$/);
    await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("团队总览");
  });

  test("adds a team with an existing application, shows each group's onboarding, and lists the team once it joins", async ({ page, fixtureServer }, testInfo) => {
    await onboarding(fixtureServer, { chats: { oc_alpha: { ...GROUP_NAMES.chats.oc_alpha, add: "owner_only", inChat: false } } });
    await page.goto("/console/teams");
    await page.getByRole("button", { name: "新增团队" }).click();
    await expect(page.locator(".atm-list-item[aria-pressed=true] strong")).toHaveText("新团队 · 待命名");
    await field(page, "负责人名称").fill("Daisy");
    await field(page, "团队名称").fill("设计团队");
    await field(page, "App ID").fill("cli_dddddddddddddddd");
    await editor(page).getByRole("button", { name: "填写" }).click();
    await editor(page).getByLabel("App Secret", { exact: true }).fill(SECRET_SENTINEL);
    await field(page, "职责").fill("视觉方案");
    await groupRow(page, "银河护卫队").getByRole("checkbox").check();
    await expect(page.locator("#atm-savebar")).toHaveText(/有未保存的修改/);
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();

    await expect(page.locator("#atm-savebar")).toContainText("已保存：新事务使用新配置");
    await expect(page.locator(".atm-list-item[aria-pressed=true] strong")).toHaveText("Daisy · 设计团队");
    await expect(editor(page).locator(".acf-secret")).toHaveText(/已保存 · 不显示/);
    const steps = editor(page).locator(".atm-onboard > li");
    await expect(steps.nth(0)).toContainText("已完成", LONG);
    const alpha = steps.nth(1).locator(".atm-joins li", { hasText: "银河护卫队" });
    await expect(alpha).toContainText("银河护卫队只允许群主和管理员添加成员，Sam 无法拉入。", LONG);
    await expect(alpha).toContainText("需处理");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "blocked");
    await expect(editor(page).locator(".atm-roster-preview")).toContainText("银河护卫队：Sam 可分派给 Alice、Bill、Jack");
    await testInfo.attach("onboarding-needs-action", { body: await page.screenshot(), contentType: "image/png" });

    await onboarding(fixtureServer, { chats: { oc_alpha: { ...GROUP_NAMES.chats.oc_alpha, add: "added", inChat: true } } });
    await editor(page).getByRole("button", { name: "重新检查" }).click();
    await expect(alpha).toContainText("机器人已在群里。", LONG);
    await expect(editor(page).locator(".atm-roster-preview")).toContainText("银河护卫队：Sam 可分派给 Alice、Bill、Jack、Daisy");
    await expect(groupRow(page, "银河护卫队").locator(".atm-announce")).toHaveText(/Sam 的公告：「Daisy（设计团队）已加入本群，负责：视觉方案」 · 飞书已接收/, LONG);
    await expect(listItem(page, "Daisy · 设计团队")).toContainText("正常接单");
    expect(await page.content()).not.toContain(SECRET_SENTINEL);
    await testInfo.attach("onboarding-done", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("shows the save bar's states, refuses an invalid save with its reasons, and refuses a stale save until reloaded", async ({ page, fixtureServer }, testInfo) => {
    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    await expect(page.locator("#atm-savebar")).toHaveText(/保存后新事务立即使用新配置。/);
    // A second page edits Bill from the same version and saves after the first page.
    const other = await page.context().newPage();
    await other.goto(`${fixtureServer.url}/console/teams`);
    await listItem(other, "Bill · 生活团队").click();
    await field(other, "负责人提示词").fill("另一页的修改");

    await field(page, "职责").fill("日常生活事务和出行安排。");
    await expect(page.locator("#atm-savebar")).toHaveText(/有未保存的修改/);
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#atm-savebar")).toHaveText(/已保存：新事务使用新配置，进行中的事务保持原配置。/);

    await field(page, "团队名称").fill("");
    await editor(page).getByRole("button", { name: "删除能力档" }).click();
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".atm-save-err")).toHaveText(/无法保存\s*缺少团队名称\s*至少需要一个执行者能力档/);
    await testInfo.attach("save-refused", { body: await page.screenshot(), contentType: "image/png" });

    await editor(other).getByRole("button", { name: "保存", exact: true }).click();
    await expect(other.locator(".atm-save-err")).toContainText("这个团队已在其他页面保存过新版本；为避免覆盖，本次保存没有生效。");
    await testInfo.attach("save-stale", { body: await other.screenshot(), contentType: "image/png" });
    await editor(other).getByRole("button", { name: "重新载入" }).click();
    await expect(other.locator("#atm-savebar")).toHaveText(/已重新载入最新版本，请再修改。/);
    await expect(field(other, "职责")).toHaveValue("日常生活事务和出行安排。");
    await expect(field(other, "负责人提示词")).toHaveValue("");
  });

  test("shows Sam with its application, every step done and no actions, and saves only its responsibility and instructions", async ({ page }, testInfo) => {
    await page.goto("/console/teams");
    await listItem(page, "Sam · 总协调").click();
    await expect(editor(page).locator("h2")).toHaveText("Sam · 总协调");
    await expect(field(page, "App ID")).toHaveValue(SAM_APP);
    await expect(field(page, "App ID")).toBeDisabled();
    await expect(editor(page).locator(".acf-secret")).toHaveText("已保存 · 不显示");
    await expect(editor(page).locator(".acf-secret button")).toHaveCount(0);
    await expect(editor(page).locator(".atm-onboard > li > .acv2-badge")).toHaveText(["已完成", "已完成"]);
    await expect(editor(page).locator(".atm-joins li")).toHaveText([/银河护卫队.*已完成/, /产品讨论组.*已完成/]);
    await expect(editor(page).getByRole("button", { name: "重新检查" })).toHaveCount(0);
    await expect(editor(page)).toContainText("Sam 不执行具体事务，没有执行者能力档。");
    await expect(editor(page).locator("[data-group]")).toHaveCount(2);
    for (const box of await editor(page).locator("[data-group]").all()) {
      await expect(box).toBeChecked();
      await expect(box).toBeDisabled();
    }
    await testInfo.attach("coordinator", { body: await page.screenshot(), contentType: "image/png" });
    await field(page, "职责").fill("识别群消息意图，交给合适的负责人。");
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#atm-savebar")).toHaveText(/已保存/);
    await page.reload();
    await listItem(page, "Sam · 总协调").click();
    await expect(field(page, "职责")).toHaveValue("识别群消息意图，交给合适的负责人。");
  });

  test("marks checked tools that module permissions do not grant, shows the effective tools, and follows the executor noun", async ({ page, fixtureServer }, testInfo) => {
    // Module permissions grant reading and not writing.
    const permissions = new WorkflowModulePermissionStore(path.join(fixtureServer.directory, "workflow-module-permissions.sqlite"));
    try {
      permissions.save({ moduleId: "local-media", expectedRevision: permissions.get("local-media")?.revision ?? 0, confirmed: true,
        scopes: [{ scopeId: "downloads", label: "Downloads", directory: fixtureServer.businessDirectory, read: true, write: false }] });
    } finally { permissions.close(); }
    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    const profile = editor(page).locator(".atm-profile").first();
    const unauthorized = profile.locator(".acf-check", { has: page.locator(".atm-unauth") });
    // Bill's seeded profile checks every tool: writing is checked but not granted.
    await expect(unauthorized).toHaveText([/修改文件/, /新建或覆盖文件/]);
    const effective = profile.locator("[data-effective]");
    await expect(effective).toHaveText("实际可用：查找文件、搜索文件内容、读取文件、发送文件、发送图片、查看任务列表、查看任务详情、读取任务正文、创建任务、修改任务、启用任务、停用任务、立即执行、重试日报、删除任务"
      + "修改文件、新建或覆盖文件未获模块授权，勾选了也不会提供；在本机设置里开放模块授权后才可用。");
    await profile.getByRole("checkbox", { name: "新建或覆盖文件" }).uncheck();
    await expect(unauthorized).toHaveText([/修改文件/]);
    await expect(effective.locator("small")).toHaveText(/^修改文件未获模块授权/);

    await profile.getByLabel("能力档名称").fill("行程规划");
    await profile.getByLabel("执行者称呼").fill("行程执行者");
    await expect(profile.locator("[data-profile-title]")).toHaveText("行程规划");
    await expect(profile.locator(".atm-noun-hint")).toHaveText("群里称为「行程执行者 51」这样的称呼加编号");
    await testInfo.attach("profile-tools", { body: await page.screenshot(), contentType: "image/png" });
  });

  // team-management::US-004/AC-01, AC-05: with nothing to wait for, the removal completes with the save.
  test("removes an idle team from a group with the save: the page says it is unbound, Sam's departure notice stays and the preview drops it", async ({ page }, testInfo) => {
    await page.goto("/console/teams");
    await listItem(page, "Alice · 运营团队").click();
    // Imported from the local configuration, Alice takes work in both groups without recorded checks: both steps show done.
    await expect(editor(page).locator(".atm-onboard > li > .acv2-badge")).toHaveText(["已完成", "已完成"]);
    await expect(editor(page).locator(".atm-joins li")).toHaveText([/银河护卫队.*机器人已在群里。.*已完成/, /产品讨论组.*机器人已在群里。.*已完成/]);
    await groupRow(page, "产品讨论组").getByRole("checkbox").uncheck();
    await expect(groupRow(page, "产品讨论组")).toContainText("保存后移除");
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor(page).locator(".atm-done-note")).toHaveText("已从产品讨论组移除并解绑，历史记录保留。");
    await expect(editor(page).locator(".atm-removal")).toHaveCount(0);
    await expect(groupRow(page, "产品讨论组")).not.toContainText("移除");
    await expect(groupRow(page, "产品讨论组").getByRole("checkbox")).not.toBeChecked();
    await expect(groupRow(page, "产品讨论组").getByRole("checkbox")).toBeEnabled();
    await expect(groupRow(page, "产品讨论组").locator(".atm-announce"))
      .toHaveText(/Sam 的公告：「Alice（运营团队）已离开本群，不再接新的事务；进行中的事务会做完。」 · 飞书已接收/, LONG);
    await expect(editor(page).locator(".atm-roster-preview")).toContainText("产品讨论组：Sam 可分派给 Bill、Jack");
    await expect(listItem(page, "Alice · 运营团队").locator(".atm-list-meta")).toHaveText("银河护卫队 · 1 个能力档 · 0 项分工进行中");
    await editor(page).locator(".atm-done-note").scrollIntoViewIfNeeded();
    await testInfo.attach("group-removal-idle", { body: await page.screenshot(), contentType: "image/png" });
  });

  // team-management::US-004/AC-01..AC-03, AC-05, REQ-005: the four steps follow the service, a scheduled task is handed to a team
  // that takes work in that group, and the removal completes by itself when the Assignment ends.
  test("shows a removal's four steps, moves the team's scheduled task to a team taking work in that group, and unbinds once the Assignment ends", async ({ page, fixtureServer }, testInfo) => {
    await scheduleAsBill(fixtureServer, "om_removal_task", "带伞提醒");
    await holdBill(fixtureServer, "om_removal_held");
    // Jack keeps taking work in 产品讨论组 only, so it must not be offered a task of 银河护卫队.
    await bindTo(fixtureServer, "jack", ["oc_beta"]);
    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    await groupRow(page, "银河护卫队").getByRole("checkbox").uncheck();
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(groupRow(page, "银河护卫队")).toContainText("移除中 · 停止接单");
    await expect(groupRow(page, "银河护卫队").getByRole("checkbox")).toBeDisabled();
    await expect(groupRow(page, "产品讨论组").getByRole("checkbox")).toBeChecked();
    await expect(editor(page).locator(".atm-removal-h")).toHaveText("银河护卫队 · 移除进行中");
    await expect(removalSteps(page)).toHaveText([
      "停止接单Sam 已不再分派给 Bill，并在银河护卫队公告它离开；各负责人的团队通讯录已更新。已完成",
      "进行中的分工 · 1 项做完后由 Bill 在群里收尾。等待中",
      /^用 Bill 身份发送的定时任务 · 1 项每项转给银河护卫队里其他接单的团队，或删除，才能完成移除。转给后只换发送身份，计划和内容不变。需处理带伞提醒\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 用 Bill 的身份发送/,
      "等待发起人确认的事务 · 0 项已全部结束。已完成"]);
    await expect(editor(page).locator(".atm-removal-note")).toHaveText("以上都结束后自动从银河护卫队解绑，历史记录保留。");
    const move = editor(page).getByRole("combobox", { name: "把「带伞提醒」转给其他团队" });
    await expect(move.locator("option")).toHaveText(["转给…", "Alice · 运营团队"]);
    await testInfo.attach("removal-steps", { body: await page.screenshot(), contentType: "image/png" });

    await move.selectOption({ label: "Alice · 运营团队" });
    await expect(editor(page).locator(".atm-done-note")).toHaveText("已把「带伞提醒」转给 Alice：之后用 Alice 的身份发送，计划和内容不变。");
    await expect(removalSteps(page).nth(2)).toHaveText("用 Bill 身份发送的定时任务 · 0 项已全部处理。已完成");
    await expect(removalSteps(page).nth(1)).toHaveText("进行中的分工 · 1 项做完后由 Bill 在群里收尾。等待中");
    // Handing a task over is done at once; it is not an edit waiting for a save.
    await expect(page.locator("#atm-savebar")).not.toContainText("有未保存的修改");
    await editor(page).locator(".atm-removal-note").scrollIntoViewIfNeeded();
    await testInfo.attach("removal-task-moved", { body: await page.screenshot(), contentType: "image/png" });

    await release(fixtureServer, "om_removal_held");
    await expect(editor(page).locator(".atm-done-note")).toHaveText("已从银河护卫队移除并解绑，历史记录保留。", LONG);
    await expect(editor(page).locator(".atm-removal")).toHaveCount(0);
    await expect(groupRow(page, "银河护卫队").getByRole("checkbox")).toBeEnabled();
    await expect(groupRow(page, "银河护卫队").getByRole("checkbox")).not.toBeChecked();
    await editor(page).locator(".atm-done-note").scrollIntoViewIfNeeded();
    await testInfo.attach("removal-complete", { body: await page.screenshot(), contentType: "image/png" });
  });

  // The page shows a view up to one poll old. Each refusal here is of an action taken on such a view after the service moved on:
  // the page's reads of the team view are answered with the view it already has, and the changes go to the service directly.
  test("says in one error line what a refused task move, task deletion or team deletion did not do", async ({ page, fixtureServer }, testInfo) => {
    await scheduleAsBill(fixtureServer, "om_refused_task", "带伞提醒");
    const draining = await bindTo(fixtureServer, "bill", ["oc_beta"]);
    const task = draining.teams.find(({ id }) => id === "bill")!.bindings.find(({ chatId }) => chatId === "oc_alpha")!.removal!.tasks[0]!;
    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    const move = editor(page).getByRole("combobox", { name: "把「带伞提醒」转给其他团队" });
    await expect(move).toBeVisible();
    const shown = await (await fetch(`${fixtureServer.url}/api/teams`, { headers: { cookie: fixtureServer.cookie } })).text();
    await page.route("**/api/teams", (route) => route.request().method() === "GET" ? route.fulfill({ contentType: "application/json", body: shown }) : route.fallback());

    await bindTo(fixtureServer, "alice", ["oc_beta"]);
    await move.selectOption({ label: "Alice · 运营团队" });
    const line = editor(page).locator(".atm-removal .atm-action-err");
    await expect(line).toHaveText("没有转交「带伞提醒」：Alice 已不在该群接单，请重新选择。");
    expect(await colour(line)).toBe(ERROR_COLOUR);
    await expect(editor(page).locator(".atm-done-note")).toHaveCount(0);
    await editor(page).locator(".atm-removal-note").scrollIntoViewIfNeeded();
    await testInfo.attach("removal-move-refused", { body: await page.screenshot(), contentType: "image/png" });

    await post(fixtureServer, "/api/teams/tasks/delete", { teamId: "bill", taskId: task.id });
    await editor(page).locator(".atm-removal-items").getByRole("button", { name: "删除", exact: true }).click();
    await expect(editor(page).locator(".atm-removal-items .acf-inline-confirm")).toContainText("删除后不再执行，已有的执行记录保留。");
    await editor(page).locator(".atm-removal-items").getByRole("button", { name: "确认删除" }).click();
    await expect(line).toHaveText("没有删除「带伞提醒」：这项定时任务已不存在，请刷新页面。");

    await post(fixtureServer, "/api/teams/delete", { teamId: "jack" });
    await listItem(page, "Jack · 技术团队").click();
    await editor(page).getByRole("button", { name: "删除团队" }).click();
    await editor(page).locator(".acf-danger").getByRole("button", { name: "确认删除" }).click();
    const refused = editor(page).locator(".acf-danger .atm-action-err");
    await expect(refused).toHaveText("没有开始删除：这个团队已不存在，请刷新页面。");
    expect(await colour(refused)).toBe(ERROR_COLOUR);
    await expect(editor(page).getByRole("button", { name: "删除团队" })).toBeVisible();
    await refused.scrollIntoViewIfNeeded();
    await testInfo.attach("deletion-refused", { body: await page.screenshot(), contentType: "image/png" });
  });

  // team-management::US-004/AC-01, REQ-001/AC-02, agent-console::US-003/AC-02.
  test("deletes a team: it stops taking work and is marked 删除中 on the overview until its Assignment ends, and an idle team is deleted at once", async ({ page, fixtureServer }, testInfo) => {
    await holdBill(fixtureServer, "om_delete_held");
    await page.goto("/console/teams");
    await expect(page.locator("#atm-count")).toHaveText("4 个");
    await listItem(page, "Bill · 生活团队").click();
    const danger = editor(page).locator(".acf-danger");
    await expect(danger).toContainText("删除后先停止接单，进行中的分工做完再移除。");
    await danger.getByRole("button", { name: "删除团队" }).click();
    await expect(danger.locator(".acf-inline-confirm")).toContainText("删除后 Sam 立即停止分派给 Bill；进行中的 1 项分工做完后从所有群移除，并在群里公告。用它身份发送的定时任务要先转给其他团队或删除。历史记录保留。");
    await testInfo.attach("deletion-confirm", { body: await page.screenshot(), contentType: "image/png" });
    await danger.getByRole("button", { name: "确认删除" }).click();
    await expect(listItem(page, "Bill · 生活团队")).toContainText("停止接单 · 做完后移除");
    await expect(danger.locator(".atm-deleting-note")).toHaveText("已停止接单：Sam 不再分派给 Bill。下面各群的阻塞都处理完后，团队才会被移除。");
    // 产品讨论组 had nothing to wait for, so only 银河护卫队 still has a removal in progress.
    await expect(danger.locator(".atm-removal-h")).toHaveText(["银河护卫队 · 移除进行中"]);
    await expect(removalSteps(page).nth(1)).toHaveText("进行中的分工 · 1 项做完后由 Bill 在群里收尾。等待中");
    await expect(danger.getByRole("button", { name: "删除团队" })).toHaveCount(0);
    for (const box of await editor(page).locator("[data-group]").all()) await expect(box).toBeDisabled();
    await expect(groupRow(page, "银河护卫队").locator(".atm-announce"))
      .toHaveText(/Sam 的公告：「Bill（生活团队）已离开本群，不再接新的事务；进行中的事务会做完。」 · 飞书已接收/, LONG);
    await testInfo.attach("deletion-in-progress", { body: await page.screenshot(), contentType: "image/png" });

    const overview = await page.context().newPage();
    await overview.goto(`${fixtureServer.url}/console`);
    const card = (name: string) => overview.locator(".ats-card", { has: overview.locator(".ats-name strong", { hasText: new RegExp(`^${name}$`) }) });
    await expect(card("Bill").locator(".ats-card-head .acv2-badge")).toHaveText("删除中");
    await expect(card("Alice")).toBeVisible();
    await expect(card("Alice").locator(".ats-card-head .acv2-badge")).toHaveCount(0);
    await testInfo.attach("overview-deleting", { body: await overview.screenshot(), contentType: "image/png" });
    await overview.close();

    await release(fixtureServer, "om_delete_held");
    const titles = page.locator(".atm-list-item strong");
    await expect(titles).toHaveText(["Sam · 总协调", "Alice · 运营团队", "Jack · 技术团队"], LONG);
    await expect(page.locator("#atm-count")).toHaveText("3 个");
    await expect(danger.locator(".atm-done-note")).toHaveText("删除完成：Bill 已从所有群移除，Sam 不再分派给它；历史记录保留。");
    await expect(editor(page).locator(".atm-editor-title")).toContainText("已删除 · 历史保留");
    await expect(editor(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await danger.locator(".atm-done-note").scrollIntoViewIfNeeded();
    await testInfo.attach("deletion-complete", { body: await page.screenshot(), contentType: "image/png" });

    await listItem(page, "Alice · 运营团队").click();
    await danger.getByRole("button", { name: "删除团队" }).click();
    await expect(danger.locator(".acf-inline-confirm")).toContainText("删除后 Sam 立即停止分派给 Alice；没有进行中的分工，从所有群移除，并在群里公告。");
    await danger.getByRole("button", { name: "确认删除" }).click();
    await expect(danger.locator(".atm-done-note")).toHaveText("删除完成：Alice 已从所有群移除，Sam 不再分派给它；历史记录保留。");
    await expect(titles).toHaveText(["Sam · 总协调", "Jack · 技术团队"]);
  });
});

// A request waits for its requester only after an Executor asked them to choose, which the fixture Executor does with the file
// tools: those need both channels running and the notes module granted.
test.describe("with Feishu dispatch beside WeChat", () => {
  test.use({ fixtureStart: { channelConfiguration: { owner, taskScope: dispatchChannel.taskScope, enabledChannels: ["weixin", "feishu"],
    feishu: { ...dispatchChannel.feishu, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner", "ou_colleague"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }] } },
  env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify(GROUP_NAMES) } } });

  const asOwner = { sender: "ou_owner", pathname: "/api/fixture/feishu/inbound" }, asMember = { sender: "ou_colleague", pathname: "/api/fixture/feishu/inbound" };
  /** An Executor turn that finds two notes and asks its requester to choose, which leaves its Assignment waiting. */
  const choose = { modelToolCalls: [
    { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
    { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
      candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } }] };
  /** Grants the notes module, which the choice above reads. */
  async function grantNotes(server: Server) {
    await expect.poll(async () => (await serviceState(server)).channels?.feishu?.ready, LONG).toBe(true);
    const notes = (await serviceState(server)).workflowModulePermissions!.modules.find(({ moduleId }) => moduleId === "notes")!;
    await post(server, "/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map(({ scopeId }) => ({ scopeId, read: true, write: true })) });
  }
  const assignmentStatuses = async (server: Server) => (await serviceState(server)).agentDispatch?.jobs.map(({ assignments }) => assignments.map(({ teamId, status }) => `${teamId}:${status}`).join(","));

  // team-management::US-004/AC-02, AC-04.
  test("counts a removal's waiting Assignments with the ones in progress, lists their requests with their requesters without a way to answer for them, and drops one when its requester cancels", async ({ page, fixtureServer }, testInfo) => {
    await grantNotes(fixtureServer);
    await groupMessage(fixtureServer, "om_owner_choice", "列出 Agent 笔记让我选发哪个", dispatchTo("alice", "选择并发送运营笔记"), choose, asOwner);
    await expect.poll(() => jobStatuses(fixtureServer), LONG).toEqual(["waiting"]);
    await groupMessage(fixtureServer, "om_member_choice", "也列出 Agent 笔记让我选", dispatchTo("alice", "为同事选择运营笔记"), choose, asMember);
    await expect.poll(() => jobStatuses(fixtureServer), LONG).toEqual(["waiting", "waiting"]);
    await groupMessage(fixtureServer, "om_owner_held", "整理本周运营数据", dispatchTo("alice", "整理本周运营数据"), { modelHold: true }, asOwner);
    await expect.poll(() => assignmentStatuses(fixtureServer), LONG).toEqual(["alice:waiting", "alice:waiting", "alice:running"]);
    const [mine, theirs] = (await serviceState(fixtureServer)).agentDispatch!.jobs;

    // One running and two waiting: the list row, the deletion confirmation and the removal's second step all count three.
    await page.goto("/console/teams");
    const row = listItem(page, "Alice · 运营团队").locator(".atm-list-meta"), danger = editor(page).locator(".acf-danger");
    await listItem(page, "Alice · 运营团队").click();
    await expect(row).toContainText(" · 3 项分工进行中");
    await danger.getByRole("button", { name: "删除团队" }).click();
    await expect(danger.locator(".acf-inline-confirm")).toContainText("进行中的 3 项分工做完后从所有群移除");
    await danger.getByRole("button", { name: "取消", exact: true }).click();
    await groupRow(page, "银河护卫队").getByRole("checkbox").uncheck();
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(removalSteps(page).nth(1)).toHaveText("进行中的分工 · 3 项做完后由 Alice 在群里收尾。其中 2 项在等发起人回复，见第 4 步。等待中");
    const waiting = removalSteps(page).nth(3);
    await expect(waiting).toContainText("等待发起人确认的事务 · 2 项只有发起人能确认或取消；本人发起的请在群里回复，其他成员的等他们回复。等待中");
    await expect(waiting.locator(".atm-removal-items > li")).toHaveText([
      `${mine!.id.slice(0, 8)} 选择并发送运营笔记发起人：本人 · 选择并发送运营笔记`, `${theirs!.id.slice(0, 8)} 为同事选择运营笔记发起人：群成员 · 为同事选择运营笔记`]);
    expect(await waiting.locator(".atm-removal-items a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))))
      .toEqual([`/console?request=${mine!.id}`, `/console?request=${theirs!.id}`]);
    await expect(waiting.locator("button, select, input")).toHaveCount(0);
    await editor(page).locator(".atm-removal-note").scrollIntoViewIfNeeded();
    await testInfo.attach("removal-running-and-waiting", { body: await page.screenshot(), contentType: "image/png" });

    // Only the two waiting ones are left: all three still say the same number, and the step points at the fourth.
    await release(fixtureServer, "om_owner_held", asOwner.pathname);
    await expect(removalSteps(page).nth(1)).toHaveText("进行中的分工 · 2 项其中 2 项在等发起人回复，见第 4 步。等待中", LONG);
    await expect(row).toContainText(" · 2 项分工进行中");
    await danger.getByRole("button", { name: "删除团队" }).click();
    await expect(danger.locator(".acf-inline-confirm")).toContainText("进行中的 2 项分工做完后从所有群移除");
    await danger.getByRole("button", { name: "取消", exact: true }).click();
    await editor(page).locator(".atm-removal-note").scrollIntoViewIfNeeded();
    await testInfo.attach("removal-waiting", { body: await page.screenshot(), contentType: "image/png" });

    await groupMessage(fixtureServer, "om_owner_cancel", "取消", { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" }, {}, asOwner);
    await expect(waiting.locator(".atm-removal-items > li")).toHaveText([`${theirs!.id.slice(0, 8)} 为同事选择运营笔记发起人：群成员 · 为同事选择运营笔记`], LONG);
    await expect(removalSteps(page).nth(1)).toHaveText("进行中的分工 · 1 项其中 1 项在等发起人回复，见第 4 步。等待中");
    await expect(groupRow(page, "银河护卫队")).toContainText("移除中 · 停止接单");
  });

  // team-management::US-004/AC-02, AC-04: the second step counts only the leaving team's own Assignments.
  test("counts no Assignment for a leaving team whose request waits with another team's Assignment only, and still lists that request", async ({ page, fixtureServer }, testInfo) => {
    await grantNotes(fixtureServer);
    await groupMessage(fixtureServer, "om_cross_choice", "规划周末行程，再请运营选一篇笔记发我", dispatchTo("bill", "规划行程并发送笔记"), {
      leaderPlan: { assignments: [{ profileId: "executor-1", title: "规划周末行程", brief: "一日行程" }], decisions: [], help: [{ title: "选择并发送笔记", brief: "列出 Agent 笔记供选择" }] },
      crossTeamDecision: { assignments: [{ part: 1, agentId: "alice", summary: "选择并发送笔记" }] },
      teamTurns: { alice: { leaderPlan: { assignments: [{ profileId: "executor-1", title: "选择运营笔记", brief: "列出 Agent 笔记供选择" }], decisions: [], help: [] } } },
      executorTurns: { 选择运营笔记: choose } }, asOwner);
    await expect.poll(() => assignmentStatuses(fixtureServer), LONG).toEqual(["bill:completed,alice:waiting"]);
    const [request] = (await serviceState(fixtureServer)).agentDispatch!.jobs;

    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    await groupRow(page, "银河护卫队").getByRole("checkbox").uncheck();
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(removalSteps(page).nth(1)).toHaveText("进行中的分工 · 0 项已全部结束。已完成");
    await expect(removalSteps(page).nth(3).locator(".atm-removal-items > li")).toHaveText([`${request!.id.slice(0, 8)} 规划行程并发送笔记发起人：本人 · 选择运营笔记`]);
    await expect(listItem(page, "Bill · 生活团队").locator(".atm-list-meta")).toContainText(" · 0 项分工进行中");
    await expect(listItem(page, "Alice · 运营团队").locator(".atm-list-meta")).toContainText(" · 1 项分工进行中");
    await editor(page).locator(".atm-removal-note").scrollIntoViewIfNeeded();
    await testInfo.attach("removal-waits-with-another-team", { body: await page.screenshot(), contentType: "image/png" });
  });
});

// The dispatch-group form (agent-console::US-009). The file write and its refusals are covered by
// tests/dispatch-group-settings.test.ts and the restart by tests/team-management.integration.test.ts; these journeys check the page.
// Coverage gap: the page's request states are driven for proposed and running only. Holding a request queued or waiting needs a
// queue behind it or an Executor's pending choice, which that journey's fixture does not give; the module test covers all four states.
const channelFile = (server: Server) => path.join(server.directory, "channel.json");
const readChannel = (server: Server) => JSON.parse(readFileSync(channelFile(server), "utf8")) as { feishu: { dispatch?: { groupChatIds: string[] } } };
const dcGroup = (scope: Page | Locator, name: string) => scope.locator(".atm-dc-group", { hasText: name }).getByRole("checkbox");

test.describe("with Feishu paired and dispatch not enabled", () => {
  test.use({ fixtureStart: { channelConfiguration: { channel: "feishu", owner, taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" }, feishu },
    env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify(GROUP_NAMES) } } });

  test("shows the dispatch-group form in the 未配置 panel, and a save waits for a restart", async ({ page, fixtureServer }, testInfo) => {
    await page.goto("/console/teams");
    await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("团队管理");
    await expect(page.locator(".acv2-empty strong")).toHaveText("尚未配置派单群");
    await expect(page.locator(".atm-dc-group")).toHaveText(["银河护卫队oc_alpha", "产品讨论组oc_beta"]);
    await expect(page.getByRole("button", { name: "新增团队" })).toBeHidden();
    await expect(page.getByRole("button", { name: "派单群设置" })).toBeHidden();
    await expect(page.locator(".acf-savebar")).toHaveText("保存后重启服务才生效。保存");
    await dcGroup(page, "银河护卫队").check();
    await expect(page.locator(".acf-savebar")).toContainText("有未保存的修改");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".acf-savebar")).toContainText("已保存，重启服务后生效");
    await expect(page.locator(".atm-dc-compare")).toHaveText("运行中的服务未启用派单已保存，重启后银河护卫队");
    expect(readChannel(fixtureServer).feishu.dispatch).toEqual({ groupChatIds: ["oc_alpha"] });
    await testInfo.attach("dispatch-groups-unconfigured-saved", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("refuses a save while the pairing lock exists, and after the file changed, until it is reloaded", async ({ page, fixtureServer }, testInfo) => {
    await page.goto("/console/teams");
    await dcGroup(page, "银河护卫队").check();
    writeFileSync(`${channelFile(fixtureServer)}.pairing-lock`, "", { mode: 0o600 });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".atm-save-err")).toHaveText(`无法保存飞书配对向导正在使用渠道配置，暂时不能保存；配对结束后再保存。如果没有配对命令在运行，这个锁文件可能是配对中途退出留下的：${channelFile(fixtureServer)}.pairing-lock确认没有配对命令运行后删除它，再保存。`);
    await testInfo.attach("dispatch-groups-locked", { body: await page.screenshot(), contentType: "image/png" });
    rmSync(`${channelFile(fixtureServer)}.pairing-lock`);
    const edited = readChannel(fixtureServer);
    writeFileSync(channelFile(fixtureServer), JSON.stringify({ ...edited, feishu: { ...edited.feishu, dispatch: { groupChatIds: ["oc_beta"] } } }, null, 2));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".atm-save-err")).toHaveText("无法保存渠道配置文件在页面载入后被修改过；为避免覆盖，本次保存没有生效。");
    await page.getByRole("button", { name: "重新载入" }).click();
    await expect(page.locator(".acf-savebar")).toContainText("已重新载入最新的配置，请再修改。");
    await expect(dcGroup(page, "产品讨论组")).toBeChecked();
    await expect(dcGroup(page, "银河护卫队")).not.toBeChecked();
    expect(readChannel(fixtureServer).feishu.dispatch).toEqual({ groupChatIds: ["oc_beta"] });
  });
});

test.describe("with Feishu dispatch, choosing its groups", () => {
  test.use({ fixtureStart: { channelConfiguration: dispatchChannel, env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify(GROUP_NAMES) } } });

  test("opens the form in the 派单群设置 drawer, saves no group, refuses to uncheck a group with an unfinished request, and keeps a strip until the restart", async ({ page, fixtureServer }, testInfo) => {
    await page.goto("/console/teams");
    await expect(page.getByRole("button", { name: "派单群设置" })).toBeVisible();
    await expect(page.locator("#atm-dc-pending")).toBeHidden();
    await page.getByRole("button", { name: "派单群设置" }).click();
    const drawer = page.locator("#atm-dc-drawer");
    await expect(drawer).toBeVisible();
    await expect(dcGroup(drawer, "银河护卫队")).toBeChecked();
    await expect(dcGroup(drawer, "产品讨论组")).toBeChecked();
    // No group checked turns dispatch off at the restart.
    await dcGroup(drawer, "银河护卫队").uncheck();
    await dcGroup(drawer, "产品讨论组").uncheck();
    await drawer.getByRole("button", { name: "保存", exact: true }).click();
    await expect(drawer.locator(".atm-dc-compare")).toHaveText("运行中的服务银河护卫队、产品讨论组已保存，重启后不启用派单");
    expect(readChannel(fixtureServer).feishu.dispatch).toBeUndefined();
    // Then a proposal waits for its author in 银河护卫队, and a second request runs there, held at its start message, so that group
    // cannot stay unchecked. The running request's summary carries markup, which the page must show as text.
    await groupMessage(fixtureServer, "om_dc_proposal", "周末可能想去附近玩玩", { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" });
    await post(fixtureServer, "/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["held"] } });
    await groupMessage(fixtureServer, "om_dc_running", "帮我核对预算和行程", dispatchTo("bill", "核对 <b>预算</b> & 行程"));
    await expect.poll(() => jobStatuses(fixtureServer), LONG).toEqual(["proposed", "running"]);
    await drawer.getByRole("button", { name: "保存", exact: true }).click();
    await expect(drawer.locator(".atm-save-err")).toHaveText("无法保存银河护卫队还有 2 项未结束的派单事务，结束后才能取消勾选：安排周末出行等待发起人确认核对 <b>预算</b> & 行程处理中");
    await expect(drawer.locator(".atm-dc-busy b")).toHaveCount(0);
    await testInfo.attach("dispatch-groups-unfinished", { body: await page.screenshot(), contentType: "image/png" });
    // Each unfinished request links to its record on the team overview, which opens it expanded (ticket 10).
    const proposal = drawer.locator(".atm-dc-busy a", { hasText: "安排周末出行" });
    const overview = await page.context().newPage();
    await overview.goto((await proposal.getAttribute("href"))!);
    await expect(overview.locator("#ats-drawer .acv2-record-button")).toHaveAttribute("aria-expanded", "true");
    await expect(overview.locator("#ats-drawer .acv4-detail-title")).toHaveText("安排周末出行");
    await expect(overview.locator(".ats-chip[aria-pressed=true]")).toHaveText("银河护卫队 · 群协作");
    await overview.close();
    await dcGroup(drawer, "银河护卫队").check();
    await drawer.getByRole("button", { name: "保存", exact: true }).click();
    await expect(drawer.locator(".acf-savebar")).toContainText("已保存，重启服务后生效");
    await expect(drawer.locator(".atm-dc-compare")).toHaveText("运行中的服务银河护卫队、产品讨论组已保存，重启后银河护卫队");
    expect(readChannel(fixtureServer).feishu.dispatch?.groupChatIds).toEqual(["oc_alpha"]);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.locator("#atm-dc-pending")).toHaveText("派单群设置已保存，重启服务后生效。查看派单群设置");
    await testInfo.attach("dispatch-groups-strip", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "查看派单群设置" }).click();
    await expect(drawer).toBeVisible();
    await expect(dcGroup(drawer, "产品讨论组")).not.toBeChecked();
  });
});

test.describe("without Feishu paired", () => {
  test("keeps the 团队管理 entry and shows only how to pair Feishu, with no group list", async ({ page }, testInfo) => {
    await page.goto("/console/teams");
    await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("团队管理");
    await expect(page.locator(".acv2-empty strong")).toHaveText("尚未配置派单群");
    await expect(page.locator(".atm-empty-body")).toHaveText("飞书尚未接入本机服务：请先停止服务，在终端运行 pnpm feishu:pair 完成飞书配对，再回到这里选择派单群。");
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新增团队" })).toBeHidden();
    await testInfo.attach("no-feishu", { body: await page.screenshot(), contentType: "image/png" });
  });
});
