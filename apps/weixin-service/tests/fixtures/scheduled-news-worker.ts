import fs from "node:fs";
import path from "node:path";
import { DailyAiNewsScheduler } from "../../src/daily-ai-news-scheduler.js";
import { DailyAiNewsFileStore } from "../../src/daily-ai-news-store.js";
import { DailyNewsHandoff } from "../../src/daily-news-handoff.js";
import { ScheduledTasks } from "../../src/scheduled-tasks.js";

const [root, mode, oldPid] = process.argv.slice(2) as [string, string, string];
const statePath = path.join(root, "news.json"), databasePath = path.join(root, "tasks.sqlite");
const now = Date.parse("2026-10-16T02:00:00Z") + Number(process.argv[5] ?? 0);
process.send?.("ready");
process.once("message", () => void (async () => {
  if (mode === "legacy") {
    const news = new DailyAiNewsScheduler({ store: new DailyAiNewsFileStore(statePath), now: () => now, setTimer: () => 0, clearTimer: () => {},
      researcher: { generate: async ({ date }) => ({ date, generatedAt: now, items: [] }) },
      channel: { getSnapshot: () => ({ accounts: [{ accountId: "fixture", credentialStatus: "usable" }], targets: [{ accountId: "fixture", target: "recipient@im.wechat" }] }),
        sendText: async () => ({ ok: false, reason: "context_missing", acceptedSegments: 0 }) } });
    await news.enable("fixture", "recipient@im.wechat"); news.close(); process.exit(0);
  }
  const handoff = new DailyNewsHandoff(statePath);
  const source = handoff.prepare(Number(oldPid));
  if (mode === "prepared") { process.send?.("prepared"); return; }
  const tasks = new ScheduledTasks({ databasePath, now: () => now, readOriginalText: () => undefined, dailyNewsImport: source,
    dailyNewsActive: () => mode !== "committed",
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "new-binding", contextGeneration: "fresh", contextUpdatedAt: now + 1 }),
      send: async ({ message }) => { fs.appendFileSync(path.join(root, "outbox.jsonl"), JSON.stringify({ message }) + "\n");
        if (mode === "sending") { process.send?.("sending"); return new Promise(() => {}); }
        return { ok: true }; } } });
  if (mode === "committed") { process.send?.("committed"); return; }
  await tasks.tick(); tasks.close(); process.exit(0);
})().catch((error) => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); }));
