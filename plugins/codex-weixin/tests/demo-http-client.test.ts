import { describe, expect, it, vi } from "vitest";

import { DemoHttpClient } from "../src/demo-http-client.js";

describe("DemoHttpClient", () => {
  it("returns a model-safe snapshot without exposing QR image data", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          phase: "awaiting_scan",
          notice: "真实二维码已生成",
          qrDataUrl: "data:image/png;base64,private-qr",
          accounts: [{ accountId: "bot-a", label: "我的微信", credentialStatus: "usable" }],
          targets: [],
          codex: {
            status: "idle",
            threadReady: true,
            enabledTargets: [{ accountId: "bot-a", target: "user@im.wechat" }],
            notice: "等待消息",
            permissions: {
              onboardingCompleted: false,
              mode: "safe",
              capability: { restrictedReadSupported: false },
              candidates: [{ id: "workspace", displayName: "工作区", path: "/private/workspace" }],
              selectedRoots: [],
              revision: 0,
              pendingCount: 0,
            },
            transcript: [{ text: "private inbound message" }],
          },
          dailyNews: { previewMessage: "private draft" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new DemoHttpClient("http://127.0.0.1:4317", fetchFn);

    const result = await client.getState();

    expect(result.modelState).toEqual({
      phase: "awaiting_scan",
      notice: "真实二维码已生成",
      accounts: [{ accountId: "bot-a", label: "我的微信", credentialStatus: "usable" }],
      targets: [],
      codex: {
        status: "idle",
        threadReady: true,
        enabledTargets: [{ accountId: "bot-a", target: "user@im.wechat" }],
        notice: "等待消息",
        permissions: {
          onboardingCompleted: false,
          mode: "safe",
          restrictedReadSupported: false,
          selectedRoots: [],
          revision: 0,
          pendingCount: 0,
        },
      },
    });
    expect(result.privateUi).toEqual({
      qrDataUrl: "data:image/png;base64,private-qr",
      permissionCandidates: [{ id: "workspace", displayName: "工作区", path: "/private/workspace" }],
    });
    expect(JSON.stringify(result.modelState)).not.toMatch(
      /private-qr|qrDataUrl|private inbound message|private draft|private\/workspace|transcript|previewMessage/,
    );
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:4317/api/state", {
      headers: { accept: "application/json" },
    });
  });

  it("rejects non-loopback endpoints and drops non-image QR values", async () => {
    expect(() => new DemoHttpClient("https://example.com")).toThrow(/loopback/);
    expect(() => new DemoHttpClient("http://127.0.0.1:4317/private")).toThrow(/格式无效/);

    const client = new DemoHttpClient(
      "http://localhost:4317",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            phase: "awaiting_scan",
            notice: "等待扫码",
            qrDataUrl: "https://example.com/private-qr",
            accounts: [],
            targets: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(client.getState()).resolves.toMatchObject({ privateUi: { qrDataUrl: null } });
  });

  it("starts login through the existing same-origin write boundary", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          phase: "login_starting",
          notice: "正在请求二维码",
          qrDataUrl: null,
          accounts: [],
          targets: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new DemoHttpClient("http://127.0.0.1:4317", fetchFn);

    await client.startLogin();

    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:4317/api/login/start", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "http://127.0.0.1:4317",
      },
      body: "{}",
    });
  });

  it("proxies channel and Codex relay controls through fixed endpoints", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          phase: "ready",
          notice: "ok",
          qrDataUrl: null,
          accounts: [],
          targets: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new DemoHttpClient("http://127.0.0.1:4317", fetchFn);

    await client.submitPairCode("123456");
    await client.discoverTargets();
    await client.confirmSession("bot-a", "user@im.wechat", true);
    await client.sendTestMessage("你好");
    await client.enableCodex("bot-a", "user@im.wechat");
    await client.disableCodex("bot-a", "user@im.wechat");
    await client.openCodexDesktop("bot-a", "user@im.wechat");
    await client.configurePermissions("guarded_plus", ["workspace"], true);

    expect(fetchFn.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
      ["http://127.0.0.1:4317/api/login/code", '{"code":"123456"}'],
      ["http://127.0.0.1:4317/api/session/discover", "{}"],
      [
        "http://127.0.0.1:4317/api/session/confirm",
        '{"accountId":"bot-a","target":"user@im.wechat","inboundConfirmed":true}',
      ],
      ["http://127.0.0.1:4317/api/send", '{"message":"你好"}'],
      ["http://127.0.0.1:4317/api/codex/enable", '{"accountId":"bot-a","target":"user@im.wechat"}'],
      ["http://127.0.0.1:4317/api/codex/disable", '{"accountId":"bot-a","target":"user@im.wechat"}'],
      ["http://127.0.0.1:4317/api/codex/desktop/open", '{"accountId":"bot-a","target":"user@im.wechat"}'],
      [
        "http://127.0.0.1:4317/api/codex/permissions/configure",
        '{"mode":"guarded_plus","rootIds":["workspace"],"confirmed":true}',
      ],
    ]);
  });
  it("keeps its console credential and asks once for a different one after a 401", async () => {
    const seen: string[] = [];
    const credentials = {
      current: async () => "codex_console_4317=c1",
      renew: async (rejected: string) => {
        if (rejected !== "codex_console_4317=c1") throw new Error(`unexpected rejected credential ${rejected}`);
        return "codex_console_4317=c2";
      },
    };
    const state = () => new Response(
      JSON.stringify({ phase: "configured", notice: "", accounts: [], targets: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const responses = [new Response("{}", { status: 401 }), state(), state()];
    const client = new DemoHttpClient("http://127.0.0.1:4317", async (_input, init) => {
      seen.push(new Headers(init?.headers).get("cookie") ?? "");
      return responses.shift()!;
    }, credentials);

    await expect(client.getState()).resolves.toMatchObject({ modelState: { phase: "configured" } });
    await client.getState();
    expect(seen).toEqual(["codex_console_4317=c1", "codex_console_4317=c2", "codex_console_4317=c2"]);
  });

  it("authorizes again on the next call after its first authorization failed", async () => {
    let attempts = 0;
    const client = new DemoHttpClient("http://127.0.0.1:4317", async () => new Response(
      JSON.stringify({ phase: "configured", notice: "", accounts: [], targets: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ), {
      current: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("微信 Demo 未运行，无法取得本机授权");
        return "codex_console_4317=c1";
      },
      renew: async () => "codex_console_4317=c2",
    });

    await expect(client.getState()).rejects.toThrow("微信 Demo 未运行");
    await expect(client.getState()).resolves.toMatchObject({ modelState: { phase: "configured" } });
  });

  it("reports the refusal when the renewed credential is refused as well", async () => {
    const seen: string[] = [];
    const client = new DemoHttpClient("http://127.0.0.1:4317", async (_input, init) => {
      seen.push(new Headers(init?.headers).get("cookie") ?? "");
      return new Response(JSON.stringify({ error: "需要本机授权" }), { status: 401 });
    }, { current: async () => "codex_console_4317=c1", renew: async () => "codex_console_4317=c2" });

    await expect(client.getState()).rejects.toThrow("微信 Demo 状态请求失败（HTTP 401）");
    expect(seen).toEqual(["codex_console_4317=c1", "codex_console_4317=c2"]);
  });
});
