import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";
import { CodexAccountMemoryCurator } from "../src/codex-account-memory-curator.js";
import {
  AccountMemorySystem,
  type AccountMemoryCurator,
  type MemoryCurationInput,
} from "../src/account-memory-system.js";

describe("AccountMemorySystem", () => {
  it("starts embedding migration for an enabled account and exposes its public status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-embedding-status-"));
    const prepare = vi.fn(async () => {});
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => ({ status: "noop" as const }), close: () => {} },
      statePath: path.join(root, "memory-jobs.json"),
      search: {
        search: async () => [],
        prepare,
        getStatus: () => ({
          state: "building" as const,
          activeModel: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
          candidateModel: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
          indexedEntries: 2,
          totalEntries: 3,
          generation: 0,
        }),
      },
    });

    system.enable("bot-a@im.bot");
    await system.start();

    await vi.waitFor(() => expect(prepare).toHaveBeenCalledWith("bot-a@im.bot"));
    expect(system.getPublicState().accounts[0]?.embedding).toMatchObject({
      state: "building",
      indexedEntries: 2,
      totalEntries: 3,
    });
    system.close();
  });

  it("enables a newly discovered account by default while preserving an explicit disable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-default-enabled-"));
    const statePath = path.join(root, "memory-jobs.json");
    const createSystem = () => new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => ({ status: "noop" as const }), close: () => {} },
      statePath,
    });
    const first = createSystem();
    first.registerAccount("bot-a@im.bot");
    expect(first.getPublicState().accounts).toEqual([
      expect.objectContaining({ accountId: "bot-a@im.bot", enabled: true, status: "idle" }),
    ]);
    first.disable("bot-a@im.bot");
    expect(first.getPublicState().accounts[0]).toMatchObject({ enabled: false, status: "disabled" });
    first.close();

    const restored = createSystem();
    restored.registerAccount("bot-a@im.bot");
    expect(restored.getPublicState().accounts[0]).toMatchObject({ enabled: false, status: "disabled" });
    restored.enable("bot-a@im.bot");
    expect(restored.getPublicState().accounts[0]).toMatchObject({ enabled: true, status: "idle" });
    restored.close();
  });

  it("migrates a known but disabled v4 account without silently enabling it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-v4-disabled-"));
    const statePath = path.join(root, "memory-jobs.json");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 4,
      knownAccounts: ["enabled@im.bot", "disabled@im.bot"],
      enabledAccounts: ["enabled@im.bot"],
      collected: {},
      jobs: [],
    }));
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => ({ status: "noop" as const }), close: () => {} },
      statePath,
    });

    system.registerAccount("disabled@im.bot");
    system.registerAccount("new@im.bot");

    expect(system.getPublicState().accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "disabled@im.bot", enabled: false }),
      expect.objectContaining({ accountId: "new@im.bot", enabled: true }),
    ]));
    system.close();
  });

  it("starts the plan monitor for enabled accounts and binds only an explicitly confirmed target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-reminders-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const monitor = {
      start: vi.fn<(accountIds: () => string[]) => void>(),
      runNow: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      statePath: path.join(root, "memory-jobs.json"),
      reminderMonitor: monitor,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    expect(monitor.start).toHaveBeenCalledOnce();
    expect(monitor.start.mock.calls[0]?.[0]()).toEqual(["bot-a@im.bot"]);
    expect(store.notificationTarget("bot-a@im.bot")).toBeUndefined();

    system.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat");
    expect(store.notificationTarget("bot-a@im.bot")).toBe("owner@im.wechat");
    expect(system.getPublicState().accounts[0]?.planFollowUp.reminderTarget).toBe("owner@im.wechat");
    expect(monitor.runNow).toHaveBeenCalledWith(["bot-a@im.bot"]);
    await system.close();
    expect(monitor.close).toHaveBeenCalledOnce();
  });

  it("finishes short low-information turns as noop without starting the Curator", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-short-noop-"));
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async () => ({ status: "noop" as const })),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    for (const [id, text] of [["ack", "好的"], ["ack-punctuation", "好。"], ["emoji", "👍🏻"], ["punctuation", "？！"]] as const) {
      await expect(system.captureTurn({
        accountId: "bot-a@im.bot",
        userEntry: { id, text, createdAt: 100 },
      })).resolves.toMatchObject({ queued: true });
    }

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.pendingCount).toBe(0));
    expect(curator.curate).not.toHaveBeenCalled();
    expect(system.getPublicState().accounts[0]?.status).toBe("idle");
    system.close();
  });

  it.each(["去上海", "爱咖啡"])("finishes every text of at most three graphemes as noop: %s", async (text) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-short-meaningful-"));
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async () => ({ status: "noop" as const })),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: `meaningful-${text}`, text, createdAt: 100 },
    });

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.pendingCount).toBe(0));
    expect(curator.curate).not.toHaveBeenCalled();
    system.close();
  });

  it("still reviews a four-grapheme text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-four-graphemes-"));
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async () => ({ status: "noop" as const })),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "four-graphemes", text: "pnpm", createdAt: 100 },
    });

    await vi.waitFor(() => expect(curator.curate).toHaveBeenCalledTimes(1));
    system.close();
  });

  it("passes only bounded search candidates to the Curator instead of the full memory snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-candidates-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const entries = Array.from({ length: 25 }, (_, index) => ({
      op: "add" as const,
      id: `entry-${String(index).padStart(2, "0")}`,
      category: "preferences" as const,
      value: `候选偏好 ${index}`,
      evidenceEntryIds: ["seed"],
      confidence: 1,
    }));
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]), mutations: entries,
    });
    const inputs: MemoryCurationInput[] = [];
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async (input) => { inputs.push(input); return { status: "noop" }; }, close: () => {} },
      search: { search: async () => [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `missing-${index}`, rank: index + 1, score: 1, source: "semantic" as const,
        })),
        ...entries.map((entry, index) => ({
          id: entry.id, rank: index + 6, score: 1 - index / 100, source: "semantic" as const,
        })),
      ] },
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "candidate-query", text: "我偏好候选方案", createdAt: 100 },
    });

    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]).toMatchObject({
      candidateEntries: entries.slice(0, 20).map((entry) => ({ id: entry.id, value: entry.value })),
    });
    expect(inputs[0]).not.toHaveProperty("memory");
    expect(inputs[0]).not.toHaveProperty("snapshot");
    system.close();
  });

  it("passes a query-relevant existing plan to the Curator even when its date is outside the default window", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-plan-candidates-"));
    const now = Date.parse("2026-08-17T12:00:00+08:00");
    const store = new AccountMemoryStore(path.join(root, "memory"), () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{
        op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-09-01",
        timezone: "Asia/Shanghai", summary: "晚上去看电影。", evidenceEntryIds: ["seed"], confidence: 1,
      }],
    });
    const inputs: MemoryCurationInput[] = [];
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async (input) => { inputs.push(input); return { status: "noop" }; }, close: () => {} },
      statePath: path.join(root, "memory-jobs.json"), now: () => now,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "change-plan", text: "我改变计划，今晚去看电影《牛来》", createdAt: now },
    });

    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]?.candidateEvents).toEqual([
      expect.objectContaining({ id: "movie-plan", eventKind: "planned", localDate: "2026-09-01" }),
    ]);
    system.close();
  });

  it("passes the latest accepted reminder ordinal context to the Curator for a reply", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-reminder-reply-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(path.join(root, "memory"), () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "昨晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 10);
    const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", [{ message: "提醒", planIds: ["movie-plan"] }], now - 5);
    store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, now - 4);
    store.finishReminderSegment("bot-a@im.bot", batch.id, 0, "accepted", now - 3);
    expect(store.latestReminderContext("bot-a@im.bot", "owner@im.wechat")).toBeDefined();
    const inputs: MemoryCurationInput[] = [];
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async (input) => { inputs.push(input); return { status: "noop" }; }, close: () => {} },
      statePath: path.join(root, "memory-jobs.json"), now: () => now,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot", target: "owner@im.wechat",
      userEntry: { id: "reply", text: "1 没有完成", createdAt: now },
    });

    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]).toMatchObject({
      reminderContext: { batchId: batch.id, plans: [{ ordinal: 1, planId: "movie-plan", summary: "昨晚看电影。" }] },
      candidateEvents: [expect.objectContaining({ id: "movie-plan" })],
    });
    system.close();
  });

  it("reviews a three-grapheme reply when an accepted reminder is awaiting a response", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-reminder-short-reply-"));
    const now = Date.parse("2026-08-21T20:20:00+08:00");
    const store = new AccountMemoryStore(path.join(root, "memory"), () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-18", timezone: "Asia/Shanghai", summary: "计划晚上去看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 10);
    const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", [{ message: "提醒", planIds: ["movie-plan"] }], now - 5);
    store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, now - 4);
    store.finishReminderSegment("bot-a@im.bot", batch.id, 0, "accepted", now - 3);
    expect(store.latestReminderContext("bot-a@im.bot", "owner@im.wechat")).toBeDefined();
    const curator = new CodexAccountMemoryCurator({
      startOrResume: async () => "thread-reminder-short-reply",
      reply: async (_threadId, input) => {
        const payload = JSON.parse(String(input)) as { batchId: string; basedOnRevision: number; turns: Array<{ userEntry: { id: string } }> };
        return JSON.stringify({
          basedOnRevision: payload.basedOnRevision,
          batchId: payload.batchId,
          decisions: [{
            kind: "resolve_reminder", match: null, outcome: "occurred", summary: "看过了电影。",
            evidenceEntryIds: [payload.turns[0]!.userEntry.id], confidence: 1,
          }],
        });
      },
      close: () => {},
    }, new AccountMemoryToolHost(store), root);
    const system = new AccountMemorySystem({
      store, curator,
      statePath: path.join(root, "memory-jobs.json"), now: () => now,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot", target: "owner@im.wechat",
      userEntry: { id: "reply", text: "看过了", createdAt: now },
    });

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.pendingCount).toBe(0));
    expect(store.read("bot-a@im.bot").events.find((event) => event.id === "movie-plan")?.planStatus).toBe("occurred");
    expect(store.latestReminderContext("bot-a@im.bot", "owner@im.wechat")).toBeUndefined();
    system.close();
  });

  it("reconciles a numbered reminder reply through Curator into the stable plan", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-reminder-e2e-"));
    const now = Date.parse("2026-08-18T12:05:00+08:00");
    const store = new AccountMemoryStore(path.join(root, "memory"), () => now);
    store.apply("bot-a@im.bot", {
      batchId: "seed-plan", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "event_add", id: "movie-plan", eventKind: "planned", localDate: "2026-08-17", timezone: "Asia/Shanghai", summary: "昨晚看电影。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    store.confirmNotificationTarget("bot-a@im.bot", "owner@im.wechat", now - 10);
    const batch = store.createReminderBatch("bot-a@im.bot", "owner@im.wechat", [{ message: "提醒", planIds: ["movie-plan"] }], now - 5);
    store.markReminderSegmentSending("bot-a@im.bot", batch.id, 0, now - 4);
    store.finishReminderSegment("bot-a@im.bot", batch.id, 0, "accepted", now - 3);
    const curator = new CodexAccountMemoryCurator({
      startOrResume: async () => "thread-reminder",
      reply: async (_threadId, input) => {
        const payload = JSON.parse(String(input)) as { batchId: string; basedOnRevision: number; turns: Array<{ userEntry: { id: string } }> };
        return JSON.stringify({
          basedOnRevision: payload.basedOnRevision, batchId: payload.batchId,
          decisions: [{ kind: "set_plan_outcome", match: "1", status: "unfulfilled", evidenceEntryIds: [payload.turns[0]!.userEntry.id] }],
        });
      },
      close: () => {},
    }, new AccountMemoryToolHost(store), root);
    const system = new AccountMemorySystem({ store, curator, statePath: path.join(root, "memory-jobs.json"), now: () => now });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({ accountId: "bot-a@im.bot", target: "owner@im.wechat", userEntry: { id: "reply", text: "1 没有完成", createdAt: now } });

    await vi.waitFor(() => expect(store.read("bot-a@im.bot").events[0]?.planStatus).toBe("unfulfilled"));
    expect(store.latestReminderContext("bot-a@im.bot", "owner@im.wechat")).toBeUndefined();
    system.close();
  });

  it("recalls the bounded event window and adds query-relevant older events without exposing the full archive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-event-recall-"));
    const now = Date.parse("2026-08-16T12:00:00+08:00");
    const store = new AccountMemoryStore(path.join(root, "memory"), () => now);
    store.apply("bot-a@im.bot", {
      batchId: "event-recall-seed", basedOnRevision: 0,
      evidenceEntryIds: new Set(["event-seed"]),
      mutations: [
        { op: "event_add", id: "event-old", eventKind: "observed", localDate: "2026-06-01", timezone: "Asia/Shanghai", summary: "在南京吃过盐水鸭。", evidenceEntryIds: ["event-seed"], confidence: 1 },
        { op: "event_add", id: "event-recent", eventKind: "observed", localDate: "2026-08-15", timezone: "Asia/Shanghai", summary: "吃了肉蟹煲。", evidenceEntryIds: ["event-seed"], confidence: 1 },
        { op: "event_add", id: "event-future-seven", eventKind: "planned", localDate: "2026-08-23", timezone: "Asia/Shanghai", summary: "去上海看展。", evidenceEntryIds: ["event-seed"], confidence: 1 },
        { op: "event_add", id: "event-future-eight", eventKind: "planned", localDate: "2026-08-24", timezone: "Asia/Shanghai", summary: "整理旧照片。", evidenceEntryIds: ["event-seed"], confidence: 1 },
      ],
    });
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      statePath: path.join(root, "memory-jobs.json"),
      now: () => now,
    });
    system.enable("bot-a@im.bot");

    expect(system.getPublicState().accounts[0]).toMatchObject({
      eventCount: 4,
      displayedEventCount: 2,
    });
    const panelEvents = system.getPublicState().accounts[0]?.events ?? "";
    expect(panelEvents).toContain("吃了肉蟹煲");
    expect(panelEvents).toContain("去上海看展");
    expect(panelEvents).not.toContain("event:id=");
    expect(panelEvents).not.toContain("event-recent");
    expect(panelEvents).not.toContain("盐水鸭");
    expect(panelEvents).not.toContain("整理旧照片");

    const recalled = system.recall("bot-a@im.bot", "我以前在南京吃过什么？盐水鸭相关");
    expect(recalled).toContain("盐水鸭");
    expect(recalled).toContain("吃了肉蟹煲");
    expect(recalled).not.toContain("整理旧照片");
    system.close();
  });

  it("updates a stable id end-to-end when an ordinary turn revises a durable decision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-triggerless-e2e-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed-entry"]),
      mutations: [{
        op: "add", id: "js-package-manager-pnpm", category: "preferences",
        value: "所有 JavaScript 项目统一使用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1,
      }],
    });
    const tools = new AccountMemoryToolHost(store);
    const agent = {
      startOrResume: vi.fn(async () => "curator-thread"),
      reply: vi.fn(async (_threadId: string, prompt: unknown) => {
        const batchId = typeof prompt === "string"
          ? (JSON.parse(prompt) as { batchId?: unknown }).batchId
          : undefined;
        if (!batchId) throw new Error("missing batch id");
        return JSON.stringify({
          basedOnRevision: 1, batchId,
          decisions: [{
            kind: "revise", match: "JavaScript 项目使用 pnpm",
            value: "只在 Node.js 项目使用 pnpm", evidenceEntryIds: ["user-triggerless"], confidence: 1,
          }],
        });
      }),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store,
      curator: new CodexAccountMemoryCurator(agent, tools, "/workspace"),
      statePath: path.join(root, "memory-jobs.json"),
      now: () => 1_000,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    const queued = await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-triggerless", text: "只在 Node.js 项目使用 pnpm", createdAt: 100 },
    });

    expect(queued.queued).toBe(true);
    await vi.waitFor(() => expect(store.read("bot-a@im.bot").entries[0]?.value).toBe("只在 Node.js 项目使用 pnpm"));
    expect(store.read("bot-a@im.bot").entries).toEqual([
      expect.objectContaining({ id: "js-package-manager-pnpm", value: "只在 Node.js 项目使用 pnpm" }),
    ]);
    system.close();
  });

  it("resolves an explicit correction to the existing stable id before invoking the Curator", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-correction-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    store.apply("bot-a@im.bot", {
      batchId: "seed",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["seed-entry"]),
      mutations: [{
        op: "add", id: "js-package-manager-pnpm", category: "preferences",
        value: "所有 JavaScript 项目统一使用 pnpm。", evidenceEntryIds: ["seed-entry"], confidence: 1,
      }],
    });
    const inputs: MemoryCurationInput[] = [];
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async (input) => { inputs.push(input); return { status: "noop" }; }, close: () => {} },
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    const result = await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-correction", text: "改成只在 Node.js 项目使用 pnpm", createdAt: 100 },
    });

    expect(result.queued).toBe(true);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]).toMatchObject({
      trigger: "explicit_correction",
      mutationPolicy: {
        mode: "single_update",
        targetId: "js-package-manager-pnpm",
        replacement: "只在 Node.js 项目使用 pnpm",
        evidenceEntryId: "user-correction",
      },
      candidateEntries: [expect.objectContaining({ id: "js-package-manager-pnpm" })],
    });
    system.close();
  });

  it("finishes a missing correction as clarification without calling the Curator", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-clarification-"));
    const curator: AccountMemoryCurator = { curate: vi.fn(async () => ({ status: "noop" as const })), close: () => {} };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-missing", text: "更新记忆中的默认编辑器为 Zed", createdAt: 100 },
    });

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.status).toBe("needs_clarification"));
    expect(curator.curate).not.toHaveBeenCalled();
    expect(system.getPublicState().accounts[0]).toMatchObject({
      clarificationReason: "target_missing",
      pendingCount: 0,
    });
    system.close();
  });

  it("queues an ordinary completed turn for automatic review without treating code-update wording as an explicit correction", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-code-update-"));
    const curator: AccountMemoryCurator = { curate: vi.fn(async () => ({ status: "noop" as const })), close: () => {} };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")), curator,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    const result = await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "code-update", text: "帮我更新这段代码并运行测试", createdAt: 100 },
    });

    expect(result.queued).toBe(true);
    await vi.waitFor(() => expect(curator.curate).toHaveBeenCalledTimes(1));
    expect(curator.curate).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "automatic",
      mutationPolicy: { mode: "reconcile" },
      turns: [expect.objectContaining({ userEntry: expect.objectContaining({ id: "code-update" }) })],
    }));
    system.close();
  });

  it("times out unavailable semantic search and safely asks for clarification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-search-timeout-"));
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: vi.fn(async () => ({ status: "noop" as const })), close: () => {} },
      search: { search: () => new Promise(() => {}) },
      searchTimeoutMs: 1,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "search-timeout", text: "更新记忆中的默认编辑器为 Zed", createdAt: 100 },
    });

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]).toMatchObject({
      status: "needs_clarification", clarificationReason: "target_missing",
    }));
    system.close();
  });

  it("persists a no-retry clarification returned by automatic reconciliation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-automatic-clarification-"));
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async () => ({
        status: "needs_clarification" as const,
        reason: "target_ambiguous" as const,
        candidateIds: ["pnpm-demo", "pnpm-global"],
      })),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")), curator,
      statePath: path.join(root, "memory-jobs.json"), retryDelaysMs: [0],
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "automatic-ambiguous", text: "只在 Node.js 项目使用 pnpm", createdAt: 100 },
    });

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.status).toBe("needs_clarification"));
    expect(system.getPublicState().accounts[0]).toMatchObject({
      pendingCount: 0,
      clarificationReason: "target_ambiguous",
      candidateIds: ["pnpm-demo", "pnpm-global"],
    });
    expect(curator.curate).toHaveBeenCalledTimes(1);
    system.close();
  });

  it("manually retries only the latest dead-letter memory job with its original evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-manual-retry-"));
    const statePath = path.join(root, "memory-jobs.json");
    const now = Date.parse("2026-08-17T23:20:00+08:00");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 4,
      knownAccounts: ["bot-a@im.bot"],
      enabledAccounts: ["bot-a@im.bot"],
      collected: { "bot-a@im.bot": [] },
      jobs: [
        {
          id: "older", batchId: "older-batch", accountId: "bot-a@im.bot", status: "dead_letter",
          trigger: "automatic", turns: [{ userEntry: { id: "older-entry", text: "旧失败", createdAt: now - 2 } }],
          attempt: 4, attemptDiagnostics: [], createdAt: now - 2, updatedAt: now - 2, error: "curator_unexpected_error",
        },
        {
          id: "latest", batchId: "latest-batch", accountId: "bot-a@im.bot", status: "dead_letter",
          trigger: "automatic", turns: [{ userEntry: { id: "latest-entry", text: "已经买了", createdAt: now - 1 } }],
          attempt: 4, attemptDiagnostics: [], createdAt: now - 1, updatedAt: now - 1, error: "memory_event_evidence_invalid",
        },
      ],
    }));
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async () => ({ status: "noop" as const })), close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")), curator, statePath, now: () => now,
    });
    await system.start();

    expect(system.retryLatestFailed("bot-a@im.bot")).toBe(true);

    await vi.waitFor(() => expect(curator.curate).toHaveBeenCalledOnce());
    expect(curator.curate).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "latest", batchId: "latest-batch",
      turns: [{ userEntry: expect.objectContaining({ id: "latest-entry", text: "已经买了" }) }],
    }));
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { jobs: Array<{ id: string; status: string }> };
    expect(persisted.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "older", status: "dead_letter" }),
      expect.objectContaining({ id: "latest", status: "noop" }),
    ]));
    system.close();
  });

  it("queues changing-target turns as separate FIFO jobs while keeping account scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-system-"));
    const inputs: MemoryCurationInput[] = [];
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async (input) => { inputs.push(input); return { status: "noop" as const }; }),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath: path.join(root, "memory-jobs.json"),
      now: () => 1_000,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-1", text: "我在做项目 A", createdAt: 100 },
      assistantEntry: { id: "assistant-1", text: "收到", createdAt: 110, status: "accepted" },
    });
    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-2", text: "这个项目使用 pnpm", createdAt: 200 },
      assistantEntry: { id: "assistant-2", text: "明白", createdAt: 210, status: "accepted" },
    });

    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    expect(inputs.map((input) => ({ accountId: input.accountId, trigger: input.trigger, ids: input.turns.map((turn) => turn.userEntry.id) }))).toEqual([
      { accountId: "bot-a@im.bot", trigger: "automatic", ids: ["user-1"] },
      { accountId: "bot-a@im.bot", trigger: "automatic", ids: ["user-2"] },
    ]);
    expect(JSON.stringify(inputs)).not.toContain("target");
    expect(system.getPublicState()).toMatchObject({
      available: true,
      accounts: [{ accountId: "bot-a@im.bot", enabled: true, status: "idle", entryCount: 0 }],
    });
    system.disable("bot-a@im.bot");
    expect(system.getPublicState()).toMatchObject({
      accounts: [{ accountId: "bot-a@im.bot", enabled: false, status: "disabled" }],
    });
    expect(system.recall("bot-a@im.bot")).toBe("");
    system.close();
  });

  it("does not let a newer automatic job pass an active account job", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-fifo-"));
    const inputs: MemoryCurationInput[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async (input) => {
        inputs.push(input);
        if (input.turns[0]?.userEntry.id === "user-1") await firstBlocked;
        return { status: "noop" as const };
      }),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")), curator,
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({ accountId: "bot-a@im.bot", userEntry: { id: "user-1", text: "第一条消息", createdAt: 100 } });
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    await system.captureTurn({ accountId: "bot-a@im.bot", userEntry: { id: "user-2", text: "第二条消息", createdAt: 200 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inputs.map((input) => input.turns[0]?.userEntry.id)).toEqual(["user-1"]);

    releaseFirst();
    await vi.waitFor(() => expect(inputs.map((input) => input.turns[0]?.userEntry.id)).toEqual(["user-1", "user-2"]));
    system.close();
  });

  it("does not let a newer automatic job pass an older account retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-retry-fifo-"));
    const seen: string[] = [];
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async (input) => {
        const entryId = input.turns[0]?.userEntry.id ?? "missing";
        seen.push(entryId);
        if (entryId === "user-1") throw new Error("temporary");
        return { status: "noop" as const };
      }),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")), curator,
      statePath: path.join(root, "memory-jobs.json"),
      retryDelaysMs: [60_000],
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({ accountId: "bot-a@im.bot", userEntry: { id: "user-1", text: "第一条消息", createdAt: 100 } });
    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.status).toBe("failed"));
    await system.captureTurn({ accountId: "bot-a@im.bot", userEntry: { id: "user-2", text: "第二条消息", createdAt: 200 } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(seen).toEqual(["user-1"]);
    expect(system.getPublicState().accounts[0]?.pendingCount).toBe(2);
    system.close();
  });

  it("retains unfinished jobs when automatic history reaches its terminal-job cap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-job-retention-"));
    const statePath = path.join(root, "memory-jobs.json");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 3,
      knownAccounts: ["bot-a@im.bot"],
      enabledAccounts: ["bot-a@im.bot"],
      collected: { "bot-a@im.bot": [] },
      jobs: [
        {
          id: "retry-old", batchId: "retry-old-batch", accountId: "bot-a@im.bot",
          status: "retry_wait", trigger: "automatic", turns: [], attempt: 1,
          createdAt: 1, updatedAt: 1, nextAttemptAt: Date.now() + 60_000,
        },
        ...Array.from({ length: 199 }, (_, index) => ({
          id: `done-${index}`, batchId: `done-batch-${index}`, accountId: "bot-a@im.bot",
          status: "noop", trigger: "automatic", turns: [], attempt: 0,
          createdAt: index + 2, updatedAt: index + 2,
        })),
      ],
    }));
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      statePath,
    });

    const queued = await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "new-pending", text: "新的完成回合", createdAt: 500 },
    });

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { jobs: Array<{ id: string }> };
    expect(persisted.jobs).toHaveLength(200);
    expect(persisted.jobs.map((job) => job.id)).toContain("retry-old");
    expect(persisted.jobs.map((job) => job.id)).toContain(queued.jobId);
    system.close();
  });

  it("retains sanitized attempt diagnostics after a failed curation retry succeeds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-retry-"));
    const statePath = path.join(root, "memory-jobs.json");
    let attempts = 0;
    let now = 2_000;
    const curator: AccountMemoryCurator = {
      curate: vi.fn(async () => {
        attempts += 1;
        now += 250;
        if (attempts === 1) throw new Error("temporary local failure /Users/private token=secret");
        return { status: "noop" as const };
      }),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath,
      retryDelaysMs: [0],
      now: () => now,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-explicit", text: "请记住以后都使用 pnpm", createdAt: 200 },
    });

    await vi.waitFor(() => expect(curator.curate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.status).toBe("idle"));
    expect(system.getPublicState().accounts[0]?.lastError).toBeUndefined();
    expect(system.getPublicState().accounts[0]).toMatchObject({
      recentAttempts: [
        {
          attempt: 1,
          startedAt: 2_000,
          finishedAt: 2_250,
          durationMs: 250,
          stage: "curate",
          outcome: "failed",
          errorMessage: "记忆整理暂时失败，系统将自动重试。",
          retryScheduledAt: 2_250,
        },
        {
          attempt: 2,
          startedAt: 2_250,
          finishedAt: 2_500,
          durationMs: 250,
          stage: "curate",
          outcome: "noop",
        },
      ],
    });
    const persisted = fs.readFileSync(statePath, "utf8");
    expect(persisted).not.toContain("/Users/private");
    expect(persisted).not.toContain("token=secret");
    expect(JSON.parse(persisted)).toMatchObject({
      version: 5,
      jobs: [{ attemptDiagnostics: [{ errorCode: "curator_unexpected_error" }, { outcome: "noop" }] }],
    });
    system.close();
  });

  it("classifies a known Codex timeout without persisting the raw exception", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-timeout-diagnostic-"));
    const statePath = path.join(root, "memory-jobs.json");
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => { throw new Error("Codex App Server 请求超时：thread/start secret-detail"); }, close: () => {} },
      statePath,
      retryDelaysMs: [60_000],
      now: () => 3_000,
    });
    system.enable("bot-a@im.bot");
    await system.start();

    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "timeout-entry", text: "我喜欢安静的工作环境", createdAt: 100 },
    });

    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.status).toBe("failed"));
    expect(system.getPublicState().accounts[0]).toMatchObject({
      lastError: "记忆整理服务响应超时，系统将自动重试。",
      nextAttemptAt: 63_000,
      recentAttempts: [expect.objectContaining({
        stage: "curate",
        outcome: "failed",
        errorMessage: "记忆整理服务响应超时，系统将自动重试。",
      })],
    });
    expect(system.getPublicState().accounts[0]?.recentAttempts[0]).not.toHaveProperty("errorCode");
    expect(fs.readFileSync(statePath, "utf8")).not.toContain("secret-detail");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
      jobs: [{ attemptDiagnostics: [{ errorCode: "codex_timeout" }] }],
    });
    system.close();
  });

  it("repairs a damaged Markdown projection from authoritative SQLite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-damaged-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    store.apply("bot-a@im.bot", {
      batchId: "seed",
      basedOnRevision: 0,
      evidenceEntryIds: new Set(["entry-1"]),
      mutations: [{ op: "add", id: "project-safe", category: "projects", value: "安全项目。", evidenceEntryIds: ["entry-1"], confidence: 1 }],
    });
    const system = new AccountMemorySystem({
      store,
      curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      statePath: path.join(root, "memory-jobs.json"),
    });
    system.enable("bot-a@im.bot");
    const scope = crypto.createHash("sha256").update("bot-a@im.bot").digest("hex");
    fs.writeFileSync(path.join(root, "memory", "accounts", scope, "MEMORY.md"), "tampered\n");

    expect(system.getPublicState()).toMatchObject({
      accounts: [{ accountId: "bot-a@im.bot", status: "idle", memory: expect.stringContaining("memory:id=project-safe") }],
    });
    expect(fs.readFileSync(path.join(root, "memory", "accounts", scope, "MEMORY.md"), "utf8"))
      .toContain("memory:id=project-safe");
    system.close();
  });

  it("cancels active curation and pauses its job when the account is disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-disable-"));
    let rejectCuration!: (error: Error) => void;
    let curationCalls = 0;
    const curator: AccountMemoryCurator = {
      curate: vi.fn(() => {
        curationCalls += 1;
        if (curationCalls === 1) return new Promise<never>((_resolve, reject) => { rejectCuration = reject; });
        if (curationCalls === 2) return Promise.reject(new Error("temporary after resume"));
        return Promise.resolve({ status: "noop" as const });
      }),
      cancelAccount: vi.fn(() => rejectCuration(new Error("cancelled"))),
      close: vi.fn(),
    };
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator,
      statePath: path.join(root, "memory-jobs.json"),
      retryDelaysMs: [0],
    });
    system.enable("bot-a@im.bot");
    await system.start();
    await system.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "user-1", text: "请记住使用 pnpm", createdAt: 100 },
    });
    await vi.waitFor(() => expect(curator.curate).toHaveBeenCalledTimes(1));

    system.disable("bot-a@im.bot");

    await vi.waitFor(() => expect(curator.cancelAccount).toHaveBeenCalledWith("bot-a@im.bot"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(curator.curate).toHaveBeenCalledTimes(1);
    expect(system.getPublicState().accounts[0]).toMatchObject({ enabled: false, status: "disabled", pendingCount: 1 });

    system.enable("bot-a@im.bot");
    await vi.waitFor(() => expect(system.getPublicState().accounts[0]?.status).toBe("idle"));
    expect(curator.curate).toHaveBeenCalledTimes(3);
    expect(system.getPublicState().accounts[0]?.recentAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    system.close();
  });

  it("removes dead-letter conversation bodies after seven days", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-retention-"));
    const statePath = path.join(root, "memory-jobs.json");
    let now = 1_000;
    const first = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => { throw new Error("permanent"); }, close: () => {} },
      statePath,
      retryDelaysMs: [],
      now: () => now,
    });
    first.enable("bot-a@im.bot");
    await first.start();
    await first.captureTurn({
      accountId: "bot-a@im.bot",
      userEntry: { id: "private-entry", text: "请记住这段私密正文", createdAt: now },
    });
    await vi.waitFor(() => expect(first.getPublicState().accounts[0]?.status).toBe("failed"));
    first.close();

    now += 8 * 24 * 60 * 60 * 1_000;
    const second = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      statePath,
      now: () => now,
    });
    await second.start();

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { jobs: Array<{ turns: unknown[] }> };
    expect(persisted.jobs[0]?.turns).toEqual([]);
    second.close();
  });

  it("migrates version-2 collected turns into one automatic FIFO job", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-v2-migration-"));
    const statePath = path.join(root, "memory-jobs.json");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      knownAccounts: ["bot-a@im.bot"],
      enabledAccounts: ["bot-a@im.bot"],
      collected: {
        "bot-a@im.bot": [
          { userEntry: { id: "legacy-1", text: "第一条决定", createdAt: 100 } },
          { userEntry: { id: "legacy-2", text: "第二条决定", createdAt: 200 } },
        ],
      },
      jobs: [],
    }));
    const inputs: MemoryCurationInput[] = [];
    const system = new AccountMemorySystem({
      store: new AccountMemoryStore(path.join(root, "memory")),
      curator: { curate: async (input) => { inputs.push(input); return { status: "noop" }; }, close: () => {} },
      statePath,
      now: () => 1_000,
    });

    await system.start();

    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]).toMatchObject({
      trigger: "automatic",
      turns: [
        { userEntry: { id: "legacy-1" } },
        { userEntry: { id: "legacy-2" } },
      ],
    });
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      version: number;
      collected: Record<string, unknown[]>;
      jobs: Array<{ attemptDiagnostics: Array<{ outcome: string }> }>;
    };
    expect(persisted.version).toBe(5);
    expect(persisted.collected["bot-a@im.bot"]).toEqual([]);
    expect(persisted.jobs[0]?.attemptDiagnostics).toEqual([expect.objectContaining({ outcome: "noop" })]);
    system.close();
  });
});
