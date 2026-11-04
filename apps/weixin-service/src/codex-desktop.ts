import { execFile } from "node:child_process";
import { promisify } from "node:util";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CodexDesktopNavigator {
  openThread(threadId: string): Promise<void>;
}

type ExecFile = (file: string, args: string[]) => Promise<unknown>;

export class MacCodexDesktopNavigator implements CodexDesktopNavigator {
  constructor(
    private readonly platform = process.platform,
    private readonly exec: ExecFile = promisify(execFile),
  ) {}

  async openThread(threadId: string): Promise<void> {
    if (!THREAD_ID.test(threadId)) throw new Error("Codex 任务 ID 无效");
    if (this.platform !== "darwin") throw new Error("当前仅支持在 macOS Codex Desktop 中查看");

    try {
      await this.exec("/usr/bin/open", [
        "-b",
        "com.openai.codex",
        `codex://threads/${threadId}`,
      ]);
    } catch {
      throw new Error("无法请求 Codex Desktop 打开该任务");
    }
  }
}
