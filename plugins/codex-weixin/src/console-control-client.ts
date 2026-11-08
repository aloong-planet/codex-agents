import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The plugin is not a browser, so it authorizes through the local service's owner-only control channel, the
 * same one the login command uses (agent-console::US-001/AC-05). The connection file in the service's state
 * directory names the Unix socket and a token rotated on every service start. The service answers
 * `authorize-plugin` with a cookie (`name=value`) and replaces the plugin's previous authorization.
 *
 * Every plugin process shares one credential, kept in an owner-only file beside the connection file, so the
 * service keeps a single 「Codex 插件」 entry however many processes run. Any owner process that can read the
 * control token could obtain a credential anyway, so sharing it grants nothing new. A process authorizes only
 * when that file is missing, or when the service refused the credential and no other process has replaced it
 * yet; a lock file makes that step exclusive, so processes starting together settle on one entry.
 */
const CONTROL_FILE = "console-control.json";
export const PLUGIN_CREDENTIAL_FILE = "console-plugin-credential.json";
const LOCK_FILE = "console-plugin-credential.lock";
const REQUEST_TIMEOUT_MS = 5_000;
// A lock older than this was left by a process that died while authorizing.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 25;

export type PluginCredentials = {
  /** The shared credential, obtaining one when none exists yet. */
  current(): Promise<string>;
  /** A credential other than the one the service just refused. */
  renew(rejected: string): Promise<string>;
};

export function defaultStateDirectory(env: Record<string, string | undefined>, homeDir = os.homedir()): string {
  return env.WEIXIN_DEMO_STATE_DIR?.trim() || path.join(homeDir, "Library", "Application Support", "weixin-ilink-direct-demo");
}

export function consoleControlAuthorizer(stateDirectory: string): () => Promise<string> {
  return async () => {
    let connection: { socket?: unknown; token?: unknown };
    try {
      connection = JSON.parse(fs.readFileSync(path.join(stateDirectory, CONTROL_FILE), "utf8")) as typeof connection;
    } catch {
      throw new Error("微信 Demo 未运行，无法取得本机授权");
    }
    if (typeof connection.socket !== "string" || typeof connection.token !== "string") {
      throw new Error("微信 Demo 未运行，无法取得本机授权");
    }
    const socketPath = connection.socket;
    const request = `${JSON.stringify({ token: connection.token, command: "authorize-plugin" })}\n`;
    const text = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(socketPath, () => socket.write(request));
      let buffer = "";
      socket.setEncoding("utf8");
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
        socket.destroy();
        reject(new Error("微信 Demo 没有响应本机授权请求"));
      });
      socket.on("data", (chunk: string) => { buffer += chunk; });
      socket.once("end", () => resolve(buffer));
      socket.once("error", () => reject(new Error("微信 Demo 未运行，无法取得本机授权")));
    });
    let value: { ok?: unknown; cookie?: unknown; error?: unknown };
    try {
      value = JSON.parse(text.trim()) as typeof value;
    } catch {
      throw new Error("微信 Demo 返回了无效的本机授权");
    }
    if (value.ok !== true || typeof value.cookie !== "string") {
      throw new Error(typeof value.error === "string" ? value.error : "微信 Demo 拒绝了本机授权");
    }
    return value.cookie;
  };
}

function readCredential(file: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { cookie?: unknown };
    return typeof value.cookie === "string" && value.cookie.length > 0 ? value.cookie : undefined;
  } catch {
    return undefined;
  }
}

function writeCredential(file: string, cookie: string): void {
  const temporaryPath = path.join(path.dirname(file), `.console-plugin-credential-${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ cookie }), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/** The credential shared by every plugin process of this state directory. */
export function sharedPluginCredentials(
  stateDirectory: string,
  authorize: () => Promise<string> = consoleControlAuthorizer(stateDirectory),
): PluginCredentials {
  const file = path.join(stateDirectory, PLUGIN_CREDENTIAL_FILE);
  const lock = path.join(stateDirectory, LOCK_FILE);
  const usable = (rejected?: string) => {
    const cookie = readCredential(file);
    return cookie !== undefined && cookie !== rejected ? cookie : undefined;
  };
  const obtain = async (rejected?: string): Promise<string> => {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const existing = usable(rejected);
      if (existing) return existing;
      let descriptor: number;
      try {
        descriptor = fs.openSync(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
        } catch {
          // The holder released the lock meanwhile.
        }
        if (Date.now() > deadline) throw new Error("微信 Demo 本机授权正忙，请稍后重试");
        await delay(LOCK_POLL_MS);
        continue;
      }
      fs.closeSync(descriptor);
      try {
        // Another process may have replaced the credential between the check above and taking the lock.
        const replaced = usable(rejected);
        if (replaced) return replaced;
        const cookie = await authorize();
        writeCredential(file, cookie);
        return cookie;
      } finally {
        fs.rmSync(lock, { force: true });
      }
    }
  };
  return { current: () => obtain(), renew: (rejected) => obtain(rejected) };
}
