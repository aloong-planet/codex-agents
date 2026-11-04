import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasks, type ScheduledTasksOptions } from "../src/scheduled-tasks.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

// Public tools, real SQLite, injected time/render/channel. No private state setup.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const turn: TrustedWorkflowTurn = { accountId: "fixture", target: "user@im.wechat", eventKey: "create", occurredAt: 0, originalTextRef: "text", attachmentRefs: [] };
function setup(options: Partial<ScheduledTasksOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-lifecycle-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-14T02:00:00Z");
  const open = () => {
    const service = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => now, readOriginalText: () => "original request", ...options });
    cleanup.push(() => service.close()); return service;
  };
  return { service: open(), open, setNow: (at: string) => { now = Date.parse(at); } };
}
function call(service: ScheduledTasks, tool: string, args: Record<string, unknown> = {}, eventKey = tool, scope = turn) {
  // These mechanical fixtures explicitly keep their established body; wording is tested separately.
  if ((tool === "create" || tool === "edit") && args.instruction !== undefined && args.reminderText === undefined) {
    const name = args.name ?? "浇水提醒";
    args = { ...args, reminderText: `提醒：${name}\n\n${args.instruction}`, reminderMode: "natural" };
  }
  return service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...scope, eventKey });
}
async function create(service: ScheduledTasks, eventKey = "create", name = "浇水提醒") {
  const result = await call(service, "create", { name, instruction: "给花浇水", at: "2026-10-14T15:00:00+08:00", sourceText: "original request" }, eventKey) as { task: { id: string; revision: number } };
  return result.task;
}
const mutation = (reference: string, expectedRevision: number) => ({ reference, expectedRevision, sourceText: "original request" });

describe("scheduled task lifecycle", () => {
  it("atomically edits settings, rejects stale revisions, and replays a rename against current durable state", async () => {
    const { service, open } = setup(); const task = await create(service);
    const args = { ...mutation("浇水提醒", 1), name: "晚间浇水", instruction: "给兰花浇水", at: "2026-10-14T16:00:00+08:00" };
    expect(await call(service, "edit", args)).toMatchObject({ status: "updated", task: { id: task.id, name: "晚间浇水", instruction: "给兰花浇水", revision: 2, enabled: true, nextExecutionAt: "2026-10-14T08:00:00.000Z" } });
    expect(await call(service, "edit", { ...mutation(task.id, 1), instruction: "stale" }, "stale")).toMatchObject({ status: "conflict", code: "revision_conflict", task: { revision: 2 } });
    expect(await call(service, "edit", { ...mutation(task.id, 2), name: "invalid", at: "2026-02-30T08:00:00Z" }, "invalid")).toMatchObject({ status: "error", code: "invalid_settings" });
    service.close(); const restarted = open();
    expect(await call(restarted, "edit", args)).toMatchObject({ status: "updated", task: { id: task.id, name: "晚间浇水", instruction: "给兰花浇水", revision: 2 } });
    expect(await call(restarted, "list")).toMatchObject({ total: 1, tasks: [{ name: "晚间浇水", revision: 2 }] });
  });
  it("keeps cached output paused across edit, context refresh and restart, then resumes once", async () => {
    const outbox: string[] = []; let context: string | null = null;
    const { service, open, setNow } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "binding", contextGeneration: context }),
      send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const task = await create(service); setNow("2026-10-14T07:00:00Z"); await service.tick();
    expect(await call(service, "disable", mutation(task.id, 1))).toMatchObject({ status: "disabled", task: { enabled: false, pauseGeneration: 1 } });
    expect(await call(service, "edit", { ...mutation(task.id, 2), instruction: "新内容" })).toMatchObject({ task: { enabled: false, revision: 3 } });
    context = "fresh"; await service.tick(); expect(outbox).toEqual([]);
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ task: { deliveryEligibility: "paused" }, history: [{ revision: 1, body: "提醒：浇水提醒\n\n给花浇水" }] });
    service.close(); const restarted = open(); await restarted.tick();
    expect(await call(restarted, "disable", mutation(task.id, 1))).toMatchObject({ task: { pauseGeneration: 1, revision: 3 } });
    expect(await call(restarted, "disable", mutation(task.id, 3), "disable-again")).toMatchObject({ task: { pauseGeneration: 2, revision: 4 } });
    expect(await call(restarted, "enable", mutation(task.id, 4))).toMatchObject({ status: "enabled", task: { enabled: true } });
    await restarted.tick(); await restarted.tick(); expect(outbox).toEqual(["提醒：浇水提醒\n\n给花浇水"]);
  });

  it("authorizes only a paused manual result and revokes it on a later explicit disable", async () => {
    const outbox: string[] = []; let context: string | null = null;
    const { service, setNow, open } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "binding", contextGeneration: context }),
      send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const task = await create(service); setNow("2026-10-14T07:00:00Z"); await service.tick();
    await call(service, "disable", mutation(task.id, 1));
    await call(service, "edit", { ...mutation(task.id, 2), instruction: "第一次手动内容" });
    setNow("2026-10-14T07:01:00Z");
    const manual = await call(service, "run_now", mutation(task.id, 3), "manual-1") as { occurrenceId: string };
    expect(manual).toMatchObject({ status: "started", task: { enabled: false, nextExecutionAt: null, deliveryEligibility: "manual_authorized" } });
    await service.tick(); await call(service, "disable", mutation(task.id, 3), "disable-again");
    context = "fresh"; await service.tick(); expect(outbox).toEqual([]);
    await call(service, "edit", { ...mutation(task.id, 4), instruction: "第二次手动内容" }, "edit-again");
    expect(await call(service, "run_now", mutation(task.id, 5), "manual-2")).toMatchObject({ status: "started", task: { enabled: false } });
    await service.tick(); expect(outbox).toEqual(["提醒：浇水提醒\n\n第二次手动内容"]);
    service.close(); const restarted = open();
    expect(await call(restarted, "run_now", mutation(task.id, 3), "manual-1")).toMatchObject({ replayed: true, occurrenceId: manual.occurrenceId });
    await restarted.tick();
    expect(await call(restarted, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 3 });
    expect(outbox).toEqual(["提醒：浇水提醒\n\n第二次手动内容"]);
    await call(restarted, "enable", mutation(task.id, 5)); await restarted.tick();
    expect(outbox).toEqual(["提醒：浇水提醒\n\n第二次手动内容", "提醒：浇水提醒\n\n给花浇水", "提醒：浇水提醒\n\n第一次手动内容"]);
  });

  it("stops remaining parts after a pause even if reenabled, without blocking another task's channel", async () => {
    const outbox: string[] = []; let taskId = "";
    const { service, setNow } = setup({ renderReminder: async (task) => task.name === "浇水提醒" ? "a".repeat(1600) : "other task body",
      channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "binding", contextGeneration: "context" }),
        send: async ({ message }) => {
          outbox.push(message);
          if (message === "a".repeat(1500)) {
            await call(service, "disable", mutation(taskId, 1));
            await call(service, "enable", mutation(taskId, 2));
          }
          return { ok: true };
        } } });
    taskId = (await create(service)).id; await create(service, "other", "另一个提醒");
    setNow("2026-10-14T07:00:00Z"); await service.tick();
    expect(outbox.filter((body) => !body.startsWith("定时任务需要处理"))).toHaveLength(2); expect(outbox).toContain("other task body"); expect(outbox).not.toContain("a".repeat(100));
    expect(await call(service, "inspect", { reference: taskId })).toMatchObject({ history: [{ delivery: "partial" }] });
    await service.tick(); expect(outbox.filter((body) => !body.startsWith("定时任务需要处理"))).toHaveLength(2);
  });

  it("deletes an idle task without sending its cache or reviving its reminder intent", async () => {
    const { service, setNow, open } = setup(); const task = await create(service);
    setNow("2026-10-14T07:00:00Z"); await service.tick();
    expect(await call(service, "delete", mutation(task.id, 1))).toMatchObject({ status: "deleted", task: { id: task.id, lifecycle: "deleted", enabled: false, nextExecutionAt: null } });
    expect(await call(service, "list")).toMatchObject({ total: 0 });
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ history: [{ delivery: "cancelled", reason: "cancelled_by_task_deletion", body: "提醒：浇水提醒\n\n给花浇水" }] });
    service.close(); const restarted = open(); await restarted.tick();
    expect(await call(restarted, "list", { view: "all" })).toMatchObject({ total: 1, tasks: [{ lifecycle: "deleted" }] });
    expect(await call(restarted, "enable", mutation(task.id, 2))).toMatchObject({ status: "error", code: "task_deleted" });
    expect(await call(restarted, "create", { name: "浇水提醒", instruction: "给花浇水", at: "2026-10-14T15:00:00+08:00", sourceText: "original request" }, "create")).toMatchObject({ task: { id: task.id, lifecycle: "deleted" } });
    const admission = restarted.memoryAdmission([{ ...turn, originalText: "original request", sourceText: "original request", owner: "linked-memory" }]);
    expect(admission.reserve("linked-memory")).toBe(false);
    expect(await call(restarted, "delete", mutation(task.id, 1))).toMatchObject({ status: "deleted", task: { revision: 2 } });
  });

  it("retains unlimited history while protecting paused output and durable once/request claims", async () => {
    let context: string | null = null; const outbox: string[] = [];
    const { service, setNow, open } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "binding", contextGeneration: context }),
      send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const task = await create(service); setNow("2026-10-14T07:00:00Z"); await service.tick();
    await call(service, "disable", mutation(task.id, 1)); context = "fresh";
    for (let i = 0; i < 33; i++) {
      setNow(`2026-10-14T08:00:${String(i).padStart(2, "0")}Z`);
      await call(service, "run_now", mutation(task.id, 2), `manual-${i}`); await service.tick();
    }
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 34, task: { lifecycle: "pending_delivery" } });
    expect(await call(service, "read_text", { reference: `${task.id}:once`, field: "output" })).toMatchObject({ text: "提醒：浇水提醒\n\n给花浇水" });
    await call(service, "enable", mutation(task.id, 2)); await service.tick();
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 34, task: { lifecycle: "completed" } });
    service.close(); const restarted = open();
    await call(restarted, "run_now", mutation(task.id, 2), "manual-0"); await restarted.tick();
    expect(await call(restarted, "edit", { ...mutation(task.id, 3), at: "2026-10-15T07:00:00Z" })).toMatchObject({ status: "error", code: "schedule_exhausted" });
    expect(outbox).toHaveLength(34);
  });

  it("requires an explicit new time after a paused one-time deadline and keeps editing paused", async () => {
    const { service, setNow } = setup(); const task = await create(service);
    await call(service, "disable", mutation(task.id, 1)); setNow("2026-10-14T08:00:00Z");
    expect(await call(service, "enable", mutation(task.id, 2))).toMatchObject({ status: "needs_input", code: "overdue_once" });
    await service.tick(); expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 0, task: { enabled: false, revision: 2 } });
    expect(await call(service, "edit", { ...mutation(task.id, 2), at: "2026-10-15T08:00:00Z" })).toMatchObject({ task: { enabled: false, revision: 3, nextExecutionAt: "2026-10-15T08:00:00.000Z" } });
    await call(service, "enable", mutation(task.id, 3), "enable-new-time"); await service.tick();
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 0, task: { enabled: true } });
  });

  it("rejects ambiguous, foreign, invalid and conflicting mutations without modifying either task", async () => {
    let enabled = true;
    const { service } = setup({ channel: { state: () => ({ enabled, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: null }), send: async () => ({ ok: true }) } });
    const first = await create(service); await create(service, "second");
    for (const tool of ["edit", "disable", "enable", "run_now", "delete"]) {
      const args = { ...mutation("浇水提醒", 1), ...(tool === "edit" ? { name: "new" } : {}) };
      expect(await call(service, tool, args)).toMatchObject({ status: "needs_choice", total: 2 });
      expect(await call(service, tool, { ...args, reference: first.id }, tool, { ...turn, target: "foreign" })).toMatchObject({ status: "not_found" });
      expect(await call(service, tool, { ...args, target: "foreign" })).toMatchObject({ status: "error", code: "invalid_settings" });
    }
    expect(await call(service, "edit", { ...mutation(first.id, 1), name: " ", instruction: "changed" })).toMatchObject({ code: "invalid_settings" });
    expect(await call(service, "edit", { ...mutation(first.id, 1), timezone: "invalid/timezone" })).toMatchObject({ code: "timezone_invalid" });
    expect(await call(service, "edit", { ...mutation(first.id, 1), at: "2026-10-13T08:00:00Z" })).toMatchObject({ code: "time_in_past" });
    expect(await call(service, "disable", { ...mutation(first.id, 1), sourceText: "not original" })).toMatchObject({ code: "source_ambiguous" });
    enabled = false;
    expect(await call(service, "disable", mutation(first.id, 1))).toMatchObject({ code: "target_disabled" });
    enabled = true;
    await call(service, "disable", mutation(first.id, 1));
    expect(await call(service, "disable", mutation(first.id, 2))).toMatchObject({ code: "request_conflict" });
    expect(await call(service, "inspect", { reference: first.id })).toMatchObject({ totalOccurrences: 0, task: { revision: 2, pauseGeneration: 1, name: "浇水提醒", instruction: "给花浇水" } });
  });

  it("freezes claimed content across edits and rejects run-now and deletion while generation is busy", async () => {
    let finish!: () => void; const snapshots: string[] = [];
    const { service } = setup({ renderReminder: async (task) => { snapshots.push(task.instruction); await new Promise<void>((resolve) => { finish = resolve; }); return task.instruction; } });
    const task = await create(service);
    expect(await call(service, "run_now", mutation(task.id, 1))).toMatchObject({ status: "started", task: { enabled: true, nextExecutionAt: "2026-10-14T07:00:00.000Z" } });
    const ticking = service.tick();
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      for (const tool of ["run_now", "delete"]) expect(await call(service, tool, mutation(task.id, 1), `busy-${tool}`)).toMatchObject({ status: "busy", code: "task_busy" });
      await call(service, "edit", { ...mutation(task.id, 1), instruction: "edited during generation" });
      await call(service, "disable", mutation(task.id, 2));
    } finally { finish?.(); await ticking; }
    expect(snapshots).toEqual(["给花浇水"]);
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ task: { enabled: false, instruction: "edited during generation" }, history: [{ revision: 1, body: "给花浇水" }] });
  });

  it("rejects manual admission at capacity, and deletion frees space without sending protected output", async () => {
    const { service, setNow } = setup({ limits: { recipientPendingCount: 1 } });
    const first = await create(service); const second = await create(service, "second", "喝水");
    await call(service, "disable", mutation(second.id, 1)); setNow("2026-10-14T07:00:00Z"); await service.tick();
    expect(await call(service, "run_now", mutation(second.id, 2))).toMatchObject({ status: "blocked", code: "pending_capacity", usage: { recipientCount: 1 }, limits: { recipientPendingCount: 1 } });
    await call(service, "delete", mutation(first.id, 1));
    expect(await call(service, "run_now", mutation(second.id, 2))).toMatchObject({ status: "started" });
    await service.tick(); expect(await call(service, "inspect", { reference: second.id })).toMatchObject({ totalOccurrences: 1 });
  });

  it("fences an interrupted manual claim on restart and allows deletion without replay", async () => {
    const { service, open } = setup(); const task = await create(service);
    await call(service, "run_now", mutation(task.id, 1)); service.close(); const restarted = open(); await restarted.tick();
    expect(await call(restarted, "inspect", { reference: task.id })).toMatchObject({ history: [{ execution: "unknown", reason: "execution_interrupted" }] });
    expect(await call(restarted, "run_now", mutation(task.id, 1))).toMatchObject({ status: "started", task: { lifecycle: "unknown" } });
    expect(await call(restarted, "delete", mutation(task.id, 1))).toMatchObject({ status: "deleted" });
    await restarted.tick(); expect(await call(restarted, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 1, history: [{ execution: "unknown" }] });
  });

  it.each(["accepted", "partial", "rejected", "unknown"] as const)("does not replay a %s delivery after disable/enable", async (outcome) => {
    const outbox: string[] = [];
    const { service, setNow } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }),
      send: async ({ message }) => { outbox.push(message); return outcome === "accepted" ? { ok: true } : { ok: false, reason: outcome === "partial" ? "unknown" : outcome, ...(outcome === "partial" ? { acceptedSegments: 1 } : {}) }; } } });
    const task = await create(service); setNow("2026-10-14T07:00:00Z"); await service.tick();
    await call(service, "disable", mutation(task.id, 1)); await call(service, "enable", mutation(task.id, 2)); await service.tick();
    expect(outbox.filter((body) => body.startsWith("提醒："))).toEqual(["提醒：浇水提醒\n\n给花浇水"]);
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ totalOccurrences: 1, history: [{ delivery: outcome, totalAttempts: 1 }] });
    await call(service, "delete", mutation(task.id, 3));
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ history: [{ delivery: outcome, totalAttempts: 1 }] });
  });

  it("reports a failed authorized manual run while paused and suppresses a notice revoked before submission", async () => {
    let taskId = ""; const outbox: string[] = []; let revoke = false;
    const { service } = setup({ renderReminder: async () => { throw new Error("fixture execution failure"); },
      channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }),
        send: async ({ message, beforeSubmit }) => {
          if (revoke) { await call(service, "disable", mutation(taskId, 2), "pause-notice"); revoke = false; }
          if (!beforeSubmit()) return { ok: false, reason: "context_missing", acceptedSegments: 0 };
          outbox.push(message); return { ok: true };
        } } });
    taskId = (await create(service)).id; await call(service, "disable", mutation(taskId, 1));
    await call(service, "run_now", mutation(taskId, 2), "manual-1"); await service.tick();
    expect(outbox).toHaveLength(1); expect(outbox[0]).toContain("生成失败");
    revoke = true; await call(service, "run_now", mutation(taskId, 2), "manual-2"); await service.tick();
    expect(outbox).toHaveLength(1);
    const other = await create(service, "other", "other");
    await call(service, "run_now", mutation(other.id, 1), "manual-other"); await service.tick();
    expect(outbox).toHaveLength(2); expect(outbox[1]).toContain("other");
  });

  it("retains notice identity and unlimited history without hiding an unresolved failure", async () => {
    let fail = true, context: string | null = null; const outbox: string[] = [];
    const { service, setNow } = setup({ renderReminder: async () => { if (fail) throw new Error("failure"); return "manual body"; },
      channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: context }),
        send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
    const task = await create(service); await call(service, "disable", mutation(task.id, 1));
    await call(service, "run_now", mutation(task.id, 2), "failed"); await service.tick();
    await call(service, "disable", mutation(task.id, 2), "revoke"); fail = false; context = "fresh";
    for (let i = 0; i < 33; i++) {
      setNow(`2026-10-14T03:00:${String(i).padStart(2, "0")}Z`);
      await call(service, "run_now", mutation(task.id, 3), `manual-${i}`); await service.tick();
    }
    expect(await call(service, "inspect", { reference: task.id })).toMatchObject({ task: { lifecycle: "failed" }, totalOccurrences: 34, totalNotifications: 1 });
    await call(service, "enable", mutation(task.id, 3)); await service.tick();
    expect(outbox).toHaveLength(33); expect(outbox.every((body) => body === "manual body")).toBe(true);
  });

  it("reserves at most two manual executions and frees interrupted reservations only after fencing", async () => {
    const { service, open } = setup(); const first = await create(service); const second = await create(service, "second", "第二个"); const third = await create(service, "third", "第三个");
    expect(await call(service, "run_now", mutation(first.id, 1), "first")).toMatchObject({ status: "started" });
    expect(await call(service, "run_now", mutation(second.id, 1), "second")).toMatchObject({ status: "started" });
    expect(await call(service, "run_now", mutation(third.id, 1), "third")).toMatchObject({ status: "blocked", code: "execution_capacity" });
    service.close(); const restarted = open(); await restarted.tick();
    expect(await call(restarted, "inspect", { reference: first.id })).toMatchObject({ history: [{ execution: "unknown" }] });
    expect(await call(restarted, "run_now", mutation(third.id, 1), "third")).toMatchObject({ status: "started" });
    await restarted.tick(); expect(await call(restarted, "inspect", { reference: third.id })).toMatchObject({ totalOccurrences: 1, history: [{ execution: "succeeded", body: "提醒：第三个\n\n给花浇水" }] });
  });

});
