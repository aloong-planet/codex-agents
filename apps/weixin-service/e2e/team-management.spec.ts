import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { test } from "./fixtures.js";

// 团队管理 (docs/specs/team-management.md) in a real browser, against the fixture service with Feishu dispatch and the fake
// onboarding platform. The rules are covered by tests/team-registry.test.ts and tests/team-onboarding.test.ts, the API by
// tests/team-management-api.test.ts and the running service by tests/team-management.integration.test.ts; these journeys
// check that the page, the API and the service are wired together.
// QR creation runs against the fake platform, whose scan the journeys end through the fixture route: no Feishu tenant is called,
// and whether Feishu accepts the automatic configuration and release of a QR-created application stays live acceptance.
// Not built yet (decision D1), so not driven here: MCP binding, skills, and team deletion with its removal panel.
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
    // A new team starts in QR creation; this one enters an existing application, whose progress starts at the credential check.
    await editor(page).getByRole("button", { name: "已有应用，手动填写" }).click();
    await expect(editor(page).locator(".atm-onboard > li > div")).toHaveText([/^校验凭证并读取机器人信息/, /^加入所绑定的群/, /^发送测试消息/]);
    await field(page, "App ID").fill("cli_dddddddddddddddd");
    await editor(page).getByRole("button", { name: "填写", exact: true }).click();
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
    await expect(editor(page).locator(".atm-mode")).toHaveText("接入方式：已有应用，手动填写");
    await expect(editor(page).locator(".atm-onboard > li > .acv2-badge")).toHaveText(["已完成", "已完成", "已完成"]);
    await expect(editor(page).locator(".atm-joins li")).toHaveText([/银河护卫队.*已完成/, /产品讨论组.*已完成/]);
    await expect(editor(page).locator("[data-onboarding] button")).toHaveCount(0);
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
    // Imported from the local configuration, Alice takes work in both groups without recorded checks: both steps show done, and
    // no test message was sent yet.
    await expect(editor(page).locator(".atm-onboard > li > .acv2-badge")).toHaveText(["已完成", "已完成", "未开始"]);
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

  // QR creation (team-management::US-002/AC-01, AC-03, AC-04). The fake platform creates cli_c0de000000000001 when its scan is confirmed.
  const CREATED_APP = "cli_c0de000000000001";
  const steps = (page: Page) => editor(page).locator(".atm-onboard > li");
  const badges = (page: Page) => editor(page).locator(".atm-onboard > li > .acv2-badge");
  const qr = (page: Page) => editor(page).locator(".atm-qr");
  /** Saves a new team in QR creation, bound to 银河护卫队, and waits for its code. */
  async function saveQrTeam(page: Page) {
    await page.goto("/console/teams");
    await page.getByRole("button", { name: "新增团队" }).click();
    await field(page, "负责人名称").fill("Daisy");
    await field(page, "团队名称").fill("设计团队");
    await groupRow(page, "银河护卫队").getByRole("checkbox").check();
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(qr(page).locator("img")).toBeVisible(LONG);
  }
  /** A screenshot with the onboarding block at the top of the editor, so that the code and its steps are in the picture. */
  async function onboardingShot(page: Page, testInfo: TestInfo, name: string) {
    await editor(page).locator(".atm-mode").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
  }
  /** The code is a drawn image, not a broken one. */
  const codeDrawn = (page: Page) => qr(page).locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);

  test("creates a new team's application by QR code: the code appears after the save, the scan fills in the App ID, and the steps follow the review", async ({ page, fixtureServer }, testInfo) => {
    // The created application's release will await the admin's review.
    await onboarding(fixtureServer, { applications: { [CREATED_APP]: "not_enabled" } });
    await page.goto("/console/teams");
    await page.getByRole("button", { name: "新增团队" }).click();
    // A new team starts in QR creation; nothing is asked of Feishu before the team is saved.
    await expect(editor(page).locator(".acf-seg button[aria-pressed=true]")).toHaveText("扫码一键创建");
    await expect(qr(page)).toHaveText("保存后显示保存团队后，这里显示二维码；用飞书扫码即可创建应用。");
    await expect(steps(page).locator("> div")).toHaveText([/^扫码创建应用/, /^配置权限与机器人能力/, /^发布版本/, /^校验凭证并读取机器人信息/, /^加入所绑定的群/, /^发送测试消息/]);
    await expect(badges(page)).toHaveText(["未开始", "未开始", "未开始", "未开始", "未开始", "未开始"]);
    await expect(editor(page).locator("[data-onboarding] .acf-row-actions")).toHaveCount(0);
    await onboardingShot(page, testInfo, "qr-before-save");

    await field(page, "负责人名称").fill("Daisy");
    await field(page, "团队名称").fill("设计团队");
    await groupRow(page, "银河护卫队").getByRole("checkbox").check();
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(qr(page).locator("img")).toBeVisible(LONG);
    expect(await codeDrawn(page)).toBe(true);
    await expect(qr(page).locator("p")).toHaveText("用飞书扫码，在手机上确认创建。创建完成后，App ID 与 App Secret 自动回填，你不需要复制任何凭证。");
    await expect(qr(page).getByRole("button", { name: "刷新二维码" })).not.toHaveClass(/acv2-primary/);
    await expect(badges(page)).toHaveText(["进行中", "未开始", "未开始", "未开始", "未开始", "未开始"]);
    await onboardingShot(page, testInfo, "qr-waiting-for-scan");

    // The scan, while the owner is editing another field: the QR block still follows the service.
    await field(page, "职责").fill("视觉方案");
    await onboarding(fixtureServer, { scan: "confirmed" });
    await expect(editor(page).locator(".atm-created")).toHaveText(`已创建应用 ${CREATED_APP}凭证已自动保存，不显示`, LONG);
    await expect(badges(page)).toHaveText(["已完成", "已完成", "等待审核", "未开始", "未开始", "未开始"], LONG);
    await expect(steps(page).nth(2)).toContainText("已提交发布，等待企业管理员审核。审核通过后点「重新检查」。");
    await expect(field(page, "职责")).toHaveValue("视觉方案");
    await expect(editor(page).getByRole("button", { name: "发送测试消息…" })).toHaveCount(0);
    await onboardingShot(page, testInfo, "qr-awaiting-review");
    // A save made with the page's older copy of the team keeps the created application.
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#atm-savebar")).toContainText("已保存：新事务使用新配置");
    await expect(editor(page).locator(".atm-created")).toContainText(CREATED_APP);

    // The admin approved.
    await onboarding(fixtureServer, { applications: { [CREATED_APP]: "enabled" } });
    await editor(page).getByRole("button", { name: "重新检查" }).click();
    await expect(badges(page)).toHaveText(["已完成", "已完成", "已完成", "已完成", "已完成", "未开始"], LONG);
    await expect(listItem(page, "Daisy · 设计团队")).toContainText("正常接单");
    await expect(editor(page).getByRole("button", { name: "发送测试消息…" })).toBeVisible();
    // team-management::CON-001: the secret the scan returned is nowhere in the page.
    expect(await page.content()).not.toContain("fixture-created-secret");
    await onboardingShot(page, testInfo, "qr-done");
  });

  test("shows a code that ran out as needing action, offers a new one, and says when Feishu gives none", async ({ page, fixtureServer }, testInfo) => {
    await saveQrTeam(page);
    const first = await qr(page).locator("img").getAttribute("src");
    await onboarding(fixtureServer, { scan: "expired" });
    await expect(qr(page)).toHaveText("二维码已过期这个二维码已过期，或扫码没有完成。刷新后重新扫码即可，不会创建重复的应用。刷新二维码", LONG);
    await expect(qr(page).getByRole("button", { name: "刷新二维码" })).toHaveClass(/acv2-primary/);
    await expect(steps(page).first()).toHaveAttribute("data-state", "blocked");
    await expect(steps(page).first()).toContainText("二维码已过期，或扫码没有完成。请刷新二维码后重新扫码。");
    await expect(badges(page).first()).toHaveText("需处理");
    await onboardingShot(page, testInfo, "qr-expired");

    await onboarding(fixtureServer, { link: "unreachable" });
    await qr(page).getByRole("button", { name: "刷新二维码" }).click();
    await expect(qr(page)).toHaveText("未取得二维码暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」再试。刷新二维码", LONG);
    await expect(steps(page).first()).toContainText("暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」。");
    await onboardingShot(page, testInfo, "qr-unreachable");

    await onboarding(fixtureServer, { link: "ready" });
    await qr(page).getByRole("button", { name: "刷新二维码" }).click();
    await expect(qr(page).locator("img")).toBeVisible(LONG);
    expect(await codeDrawn(page)).toBe(true);
    expect(await qr(page).locator("img").getAttribute("src")).not.toBe(first);
    await expect(badges(page).first()).toHaveText("进行中");
  });

  // Owner decision of 2026-11-11: a team that has an application may be saved as QR creation; it keeps working until the scan.
  test("lets a team with an application switch to QR creation: it keeps taking work until the scan, then onboards again with the created application", async ({ page, fixtureServer }, testInfo) => {
    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    const segment = (name: string) => editor(page).locator(".acf-seg").getByRole("button", { name });
    await expect(segment("已有应用，手动填写")).toHaveAttribute("aria-pressed", "true");
    // The chosen segment keeps its background under the pointer, and differs from a segment that is only hovered.
    const background = (name: string) => segment(name).evaluate((button) => getComputedStyle(button).backgroundColor);
    await segment("已有应用，手动填写").hover();
    const chosen = await background("已有应用，手动填写");
    await segment("扫码一键创建").hover();
    expect([chosen, await background("已有应用，手动填写"), await background("扫码一键创建")]).toEqual(["rgb(228, 239, 234)", "rgb(228, 239, 234)", "rgb(238, 240, 235)"]);
    // A 1px line in the page's line colour (#e2e5df) parts the two segments, so the hovered one and the chosen one beside it
    // do not read as one block (owner decision of 2026-11-11). The first segment has no line before it.
    const leftBorder = (name: string) => segment(name).evaluate((button) => { const style = getComputedStyle(button); return `${style.borderLeftWidth} ${style.borderLeftStyle} ${style.borderLeftColor}`; });
    expect([await leftBorder("扫码一键创建"), await leftBorder("已有应用，手动填写")]).toEqual([expect.stringMatching(/^0px /), "1px solid rgb(226, 229, 223)"]);

    await segment("扫码一键创建").click();
    await expect(qr(page)).toHaveText("保存后显示保存团队后，这里显示二维码；用飞书扫码即可创建应用。扫码创建的新应用会替换现在的应用 cli_bbbbbbbbbbbbbbbb，替换后团队在各群重新接入。");
    await expect(badges(page)).toHaveText(["未开始", "未开始", "未开始", "未开始", "未开始", "未开始"]);
    await onboardingShot(page, testInfo, "qr-replacement-before-save");
    await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(qr(page).locator("img")).toBeVisible(LONG);
    // Until the scan Bill posts with the application it has.
    await expect(listItem(page, "Bill · 生活团队")).toContainText("正常接单");
    await expect(editor(page).locator(".atm-roster-preview")).toContainText("银河护卫队：Sam 可分派给 Alice、Bill、Jack");

    await onboarding(fixtureServer, { scan: "confirmed" });
    await expect(editor(page).locator(".atm-created")).toContainText(CREATED_APP, LONG);
    await expect(badges(page)).toHaveText(["已完成", "已完成", "已完成", "已完成", "已完成", "未开始"], LONG);
    await expect(listItem(page, "Bill · 生活团队")).toContainText("正常接单", LONG);
    // As an existing application it now shows the created App ID, with its secret stored.
    await segment("已有应用，手动填写").click();
    await expect(field(page, "App ID")).toHaveValue(CREATED_APP);
    await expect(editor(page).locator(".acf-secret")).toHaveText(/已保存 · 不显示/);
  });

  // Step 6 (owner decision of 2026-11-11): sent by the team's own application, only from the confirmation.
  test("sends the test message only from its confirmation, and shows each group's result", async ({ page, fixtureServer }, testInfo) => {
    const billOutbox = async () => ((await (await fetch(`${fixtureServer.url}/api/state`, { headers: { cookie: fixtureServer.cookie } })).json()) as
      { agentFixtureOutboxes: Record<string, { text: Array<{ chatId: string; message: string }> }> }).agentFixtureOutboxes.bill!.text.map(({ chatId, message: sent }) => [chatId, sent]);
    const message = "这是 Bill（生活团队）的测试消息，用来确认可以在本群发言。";
    await page.goto("/console/teams");
    await listItem(page, "Bill · 生活团队").click();
    await editor(page).getByRole("button", { name: "发送测试消息…" }).click();
    const confirmation = editor(page).locator(".atm-test-confirm");
    await expect(confirmation).toHaveText(`将以 Bill（生活团队）的机器人向银河护卫队、产品讨论组各发一条测试消息，群里的成员都会看到：「${message}」确认发送取消`);
    await testInfo.attach("test-message-confirmation", { body: await page.screenshot(), contentType: "image/png" });
    await confirmation.getByRole("button", { name: "取消" }).click();
    await expect(confirmation).toHaveCount(0);
    expect(await billOutbox()).toEqual([]);

    // Feishu refuses the first send and accepts the second.
    await post(fixtureServer, "/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["rejected", "accepted"] } });
    await editor(page).getByRole("button", { name: "发送测试消息…" }).click();
    await confirmation.getByRole("button", { name: "确认发送" }).click();
    const results = steps(page).nth(2).locator(".atm-joins li");
    await expect(results).toHaveText(["银河护卫队发送失败 · 不会自动重发需处理", "产品讨论组飞书已接收已完成"], LONG);
    await expect(steps(page).nth(2)).toHaveAttribute("data-state", "blocked");
    await expect(confirmation).toHaveCount(0);
    expect(await billOutbox()).toEqual([["oc_beta", message]]);
    await testInfo.attach("test-message-failed-in-one-group", { body: await page.screenshot(), contentType: "image/png" });

    // The owner sends again: both groups accept, and each group shows its latest result.
    await editor(page).getByRole("button", { name: "发送测试消息…" }).click();
    await confirmation.getByRole("button", { name: "确认发送" }).click();
    await expect(results).toHaveText(["银河护卫队飞书已接收已完成", "产品讨论组飞书已接收已完成"], LONG);
    await expect(badges(page).nth(2)).toHaveText("已完成");
    expect(await billOutbox()).toEqual([["oc_beta", message], ["oc_alpha", message], ["oc_beta", message]]);
    await testInfo.attach("test-message-accepted", { body: await page.screenshot(), contentType: "image/png" });
  });
});

// agent-console::REQ-005/AC-04: a group's name comes from Feishu, where any member can rename the group, and a leader's and a
// team's name are typed by the owner. The onboarding block draws them in its rows, their reasons and the test message's
// confirmation; they must appear as the text they are, and never become page elements.
test.describe("with names that hold markup", () => {
  const MARK = '<img src=x onerror="window.__marked=1">';
  test.use({ fixtureStart: { channelConfiguration: dispatchChannel, env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify({ chats: {
    oc_alpha: { name: `${MARK}银河护卫队` }, oc_beta: { name: `<i>产品</i>讨论组`, add: "owner_only" } } }) } } });

  test("draws group, leader and team names in the onboarding block as text", async ({ page, fixtureServer }) => {
    const { version } = await (await fetch(`${fixtureServer.url}/api/teams`, { headers: { cookie: fixtureServer.cookie } })).json() as { version: number };
    await post(fixtureServer, "/api/teams/save", { basedOn: version, team: { teamName: "<i>设计</i>团队", responsibility: "视觉方案", groups: ["oc_alpha", "oc_beta"],
      leader: { name: `Daisy${MARK}`, appId: "cli_dddddddddddddddd", instructions: "" }, secret: "daisy-secret",
      executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: ["files.read"] }] } });
    await page.goto("/console/teams");
    await listItem(page, "<i>设计</i>团队").click();
    const block = editor(page).locator("[data-onboarding]");
    // The group that lets only its owner and admins add members is named in its row and in the row's reason.
    await expect(block.locator(".atm-joins li")).toHaveText([`${MARK}银河护卫队机器人已在群里。已完成`,
      "<i>产品</i>讨论组<i>产品</i>讨论组只允许群主和管理员添加成员，Sam 无法拉入。请在飞书调整群设置，或由群主手动添加。需处理"], LONG);
    await block.getByRole("button", { name: "发送测试消息…" }).click();
    await expect(block.locator(".atm-test-confirm")).toHaveText(`将以 Daisy${MARK}（<i>设计</i>团队）的机器人向${MARK}银河护卫队发一条测试消息，群里的成员都会看到：`
      + `「这是 Daisy${MARK}（<i>设计</i>团队）的测试消息，用来确认可以在本群发言。」确认发送取消`);
    // Nothing in the names became an element, and nothing in them ran.
    await expect(block.locator("img, i")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __marked?: number }).__marked)).toBeUndefined();
  });
});

// The dispatch-group form (agent-console::US-009). The file write and its refusals are covered by
// tests/dispatch-group-settings.test.ts and the restart by tests/team-management.integration.test.ts; these journeys check the page.
// Coverage gap: the page's request states are driven for proposed and running only. Holding a request queued or waiting needs a
// queue behind it or an Executor's pending choice, which no team-management fixture gives; the module test covers all four states.
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
    const groupMessage = (messageId: string, text: string, dispatchDecision: unknown) => post(fixtureServer, "/api/fixture/inbound", {
      event: { app_id: SAM_APP, sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
          content: JSON.stringify({ text }), mentions: [] } }, dispatchDecision });
    await groupMessage("om_dc_proposal", "周末可能想去附近玩玩", { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" });
    await post(fixtureServer, "/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["held"] } });
    await groupMessage("om_dc_running", "帮我核对预算和行程", { kind: "dispatch", agentId: "bill", requestId: null, summary: "核对 <b>预算</b> & 行程", message: "" });
    await expect.poll(async () => (await (await fetch(`${fixtureServer.url}/api/state`, { headers: { cookie: fixtureServer.cookie } })).json() as
      { agentDispatch?: { jobs: Array<{ status: string }> } }).agentDispatch?.jobs.map(({ status }) => status), LONG).toEqual(["proposed", "running"]);
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
