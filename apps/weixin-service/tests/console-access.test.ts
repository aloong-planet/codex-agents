// Coverage gaps (agent-console spec, failure modes): the browser's enforcement of the 400-day cookie lifetime
// cannot be observed here; H3 and H6 assert the Max-Age attribute that carries it.
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { exchangeLoginLink } from "../e2e/console-session.js";
import { createChannelStatusServer } from "../src/channel-status-server.js";
import { browserLabel, ConsoleAccess } from "../src/console-access.js";
import { DemoService } from "../src/demo-service.js";
import { FixturePort } from "../src/fixture-port.js";
import { createDemoServer } from "../src/http-server.js";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const EDGE_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const HEADLESS_CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.0 Safari/537.36";

const CARD_TITLE = "需要本机授权";
const EXPIRED_NOTICE = "这条登录链接已失效：超过 2 分钟或已经用过。请重新运行登录命令。";
const REVOKED_NOTICE = "本浏览器的授权已收回，打开的页面已断开。";
const SETTINGS_PAGE_MARKER = 'id="connection-app-tab"';
// 400 days × 86 400 seconds, computed by hand.
const MAX_AGE = "Max-Age=34560000";

// From `grep -o 'url.pathname === "[^"]*"' src/http-server.ts | sort -u`, without the GET-only /api/state.
const POST_ROUTES = [
  "/api/codex/desktop/open", "/api/codex/disable", "/api/codex/enable", "/api/codex/memory/disable",
  "/api/codex/memory/enable", "/api/codex/memory/notification-target", "/api/codex/memory/retry-latest-failed",
  "/api/codex/model/configure", "/api/codex/model/refresh", "/api/codex/permissions/configure",
  "/api/codex/vault/disable", "/api/codex/vault/enable", "/api/fixture/feishu/inbound", "/api/fixture/inbound",
  "/api/fixture/workflow/inbound", "/api/labels", "/api/login/code", "/api/login/start",
  "/api/media-exports/configure", "/api/news/disable", "/api/news/enable", "/api/news/preview", "/api/news/retry",
  "/api/news/send-preview", "/api/send", "/api/session/confirm", "/api/session/discover",
  "/api/workflows/module-permissions/configure",
];

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string; socket: Socket };

function raw(port: number, input: {
  method?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
  agent?: http.Agent;
} = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: input.method ?? "GET",
      path: input.path ?? "/",
      agent: input.agent ?? false,
      headers: { host: input.host ?? `127.0.0.1:${port}`, ...input.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        socket: request.socket!,
      }));
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

function setCookies(response: RawResponse): string[] {
  return response.headers["set-cookie"] ?? [];
}

describe("browser label", () => {
  it.each([
    [CHROME_MAC, "Chrome · macOS"],
    [SAFARI_MAC, "Safari · macOS"],
    [EDGE_WINDOWS, "Edge · Windows"],
    [FIREFOX_LINUX, "Firefox · Linux"],
    [HEADLESS_CHROME_MAC, "Chrome · macOS"],
    ["node", "浏览器"],
    ["", "浏览器"],
  ])("names %j as %s", (userAgent, label) => {
    expect(browserLabel(userAgent)).toBe(label);
  });
});

describe("console access at the local HTTP boundary", () => {
  const servers: http.Server[] = [];
  const directories: string[] = [];
  const agents: http.Agent[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.destroy();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function stateDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "console-access-"));
    directories.push(directory);
    return path.join(directory, "state");
  }

  async function listen(server: http.Server, port = 0): Promise<number> {
    servers.push(server);
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    return address.port;
  }

  async function start(options: { fixtureMode?: boolean; now?: () => number; directory?: string; port?: number } = {}) {
    const directory = options.directory ?? stateDirectory();
    const access = new ConsoleAccess({ directory, ...(options.now ? { now: options.now } : {}) });
    const service = new DemoService(new FixturePort(), async () => "data:image/svg+xml,safe");
    const server = createDemoServer(service, { access, ...(options.fixtureMode ? { fixtureMode: true } : {}) });
    const port = await listen(server, options.port);
    const origin = `http://127.0.0.1:${port}`;
    const login = (userAgent?: string) => exchangeLoginLink(access.issueLoginLink(port).url, userAgent);
    return { access, server, port, origin, directory, login };
  }

  it("refuses every request whose Host is not this machine on the service's port, before any exchange", async () => {
    const { access, port, login } = await start({ fixtureMode: true });
    const cookie = await login();
    const link = new URL(access.issueLoginLink(port).url);
    const hosts = ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", "localhost"];
    const requests = [
      { path: "/" },
      { path: "/api/state" },
      { path: `${link.pathname}${link.search}` },
      { method: "POST", path: "/api/fixture/inbound", body: "{}" },
    ];
    for (const host of hosts) {
      for (const request of requests) {
        const response = await raw(port, {
          ...request,
          host,
          headers: { cookie, "content-type": "application/json", origin: `http://${host}` },
        });
        expect([host, request.path, response.status]).toEqual([host, request.path, 403]);
        expect(response.body).not.toMatch(/accounts|phase|codex/);
        expect(setCookies(response)).toEqual([]);
      }
    }
    // The refused link was never consumed: it still exchanges from the real Host.
    const exchanged = await raw(port, { path: `${link.pathname}${link.search}` });
    expect(exchanged.status).toBe(302);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await raw(port, { path: "/api/state", host, headers: { cookie } })).status).toBe(200);
    }
  });

  it("shows only the login card to an unauthorized browser and refuses every API route with 401", async () => {
    const { port, origin, login } = await start();
    for (const pathname of ["/", "/app.js", "/styles.css", "/favicon.ico", "/console"]) {
      const response = await raw(port, { path: pathname });
      expect([pathname, response.status]).toEqual([pathname, 401]);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      expect(response.body).toContain(`<h1 id="console-gate-title">${CARD_TITLE}</h1>`);
      expect(response.body).toContain("在这台电脑的终端运行工作台登录命令：<code>pnpm --filter @aloong-planet/codex-weixin-service console login</code>");
      expect(response.body).toContain("链接 2 分钟内有效，只能使用一次。");
      expect(response.body).not.toContain(SETTINGS_PAGE_MARKER);
      expect(response.body).not.toContain("<script");
      expect(response.body).not.toContain("测试账户");
    }
    expect(POST_ROUTES).toHaveLength(28);
    const apiCalls = [{ method: "GET", path: "/api/state" }, ...POST_ROUTES.map((pathname) => ({ method: "POST", path: pathname }))];
    for (const call of apiCalls) {
      const response = await raw(port, {
        ...call,
        headers: { origin, "content-type": "application/json" },
        ...(call.method === "POST" ? { body: JSON.stringify({ accountId: "fixture-bot", accountLabel: "被改的名字" }) } : {}),
      });
      expect([call.path, response.status]).toEqual([call.path, 401]);
      expect(JSON.parse(response.body)).toEqual({ error: "需要本机授权" });
    }
    const cookie = await login();
    const state = await raw(port, { path: "/api/state", headers: { cookie } });
    expect(JSON.parse(state.body).accounts).toEqual([expect.objectContaining({ accountId: "fixture-bot", label: "测试账户" })]);
  });

  it("exchanges a login link once for a strict HttpOnly cookie that opens the settings page", async () => {
    const { access, port } = await start();
    const link = new URL(access.issueLoginLink(port).url);
    expect(link.href).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/login\\?t=[0-9a-f]{48}$`));
    const first = await raw(port, { path: `${link.pathname}${link.search}`, headers: { cookie: "other_app=1" } });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/");
    expect(setCookies(first)).toHaveLength(1);
    expect(setCookies(first)[0]).toMatch(new RegExp(`^codex_console_${port}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/; ${MAX_AGE}$`));
    const cookie = `other_app=1; ${setCookies(first)[0]!.split(";")[0]}`;

    const page = await raw(port, { path: "/", headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain(SETTINGS_PAGE_MARKER);
    expect((await raw(port, { path: "/api/state", headers: { cookie } })).status).toBe(200);

    const second = await raw(port, { path: `${link.pathname}${link.search}` });
    expect(second.status).toBe(401);
    expect(second.body).toContain(EXPIRED_NOTICE);
    expect(setCookies(second)).toEqual([]);
  });

  it.each([
    ["opened just inside 2 minutes", 119_999, 302],
    ["opened just after 2 minutes", 120_001, 401],
  ] as const)("treats a login link %s by its lifetime", async (_name, elapsed, status) => {
    let clock = Date.parse("2026-11-08T04:00:00.000Z");
    const { access, port } = await start({ now: () => clock });
    const link = new URL(access.issueLoginLink(port).url);
    clock += elapsed;
    const response = await raw(port, { path: `${link.pathname}${link.search}` });
    expect(response.status).toBe(status);
    if (status === 401) {
      expect(response.body).toContain(EXPIRED_NOTICE);
      expect(setCookies(response)).toEqual([]);
    }
  });

  it("keeps an authorization across a restart while storing only a hash of the cookie", async () => {
    const first = await start();
    const cookie = await first.login();
    await new Promise<void>((resolve) => {
      first.server.closeAllConnections();
      first.server.close(() => resolve());
    });
    first.access.close();

    const restarted = await start({ directory: first.directory, port: first.port });
    expect((await raw(restarted.port, { path: "/api/state", headers: { cookie } })).status).toBe(200);
    const store = path.join(first.directory, "console-browsers.json");
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
    expect(fs.statSync(first.directory).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(store, "utf8")).not.toContain(cookie.split("=")[1]);
  });

  it("renews the cookie whenever an authorized page opens", async () => {
    const { port, login } = await start();
    const cookie = await login();
    const page = await raw(port, { path: "/", headers: { cookie } });
    expect(page.status).toBe(200);
    expect(setCookies(page)).toEqual([`${cookie}; HttpOnly; SameSite=Strict; Path=/; ${MAX_AGE}`]);
  });

  it("protects fixture routes outside fixture mode and keeps fixture-mode same-origin checks", async () => {
    const plain = await start();
    const cookie = await plain.login();
    const request = { method: "POST", path: "/api/fixture/inbound", body: "{}" };
    const headers = { origin: plain.origin, "content-type": "application/json" };
    expect((await raw(plain.port, { ...request, headers })).status).toBe(401);
    expect((await raw(plain.port, { ...request, headers: { ...headers, cookie } })).status).toBe(404);

    const fixture = await start({ fixtureMode: true });
    const crossOrigin = await raw(fixture.port, { ...request, headers: { origin: "https://evil.example", "content-type": "application/json" } });
    expect(crossOrigin.status).toBe(403);
  });

  it("disconnects a revoked browser's open connections and shows it the revoked notice", async () => {
    const { access, port, login } = await start();
    const a = await login(CHROME_MAC);
    const b = await login(SAFARI_MAC);
    const [agentA, agentB] = [new http.Agent({ keepAlive: true, maxSockets: 1 }), new http.Agent({ keepAlive: true, maxSockets: 1 })];
    agents.push(agentA, agentB);
    const openA = await raw(port, { path: "/api/state", headers: { cookie: a }, agent: agentA });
    const openB = await raw(port, { path: "/api/state", headers: { cookie: b }, agent: agentB });
    expect([openA.status, openB.status]).toEqual([200, 200]);
    const browsers = access.listBrowsers();
    expect(browsers.map((browser) => browser.label)).toEqual(["Chrome · macOS", "Safari · macOS"]);

    const closed = once(openA.socket, "close");
    expect(access.revoke(browsers[0]!.id, "local-command")).toEqual({ revoked: 1, auditFailed: false });
    await Promise.race([closed, delay(1_000).then(() => { throw new Error("revoked connection stayed open"); })]);

    const revokedPage = await raw(port, { path: "/", headers: { cookie: a } });
    expect(revokedPage.status).toBe(401);
    expect(revokedPage.body).toContain(REVOKED_NOTICE);
    expect(setCookies(revokedPage)).toEqual([`codex_console_${port}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`]);
    const stillB = await raw(port, { path: "/api/state", headers: { cookie: b }, agent: agentB });
    expect(stillB.status).toBe(200);
    expect(stillB.socket).toBe(openB.socket);

    const closedB = once(openB.socket, "close");
    expect(access.revoke("all", "local-command")).toEqual({ revoked: 1, auditFailed: false });
    await Promise.race([closedB, delay(1_000).then(() => { throw new Error("connection stayed open after revoking all"); })]);
    expect((await raw(port, { path: "/api/state", headers: { cookie: b } })).status).toBe(401);
    expect(access.listBrowsers()).toEqual([]);
  });

  it("replaces a re-authorized browser's record without closing its open connections", async () => {
    const { access, port, directory, login } = await start();
    const old = await login(CHROME_MAC);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    const open = await raw(port, { path: "/api/state", headers: { cookie: old }, agent });
    expect(open.status).toBe(200);
    const [before] = access.listBrowsers();

    const link = new URL(access.issueLoginLink(port).url);
    const exchanged = await raw(port, { path: `${link.pathname}${link.search}`, headers: { cookie: old, "user-agent": CHROME_MAC } });
    expect(exchanged.status).toBe(302);
    const renewed = setCookies(exchanged)[0]!.split(";")[0]!;

    const reused = await raw(port, { path: "/api/state", headers: { cookie: renewed }, agent });
    expect(reused.status).toBe(200);
    expect(reused.socket).toBe(open.socket);
    expect((await raw(port, { path: "/api/state", headers: { cookie: old } })).status).toBe(401);
    const browsers = access.listBrowsers();
    expect(browsers).toHaveLength(1);
    const audit = fs.readFileSync(path.join(directory, "console-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ by: "login-link", event: "browser_authorized", browser: { id: browsers[0]!.id }, replaced: [before!.id] });
  });

  it("appends each authorization and revocation to the audit file without secrets", async () => {
    let clock = Date.parse("2026-11-08T04:00:00.000Z");
    const { access, port, directory } = await start({ now: () => clock });
    const link = access.issueLoginLink(port).url;
    const cookie = await exchangeLoginLink(link, CHROME_MAC);
    const [browser] = access.listBrowsers();
    const storeText = fs.readFileSync(path.join(directory, "console-browsers.json"), "utf8");
    clock += 60_000;
    access.revoke(browser!.id, "local-command");

    const audit = path.join(directory, "console-audit.jsonl");
    const text = fs.readFileSync(audit, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { at: "2026-11-08T04:00:00.000Z", by: "login-link", event: "browser_authorized", browser: { id: browser!.id, label: "Chrome · macOS" } },
      { at: "2026-11-08T04:01:00.000Z", by: "local-command", event: "browser_revoked", browsers: [{ id: browser!.id, label: "Chrome · macOS" }] },
    ]);
    expect(fs.statSync(audit).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(cookie.split("=")[1]);
    expect(text).not.toContain(new URL(link).searchParams.get("t"));
    expect(storeText).toMatch(/"hash":"[0-9a-f]{64}"/);
    for (const hash of storeText.match(/[0-9a-f]{64}/g) ?? []) expect(text).not.toContain(hash);
  });

  it.each([
    ["its audit entry cannot be written", "audit"],
    ["the browser store cannot be written", "store"],
  ] as const)("refuses an authorization when %s", async (_name, failing) => {
    const directory = stateDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const audit = path.join(directory, "console-audit.jsonl");
    if (failing === "audit") {
      fs.writeFileSync(audit, "");
      fs.chmodSync(audit, 0o400);
    } else {
      // A directory where the store file belongs makes the store's atomic rename fail.
      fs.mkdirSync(path.join(directory, "console-browsers.json"));
    }
    try {
      const { access, port } = await start({ directory });
      const link = new URL(access.issueLoginLink(port).url);
      const response = await raw(port, { path: `${link.pathname}${link.search}` });
      expect(response.status).toBe(500);
      expect(setCookies(response)).toEqual([]);
      expect(access.listBrowsers()).toEqual([]);
    } finally {
      if (failing === "audit") fs.chmodSync(audit, 0o600);
    }
  });

  it("applies a revocation and closes its connections even when the audit entry cannot be written", async () => {
    const { access, port, directory, login } = await start();
    const cookie = await login(CHROME_MAC);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    const open = await raw(port, { path: "/api/state", headers: { cookie }, agent });
    expect(open.status).toBe(200);
    const audit = path.join(directory, "console-audit.jsonl");
    fs.chmodSync(audit, 0o400);
    try {
      const closed = once(open.socket, "close");
      const [browser] = access.listBrowsers();
      expect(access.revoke(browser!.id, "local-command")).toEqual({ revoked: 1, auditFailed: true });
      await Promise.race([closed, delay(1_000).then(() => { throw new Error("revoked connection stayed open"); })]);
      expect((await raw(port, { path: "/api/state", headers: { cookie } })).status).toBe(401);
      expect(access.listBrowsers()).toEqual([]);
    } finally {
      fs.chmodSync(audit, 0o600);
    }
  });

  it("guards the Feishu-only status server the same way", async () => {
    const directory = stateDirectory();
    const access = new ConsoleAccess({ directory });
    const received: unknown[] = [];
    const server = createChannelStatusServer(() => ({ channel: "feishu", ready: true }), {
      async emit(input) { received.push(input); },
    }, access);
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    expect((await raw(port, { path: "/api/state" })).status).toBe(401);
    const cookie = await exchangeLoginLink(access.issueLoginLink(port).url);
    const state = await raw(port, { path: "/api/state", headers: { cookie } });
    expect([state.status, JSON.parse(state.body)]).toEqual([200, { channel: "feishu", ready: true }]);
    expect((await raw(port, { path: "/api/state", host: `evil.example:${port}`, headers: { cookie } })).status).toBe(403);
    const fixture = await raw(port, {
      method: "POST",
      path: "/api/fixture/inbound",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ text: "飞书 fixture" }),
    });
    expect(fixture.status).toBe(200);
    expect(received).toEqual([{ text: "飞书 fixture" }]);
  });
});
