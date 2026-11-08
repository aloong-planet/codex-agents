import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exchangeLoginLink } from "../e2e/console-session.js";
import { ConsoleAccess } from "../src/console-access.js";
import { consoleControlSocketPath, ConsoleControlServer, requestConsoleControl } from "../src/console-control.js";
import { DemoService } from "../src/demo-service.js";
import { FixturePort } from "../src/fixture-port.js";
import { createDemoServer } from "../src/http-server.js";

// macOS limits a Unix socket path to 104 bytes, including the terminator.
const SUN_PATH_LIMIT = 104;

describe("console control socket path", () => {
  it("uses the state directory when the path fits and a short per-directory path under the temp directory otherwise", () => {
    const short = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
    try {
      expect(consoleControlSocketPath(short)).toBe(path.join(short, "console-control.sock"));
    } finally {
      fs.rmSync(short, { recursive: true, force: true });
    }
    const first = path.join(os.tmpdir(), "x".repeat(60), "a".repeat(40));
    const second = path.join(os.tmpdir(), "x".repeat(60), "b".repeat(40));
    expect(Buffer.byteLength(path.join(first, "console-control.sock"))).toBeGreaterThanOrEqual(SUN_PATH_LIMIT);
    const [firstSocket, secondSocket] = [consoleControlSocketPath(first), consoleControlSocketPath(second)];
    for (const socket of [firstSocket, secondSocket]) {
      expect(path.dirname(socket)).toBe(os.tmpdir());
      expect(Buffer.byteLength(socket)).toBeLessThan(SUN_PATH_LIMIT);
    }
    expect(firstSocket).not.toBe(secondSocket);
  });
});

describe("console control channel", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function start() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-control-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDirectory = path.join(root, "state");
    const access = new ConsoleAccess({ directory: stateDirectory });
    const server = createDemoServer(new DemoService(new FixturePort(), async () => "data:image/svg+xml,safe"), { access });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const port = address.port;
    const control = await ConsoleControlServer.start({ stateDirectory, access, port });
    cleanups.push(() => control.close());
    const state = (cookie: string) => fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie } });
    return { stateDirectory, port, state };
  }

  function sendRaw(socketPath: string, line: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath, () => socket.write(line));
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { buffer += chunk; });
      socket.once("end", () => resolve(JSON.parse(buffer) as Record<string, unknown>));
      socket.once("error", reject);
    });
  }

  it("is owner-only and answers only the token from its connection file", async () => {
    const { stateDirectory } = await start();
    const controlFile = path.join(stateDirectory, "console-control.json");
    const connection = JSON.parse(fs.readFileSync(controlFile, "utf8")) as { socket: string; token: string };
    expect(fs.statSync(controlFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(connection.socket).mode & 0o777).toBe(0o600);
    expect(connection.token).toMatch(/^[0-9a-f]{64}$/);

    const wrong = await sendRaw(connection.socket, `${JSON.stringify({ token: "0".repeat(64), command: "login-link" })}\n`);
    expect(wrong).toEqual({ ok: false, error: "控制令牌无效" });
    const right = await sendRaw(connection.socket, `${JSON.stringify({ token: connection.token, command: "login-link" })}\n`);
    expect(right.ok).toBe(true);
    await expect(exchangeLoginLink(String(right.url))).resolves.toMatch(/^codex_console_\d+=[0-9a-f]{64}$/);
  });

  it("rotates its token on every start, so a token from an earlier start stops working", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-control-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDirectory = path.join(root, "state");
    const access = new ConsoleAccess({ directory: stateDirectory });
    const controlFile = path.join(stateDirectory, "console-control.json");
    const first = await ConsoleControlServer.start({ stateDirectory, access, port: 4317 });
    const leftBehind = fs.readFileSync(controlFile, "utf8");
    const firstToken = (JSON.parse(leftBehind) as { token: string }).token;
    await first.close();
    // A killed service leaves its connection file behind; the next start must not reuse that token.
    fs.writeFileSync(controlFile, leftBehind, { mode: 0o600 });

    const second = await ConsoleControlServer.start({ stateDirectory, access, port: 4317 });
    cleanups.push(() => second.close());
    const connection = JSON.parse(fs.readFileSync(controlFile, "utf8")) as { socket: string; token: string };
    expect(connection.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connection.token).not.toBe(firstToken);
    expect(await sendRaw(connection.socket, `${JSON.stringify({ token: firstToken, command: "login-link" })}\n`))
      .toEqual({ ok: false, error: "控制令牌无效" });
    expect((await sendRaw(connection.socket, `${JSON.stringify({ token: connection.token, command: "login-link" })}\n`)).ok).toBe(true);
  });

  it("issues links, lists browsers and revokes one or all for the local command", async () => {
    const { stateDirectory, state } = await start();
    const login = async () => exchangeLoginLink(String((await requestConsoleControl(stateDirectory, { command: "login-link" })).url));
    const first = await login();
    const second = await login();
    const third = await login();

    const listed = (await requestConsoleControl(stateDirectory, { command: "list" })).browsers as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(3);
    for (const browser of listed) {
      expect(Object.keys(browser).sort()).toEqual(["authorizedAt", "id", "label", "lastUsedAt"]);
      expect(browser.label).toBe("浏览器");
    }

    await expect(requestConsoleControl(stateDirectory, { command: "revoke", target: "nobody" })).rejects.toThrow("没有该浏览器");
    expect(await requestConsoleControl(stateDirectory, { command: "revoke", target: String(listed[0]!.id) }))
      .toEqual({ ok: true, revoked: 1, auditFailed: false });
    expect((await state(first)).status).toBe(401);
    expect((await state(second)).status).toBe(200);
    expect(await requestConsoleControl(stateDirectory, { command: "revoke", target: "all" }))
      .toEqual({ ok: true, revoked: 2, auditFailed: false });
    expect([(await state(second)).status, (await state(third)).status]).toEqual([401, 401]);
  });

  it("keeps a single replaceable Codex plugin authorization", async () => {
    const { stateDirectory, state } = await start();
    const first = String((await requestConsoleControl(stateDirectory, { command: "authorize-plugin" })).cookie);
    expect((await state(first)).status).toBe(200);
    const second = String((await requestConsoleControl(stateDirectory, { command: "authorize-plugin" })).cookie);
    expect(second).toMatch(/^codex_console_\d+=[0-9a-f]{64}$/);
    expect([(await state(first)).status, (await state(second)).status]).toEqual([401, 200]);

    const listed = (await requestConsoleControl(stateDirectory, { command: "list" })).browsers as Array<Record<string, unknown>>;
    expect(listed).toEqual([expect.objectContaining({ label: "Codex 插件", client: "codex-plugin" })]);
    const audit = fs.readFileSync(path.join(stateDirectory, "console-audit.jsonl"), "utf8");
    const entries = audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    const firstId = (entries[0]!.browser as { id: string }).id;
    expect(entries).toEqual([
      expect.objectContaining({ by: "codex-plugin", event: "browser_authorized", browser: { id: firstId, label: "Codex 插件" } }),
      expect.objectContaining({ by: "codex-plugin", event: "browser_authorized", browser: { id: listed[0]!.id, label: "Codex 插件" }, replaced: [firstId] }),
    ]);
    for (const cookie of [first, second]) expect(audit).not.toContain(cookie.split("=")[1]);
  });
});
