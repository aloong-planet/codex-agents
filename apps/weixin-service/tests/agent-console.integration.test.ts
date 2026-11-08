// Whole-app wiring of the console login (agent-console::US-001): the service process builds the gate on its
// state directory and starts the control channel, and the `console` command reaches it there.
// Coverage gap: the real macOS default-browser launch is not exercised; the login case puts a stand-in `open`
// (and `xdg-open`) first on PATH and checks that it received the printed link.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { exchangeLoginLink } from "../e2e/console-session.js";
import { startFixtureServer } from "../e2e/fixture-server.js";

const SERVICE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

type CommandResult = { code: number; stdout: string; stderr: string };

function runConsole(args: string[], env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "src/console-cli.ts", ...args], {
      cwd: SERVICE_DIRECTORY,
      env: { ...process.env, ...env },
      timeout: 20_000,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function loginLinkIn(output: string, port: string): string {
  const match = output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/login\\?t=[0-9a-f]{48}`));
  if (!match) throw new Error(`no login link in: ${output}`);
  return match[0];
}

describe("console login command against the running service", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function temporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
  }

  async function startService(options: { stateDirectory: string; port?: number }) {
    const server = await startFixtureServer("fixture", "fixture", undefined, options);
    cleanups.push(() => server.close());
    return server;
  }

  /** Puts a stand-in `open` and `xdg-open` first on PATH; each records the URL it was asked to open. */
  function standInOpener(stateDirectory: string) {
    const bin = temporaryDirectory("agent-console-bin-");
    const opened = path.join(bin, "opened.txt");
    for (const opener of ["open", "xdg-open"]) {
      fs.writeFileSync(path.join(bin, opener), `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`, { mode: 0o755 });
    }
    return { opened, env: { WEIXIN_DEMO_STATE_DIR: stateDirectory, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } };
  }

  it("prints a link that authorizes the browser, and the authorization survives a service restart", async () => {
    const stateDirectory = temporaryDirectory("agent-console-state-");
    const first = await startService({ stateDirectory });
    const port = new URL(first.url).port;

    const opener = standInOpener(stateDirectory);
    const login = await runConsole(["login", "--no-open"], opener.env);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain("2 分钟内有效");
    expect(fs.existsSync(opener.opened)).toBe(false);
    const cookie = await exchangeLoginLink(loginLinkIn(login.stdout, port));
    const page = await fetch(`${first.url}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="connection-app-tab"');

    await first.close();
    const restarted = await startService({ stateDirectory, port: Number(port) });
    expect((await fetch(`${restarted.url}/api/state`, { headers: { cookie } })).status).toBe(200);
  }, 60_000);

  it("opens the link in the default browser, lists the browsers and revokes them, warning when the audit cannot be written", async () => {
    const stateDirectory = temporaryDirectory("agent-console-state-");
    const server = await startService({ stateDirectory });
    const port = new URL(server.url).port;
    const { opened, env } = standInOpener(stateDirectory);

    const login = await runConsole(["login"], env);
    expect(login.code).toBe(0);
    const link = loginLinkIn(login.stdout, port);
    expect(fs.readFileSync(opened, "utf8")).toBe(link);
    const chrome = await exchangeLoginLink(link, CHROME_MAC);
    const second = await runConsole(["login"], env);
    const safari = await exchangeLoginLink(loginLinkIn(second.stdout, port), SAFARI_MAC);

    const list = await runConsole(["list"], env);
    expect(list.code).toBe(0);
    const idOf = (label: string) => {
      const line = list.stdout.split("\n").find((entry) => entry.includes(label));
      expect(line).toBeDefined();
      const id = line!.split(/\s+/)[0]!;
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      return id;
    };
    const [chromeId, safariId] = [idOf("Chrome · macOS"), idOf("Safari · macOS")];

    const revoke = await runConsole(["revoke", chromeId], env);
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain("已收回 1 个浏览器的授权");
    expect(revoke.stderr).toBe("");
    expect((await fetch(`${server.url}/api/state`, { headers: { cookie: chrome } })).status).toBe(401);

    const audit = path.join(fs.realpathSync(stateDirectory), "console-audit.jsonl");
    fs.chmodSync(audit, 0o400);
    try {
      const unaudited = await runConsole(["revoke", safariId], env);
      expect(unaudited.code).toBe(0);
      expect(unaudited.stdout).toContain("已收回 1 个浏览器的授权");
      expect(unaudited.stderr).toContain("审计记录写入失败");
    } finally {
      fs.chmodSync(audit, 0o600);
    }
    expect((await fetch(`${server.url}/api/state`, { headers: { cookie: safari } })).status).toBe(401);
  }, 60_000);

  it("says the service is not running when the service was killed and left its connection file", async () => {
    const stateDirectory = temporaryDirectory("agent-console-state-");
    const server = await startService({ stateDirectory });
    // Kill the service's whole process group, as a crash or `kill -9` would; no shutdown cleanup runs.
    process.kill(-server.pid, "SIGKILL");
    const until = Date.now() + 5_000;
    while (Date.now() < until && (await fetch(`${server.url}/api/state`).then(() => true, () => false))) await delay(50);
    expect(fs.existsSync(path.join(stateDirectory, "console-control.json"))).toBe(true);

    const result = await runConsole(["login", "--no-open"], { WEIXIN_DEMO_STATE_DIR: stateDirectory });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("本机服务未运行");
    expect(result.stdout).not.toContain("/login?t=");
  }, 60_000);

  it("says the service is not running when no service owns the state directory", async () => {
    const result = await runConsole(["login", "--no-open"], { WEIXIN_DEMO_STATE_DIR: temporaryDirectory("agent-console-empty-") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("本机服务未运行");
  }, 30_000);
});
