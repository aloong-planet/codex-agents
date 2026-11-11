import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processWaitLimitMs } from "../../../apps/weixin-service/tests/support/process-wait.js";
import { weixinPanelHtml } from "../src/panel-html.js";

const qrDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nNwAAAAASUVORK5CYII=";

const inboundConfirmation = "我确认刚刚已从这个微信目标给 bot 发过消息";
const sendConfirmation = "我确认将向上方选择的微信目标发送这条真实消息";
const fixtureTargets = [
  { accountId: "fixture-bot", target: "fixture-user@im.wechat", label: "最近联系人" },
  { accountId: "fixture-bot", target: "other-user@im.wechat", label: "另一位联系人" },
];

type HostWindow = typeof window & {
  hostReady?: boolean;
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  pushState: (patch: Record<string, unknown>) => void;
};

/** The panel renders in Chrome, another process, so every read of its state waits (tests/support/process-wait.ts). */
const eventually = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: processWaitLimitMs });

/** Opens the panel in a simulated Codex host whose state starts as the fixture's, with `initial` merged over it. */
const openPanel = async (browser: Browser, initial: Record<string, unknown> = {}) => {
  const page: Page = await browser.newPage();
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
        targets: ${JSON.stringify(fixtureTargets)},
        selectedAccountId: null,
        selectedTarget: null,
        codex: {
          status: "idle",
          threadReady: true,
          enabledTargets: [{ accountId: "fixture-bot", target: "other-user@im.wechat" }],
          transcript: [], runs: [], notice: "独立任务已就绪。",
          permissions: { onboardingCompleted: false, mode: "safe", capability: { restrictedReadSupported: false }, candidates: [], selectedRoots: [], revision: 0, pendingCount: 0 }
        },
        ...${JSON.stringify(initial)}
      };
      const texts = {
        get_weixin_state: "状态已刷新。",
        start_weixin_login: "已请求真实微信二维码。",
        confirm_weixin_session: "会话与目标已确认。",
        send_weixin_test_message: "渠道已接受发送请求，请在微信端确认是否收到。",
        open_weixin_codex_desktop_thread: "已请求 Codex Desktop 打开当前任务；原生页面可能提示任务正在其他位置运行。"
      };
      window.pushState = (patch) => {
        state = { ...state, ...patch };
        document.getElementById("app").contentWindow.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [], structuredContent: state }
        }, "*");
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

  const panel: FrameLocator = page.frameLocator("#app");
  await panel.locator("#account option").first().waitFor({ state: "attached", timeout: processWaitLimitMs }).catch(async () => {
    const host = await page.evaluate(() => ({
      ready: Boolean((window as HostWindow).hostReady),
      calls: (window as HostWindow).toolCalls ?? [],
    }));
    const body = await panel.locator("body").textContent().catch(() => "no iframe body");
    throw new Error(
      `panel did not initialize: host=${JSON.stringify(host)} body=${body} ${diagnostics.join(" | ")}`,
    );
  });

  let pushes = 0;
  return {
    page,
    panel,
    /**
     * Changes the host's state and pushes it to the panel as a tool result, the update a silent poll also
     * delivers, then waits until the panel has rendered it.
     */
    pushState: async (patch: Record<string, unknown>) => {
      pushes += 1;
      const notice = `宿主状态更新 ${pushes}`;
      await page.evaluate((next) => (window as HostWindow).pushState(next), { ...patch, notice });
      await eventually(() => panel.locator("#notice").textContent()).toBe(notice);
    },
    confirmedSessions: () =>
      page.evaluate(() =>
        (window as HostWindow).toolCalls
          .filter((call) => call.name === "confirm_weixin_session")
          .map((call) => ({ accountId: call.arguments?.accountId, target: call.arguments?.target })),
      ),
  };
};

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
    const { page, panel, pushState, confirmedSessions } = await openPanel(browser);
    await eventually(() => panel.locator("#account option").textContent()).toBe("我的微信");
    await eventually(() => panel.locator("#target option").first().textContent()).toBe("最近联系人");

    await panel.getByRole("button", { name: "生成真实二维码" }).click();
    await panel.locator("#qrImage").waitFor({ state: "visible" });
    await eventually(() => panel.locator("#feedback").textContent()).toBe("已请求真实微信二维码。");

    await panel.getByLabel(inboundConfirmation).check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await panel.locator("#send").waitFor({ state: "visible" });

    await page.waitForTimeout(2_200);
    await eventually(() => panel.locator("#feedback").textContent()).toBe("会话与目标已确认。");

    await panel.locator("#target").selectOption("other-user@im.wechat");
    await eventually(() => panel.getByLabel(inboundConfirmation).isChecked()).toBe(false);
    await eventually(() => panel.locator("#send").isVisible()).toBe(false);
    // A state update between choosing a target and confirming it keeps the choice.
    await pushState({});
    await panel.getByLabel(inboundConfirmation).check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await eventually(confirmedSessions).toEqual([
      { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
      { accountId: "fixture-bot", target: "other-user@im.wechat" },
    ]);
    await panel.locator("#send").waitFor({ state: "visible" });

    await eventually(() => panel.getByRole("button", { name: "在 Codex Desktop 中查看（实验）" }).isEnabled()).toBe(true);
    await panel.getByRole("button", { name: "在 Codex Desktop 中查看（实验）" }).click();
    await eventually(() => panel.locator("#feedback").textContent()).toContain("已请求 Codex Desktop");

    await panel.getByLabel(sendConfirmation).check();
    await eventually(() => panel.getByRole("button", { name: "发送测试消息" }).isEnabled()).toBe(true);
    await panel.getByRole("button", { name: "发送测试消息" }).click();
    await eventually(() => panel.locator("#feedback").textContent()).toBe("渠道已接受发送请求，请在微信端确认是否收到。");

    const calls = await page.evaluate(() => (window as HostWindow).toolCalls);
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

  it("keeps a switched account through state updates until it is confirmed, then follows the service again", async () => {
    const { page, panel, pushState, confirmedSessions } = await openPanel(browser, {
      accounts: [
        { accountId: "fixture-bot", label: "我的微信" },
        { accountId: "work-bot", label: "工作微信" },
      ],
    });
    await panel.getByLabel(inboundConfirmation).check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await panel.locator("#send").waitFor({ state: "visible" });

    // The chosen account has no target until its first inbound message arrives.
    await panel.locator("#account").selectOption("work-bot");
    await panel.getByLabel(inboundConfirmation).check();
    await pushState({});
    await pushState({
      targets: [...fixtureTargets, { accountId: "work-bot", target: "work-user@im.wechat", label: "工作联系人" }],
    });
    // A tick given before the account had a target does not carry over to the target that arrived.
    await eventually(() => panel.getByLabel(inboundConfirmation).isChecked()).toBe(false);
    await panel.getByLabel(inboundConfirmation).check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await eventually(confirmedSessions).toEqual([
      { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
      { accountId: "work-bot", target: "work-user@im.wechat" },
    ]);
    await panel.locator("#send").waitFor({ state: "visible" });
    await panel.getByLabel(sendConfirmation).check();

    // The service confirms another session, as a confirm made elsewhere would.
    await pushState({ selectedAccountId: "fixture-bot", selectedTarget: "fixture-user@im.wechat" });
    await eventually(() => panel.locator("#account").inputValue()).toBe("fixture-bot");
    await eventually(() => panel.getByLabel(inboundConfirmation).isChecked()).toBe(false);
    await eventually(() => panel.getByLabel(sendConfirmation).isChecked()).toBe(false);
    await eventually(() => panel.getByRole("button", { name: "发送测试消息" }).isEnabled()).toBe(false);
    await page.close();
  });

  it("drops a switched target whose option disappears and leaves nothing confirmed for it", async () => {
    const { page, panel, pushState, confirmedSessions } = await openPanel(browser);
    await panel.getByLabel(inboundConfirmation).check();
    await panel.getByRole("button", { name: "确认会话与目标" }).click();
    await panel.locator("#send").waitFor({ state: "visible" });

    await panel.locator("#target").selectOption("other-user@im.wechat");
    await panel.getByLabel(inboundConfirmation).check();
    await pushState({ targets: fixtureTargets.filter((item) => item.target !== "other-user@im.wechat") });
    await eventually(() => panel.locator("#target").inputValue()).toBe("fixture-user@im.wechat");
    await eventually(() => panel.getByLabel(inboundConfirmation).isChecked()).toBe(false);

    // The option coming back does not bring the dropped choice back.
    await pushState({ targets: fixtureTargets });
    await eventually(() => panel.locator("#target").inputValue()).toBe("fixture-user@im.wechat");
    expect(await confirmedSessions()).toEqual([{ accountId: "fixture-bot", target: "fixture-user@im.wechat" }]);
    await page.close();
  });
});
