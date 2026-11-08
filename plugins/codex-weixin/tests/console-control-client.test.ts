// Coverage gaps:
// - The 15 s lock-wait deadline (「微信 Demo 本机授权正忙」) is not driven. It is reached only when, for 15 s, every
//   poll finds a lock younger than its 10 s stale limit (other processes taking it in turn) or a lock that cannot be
//   removed; a single holder that never finishes is taken over after 10 s instead (driven below). Re-test
//   condition: a lock path that cannot be removed, for 15 s.
// - The re-check right after taking the lock, which returns a credential another process wrote between this
//   process's check and its lock, is not driven: within one process nothing runs between the two, and across
//   processes the window is microseconds. Without it such a race costs one extra authorization that then settles.
//   Re-test condition: a seam between the check and taking the lock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConsoleAccess } from "../../../apps/weixin-service/src/console-access.js";
import { ConsoleControlServer } from "../../../apps/weixin-service/src/console-control.js";
import { resolvePrivateStatePath } from "../../../apps/weixin-service/src/runtime-paths.js";
import { defaultStateDirectory, PLUGIN_CREDENTIAL_FILE, sharedPluginCredentials } from "../src/console-control-client.js";

describe("console control client", () => {
  // The installed plugin finds the service's control channel through this default, so it must stay the
  // service's own state directory for the same environment.
  it.each([
    ["the default directory", {}],
    ["an override with surrounding spaces", { WEIXIN_DEMO_STATE_DIR: "  /private/demo-state  " }],
  ])("looks for the control channel in the service's state directory: %s", (_name, env) => {
    expect(defaultStateDirectory(env, "/Users/example")).toBe(path.dirname(resolvePrivateStatePath(env, "/Users/example")));
  });
});

describe("shared plugin credential", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  // The service's real browser store and control channel; each credential source stands for one plugin process.
  async function startService() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-credential-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDirectory = path.join(root, "state");
    const access = new ConsoleAccess({ directory: stateDirectory });
    const control = await ConsoleControlServer.start({ stateDirectory, access, port: 4317 });
    cleanups.push(() => control.close());
    const pluginEntries = () => access.listBrowsers().filter((browser) => browser.label === "Codex 插件");
    return { stateDirectory, access, pluginEntries };
  }

  it("lets processes that start together share one credential and one entry", async () => {
    const { stateDirectory, pluginEntries } = await startService();
    const [first, second] = [sharedPluginCredentials(stateDirectory), sharedPluginCredentials(stateDirectory)];

    const [a, b] = await Promise.all([first.current(), second.current()]);
    expect(a).toMatch(/^codex_console_4317=[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(pluginEntries()).toHaveLength(1);
    const file = path.join(stateDirectory, PLUGIN_CREDENTIAL_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ cookie: a });
  });

  it("returns as one new entry after the owner revokes the plugin", async () => {
    const { stateDirectory, access, pluginEntries } = await startService();
    const [first, second] = [sharedPluginCredentials(stateDirectory), sharedPluginCredentials(stateDirectory)];
    const revoked = await first.current();
    const [entry] = pluginEntries();
    access.revoke(entry!.id, "local-command");
    expect(pluginEntries()).toEqual([]);

    const [a, b] = await Promise.all([first.renew(revoked), second.renew(revoked)]);
    expect(a).not.toBe(revoked);
    expect(b).toBe(a);
    expect(pluginEntries()).toHaveLength(1);
    expect(pluginEntries()[0]!.id).not.toBe(entry!.id);
  });

  it("releases its lock when an authorization fails, so the next attempt proceeds at once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-credential-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDirectory = path.join(root, "state");
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const credentials = sharedPluginCredentials(stateDirectory);
    await expect(credentials.current()).rejects.toThrow("微信 Demo 未运行");

    const access = new ConsoleAccess({ directory: stateDirectory });
    const control = await ConsoleControlServer.start({ stateDirectory, access, port: 4317 });
    cleanups.push(() => control.close());
    const started = Date.now();
    await expect(credentials.current()).resolves.toMatch(/^codex_console_4317=[0-9a-f]{64}$/);
    // A lock left behind would only be taken over once it is 10 s old.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("takes over a lock left by a process that died while authorizing", async () => {
    const { stateDirectory, pluginEntries } = await startService();
    const lock = path.join(stateDirectory, "console-plugin-credential.lock");
    fs.writeFileSync(lock, "", { mode: 0o600 });
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, longAgo, longAgo);

    await expect(sharedPluginCredentials(stateDirectory).current()).resolves.toMatch(/^codex_console_4317=[0-9a-f]{64}$/);
    expect(pluginEntries()).toHaveLength(1);
  });
});
