import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { weixinPanelHtml } from "../src/panel-html.js";

const qrDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nNwAAAAASUVORK5CYII=";

describe("MCP Apps panel in a simulated Codex host", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("shows aliases, enforces confirmations, and keeps action feedback visible", async () => {
    const page = await browser.newPage();
    const diagnostics: string[] = [];
    page.on("console", (message) => diagnostics.push(`console:${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => diagnostics.push(`pageerror:${error.message}`));
    await page.setContent(`
      <iframe id="app" style="width:700px;height:900px"></iframe>
      <script>
        window.hostReady = true;
        window.toolCalls = [];
        let state = {
          phase: "configured",
          notice: "已连接；请确认最近入站目标。",
          accounts: [{ accountId: "fixture-bot", label: "我的微信" }],
          targets: [
            { accountId: "fixture-bot", target: "fixture-user@im.wechat", label: "最近联系人" },
            { accountId: "fixture-bot", target: "other-user@im.wechat", label: "另一位联系人" }
          ],
          selectedAccountId: null,
          selectedTarget: null,
          codex: {
            status: "idle",
            threadReady: true,
            enabledTargets: [{ accountId: "fixture-bot", target: "other-user@im.wechat" }],
            transcript: [], runs: [], notice: "独立任务已就绪。",
            permissions: { onboardingCompleted: false, mode: "safe", capability: { restrictedReadSupported: false }, candidates: [], selectedRoots: [], revision: 0, pendingCount: 0 }
          }
        };
        const texts = {
          get_weixin_state: "状态已刷新。",
          start_weixin_login: "已请求真实微信二维码。",
          confirm_weixin_session: "会话与目标已确认。",
          send_weixin_test_message: "渠道已接受发送请求，请在微信端确认是否收到。",
          open_weixin_codex_desktop_thread: "已请求 Codex Desktop 打开当前任务；原生页面可能提示任务正在其他位置运行。"
        };
        window.addEventListener("message", (event) => {
          const message = event.data;
          if (message?.jsonrpc !== "2.0" || message.id === undefined) return;
          if (message.method === "ui/initialize") {
            event.source.postMessage({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2026-01-26",
                hostInfo: { name: "fixture-codex", version: "1" },
                hostCapabilities: { serverTools: {} },
                hostContext: { theme: "light", displayMode: "inline" }
              }
            }, "*");
            return;
          }
          if (message.method !== "tools/call") return;
          const call = message.params;
          window.toolCalls.push(call);
          if (call.name === "start_weixin_login") {
            state = { ...state, phase: "awaiting_scan", notice: "等待扫码" };
          } else if (call.name === "confirm_weixin_session") {
            state = {
              ...state,
              phase: "ready",
              notice: "已确认会话与目标，可以发送测试消息。",
              selectedAccountId: call.arguments.accountId,
              selectedTarget: call.arguments.target
            };
          } else if (call.name === "send_weixin_test_message") {
            state = { ...state, phase: "sent", notice: "渠道已接受发送请求。" };
          }
          event.source.postMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: texts[call.name] || "操作已完成。" }],
              structuredContent: state,
              _meta: state.phase === "awaiting_scan" ? { qrDataUrl: ${JSON.stringify(qrDataUrl)} } : {}
            }
          }, "*");
        });
      </script>
    `);
    await page.locator("#app").evaluate((iframe, html) => {
      (iframe as HTMLIFrameElement).srcdoc = html;
    }, weixinPanelHtml);

    const panel = page.frameLocator("#app");
    await panel.locator("#account option").waitFor({ state: "attached", timeout: 5_000 }).catch(async () => {
      const host = await page.evaluate(() => ({
        ready: Boolean((window as typeof window & { hostReady?: boolean }).hostReady),
        calls: (window as typeof window & { toolCalls?: unknown[] }).toolCalls ?? [],
      }));
      const body = await panel.locator("body").textContent().catch(() => "no iframe body");
      throw new Error(
        `panel did not initialize: host=${JSON.stringify(host)} body=${body} ${diagnostics.join(" | ")}`,
      );
    });
    expect(await panel.locator("#account option").textContent()).toBe("我的微信");
    expect(await panel.locator("#target option").first().textContent()).toBe("最近联系人");

    await panel.getByRole("button", { name: "生成真实二维码" }).click();
    await panel.locator("#qrImage").waitFor({ state: "visible" });
    expect(await panel.locator("#feedback").textContent()).toBe("已请求真实微信二维码。");

    await panel.getByLabel("我确认刚刚已从这个微信目标给 bot 发过消息").check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await panel.locator("#send").waitFor({ state: "visible" });

    await page.waitForTimeout(2_200);
    expect(await panel.locator("#feedback").textContent()).toBe("会话与目标已确认。");

    await panel.locator("#target").selectOption("other-user@im.wechat");
    expect(await panel.getByLabel("我确认刚刚已从这个微信目标给 bot 发过消息").isChecked()).toBe(false);
    expect(await panel.locator("#send").isVisible()).toBe(false);
    await panel.getByLabel("我确认刚刚已从这个微信目标给 bot 发过消息").check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await panel.locator("#send").waitFor({ state: "visible" });

    expect(await panel.getByRole("button", { name: "在 Codex Desktop 中查看（实验）" }).isEnabled()).toBe(true);
    await panel.getByRole("button", { name: "在 Codex Desktop 中查看（实验）" }).click();
    await expect
      .poll(() => panel.locator("#feedback").textContent(), { timeout: 2_000 })
      .toContain("已请求 Codex Desktop");

    await panel.getByLabel("我确认将向上方选择的微信目标发送这条真实消息").check();
    expect(await panel.getByRole("button", { name: "发送测试消息" }).isEnabled()).toBe(true);
    await panel.getByRole("button", { name: "发送测试消息" }).click();
    await expect
      .poll(() => panel.locator("#feedback").textContent(), { timeout: 2_000 })
      .toBe("渠道已接受发送请求，请在微信端确认是否收到。");

    const calls = await page.evaluate(() => (window as typeof window & { toolCalls: unknown[] }).toolCalls);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "start_weixin_login" }),
        expect.objectContaining({
          name: "confirm_weixin_session",
          arguments: expect.objectContaining({ inboundConfirmed: true }),
        }),
        expect.objectContaining({
          name: "send_weixin_test_message",
          arguments: expect.objectContaining({ outboundConfirmed: true }),
        }),
        expect.objectContaining({
          name: "open_weixin_codex_desktop_thread",
          arguments: expect.objectContaining({
            accountId: "fixture-bot",
            target: "other-user@im.wechat",
          }),
        }),
      ]),
    );
    await page.close();
  }, 20_000);
});
