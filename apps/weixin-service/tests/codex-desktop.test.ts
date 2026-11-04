import { describe, expect, it, vi } from "vitest";

import { MacCodexDesktopNavigator } from "../src/codex-desktop.js";

const THREAD_ID = "019fef94-7da4-75a2-b9fb-226af024ddcd";

describe("MacCodexDesktopNavigator", () => {
  it("opens only the fixed Codex thread deep link without invoking a shell", async () => {
    const exec = vi.fn(async () => ({}));
    const navigator = new MacCodexDesktopNavigator("darwin", exec);

    await navigator.openThread(THREAD_ID);

    expect(exec).toHaveBeenCalledWith("/usr/bin/open", [
      "-b",
      "com.openai.codex",
      `codex://threads/${THREAD_ID}`,
    ]);
  });

  it.each([
    ["darwin", "../../bad", "Codex 任务 ID 无效"],
    ["linux", THREAD_ID, "当前仅支持在 macOS Codex Desktop 中查看"],
  ] satisfies Array<[NodeJS.Platform, string, string]>)(
    "rejects unsafe or unsupported requests",
    async (platform, threadId, message) => {
    const exec = vi.fn(async () => ({}));
    const navigator = new MacCodexDesktopNavigator(platform, exec);

    await expect(navigator.openThread(threadId)).rejects.toThrow(message);
    expect(exec).not.toHaveBeenCalled();
    },
  );

  it("redacts native launch errors", async () => {
    const navigator = new MacCodexDesktopNavigator("darwin", async () => {
      throw new Error("sensitive native details");
    });

    await expect(navigator.openThread(THREAD_ID)).rejects.toThrow(
      "无法请求 Codex Desktop 打开该任务",
    );
  });
});
