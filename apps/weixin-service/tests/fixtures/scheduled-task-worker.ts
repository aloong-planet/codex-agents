import fs from "node:fs";
import path from "node:path";
import { AccountMemoryStore } from "../../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../../src/account-memory-tool-host.js";
import { ScheduledTasks } from "../../src/scheduled-tasks.js";

const [databasePath, outboxPath, mode, instant] = process.argv.slice(2);
if (!databasePath || !outboxPath || !instant) throw new Error("worker arguments missing");
const tasks = new ScheduledTasks({ databasePath, now: () => Number(instant), readOriginalText: () => mode === "manual" ? "现在执行一次浇水" : "明天下午三点提醒我浇水",
  ...(mode === "hang-generation" ? { renderReminder: async () => { process.send?.({ state: "generating" }); return new Promise<string>(() => {}); } } : {}),
  channel: {
    state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "binding-1", contextGeneration: "context-1" }),
    send: async ({ message, beforeSubmit }) => {
      if (!beforeSubmit()) return { ok: false, reason: "context_missing", acceptedSegments: 0 };
      fs.appendFileSync(outboxPath, JSON.stringify({ message }) + "\n");
      process.send?.({ state: "submitted" });
      if (mode === "hang") await new Promise<void>(() => {});
      return { ok: true, acceptedSegments: 1 };
    },
  },
});
process.send?.({ state: "ready" });
process.once("message", () => {
  const work = async () => {
    const turn = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "event-1", occurredAt: Number(instant), originalTextRef: "query-1", attachmentRefs: [] };
    if (mode === "manual") {
      const result = await tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "浇水" } }, turn) as { task: { id: string; revision: number } };
      await tasks.execute({ toolId: "schedules.run_now", toolVersion: 1, arguments: { reference: result.task.id, expectedRevision: result.task.revision, sourceText: "现在执行一次浇水" } }, { ...turn, eventKey: "manual-1" });
      await tasks.tick();
    } else if (mode === "intent-schedule") {
      await tasks.execute({ toolId: "schedules.create", toolVersion: 1, arguments: { name: "浇水", instruction: "给花浇水", reminderText: "提醒：浇水\n\n给花浇水", reminderMode: "natural", at: "2026-10-14T15:00:00+08:00", sourceText: "明天下午三点提醒我浇水" } }, turn);
    } else if (mode === "intent-memory") {
      const memory = new AccountMemoryStore(path.join(path.dirname(databasePath!), "memory"));
      await new AccountMemoryToolHost(memory, undefined, tasks).commit({ accountId: "fixture-bot", jobId: "job-1", batchId: "batch-1", evidenceEntryIds: ["entry-1"],
        evidenceTexts: { "entry-1": "明天下午三点提醒我浇水" }, evidenceLocalDates: { "entry-1": "2026-10-13" }, evidenceOrigins: { "entry-1": { eventKey: "event-1", target: "fixture-user@im.wechat" } }, mutationPolicy: { mode: "free_add" } },
      { basedOnRevision: 0, batchId: "batch-1", decisions: [{ kind: "record_event", eventKind: "planned", localDate: "2026-10-14", timePrecision: "exact", localTime: "15:00", summary: "给花浇水", sourceText: "明天下午三点提醒我浇水", planMatch: null, evidenceEntryIds: ["entry-1"], confidence: 1 }] });
    } else await tasks.tick();
  };
  void work().then(() => { tasks.close(); process.disconnect?.(); }).catch((error) => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
});
