import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ScheduledTasks, type ScheduledTasksOptions } from "../src/scheduled-tasks.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

// Real disposable SQLite via public tools. No real model, production upgrade or phone receipt verified.
// Fixture shapes reuse the public lifecycle tests and the incident's saved legacy news fields.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const turn: TrustedWorkflowTurn = { accountId: "fixture", target: "recipient", eventKey: "create", occurredAt: 0, originalTextRef: "text", attachmentRefs: [] };
function setup(options: Partial<ScheduledTasksOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-retention-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-18T00:00:00Z");
  const outbox: string[] = [];
  const open = () => {
    const service = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => now,
      readOriginalText: () => "original request", historyRetention: { maxAgeMs: 1000, maxBytes: 100_000 },
      channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }),
        send: async ({ message }) => { outbox.push(message); return { ok: true }; } }, ...options });
    cleanup.push(() => service.close()); return service;
  };
  return { service: open(), open, outbox, advance: (ms: number) => { now += ms; } };
}
const call = (service: ScheduledTasks, tool: string, args: Record<string, unknown>, eventKey = tool) => service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...turn, eventKey });
async function create(service: ScheduledTasks, name = "reminder", body = "你应该活动一下了。") {
  return (await call(service, "create", { name, instruction: "活动一下", reminderText: body, reminderMode: "natural", at: "2026-10-19T00:00:00Z", sourceText: "original request" }, name) as { task: { id: string } }).task.id;
}
const mutation = (reference: string, expectedRevision = 1) => ({ reference, expectedRevision, sourceText: "original request" });
const inspect = (service: ScheduledTasks, reference: string, occurrenceId?: string) => call(service, "inspect", { reference, ...(occurrenceId ? { occurrenceId } : {}) });

it("expires settled details at the retention boundary but preserves counts, outcomes and replay protection across reopen", async () => {
  const { service, open, advance, outbox } = setup(); const id = await create(service);
  const run = await call(service, "run_now", mutation(id), "first") as { occurrenceId: string };
  await service.tick(); advance(999); await service.tick();
  expect(await call(service, "read_text", { reference: run.occurrenceId, field: "output" })).toMatchObject({ status: "ok", text: "你应该活动一下了。" });
  advance(1); await service.tick();
  expect(await inspect(service, id)).toMatchObject({ totalOccurrences: 1, executionCount: 1, executionCountKind: "cumulative",
    history: [{ id: run.occurrenceId, execution: "succeeded", delivery: "accepted", bodyAvailable: false, detailsClearReason: "age", totalAttempts: 1,
      attempts: [{ result: "accepted", parts: [{ characters: 9, result: { ok: true } }] }] }] });
  expect(await call(service, "read_text", { reference: run.occurrenceId, field: "output" })).toMatchObject({ status: "unavailable", code: "history_details_cleared" });
  service.close(); const reopened = open();
  expect(await call(reopened, "run_now", mutation(id), "first")).toMatchObject({ occurrenceId: run.occurrenceId, replayed: true });
  await reopened.tick(); expect(outbox).toEqual(["你应该活动一下了。"]);
  expect(await inspect(reopened, id)).toMatchObject({ executionCount: 1, history: [{ detailsClearReason: "age", delivery: "accepted" }] });
});

it("clears oldest settled detail across tasks for capacity while preserving paused output above the budget", async () => {
  let context: string | null = "c";
  const outbox: string[] = [];
  const { service, advance } = setup({ historyRetention: { maxAgeMs: 1000, maxBytes: 7000 },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: context }),
      send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  const oldest = await create(service, "oldest", "a".repeat(2000));
  const first = await call(service, "run_now", mutation(oldest), "one") as { occurrenceId: string }; await service.tick();
  expect(await inspect(service, oldest)).toMatchObject({ history: [{ bodyAvailable: true }] });
  advance(1); const newer = await create(service, "newer", "b".repeat(2000));
  await call(service, "run_now", mutation(newer), "two"); await service.tick();
  expect(await inspect(service, oldest)).toMatchObject({ executionCount: 1, history: [{ bodyAvailable: false, detailsClearReason: "capacity" }] });
  expect(await inspect(service, newer)).toMatchObject({ history: [{ bodyAvailable: true, delivery: "accepted" }] });
  context = null;
  const pending = await create(service, "pending", "p".repeat(10_000));
  const run = await call(service, "run_now", mutation(pending), "pending") as { occurrenceId: string }; await service.tick();
  await call(service, "disable", mutation(pending)); advance(2000); await service.tick();
  expect(await call(service, "read_text", { reference: run.occurrenceId, field: "output", limit: 1 })).toMatchObject({ status: "ok", text: "p", totalCharacters: 10_000 });
  expect(await inspect(service, pending)).toMatchObject({ history: [{ bodyAvailable: true, delivery: "pending_inbound" }] });
  expect(await call(service, "read_text", { reference: first.occurrenceId, field: "output" })).toMatchObject({ code: "history_details_cleared" });
  expect(outbox.join("")).toBe("a".repeat(2000) + "b".repeat(2000));
});

it.each(["failed", "partial", "unknown", "rejected", "cancelled"] as const)("retains %s outcome and notice identity after cleanup and never replays it", async (outcome) => {
  const outbox: string[] = [];
  const { service, advance, open } = setup({ renderReminder: async () => { if (outcome === "failed") throw new Error("failure"); return "saved body"; },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: outcome === "cancelled" ? null : "c" }),
      send: async ({ message }) => { outbox.push(message); return message === "saved body"
        ? { ok: false, reason: outcome === "rejected" ? "rejected" : "unknown", ...(outcome === "partial" ? { acceptedSegments: 1 } : {}) }
        : { ok: true }; } } });
  const id = await create(service);
  const run = await call(service, "run_now", mutation(id), "once") as { occurrenceId: string }; await service.tick();
  // A pending failure notification is protected until settled or explicitly suppressed by deletion.
  if (outcome === "cancelled") await call(service, "delete", mutation(id));
  else { await call(service, "delete", mutation(id)); await service.tick(); }
  const before = await inspect(service, id) as { notifications: unknown[] };
  advance(1000); await service.tick();
  const after = await inspect(service, id);
  expect(after).toMatchObject({ totalOccurrences: 1, executionCount: 1, task: { lifecycle: "deleted" }, notifications: before.notifications,
    history: [{ execution: outcome === "failed" ? "failed" : "succeeded", delivery: outcome === "failed" ? "not_generated" : outcome, detailsClearReason: "age", bodyAvailable: false }] });
  expect(await call(service, "read_text", { reference: run.occurrenceId, field: "output" })).toMatchObject(outcome === "failed"
    ? { status: "not_found" } : { status: "unavailable", code: "history_details_cleared" });
  const sent = [...outbox]; service.close(); const reopened = open(); await reopened.tick();
  expect(await call(reopened, "run_now", mutation(id), "once")).toMatchObject({ replayed: true }); await reopened.tick();
  expect(outbox).toEqual(sent); expect(await inspect(reopened, id)).toMatchObject({ executionCount: 1, history: [{ detailsClearReason: "age" }] });
});

it("starts retention only after a long-paused cache is sent", async () => {
  let context: string | null = null;
  const outbox: string[] = [];
  const { service, advance } = setup({ channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: context }),
    send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  const id = await create(service); await call(service, "run_now", mutation(id), "cache"); await service.tick();
  await call(service, "disable", mutation(id)); advance(10_000); context = "fresh"; await service.tick();
  expect(await inspect(service, id)).toMatchObject({ history: [{ bodyAvailable: true }] }); expect(outbox).toEqual([]);
  await call(service, "enable", mutation(id, 2)); await service.tick();
  advance(999); await service.tick(); expect(await inspect(service, id)).toMatchObject({ history: [{ bodyAvailable: true }] });
  advance(1); await service.tick(); expect(await inspect(service, id)).toMatchObject({ history: [{ bodyAvailable: false, detailsClearReason: "age" }] });
  expect(outbox).toEqual(["你应该活动一下了。"]);
});

it("reports imported history only as a known minimum and preserves source outcomes after details expire", async () => {
  const { service, advance, open, outbox } = setup({ dailyNewsImport: { sourceHash: "legacy-retention", state: {
    version: 2, enabledTarget: null, seenItemKeys: [], summarizedArticleKeys: [], preview: null,
    runs: [{ runKey: "2026-10-15", accountId: "fixture", target: "recipient", status: "accepted", createdAt: 1, updatedAt: 2,
      message: "imported body", attempt: 2, digest: { date: "2026-10-15", generatedAt: 1, items: [], sources: { hackernews: { status: "complete", requested: 7, selected: 7 } } } }],
  } } });
  expect(await inspect(service, "AI 新闻日报")).toMatchObject({ executionCount: 1, executionCountKind: "known_minimum", history: [{ body: "imported body" }] });
  await service.tick(); advance(1000); await service.tick();
  expect(await inspect(service, "AI 新闻日报")).toMatchObject({ executionCount: 1, history: [{ bodyAvailable: false, detailsClearReason: "age", news: { sources: { hackernews: { status: "complete", requested: 7, selected: 7 } }, originalStatus: "accepted" } }] });
  service.close(); const reopened = open(); await reopened.tick(); expect(outbox).toEqual([]);
  expect(await inspect(reopened, "AI 新闻日报")).toMatchObject({ executionCount: 1, executionCountKind: "known_minimum" });
});

it.each([0, -1, 1.5, NaN])("rejects invalid detail retention bounds %s", (invalid) => {
  expect(() => setup({ historyRetention: { maxAgeMs: invalid } })).toThrow("scheduled_history_retention_invalid");
  expect(() => setup({ historyRetention: { maxBytes: invalid } })).toThrow("scheduled_history_retention_invalid");
});

it("pages permanent failure notices independently and preserves their deduplication after cleanup", async () => {
  const { service, advance, outbox } = setup({ renderReminder: async () => { throw new Error("failed"); } }); const id = await create(service);
  for (let i = 0; i < 6; i++) { await call(service, "run_now", mutation(id), `failure-${i}`); await service.tick(); }
  const first = await inspect(service, id) as { notifications: unknown[]; nextNotificationOffset: number };
  expect(first).toMatchObject({ totalNotifications: 6, nextNotificationOffset: 5 }); expect(first.notifications).toHaveLength(5);
  const next = await call(service, "inspect", { reference: id, notificationOffset: first.nextNotificationOffset }) as { notifications: unknown[] };
  expect(next.notifications).toHaveLength(1); expect(outbox).toHaveLength(6);
  advance(1000); await service.tick(); await service.tick();
  expect(outbox).toHaveLength(6);
  expect(await inspect(service, id)).toMatchObject({ executionCount: 6, notifications: first.notifications, history: expect.arrayContaining([expect.objectContaining({ detailsClearReason: "age", execution: "failed" })]) });
});

it("protects pending notices and starts the detail clock only after the notice settles", async () => {
  let context: string | null = null; const outbox: string[] = [];
  const { service, advance } = setup({ renderReminder: async () => { throw new Error("failure"); },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: context }),
      send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  const id = await create(service); await call(service, "run_now", mutation(id)); await service.tick(); advance(2000); await service.tick();
  const pending = await inspect(service, id) as { history: Array<{ detailsClearedAt?: number; detailsEligibleAt?: number }> };
  expect(pending).toMatchObject({ totalNotifications: 1, notifications: [{ delivery: "pending" }], history: [{ execution: "failed" }] });
  expect(pending.history[0]?.detailsEligibleAt).toBeUndefined(); expect(pending.history[0]?.detailsClearedAt).toBeUndefined();
  context = "fresh"; await service.tick(); advance(1000); await service.tick();
  expect(await inspect(service, id)).toMatchObject({ history: [{ detailsClearReason: "age" }], notifications: [{ delivery: "accepted" }] });
  expect(outbox).toHaveLength(1);
});

it("protects unfinished news archive work after delivery, then clears only execution detail", async () => {
  let archives = 0;
  const { service, advance, outbox } = setup({ dailyNewsImport: { sourceHash: "archive-retention", state: { version: 2,
    enabledTarget: null, runs: [{ runKey: "2026-10-15", accountId: "fixture", target: "recipient", status: "accepted", createdAt: 1, updatedAt: 2 }],
    seenItemKeys: [], summarizedArticleKeys: [], preview: null } },
    dailyNews: { researcher: { generate: async () => ({ date: "2026-10-18", generatedAt: Date.parse("2026-10-18T00:00:00Z"), items: [
      { title: "测试新闻", summary: "测试内容完整保留。", brief: "测试内容完整保留。", source: "官方", url: "https://example.test/news", publishedAt: "2026-10-18T00:00:00Z" }] }) },
      archive: { archive: async () => { archives++; if (archives === 1) throw new Error("archive unavailable"); } } } });
  const started = await call(service, "run_now", mutation("AI 新闻日报")) as { occurrenceId: string }; await service.tick();
  advance(2000); await service.tick();
  expect(await inspect(service, "AI 新闻日报", started.occurrenceId)).toMatchObject({ history: [{ delivery: "accepted", bodyAvailable: true, news: { archiveWork: { status: "pending" } } }] });
  advance(598_000); await service.tick();
  expect(await inspect(service, "AI 新闻日报", started.occurrenceId)).toMatchObject({ history: [{ bodyAvailable: true, news: { archiveWork: { status: "succeeded" } } }] });
  advance(1000); await service.tick();
  expect(await inspect(service, "AI 新闻日报", started.occurrenceId)).toMatchObject({ history: [{ bodyAvailable: false, detailsClearReason: "age", news: { archiveWork: { status: "succeeded" } } }] });
  expect(archives).toBe(2); expect(outbox).toHaveLength(1);
});
