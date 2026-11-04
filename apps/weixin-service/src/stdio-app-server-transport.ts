import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { ModelProtocolError } from "./model-recovery.js";

import type {
  AppServerMessage,
  AppServerTransport,
} from "./codex-app-server-client.js";

export interface AppServerProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export class StdioAppServerTransport implements AppServerTransport {
  private buffer = "";
  private closed = false;
  private messageListener: (message: AppServerMessage) => void = () => {};
  private exitListener: (error?: Error) => void = () => {};

  constructor(private readonly child: AppServerProcess) {
    const stdout = child.stdout as Readable;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.resume();
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.exitListener(
        new Error(
          `Codex App Server 已退出（code=${String(code)}, signal=${String(signal)}）`,
        ),
      );
    });
    child.once("error", (error) => {
      if (this.closed) return;
      this.closed = true;
      this.exitListener(error);
    });
  }

  send(message: AppServerMessage): void {
    if (this.closed) throw new Error("Codex App Server transport 已关闭");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.messageListener = listener;
    return () => {
      if (this.messageListener === listener) this.messageListener = () => {};
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListener = listener;
    return () => {
      if (this.exitListener === listener) this.exitListener = () => {};
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("invalid message");
        }
        this.messageListener(parsed as AppServerMessage);
      } catch {
        const listener = this.exitListener;
        this.close();
        listener(new ModelProtocolError("Codex App Server 返回了无效 JSONL 消息"));
        return;
      }
    }
  }
}

export function resolveCodexExecutable(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_BIN?.trim();
  const bundled = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  if (configured && existsSync(configured)) return configured;
  if (!configured || bundled.includes(configured)) {
    const executable = bundled.find((candidate) => existsSync(candidate));
    if (executable) return executable;
  }
  throw new Error("找不到本机 Codex 可执行文件");
}

export function buildStdioAppServerArgs(disabledFeatures: readonly string[] = []): string[] {
  return [
    "app-server",
    ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
    "--stdio",
  ];
}

export function spawnStdioAppServer(
  codexExecutable: string,
  disabledFeatures: readonly string[] = [],
): StdioAppServerTransport {
  const child = spawn(codexExecutable, buildStdioAppServerArgs(disabledFeatures), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new StdioAppServerTransport(child);
}
