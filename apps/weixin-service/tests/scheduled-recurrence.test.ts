import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasks, type ScheduledTasksOptions, type ScheduledTask, type ScheduledOccurrence } from "../src/scheduled-tasks.js";

// Public tools, real SQLite and injected clock/channel. Expected instants come from the spec examples.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const turn = { accountId: "fixture", target: "user@im.wechat", eventKey: "create", occurredAt: 0, originalTextRef: "text", attachmentRefs: [] };
function setup(options: Partial<ScheduledTasksOptions> = {}, initial = "2026-10-14T02:15:00Z") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-recurrence-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse(initial);
  const open = () => {
    const service = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => now, readOriginalText: () => "original request", ...options });
    cleanup.push(() => service.close()); return service;
  };
  return { service: open(), open, setNow: (at: string) => { now = Date.parse(at); } };
}
function call(service: ScheduledTasks, tool: string, args: Record<string, unknown> = {}, eventKey = tool, scope = turn) {
  // These mechanical fixtures explicitly keep their established body; wording is tested separately.
  if ((tool === "create" || tool === "edit") && args.instruction !== undefined && args.reminderText === undefined) {
    const name = args.name ?? "活动提醒";
    args = { ...args, reminderText: `提醒：${name}\n\n${args.instruction}`, reminderMode: "natural" };
  }
  return service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...scope, eventKey });
}
function create(service: ScheduledTasks, args: Record<string, unknown> = {}, eventKey = "create") {
  return call(service, "create", { name: "活动提醒", instruction: "活动一下", intervalSeconds: 7200, sourceText: "original request", ...args }, eventKey);
}
const mutation = (reference: string, expectedRevision: number) => ({ reference, expectedRevision, sourceText: "original request" });
async function inspect(service: ScheduledTasks, reference: string) {
  return await call(service, "inspect", { reference }) as { task: ScheduledTask & { lifecycle: string }; history: ScheduledOccurrence[]; totalOccurrences: number };
}

describe("recurring schedules", () => {
  it("persists the interval anchor through execution, content edits, pause and restart", async () => {
    const outbox: string[] = [];
    const { service, setNow, open } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const result = await create(service);
    expect(result).toMatchObject({ status: "created", task: { schedule: { kind: "interval", everySeconds: 7200, firstAt: "2026-10-14T04:15:00.000Z" }, nextExecutionAt: "2026-10-14T04:15:00.000Z", timezone: "Asia/Shanghai" } });
    const { task } = result as { task: ScheduledTask };
    setNow("2026-10-14T04:40:00Z"); await service.tick();
    expect(await inspect(service, task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T06:15:00.000Z", lifecycle: "scheduled" }, history: [{ plannedAt: "2026-10-14T04:15:00.000Z", delivery: "accepted" }] });
    setNow("2026-10-14T04:50:00Z"); await call(service, "disable", mutation(task.id, 1));
    setNow("2026-10-14T07:00:00Z");
    expect(await call(service, "enable", mutation(task.id, 2))).toMatchObject({ status: "enabled", task: { nextExecutionAt: "2026-10-14T08:15:00.000Z" } });
    setNow("2026-10-14T07:10:00Z"); await call(service, "edit", { ...mutation(task.id, 3), instruction: "站起来活动" });
    service.close(); const restarted = open(); await restarted.tick();
    expect(await inspect(restarted, task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T08:15:00.000Z", schedule: { firstAt: "2026-10-14T04:15:00.000Z" } }, totalOccurrences: 1 });
    setNow("2026-10-14T08:15:00Z"); await restarted.tick(); await restarted.tick();
    expect(outbox).toEqual(["提醒：活动提醒\n\n活动一下", "提醒：活动提醒\n\n站起来活动"]);
  });
  it("executes only the latest missed slot and retains one compact skipped range across replay", async () => {
    const { service, setNow, open } = setup();
    const result = await create(service) as { task: ScheduledTask };
    setNow("2026-10-14T09:00:00Z"); await service.tick(); await service.tick();
    expect(await inspect(service, result.task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T10:15:00.000Z" }, totalOccurrences: 2,
      history: expect.arrayContaining([
        expect.objectContaining({ execution: "succeeded", plannedAt: "2026-10-14T08:15:00.000Z", body: "提醒：活动提醒\n\n活动一下" }),
        expect.objectContaining({ execution: "skipped", skippedRange: { from: "2026-10-14T04:15:00.000Z", through: "2026-10-14T06:15:00.000Z", cadenceRevision: 1 } }),
      ]) });
    service.close(); const restarted = open(); await restarted.tick();
    expect(await inspect(restarted, result.task.id)).toMatchObject({ totalOccurrences: 2 });
    expect(await create(restarted)).toMatchObject({ task: { id: result.task.id, nextExecutionAt: "2026-10-14T10:15:00.000Z" } });
  });

  it.each([
    ["2026-10-14T02:15:00Z", "Asia/Shanghai", "21:00", [5], "2026-10-16T13:00:00.000Z", "2026-10-23T13:00:00.000Z"],
    ["2026-03-07T08:00:00Z", "America/New_York", "02:30", undefined, "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"],
    ["2026-11-01T04:00:00Z", "America/New_York", "01:30", undefined, "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
    ["2026-10-03T16:00:00Z", "Australia/Lord_Howe", "02:15", undefined, "2026-10-04T15:15:00.000Z", "2026-10-05T15:15:00.000Z"],
  ])("keeps calendar wall time and skips gaps/uses the first fold instant (%s, %s)", async (initial, timezone, time, weekdays, first, next) => {
    const { service, setNow } = setup({}, initial);
    const result = await call(service, "create", { name: "日历提醒", instruction: "整理周报", calendar: { time, ...(weekdays ? { weekdays } : {}) }, timezone, sourceText: "original request" });
    expect(result).toMatchObject({ status: "created", task: { nextExecutionAt: first, timezone, schedule: { kind: "calendar" } } });
    const { task } = result as { task: ScheduledTask };
    setNow(first); await service.tick();
    expect(await inspect(service, task.id)).toMatchObject({ task: { nextExecutionAt: next }, totalOccurrences: 1, history: [{ plannedAt: first }] });
    if (timezone === "America/New_York" && time === "01:30") {
      setNow("2026-11-01T06:45:00Z"); await service.tick();
      expect(await inspect(service, task.id)).toMatchObject({ totalOccurrences: 1, task: { nextExecutionAt: next } });
    }
  });

  it("starts a new cadence only for rule edits and preserves frozen cache and operation replay", async () => {
    const { service, setNow, open } = setup(); const { task } = await create(service) as { task: ScheduledTask };
    setNow("2026-10-14T04:15:00Z"); await service.tick();
    await call(service, "disable", mutation(task.id, 1));
    setNow("2026-10-14T07:20:00Z");
    const args = { ...mutation(task.id, 2), intervalSeconds: 3600, instruction: "新内容" };
    expect(await call(service, "edit", args)).toMatchObject({ task: { enabled: false, cadenceRevision: 2, nextExecutionAt: "2026-10-14T08:20:00.000Z" } });
    expect(await inspect(service, task.id)).toMatchObject({ history: [{ revision: 1, body: "提醒：活动提醒\n\n活动一下" }] });
    expect(await call(service, "edit", { ...args, expectedRevision: 1 }, "stale")).toMatchObject({ code: "revision_conflict" });
    setNow("2026-10-14T10:00:00Z"); service.close(); const restarted = open();
    expect(await call(restarted, "edit", args)).toMatchObject({ replayed: true, task: { nextExecutionAt: "2026-10-14T08:20:00.000Z", cadenceRevision: 2 } });
    await call(restarted, "enable", mutation(task.id, 3));
    expect(await inspect(restarted, task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T10:20:00.000Z" }, totalOccurrences: 1 });
    await call(restarted, "edit", { ...mutation(task.id, 4), intervalSeconds: 7200, startAt: "2026-10-15T08:00:00Z" }, "explicit-start");
    expect(await inspect(restarted, task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-15T08:00:00.000Z", cadenceRevision: 3 } });
  });

  it.each([
    { intervalSeconds: 0 }, { intervalSeconds: -1 }, { intervalSeconds: 59 }, { intervalSeconds: 1.5 },
    { intervalSeconds: 7200, at: "2026-10-20T00:00:00Z" },
    { intervalSeconds: 7200, calendar: { time: "09:00" } },
    { calendar: { time: "25:00" } }, { calendar: { time: "09:00", weekdays: [] } },
    { calendar: { time: "09:00", weekdays: [1, 1] } }, { calendar: { time: "09:00", weekdays: [7] } },
    { startAt: "2026-10-20T00:00:00Z" }, { intervalSeconds: 60, startAt: "2026-02-30T00:00:00Z" },
    { intervalSeconds: 60, startAt: "2026-10-14T02:00:00Z" },
    { calendar: { time: "09:00" }, timezone: "Invalid/Zone" },
    { calendar: { time: "09:00" }, timezone: "+08:00" },
    { intervalSeconds: 60, target: "another-recipient" }, {},
  ])("rejects invalid or contradictory recurrence without a partial mutation: %j", async (invalid) => {
    const { service } = setup();
    expect(await call(service, "create", { name: "invalid", instruction: "content", sourceText: "original request", ...invalid })).toMatchObject({ status: "error" });
    expect(await call(service, "list")).toMatchObject({ total: 0 });
    const { task } = await create(service) as { task: ScheduledTask };
    expect(await call(service, "edit", { ...mutation(task.id, 1), ...invalid })).toMatchObject({ status: "error" });
    expect(await inspect(service, task.id)).toMatchObject({ task: { revision: 1, name: "活动提醒", nextExecutionAt: "2026-10-14T04:15:00.000Z" } });
  });

  it("applies configured minimums and treats calendar timezone changes as a new future cadence", async () => {
    const { service, setNow } = setup({ limits: { minimumRecurringSeconds: 86400 } });
    expect(await create(service)).toMatchObject({ code: "interval_too_short" });
    expect(await call(service, "create", { name: "daily", instruction: "text", sourceText: "original request", calendar: { time: "09:00" }, timezone: "America/New_York" })).toMatchObject({ code: "interval_too_short" });
    const result = await call(service, "create", { name: "weekly", instruction: "text", sourceText: "original request", calendar: { time: "21:00", weekdays: [5] } }) as { task: ScheduledTask };
    expect(result).toMatchObject({ task: { nextExecutionAt: "2026-10-16T13:00:00.000Z" } });
    setNow("2026-10-16T13:00:00Z"); await service.tick();
    await call(service, "edit", { ...mutation(result.task.id, 1), timezone: "America/New_York" });
    expect(await inspect(service, result.task.id)).toMatchObject({ task: { cadenceRevision: 2, nextExecutionAt: "2026-10-17T01:00:00.000Z" }, history: [{ plannedAt: "2026-10-16T13:00:00.000Z" }] });
  });

  it("admits latest candidates in time order at capacity and wakes with the new latest slot after space is freed", async () => {
    const { service, setNow } = setup({ limits: { recipientPendingCount: 1 } });
    const first = await create(service) as { task: ScheduledTask };
    const second = await create(service, { name: "second", startAt: "2026-10-14T04:00:00Z" }, "second") as { task: ScheduledTask };
    setNow("2026-10-14T09:00:00Z"); await service.tick();
    expect(await inspect(service, second.task.id)).toMatchObject({ history: expect.arrayContaining([expect.objectContaining({ plannedAt: "2026-10-14T08:00:00.000Z", execution: "succeeded" })]) });
    expect(await inspect(service, first.task.id)).toMatchObject({ task: { blocker: { code: "pending_capacity" } }, totalOccurrences: 0 });
    expect(await call(service, "run_now", mutation(first.task.id, 1))).toMatchObject({ status: "blocked", code: "pending_capacity" });
    setNow("2026-10-14T11:00:00Z"); await call(service, "delete", mutation(second.task.id, 1)); await service.tick();
    expect(await inspect(service, first.task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T12:15:00.000Z" }, history: expect.arrayContaining([
      expect.objectContaining({ plannedAt: "2026-10-14T10:15:00.000Z", execution: "succeeded" }),
      expect.objectContaining({ execution: "skipped", skippedRange: { from: "2026-10-14T04:15:00.000Z", through: "2026-10-14T08:15:00.000Z", cadenceRevision: 1 } }),
    ]) });
  });

  it("fences a lost generation, discards its late body and allows a later recurring slot without overlap", async () => {
    let finish!: (body: string) => void; let hang = true; const renders: string[] = [];
    const { service, setNow, open } = setup({ renderReminder: async (task) => { renders.push(task.instruction); if (!hang) return "new result"; return new Promise<string>((resolve) => { finish = resolve; }); } });
    const { task } = await create(service, { intervalSeconds: 60 }) as { task: ScheduledTask };
    setNow("2026-10-14T02:16:00Z"); const pending = service.tick();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const second = open(); await second.tick();
    expect(await call(second, "run_now", mutation(task.id, 1))).toMatchObject({ status: "busy" });
    expect(renders).toHaveLength(1);
    setNow("2026-10-14T02:20:00Z"); hang = false; await second.tick();
    finish("stale body"); await pending;
    const state = await inspect(second, task.id);
    expect(state).toMatchObject({ task: { nextExecutionAt: "2026-10-14T02:21:00.000Z" }, history: expect.arrayContaining([
      expect.objectContaining({ plannedAt: "2026-10-14T02:16:00.000Z", execution: "unknown" }),
      expect.objectContaining({ plannedAt: "2026-10-14T02:20:00.000Z", execution: "succeeded", body: "new result" }),
    ]) });
    expect(state.history.some((item) => item.body === "stale body")).toBe(false);
    expect(renders).toHaveLength(2);
  });

  it("keeps caches ordered across tasks and pause, manual grants and calendar edits", async () => {
    let context: string | null = null; const outbox: string[] = [];
    const { service, setNow } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: context }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const first = await create(service) as { task: ScheduledTask };
    const second = await create(service, { name: "second", startAt: "2026-10-14T04:00:00Z" }, "second") as { task: ScheduledTask };
    setNow("2026-10-14T04:20:00Z"); await service.tick();
    expect(await call(service, "disable", mutation(second.task.id, 1), "disable-second")).toMatchObject({ status: "disabled" });
    expect(await call(service, "edit", { ...mutation(first.task.id, 1), instruction: "manual", calendar: { time: "22:00" } })).toMatchObject({ status: "updated" });
    expect(await call(service, "disable", mutation(first.task.id, 2), "disable-first")).toMatchObject({ status: "disabled" });
    expect(await call(service, "run_now", mutation(first.task.id, 3))).toMatchObject({ status: "started" }); await service.tick(); context = "new"; await service.tick();
    expect(outbox).toEqual(["提醒：活动提醒\n\nmanual"]);
    await call(service, "enable", mutation(first.task.id, 3)); await call(service, "enable", mutation(second.task.id, 2), "enable-second"); await service.tick();
    expect(outbox).toEqual(["提醒：活动提醒\n\nmanual", "提醒：second\n\n活动一下", "提醒：活动提醒\n\n活动一下"]);
    expect(await inspect(service, first.task.id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T14:00:00.000Z" }, totalOccurrences: 2 });
    const admission = service.memoryAdmission([{ ...turn, originalText: "original request", sourceText: "original request", owner: "linked" }]);
    expect(admission.reserve("linked")).toBe(false);
    await call(service, "delete", mutation(first.task.id, 4)); expect(admission.reserve("linked")).toBe(false);
  });

  it("retains the recurrence cursor beyond 31 executions and never calls a recurring task completed", async () => {
    const outbox: string[] = [];
    const { service, setNow, open } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const { task } = await create(service, { intervalSeconds: 60 }) as { task: ScheduledTask };
    for (let i = 16; i <= 49; i++) { setNow(`2026-10-14T02:${i}:00Z`); await service.tick(); }
    expect(await inspect(service, task.id)).toMatchObject({ task: { lifecycle: "scheduled", nextExecutionAt: "2026-10-14T02:50:00.000Z" }, totalOccurrences: 34, executionCount: 34 });
    service.close(); const restarted = open(); setNow("2026-10-14T02:16:00Z"); await restarted.tick();
    expect(outbox).toHaveLength(34);
    expect(await call(restarted, "list", { view: "completed" })).toMatchObject({ total: 0 });
    expect(await call(restarted, "list")).toMatchObject({ total: 1 });
  });

  it("compacts years of downtime without enumerating each slot and preserves the cadence across calendar pause", async () => {
    const { service, setNow } = setup(); const { task } = await create(service, { intervalSeconds: 60 }) as { task: ScheduledTask };
    setNow("2036-10-14T02:15:30Z"); await service.tick();
    expect(await inspect(service, task.id)).toMatchObject({ totalOccurrences: 2, executionCount: 1, task: { nextExecutionAt: "2036-10-14T02:16:00.000Z" }, history: expect.arrayContaining([
      expect.objectContaining({ execution: "skipped", skippedRange: { from: "2026-10-14T02:16:00.000Z", through: "2036-10-14T02:14:00.000Z", cadenceRevision: 1 } }),
    ]) });
    await call(service, "edit", { ...mutation(task.id, 1), calendar: { time: "09:00", weekdays: [1] } });
    await call(service, "disable", mutation(task.id, 2)); setNow("2036-11-01T02:00:00Z");
    expect(await call(service, "enable", mutation(task.id, 3))).toMatchObject({ status: "enabled", task: { nextExecutionAt: "2036-11-03T01:00:00.000Z", cadenceRevision: 2 } });
    await service.tick(); expect(await inspect(service, task.id)).toMatchObject({ totalOccurrences: 2 });
  });

  it("admits older due candidates before a later manual request under the shared execution limit", async () => {
    const { service, setNow } = setup();
    await create(service, { name: "older", startAt: "2026-10-14T04:00:00Z" }, "older");
    await create(service, { name: "next", startAt: "2026-10-14T04:10:00Z" }, "next");
    const manual = await create(service, { name: "manual" }, "manual") as { task: ScheduledTask };
    setNow("2026-10-14T04:11:00Z");
    expect(await call(service, "run_now", mutation(manual.task.id, 1))).toMatchObject({ status: "blocked", code: "execution_capacity" });
    await service.tick();
    expect(await inspect(service, "older")).toMatchObject({ history: [{ execution: "succeeded", plannedAt: "2026-10-14T04:00:00.000Z" }] });
    expect(await inspect(service, "next")).toMatchObject({ history: [{ execution: "succeeded", plannedAt: "2026-10-14T04:10:00.000Z" }] });
    expect(await inspect(service, manual.task.id)).toMatchObject({ totalOccurrences: 0 });
  });

  it("clears an obsolete admission blocker when a cadence edit moves execution into the future", async () => {
    const { service, setNow } = setup({ limits: { recipientPendingCount: 1 } });
    const first = await create(service) as { task: ScheduledTask };
    const blocked = await create(service, { name: "blocked", startAt: "2026-10-14T04:20:00Z" }, "blocked") as { task: ScheduledTask };
    setNow("2026-10-14T04:20:00Z"); await service.tick();
    expect(await inspect(service, blocked.task.id)).toMatchObject({ task: { blocker: { code: "pending_capacity" } } });
    const edited = await call(service, "edit", { ...mutation(blocked.task.id, 1), intervalSeconds: 3600 }) as { task: Record<string, unknown> };
    expect(edited).toMatchObject({ task: { nextExecutionAt: "2026-10-14T05:20:00.000Z" } });
    expect(edited.task).not.toHaveProperty("currentBlocker");
    expect(edited.task).not.toHaveProperty("blocker");
    expect(await inspect(service, first.task.id)).toMatchObject({ history: [{ body: "提醒：活动提醒\n\n活动一下" }] });
  });

  it("accepts representable long intervals and rejects an overflowing date without writing a task", async () => {
    const { service } = setup();
    expect(await create(service, { intervalSeconds: 400000000, startAt: "2026-10-20T00:00:00Z" })).toMatchObject({ status: "created", task: { schedule: { everySeconds: 400000000 }, nextExecutionAt: "2026-10-20T00:00:00.000Z" } });
    expect(await create(service, { intervalSeconds: Number.MAX_SAFE_INTEGER }, "overflow")).toMatchObject({ status: "error" });
    expect(await create(service, { intervalSeconds: 8900000000000, startAt: "2026-10-14T02:16:00Z" }, "overflow-next")).toMatchObject({ status: "error" });
    expect(await call(service, "list")).toMatchObject({ total: 1 });
  });

});
