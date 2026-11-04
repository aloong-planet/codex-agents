import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AccountMemoryStore,
  renderEventPanel,
  renderMemory,
  type AccountMemoryEvent,
} from "../src/account-memory-store.js";

function makeStore(): AccountMemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-store-"));
  return new AccountMemoryStore(root, () => Date.parse("2026-08-18T12:00:00+08:00"));
}

describe("AccountMemoryStore", () => {
  it("does not expose an unresolved reminder item whose plan is already terminal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-terminal-reminder-"));
    const now = Date.parse("2026-08-21T20:20:00+08:00");
    const store = new AccountMemoryStore(root, () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", summary: "计划晚上去看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 10);
    const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", [{ message: "提醒", planIds: ["movie-plan"] }], now - 5);
    store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, now - 4);
    store.finishReminderSegment("bot-a@im.bot", batch.id, 0, "accepted", now - 3);

    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const database = new DatabaseSync(path.join(root, "accounts", scope, "memory.sqlite"));
    database.prepare("UPDATE events SET plan_status = 'occurred' WHERE id = 'movie-plan'").run();
    database.close();

    expect(store.latestReminderContext("bot-a@im.bot", "owner@im.wechat")).toBeUndefined();
  });

  it("renders a user-facing event panel with plan time, outcome, and reminder progress but no internal ids", () => {
    const base = {
      timezone: "Asia/Shanghai" as const,
      evidenceEntryIds: ["evidence"],
      confidence: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const events: AccountMemoryEvent[] = [
      {
        ...base, id: "plan-shoes", eventKind: "planned", localDate: "2026-08-17",
        summary: "买鞋子。", planStatus: "pending", timePrecision: "exact", localTime: "22:00",
        scheduledAt: Date.parse("2026-08-17T22:00:00+08:00"), followUpState: "awaiting_response", reminderCount: 1,
      },
      {
        ...base, id: "plan-movie", eventKind: "planned", localDate: "2026-08-16",
        summary: "去看电影。", planStatus: "pending", timePrecision: "evening",
        scheduledAt: Date.parse("2026-08-16T23:59:00+08:00"), followUpState: "exhausted", reminderCount: 3,
      },
      {
        ...base, id: "plan-cancelled", eventKind: "planned", localDate: "2026-08-18",
        summary: "去跑步。", planStatus: "cancelled", timePrecision: "morning",
      },
      {
        ...base, id: "plan-unfulfilled", eventKind: "planned", localDate: "2026-08-18",
        summary: "整理资料。", planStatus: "unfulfilled", timePrecision: "afternoon", reminderCount: 2,
      },
      {
        ...base, id: "plan-occurred", eventKind: "planned", localDate: "2026-08-18",
        summary: "完成锻炼。", planStatus: "occurred", timePrecision: "date", reminderCount: 1,
      },
      {
        ...base, id: "fact-dinner", eventKind: "observed", localDate: "2026-08-17",
        summary: "吃了晚饭。", factStatus: "valid",
      },
    ];

    const rendered = renderEventPanel(events, Date.parse("2026-08-17T22:01:00+08:00"));

    expect(rendered).toContain("[计划·已到期·结果未确认] 22:00 · 买鞋子。");
    expect(rendered).toContain("提醒：已提醒 1/3 次，等待回复");
    expect(rendered).toContain("[计划·已到期·结果未确认] 晚上 · 去看电影。");
    expect(rendered).toContain("提醒：已停止自动提醒（已提醒 3/3 次）");
    expect(rendered).toContain("[计划·已取消] 上午 · 去跑步。");
    expect(rendered).toContain("[计划·未落实] 下午 · 整理资料。");
    expect(rendered).toContain("[计划·已发生] 未指定具体时间 · 完成锻炼。");
    expect(rendered).toContain("[已发生] 吃了晚饭。");
    expect(rendered.match(/提醒：/gu)).toHaveLength(2);
    expect(rendered).not.toContain("event:id=");
    expect(rendered).not.toContain("plan-shoes");
  });

  it("atomically stores a durable preference and a dated planned event with separate projections", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-event-"));
    const store = new AccountMemoryStore(root, () => Date.parse("2026-08-16T12:00:00+08:00"));

    const receipt = store.apply("bot-a@im.bot", {
      batchId: "preference-and-event",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["user-meal"]),
      mutations: [
        {
          op: "add", id: "preference-crab-pot", category: "preferences",
          value: "喜欢吃肉蟹煲。", evidenceEntryIds: ["user-meal"], confidence: 1,
        },
        {
          op: "event_add", id: "event-crab-pot-tomorrow", eventKind: "planned",
          localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "准备去吃肉蟹煲。",
          timePrecision: "evening",
          evidenceEntryIds: ["user-meal"], confidence: 1,
        } as const,
      ],
    });

    expect(receipt).toMatchObject({ revision: 1, added: 1, eventsAdded: 1 });
    expect(store.read("bot-a@im.bot")).toMatchObject({
      revision: 1,
      entries: [{ id: "preference-crab-pot", value: "喜欢吃肉蟹煲。" }],
      eventCount: 1,
      events: [{
        id: "event-crab-pot-tomorrow", eventKind: "planned", localDate: "2026-08-17",
        timezone: "Asia/Shanghai", summary: "准备去吃肉蟹煲。", planStatus: "pending",
        timePrecision: "evening", scheduledAt: Date.parse("2026-08-17T23:59:00+08:00"),
        followUpState: "waiting", reminderCount: 0,
      }],
    });
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    expect(fs.readFileSync(path.join(root, "accounts", scope, "MEMORY.md"), "utf8")).toContain("喜欢吃肉蟹煲");
    expect(fs.readFileSync(path.join(root, "accounts", scope, "events", "2026-08-17.md"), "utf8")).toContain("[计划·未落实] 准备去吃肉蟹煲。");
  });

  it("commits an exact duplicate event as a no-op without advancing revision", () => {
    const store = makeStore();
    const event = {
      op: "event_add" as const, id: "event-crab-pot-tomorrow", eventKind: "planned" as const,
      localDate: "2026-08-17", timezone: "Asia/Shanghai" as const, summary: "准备去吃肉蟹煲。",
      evidenceEntryIds: ["meal-plan"], confidence: 1,
    };
    store.apply("bot-a@im.bot", {
      batchId: "event-first", basedOnRevision: 0,
      evidenceEntryIds: new Set(["meal-plan"]), mutations: [event],
    });

    const duplicate = store.apply("bot-a@im.bot", {
      batchId: "event-duplicate", basedOnRevision: 1,
      evidenceEntryIds: new Set(["meal-plan-again"]),
      mutations: [{ ...event, id: "event-crab-pot-duplicate", evidenceEntryIds: ["meal-plan-again"] }],
    });

    expect(duplicate).toEqual({ status: "committed", revision: 1, added: 0, updated: 0, removed: 0 });
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, eventCount: 1 });
  });

  it("moves one planned event without changing its id and removes the stale date projection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-event-update-"));
    const store = new AccountMemoryStore(root, () => Date.parse("2026-08-17T12:00:00+08:00"));
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-18",
        timezone: "Asia/Shanghai", summary: "晚上去看电影。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    });
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const eventsDirectory = path.join(root, "accounts", scope, "events");
    expect(fs.existsSync(path.join(eventsDirectory, "2026-08-18.md"))).toBe(true);

    const receipt = store.apply("bot-a@im.bot", {
      batchId: "move-plan", basedOnRevision: 1, evidenceEntryIds: new Set(["entry-2"]),
      mutations: [{
        op: "event_update", id: "movie-plan", localDate: "2026-08-17", timezone: "Asia/Shanghai",
        summary: "今晚去看电影《牛来》。", evidenceEntryIds: ["entry-2"], confidence: 1,
      }],
    });

    expect(receipt).toMatchObject({ revision: 2, eventsUpdated: 1 });
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({ id: "movie-plan", localDate: "2026-08-17", summary: "今晚去看电影《牛来》。" }),
    ]);
    expect(fs.existsSync(path.join(eventsDirectory, "2026-08-18.md"))).toBe(false);
    expect(fs.readFileSync(path.join(eventsDirectory, "2026-08-17.md"), "utf8")).toContain("event:id=movie-plan");
  });

  it("does not allow an observed fact to be rewritten as a plan", () => {
    const store = makeStore();
    store.apply("bot-a@im.bot", {
      batchId: "seed-fact", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "event_add", id: "movie-fact", eventKind: "observed", localDate: "2026-08-17",
        timezone: "Asia/Shanghai", summary: "看了电影。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    });

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "rewrite-fact", basedOnRevision: 1, evidenceEntryIds: new Set(["entry-2"]),
      mutations: [{
        op: "event_update", id: "movie-fact", localDate: "2026-08-18", timezone: "Asia/Shanghai",
        summary: "准备看电影。", evidenceEntryIds: ["entry-2"], confidence: 1,
      }],
    })).toThrow("memory_event_not_active_plan");
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({ id: "movie-fact", eventKind: "observed", localDate: "2026-08-17" }),
    ]);
  });

  it("migrates existing planned events into one pending date-only plan record", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-event-status-migration-"));
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const directory = path.join(root, "accounts", scope);
    fs.mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(path.join(directory, "memory.sqlite"));
    database.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, event_kind TEXT NOT NULL, local_date TEXT NOT NULL, timezone TEXT NOT NULL,
        summary TEXT NOT NULL, normalized_summary TEXT NOT NULL, evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(event_kind, local_date, normalized_summary)
      );
    `);
    database.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-plan", "planned", "2026-08-18", "Asia/Shanghai", "晚上去看电影。", "晚上去看电影", '["legacy"]', 1, 1, 1);
    database.close();

    const store = new AccountMemoryStore(root, () => Date.parse("2026-08-17T12:00:00+08:00"));
    expect(store.read("bot-a@im.bot").events).toEqual([
      expect.objectContaining({
        id: "legacy-plan", eventKind: "planned", planStatus: "pending",
        timePrecision: "date", scheduledAt: Date.parse("2026-08-18T23:59:00+08:00"),
        followUpState: "waiting", reminderCount: 0,
      }),
    ]);
  });

  it("rolls back plan completion when an exact duplicate prevents the linked fact from being inserted", () => {
    const store = makeStore();
    store.apply("bot-a@im.bot", {
      batchId: "seed-events", basedOnRevision: 0, evidenceEntryIds: new Set(["entry-1"]),
      mutations: [
        { op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看电影《牛来》。", evidenceEntryIds: ["entry-1"], confidence: 1 },
        { op: "event_add", id: "existing-fact", eventKind: "observed", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看了电影《牛来》。", evidenceEntryIds: ["entry-1"], confidence: 1 },
      ],
    });

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "complete-plan", basedOnRevision: 1, evidenceEntryIds: new Set(["entry-2"]),
      mutations: [
        { op: "event_add", id: "new-linked-fact", eventKind: "observed", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看了电影《牛来》。", fulfillsPlanId: "movie-plan", evidenceEntryIds: ["entry-2"], confidence: 1 },
        { op: "event_complete", id: "movie-plan", observedEventId: "new-linked-fact", evidenceEntryIds: ["entry-2"] },
      ],
    })).toThrow("memory_event_completion_link_missing");
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 1, eventCount: 2 });
    expect(store.read("bot-a@im.bot").events.find((event) => event.id === "movie-plan")?.planStatus).toBe("pending");
  });

  it("updates plan outcomes atomically, resolves reminder items, and retracts a linked fact on correction", () => {
    const store = makeStore();
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.apply("bot-a@im.bot", {
      batchId: "complete-plan", basedOnRevision: 1, evidenceEntryIds: new Set(["done"]),
      mutations: [
        { op: "event_add", id: "movie-fact", eventKind: "observed", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "今晚看了电影。", fulfillsPlanId: "movie-plan", evidenceEntryIds: ["done"], confidence: 1 },
        { op: "event_complete", id: "movie-plan", observedEventId: "movie-fact", evidenceEntryIds: ["done"] },
      ],
    });

    store.apply("bot-a@im.bot", {
      batchId: "correct-result", basedOnRevision: 2, evidenceEntryIds: new Set(["correction"]),
      mutations: [{ op: "event_set_status", id: "movie-plan", status: "unfulfilled", evidenceEntryIds: ["correction"] }],
    });

    expect(store.read("bot-a@im.bot").events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "movie-plan", planStatus: "unfulfilled" }),
      expect.objectContaining({ id: "movie-fact", factStatus: "retracted" }),
    ]));
  });

  it("rolls back stable memory when a combined batch contains an impossible event date", () => {
    const store = makeStore();

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "invalid-event-date", basedOnRevision: 0,
      evidenceEntryIds: new Set(["meal-plan"]),
      mutations: [
        { op: "add", id: "preference-crab-pot", category: "preferences", value: "喜欢吃肉蟹煲。", evidenceEntryIds: ["meal-plan"], confidence: 1 },
        { op: "event_add", id: "event-invalid-date", eventKind: "planned", localDate: "2026-02-30", timezone: "Asia/Shanghai", summary: "准备去吃肉蟹煲。", evidenceEntryIds: ["meal-plan"], confidence: 1 },
      ],
    })).toThrow("memory_event_invalid");
    expect(store.read("bot-a@im.bot")).toMatchObject({ revision: 0, entries: [], events: [], eventCount: 0 });
  });

  it("records an empty batch idempotently without advancing revision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-empty-batch-"));
    const store = new AccountMemoryStore(root);

    const first = store.apply("bot-a@im.bot", {
      batchId: "noop-batch", basedOnRevision: 0, evidenceEntryIds: new Set(), mutations: [],
    });
    const replay = store.apply("bot-a@im.bot", {
      batchId: "noop-batch", basedOnRevision: 0, evidenceEntryIds: new Set(), mutations: [],
    });

    expect(first).toEqual({ status: "committed", revision: 0, added: 0, updated: 0, removed: 0 });
    expect(replay).toEqual(first);
    expect(store.read("bot-a@im.bot").revision).toBe(0);
  });
  it("persists memory for one account without exposing it to another account", () => {
    const store = makeStore();

    const receipt = store.apply("bot-a@im.bot", {
      batchId: "batch-1",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "add",
        id: "preference-package-manager",
        category: "preferences",
        value: "JavaScript 项目使用 pnpm。",
        evidenceEntryIds: ["entry-1"],
        confidence: 1,
      }],
    });

    expect(receipt).toMatchObject({ status: "committed", revision: 1, added: 1 });
    expect(store.read("bot-a@im.bot")).toMatchObject({
      revision: 1,
      entries: [{ id: "preference-package-manager", value: "JavaScript 项目使用 pnpm。" }],
    });
    expect(store.read("bot-b@im.bot")).toMatchObject({ revision: 0, entries: [] });
  });

  it("returns the original receipt when the same batch is replayed", () => {
    const store = makeStore();
    const request = {
      batchId: "batch-replayed",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "add" as const,
        id: "project-assistant",
        category: "projects" as const,
        value: "正在开发微信个人助理。",
        evidenceEntryIds: ["entry-1"],
        confidence: 0.95,
      }],
    };

    expect(store.apply("bot-a@im.bot", request)).toMatchObject({ revision: 1, added: 1 });
    expect(store.apply("bot-a@im.bot", request)).toMatchObject({ revision: 1, added: 1 });
    expect(store.read("bot-a@im.bot").entries).toHaveLength(1);
  });

  it("updates and removes stable entries in one atomic batch", () => {
    const store = makeStore();
    store.apply("bot-a@im.bot", {
      batchId: "seed",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [
        { op: "add", id: "project-a", category: "projects", value: "旧项目。", evidenceEntryIds: ["entry-1"], confidence: 1 },
        { op: "add", id: "preference-a", category: "preferences", value: "喜欢旧方案。", evidenceEntryIds: ["entry-1"], confidence: 1 },
      ],
    });

    const receipt = store.apply("bot-a@im.bot", {
      batchId: "correction",
      basedOnRevision: 1,
      evidenceEntryIds: new Set(["entry-2"]),
      mutations: [
        { op: "update", id: "project-a", value: "新项目。", evidenceEntryIds: ["entry-2"], confidence: 1 },
        { op: "remove", id: "preference-a", evidenceEntryIds: ["entry-2"], reason: "user_forget_request" },
      ],
    });

    expect(receipt).toMatchObject({ revision: 2, updated: 1, removed: 1 });
    expect(store.read("bot-a@im.bot").entries).toMatchObject([
      { id: "project-a", value: "新项目。" },
    ]);
  });

  it("rejects a mutation whose evidence does not belong to the bound job", () => {
    const store = makeStore();

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "forged-evidence",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["allowed-entry"]),
      mutations: [{
        op: "add",
        id: "constraint-forged",
        category: "constraints",
        value: "伪造证据。",
        evidenceEntryIds: ["other-entry"],
        confidence: 1,
      }],
    })).toThrow("memory_evidence_invalid");
    expect(store.read("bot-a@im.bot").entries).toEqual([]);
  });

  it("rejects secrets and account identifiers before writing MEMORY.md", () => {
    const store = makeStore();
    const apply = (value: string) => store.apply("bot-a@im.bot", {
      batchId: `batch-${value.length}`,
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "add",
        id: "preference-sensitive",
        category: "preferences",
        value,
        evidenceEntryIds: ["entry-1"],
        confidence: 1,
      }],
    });

    expect(() => apply("API token 是 sk-secret-value-1234567890")).toThrow("memory_sensitive_value");
    expect(() => apply("我的微信账号是 user@example.com")).toThrow("memory_sensitive_value");
    expect(store.read("bot-a@im.bot").entries).toEqual([]);
  });

  it("rejects high-risk health, financial, identity, relationship, and exact-location facts", () => {
    for (const [index, value] of [
      "我的身份证号是 320101199001011234",
      "我的银行卡号是 6222021234567890",
      "我被诊断为糖尿病",
      "我的家庭住址是无锡市某路 18 号 201 室",
      "我的妻子叫小王",
    ].entries()) {
      const store = makeStore();
      expect(() => store.apply("bot-a@im.bot", {
        batchId: `high-risk-${index}`,
        basedOnRevision: 0,
        evidenceEntryIds: new Set(["entry-1"]),
        mutations: [{
          op: "add", id: `constraint-high-risk-${index}`, category: "constraints",
          value, evidenceEntryIds: ["entry-1"], confidence: 1,
        }],
      })).toThrow("memory_sensitive_value");
    }
  });

  it("fails closed when an account scope directory is a symbolic link", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-outside-"));
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    fs.mkdirSync(path.join(root, "accounts"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "accounts", scope));
    const store = new AccountMemoryStore(root);

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "batch-symlink",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "project-safe", category: "projects", value: "安全项目。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    })).toThrow("memory_scope_unsafe");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects an atomic batch that would exceed the account entry budget", () => {
    const store = makeStore();
    const mutations = Array.from({ length: 201 }, (_, index) => ({
      op: "add" as const,
      id: `project-budget-${index}`,
      category: "projects" as const,
      value: `项目 ${index}`,
      evidenceEntryIds: ["entry-1"],
      confidence: 1,
    }));

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "batch-over-budget",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations,
    })).toThrow("memory_budget_exceeded");
    expect(store.read("bot-a@im.bot").entries).toEqual([]);
  });

  it("writes private account files without temporary leftovers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-private-"));
    const store = new AccountMemoryStore(root);
    store.apply("bot-a@im.bot", {
      batchId: "batch-private",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "decision-private", category: "decisions", value: "采用账户级记忆。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    });
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const directory = path.join(root, "accounts", scope);

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, "MEMORY.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(directory, "memory.sqlite")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory).sort()).toEqual(["MEMORY.md", "memory.sqlite"]);
  });

  it("uses SQLite as authority and repairs a missing Markdown projection on read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-sqlite-"));
    const store = new AccountMemoryStore(root);
    store.apply("bot-a@im.bot", {
      batchId: "batch-sqlite",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{
        op: "add", id: "preference-sqlite", category: "preferences",
        value: "使用 SQLite 保存记忆。", evidenceEntryIds: ["entry-1"], confidence: 1,
      }],
    });
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const directory = path.join(root, "accounts", scope);
    fs.unlinkSync(path.join(directory, "MEMORY.md"));

    expect(store.read("bot-a@im.bot")).toMatchObject({
      revision: 1,
      entries: [{ id: "preference-sqlite" }],
    });
    expect(fs.readFileSync(path.join(directory, "MEMORY.md"), "utf8")).toContain("memory:id=preference-sqlite");
  });

  it("repairs a missing dated event projection from authoritative SQLite on read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-event-sqlite-"));
    const store = new AccountMemoryStore(root, () => Date.parse("2026-08-16T12:00:00+08:00"));
    store.apply("bot-a@im.bot", {
      batchId: "event-sqlite", basedOnRevision: 0,
      evidenceEntryIds: new Set(["meal-plan"]),
      mutations: [{ op: "event_add", id: "event-repair", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "准备去吃肉蟹煲。", evidenceEntryIds: ["meal-plan"], confidence: 1 }],
    });
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const eventPath = path.join(root, "accounts", scope, "events", "2026-08-17.md");
    fs.unlinkSync(eventPath);

    expect(store.read("bot-a@im.bot")).toMatchObject({ eventCount: 1, events: [{ id: "event-repair" }] });
    expect(fs.readFileSync(eventPath, "utf8")).toContain("event:id=event-repair");
  });

  it("imports the legacy metadata authority once without changing stable ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-legacy-"));
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const directory = path.join(root, "accounts", scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entries = [{
      id: "js-package-manager-pnpm", category: "preferences" as const,
      value: "JavaScript 项目使用 pnpm。", evidenceEntryIds: ["legacy-entry"], confidence: 1, updatedAt: 100,
    }];
    const markdown = renderMemory(entries);
    fs.writeFileSync(path.join(directory, "MEMORY.md"), markdown, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify({
      revision: 7, entries, receipts: {}, contentHash: crypto.createHash("sha256").update(markdown).digest("hex"),
    }), { mode: 0o600 });

    const snapshot = new AccountMemoryStore(root).read("bot-a@im.bot");

    expect(snapshot).toMatchObject({ revision: 7, entries: [{ id: "js-package-manager-pnpm" }] });
    expect(fs.existsSync(path.join(directory, "memory.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "metadata.json"))).toBe(false);
  });

  it("recovers a lock left by a process that no longer exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-stale-lock-"));
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    const directory = path.join(root, "accounts", scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "MEMORY.lock"), JSON.stringify({ pid: 2_147_483_647, createdAt: 1 }), { mode: 0o600 });
    const store = new AccountMemoryStore(root);

    expect(store.apply("bot-a@im.bot", {
      batchId: "batch-after-crash",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "project-recovered", category: "projects", value: "恢复后写入。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    })).toMatchObject({ status: "committed" });
    expect(fs.existsSync(path.join(directory, "MEMORY.lock"))).toBe(false);
  });

  it("rejects the same normalized fact under a different entry id", () => {
    const store = makeStore();
    store.apply("bot-a@im.bot", {
      batchId: "batch-original",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "preference-pnpm", category: "preferences", value: "JavaScript 项目使用 pnpm。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    });

    expect(() => store.apply("bot-a@im.bot", {
      batchId: "batch-duplicate",
      basedOnRevision: 1,
      evidenceEntryIds: new Set(["entry-2"]),
      mutations: [{ op: "add", id: "preference-pnpm-again", category: "preferences", value: " JavaScript项目使用pnpm ", evidenceEntryIds: ["entry-2"], confidence: 1 }],
    })).toThrow("memory_duplicate_value");
    expect(store.read("bot-a@im.bot").entries).toHaveLength(1);
  });
});
