import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DailyAiNewsScheduler } from "../src/daily-ai-news-scheduler.js";
import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";
import { ScheduledTasks } from "../src/scheduled-tasks.js";

// Build retained legacy data through its real scheduler, not by writing Run records.
it("imports an over-quota legacy backlog exactly and protects more than 31 pending reports after cutover", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "news-retention-"));
  let clock = Date.parse("2026-09-16T00:30:00Z");
  const store = new DailyAiNewsFileStore(path.join(dir, "news.json"));
  const researcher = { generate: async ({ date }: { date: string }) => ({ date, generatedAt: clock, items: [] }) };
  const legacy = new DailyAiNewsScheduler({ store, researcher, now: () => clock, setTimer: () => 0, clearTimer: () => {},
    channel: { getSnapshot: () => ({ accounts: [{ accountId: "fixture", credentialStatus: "usable" }], targets: [{ accountId: "fixture", target: "recipient@im.wechat" }] }),
      sendText: async () => ({ ok: false, reason: "context_missing", acceptedSegments: 0 }) } });
  let tasks: ScheduledTasks | undefined;
  try {
    for (let day = 0; day < 31; day++) { clock = Date.parse("2026-09-16T00:30:00Z") + day * 86_400_000; await legacy.enable("fixture", "recipient@im.wechat"); }
    legacy.close(); const original = store.load(); expect(original.runs).toHaveLength(31);
    const base = { databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
      dailyNewsImport: { state: original, sourceHash: "public-legacy-31" }, dailyNews: { researcher } };
    tasks = new ScheduledTasks({ ...base, limits: { globalPendingCount: 1, recipientPendingCount: 1 } });
    clock += 86_400_000; await tasks.tick();
    expect(tasks.newsSnapshot().occurrences.filter((item) => item.body).map((item) => item.body).sort()).toEqual(original.runs.map((run) => run.message).sort());
    expect(tasks.newsSnapshot().tasks[0]?.blocker?.code).toBe("pending_capacity");
    tasks.close(); tasks = new ScheduledTasks(base);
    for (let day = 0; day < 5; day++) { await tasks.tick(); clock += 86_400_000; }
    expect(tasks.newsSnapshot().occurrences.filter((item) => item.execution === "succeeded")).toHaveLength(36);
    expect(tasks.newsSnapshot().occurrences.find((item) => item.news?.runKey === "2026-09-16")?.body).toBe("2026-09-16 AI 新闻\n今日暂无值得汇总的重大更新。");
    tasks.close(); tasks = new ScheduledTasks(base);
    expect(tasks.newsSnapshot().occurrences.filter((item) => item.execution === "succeeded")).toHaveLength(36);
  } finally { legacy.close(); tasks?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
