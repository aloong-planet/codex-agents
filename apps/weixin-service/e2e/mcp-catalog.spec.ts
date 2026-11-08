import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import { SECRET_SENTINEL, isAlive, starts, testServerArgs, testServerFiles, writeTools } from "../tests/fixtures/mcp-test-server-control.js";
import { test } from "./fixtures.js";

// MCP 管理 (docs/specs/mcp-catalog.md) in a real browser, against the fixture service and real local MCP programs.
// Rules are covered by tests/mcp-catalog-rules.test.ts and the catalog by tests/mcp-catalog.test.ts; these journeys
// check that the page, the API and the service's connections are wired together.
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

  await expect(page.locator(".acv-side-nav .acv-nav-item")).toHaveCount(1);
  await expect(page.locator('.acv-nav-item[aria-current="page"]')).toHaveText("MCP 管理");
  await expect(page.getByRole("button", { name: "添加服务器" })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回团队管理" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导入 JSON" })).toHaveCount(0);
  await expect(page.locator("#amc-rows .acv2-empty")).toHaveText(/还没有 MCP 服务器。\s*点「添加服务器」登记本机程序。/);
  await testInfo.attach("empty-table", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("button", { name: "添加服务器" }).click();
  await expect(page.locator("#amc-title")).toHaveText("添加 MCP 服务器");
  await expect(page.locator("#amc-form .acv-req")).toHaveCount(2);
  await expect(page.locator("#amc-form .acv-opt")).toHaveCount(4);
  await expect(page.locator("#amc-form .acv-tip-btn")).not.toHaveCount(0);
  await expect(page.locator('#amc-form input[type="radio"]')).toHaveCount(0);
  await expect(page.locator('[data-f="timeout"]')).toHaveAttribute("placeholder", "60");
  await expect(page.locator('[data-f="trusted"]')).not.toBeChecked();
  await expect(page.locator('[data-f="enabled"]')).toBeChecked();
  await page.locator('[data-f="sandbox"]').check();
  await expect(page.locator('[data-f="sbDomains"], [data-f="sbRead"], [data-f="sbWrite"]')).toHaveCount(3);
  await page.locator('[data-f="sandbox"]').uncheck();

  const line = [process.execPath, ...testServerArgs(files)].join(" ");
  await fillLocalProgram(page, "local", testServerArgs(files), `SECRET_TOKEN=${SECRET_SENTINEL}`);
  await expect(page.locator("#amc-launch")).toHaveText(line);
  await page.locator(".acv2-drawer-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
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
  await expect(row(page, "broken")).toContainText(/将于 \d{2}:\d{2}:\d{2} 自动重试/);
  await expect(page.locator("body")).not.toContainText(SECRET_SENTINEL);
  // The page follows the service every 2 seconds; an opened output tail must stay open across that refresh.
  await page.locator("#amc-status summary").click();
  await expect(page.locator("#amc-status details")).toHaveAttribute("open", "");
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
  writeTools(files.tools, [LOOKUP]);
  await registerViaApi(fixtureServer, { name: "review", command: process.execPath, args: testServerArgs(files) });
  await page.goto(`${fixtureServer.url}/console/mcp`);
  await expect(row(page, "review")).toContainText("已连接", LONG);
  await page.locator('[data-open="review"]').click();

  writeTools(files.tools, [
    { ...LOOKUP, description: "Finds an item by name." },
    { name: "fresh", description: "Creates an item.", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
    { name: "pay", description: "Confirms a payment.", inputSchema: { type: "object" }, _meta: { "anthropic/requiresUserInteraction": true } },
  ]);
  const tool = (name: string) => page.locator(".amc-tool").filter({ has: page.locator(`[data-tool="${name}"]`) });
  await expect(tool("fresh")).toContainText("新增，待复核", LONG);
  await expect(tool("lookup")).toContainText("定义有变化，待复核");
  await expect(tool("lookup")).toContainText("变化的部分：说明；原说明：Finds an item.");
  await expect(tool("pay")).toContainText("需人工确认，不提供");
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
  await page.locator(".acv2-drawer-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await testInfo.attach("command-change-card", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "确认并保存" }).click();
  await expect(page.locator("#amc-note")).toHaveText("已保存：新事务使用新配置。");
  await expect.poll(() => starts(second).length, LONG).toBe(1);
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
