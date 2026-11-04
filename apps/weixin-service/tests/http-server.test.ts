import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
  DemoService,
  type ChannelSnapshot,
  type LocalLabelUpdate,
  type WeixinChannel,
} from "../src/demo-service.js";
import { createDemoServer } from "../src/http-server.js";
import type { PublicCodexServiceState } from "../src/weixin-codex-service.js";
import type { PublicDailyAiNewsState } from "../src/daily-ai-news-scheduler.js";

class HttpFakePort implements WeixinChannel {
  snapshot: ChannelSnapshot = {
    accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
    targets: [{ accountId: "bot-a", target: "user@im.wechat" }],
  };
  listener?: (snapshot: ChannelSnapshot) => void;
  async start(): Promise<void> {}
  getSnapshot() {
    return structuredClone(this.snapshot);
  }
  onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void): () => void {
    this.listener = listener;
    listener(this.getSnapshot());
    return () => {};
  }
  updateLocalLabels(input: LocalLabelUpdate): void {
    this.snapshot.accounts = this.snapshot.accounts.map((account) =>
      account.accountId === input.accountId
        ? { ...account, ...(input.accountLabel?.trim() ? { label: input.accountLabel.trim() } : {}) }
        : account,
    );
    this.snapshot.targets = this.snapshot.targets.map((target) =>
      target.accountId === input.accountId && target.target === input.target
        ? { ...target, ...(input.targetLabel?.trim() ? { label: input.targetLabel.trim() } : {}) }
        : target,
    );
    this.listener?.(this.getSnapshot());
  }
  startLogin() {
    return { submitPairCode() {}, terminate() {} };
  }
  async sendText() {
    return { ok: true, messageId: "m-1" };
  }
  close(): void {}
}

describe("HTTP server", () => {
  const servers: ReturnType<typeof createDemoServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  async function start(codex?: {
    getPublicState(): PublicCodexServiceState;
    enable(accountId: string, target: string): Promise<void>;
    disable(accountId: string, target: string): void;
    enableMemory(accountId: string): void;
    disableMemory(accountId: string): void;
    confirmMemoryNotificationTarget(accountId: string, target: string): void;
    openInCodexDesktop?(accountId: string, target: string): Promise<void>;
    enableVault(): void;
    disableVault(): void;
    configurePermissions(input: {
      mode: "safe" | "guarded_plus" | "advanced_controlled";
      rootIds: string[];
      confirmed: boolean;
    }): void;
    close(): void;
  }, dailyNews?: {
    getPublicState(): PublicDailyAiNewsState;
    preview(): Promise<void>;
    sendPreview(accountId: string, target: string): Promise<void>;
    retryNow(): Promise<void>;
    enable(accountId: string, target: string): Promise<void>;
    disable(): void;
    close(): void;
  }) {
    const service = new DemoService(
      new HttpFakePort(),
      async () => "data:image/svg+xml,safe",
      codex,
      dailyNews,
    );
    const server = createDemoServer(service);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const origin = `http://127.0.0.1:${address.port}`;
    return { service, origin };
  }

  it("passes a bounded custom text through the fixture-only inbound endpoint", async () => {
    class FixtureHttpPort extends HttpFakePort {
      received: string[] = [];
      async emitFixtureInbound(text?: string): Promise<void> {
        this.received.push(text ?? "fixture 首条消息");
      }
    }
    const port = new FixtureHttpPort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    const server = createDemoServer(service, { fixtureMode: true });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const origin = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${origin}/api/fixture/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ text: "把2026-08-12下的摘要文件发给我" }),
    });

    expect(response.status).toBe(200);
    expect(port.received).toEqual(["把2026-08-12下的摘要文件发给我"]);
  });

  it("previews, sends, enables and disables the daily AI news module", async () => {
    let enabled = false;
    let previewed = false;
    let sent = false;
    let retried = false;
    const dailyNews = {
      getPublicState: (): PublicDailyAiNewsState => ({
        status: enabled ? "idle" : "disabled",
        enabledTarget: enabled ? { accountId: "bot-a", target: "user@im.wechat" } : null,
        nextRunAt: enabled ? 1234 : null,
        lastRun: null,
        preview: null,
        previewMessage: previewed ? "preview" : null,
        archive: null,
        notice: sent ? "sent" : previewed ? "previewed" : "disabled",
      }),
      preview: async () => { previewed = true; },
      sendPreview: async () => { sent = true; },
      retryNow: async () => { retried = true; },
      enable: async () => { enabled = true; },
      disable: () => { enabled = false; },
      close: () => {},
    };
    const { origin } = await start(undefined, dailyNews);
    const post = (path: string, body: unknown = {}) => fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });

    expect((await post("/api/news/preview")).status).toBe(200);
    expect((await post("/api/news/retry")).status).toBe(200);
    expect((await post("/api/news/send-preview", {
      accountId: "bot-a",
      target: "user@im.wechat",
    })).status).toBe(200);
    expect((await post("/api/news/enable", {
      accountId: "bot-a",
      target: "user@im.wechat",
    })).status).toBe(200);
    await expect((await post("/api/news/disable")).json()).resolves.toMatchObject({
      dailyNews: { status: "disabled" },
    });
    expect(previewed).toBe(true);
    expect(sent).toBe(true);
    expect(retried).toBe(true);
  });

  it("enables and disables the dedicated Codex service but refuses the retired write switch", async () => {
    let enabled = false;
    let opened = false;
    let memoryEnabled = false;
    let memoryRetried = false;
    let reminderTarget: string | undefined;
    let modelSelection: unknown;
    let modelRefreshed = false;
    const codex = {
      getPublicState: (): PublicCodexServiceState => ({
        status: enabled ? "idle" : "disabled",
        threadReady: enabled,
        enabledTargets: enabled ? [{ accountId: "bot-a", target: "user@im.wechat" }] : [],
        transcript: [],
        runs: [],
        notice: enabled ? "ready" : "disabled",
        permissions: {
          onboardingCompleted: false,
          mode: "safe",
          capability: { restrictedReadSupported: false },
          candidates: [],
          selectedRoots: [],
          revision: 0,
          pendingCount: 0,
        },
      }),
      enable: async () => { enabled = true; },
      disable: () => { enabled = false; },
      enableMemory: () => { memoryEnabled = true; },
      disableMemory: () => { memoryEnabled = false; },
      confirmMemoryNotificationTarget: (_accountId: string, target: string) => { reminderTarget = target; },
      retryLatestMemoryFailure: () => { memoryRetried = true; return true; },
      openInCodexDesktop: async () => { opened = true; },
      enableVault: () => { throw new Error("旧写权限开关已停用；请在三档权限向导中重新授权"); },
      disableVault: () => {},
      configurePermissions: () => {},
      configureChatModel: (_accountId: string, selection: unknown) => { modelSelection = selection; },
      refreshModelCatalog: async () => { modelRefreshed = true; },
      close: () => {},
    };
    const { origin } = await start(codex);

    const enabledResponse = await fetch(`${origin}/api/codex/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a", target: "user@im.wechat" }),
    });
    expect(enabledResponse.status).toBe(200);
    await expect(enabledResponse.json()).resolves.toMatchObject({
      codex: { status: "idle", threadReady: true },
    });

    const disabledResponse = await fetch(`${origin}/api/codex/disable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a", target: "user@im.wechat" }),
    });
    expect(disabledResponse.status).toBe(200);
    await expect(disabledResponse.json()).resolves.toMatchObject({ codex: { status: "disabled" } });

    const openedResponse = await fetch(`${origin}/api/codex/desktop/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a", target: "user@im.wechat" }),
    });
    expect(openedResponse.status).toBe(200);
    expect(opened).toBe(true);
    expect(await openedResponse.text()).not.toContain("019fef94");

    const memoryEnabledResponse = await fetch(`${origin}/api/codex/memory/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a" }),
    });
    expect(memoryEnabledResponse.status).toBe(200);
    expect(memoryEnabled).toBe(true);

    const reminderTargetResponse = await fetch(`${origin}/api/codex/memory/notification-target`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a", target: "user@im.wechat" }),
    });
    expect(reminderTargetResponse.status).toBe(200);
    expect(reminderTarget).toBe("user@im.wechat");

    const memoryRetryResponse = await fetch(`${origin}/api/codex/memory/retry-latest-failed`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a" }),
    });
    expect(memoryRetryResponse.status).toBe(200);
    expect(memoryRetried).toBe(true);

    const memoryDisabledResponse = await fetch(`${origin}/api/codex/memory/disable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a" }),
    });
    expect(memoryDisabledResponse.status).toBe(200);
    expect(memoryEnabled).toBe(false);

    const modelResponse = await fetch(`${origin}/api/codex/model/configure`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ accountId: "bot-a", mode: "track", track: "fast", effort: "low" }),
    });
    expect(modelResponse.status).toBe(200);
    expect(modelSelection).toEqual({ mode: "track", track: "fast", effort: "low" });
    expect((await fetch(`${origin}/api/codex/model/refresh`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: "{}",
    })).status).toBe(200);
    expect(modelRefreshed).toBe(true);

    const vaultEnabledResponse = await fetch(`${origin}/api/codex/vault/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
    expect(vaultEnabledResponse.status).toBe(400);
    await expect(vaultEnabledResponse.json()).resolves.toMatchObject({
      error: "旧写权限开关已停用；请在三档权限向导中重新授权",
    });

    const vaultDisabledResponse = await fetch(`${origin}/api/codex/vault/disable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
    await expect(vaultDisabledResponse.json()).resolves.toMatchObject({
      codex: { permissions: { onboardingCompleted: false, mode: "safe" } },
    });
  });

  it("serves public state with no-store and no sensitive fields", async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/api/state`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    expect(body).not.toMatch(/context.?token|bot.?token|authorization/i);
    expect(JSON.parse(body)).toMatchObject({
      phase: "configured",
      accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
    });
  });

  it("serves automatic first-inbound binding guidance without manual confirmation controls", async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("收到后会自动绑定并回复问候");
    expect(html).toContain('id="auto-binding-feedback"');
    expect(html).not.toContain('id="inbound-confirmed"');
    expect(html).not.toContain("确认会话与目标");
  });

  it("renders all three permission modes and explains an unsupported strict-directory capability", async () => {
    const { origin } = await start({
      getPublicState: () => ({
        status: "disabled",
        threadReady: false,
        enabledTargets: [],
        transcript: [],
        runs: [],
        notice: "disabled",
        permissions: {
          onboardingCompleted: false,
          mode: "safe",
          capability: { restrictedReadSupported: false },
          candidates: [],
          selectedRoots: [],
          revision: 0,
          pendingCount: 0,
        },
      }),
      enable: async () => {},
      disable: () => {},
      enableMemory: () => {},
      disableMemory: () => {},
      confirmMemoryNotificationTarget: () => {},
      enableVault: () => {},
      disableVault: () => {},
      configurePermissions: () => {},
      close: () => {},
    });
    const html = await (await fetch(`${origin}/`)).text();

    expect(html).toContain("安全只读");
    expect(html).toContain("增强受控");
    expect(html).toContain("高级受控");
    expect(html).toContain("当前 Codex 版本不支持严格目录隔离");
    expect(html).toContain('id="permission-form"');
    expect(html).toContain('name="permission-mode"');
    expect(html).toContain('id="permission-roots"');
    expect(html).toContain('id="permission-confirmed"');
    expect(html).toContain('id="permission-submit"');
    expect(html).toContain('id="codex-runs"');
    expect(html).toContain("运行状态");
    expect(html).toContain('id="memory-summary"');
    expect(html).toContain('id="memory-diagnostics"');
    expect(html).toContain('id="memory-enable-button"');
    expect(html).toContain('id="memory-disable-button"');
    expect(html).toContain('id="memory-content"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="memory-tab"');
    expect(html).toContain('id="events-tab"');
    expect(html).toContain('id="memory-tabpanel"');
    expect(html).toContain('id="events-tabpanel"');
    expect(html).toContain('id="events-content"');
    expect(html).toContain("Memory Curator");
    expect(html).toContain('id="connection-app-tab"');
    expect(html).toContain('id="chat-app-tab"');
    expect(html).toContain('id="workflows-app-tab"');
    expect(html).toContain('id="permissions-app-tab"');
    expect(html).toContain('id="memory-app-tab"');
    expect(html).toContain('id="news-app-tab"');
    expect(html).toContain('id="connection-app-tabpanel"');
    expect(html).toContain('id="chat-app-tabpanel"');
    expect(html).toContain('id="workflows-app-tabpanel"');
    expect(html).toContain('id="permissions-app-tabpanel"');
    expect(html).toContain('id="memory-app-tabpanel"');
    expect(html).toContain('id="news-app-tabpanel"');
    expect(html).toContain('id="app-tab-content"');
    expect(html).toContain('id="workflow-run-list"');
    expect(html).toContain('id="workflow-run-detail"');
    expect(html).toContain('id="workflow-filter-all"');
    expect(html).toContain('id="workflow-filter-attention"');
    expect(html).toContain('id="memory-account-summary"');
    expect(html).toContain('id="memory-current-account"');
    expect(html).toContain('id="memory-current-target"');
    expect(html).toContain('id="memory-account-status"');
    expect(html).toContain('id="memory-target-status"');
    expect(html).toContain('id="memory-feedback"');
    expect(html.indexOf('id="memory-feedback"')).toBeLessThan(html.indexOf('id="memory-tab"'));
    expect(html).not.toContain("不是模拟，也不经过 OpenClaw");
    expect(html).not.toContain('id="vault-enable-button"');
  });

  it("fails closed when onboarding is submitted without strict read-root support", async () => {
    const codex = {
      getPublicState: (): PublicCodexServiceState => ({
        status: "disabled",
        threadReady: false,
        enabledTargets: [],
        transcript: [],
        runs: [],
        notice: "disabled",
        permissions: {
          onboardingCompleted: false,
          mode: "safe",
          capability: { restrictedReadSupported: false },
          candidates: [{ id: "workspace", displayName: "工作区", path: "/workspace" }],
          selectedRoots: [],
          revision: 0,
          pendingCount: 0,
        },
      }),
      enable: async () => {},
      disable: () => {},
      enableMemory: () => {},
      disableMemory: () => {},
      confirmMemoryNotificationTarget: () => {},
      enableVault: () => {},
      disableVault: () => {},
      configurePermissions: () => {
        throw new Error("当前 Codex 版本不支持严格目录隔离；不能启用三档权限");
      },
      close: () => {},
    };
    const { origin } = await start(codex);
    const response = await fetch(`${origin}/api/codex/permissions/configure`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        mode: "guarded_plus",
        rootIds: ["workspace"],
        confirmed: true,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "当前 Codex 版本不支持严格目录隔离；不能启用三档权限",
    });
  });

  it("rejects cross-origin writes and accepts an exact same-origin confirmation", async () => {
    const { origin } = await start();
    const payload = {
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    };
    const blocked = await fetch(`${origin}/api/session/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(payload),
    });
    expect(blocked.status).toBe(403);

    const discovery = await fetch(`${origin}/api/session/discover`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
    expect(discovery.status).toBe(200);

    const allowed = await fetch(`${origin}/api/session/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(payload),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ phase: "ready" });
  });

  it("rejects oversized JSON bodies", async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ message: "x".repeat(65 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it("updates local aliases without exposing private channel credentials", async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/api/labels`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        accountId: "bot-a",
        accountLabel: "我的微信",
        target: "user@im.wechat",
        targetLabel: "我的会话",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      accounts: [{ label: "我的微信" }],
      targets: [{ label: "我的会话" }],
    });
    expect(body).not.toMatch(/context.?token|bot.?token|authorization/i);
  });

  it("returns recent inbound targets without returning channel logs", async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/api/session/discover`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
    const body = await response.text();

    expect(JSON.parse(body).targets).toEqual([
      { accountId: "bot-a", target: "user@im.wechat" },
    ]);
    expect(body).not.toContain("inbound message:");
  });
});
