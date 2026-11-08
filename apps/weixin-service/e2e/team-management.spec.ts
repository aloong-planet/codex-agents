import path from "node:path";

import { expect, type Page } from "@playwright/test";

import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { test } from "./fixtures.js";

// 团队管理 (docs/specs/team-management.md) in a real browser, against the fixture service with Feishu dispatch and the fake
// onboarding platform. The rules are covered by tests/team-registry.test.ts and tests/team-onboarding.test.ts, the API by
// tests/team-management-api.test.ts and the running service by tests/team-management.integration.test.ts; these journeys
// check that the page, the API and the service are wired together.
// Not built in this ticket (decision D1), so not driven here: QR creation and the test message, MCP binding, skills, and team
// deletion with its removal panel.
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

test.describe("with Feishu dispatch", () => {
  test.use({ fixtureStart: { channelConfiguration: dispatchChannel, env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify(GROUP_NAMES) } } });

  test("lists the teams under the 团队管理 entry, narrows them by search and group, and links to MCP 管理", async ({ page, fixtureServer }, testInfo) => {
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

  test("removes a team from a group where it takes work: it stops at once, Sam announces the departure and the preview drops it", async ({ page }, testInfo) => {
    await page.goto("/console/teams");
    await listItem(page, "Alice · 运营团队").click();
    // Imported from the local configuration, Alice takes work in both groups without recorded checks: both steps show done.
    await expect(editor(page).locator(".atm-onboard > li > .acv2-badge")).toHaveText(["已完成", "已完成"]);
    await expect(editor(page).locator(".atm-joins li")).toHaveText([/银河护卫队.*机器人已在群里。.*已完成/, /产品讨论组.*机器人已在群里。.*已完成/]);
    await groupRow(page, "产品讨论组").getByRole("checkbox").uncheck();
    await expect(groupRow(page, "产品讨论组")).toContainText("保存后移除");
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(groupRow(page, "产品讨论组")).toContainText("移除中 · 停止接单");
    await expect(groupRow(page, "产品讨论组").getByRole("checkbox")).toBeDisabled();
    await expect(groupRow(page, "产品讨论组").locator(".atm-announce"))
      .toHaveText(/Sam 的公告：「Alice（运营团队）已离开本群，不再接新的事务；进行中的事务会做完。」 · 飞书已接收/, LONG);
    await expect(editor(page).locator(".atm-roster-preview")).toContainText("产品讨论组：Sam 可分派给 Bill、Jack");
    await testInfo.attach("group-removal", { body: await page.screenshot(), contentType: "image/png" });
  });
});

for (const [name, channelConfiguration, body] of [
  ["Feishu paired, dispatch not enabled", { channel: "feishu", owner, taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" }, feishu },
    (directory: string) => `飞书派单目前在本机渠道配置文件中启用：在 ${path.join(directory, "channel.json")} 的 feishu 中加入 dispatch，然后重启服务。详细步骤见运维文档《Feishu agent dispatch》。`],
  ["Feishu not paired", undefined,
    () => "飞书尚未接入本机服务：请先停止服务，在终端运行 pnpm feishu:pair 完成飞书配对，再在渠道配置文件的 feishu 中加入 dispatch。"],
] as const) {
  test.describe(`without Feishu dispatch (${name})`, () => {
    test.use({ fixtureStart: channelConfiguration ? { channelConfiguration } : {} });

    test("keeps the 团队管理 entry and shows only where dispatch is enabled", async ({ page, fixtureServer }, testInfo) => {
      await page.goto("/console/teams");
      await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("团队管理");
      await expect(page.locator(".acv2-empty strong")).toHaveText("尚未配置派单群");
      await expect(page.locator(".atm-empty-body")).toHaveText(body(fixtureServer.directory));
      await expect(page.getByRole("button", { name: "新增团队" })).toBeHidden();
      await expect(page.locator(".atm-list-item")).toHaveCount(0);
      await testInfo.attach("no-dispatch", { body: await page.screenshot(), contentType: "image/png" });
    });
  });
}
