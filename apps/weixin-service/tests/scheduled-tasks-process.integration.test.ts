import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { ScheduledTasks } from "../src/scheduled-tasks.js";

// Separate OS processes use current TypeScript source, real SQLite and a file-backed channel boundary.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const turn = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "event-1", occurredAt: 1791856800000, originalTextRef: "query-1", attachmentRefs: [] };
async function fixture(createReminder = true, schedule = { at: "2026-10-14T15:00:00+08:00" } as Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-process-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "tasks.sqlite"), outboxPath = path.join(root, "outbox.jsonl");
  fs.writeFileSync(outboxPath, "");
  let now = Date.parse("2026-10-13T02:00:00Z");
  const store = new ScheduledTasks({ databasePath, now: () => now, readOriginalText: () => "明天下午三点提醒我浇水" });
  cleanup.push(() => store.close());
  if (createReminder) await store.execute({ toolId: "schedules.create", toolVersion: 1, arguments: { name: "浇水", instruction: "给花浇水", reminderText: "提醒：浇水\n\n给花浇水", reminderMode: "natural", ...schedule, sourceText: "明天下午三点提醒我浇水" } }, turn);
  const children: ChildProcess[] = [];
  cleanup.push(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const start = async (mode: string, at = mode.startsWith("intent-") ? "2026-10-13T02:00:00Z" : "2026-10-14T07:00:00Z") => {
    const child = fork(fileURLToPath(new URL("./fixtures/scheduled-task-worker.ts", import.meta.url)), [databasePath, outboxPath, mode, String(Date.parse(at))], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    let errors = ""; child.stderr?.on("data", (chunk) => { errors += String(chunk); });
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors || "worker exited before ready"); })]);
    return child;
  };
  return { store, outboxPath, start, setNow: (value: string) => { now = Date.parse(value); } };
}

describe("scheduled reminder process ownership", () => {
  it("two independent workers claim and submit one due occurrence only once", async () => {
    const { store, outboxPath, start } = await fixture();
    const [first, second] = await Promise.all([start("accept"), start("accept")]);
    const exits = [once(first, "exit"), once(second, "exit")];
    first.send("wake"); second.send("wake");
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
    expect(fs.readFileSync(outboxPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ message: "提醒：浇水\n\n给花浇水" }]);
    expect(await store.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "浇水" } }, turn)).toMatchObject({ history: [{ execution: "succeeded", delivery: "accepted", totalAttempts: 1 }] });
  }, 20000);

  it("racing memory extraction and scheduled creation retain exactly one owner across process restart and replay", async () => {
    const { store, outboxPath, start } = await fixture(false);
    const race = async () => {
      const workers = await Promise.all([start("intent-schedule"), start("intent-memory")]);
      const exits = workers.map((worker) => once(worker, "exit"));
      workers.forEach((worker) => worker.send("wake"));
      expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
    };
    await race();
    const memory = new AccountMemoryStore(path.join(path.dirname(outboxPath), "memory"));
    const scheduled = await store.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, turn) as { total: number };
    expect(scheduled.total + memory.read("fixture-bot").eventCount).toBe(1);
    await race();
    expect(await store.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, turn)).toMatchObject({ total: scheduled.total });
    expect(memory.duePlanReminders("fixture-bot", Date.parse("2026-10-14T16:00:00Z"))).toHaveLength(1 - scheduled.total);
    expect(fs.readFileSync(outboxPath, "utf8")).toBe("");
  }, 20000);

  it("a killed submitting process becomes unknown after fencing and is never replayed", async () => {
    const { store, outboxPath, start, setNow } = await fixture();
    const child = await start("hang"); const submitted = once(child, "message"); child.send("wake"); await submitted;
    await vi.waitFor(() => expect(fs.readFileSync(outboxPath, "utf8")).toContain("给花浇水"));
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    setNow("2026-10-14T07:01:01Z"); await store.tick(); await store.tick();
    expect(await store.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "浇水" } }, turn)).toMatchObject({ history: [{ execution: "succeeded", delivery: "unknown", reason: "submission_interrupted", totalAttempts: 1 }] });
    store.close();
    const recovered = new ScheduledTasks({ databasePath: path.join(path.dirname(outboxPath), "tasks.sqlite"), now: () => Date.parse("2026-10-14T07:01:02Z"), readOriginalText: () => undefined,
      channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "binding-1", contextGeneration: "fresh-context" }),
        send: async ({ message }) => { fs.appendFileSync(outboxPath, JSON.stringify({ message }) + "\n"); return { ok: true }; } },
    });
    try { await recovered.tick(); await recovered.tick(); } finally { recovered.close(); }
    const messages = fs.readFileSync(outboxPath, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages.filter((message) => message.startsWith("提醒："))).toEqual(["提醒：浇水\n\n给花浇水"]);
    expect(messages).toHaveLength(2); expect(messages[1]).toContain("发送结果无法确认");
  }, 20000);
  it("deduplicates a paused manual request across competing processes and later replay", async () => {
    const { store, outboxPath, start } = await fixture();
    const task = await store.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "浇水" } }, turn) as { task: { id: string } };
    await store.execute({ toolId: "schedules.disable", toolVersion: 1, arguments: { reference: task.task.id, expectedRevision: 1, sourceText: "明天下午三点提醒我浇水" } }, { ...turn, eventKey: "pause" });
    const workers = await Promise.all([start("manual"), start("manual")]);
    const exits = workers.map((worker) => once(worker, "exit")); workers.forEach((worker) => worker.send("wake"));
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
    const replay = await start("manual"), exit = once(replay, "exit"); replay.send("wake"); expect(await exit).toEqual([0, null]);
    expect(fs.readFileSync(outboxPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ message: "提醒：浇水\n\n给花浇水" }]);
    expect(await store.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: task.task.id } }, turn)).toMatchObject({ task: { enabled: false, pauseGeneration: 1 }, totalOccurrences: 1, history: [{ kind: "manual", delivery: "accepted", totalAttempts: 1 }] });
  }, 20000);

  it("competing processes claim one latest recurring slot and preserve the cursor across restart", async () => {
    const { store, outboxPath, start } = await fixture(true, { intervalSeconds: 60, startAt: "2026-10-14T07:00:00Z" });
    const race = async (at: string) => {
      const workers = await Promise.all([start("accept", at), start("accept", at)]);
      const exits = workers.map((worker) => once(worker, "exit")); workers.forEach((worker) => worker.send("wake"));
      expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
    };
    await race("2026-10-14T07:05:00Z"); await race("2026-10-14T07:05:00Z");
    expect(fs.readFileSync(outboxPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(await store.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "浇水" } }, turn)).toMatchObject({ totalOccurrences: 2, task: { nextExecutionAt: "2026-10-14T07:06:00.000Z" }, history: expect.arrayContaining([
      expect.objectContaining({ plannedAt: "2026-10-14T07:05:00.000Z", delivery: "accepted" }), expect.objectContaining({ execution: "skipped" }),
    ]) });
    await race("2026-10-14T07:06:00Z"); expect(fs.readFileSync(outboxPath, "utf8").trim().split("\n")).toHaveLength(2);
  }, 20000);

  it("a killed recurring generator becomes unknown while the latest later slot can execute", async () => {
    const { store, outboxPath, start } = await fixture(true, { intervalSeconds: 60, startAt: "2026-10-14T07:00:00Z" });
    const child = await start("hang-generation"); const claimed = once(child, "message"); child.send("wake"); await claimed;
    expect(fs.readFileSync(outboxPath, "utf8")).toBe("");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const recovered = await start("accept", "2026-10-14T07:05:00Z"), done = once(recovered, "exit"); recovered.send("wake"); expect(await done).toEqual([0, null]);
    const messages = fs.readFileSync(outboxPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message: string });
    expect(messages.filter((item) => item.message.startsWith("提醒："))).toEqual([{ message: "提醒：浇水\n\n给花浇水" }]);
    expect(await store.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "浇水" } }, turn)).toMatchObject({ totalOccurrences: 3, history: expect.arrayContaining([
      expect.objectContaining({ plannedAt: "2026-10-14T07:00:00.000Z", execution: "unknown" }),
      expect.objectContaining({ plannedAt: "2026-10-14T07:05:00.000Z", delivery: "accepted" }),
    ]) });
  }, 20000);

});
