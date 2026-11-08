import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { ConsoleAccessError, type ConsoleAccess } from "./console-access.js";

/**
 * The owner-only local control channel used by the login command and the Codex plugin, after agent-link's
 * control socket. The running service listens on a Unix socket in the state directory (mode 0600) and writes a
 * connection file holding the socket path and a token rotated on every start (mode 0600). A client sends one
 * JSON line `{token, command, target?}` and receives one JSON line, `{ok: true, ...}` or `{ok: false, error}`.
 */
export const CONTROL_FILE = "console-control.json";
const SOCKET_FILE = "console-control.sock";
// macOS limits a Unix socket path to 104 bytes including the terminator; keep a margin.
const MAX_SOCKET_PATH_BYTES = 100;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 4_096;

export type ConsoleControlCommand = "login-link" | "list" | "revoke" | "authorize-plugin";

export class ConsoleControlUnavailableError extends Error {
  constructor() {
    super("本机服务未运行");
  }
}

export function consoleControlSocketPath(stateDirectory: string): string {
  const preferred = path.join(stateDirectory, SOCKET_FILE);
  if (Buffer.byteLength(preferred) < MAX_SOCKET_PATH_BYTES) return preferred;
  const digest = crypto.createHash("sha256").update(path.resolve(stateDirectory)).digest("hex").slice(0, 8);
  return path.join(os.tmpdir(), `codex-console-${digest}.sock`);
}

function writePrivateFile(file: string, text: string): void {
  const temporaryPath = path.join(path.dirname(file), `.console-control-${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not exist or may already be renamed.
    }
    throw error;
  }
}

function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function tokensMatch(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export class ConsoleControlServer {
  private constructor(
    private readonly server: net.Server,
    private readonly socketPath: string,
    private readonly controlFile: string,
    private readonly token: string,
  ) {}

  static async start(input: { stateDirectory: string; access: ConsoleAccess; port: number }): Promise<ConsoleControlServer> {
    const { stateDirectory, access, port } = input;
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const socketPath = consoleControlSocketPath(stateDirectory);
    if (await socketAnswers(socketPath)) throw new Error("console_control_socket_in_use");
    fs.rmSync(socketPath, { force: true });
    const token = crypto.randomBytes(32).toString("hex");
    const server = net.createServer((socket) => {
      let buffer = "";
      let answered = false;
      const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("close", () => clearTimeout(timer));
      socket.on("data", (chunk: string) => {
        if (answered) return;
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) socket.destroy();
          return;
        }
        answered = true;
        clearTimeout(timer);
        socket.end(`${JSON.stringify(handleRequest(buffer.slice(0, newline), token, access, port))}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
    const controlFile = path.join(stateDirectory, CONTROL_FILE);
    try {
      writePrivateFile(controlFile, JSON.stringify({ socket: socketPath, token }));
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    return new ConsoleControlServer(server, socketPath, controlFile, token);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      const current = JSON.parse(fs.readFileSync(this.controlFile, "utf8")) as { token?: unknown };
      if (current.token === this.token) fs.rmSync(this.controlFile, { force: true });
    } catch {
      // Another start may have replaced or removed the file.
    }
  }
}

function handleRequest(line: string, token: string, access: ConsoleAccess, port: number): Record<string, unknown> {
  let request: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    request = value as Record<string, unknown>;
  } catch {
    return { ok: false, error: "请求格式无效" };
  }
  if (!tokensMatch(token, request.token)) return { ok: false, error: "控制令牌无效" };
  try {
    switch (request.command) {
      case "login-link":
        return { ok: true, ...access.issueLoginLink(port) };
      case "list":
        return { ok: true, browsers: access.listBrowsers() };
      case "revoke":
        if (typeof request.target !== "string" || request.target.length === 0) return { ok: false, error: "缺少要收回的浏览器" };
        return { ok: true, ...access.revoke(request.target, "local-command") };
      case "authorize-plugin":
        return { ok: true, ...access.authorizePlugin(port) };
      default:
        return { ok: false, error: "未知命令" };
    }
  } catch (error) {
    if (error instanceof ConsoleAccessError) return { ok: false, error: error.message };
    process.stderr.write(`console_control_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false, error: "本机授权操作失败，请查看服务日志" };
  }
}

/** Sends one command to the running service. Throws ConsoleControlUnavailableError when no service answers. */
export async function requestConsoleControl(
  stateDirectory: string,
  request: { command: ConsoleControlCommand; target?: string },
): Promise<Record<string, unknown>> {
  let connection: { socket?: unknown; token?: unknown };
  try {
    connection = JSON.parse(fs.readFileSync(path.join(stateDirectory, CONTROL_FILE), "utf8")) as typeof connection;
  } catch {
    throw new ConsoleControlUnavailableError();
  }
  if (typeof connection.socket !== "string" || typeof connection.token !== "string") throw new ConsoleControlUnavailableError();
  const socketPath = connection.socket;
  const line = `${JSON.stringify({ token: connection.token, ...request })}\n`;
  const response = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    let connected = false;
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("本机服务没有响应"));
    });
    socket.once("connect", () => {
      connected = true;
      socket.write(line);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.once("error", (error) => reject(connected ? error : new ConsoleControlUnavailableError()));
    socket.once("end", () => resolve(buffer));
  });
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(response.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("本机服务返回了无效响应");
  }
  if (value.ok !== true) throw new Error(typeof value.error === "string" ? value.error : "本机服务拒绝了请求");
  return value;
}
