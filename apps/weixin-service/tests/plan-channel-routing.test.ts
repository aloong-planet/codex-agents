// Public memory/tool/monitor boundary; simultaneous main and actual device receipt remain tickets 12/13.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { PlanFollowUpMonitor } from "../src/plan-follow-up-monitor.js";
import { OwnerNotificationRoute, type NotificationDestination } from "../src/notification-channel.js";

const accountId = "bot-a@im.bot";
const target = "owner@im.wechat";
const selected = { channel: "feishu" as const, accountId: "feishu.app", target: `feishu.${"a".repeat(64)}` };

describe("plan reminder channel routing", () => {
  it("captures each plan source and keeps reminder batches and numbered contexts separate after restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-dual-"));
    let now = Date.parse("2026-08-18T12:05:00+08:00");
    const route = new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
      destinations: [{ channel: "weixin", accountId, target }, selected] });
    let store = new AccountMemoryStore(root, () => now);
    const host = new AccountMemoryToolHost(store, undefined, undefined, route);
    const sources = [{ target, text: "今天中午12点和朋友吃饭", summary: "和朋友吃饭。" },
      { target: selected.target, text: "今天中午12点去图书馆", summary: "去图书馆。" }];
    try {
      for (const [index, source] of sources.entries()) {
        expect(await host.commit({ accountId, jobId: `job-${index}`, batchId: `batch-${index}`, mutationPolicy: { mode: "reconcile" },
          evidenceEntryIds: ["source"], evidenceTexts: { source: source.text }, evidenceLocalDates: { source: "2026-08-18" },
          evidenceOrigins: { source: { eventKey: `event-${index}`, target: source.target } },
        }, { batchId: `batch-${index}`, basedOnRevision: store.read(accountId).revision, decisions: [{
          kind: "record_event", eventKind: "planned", localDate: "2026-08-18", timePrecision: "exact", localTime: "12:00",
          summary: source.summary, sourceText: source.text, planMatch: null, evidenceEntryIds: ["source"], confidence: 1,
        }] })).toMatchObject({ status: "committed", receipt: { eventsAdded: 1 } });
      }
      const events = store.read(accountId).events;
      expect(events).toHaveLength(2);
      const lunch = events.find((event) => event.summary === "和朋友吃饭。")!;
      const library = events.find((event) => event.summary === "去图书馆。")!;
      // An opposite-channel edit changes the plan content, never its original delivery preference.
      expect(await host.commit({ accountId, jobId: "edit", batchId: "edit", mutationPolicy: { mode: "reconcile" }, evidenceEntryIds: ["edit"],
        evidenceTexts: { edit: "今天中午12点和朋友吃饭的计划改成今天中午12点和朋友吃午饭" }, evidenceLocalDates: { edit: "2026-08-18" },
        evidenceOrigins: { edit: { eventKey: "fs-edit", target: selected.target } },
      }, { batchId: "edit", basedOnRevision: store.read(accountId).revision, decisions: [{ kind: "revise_event", match: "和朋友吃饭",
        eventKind: "planned", localDate: "2026-08-18", timePrecision: "exact", localTime: "12:00", summary: "和朋友吃午饭。", evidenceEntryIds: ["edit"], confidence: 1 }] }))
        .toMatchObject({ status: "committed", receipt: { eventsUpdated: 1 } });
      store = new AccountMemoryStore(root, () => now);
      expect(() => store.createReminderBatch(accountId, target, [{ message: "invalid mixed batch", planIds: [lunch.id, library.id] }], now,
        { channel: "weixin", accountId, target })).toThrow("memory_reminder_destination_mismatch");
      const sends: Array<NotificationDestination & { message: string }> = [];
      const monitor = new PlanFollowUpMonitor({ store, notificationRoute: route, now: () => now,
        sender: async (input) => { sends.push(input); return { ok: true }; } });
      await monitor.runNow([accountId]); await monitor.close();
      expect(sends).toHaveLength(2);
      expect(sends.find((send) => send.target === target)?.message).toContain("和朋友吃午饭");
      expect(sends.find((send) => send.target === target)?.message).not.toContain("图书馆");
      expect(sends.find((send) => send.target === selected.target)?.message).toContain("去图书馆");
      expect(sends.find((send) => send.target === selected.target)?.message).not.toContain("朋友");
      expect(store.latestReminderContext(accountId, target)?.plans).toEqual([{ ordinal: 1, planId: lunch.id, summary: "和朋友吃午饭。" }]);
      expect(store.latestReminderContext(accountId, selected.target)?.plans).toEqual([{ ordinal: 1, planId: library.id, summary: "去图书馆。" }]);
      now += 86_400_000;
      const restarted = new PlanFollowUpMonitor({ store: new AccountMemoryStore(root, () => now), notificationRoute: route, now: () => now,
        sender: async (input) => { sends.push(input); return { ok: true }; } });
      await restarted.runNow([accountId]); await restarted.close();
      expect(sends.map((send) => send.target).sort()).toEqual([target, target, selected.target, selected.target].sort());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("reports the legacy migration prerequisite without consuming a plan or sending through Weixin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-migration-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply(accountId, { batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]), mutations: [{
      op: "event_add", id: "old-plan", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai",
      timePrecision: "exact", localTime: "12:00", summary: "去图书馆。", evidenceEntryIds: ["seed"], confidence: 1,
    }] });
    const sends: string[] = [];
    const unavailable = new PlanFollowUpMonitor({ store, now: () => now, notificationRoute: new OwnerNotificationRoute({
      memoryAccountId: accountId, scope: { accountId, target }, selected: { channel: "weixin", accountId, target },
      destinations: [{ channel: "weixin", accountId, target }],
    }), sender: async (input) => { sends.push(input.target); return { ok: true }; } });
    try {
      await expect(unavailable.runNow([accountId])).rejects.toThrow("notification_migration_feishu_binding_required");
      expect(sends).toEqual([]);
      expect(store.read(accountId)).toMatchObject({ revision: 1, events: [{ id: "old-plan", reminderCount: 0 }] });
      const route = new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
        destinations: [{ channel: "weixin", accountId, target }, selected] });
      for (let restart = 0; restart < 2; restart++) {
        const monitor = new PlanFollowUpMonitor({ store: new AccountMemoryStore(root, () => now), notificationRoute: route, now: () => now,
          sender: async (input) => { sends.push(input.target); return { ok: true }; } });
        await monitor.runNow([accountId]); await monitor.close();
      }
      expect(sends).toEqual([selected.target]);
      expect(store.read(accountId)).toMatchObject({ revision: 1, events: [{ id: "old-plan", reminderCount: 1 }] });
    } finally { await unavailable.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("continues the healthy group and never retries an unknown group after reopening", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-unknown-dual-"));
    let now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    const route = new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
      destinations: [{ channel: "weixin", accountId, target }, selected] });
    store.apply(accountId, { batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      planDestinations: { "plan-wx": { channel: "weixin", accountId, target }, "plan-fs": selected },
      mutations: ["plan-wx", "plan-fs"].map((id) => ({ op: "event_add", id, eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00", summary: id === "plan-wx" ? "吃午饭。" : "去图书馆。", evidenceEntryIds: ["seed"], confidence: 1 })),
    });
    store.apply("other@im.bot", { batchId: "foreign", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]), mutations: [{
      op: "event_add", id: "foreign-plan", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai",
      timePrecision: "exact", localTime: "12:00", summary: "陌生计划。", evidenceEntryIds: ["seed"], confidence: 1,
    }] });
    const sends: Array<{ target: string; operationId: string }> = [];
    try {
      for (let restart = 0; restart < 2; restart++) {
        const monitor = new PlanFollowUpMonitor({ store: new AccountMemoryStore(root, () => now), notificationRoute: route, now: () => now,
          sender: async (input) => { sends.push(input); return input.target === target ? { ok: false, reason: "unknown" } : { ok: true }; } });
        await monitor.runNow(["other@im.bot", accountId]); await monitor.close(); now += 86_400_000;
      }
      expect(sends.filter((send) => send.target === target)).toHaveLength(1);
      expect(sends.filter((send) => send.target === selected.target)).toHaveLength(2);
      expect(store.latestReminderContext(accountId, target)).toBeUndefined();
      expect(store.latestReminderContext(accountId, selected.target)?.plans).toEqual([{ ordinal: 1, planId: "plan-fs", summary: "去图书馆。" }]);
      const wxBatch = sends.find((send) => send.target === target)!.operationId.split(":")[0]!;
      expect(store.reminderDelivery(accountId, wxBatch)).toEqual({ channel: "weixin", accountId: "bot-a@im.bot", target: "owner@im.wechat" });
      expect(store.read(accountId).events.find((event) => event.id === "plan-wx")).toMatchObject({ reminderCount: 0 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps one reminder intent owner in either chat and rejects an unbound plan origin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-intent-dual-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00"), text = "今天下午三点提醒我喝水";
    const route = new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
      destinations: [{ channel: "weixin", accountId, target }, selected] });
    const store = new AccountMemoryStore(path.join(root, "memory"), () => now);
    const scheduled = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => now,
      readOriginalText: () => text, notificationRoute: route });
    const host = new AccountMemoryToolHost(store, undefined, scheduled, route);
    try {
      for (const [index, address] of [{ accountId, target }, selected].entries()) {
        expect(await scheduled.execute({ toolId: "schedules.create", toolVersion: 1, arguments: {
          name: "喝水", instruction: "喝水", reminderText: "喝水", reminderMode: "verbatim", sourceText: text, at: "2026-08-18T15:00:00+08:00",
        } }, { ...address, eventKey: `create-${index}`, occurredAt: now, originalTextRef: "source", attachmentRefs: [] })).toMatchObject({ status: "created" });
        expect(await host.commit({ accountId, jobId: `job-${index}`, batchId: `batch-${index}`, mutationPolicy: { mode: "reconcile" },
          evidenceEntryIds: ["source"], evidenceTexts: { source: text }, evidenceLocalDates: { source: "2026-08-18" },
          evidenceOrigins: { source: { eventKey: `create-${index}`, target: address.target } },
        }, { batchId: `batch-${index}`, basedOnRevision: store.read(accountId).revision, decisions: [{
          kind: "record_event", eventKind: "planned", localDate: "2026-08-18", timePrecision: "exact", localTime: "15:00",
          summary: "喝水。", sourceText: text, planMatch: null, evidenceEntryIds: ["source"], confidence: 1,
        }] })).toMatchObject({ status: "committed", receipt: { revision: 0, added: 0, updated: 0, removed: 0 } });
      }
      expect(store.read(accountId).events).toEqual([]);
      await expect(host.commit({ accountId, jobId: "foreign", batchId: "foreign", mutationPolicy: { mode: "reconcile" },
        evidenceEntryIds: ["source"], evidenceTexts: { source: text }, evidenceLocalDates: { source: "2026-08-18" },
        evidenceOrigins: { source: { eventKey: "foreign", target: "foreign@im.wechat" } },
      }, { batchId: "foreign", basedOnRevision: store.read(accountId).revision, decisions: [{
        kind: "record_event", eventKind: "planned", localDate: "2026-08-18", timePrecision: "exact", localTime: "15:00",
        summary: "喝水。", sourceText: text, planMatch: null, evidenceEntryIds: ["source"], confidence: 1,
      }] })).rejects.toThrow("memory_plan_origin_unbound");
      expect(store.read(accountId).events).toEqual([]);
    } finally { scheduled.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("does not recreate a frozen unsent legacy batch on another channel", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-frozen-unsent-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply(accountId, { batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]), mutations: [{
      op: "event_add", id: "old-plan", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai",
      timePrecision: "exact", localTime: "12:00", summary: "去图书馆。", evidenceEntryIds: ["seed"], confidence: 1,
    }] });
    store.confirmNotificationTarget(accountId, target);
    const frozen = store.createReminderBatch(accountId, target, [{ message: "原提醒", planIds: ["old-plan"] }], now);
    const sends: string[] = [];
    const monitor = new PlanFollowUpMonitor({ store: new AccountMemoryStore(root, () => now), now: () => now,
      notificationRoute: new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
        destinations: [{ channel: "weixin", accountId, target }, selected] }),
      sender: async (input) => { sends.push(input.target); return { ok: true }; },
    });
    try {
      await monitor.runNow([accountId]);
      expect(sends).toEqual([]);
      expect(store.reminderDelivery(accountId, frozen.id)).toEqual({ accountId: "bot-a@im.bot", target: "owner@im.wechat" });
      expect(store.read(accountId).events).toMatchObject([{ id: "old-plan", reminderCount: 0 }]);
      expect(store.latestReminderContext(accountId, selected.target)).toBeUndefined();
    } finally { await monitor.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("finishes every segment of a destination batch before proceeding to the other group", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-segments-dual-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    const ids = ["plan-a", "plan-b", "plan-c", "plan-d", "plan-z"];
    store.apply(accountId, { batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      planDestinations: Object.fromEntries(ids.map((id) => [id, id === "plan-z" ? selected : { channel: "weixin" as const, accountId, target }])),
      mutations: ids.map((id) => ({ op: "event_add", id, eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai",
        timePrecision: "exact", localTime: "12:00", summary: id === "plan-z" ? "去图书馆。" : `${id}：${"整理资料".repeat(95)}。`, evidenceEntryIds: ["seed"], confidence: 1 })),
    });
    const sends: Array<{ target: string; message: string }> = [];
    const monitor = new PlanFollowUpMonitor({ store, now: () => now,
      notificationRoute: new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
        destinations: [{ channel: "weixin", accountId, target }, selected] }),
      sender: async (input) => { sends.push(input); return { ok: true }; },
    });
    try {
      await monitor.runNow([accountId]);
      expect(sends.filter((send) => send.target === target)).toHaveLength(2);
      expect(sends.filter((send) => send.target === selected.target)).toHaveLength(1);
      expect(store.latestReminderContext(accountId, target)?.plans.map((plan) => [plan.ordinal, plan.planId]))
        .toEqual([[1, "plan-a"], [2, "plan-b"], [3, "plan-c"], [4, "plan-d"]]);
      expect(store.read(accountId).events.map((event) => event.reminderCount)).toEqual([1, 1, 1, 1, 1]);
      await monitor.runNow([accountId]); expect(sends).toHaveLength(3);
    } finally { await monitor.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ["accepted", false], ["unknown", false], ["accepted", true], ["unknown", true],
  ] as const)("keeps %s historical delivery with creation capture %s", async (outcome, capture) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-route-"));
    let now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply(accountId, { batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "plan-lunch", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", timePrecision: "exact", localTime: "12:00", summary: "和朋友吃饭。", evidenceEntryIds: ["seed"], confidence: 1 }] });
    store.confirmNotificationTarget(accountId, target, now - 1);
    const sends: Array<NotificationDestination & { message: string }> = [];
    const old = new PlanFollowUpMonitor({ store, now: () => now, sender: async (input) => {
      sends.push(input); return outcome === "accepted" ? { ok: true } : { ok: false, reason: "unknown" };
    } });
    await old.runNow([accountId]); await old.close();
    const previous = store.latestReminderContext(accountId, target)!;
    const reopened = new AccountMemoryStore(root, () => now);
    const current = new PlanFollowUpMonitor({ store: reopened, now: () => now,
      notificationRoute: new OwnerNotificationRoute({ memoryAccountId: accountId, scope: { accountId, target }, selected,
        ...(capture ? { destinations: [{ channel: "weixin" as const, accountId, target }, selected] } : {}) }),
      sender: async (input) => { sends.push(input); return { ok: true }; } });
    try {
      await current.runNow([accountId]); expect(sends).toHaveLength(1);
      now += 86_400_000;
      await current.runNow([accountId]);
      if (outcome === "accepted") {
        expect(sends).toHaveLength(2);
        expect(sends[1]).toMatchObject({ channel: "feishu", accountId: "feishu.app", target: `feishu.${"a".repeat(64)}` });
        const context = reopened.latestReminderContext(accountId, selected.target)!;
        expect(context.plans).toEqual([{ ordinal: 1, planId: "plan-lunch", summary: "和朋友吃饭。" }]);
        expect(reopened.reminderDelivery(accountId, context.batchId)).toEqual({ channel: "feishu", accountId: "feishu.app", target: `feishu.${"a".repeat(64)}` });
        expect(reopened.reminderDelivery(accountId, previous.batchId)).toEqual({ accountId: "bot-a@im.bot", target: "owner@im.wechat" });
        expect(reopened.read(accountId).events[0]).toMatchObject({ id: "plan-lunch", reminderCount: 2 });
      } else {
        expect(sends).toHaveLength(1);
        expect(reopened.latestReminderContext(accountId, selected.target)).toBeUndefined();
        expect(reopened.read(accountId).events[0]).toMatchObject({ id: "plan-lunch", reminderCount: 0 });
      }
    } finally { await current.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
