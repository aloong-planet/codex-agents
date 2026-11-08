import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * The plugin is not a browser, so it authorizes through the local service's owner-only control channel, the
 * same one the login command uses. The connection file in the service's state directory names the Unix socket
 * and a token rotated on every service start; this is the only private state the plugin reads. The service
 * answers `authorize-plugin` with a cookie (`name=value`) and replaces the plugin's previous authorization.
 */
const CONTROL_FILE = "console-control.json";
const REQUEST_TIMEOUT_MS = 5_000;

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
