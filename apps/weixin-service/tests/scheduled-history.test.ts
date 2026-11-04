import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

// Public tools and real SQLite; fixtures follow the incident's mixed automatic/manual identities.
it("retains every execution beyond 31 and shows the latest manual execution first", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-history-"));
  let now = Date.parse("2026-10-17T00:00:00Z");
  const turn: TrustedWorkflowTurn = { accountId: "fixture", target: "recipient", eventKey: "create", occurredAt: now, originalTextRef: "source", attachmentRefs: [] };
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => now, readOriginalText: () => "提醒活动",
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async () => ({ ok: true }) } });
  const call = (tool: string, args: Record<string, unknown>, eventKey = tool) => tasks.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...turn, eventKey });
  try {
    const created = await call("create", { name: "活动提醒", instruction: "活动一下", reminderText: "你应该活动一下了。", reminderMode: "natural", at: "2026-10-17T00:01:00Z", sourceText: "提醒活动" }) as { task: { id: string } };
    now += 60_000; await tasks.tick();
    let latest = "", previous = "";
    for (let i = 0; i < 32; i++) {
      now += 60_000; previous = latest;
      const started = await call("run_now", { reference: created.task.id, expectedRevision: 1, sourceText: "提醒活动" }, `manual-${i}`) as { occurrenceId: string };
      latest = started.occurrenceId; await tasks.tick();
    }
    expect(await call("inspect", { reference: created.task.id, limit: 1 })).toMatchObject({
      totalOccurrences: 33, executionCount: 33, executionCountKind: "cumulative", terminalHistoryLimit: null, historyOrder: "planned_at_desc", nextOffset: 1,
      history: [{ id: latest, kind: "manual", execution: "succeeded", delivery: "accepted", plannedAt: "2026-10-17T00:33:00.000Z" }],
    });
    expect(await call("inspect", { reference: created.task.id, offset: 32, limit: 1 })).toMatchObject({ history: [{ kind: "automatic", delivery: "accepted" }] });
    expect(await call("inspect", { reference: created.task.id, offset: 1, limit: 1 })).toMatchObject({ history: [{ id: previous, plannedAt: "2026-10-17T00:32:00.000Z" }] });
  } finally { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("inspects an exact older occurrence without confusing task IDs or crossing conversation scope", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-history-exact-"));
  let now = Date.parse("2026-10-17T00:00:00Z");
  const turn: TrustedWorkflowTurn = { accountId: "fixture", target: "recipient", eventKey: "create", occurredAt: now, originalTextRef: "source", attachmentRefs: [] };
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => now, readOriginalText: () => "提醒活动",
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async () => ({ ok: true }) } });
  const call = (tool: string, args: Record<string, unknown>, eventKey = tool, target = "recipient") => tasks.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...turn, eventKey, target });
  try {
    const args = { name: "活动提醒", instruction: "活动一下", reminderText: "你应该活动一下了。", reminderMode: "natural", at: "2026-10-17T00:01:00Z", sourceText: "提醒活动" };
    const created = await call("create", args) as { task: { id: string } };
    const other = await call("create", { ...args, name: "另一个任务" }, "other") as { task: { id: string } };
    const manual = await call("run_now", { reference: created.task.id, expectedRevision: 1, sourceText: "提醒活动" }) as { occurrenceId: string };
    await tasks.tick(); now += 60_000; await tasks.tick();
    expect(await call("inspect", { reference: created.task.id, limit: 1 })).toMatchObject({ history: [{ kind: "automatic", plannedAt: "2026-10-17T00:01:00.000Z" }] });
    const selected = await call("inspect", { reference: created.task.id, occurrenceId: manual.occurrenceId }) as { history: unknown[]; nextOffset?: number };
    expect(selected).toMatchObject({ status: "ok", totalOccurrences: 2, history: [{ id: manual.occurrenceId, kind: "manual", plannedAt: "2026-10-17T00:00:00.000Z", delivery: "accepted" }] });
    expect(selected.history).toHaveLength(1); expect(selected.nextOffset).toBeUndefined();
    expect(await call("inspect", { reference: created.task.id, occurrenceId: "missing" })).toMatchObject({ status: "not_found", code: "occurrence_not_found" });
    expect(await call("inspect", { reference: other.task.id, occurrenceId: manual.occurrenceId })).toMatchObject({ status: "not_found", code: "occurrence_not_found" });
    expect(await call("inspect", { reference: created.task.id, occurrenceId: manual.occurrenceId }, "foreign", "another-recipient")).toMatchObject({ status: "not_found" });
  } finally { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
