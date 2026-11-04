import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";
import { DailyNewsHandoff } from "../src/daily-news-handoff.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
it("refuses a still-running legacy process, then preserves a durable prepared source and fences the old store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "news-handoff-")); cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "news.json");
  const store = new DailyAiNewsFileStore(statePath);
  store.save({ version: 2, enabledTarget: { accountId: "fixture", target: "recipient@im.wechat", enabledAt: 1 }, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null });
  const before = fs.readFileSync(statePath, "utf8");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  cleanup.push(() => { child.kill("SIGKILL"); }); await once(child, "spawn");
  const handoff = new DailyNewsHandoff(statePath);
  expect(() => handoff.prepare(child.pid!)).toThrow("daily_news_legacy_still_running");
  expect(fs.readFileSync(statePath, "utf8")).toBe(before);
  const exited = once(child, "exit"); child.kill(); await exited;
  expect(handoff.prepare(child.pid!)).toMatchObject({ state: { version: 2, enabledTarget: { accountId: "fixture", target: "recipient@im.wechat" } } });
  expect(() => store.load()).toThrow("每日 AI 新闻状态格式无效");
  expect(new DailyNewsHandoff(statePath).readPrepared()).toMatchObject({ state: { runs: [], preview: null } });
  expect(handoff.prepare(child.pid!)).toEqual(new DailyNewsHandoff(statePath).readPrepared());
});
