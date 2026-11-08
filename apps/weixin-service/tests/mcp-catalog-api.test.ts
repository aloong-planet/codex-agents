// The MCP catalog API at the HTTP boundary of the real local servers, behind the real console guard with a browser
// authorized by a login link (docs/specs/mcp-catalog.md, Testing Decisions "Console").
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exchangeLoginLink } from "../e2e/console-session.js";
import { createChannelStatusServer } from "../src/channel-status-server.js";
import { ConsoleAccess } from "../src/console-access.js";
import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import { createConsoleRoutes } from "../src/console-routes.js";
import { DemoService, type ChannelSnapshot, type WeixinChannel } from "../src/demo-service.js";
import { createDemoServer } from "../src/http-server.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { SECRET_SENTINEL, testServerArgs, testServerFiles, writeTools } from "./fixtures/mcp-test-server-control.js";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const WAIT = { timeout: 10_000, interval: 50 };

/** A Weixin channel that is never used: these cases only need the demo server to exist around the console routes. */
class IdleChannel implements WeixinChannel {
  async start(): Promise<void> {}
  getSnapshot(): ChannelSnapshot {
    return { accounts: [], targets: [] };
  }
  onSnapshotChanged(): () => void {
    return () => {};
  }
  updateLocalLabels(): void {}
  startLogin(): never {
    throw new Error("not used");
  }
  sendText(): never {
    throw new Error("not used");
  }
  close(): void {}
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function start(variant: "demo" | "status") {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-api-"));
  cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const state = path.join(work, "state");
  const home = path.join(work, "home");
  fs.mkdirSync(home);
  const audit = new ConsoleAudit({ directory: state });
  const access = new ConsoleAccess({ directory: state, audit });
  const catalog = new McpCatalog({ stateDirectory: state, homeDirectory: home, audit, retryMs: 60_000, refreshMs: 0 });
  cleanup.push(() => catalog.close());
  const consoleRoutes = createConsoleRoutes({ catalog });
  const server: Server = variant === "demo"
    ? createDemoServer(new DemoService(new IdleChannel(), async () => ""), { access, consoleRoutes })
    : createChannelStatusServer(() => ({}), undefined, access, consoleRoutes);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const cookie = await exchangeLoginLink(access.issueLoginLink(address.port).url, CHROME_MAC);
  const bodies: string[] = [];
  const request = async (pathname: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${pathname}`, payload === undefined
      ? { headers: { cookie, ...extra } }
      : { method: "POST", headers: { cookie, origin, "content-type": "application/json", ...extra }, body: JSON.stringify(payload) });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { work, state, origin, cookie, catalog, access, request, bodies };
}

describe("MCP catalog API", () => {
  it("no console response contains a secret", async () => {
    const { work, request, bodies } = await start("status");
    const files = testServerFiles(work);
    writeTools(files.tools, [{ name: "lookup", description: "Finds.", inputSchema: { type: "object" } }]);
    const server = { name: "secretive", command: process.execPath, args: testServerArgs(files), env: { SECRET_TOKEN: SECRET_SENTINEL, SHORT: "ab" } };
    const failing = { name: "failing", command: process.execPath, args: testServerArgs(testServerFiles(work, "failing")), env: { SECRET_TOKEN: SECRET_SENTINEL } };
    fs.writeFileSync(testServerFiles(work, "failing").failFlag, "");

    const preview = await request("/api/mcp/preview", { server });
    expect((await request("/api/mcp/servers", { server, confirmed: preview.body.launchLine })).status).toBe(200);
    expect((await request("/api/mcp/servers", { server: failing, confirmed: (await request("/api/mcp/preview", { server: failing })).body.launchLine })).status).toBe(200);
    expect((await request("/api/mcp/servers", { server: { ...server, name: "bad name" }, confirmed: "x" })).body).toEqual({ error: "名称只能包含英文字母、数字、_ 和 -，1–32 个字符" });
    await vi.waitFor(async () => {
      const { body } = await request("/api/mcp/servers");
      expect(body.servers.map((item: { state: string }) => item.state)).toEqual(["connected", "failed"]);
    }, WAIT);
    const listed = (await request("/api/mcp/servers")).body.servers;
    expect(listed[1].output).toContain("could not authenticate with ***");
    expect((await request("/api/mcp/servers/secretive", { server: { ...server, env: { SECRET_TOKEN: "••••••", SHORT: "••••••" } } })).status).toBe(200);
    expect((await request("/api/mcp/servers/secretive/tools", { tool: "lookup", enabled: false })).status).toBe(200);
    expect((await request("/api/mcp/servers/secretive/approve", {})).body).toEqual({ error: "secretive 没有待复核的工具" });
    expect((await request("/api/mcp/servers/secretive/reconnect", {})).status).toBe(200);

    for (const view of (await request("/api/mcp/servers")).body.servers) {
      expect(view.env).toEqual(view.name === "secretive" ? { SECRET_TOKEN: "••••••", SHORT: "••••••" } : { SECRET_TOKEN: "••••••" });
    }
    expect((await request("/api/mcp/servers/secretive/delete", {})).body).toEqual({ deleted: "secretive" });
    expect(bodies.length).toBeGreaterThanOrEqual(12);
    for (const body of bodies) expect(body).not.toContain(SECRET_SENTINEL);
  });

  it("audit entries name the browser that made the change", async () => {
    const { work, state, access, request } = await start("status");
    const server = { name: "audited", command: process.execPath, args: testServerArgs(testServerFiles(work)) };
    await request("/api/mcp/servers", { server, confirmed: (await request("/api/mcp/preview", { server })).body.launchLine });

    const [browser] = access.listBrowsers();
    expect(browser?.label).toBe("Chrome · macOS");
    const entries = fs.readFileSync(path.join(state, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ event: "mcp_server_added", server: "audited", by: "browser", browser: { id: browser!.id, label: "Chrome · macOS" } });
  });

  it.each(["demo", "status"] as const)("the MCP API is guarded on the %s server", async (variant) => {
    const { origin, cookie, catalog } = await start(variant);
    const server = { name: "guarded", command: process.execPath, args: [] };

    expect((await fetch(`${origin}/api/mcp/servers`)).status).toBe(401);
    const foreign = await fetch(`${origin}/api/mcp/servers`, { method: "POST", headers: { cookie, origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ server, confirmed: "x" }) });
    expect(foreign.status).toBe(403);
    expect(catalog.view()).toEqual([]);
    const listed = await fetch(`${origin}/api/mcp/servers`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ servers: [] });
    const page = await fetch(`${origin}/console/mcp`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>MCP 管理</title>");
  });
});
