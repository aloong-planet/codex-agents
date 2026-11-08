import { expect } from "@playwright/test";

import { requestConsoleControl } from "../src/console-control.js";
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
