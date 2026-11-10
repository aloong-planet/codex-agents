import { expect } from "@playwright/test";

import { requestConsoleControl } from "../src/console-control.js";
import { groupMemoryAccount, seedEvent, seedMemory } from "../tests/support/memory.js";
import { processWaitLimitMs } from "../tests/support/process-wait.js";
import { exchangeLoginLink } from "./console-session.js";
import { test } from "./fixtures.js";

// agent-console::US-001 in a real browser. These cases open their own contexts, so the shared `page`
// fixture's automatic login does not apply to them.
const EXPIRED_NOTICE = "这条登录链接已失效：超过 2 分钟或已经用过。请重新运行登录命令。";
const REVOKED_NOTICE = "本浏览器的授权已收回，打开的页面已断开。";

test("shows only the login card to a browser without authorization, including one opening a used link", async ({ browser, fixtureServer }, testInfo) => {
  const unauthorized = await browser.newContext();
  try {
    const page = await unauthorized.newPage();
    await page.goto(`${fixtureServer.url}/`);
    await expect(page.getByRole("heading", { name: "需要本机授权" })).toBeVisible();
    const style = await page.locator(".console-gate-card").evaluate((element) => {
      const computed = getComputedStyle(element);
      return { radius: computed.borderTopLeftRadius, background: computed.backgroundColor };
    });
    // The card's own CSP must let its inline style through.
    expect(style).toEqual({ radius: "14px", background: "rgb(255, 255, 255)" });
    await expect(page.locator("#connection-app-tab")).toHaveCount(0);
    await testInfo.attach("login-card", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  } finally {
    await unauthorized.close();
  }

  const link = await fixtureServer.loginLink();
  await exchangeLoginLink(link);
  const late = await browser.newContext();
  try {
    const page = await late.newPage();
    await page.goto(link);
    await expect(page.getByRole("alert")).toHaveText(EXPIRED_NOTICE);
    await expect(page.locator("#connection-app-tab")).toHaveCount(0);
    await testInfo.attach("login-card-used-link", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  } finally {
    await late.close();
  }
});

test("authorizes a browser with a strict HttpOnly cookie and disconnects its open page when revoked", async ({ browser, fixtureServer }, testInfo) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(await fixtureServer.loginLink());
    await expect(page.locator("#connection-app-tab")).toBeVisible();
    const port = new URL(fixtureServer.url).port;
    expect(await context.cookies(fixtureServer.url)).toEqual([
      expect.objectContaining({ name: `codex_console_${port}`, httpOnly: true, sameSite: "Strict" }),
    ]);

    const { browsers } = await requestConsoleControl(fixtureServer.directory, { command: "list" });
    const own = (browsers as Array<{ id: string; label: string }>).filter((item) => item.label.startsWith("Chrome · "));
    expect(own).toHaveLength(1);
    await requestConsoleControl(fixtureServer.directory, { command: "revoke", target: own[0]!.id });

    await expect(page.getByRole("alert")).toHaveText(REVOKED_NOTICE, { timeout: 6_000 });
    await expect(page.locator("#connection-app-tab")).toHaveCount(0);
    await testInfo.attach("login-card-revoked", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  } finally {
    await context.close();
  }
});

// The console shell, the 本机登录 drawer and the team overview (agent-console::US-001/AC-03, US-002 to US-005) in a real browser,
// against the fixture service with Feishu dispatch in two groups. Requests are made through the fixture-only Feishu ingress with
// injected Coordinator decisions, Team Leader plans and Executor turns; held turns keep Executors running. The projection's
// rules are unit-tested in tests/console-overview.test.ts; these journeys show the page, the API and the service wired together.
const owner = { memoryAccountId: "fixture-bot", bindings: [
  { channel: "weixin", accountId: "fixture-bot", target: "fixture-user@im.wechat", senderId: "fixture-user@im.wechat" },
  { channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" },
] };
const dispatchChannel = { channel: "feishu", owner, taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
  feishu: { appId: "cli_0123456789abcdef", appSecret: "fixture-secret",
    groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
    dispatch: { groupChatIds: ["oc_alpha", "oc_beta"], agents: [{ id: "sam" }, { id: "alice", appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "fixture-alice" },
      { id: "bill", appId: "cli_bbbbbbbbbbbbbbbb", appSecret: "fixture-bill" }, { id: "jack", appId: "cli_cccccccccccccccc", appSecret: "fixture-jack" }] } } };
const GROUP_NAMES = { chats: { oc_alpha: { name: "银河护卫队" }, oc_beta: { name: "产品讨论组" } } };
const MARKUP = "请把这段加进详情：<a href=\"https://example.com/x\">链接</a> ![主图](https://example.com/a.png) <script>alert(1)</script>";
type Server = { url: string; cookie: string };
type Jobs = { agentDispatch?: { jobs: Array<{ status: string; assignments: Array<{ title: string; status: string }> }> } };
async function inbound(server: Server, chatId: string, messageId: string, text: string, agentId: string, summary: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${server.url}/api/fixture/inbound`, { method: "POST", headers: { cookie: server.cookie, origin: server.url, "content-type": "application/json" },
    body: JSON.stringify({ event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: messageId, create_time: String(Date.now()), chat_id: chatId, chat_type: "group", message_type: "text", content: JSON.stringify({ text }), mentions: [] } },
    dispatchDecision: { kind: "dispatch", agentId, requestId: null, summary, message: "" }, ...extra }) });
  expect(response.status, await response.text()).toBe(200);
}
const jobs = async (server: Server) => ((await (await fetch(`${server.url}/api/state`, { headers: { cookie: server.cookie } })).json()) as Jobs).agentDispatch?.jobs ?? [];
const reply = (message: string, subject: string, status = "completed") => JSON.stringify({ message, results: [{ subject, status }] });
/**
 * Three requests: in 银河护卫队, Alice's partly failed one, then Alice's held one with a part placed with Bill; in 产品讨论组, Bill's
 * completed one. Alice takes one request at a time in a group, so the held one comes last there.
 */
async function seedRequests(server: Server) {
  await inbound(server, "oc_alpha", "om_partial", `商品 C 上架：校对详情页并核对竞品价格，这个标题写得很长很长，用来检查摘要里截断、展开后完整显示，再补充一段说明文字，让它在七百多像素宽的抽屉里也放不下一行。${MARKUP}`, "alice", "商品 C 上架：校对详情页并核对竞品价格，这个标题写得很长很长，用来检查摘要里截断、展开后完整显示，再补充一段说明文字，让它在七百多像素宽的抽屉里也放不下一行", {
    leaderPlan: { assignments: [{ profileId: "executor-1", title: "校对详情页", brief: "逐段校对" }, { profileId: "executor-1", title: "核对竞品价格", brief: "核对三家" }], decisions: [], help: [] },
    leaderClosing: { message: "商品 C 收尾：校对已完成，交付文件为 product-c-review.md；竞品价格未能核对。" },
    executorTurns: { 校对详情页: { modelReply: reply("校对完成，交付文件为 product-c-review.md", "校对详情页") }, 核对竞品价格: { modelReply: reply("价格页打不开", "核对竞品价格", "partial") } } });
  await expect.poll(async () => (await jobs(server))[0]?.status, { timeout: processWaitLimitMs }).toBe("partially_failed");
  await inbound(server, "oc_alpha", "om_running", "商品 D 上架：写详情、核对价格，再做个自动上架脚本", "alice", "商品 D 上架", {
    leaderPlan: { assignments: [{ profileId: "executor-1", title: "撰写商品详情", brief: "九成新" }, { profileId: "executor-1", title: "核对价格", brief: "三家" }], decisions: [],
      help: [{ title: "自动上架脚本", brief: "只交付代码" }] },
    crossTeamDecision: { assignments: [{ part: 1, agentId: "bill", summary: "编写自动上架脚本" }] },
    teamTurns: { bill: { leaderPlan: { assignments: [{ profileId: "executor-1", title: "编写上架脚本", brief: "只交付代码" }], decisions: [], help: [] } } },
    executorTurns: { 撰写商品详情: { modelHold: true }, 核对价格: { modelHold: true }, 编写上架脚本: { modelHold: true } } });
  await inbound(server, "oc_beta", "om_beta", "整理下周发布说明", "bill", "整理发布说明", { modelReply: reply("发布说明已整理", "整理发布说明") });
  await expect.poll(async () => (await jobs(server)).map(({ status, assignments }) => `${status}:${assignments.map((a) => a.status).join(",")}`),
    { timeout: processWaitLimitMs }).toEqual(["partially_failed:completed,failed", "running:running,running,running", "completed:completed"]);
}

test.describe("with Feishu dispatch", () => {
  test.use({ fixtureStart: { channelConfiguration: dispatchChannel, env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify(GROUP_NAMES) } } });

  test("opens on the team overview, with the sidebar's private entries and 本机 section on every page and a menu bar on narrow screens", async ({ page }, testInfo) => {
    // The login link lands on the console's home, which is the team overview.
    await expect(page).toHaveURL(/\/console$/);
    const side = page.locator(".acv-side");
    await expect(side.locator('.acv-nav-item[aria-current="page"]')).toHaveText("团队总览");
    expect((await side.boundingBox())?.width).toBe(212);
    await expect(side.locator(".acv-side-h")).toHaveText(["工作台", "Penny · 本人私聊", "普通私聊", "本机"]);
    await expect(side.locator('[data-open="penny"]')).toContainText("个人账 / 经营账 · 未配置");
    await expect(page.locator("#acv-login-meta")).toHaveText(/^\d+ 个浏览器已授权$/);
    // Page and section explanations sit in tips beside their titles.
    await expect(page.locator(".acv2-heading .acv-tip-btn")).toHaveCount(1);
    await expect(side.locator(".acv-side-h .acv-tip-btn")).toHaveCount(3);
    // On the team overview the private entries open their drawer; on other pages they lead to the overview.
    await side.locator('[data-open="penny"]').click();
    await expect(page.locator("#ats-drawer-title")).toHaveText("Penny");
    await expect(page.locator("#ats-records")).toContainText("账务内容保持私密");
    await page.keyboard.press("Escape");
    await side.locator('[data-open="personal"]').click();
    await expect(page.locator("#ats-drawer-title")).toHaveText("个人助手");
    await page.goto("/console/teams");
    await page.locator(".acv-side").getByRole("link", { name: /Penny/ }).click();
    await expect(page).toHaveURL(/\/console$/);
    await testInfo.attach("shell", { body: await page.screenshot(), contentType: "image/png" });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".acv-menu-btn")).toBeVisible();
    await page.locator(".acv-menu-btn").click();
    await expect(page.locator(".acv-side")).toBeInViewport();
    await testInfo.attach("shell-narrow", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("lists the authorized browsers in the 本机登录 drawer and revokes another one, each after an inline confirmation", async ({ page, fixtureServer }, testInfo) => {
    const other = await exchangeLoginLink(await fixtureServer.loginLink(), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15");
    await page.goto("/console/teams");
    await page.locator("[data-acv-login]").click();
    const drawer = page.locator("#acv-login-drawer");
    await expect(drawer.locator("h3").first()).toHaveText(/^已授权的浏览器 · 3$/);
    await expect(drawer.locator(".acv5-list li", { hasText: "当前浏览器" })).toHaveCount(1);
    await expect(drawer).toContainText("写入本机审计文件 · 在终端查看");
    const safari = drawer.locator(".acv5-list li", { hasText: "Safari" });
    await expect(safari.locator("small")).toHaveText(/^授权于 \d\d-\d\d \d\d:\d\d · 最近使用 \d\d-\d\d \d\d:\d\d$/);
    await safari.getByRole("button", { name: "收回" }).click();
    await expect(safari.locator(".acf-inline-confirm")).toContainText("收回后，该浏览器打开的页面立即断开");
    await testInfo.attach("login-drawer-confirm", { body: await page.screenshot(), contentType: "image/png" });
    await safari.getByRole("button", { name: "确认收回" }).click();
    await expect(drawer.locator(".acv-login-status")).toHaveText(/^已收回「Safari · macOS」的授权，它打开的页面已断开。$/);
    await expect(drawer.locator(".acv5-list li")).toHaveCount(2);
    expect((await fetch(`${fixtureServer.url}/api/overview`, { headers: { cookie: other } })).status).toBe(401);
    await drawer.getByRole("button", { name: "全部收回" }).click();
    await expect(drawer.locator(".acf-inline-confirm")).toContainText("收回全部 2 个浏览器的授权？包括正在使用的这个，本页会立即退出。");
    await drawer.getByRole("button", { name: "取消" }).click();
    await expect(drawer.locator(".acf-inline-confirm")).toHaveCount(0);
    await page.locator("#acv-login-close").click();
    await expect(drawer).toBeHidden();
  });

  test("shows the tree of the selected group and each request's record, storage and relationships in the drawer", async ({ page, fixtureServer }, testInfo) => {
    await seedRequests(fixtureServer);
    await page.goto("/console");
    await expect(page.locator(".ats-chip")).toHaveText(["银河护卫队 · 群协作", "产品讨论组 · 群协作"]);
    const card = (name: string) => page.locator(".ats-card", { has: page.locator(".ats-name strong", { hasText: new RegExp(`^${name}$`) }) });
    await expect(card("Sam")).toContainText("Sam Bot");
    // Each Team Leader's card counts its requests once: Alice one running and one ended, Bill one cross-team running.
    await expect(card("Alice").locator(".ats-node-foot")).toHaveText("1 执行中 · 0 待确认 · 1 历史");
    await expect(card("Bill").locator(".ats-node-foot")).toHaveText("1 执行中 · 0 待确认 · 0 历史");
    await expect(card("Jack").locator(".ats-node-foot")).toHaveText("0 执行中 · 0 待确认 · 0 历史");
    // Frames hold only running and waiting Executors, named after their profile and number, without a bot badge or chat entry.
    const frames = page.locator(".ats-req-frame");
    await expect(frames.locator("small")).toHaveText(["本队 2 项分工 · 跨队 1 项", "跨队分工 · 应 Alice 请求"]);
    await expect(frames.locator(".ats-card .ats-name strong")).toHaveText([/^执行者 \d+$/, /^执行者 \d+$/, /^执行者 \d+$/]);
    await expect(frames.locator(".ats-card .ats-bot")).toHaveCount(0);
    await expect(frames.locator(".ats-card").first()).toContainText("能力档 · ");
    await expect(page.locator(".ats-task-caption")).toHaveText(["撰写商品详情", "核对价格", "编写上架脚本"]);
    // 2px connectors in the dispatching role's colour (agent-console::CON-003).
    const edge = await page.locator(".ats-edge").first().evaluate((path) => ({ width: getComputedStyle(path).strokeWidth, colour: getComputedStyle(path).stroke }));
    expect(edge).toEqual({ width: "2px", colour: "rgb(31, 111, 92)" });
    await testInfo.attach("overview-tree", { body: await page.screenshot(), contentType: "image/png" });

    // Teams collapse independently; zoom and fit-to-window.
    await card("Alice").locator("[data-toggle]").click();
    await expect(frames).toHaveCount(1);
    await expect(page.locator(".ats-branch-note").first()).toContainText("已收起 1 项活动事务");
    await card("Alice").locator("[data-toggle]").click();
    await expect(frames).toHaveCount(2);
    const scale = page.locator("#ats-scale");
    await page.getByRole("button", { name: "适应窗口" }).click();
    const fitted = await scale.textContent();
    await page.getByRole("button", { name: "放大" }).click();
    await expect(scale).not.toHaveText(fitted!);
    await page.getByRole("button", { name: "适应窗口" }).click();
    await expect(scale).toHaveText(fitted!);

    // A frame's title opens the request's record, already expanded.
    await frames.first().locator(".ats-req-label").click();
    const drawer = page.locator("#ats-drawer");
    await expect(page.locator("#ats-tab-records")).toHaveAttribute("aria-selected", "true");
    await expect(drawer.locator(".acv2-record-button")).toHaveAttribute("aria-expanded", "true");
    await expect(drawer.locator(".acv2-record-delivery")).toHaveText("尚无结果汇报");
    await page.keyboard.press("Escape");

    // A Team Leader's records include history; search and both state filters share one row with content-sized selectors.
    await card("Alice").locator(".ats-name").click();
    await expect(page.locator("#ats-scope-label")).toHaveText("团队事务 · 包含历史");
    await expect(page.locator("#ats-count")).toHaveText("2 条");
    const boxes = await Promise.all(["#ats-search", "#ats-status", "#ats-delivery"].map((selector) => page.locator(selector).boundingBox()));
    expect(new Set(boxes.map((box) => Math.round(box!.y))).size).toBe(1);
    expect(boxes[1]!.width).toBeLessThan(boxes[0]!.width);
    await page.locator("#ats-status").selectOption("partially_failed");
    await expect(page.locator("#ats-count")).toHaveText("1 条");
    const record = drawer.locator(".acv2-record").first();
    // The summary: the title, then the lead with its Assignment count, the business state, the report's delivery and the time.
    await expect(record.locator(".acv2-record-meta")).toContainText(/Alice · 2 项分工部分失败平台已接收/);
    const title = record.locator(".acv2-record-title");
    expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await record.locator(".acv2-record-button").click();
    await expect(record.locator(".acv4-detail-title")).toHaveText("商品 C 上架：校对详情页并核对竞品价格，这个标题写得很长很长，用来检查摘要里截断、展开后完整显示，再补充一段说明文字，让它在七百多像素宽的抽屉里也放不下一行");
    // Expanded, in order: result, path, Assignments, group posts, original message and storage links.
    const order = await record.locator(".acv2-record-detail > *").evaluateAll((elements) => elements.map((element) => element.className || element.tagName));
    expect(order).toEqual(["acv4-detail-title", "acv2-result acv2-warning", "ats-path-line", "acv2-detail-label", "ats-asg-list", "acv2-process", "acv2-detail-label",
      "acv2-message", "acv2-detail-label", "acv2-related"]);
    await expect(record.locator(".ats-asg .acv2-badge")).toHaveText(["已完成", "失败"]);
    // Each Assignment shows the Brief its Executor received, under its meta line.
    await expect(record.locator(".ats-asg-brief")).toHaveText(["交办：逐段校对", "交办：核对三家"]);
    await record.locator(".acv2-process summary").click();
    await expect(record.locator(".ats-report-text").last()).toHaveText("商品 C 收尾：校对已完成，交付文件为 product-c-review.md；竞品价格未能核对。 · 平台已接收");
    // Text from members and Executors is plain text: no link, image or script; a delivered file is only named (REQ-005/AC-04, AC-06).
    await expect(record.locator(".acv2-message")).toContainText("<a href=\"https://example.com/x\">链接</a> ![主图](https://example.com/a.png) <script>");
    await expect(drawer.locator("a, img, script")).toHaveCount(0);
    await testInfo.attach("record-expanded", { body: await page.screenshot(), contentType: "image/png" });

    // Switching tabs keeps the search and the expanded record.
    await page.locator("#ats-search").fill("商品 C");
    await record.locator(".acv2-record-button").click();
    await page.locator("#ats-tab-storage").click();
    await expect(page.locator("#ats-panel-storage")).toContainText("所属关系与消息身份");
    await page.locator("#ats-tab-records").click();
    await expect(page.locator("#ats-search")).toHaveValue("商品 C");
    await expect(drawer.locator(".acv2-record-button")).toHaveAttribute("aria-expanded", "true");

    // Relationships and storage: a related node opens in the same drawer, with 返回.
    await page.locator("#ats-tab-storage").click();
    await page.locator("#ats-panel-storage .acv2-related button").first().click();
    await expect(page.locator("#ats-drawer-title")).toHaveText(/^执行者 \d+$/);
    await expect(page.locator("#ats-back")).toBeVisible();
    await page.locator("#ats-back").click();
    await expect(page.locator("#ats-drawer-title")).toHaveText("Alice");
    await expect(page.locator("#ats-back")).toBeHidden();
    await page.keyboard.press("Escape");

    // Each kind of storage opens separately, with its location.
    for (const [store, text] of [["群业务记忆", "只有 Sam 读取"], ["负责人与执行者记忆", "同一能力档创建的执行者在本群共享一份记忆"], ["执行记录与交付文件", "agent-dispatch.sqlite"],
      ["任务与提醒", "scheduled-tasks.sqlite"]] as const) {
      await page.locator(".ats-store", { hasText: store }).click();
      await page.locator("#ats-tab-storage").click();
      await expect(page.locator("#ats-panel-storage")).toContainText(text);
      await page.keyboard.press("Escape");
    }
    // The scope entries switch the tree to the other group.
    await page.locator(".ats-chip", { hasText: "产品讨论组" }).click();
    await expect(page.locator(".ats-group-head")).toContainText("产品讨论组 · 团队关系");
    await expect(card("Bill").locator(".ats-node-foot")).toHaveText("0 执行中 · 0 待确认 · 1 历史");
    await expect(page.locator(".ats-req-frame")).toHaveCount(0);
  });

  test("shows each group's own memory read-only in the storage tab, every entry and every event", async ({ page, fixtureServer }, testInfo) => {
    const alpha = groupMemoryAccount(fixtureServer.directory, "oc_alpha"), beta = groupMemoryAccount(fixtureServer.directory, "oc_beta");
    await seedMemory(fixtureServer.directory, alpha.account, alpha.target, "alpha-1", "上新文案先发到上新话题 https://example.com/rules");
    await seedEvent(fixtureServer.directory, alpha.account, alpha.target, "alpha-2", "2025-01-15", "去年的商品 C 校对完成");
    await seedMemory(fixtureServer.directory, beta.account, beta.target, "beta-1", "产品讨论组的发布节奏是双周");
    await page.goto("/console");
    await page.locator(".ats-store", { hasText: "群业务记忆" }).click();
    await page.locator("#ats-tab-storage").click();
    const panel = page.locator("#ats-panel-storage");
    await expect(panel.locator(".ats-memory-head")).toContainText("当前内容");
    await expect(panel.locator(".ats-memory-head .acv-tip-btn")).toHaveAttribute("aria-label", /只读.*事件按日期列出全部，不限时间范围.*控制台不修改、不删除这份记忆/);
    await expect(panel.locator(".ats-memory-meta")).toHaveText(/^记忆 1 条 · 事件 1 个 · 最近整理 \d\d-\d\d \d\d:\d\d$/);
    await expect(panel.locator(".ats-memory h4")).toHaveText(["项目", "事件"]);
    await expect(panel.locator(".ats-memory li")).toHaveText(["上新文案先发到上新话题 https://example.com/rules", "2025-01-15 · 已发生 · 去年的商品 C 校对完成"]);
    // Read-only and plain text: nothing in the view links, edits or deletes.
    await expect(panel.locator(".ats-memory a, .ats-memory button, .ats-memory input, .ats-memory textarea")).toHaveCount(0);
    await testInfo.attach("group-memory", { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    // The other group shows its own memory only.
    await page.locator(".ats-chip", { hasText: "产品讨论组" }).click();
    await page.locator(".ats-store", { hasText: "群业务记忆" }).click();
    await page.locator("#ats-tab-storage").click();
    await expect(panel.locator(".ats-memory li")).toHaveText(["产品讨论组的发布节奏是双周"]);
  });

  test("opens details in a drawer over a scrim at every width, closing on the button, the scrim and Escape, and filling the workspace on phones", async ({ page, fixtureServer }, testInfo) => {
    await seedRequests(fixtureServer);
    await page.goto("/console");
    const drawer = page.locator("#ats-drawer");
    await page.locator("#ats-all").click();
    const viewport = page.viewportSize()!;
    expect((await drawer.boundingBox())!.width).toBeCloseTo(Math.min(720, (viewport.width - 212) * 0.8), 0);
    expect(await page.locator("#ats-close").evaluate((button) => getComputedStyle(button).borderTopWidth)).toBe("1px");
    await page.locator("#ats-close").click();
    await expect(drawer).toBeHidden();
    await page.locator("#ats-all").click();
    await page.mouse.click(260, viewport.height - 20);
    await expect(drawer).toBeHidden();
    await page.locator("#ats-all").click();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#ats-all").click();
    expect((await drawer.boundingBox())!.width).toBe(390);
    expect(await page.locator("#ats-view").evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await drawer.locator(".acv2-record-button").first().click();
    await drawer.locator(".acv2-process summary").first().click();
    // Long content wraps or scrolls inside its record and never widens the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await testInfo.attach("drawer-phone", { body: await page.screenshot(), contentType: "image/png" });
  });
});
