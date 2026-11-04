import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AccountMemoryStore, renderEventTimeline } from "../src/account-memory-store.js";
import { AccountMemoryToolHost, accountMemoryDecisionOutputSchema } from "../src/account-memory-tool-host.js";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-tools-"));
  const store = new AccountMemoryStore(root, () => Date.parse("2026-08-18T12:00:00+08:00"));
  const host = new AccountMemoryToolHost(store);
  host.bind("thread-a", {
    accountId: "bot-a@im.bot",
    jobId: "job-1",
    batchId: "batch-1",
    evidenceEntryIds: ["entry-1"],
    mutationPolicy: { mode: "free_add" },
  });
  return { store, host };
}

describe("AccountMemoryToolHost", () => {
  it("uses the App Server-supported anyOf union in the shared output schema", () => {
    const outputSchema = accountMemoryDecisionOutputSchema();
    const schema = JSON.stringify(outputSchema);
    expect(schema).toContain('"anyOf"');
    expect(schema).not.toContain('"oneOf"');
    expect(schema).toContain('"kind":{"type":"string","const":"remember"}');
    expect(schema).toContain('"category":{"type":"string","enum"');
    expect(schema).toContain('"eventKind":{"type":"string","enum"');
    expect(schema).toContain('"planMatch":{"anyOf"');
    expect(schema).toContain('"kind":{"type":"string","const":"resolve_reminder"}');
    expect(schema).toContain('"required":["kind","match","outcome","summary","evidenceEntryIds","confidence"]');
    expectStrictObjectRequirements(outputSchema);
  });

  it("commits structured output directly with a host-controlled binding", async () => {
    const { store, host } = harness();

    const outcome = await host.commit({
      accountId: "bot-a@im.bot",
      jobId: "job-1",
      batchId: "batch-1",
      evidenceEntryIds: ["entry-1"],
      mutationPolicy: { mode: "free_add" },
    }, {
      basedOnRevision: 0,
      batchId: "batch-1",
      decisions: [{
        kind: "remember",
        category: "preferences",
        value: "Markdown 笔记使用 Obsidian。",
        evidenceEntryIds: ["entry-1"],
        confidence: 1,
      }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { added: 1 } });
    expect(store.read("bot-a@im.bot").entries).toMatchObject([
      { value: "Markdown 笔记使用 Obsidian。" },
    ]);
  });

  it("records a planned event while keeping account, event id, and timezone host-controlled", async () => {
    const { store, host } = harness();
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1",
      evidenceEntryIds: ["entry-1"], evidenceTexts: { "entry-1": "明天准备去吃肉蟹煲" },
      evidenceLocalDates: { "entry-1": "2026-08-16" },
      mutationPolicy: { mode: "reconcile" },
    });

    expect(JSON.stringify(host.definitions())).not.toMatch(/accountId|target|path|timezone/i);
    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 0,
      batchId: "batch-1",
      decisions: [{
        kind: "record_event", eventKind: "planned", localDate: "2026-08-17",
        timePrecision: "evening", localTime: null, planMatch: null,
        summary: "准备去吃肉蟹煲。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: true });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({
        eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai",
        summary: "准备去吃肉蟹煲。", timePrecision: "evening",
      }),
    ]);
    expect(store.read("bot-a@im.bot").events[0]?.id).toMatch(/^event-planned-[a-f0-9]{12}$/u);
  });

  it("uses trusted reminder ordinals to mark one plan unfulfilled without exposing its id to the model", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-result", batchId: "batch-result",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "1 没有完成" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" },
      reminderContext: { batchId: "reminder-1", plans: [{ ordinal: 1, planId: "movie-plan", summary: "今晚看电影。" }] },
    }, {
      basedOnRevision: 1, batchId: "batch-result",
      decisions: [{ kind: "set_plan_outcome", match: "1", status: "unfulfilled", evidenceEntryIds: ["reply"] }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events[0]).toMatchObject({ id: "movie-plan", planStatus: "unfulfilled" });
  });

  it("completes a reminded plan from an ordinal reply without requiring the user to repeat a date", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "昨晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-done", batchId: "batch-done",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "1 已完成" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" },
      reminderContext: { batchId: "reminder-1", plans: [{ ordinal: 1, planId: "movie-plan", summary: "昨晚看电影。" }] },
    }, {
      basedOnRevision: 1, batchId: "batch-done",
      decisions: [{ kind: "record_event", eventKind: "observed", localDate: "2026-08-18", summary: "完成了看电影计划。", planMatch: "1", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsAdded: 1, eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "movie-plan", planStatus: "occurred" }),
      expect.objectContaining({ eventKind: "observed", fulfillsPlanId: "movie-plan", factStatus: "valid" }),
    ]));
  });

  it("converts a natural single-plan reminder reply into an occurred plan and linked fact", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-shoes", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "buy-shoes-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚十点买鞋。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-bought", batchId: "batch-bought",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "已经买了" },
      evidenceLocalDates: { reply: "2026-08-17" }, mutationPolicy: { mode: "reconcile" },
      reminderContext: { batchId: "reminder-shoes", plans: [{ ordinal: 1, planId: "buy-shoes-plan", summary: "今晚十点买鞋。" }] },
    }, {
      basedOnRevision: 1, batchId: "batch-bought",
      decisions: [{ kind: "resolve_reminder", outcome: "occurred", summary: "已经买鞋。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsAdded: 1, eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "buy-shoes-plan", planStatus: "occurred" }),
      expect.objectContaining({ eventKind: "observed", summary: "已经买鞋。", fulfillsPlanId: "buy-shoes-plan" }),
    ]));
  });

  it("derives an observed reminder fact date from trusted relative-date evidence", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-relative-date", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "buy-shoes-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "昨晚买鞋。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-relative-date", batchId: "batch-relative-date",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "昨天已经买了" }, evidenceLocalDates: { reply: "2026-08-18" },
      mutationPolicy: { mode: "reconcile" }, reminderContext: { batchId: "reminder", plans: [{ ordinal: 1, planId: "buy-shoes-plan", summary: "昨晚买鞋。" }] },
    }, {
      basedOnRevision: 1, batchId: "batch-relative-date",
      decisions: [{ kind: "resolve_reminder", outcome: "occurred", summary: "昨天已经买鞋。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toMatchObject({ status: "committed" });
    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: "observed", localDate: "2026-08-17", fulfillsPlanId: "buy-shoes-plan" }),
    ]));
  });

  it("binds an unnumbered reminder reply only when its content uniquely identifies one of several plans", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-several", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "event_add", id: "buy-shoes-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚十点买鞋。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_add", id: "watch-movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-shoes-done", batchId: "batch-shoes-done",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "鞋已经买了" },
      evidenceLocalDates: { reply: "2026-08-17" }, mutationPolicy: { mode: "reconcile" },
      reminderContext: { batchId: "reminder-several", plans: [
        { ordinal: 1, planId: "buy-shoes-plan", summary: "今晚十点买鞋。" },
        { ordinal: 2, planId: "watch-movie-plan", summary: "今晚看电影。" },
      ] },
    }, {
      basedOnRevision: 1, batchId: "batch-shoes-done",
      decisions: [{ kind: "resolve_reminder", outcome: "occurred", summary: "已经买鞋。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsAdded: 1, eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "buy-shoes-plan", planStatus: "occurred" }),
      expect.objectContaining({ id: "watch-movie-plan", planStatus: "pending" }),
    ]));
  });

  it("resolves and revises two different reminded plans from one combined reply", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-combined-reminder", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "event_add", id: "meal-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "计划去吃胖哥俩肉蟹煲。", timePrecision: "date", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "计划今晚去看电影《牛来》。", timePrecision: "date", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-combined-reminder", batchId: "batch-combined-reminder",
      evidenceEntryIds: ["reply"],
      evidenceTexts: { reply: "牛来已经看完了，挺有意思，肉蟹煲周四晚上去吃" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" },
      reminderContext: { batchId: "reminder-combined", plans: [
        { ordinal: 1, planId: "meal-plan", summary: "计划去吃胖哥俩肉蟹煲。" },
        { ordinal: 2, planId: "movie-plan", summary: "计划今晚去看电影《牛来》。" },
      ] },
    }, {
      basedOnRevision: 1, batchId: "batch-combined-reminder",
      decisions: [
        { kind: "resolve_reminder", match: "计划今晚去看电影《牛来》", outcome: "occurred", summary: "看完了电影《牛来》，觉得挺有意思。", evidenceEntryIds: ["reply"], confidence: 1 },
        { kind: "revise_event", match: "计划去吃胖哥俩肉蟹煲", eventKind: "planned", localDate: "2026-08-20", timePrecision: "evening", localTime: null, summary: "计划周四晚上去吃胖哥俩肉蟹煲。", evidenceEntryIds: ["reply"], confidence: 1 },
      ],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsAdded: 1, eventsUpdated: 2 } });
    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "meal-plan", localDate: "2026-08-20", planStatus: "pending", summary: "计划周四晚上去吃胖哥俩肉蟹煲。" }),
      expect.objectContaining({ id: "movie-plan", localDate: "2026-08-17", planStatus: "occurred" }),
      expect.objectContaining({ eventKind: "observed", localDate: "2026-08-18", fulfillsPlanId: "movie-plan", factStatus: "valid", summary: "看完了电影《牛来》，觉得挺有意思。" }),
    ]));
  });

  it("rejects a combined reminder batch when two decisions resolve to the same plan", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-conflicting-reminder", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "event_add", id: "meal-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "计划去吃胖哥俩肉蟹煲。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "计划今晚去看电影《牛来》。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });
    const binding = {
      accountId: "bot-a@im.bot", jobId: "job-conflicting-reminder", batchId: "batch-conflicting-reminder",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "牛来已经看完了，挺有意思，肉蟹煲周四晚上去吃" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" as const },
      reminderContext: { batchId: "reminder-conflicting", plans: [
        { ordinal: 1, planId: "meal-plan", summary: "计划去吃胖哥俩肉蟹煲。" },
        { ordinal: 2, planId: "movie-plan", summary: "计划今晚去看电影《牛来》。" },
      ] },
    };

    await expect(host.commit(binding, {
      basedOnRevision: 1, batchId: "batch-conflicting-reminder",
      decisions: [
        { kind: "resolve_reminder", outcome: "occurred", summary: "看完了电影《牛来》，觉得挺有意思。", evidenceEntryIds: ["reply"], confidence: 1 },
        { kind: "revise_event", match: "计划去吃胖哥俩肉蟹煲", eventKind: "planned", localDate: "2026-08-20", timePrecision: "evening", localTime: null, summary: "计划周四晚上去吃胖哥俩肉蟹煲。", evidenceEntryIds: ["reply"], confidence: 1 },
      ],
    })).rejects.toThrow("memory_event_conflicting_mutations");

    expect(store.read("bot-a@im.bot")).toMatchObject({
      revision: 1,
      events: expect.arrayContaining([
        expect.objectContaining({ id: "meal-plan", localDate: "2026-08-17", planStatus: "pending" }),
        expect.objectContaining({ id: "movie-plan", localDate: "2026-08-17", planStatus: "pending" }),
      ]),
    });
    expect(store.read("bot-a@im.bot").events).toHaveLength(2);
  });

  it("never lets a reminder match escape its frozen reminder batch", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-reminder-scope", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "event_add", id: "in-batch-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "计划买鞋。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_add", id: "outside-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "计划看电影《牛来》。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-reminder-scope", batchId: "batch-reminder-scope",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "牛来已经看完了" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" },
      reminderContext: { batchId: "reminder-scope", plans: [
        { ordinal: 1, planId: "in-batch-plan", summary: "计划买鞋。" },
      ] },
    }, {
      basedOnRevision: 1, batchId: "batch-reminder-scope",
      decisions: [{ kind: "resolve_reminder", match: "计划看电影《牛来》", outcome: "occurred", summary: "看完了电影《牛来》。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toEqual({ status: "needs_clarification", reason: "target_missing", candidateIds: [] });
    expect(store.read("bot-a@im.bot").events.every((event) => event.planStatus === "pending")).toBe(true);
  });

  it.each([
    { text: "还没买", outcome: "unfulfilled", expected: "unfulfilled" },
    { text: "不买了", outcome: "cancelled", expected: "cancelled" },
  ] as const)("maps $text to the fixed $outcome reminder outcome without adding a fact", async ({ text, outcome, expected }) => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: `seed-${outcome}`, basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "buy-shoes-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚十点买鞋。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const outcomeResult = await host.commit({
      accountId: "bot-a@im.bot", jobId: `job-${outcome}`, batchId: `batch-${outcome}`,
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: text }, evidenceLocalDates: { reply: "2026-08-17" },
      mutationPolicy: { mode: "reconcile" }, reminderContext: { batchId: "reminder", plans: [{ ordinal: 1, planId: "buy-shoes-plan", summary: "今晚十点买鞋。" }] },
    }, {
      basedOnRevision: 1, batchId: `batch-${outcome}`,
      decisions: [{ kind: "resolve_reminder", outcome, summary: null, evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcomeResult).toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({ id: "buy-shoes-plan", planStatus: expected }),
    ]);
  });

  it("returns terminal clarification instead of accepting an occurred outcome contradicted by the reply", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-contradiction", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "buy-shoes-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚十点买鞋。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-contradiction", batchId: "batch-contradiction",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "不买了" }, evidenceLocalDates: { reply: "2026-08-17" },
      mutationPolicy: { mode: "reconcile" }, reminderContext: { batchId: "reminder", plans: [{ ordinal: 1, planId: "buy-shoes-plan", summary: "今晚十点买鞋。" }] },
    }, {
      basedOnRevision: 1, batchId: "batch-contradiction",
      decisions: [{ kind: "resolve_reminder", outcome: "occurred", summary: "已经买鞋。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toEqual({ status: "needs_clarification", reason: "outcome_ambiguous", candidateIds: [] });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({ id: "buy-shoes-plan", planStatus: "pending" }),
    ]);
  });

  it("asks which plan instead of guessing when a reply cannot distinguish several reminders", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-ambiguous", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "event_add", id: "buy-shoes-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚十点买鞋。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_add", id: "watch-movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });
    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-ambiguous", batchId: "batch-ambiguous",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "已经完成了" }, evidenceLocalDates: { reply: "2026-08-17" },
      mutationPolicy: { mode: "reconcile" }, reminderContext: { batchId: "reminder", plans: [
        { ordinal: 1, planId: "buy-shoes-plan", summary: "今晚十点买鞋。" },
        { ordinal: 2, planId: "watch-movie-plan", summary: "今晚看电影。" },
      ] },
    }, {
      basedOnRevision: 1, batchId: "batch-ambiguous",
      decisions: [{ kind: "resolve_reminder", outcome: "occurred", summary: "已经完成计划。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });

    expect(outcome).toMatchObject({ status: "needs_clarification", reason: "target_ambiguous" });
    expect(store.read("bot-a@im.bot").events.every((event) => event.planStatus === "pending")).toBe(true);
  });

  it("can correct an occurred plan to unfulfilled and retract its linked fact", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "昨晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_add", id: "movie-fact", eventKind: "observed", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "昨晚看了电影。", fulfillsPlanId: "movie-plan", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "event_complete", id: "movie-plan", observedEventId: "movie-fact", evidenceEntryIds: ["seed"] },
      ],
    });

    await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-correct", batchId: "batch-correct",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "更正一下，看电影的计划其实没有完成" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-correct",
      decisions: [{ kind: "set_plan_outcome", match: "看电影", status: "unfulfilled", evidenceEntryIds: ["reply"] }],
    });

    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "movie-plan", planStatus: "unfulfilled" }),
      expect.objectContaining({ id: "movie-fact", factStatus: "retracted" }),
    ]));
  });

  it("validates a numbered plan reschedule against the trusted Chinese weekday and time precision", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", summary: "今晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const binding = {
      accountId: "bot-a@im.bot", jobId: "job-move", batchId: "batch-move",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "1 改到周五晚上" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" as const },
      reminderContext: { batchId: "reminder-1", plans: [{ ordinal: 1, planId: "movie-plan", summary: "今晚看电影。" }] },
    };

    await expect(host.commit(binding, {
      basedOnRevision: 1, batchId: "batch-move",
      decisions: [{ kind: "revise_event", match: "1", eventKind: "planned", localDate: "2026-08-20", timePrecision: "evening", summary: "周五晚上看电影。", evidenceEntryIds: ["reply"], confidence: 1 }],
    })).rejects.toThrow("memory_event_date_mismatch");

    const outcome = await host.commit({ ...binding, batchId: "batch-move-correct" }, {
      basedOnRevision: 1, batchId: "batch-move-correct",
      decisions: [{ kind: "revise_event", match: "1", eventKind: "planned", localDate: "2026-08-21", timePrecision: "evening", summary: "周五晚上看电影。", evidenceEntryIds: ["reply"], confidence: 1 }],
    });
    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events[0]).toMatchObject({ id: "movie-plan", localDate: "2026-08-21", timePrecision: "evening" });
  });

  it("accepts 明晚 as tomorrow evening when revising an existing plan", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-meal-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{
        op: "event_add", id: "meal-plan", eventKind: "planned", localDate: "2026-08-20",
        timezone: "Asia/Shanghai", summary: "计划周四晚上去吃胖哥俩肉蟹煲。", timePrecision: "evening",
        evidenceEntryIds: ["seed"], confidence: 1,
      }],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-meal-tomorrow-evening", batchId: "batch-meal-tomorrow-evening",
      evidenceEntryIds: ["reply"], evidenceTexts: { reply: "我准备明晚就去吃肉蟹煲" },
      evidenceLocalDates: { reply: "2026-08-18" }, mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-meal-tomorrow-evening",
      decisions: [{
        kind: "revise_event", match: "周四晚上去吃胖哥俩肉蟹煲的计划", eventKind: "planned",
        localDate: "2026-08-19", timePrecision: "evening", localTime: null,
        summary: "计划明晚去吃肉蟹煲。", evidenceEntryIds: ["reply"], confidence: 0.99,
      }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({ id: "meal-plan", localDate: "2026-08-19", timePrecision: "evening", planStatus: "pending" }),
    ]);
  });

  it("updates one uniquely matched plan when its date and details change", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", summary: "晚上去看电影。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-2", batchId: "batch-2",
      evidenceEntryIds: ["entry-2"],
      evidenceTexts: { "entry-2": "我改变计划，今晚去看电影《牛来》" },
      evidenceLocalDates: { "entry-2": "2026-08-17" },
      mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-2",
      decisions: [{
        kind: "revise_event", match: "晚上去看电影", eventKind: "planned",
        localDate: "2026-08-17", summary: "今晚去看电影《牛来》。",
        evidenceEntryIds: ["entry-2"], confidence: 1,
      }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({
        id: "movie-plan", eventKind: "planned", localDate: "2026-08-17",
        summary: "今晚去看电影《牛来》。",
      }),
    ]);
  });

  it("keeps the existing date when only a plan's details change", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", summary: "晚上去看电影。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-2", batchId: "batch-2",
      evidenceEntryIds: ["entry-2"], evidenceTexts: { "entry-2": "看电影的计划改成看《牛来》" },
      evidenceLocalDates: { "entry-2": "2026-08-17" }, mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-2",
      decisions: [{ kind: "revise_event", match: "晚上去看电影", eventKind: "planned", localDate: "2026-08-18", summary: "晚上看电影《牛来》。", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({ id: "movie-plan", localDate: "2026-08-18", summary: "晚上看电影《牛来》。" }),
    ]);
  });

  it("asks for clarification instead of adding when a plan change matches multiple plans", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plans", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [
        { op: "event_add", id: "movie-plan-a", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", summary: "晚上去看电影。", evidenceEntryIds: ["entry-1"], confidence: 1 },
        { op: "event_add", id: "movie-plan-b", eventKind: "planned", localDate: "2026-08-19", timezone: "Asia/Shanghai", summary: "周三去看电影。", evidenceEntryIds: ["entry-1"], confidence: 1 },
      ],
    });

    await expect(host.commit({
      accountId: "bot-a@im.bot", jobId: "job-2", batchId: "batch-2",
      evidenceEntryIds: ["entry-2"], evidenceTexts: { "entry-2": "我改变计划，今晚去看电影《牛来》" },
      evidenceLocalDates: { "entry-2": "2026-08-17" }, mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-2",
      decisions: [{ kind: "revise_event", match: "去看电影", eventKind: "planned", localDate: "2026-08-17", summary: "今晚去看电影《牛来》。", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    })).resolves.toEqual({
      status: "needs_clarification", reason: "target_ambiguous", candidateIds: ["movie-plan-a", "movie-plan-b"],
    });
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, eventCount: 2 });
  });

  it("records an observed fact and completes its uniquely matched plan atomically", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17",
        timezone: "Asia/Shanghai", summary: "今晚去看电影《牛来》。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-2", batchId: "batch-2",
      evidenceEntryIds: ["entry-2"], evidenceTexts: { "entry-2": "我今晚看了电影《牛来》" },
      evidenceLocalDates: { "entry-2": "2026-08-17" }, mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-2",
      decisions: [{
        kind: "record_event", eventKind: "observed", localDate: "2026-08-17", summary: "今晚看了电影《牛来》。",
        planMatch: "看电影《牛来》", evidenceEntryIds: ["entry-2"], confidence: 1,
      }],
    });

    expect(outcome).toMatchObject({ status: "committed", receipt: { eventsAdded: 1, eventsUpdated: 1 } });
    const events = store.read("bot-a@im.bot").events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "movie-plan", eventKind: "planned", planStatus: "occurred" }),
      expect.objectContaining({ eventKind: "observed", fulfillsPlanId: "movie-plan" }),
    ]));
    expect(renderEventTimeline(events, "2026-08-17")).toContain("[计划·已发生]");
    expect(renderEventTimeline(events, "2026-08-17")).toContain("[已发生·完成计划]");
  });

  it("does not record a fact or complete a plan when the completion match is ambiguous", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plans", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [
        { op: "event_add", id: "movie-plan-a", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "晚上看电影《牛来》。", evidenceEntryIds: ["entry-1"], confidence: 1 },
        { op: "event_add", id: "movie-plan-b", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", summary: "明晚看电影《牛来》。", evidenceEntryIds: ["entry-1"], confidence: 1 },
      ],
    });

    const outcome = await host.commit({
      accountId: "bot-a@im.bot", jobId: "job-2", batchId: "batch-2",
      evidenceEntryIds: ["entry-2"], evidenceTexts: { "entry-2": "我今晚看了电影《牛来》" },
      evidenceLocalDates: { "entry-2": "2026-08-17" }, mutationPolicy: { mode: "reconcile" },
    }, {
      basedOnRevision: 1, batchId: "batch-2",
      decisions: [{ kind: "record_event", eventKind: "observed", localDate: "2026-08-17", summary: "今晚看了电影《牛来》。", planMatch: "看电影《牛来》", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    });

    expect(outcome).toEqual({ status: "needs_clarification", reason: "target_ambiguous", candidateIds: ["movie-plan-a", "movie-plan-b"] });
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, eventCount: 2 });
    expect(store.read("bot-a@im.bot").events.every((event) => event.planStatus === "pending")).toBe(true);
  });

  it("rejects a curator event date that conflicts with the trusted message date", async () => {
    const { store, host } = harness();
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1",
      evidenceEntryIds: ["entry-1"], evidenceTexts: { "entry-1": "明天准备去吃肉蟹煲" },
      evidenceLocalDates: { "entry-1": "2026-08-16" },
      mutationPolicy: { mode: "reconcile" },
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 0,
      batchId: "batch-1",
      decisions: [{
        kind: "record_event", eventKind: "planned", localDate: "2026-08-18",
        summary: "准备去吃肉蟹煲。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: false });
    expect(result.contentItems[0]?.text).toContain("memory_event_date_mismatch");
    expect(store.read("bot-a@im.bot").events).toEqual([]);
  });

  it("binds account scope outside model arguments and commits one mutation batch", async () => {
    const { store, host } = harness();

    expect(JSON.stringify(host.definitions())).not.toMatch(/accountId|target|path/i);
    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 0,
      batchId: "batch-1",
      decisions: [{
        kind: "remember",
        category: "preferences",
        value: "Markdown 笔记使用 Obsidian。",
        evidenceEntryIds: ["entry-1"],
        confidence: 1,
      }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result.success).toBe(true);
    expect(store.read("bot-a@im.bot").entries).toMatchObject([
      { value: "Markdown 笔记使用 Obsidian。" },
    ]);
    expect(store.read("bot-a@im.bot").entries[0]?.id).toMatch(/^memory-preferences-[a-f0-9]{12}$/u);
    await expect(host.execute("account_memory_commit", {
      basedOnRevision: 1,
      batchId: "batch-1",
      decisions: [],
    }, { threadId: "thread-a", turnId: "turn-a" })).resolves.toMatchObject({ success: false });
  });

  it("rejects an unknown mutation operation instead of treating it as remove", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "project-keep", category: "projects", value: "保留项目。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1,
      batchId: "batch-1",
      decisions: [{
        kind: "hack",
        value: "伪造操作。",
        evidenceEntryIds: ["entry-1"],
        confidence: 1,
      }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: false });
    expect(store.read("bot-a@im.bot").entries).toMatchObject([{ id: "project-keep" }]);
  });

  it("rejects remove when the bound user evidence has no explicit forget intent", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-remove",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "project-keep", category: "projects", value: "保留项目。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1,
      batchId: "batch-1",
      decisions: [{ kind: "forget", evidenceEntryIds: ["entry-1"] }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: false });
    expect(store.read("bot-a@im.bot").entries).toMatchObject([{ id: "project-keep" }]);
  });

  it("injects the trusted target id and rejects add under a correction binding", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-correction", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "js-package-manager-pnpm", category: "preferences", value: "所有 JavaScript 项目使用 pnpm。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    });
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1", evidenceEntryIds: ["entry-2"],
      mutationPolicy: { mode: "single_update", targetId: "js-package-manager-pnpm", replacement: "只在 Node.js 项目使用 pnpm", evidenceEntryId: "entry-2" },
    });

    const forbidden = await host.execute("account_memory_commit", {
      basedOnRevision: 1, batchId: "batch-1",
      decisions: [{ kind: "remember", category: "preferences", value: "只在 Node.js 项目使用 pnpm", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    }, { threadId: "thread-a", turnId: "turn-a" });
    expect(forbidden).toMatchObject({ success: false });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1, batchId: "batch-1",
      decisions: [{
        kind: "revise", match: "JavaScript 项目使用 pnpm", value: "只在 Node.js 项目使用 pnpm",
        evidenceEntryIds: ["entry-2"], confidence: 1,
      }],
    }, { threadId: "thread-a", turnId: "turn-a" });
    expect(result).toMatchObject({ success: true });
    expect(store.read("bot-a@im.bot").entries).toMatchObject([
      { id: "js-package-manager-pnpm", value: "只在 Node.js 项目使用 pnpm" },
    ]);
  });

  it("reconciles a triggerless Curator revision to the existing stable id", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-automatic", basedOnRevision: 0, evidenceEntryIds: new Set(["seed-entry"]),
      mutations: [{
        op: "add", id: "js-package-manager-pnpm", category: "preferences",
        value: "所有 JavaScript 项目使用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1,
      }],
    });
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1", evidenceEntryIds: ["entry-2"],
      mutationPolicy: { mode: "reconcile" },
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1,
      batchId: "batch-1",
      decisions: [{
        kind: "revise",
        match: "JavaScript 项目使用 pnpm",
        value: "只在 Node.js 项目使用 pnpm",
        evidenceEntryIds: ["entry-2"],
        confidence: 1,
      }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: true });
    expect(store.read("bot-a@im.bot").entries).toEqual([
      expect.objectContaining({ id: "js-package-manager-pnpm", value: "只在 Node.js 项目使用 pnpm" }),
    ]);
  });

  it("returns a no-write clarification when an automatic revision target is ambiguous", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-ambiguous", basedOnRevision: 0, evidenceEntryIds: new Set(["seed-entry"]),
      mutations: [
        { op: "add", id: "pnpm-global", category: "preferences", value: "所有项目使用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1 },
        { op: "add", id: "pnpm-demo", category: "projects", value: "Demo 项目使用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1 },
      ],
    });
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1", evidenceEntryIds: ["entry-2"],
      mutationPolicy: { mode: "reconcile" },
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1, batchId: "batch-1",
      decisions: [{ kind: "revise", match: "使用 pnpm", value: "只在 Node.js 项目使用 pnpm", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: true });
    expect(host.clarification("thread-a")).toEqual({ reason: "target_ambiguous", candidateIds: ["pnpm-demo", "pnpm-global"] });
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, entries: [{ id: "pnpm-global" }, { id: "pnpm-demo" }] });
  });

  it("treats an automatic remember of an exact existing value as an idempotent noop", async () => {
    const { store, host } = harness();
    store.apply("bot-a@im.bot", {
      batchId: "seed-duplicate", basedOnRevision: 0, evidenceEntryIds: new Set(["seed-entry"]),
      mutations: [{ op: "add", id: "existing-pnpm", category: "preferences", value: "所有项目使用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1 }],
    });
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1", evidenceEntryIds: ["entry-2"],
      mutationPolicy: { mode: "reconcile" },
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1, batchId: "batch-1",
      decisions: [{ kind: "remember", category: "preferences", value: "所有项目使用 pnpm。", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: true });
    expect(host.receipt("thread-a")).toMatchObject({ revision: 1, added: 0, updated: 0, removed: 0 });
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, entries: [{ id: "existing-pnpm" }] });
  });

  it("uses hybrid search to return safe candidates without authorizing a semantic-only update", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-tools-search-"));
    const store = new AccountMemoryStore(root);
    store.apply("bot-a@im.bot", {
      batchId: "seed-search", basedOnRevision: 0, evidenceEntryIds: new Set(["seed-entry"]),
      mutations: [{ op: "add", id: "package-manager", category: "preferences", value: "前端依赖统一采用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1 }],
    });
    const search = { search: async () => [{ id: "package-manager", rank: 1, score: 0.9, source: "semantic" as const }] };
    const host = new AccountMemoryToolHost(store, search);
    host.bind("thread-a", {
      accountId: "bot-a@im.bot", jobId: "job-1", batchId: "batch-1", evidenceEntryIds: ["entry-2"],
      mutationPolicy: { mode: "reconcile" },
    });

    const result = await host.execute("account_memory_commit", {
      basedOnRevision: 1, batchId: "batch-1",
      decisions: [{ kind: "revise", match: "Node package manager preference", value: "只在 Node.js 项目使用 pnpm", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    }, { threadId: "thread-a", turnId: "turn-a" });

    expect(result).toMatchObject({ success: true });
    expect(host.clarification("thread-a")).toEqual({ reason: "target_missing", candidateIds: ["package-manager"] });
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, entries: [{ id: "package-manager", value: "前端依赖统一采用 pnpm。" }] });
  });
});

function expectStrictObjectRequirements(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? Object.keys(record.properties)
      : [];
    expect(new Set(record.required as string[] | undefined)).toEqual(new Set(properties));
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach(expectStrictObjectRequirements);
    else expectStrictObjectRequirements(child);
  }
}
