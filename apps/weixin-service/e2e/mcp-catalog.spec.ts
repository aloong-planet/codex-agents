import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import { startAuthorizationServer, startHttpTestServer } from "../tests/fixtures/mcp-http-test-server.js";
import { CLIENT_SECRET_SENTINEL, HEADER_SENTINEL, SECRET_SENTINEL, isAlive, starts, testServerArgs, testServerFiles, writeTools } from "../tests/fixtures/mcp-test-server-control.js";
import { authorizeLocalService } from "./console-session.js";
import { startFixtureServer } from "./fixture-server.js";
import { test } from "./fixtures.js";

// MCP 管理 (docs/specs/mcp-catalog.md) in a real browser, against the fixture service and real local MCP programs.
// Rules are covered by tests/mcp-catalog-rules.test.ts and the catalog by tests/mcp-catalog.test.ts; these journeys
// check that the page, the API and the service's connections are wired together.
// Coverage gap: of the text a server supplies, the output tail, the error line (table row and 原因) and the tool
// description are given markup and checked as text; the server's name and version and the tool names are not. They
// are separate call sites of the same escaping, and a markup tool name would also change the tool's proxy name.
// URL servers run against local HTTP test servers on loopback http; TLS and real OAuth providers are not driven.
const LONG = { timeout: 15_000 };
const LOOKUP = { name: "lookup", description: "Finds an item.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };

function workDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
}

/** Registers a server through the API, as setup for journeys that are not about registration. */
async function registerViaApi(fixtureServer: { url: string; cookie: string }, server: Record<string, unknown>) {
  const post = (pathname: string, body: unknown) => fetch(`${fixtureServer.url}${pathname}`, {
    method: "POST",
    headers: { cookie: fixtureServer.cookie, origin: fixtureServer.url, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());
  const { launchLine } = await post("/api/mcp/preview", { server });
  const result = await post("/api/mcp/servers", { server, confirmed: launchLine });
  if (!result.server) throw new Error(`registration failed: ${JSON.stringify(result)}`);
}

async function fillLocalProgram(page: Page, name: string, args: string[], env: string) {
  await page.locator('[data-f="name"]').fill(name);
  await page.locator('[data-f="command"]').fill(process.execPath);
  await page.locator('[data-f="args"]').fill(args.join("\n"));
  await page.locator('[data-f="env"]').fill(env);
}

const row = (page: Page, name: string) => page.locator("#amc-rows tr").filter({ has: page.locator(`[data-open="${name}"]`) });

test("registers a local program only after confirming its exact command", async ({ page, fixtureServer }, testInfo) => {
  const work = workDirectory();
  const files = testServerFiles(work, "local");
  writeTools(files.tools, [LOOKUP]);
  await page.goto(`${fixtureServer.url}/console/mcp`);

  await expect(page.locator(".acv-side-nav .acv-nav-item")).toHaveText(["团队总览", "团队管理", "MCP 管理", "Skill 管理"]);
  await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("MCP 管理");
  await expect(page.getByRole("button", { name: "添加服务器" })).toBeVisible();
  await expect(page.locator(".amc-actions").getByRole("link", { name: "返回团队管理" })).toHaveAttribute("href", "/console/teams");
  await expect(page.getByRole("button", { name: "导入 JSON" })).toBeVisible();
  await expect(page.locator("#amc-rows .acv2-empty")).toHaveText(/还没有 MCP 服务器。\s*点「添加服务器」登记本机程序。/);
  await testInfo.attach("empty-table", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("button", { name: "添加服务器" }).click();
  await expect(page.locator("#amc-title")).toHaveText("添加 MCP 服务器");
  await expect(page.locator("#amc-form .acv-req")).toHaveCount(3);
  await expect(page.locator("#amc-form .acv-opt")).toHaveCount(4);
  await expect(page.locator("#amc-form .acv-tip-btn")).not.toHaveCount(0);
  await expect(page.locator('#amc-form input[type="radio"]')).toHaveCount(2);
  await expect(page.getByLabel("本机程序（stdio）")).toBeChecked();
  await expect(page.locator('[data-f="timeout"]')).toHaveAttribute("placeholder", "60");
  await expect(page.locator('[data-f="trusted"]')).not.toBeChecked();
  await expect(page.locator('[data-f="enabled"]')).toBeChecked();
  await page.locator('[data-f="sandbox"]').check();
  await expect(page.locator('[data-f="sbDomains"], [data-f="sbRead"], [data-f="sbWrite"]')).toHaveCount(3);
  await page.locator('[data-f="sandbox"]').uncheck();

  const line = [process.execPath, ...testServerArgs(files)].join(" ");
  await fillLocalProgram(page, "local", testServerArgs(files), `SECRET_TOKEN=${SECRET_SENTINEL}`);
  await expect(page.locator("#amc-launch")).toHaveText(line);
  await page.locator("#amc-drawer .acv2-drawer-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await testInfo.attach("confirmation-card", { body: await page.screenshot(), contentType: "image/png" });
  await page.locator("#amc-close").click();
  await expect(page.locator("#amc-drawer")).toBeHidden();
  await expect(page.locator("#amc-rows .acv2-empty")).toBeVisible();
  await page.waitForTimeout(500);
  expect(starts(files)).toEqual([]);

  await page.getByRole("button", { name: "添加服务器" }).click();
  await fillLocalProgram(page, "local", testServerArgs(files), `SECRET_TOKEN=${SECRET_SENTINEL}`);
  await expect(page.locator("#amc-launch")).toHaveText(line);
  await page.getByRole("button", { name: "确认并添加" }).click();
  await expect(page.locator("#amc-note")).toHaveText("已添加，正在连接。");
  await expect(row(page, "local")).toContainText("已连接", LONG);
  await expect(row(page, "local")).toContainText("5 个");
  await expect(row(page, "local")).toContainText("未绑定");
  const status = page.locator("#amc-status .amc-kv");
  await expect(status).toContainText("catalog-test-server 1.4.2");
  await expect(status).toContainText(/协议\s*\d{4}-\d{2}-\d{2}/);
  await expect(status).toContainText("连接于");
  await expect(page.locator("#amc-used")).toContainText("还没有能力档绑定它。");
  expect(starts(files)).toHaveLength(1);
  await testInfo.attach("server-drawer", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("button", { name: "重新连接" }).click();
  await expect.poll(() => starts(files).length, LONG).toBe(2);
  await expect(row(page, "local")).toContainText("已连接", LONG);
  await page.locator("#amc-close").click();

  const broken = testServerFiles(work, "broken");
  fs.writeFileSync(broken.failFlag, "");
  await page.getByRole("button", { name: "添加服务器" }).click();
  await fillLocalProgram(page, "broken", testServerArgs(broken), `SECRET_TOKEN=${SECRET_SENTINEL}`);
  await expect(page.locator("#amc-launch")).toHaveText([process.execPath, ...testServerArgs(broken)].join(" "));
  await page.getByRole("button", { name: "确认并添加" }).click();
  await expect(row(page, "broken")).toContainText("连接失败", LONG);
  await expect(row(page, "broken")).toContainText("***");
  // The error line comes from the program; it is shown as text in the row and under 原因 (agent-console::REQ-005/AC-04).
  const markup = '<a href="https://evil.example/login">重新登录</a><img src="x">';
  await expect(row(page, "broken")).toContainText(markup);
  await expect(page.locator("#amc-rows a, #amc-rows img")).toHaveCount(0);
  await expect(row(page, "broken")).toContainText(/将于 \d{2}:\d{2}:\d{2} 自动重试/);
  await expect(page.locator("body")).not.toContainText(SECRET_SENTINEL);
  // The page follows the service every 2 seconds; an opened output tail must stay open across that refresh.
  await page.locator("#amc-status summary").click();
  await expect(page.locator("#amc-status details")).toHaveAttribute("open", "");
  // The program's output is shown as text: its markup creates no link or image (agent-console::REQ-005/AC-04).
  await expect(page.locator("#amc-status pre")).toContainText(markup);
  await expect(page.locator("#amc-status .amc-kv")).toContainText(markup);
  await expect(page.locator("#amc-status a, #amc-status img")).toHaveCount(0);
  await page.waitForTimeout(2_500);
  await expect(page.locator("#amc-status details")).toHaveAttribute("open", "");
  await testInfo.attach("failed-server", { body: await page.screenshot(), contentType: "image/png" });

  // The shell below 900px: a menu bar opens the sidebar, and the page never scrolls sideways.
  await page.locator("#amc-close").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".acv-menu-btn")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await testInfo.attach("narrow-table", { body: await page.screenshot(), contentType: "image/png" });
  await page.locator(".acv-menu-btn").click();
  await expect(page.locator(".acv-side")).toBeInViewport({ ratio: 1 });
  await testInfo.attach("narrow-sidebar", { body: await page.screenshot(), contentType: "image/png" });
});

test("reviews new and changed tools and switches tools off", async ({ page, fixtureServer }, testInfo) => {
  const work = workDirectory();
  const files = testServerFiles(work, "review");
  const markedUp = '<a href="https://example.com/old">old</a>';
  writeTools(files.tools, [{ ...LOOKUP, description: markedUp }]);
  await registerViaApi(fixtureServer, { name: "review", command: process.execPath, args: testServerArgs(files) });
  await page.goto(`${fixtureServer.url}/console/mcp`);
  await expect(row(page, "review")).toContainText("已连接", LONG);
  await page.locator('[data-open="review"]').click();

  writeTools(files.tools, [
    { ...LOOKUP, description: "Finds an item by name." },
    { name: "fresh", description: "Creates an item.", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
    { name: "pay", description: '<a href="https://example.com/x">link</a><img src="x">', inputSchema: { type: "object" }, _meta: { "anthropic/requiresUserInteraction": true } },
  ]);
  const tool = (name: string) => page.locator(".amc-tool").filter({ has: page.locator(`[data-tool="${name}"]`) });
  await expect(tool("fresh")).toContainText("新增，待复核", LONG);
  await expect(tool("lookup")).toContainText("定义有变化，待复核");
  await expect(tool("lookup")).toContainText(`变化的部分：说明；原说明：${markedUp}`);
  await expect(tool("pay")).toContainText("需人工确认，不提供");
  // Text from a server is shown as text: its markup creates no link or image (agent-console::REQ-005/AC-04).
  await expect(tool("pay")).toContainText('<a href="https://example.com/x">link</a><img src="x">');
  await expect(page.locator("#amc-tools a, #amc-tools img")).toHaveCount(0);
  await expect(tool("fresh")).not.toContainText("可能修改数据");
  await expect(page.getByRole("button", { name: "全部确认（3）" })).toBeVisible();
  await expect(page.locator("#amc-tools .acv2-completed")).toHaveCount(0);
  await testInfo.attach("tools-waiting-for-review", { body: await page.screenshot(), contentType: "image/png" });

  await tool("fresh").getByRole("button", { name: "确认" }).click();
  await expect(tool("fresh")).not.toContainText("待复核");
  await expect(page.getByRole("button", { name: /全部确认/ })).toBeVisible();
  await expect(row(page, "review")).toContainText("7 个（可用 5 个）");

  await page.locator('[data-tool="whoami"]').uncheck();
  await expect(row(page, "review")).toContainText("7 个（可用 4 个）");

  await page.locator('[data-f="trusted"]').check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(tool("fresh")).toContainText("可能修改数据");
  await expect(tool("lookup")).toContainText("只读");
  await expect(tool("env")).not.toContainText("只读");
  await expect(page.locator("#amc-status")).toContainText("采信（已标为可信服务器）");
  await testInfo.attach("trusted-marks", { body: await page.screenshot(), contentType: "image/png" });
});

test("changes a confirmed command and deletes an unattached server", async ({ page, fixtureServer }, testInfo) => {
  const work = workDirectory();
  const first = testServerFiles(work, "first");
  const second = testServerFiles(work, "second");
  writeTools(first.tools, [LOOKUP]);
  writeTools(second.tools, [{ ...LOOKUP, inputSchema: { type: "object", properties: { query: { type: "string" } } } }]);
  await registerViaApi(fixtureServer, { name: "moving", command: process.execPath, args: testServerArgs(first), env: { SECRET_TOKEN: SECRET_SENTINEL } });
  await page.goto(`${fixtureServer.url}/console/mcp`);
  await expect(row(page, "moving")).toContainText("已连接", LONG);
  await page.locator('[data-open="moving"]').click();

  await expect(page.locator('[data-f="env"]')).toHaveValue("SECRET_TOKEN=••••••");
  await expect(page.locator('[data-f="name"]')).toBeDisabled();
  await expect(page.locator("#amc-launch")).toHaveCount(0);
  await page.locator('[data-f="args"]').fill(testServerArgs(second).join("\n"));
  await expect(page.locator("#amc-launch")).toHaveText([process.execPath, ...testServerArgs(second)].join(" "));
  await expect(page.locator("#amc-grant")).toContainText("登记后还要在团队管理里绑定到能力档，执行者才能使用；绑定时会再次确认。");
  await expect(page.locator("#amc-grant")).not.toContainText("已绑定到");
  await page.locator("#amc-drawer .acv2-drawer-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await testInfo.attach("command-change-card", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "确认并保存" }).click();
  await expect(page.locator("#amc-note")).toHaveText("已保存：新事务使用新配置。");
  await expect.poll(() => starts(second).length, LONG).toBe(1);
  // The form sent the saved value back as the placeholder, and the new program still received it.
  expect(starts(second)[0]!.secretToken).toBe(SECRET_SENTINEL);
  const lookup = page.locator(".amc-tool").filter({ has: page.locator('[data-tool="lookup"]') });
  await expect(lookup).toContainText("定义有变化，待复核", LONG);
  await expect(lookup).toContainText("变化的部分：参数");

  await page.getByRole("button", { name: "删除服务器" }).click();
  await expect(page.locator(".acf-inline-confirm")).toContainText("删除「moving」：断开连接，配置和已保存的凭证一并删除。");
  await testInfo.attach("delete-confirmation", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.locator("#amc-drawer")).toBeHidden();
  await expect(page.locator("#amc-rows .acv2-empty")).toBeVisible();
  const pid = starts(second)[0]!.pid;
  await expect.poll(() => isAlive(pid), LONG).toBe(false);
});

test("reconnects enabled servers when the service restarts", async () => {
  const work = workDirectory();
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-state-"));
  const files = testServerFiles(work, "kept");
  writeTools(files.tools, [LOOKUP]);
  const first = await startFixtureServer("fixture", "fixture", undefined, { stateDirectory });
  const port = Number(new URL(first.url).port);
  try {
    await registerViaApi(first, { name: "kept", command: process.execPath, args: testServerArgs(files) });
    await expect.poll(() => starts(files).length, LONG).toBe(1);
  } finally {
    await first.close();
  }

  const restarted = await startFixtureServer("fixture", "fixture", undefined, { stateDirectory, port });
  try {
    const cookie = await authorizeLocalService(stateDirectory);
    const state = async () => {
      const response = await fetch(`${restarted.url}/api/mcp/servers`, { headers: { cookie } });
      return (await response.json()).servers.map((server: { name: string; state: string }) => `${server.name}:${server.state}`);
    };
    await expect.poll(state, LONG).toEqual(["kept:connected"]);
    expect(starts(files)).toHaveLength(2);
  } finally {
    await restarted.close();
  }
});

test("registers a URL server with OAuth and DPoP after confirming its address", async ({ page, fixtureServer }, testInfo) => {
  const as = await startAuthorizationServer({ clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL, dpop: true });
  const remote = await startHttpTestServer({ requireHeaders: { "X-Api-Key": HEADER_SENTINEL }, authorizationServer: as });
  try {
    await page.goto(`${fixtureServer.url}/console/mcp`);
    await page.getByRole("button", { name: "添加服务器" }).click();
    await page.getByLabel("网址（Streamable HTTP）").check();
    await expect(page.locator('[data-f="command"]')).toHaveCount(0);
    await page.locator('[data-f="name"]').fill("remote");
    await page.locator('[data-f="url"]').fill(remote.url);
    await page.locator('[data-f="headers"]').fill(`X-Api-Key: ${HEADER_SENTINEL}`);
    await page.locator('[data-f="dpop"]').check();
    await page.locator('[data-f="issuer"]').fill(as.issuer);
    await page.locator('[data-f="clientId"]').fill("agent-console");
    await page.locator('[data-f="clientSecret"]').fill(CLIENT_SECRET_SENTINEL);
    await page.locator('[data-f="scope"]').fill("docs:read");
    await expect(page.locator("#amc-grant")).toContainText(`将连接：${remote.url}`);
    await expect(page.locator("#amc-launch")).toHaveText(remote.url);
    await page.locator("#amc-drawer .acv2-drawer-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await testInfo.attach("url-server-card", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "确认并添加" }).click();

    await expect(row(page, "remote")).toContainText("已连接", LONG);
    await expect(row(page, "remote")).toContainText(`网址${remote.url}`);
    await expect(page.locator("#amc-kind")).toContainText("网址（Streamable HTTP）");
    await expect(page.locator("#amc-status .amc-kv")).toContainText("认证OAuth client_credentials · 客户端 agent-console · DPoP");
    await expect(page.locator('[data-f="headers"]')).toHaveValue("X-Api-Key: ••••••");
    await expect(page.locator('[data-f="clientSecret"]')).toHaveValue("••••••");
    await expect(page.locator("body")).not.toContainText(HEADER_SENTINEL);
    expect(await page.content()).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(as.tokenRequests).toMatchObject([{ clientId: "agent-console", scope: "docs:read", dpop: true, granted: true }]);
    expect(remote.requests.filter((request) => request.scheme === "DPoP").length).toBeGreaterThan(0);
    await testInfo.attach("url-server-drawer", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await remote.close();
    await as.close();
  }
});

test("imports servers from JSON after confirming their commands and addresses", async ({ page, fixtureServer }, testInfo) => {
  const work = workDirectory();
  const local = testServerFiles(work, "local");
  const remote = await startHttpTestServer();
  try {
    await registerViaApi(fixtureServer, { name: "taken", command: process.execPath, args: testServerArgs(testServerFiles(work, "taken")) });
    await page.goto(`${fixtureServer.url}/console/mcp`);
    await page.getByRole("button", { name: "导入 JSON" }).click();
    await expect(page.locator("#amc-title")).toHaveText("导入 MCP 服务器");

    await page.locator("[data-json]").fill('{"mcpServers": ');
    await page.getByRole("button", { name: "检查" }).click();
    await expect(page.locator(".amc-import-error")).toHaveText("不是有效的 JSON");
    await expect(page.locator(".amc-import-result")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "检查" })).toBeVisible();
    await testInfo.attach("import-refused", { body: await page.screenshot(), contentType: "image/png" });

    const document = JSON.stringify({
      mcpServers: {
        local: { type: "stdio", command: process.execPath, args: testServerArgs(local), env: {} },
        remote: { type: "http", url: remote.url, headers: { "X-Api-Key": "${input:key}" } },
        taken: { command: "npx", args: ["taken"] },
        legacy: { type: "sse", url: "http://127.0.0.1:3845/sse" },
      },
    }, null, 2);
    const localLine = [process.execPath, ...testServerArgs(local)].join(" ");
    await page.locator("[data-json]").fill(document);
    await expect(page.locator(".amc-import-error")).toHaveCount(0);
    await page.getByRole("button", { name: "检查" }).click();
    const entries = page.locator(".amc-import-result li");
    await expect(entries).toHaveText([
      /将导入\s*local\s*本机程序 · 默认不可信、未绑定$/,
      /将导入\s*remote\s*网址 · 默认不可信、未绑定；需要填写：X-Api-Key$/,
      /跳过\s*taken\s*已有同名服务器$/,
      /跳过\s*legacy\s*SSE 传输，不支持$/,
    ]);
    const card = page.locator("#amc-import-out .acf-grant");
    await expect(card).toContainText(`本机将运行：${localLine}将连接：${remote.url}导入后默认不可信，还要在团队管理里绑定到能力档。`);
    await page.locator("#amc-drawer .acv2-drawer-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await testInfo.attach("import-card", { body: await page.screenshot(), contentType: "image/png" });

    await page.locator("#amc-close").click();
    await page.waitForTimeout(500);
    expect(starts(local)).toEqual([]);
    await expect(page.locator("#amc-rows tr")).toHaveCount(1);

    await page.getByRole("button", { name: "导入 JSON" }).click();
    await page.locator("[data-json]").fill(document);
    await page.getByRole("button", { name: "检查" }).click();
    await page.getByRole("button", { name: "确认并导入" }).click();
    await expect(page.locator("#amc-title")).toHaveText("local");
    await expect(page.locator("#amc-note")).toHaveText("已导入 2 个，正在连接。");
    await expect(row(page, "local")).toContainText("已连接", LONG);
    await expect(row(page, "remote")).toContainText("已连接", LONG);
    for (const name of ["local", "remote"]) await expect(row(page, name)).toContainText("未绑定");
    await expect(page.locator("#amc-status .amc-kv")).toContainText("不采信（未标为可信，一律按可能修改数据对待）");
    expect(starts(local)).toHaveLength(1);
    await testInfo.attach("imported", { body: await page.screenshot(), contentType: "image/png" });

    await page.locator("#amc-close").click();
    await page.locator('[data-open="remote"]').click();
    await expect(page.locator("#amc-status .amc-kv")).toContainText("认证请求头 X-Api-Key");
    await expect(page.locator('[data-f="headers"]')).toHaveValue("X-Api-Key: ");
    await expect(page.locator('[data-f="trusted"]')).not.toBeChecked();
  } finally {
    await remote.close();
  }
});
