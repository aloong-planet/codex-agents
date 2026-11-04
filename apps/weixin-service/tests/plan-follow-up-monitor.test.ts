import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountMemoryStore } from "../src/account-memory-store.js";
import {
  PlanFollowUpMonitor,
  renderPlanReminderSegments,
  type DuePlanReminder,
} from "../src/plan-follow-up-monitor.js";

describe("plan follow-up reminder rendering", () => {
  it("renders natural mixed per-plan ordinals and the final-reminder explanation", () => {
    const plans: DuePlanReminder[] = [
      {
        id: "plan-docs", summary: "整理项目资料。", localDate: "2026-08-18",
        timePrecision: "date", reminderCount: 0,
      },
      {
        id: "plan-movie", summary: "去看电影《牛来》。", localDate: "2026-08-17",
        timePrecision: "evening", reminderCount: 2,
      },
      {
        id: "plan-lunch", summary: "和朋友吃饭。", localDate: "2026-08-18",
        timePrecision: "exact", localTime: "12:00", reminderCount: 1,
      },
    ];

    const segments = renderPlanReminderSegments(plans, 1_500);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.message).toBe([
      "提醒你一下，下面这些计划已经到时间了。你可以告诉我完成情况，或者重新安排时间。",
      "",
      "1. [第 1 次] 你计划在 8 月 18 日整理项目资料。",
      "2. [最后一次] 你计划在 8 月 17 日晚上去看电影《牛来》。",
      "3. [第 2 次] 你计划在 8 月 18 日 12:00 和朋友吃饭。",
      "",
      "直接告诉我结果就可以，比如：",
      "“1 已完成；2 没有完成；3 改到周五晚上”",
      "也可以按你习惯的方式回复。",
      "",
      "标记为“最后一次”的计划，如果这次没有回复，我就先不再提醒了，会保留为“结果未确认”。以后想起来再告诉我也可以。",
    ].join("\n"));
    expect(segments[0]?.planIds).toEqual(["plan-docs", "plan-movie", "plan-lunch"]);
    expect(segments[0]?.message).not.toContain("|");
    expect(Array.from(segments[0]!.message).length).toBeLessThanOrEqual(1_500);
  });

  it("splits only between complete plan items and keeps every segment within the limit", () => {
    const plans: DuePlanReminder[] = Array.from({ length: 5 }, (_, index) => ({
      id: `plan-${index + 1}`,
      summary: `完成第 ${index + 1} 项${"较长内容".repeat(8)}。`,
      localDate: "2026-08-18",
      timePrecision: "date",
      reminderCount: index === 4 ? 2 : 0,
    }));

    const segments = renderPlanReminderSegments(plans, 260);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.flatMap((segment) => segment.planIds)).toEqual(plans.map((plan) => plan.id));
    expect(segments.every((segment) => Array.from(segment.message).length <= 260)).toBe(true);
    for (const index of plans.keys()) {
      expect(segments.filter((segment) => segment.message.includes(`第 ${index + 1} 项`))).toHaveLength(1);
    }
  });
});

describe("plan follow-up reminder ledger", () => {
  it("increments only plans in an accepted segment and schedules their next local-day reminder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reminder-ledger-"));
    const dueAt = Date.parse("2026-08-18T12:00:00+08:00");
    const acceptedAt = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => acceptedAt);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plans", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        {
          op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18",
          timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00",
          summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1,
        },
        {
          op: "event_add", id: "plan-evening", eventKind: "planned", localDate: "2026-08-18",
          timezone: "Asia/Shanghai", timePrecision: "evening",
          summary: "去看电影。", evidenceEntryIds: ["seed"], confidence: 1,
        },
      ],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", acceptedAt - 1_000);

    const due = store.duePlanReminders("bot-a@im.bot", acceptedAt);
    expect(due).toEqual([
      expect.objectContaining({ id: "plan-lunch", scheduledAt: dueAt, reminderCount: 0 }),
    ]);
    const segments = renderPlanReminderSegments(due, 1_500);
    const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", segments, acceptedAt);
    store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, acceptedAt);
    store.finishReminderSegment("bot-a@im.bot", batch.id, 0, "accepted", acceptedAt);

    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "plan-lunch", reminderCount: 1, followUpState: "awaiting_response",
        lastReminderAt: acceptedAt, nextReminderAt: Date.parse("2026-08-19T12:05:00+08:00"),
      }),
      expect.objectContaining({ id: "plan-evening", reminderCount: 0, followUpState: "waiting" }),
    ]));
    expect(store.latestReminderContext("bot-a@im.bot", "owner@im.wechat")).toEqual({
      batchId: batch.id,
      plans: [{ ordinal: 1, planId: "plan-lunch", summary: "和朋友吃饭。" }],
    });
  });

  it("scans overdue plans and sends the deterministic reminder to the confirmed target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reminder-monitor-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{
        op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00",
        summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1,
      }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 1_000);
    const sends: Array<{ accountId: string; target: string; message: string }> = [];
    const monitor = new PlanFollowUpMonitor({
      store, now: () => now,
      sender: async (input) => { sends.push(input); return { ok: true, acceptedSegments: 1, totalSegments: 1 }; },
    });

    await monitor.runNow(["bot-a@im.bot"]);

    expect(sends).toEqual([expect.objectContaining({
      accountId: "bot-a@im.bot", target: "owner@im.wechat",
      message: expect.stringContaining("[第 1 次] 你计划在 8 月 18 日 12:00 和朋友吃饭。"),
    })]);
    expect(store.read("bot-a@im.bot").events[0]).toMatchObject({ reminderCount: 1, followUpState: "awaiting_response" });
    monitor.close();
  });

  it("never automatically resends a segment whose delivery result is unknown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reminder-unknown-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{
        op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00",
        summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1,
      }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 1_000);
    let sendCount = 0;
    const monitor = new PlanFollowUpMonitor({
      store, now: () => now,
      sender: async () => { sendCount += 1; return { ok: false, reason: "unknown" }; },
    });

    await monitor.runNow(["bot-a@im.bot"]);
    await monitor.runNow(["bot-a@im.bot"]);

    expect(sendCount).toBe(1);
    expect(store.read("bot-a@im.bot").events[0]).toMatchObject({ reminderCount: 0, followUpState: "waiting" });
    monitor.close();
  });

  it("recovers an interrupted sending attempt as unknown before scanning after restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reminder-restart-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00", summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 10);
    const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", [{ message: "提醒", planIds: ["plan-lunch"] }], now - 5);
    store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, now - 4);
    let sends = 0;
    const monitor = new PlanFollowUpMonitor({
      store, now: () => now,
      sender: async () => { sends += 1; return { ok: true }; },
    });

    await monitor.runNow(["bot-a@im.bot"]);

    expect(sends).toBe(0);
    expect(store.duePlanReminders("bot-a@im.bot", now)).toEqual([]);
    monitor.close();
  });

  it("runs in the background on a fixed poll without overlapping scans", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reminder-timer-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{
        op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00",
        summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1,
      }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 1_000);
    let tick: (() => void) | undefined;
    let sendCount = 0;
    const monitor = new PlanFollowUpMonitor({
      store, now: () => now,
      sender: async () => { sendCount += 1; return { ok: true }; },
      pollIntervalMs: 60_000,
      setTimer: (callback) => { tick = callback; return 1; },
      clearTimer: () => {},
    });

    monitor.start(() => ["bot-a@im.bot"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendCount).toBe(1);
    expect(tick).toBeTypeOf("function");

    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendCount).toBe(1);
    monitor.close();
  });

  it("exhausts follow-up only after three accepted reminders and one further daily deadline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reminder-exhaustion-"));
    let now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00", summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 1);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const due = store.duePlanReminders("bot-a@im.bot", now);
      expect(due[0]?.reminderCount).toBe(attempt - 1);
      const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", renderPlanReminderSegments(due), now);
      store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, now);
      store.finishReminderSegment("bot-a@im.bot", batch.id, 0, "accepted", now);
      now += 24 * 60 * 60 * 1_000;
    }

    expect(store.read("bot-a@im.bot").events[0]).toMatchObject({ reminderCount: 3, followUpState: "awaiting_response", planStatus: "pending" });
    expect(store.duePlanReminders("bot-a@im.bot", now)).toEqual([]);
    expect(store.read("bot-a@im.bot").events[0]).toMatchObject({ reminderCount: 3, followUpState: "exhausted", planStatus: "pending" });
  });
});
