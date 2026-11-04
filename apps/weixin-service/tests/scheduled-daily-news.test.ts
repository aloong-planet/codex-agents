// Public scheduler/import seam; transport/device acceptance remains a separate stage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { OwnerNotificationRoute } from "../src/notification-channel.js";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";
import type { DailyAiNewsState } from "../src/daily-ai-news-scheduler.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const trusted: TrustedWorkflowTurn = { accountId: "fixture", target: "recipient@im.wechat", eventKey: "query", occurredAt: 0, originalTextRef: "source", attachmentRefs: [] };
function call(service: ScheduledTasks, tool: string, args: Record<string, unknown>, eventKey = tool) {
  return service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...trusted, eventKey });
}
function legacyState(): DailyAiNewsState {
  return { version: 2, enabledTarget: { accountId: "fixture", target: "recipient@im.wechat", enabledAt: Date.parse("2026-10-01T00:00:00Z") },
    runs: [{ runKey: "2026-10-15", accountId: "fixture", target: "recipient@im.wechat", status: "context_refresh_required",
      createdAt: Date.parse("2026-10-15T00:30:00Z"), updatedAt: Date.parse("2026-10-15T00:31:00Z"),
      message: "原有完整日报\n 空格和换行保留。", sendFailureReason: "context_stale", providerRet: -14,
      deliveryContextUpdatedAt: Date.parse("2026-10-15T00:29:00Z") }], seenItemKeys: [], summarizedArticleKeys: [], preview: null };
}

it("imports the surviving legacy body once and exposes the same scoped news task after reopening", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = new DailyAiNewsFileStore(path.join(dir, "news.json")); legacy.save(legacyState());
  const options = { databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看 AI 新闻日报",
    dailyNewsImport: { state: legacy.load(), sourceHash: "source-1" } };
  const service = new ScheduledTasks(options); cleanups.push(() => service.close());
  const listed = await call(service, "list", {}) as { tasks: Array<{ id: string }> };
  expect(listed).toMatchObject({ total: 1, tasks: [{ name: "AI 新闻日报", template: "daily_ai_news", enabled: true,
    timezone: "Asia/Shanghai", nextExecutionAt: "2026-10-16T00:30:00.000Z" }] });
  const reference = listed.tasks[0]!.id;
  expect(await call(service, "inspect", { reference })).toMatchObject({ totalOccurrences: 1,
    history: [{ plannedAt: "2026-10-15T00:30:00.000Z", execution: "succeeded", body: "原有完整日报\n 空格和换行保留。",
      news: { originalStatus: "context_refresh_required", sendFailureReason: "context_stale", providerRet: -14 } }] });
  service.close(); const reopened = new ScheduledTasks(options); cleanups.push(() => reopened.close());
  expect(await call(reopened, "list", {})).toMatchObject({ total: 1, tasks: [{ id: reference }] });
  expect(await reopened.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, { ...trusted, target: "other@im.wechat" })).toMatchObject({ total: 0 });
});

it("migrates future news delivery while retaining the original cached occurrence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-dual-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState();
  let now = Date.parse("2026-10-16T00:00:00Z");
  const outbox: Array<{ accountId: string; message: string }> = [];
  const options = { databasePath: path.join(dir, "tasks.sqlite"), now: () => now, readOriginalText: () => "查看 AI 新闻日报",
    dailyNewsImport: { state, sourceHash: "source-dual" }, notificationRoute: new OwnerNotificationRoute({
      memoryAccountId: "fixture", scope: { accountId: "fixture", target: "recipient@im.wechat" },
      selected: { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" },
      destinations: [{ channel: "weixin", accountId: "fixture", target: "recipient@im.wechat" },
        { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" }],
    }), dailyNews: { researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: now, items: [] }) } },
    channel: { state: (address: { accountId: string }) => ({ enabled: address.accountId === "feishu.app", credentialStatus: "usable" as const,
      credentialGeneration: "ready", contextGeneration: "ready" }),
      send: async ({ accountId, message }: { accountId: string; message: string }) => { outbox.push({ accountId, message }); return { ok: true }; } },
  };
  let service = new ScheduledTasks(options); cleanups.push(() => service.close());
  const initial = await call(service, "inspect", { reference: "AI 新闻日报" }) as { task: { id: string }; history: unknown[] };
  expect(initial).toMatchObject({ task: { notificationDestination: { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" } },
    history: [{ body: "原有完整日报\n 空格和换行保留。", delivery: "pending_inbound", news: { originalStatus: "context_refresh_required" } }] });
  expect(initial.history[0]).not.toHaveProperty("deliveryDestination");
  service.setDailyNewsEnabled({ accountId: "fixture", target: "recipient@im.wechat" }, false);
  service.setDailyNewsEnabled({ accountId: "fixture", target: "recipient@im.wechat" }, true);
  service.close(); service = new ScheduledTasks(options); cleanups.push(() => service.close());
  now = Date.parse("2026-10-16T00:30:00Z"); await service.tick();
  expect(outbox).toEqual([{ accountId: "feishu.app", message: "2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。" }]);
  expect(await call(service, "inspect", { reference: initial.task.id })).toMatchObject({ totalOccurrences: 2,
    history: [{ delivery: "accepted", deliveryDestination: { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" } },
      { body: "原有完整日报\n 空格和换行保留。", delivery: "pending_inbound", news: { originalStatus: "context_refresh_required" } }] });
});

it("waits for context newer than the legacy failed submission and never replays historical terminal deliveries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState();
  for (const [index, outcome] of (["accepted", "partial", "rejected", "unknown", "sending"] as const).entries()) {
    state.runs.push({ runKey: `2026-10-0${index + 1}`, accountId: "fixture", target: "recipient@im.wechat", status: outcome,
      createdAt: Date.parse(`2026-10-0${index + 1}T00:30:00Z`), updatedAt: Date.parse(`2026-10-0${index + 1}T00:31:00Z`), message: `历史 ${outcome}` });
  }
  let contextGeneration = "original", contextUpdatedAt = Date.parse("2026-10-15T00:29:00Z");
  const outbox: string[] = [];
  const options = { databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看 AI 新闻日报",
    dailyNewsImport: { state, sourceHash: "source-terminals" },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable" as const, credentialGeneration: "binding", contextGeneration, contextUpdatedAt }),
      send: async ({ message }: { message: string }) => { outbox.push(message); return { ok: true }; } } };
  const service = new ScheduledTasks(options); cleanups.push(() => service.close());
  await service.tick();
  expect(outbox.filter((body) => body === "原有完整日报\n 空格和换行保留。")).toEqual([]);
  expect(await call(service, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { delivery: "context_refresh_required" } });
  contextGeneration = "new"; contextUpdatedAt = Date.parse("2026-10-16T00:00:01Z");
  await service.tick(); service.close();
  const reopened = new ScheduledTasks(options); cleanups.push(() => reopened.close()); await reopened.tick();
  expect(outbox).toEqual(["原有完整日报\n 空格和换行保留。"]);
});

it("runs the specialised news generator at its due time and stores a complete report before channel recovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:00:00Z"), generations = 0, archives = 0;
  const state = legacyState(); state.runs = [];
  const options = { databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看 AI 新闻日报",
    dailyNewsImport: { state, sourceHash: "source-generation" }, dailyNews: {
      researcher: { generate: async () => { generations++; return { date: "2026-10-16", generatedAt: clock, items: [
        { title: "工具更新", source: "官方", summary: "新版本增加审查功能。", brief: "新版本增加审查功能。", url: "https://example.com/news", publishedAt: "2026-10-16T00:00:00Z" }] }; } },
      archive: { archive: async () => { archives++; } },
    } };
  const service = new ScheduledTasks(options); cleanups.push(() => service.close());
  clock = Date.parse("2026-10-16T00:30:00Z"); await service.tick();
  expect(await call(service, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ history: [{ execution: "succeeded", delivery: "pending_inbound",
    body: "2026-10-16 AI 新闻\n\nAI 新闻\n\n1. 工具更新\n新版本增加审查功能。\n来源：官方" }] });
  expect(generations).toBe(1); expect(archives).toBe(1);
});

it("keeps a deliverable during archive failure and retries only archiving after ten minutes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:00:00Z"), generations = 0, archives = 0;
  const state = legacyState(); state.runs = [];
  const options = { databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看 AI 新闻日报",
    dailyNewsImport: { state, sourceHash: "source-archive" }, dailyNews: {
      researcher: { generate: async () => { generations++; return { date: "2026-10-16", generatedAt: clock, items: [] }; } },
      archive: { archive: async () => { archives++; if (archives === 1) throw new Error("archive offline"); } },
    } };
  const service = new ScheduledTasks(options); cleanups.push(() => service.close());
  clock = Date.parse("2026-10-16T00:30:00Z"); await service.tick();
  expect(await call(service, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ history: [{ execution: "succeeded", bodyAvailable: true,
    news: { attempt: 1, archiveWork: { status: "pending", attempts: 1, errorCode: "archive_unavailable", nextRetryAt: Date.parse("2026-10-16T00:40:00Z") } } }] });
  clock = Date.parse("2026-10-16T00:39:59Z"); await service.tick(); expect(archives).toBe(1);
  clock += 1000; await service.tick();
  expect(await call(service, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ totalOccurrences: 1,
    task: { nextExecutionAt: "2026-10-17T00:30:00.000Z" }, history: [{ execution: "succeeded", news: { attempt: 1, archiveWork: { status: "succeeded", attempts: 2 } },
      body: "2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。" }] });
  expect(generations).toBe(1); expect(archives).toBe(2);
});

it("edits a paused news instruction through common management and freezes it for a manual occurrence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = [];
  const requests: Array<{ instruction?: string }> = [];
  const sourceText = "停用并修改日报，只分析开源模型，再立即执行一次";
  const options = { databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => sourceText,
    dailyNewsImport: { state, sourceHash: "source-edit" }, dailyNews: {
      researcher: { generate: async (request: { instruction?: string }) => { requests.push(request); return { date: "2026-10-16", generatedAt: 1, items: [] }; } },
    } };
  const service = new ScheduledTasks(options); cleanups.push(() => service.close());
  expect(await call(service, "disable", { reference: "AI 新闻日报", expectedRevision: 1, sourceText })).toMatchObject({ status: "disabled" });
  expect(await call(service, "edit", { reference: "AI 新闻日报", expectedRevision: 2, sourceText, instruction: "只分析开源模型" })).toMatchObject({ status: "updated", task: { enabled: false, instruction: "只分析开源模型" } });
  await call(service, "run_now", { reference: "AI 新闻日报", expectedRevision: 3, sourceText });
  await call(service, "edit", { reference: "AI 新闻日报", expectedRevision: 3, sourceText, instruction: "只分析评测方法" }, "edit-later");
  await service.tick();
  expect(requests).toMatchObject([{ instruction: "只分析开源模型" }]);
  expect(await call(service, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { enabled: false, instruction: "只分析评测方法" }, history: [{ revision: 3, execution: "succeeded" }] });
});

it("uses one stored identity for the existing news enable control and common task queries", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = []; state.enabledTarget = null;
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "停用 AI 新闻日报",
    dailyNewsImport: { state, sourceHash: "fresh" },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: null }), send: async () => ({ ok: true }) } });
  cleanups.push(() => tasks.close());
  const control = new ManagedDailyAiNews(tasks); await control.enable("fixture", "recipient@im.wechat");
  expect(await call(tasks, "list", {})).toMatchObject({ total: 1, tasks: [{ name: "AI 新闻日报", enabled: true, template: "daily_ai_news" }] });
  expect(control.getPublicState()).toMatchObject({ enabledTarget: { accountId: "fixture", target: "recipient@im.wechat" }, nextRunAt: Date.parse("2026-10-16T00:30:00Z") });
  await call(tasks, "disable", { reference: "AI 新闻日报", expectedRevision: 1, sourceText: "停用 AI 新闻日报" });
  expect(control.getPublicState()).toMatchObject({ enabledTarget: null, status: "disabled" });
  await control.enable("fixture", "recipient@im.wechat"); control.disable();
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { enabled: false, revision: 4, pauseGeneration: 2 } });
});

it("previews without sending, then submits only the explicitly selected saved preview through the common dispatcher", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = []; state.enabledTarget = null;
  let generations = 0;
  const outbox: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "preview" },
    dailyNews: { researcher: { generate: async () => { generations++; return { date: "2026-10-16", generatedAt: 1, items: [] }; } } },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close());
  const control = new ManagedDailyAiNews(tasks); await control.preview();
  expect(control.getPublicState()).toMatchObject({ previewMessage: "2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。", status: "ready" });
  expect(outbox).toEqual([]);
  await control.sendPreview("fixture", "recipient@im.wechat");
  expect(outbox).toEqual(["2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。"]);
  expect(generations).toBe(1);
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { enabled: false }, history: [{ kind: "manual", delivery: "accepted" }] });
});

it("keeps the original automatic retry time when explicitly retrying today's failed news through the legacy control", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:00:00Z"), attempts = 0;
  const state = legacyState(); state.runs = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "立即重试日报",
    dailyNewsImport: { state, sourceHash: "explicit-retry" }, dailyNews: { researcher: { generate: async () => { attempts++; throw new Error("Codex process exited"); } } } });
  cleanups.push(() => tasks.close()); const control = new ManagedDailyAiNews(tasks);
  clock = Date.parse("2026-10-16T00:30:00Z"); await tasks.tick();
  clock = Date.parse("2026-10-16T00:31:00Z"); await control.retryNow();
  expect(attempts).toBe(2);
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ totalOccurrences: 1,
    history: [{ execution: "failed", news: { attempt: 2, nextRetryAt: Date.parse("2026-10-16T00:40:00Z") } }] });
});


it("retains accepted article identities and completed archive metadata in the common owner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = [];
  let clock = Date.parse("2026-10-16T00:30:00Z"); const outbox: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "accepted-identities" },
    dailyNews: { researcher: { generate: async () => ({ date: new Date(clock).toISOString().slice(0, 10), generatedAt: clock, items: [
      { title: "工具更新", source: "官方", summary: "新版本增加审查功能。", brief: "新版本增加审查功能。", url: "https://example.com/news", publishedAt: "2026-10-16T00:00:00Z" }] }) },
      archive: { archive: async () => ({ summaryPath: "/vault/news.md", archived: [{}], skipped: [] }) } },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close()); await tasks.tick();
  expect(tasks.newsSnapshot().owner).toMatchObject({ archive: { summaryPath: "/vault/news.md", archivedCount: 1, skippedCount: 0, totalCount: 1 } });
  clock = Date.parse("2026-10-17T00:30:00Z"); await tasks.tick();
  expect(outbox.at(-1)).toBe("2026-10-17 AI 新闻\n今日暂无值得汇总的重大更新。");
});

it("does not backfill a research retry missed during intentional pause", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:30:00Z"), attempts = 0;
  const state = legacyState(); state.runs = []; const sourceText = "停用再启用 AI 新闻日报";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => sourceText,
    dailyNewsImport: { state, sourceHash: "pause-retry" }, dailyNews: { researcher: { generate: async () => { attempts++; throw new Error("Codex process exited"); } } } });
  cleanups.push(() => tasks.close()); await tasks.tick();
  await call(tasks, "disable", { reference: "AI 新闻日报", expectedRevision: 1, sourceText });
  clock = Date.parse("2026-10-16T00:45:00Z");
  await call(tasks, "enable", { reference: "AI 新闻日报", expectedRevision: 2, sourceText }); await tasks.tick();
  expect(attempts).toBe(1);
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { nextExecutionAt: "2026-10-17T00:30:00.000Z" } });
  expect(tasks.newsSnapshot().occurrences[0]?.news?.nextRetryAt).toBeUndefined();
});

it("does not automatically replay a rejected explicit preview after context recovery", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = []; state.enabledTarget = null;
  let contextGeneration = "old"; const outbox: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "manual-preview-failure" }, dailyNews: { researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: 1, items: [] }) } },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration }), send: async ({ message }) => { outbox.push(message); return { ok: false, reason: "context_stale", acceptedSegments: 0 }; } } });
  cleanups.push(() => tasks.close()); const control = new ManagedDailyAiNews(tasks);
  await control.preview(); await expect(control.sendPreview("fixture", "recipient@im.wechat")).rejects.toThrow();
  contextGeneration = "new"; await tasks.tick();
  expect(outbox.filter((body) => body.startsWith("2026-10-16 AI 新闻"))).toEqual(["2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。"]);
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ history: [{ delivery: "rejected" }] });
});

it("switches the legacy enable control to one recipient while retaining the old recipient cache paused", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outbox: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { state: legacyState(), sourceHash: "switch-recipient" },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "fresh", contextUpdatedAt: Date.parse("2026-10-16T00:00:00Z") }),
      send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close()); const control = new ManagedDailyAiNews(tasks);
  await control.enable("fixture", "new-recipient@im.wechat"); await tasks.tick();
  expect(tasks.newsSnapshot().tasks.filter((task) => task.enabled).map((task) => task.destination.target)).toEqual(["new-recipient@im.wechat"]);
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { enabled: false }, history: [{ body: "原有完整日报\n 空格和换行保留。" }] });
  expect(outbox).toEqual([]);
});

it("rejects a manual news run while its preview is generating", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  const state = legacyState(); state.runs = []; const sourceText = "现在执行一次 AI 新闻日报";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => sourceText,
    dailyNewsImport: { state, sourceHash: "preview-busy" }, dailyNews: { researcher: { generate: async () => { await pending; return { date: "2026-10-16", generatedAt: 1, items: [] }; } } } });
  cleanups.push(() => tasks.close()); const preview = tasks.previewDailyNews();
  try { expect(await call(tasks, "run_now", { reference: "AI 新闻日报", expectedRevision: 1, sourceText })).toMatchObject({ status: "busy", code: "task_busy" }); }
  finally { finish(); await preview; }
});

it("sends the report once and keeps archive failures out of execution failure notifications", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:30:00Z"); const outbox: string[] = [];
  const state = legacyState(); state.runs = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "archive-notice" },
    dailyNews: { researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: 1, items: [] }) }, archive: { archive: async () => { throw new Error("vault offline"); } } },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close()); await tasks.tick(); clock += 600_000; await tasks.tick();
  expect(outbox).toEqual(["2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。"]);
  expect(tasks.newsSnapshot().occurrences[0]).toMatchObject({ execution: "succeeded", delivery: "accepted", news: { attempt: 1, archiveWork: { status: "pending", attempts: 2, nextRetryAt: Date.parse("2026-10-16T01:10:00Z") } } });
});

it("does not report a preview successful after its owner closes during archive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let finish!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; }), entered = new Promise<void>((resolve) => { started = resolve; });
  const state = legacyState(); state.runs = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "preview-close" }, dailyNews: { researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: 1, items: [] }) },
      archive: { archive: async () => { started(); await pending; } } } });
  cleanups.push(() => tasks.close()); const preview = tasks.previewDailyNews(); await entered; tasks.close(); finish();
  await expect(preview).rejects.toThrow();
});

it("admits older due tasks before an explicit news retry under the shared execution limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:30:00Z"), newsAttempts = 0;
  const state = legacyState(); state.runs = []; const sourceText = "创建研究任务并立即重试日报";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => sourceText,
    dailyNewsImport: { state, sourceHash: "retry-fairness" }, research: async () => "研究完成。",
    dailyNews: { researcher: { generate: async () => { newsAttempts++; throw new Error("Codex process exited"); } } } });
  cleanups.push(() => tasks.close()); await tasks.tick();
  for (const name of ["较早研究一", "较早研究二"]) await call(tasks, "create", { name, template: "researched_text", instruction: "研究公开资料", at: "2026-10-16T00:31:00Z", sourceText }, name);
  clock = Date.parse("2026-10-16T00:32:00Z");
  expect(await call(tasks, "retry_news", { reference: "AI 新闻日报", expectedRevision: 1, sourceText })).toMatchObject({ status: "blocked", code: "execution_capacity" });
  await tasks.tick(); expect(newsAttempts).toBe(1);
  expect(await call(tasks, "inspect", { reference: "较早研究一" })).toMatchObject({ history: [{ execution: "succeeded" }] });
  expect(await call(tasks, "inspect", { reference: "较早研究二" })).toMatchObject({ history: [{ execution: "succeeded" }] });
});

it("keeps the existing local recovery notification with cached count and current action", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = []; const local: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:30:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "local-recovery-notice" },
    dailyNews: { researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: 1, items: [] }) }, notifyLocal: (_title: string, body: string) => { local.push(body); } },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: null }), send: async () => ({ ok: true }) } });
  cleanups.push(() => tasks.close()); await tasks.tick(); await tasks.tick();
  expect(local).toHaveLength(1); expect(local[0]).toContain("已缓存 1 份日报，最早为 2026-10-16"); expect(local[0]).toContain("请从原微信会话发送消息");
});

it("retains today's retryable failed news beyond 31 newer completed manual runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:30:00Z"), attempts = 0; const outbox: string[] = [];
  const state = legacyState(); state.runs = []; const sourceText = "现在执行一次 AI 新闻日报";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => sourceText,
    dailyNewsImport: { state, sourceHash: "protected-retry" }, dailyNews: { researcher: { generate: async () => {
      if (++attempts === 1) throw new Error("Codex process exited"); return { date: "2026-10-16", generatedAt: clock, items: [] };
    } } }, channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close()); await tasks.tick();
  for (let index = 0; index < 32; index++) {
    clock += 1000;
    expect(await call(tasks, "run_now", { reference: "AI 新闻日报", expectedRevision: 1, sourceText }, `manual-${index}`)).toMatchObject({ status: "started" });
    await tasks.tick();
  }
  expect(tasks.newsSnapshot().occurrences.find((item) => item.kind === "automatic")).toMatchObject({ execution: "failed", news: { nextRetryAt: Date.parse("2026-10-16T00:40:00Z") } });
  clock = Date.parse("2026-10-16T00:40:00Z"); await tasks.tick();
  expect(outbox.filter((message) => message.startsWith("2026-10-16 AI 新闻"))).toHaveLength(33);
});

it("projects only today's active retries and clears a deleted news retry", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:30:00Z"); const state = legacyState(); state.runs = []; const sourceText = "删除 AI 新闻日报，保留历史";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => sourceText,
    dailyNewsImport: { state, sourceHash: "retry-projection" }, dailyNews: { researcher: { generate: async () => { throw new Error("Codex process exited"); } } } });
  cleanups.push(() => tasks.close()); const control = new ManagedDailyAiNews(tasks); await tasks.tick();
  expect(control.getPublicState().nextRunAt).toBe(Date.parse("2026-10-16T00:40:00Z"));
  clock = Date.parse("2026-10-17T00:00:00Z");
  expect(control.getPublicState().nextRunAt).toBe(Date.parse("2026-10-17T00:30:00Z"));
  expect((await call(tasks, "inspect", { reference: "AI 新闻日报" }) as { history: Array<{ recoveryAction: string }> }).history[0]?.recoveryAction).toContain("历史日报");
  expect(await call(tasks, "delete", { reference: "AI 新闻日报", expectedRevision: 1, sourceText })).toMatchObject({ status: "deleted" });
  expect(tasks.newsSnapshot().occurrences[0]?.news?.nextRetryAt).toBeUndefined();
});

it("shows a ready preview for an enabled task and refuses to submit its stale preview during regeneration", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = legacyState(); state.runs = []; let generation = 0, finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; }); const outbox: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "enabled-preview" }, dailyNews: { researcher: { generate: async () => {
      if (++generation === 2) await wait; return { date: "2026-10-16", generatedAt: 1, items: [] };
    } } }, channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close()); const control = new ManagedDailyAiNews(tasks); await control.preview();
  expect(control.getPublicState().status).toBe("ready");
  const preview = control.preview();
  try { await expect(control.sendPreview("fixture", "recipient@im.wechat")).rejects.toThrow("task_busy"); expect(outbox).toEqual([]); }
  finally { finish(); await preview; }
});

it("projects and disables the active common news task after management switches away from the legacy selection", async () => {
  const { ManagedDailyAiNews } = await import("../src/managed-daily-ai-news.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceText = "停用再启用 AI 新闻日报";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => sourceText,
    dailyNewsImport: { state: legacyState(), sourceHash: "selection" },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: null }), send: async () => ({ ok: true }) } });
  cleanups.push(() => tasks.close()); const control = new ManagedDailyAiNews(tasks);
  await control.enable("fixture", "new-recipient@im.wechat");
  expect(await tasks.execute({ toolId: "schedules.disable", toolVersion: 1, arguments: { reference: "AI 新闻日报", expectedRevision: 1, sourceText } }, { ...trusted, target: "new-recipient@im.wechat" })).toMatchObject({ status: "disabled" });
  expect(await call(tasks, "enable", { reference: "AI 新闻日报", expectedRevision: 2, sourceText })).toMatchObject({ status: "enabled" });
  expect(control.getPublicState().enabledTarget).toEqual({ accountId: "fixture", target: "recipient@im.wechat" });
  control.disable(); expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { enabled: false } });
});

it("drains cached news and a later reminder in planned order through the same recipient dispatcher", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:00:00Z"), fresh = false; const outbox: string[] = [];
  const sourceText = "一分钟后提醒我活动一下";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => sourceText,
    dailyNewsImport: { state: legacyState(), sourceHash: "mixed-order" },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: fresh ? "fresh" : null,
      ...(fresh ? { contextUpdatedAt: clock } : {}) }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  cleanups.push(() => tasks.close());
  expect(await call(tasks, "create", { name: "活动提醒", instruction: "活动一下", reminderText: "你应该活动一下了。", reminderMode: "natural", at: "2026-10-16T08:01:00+08:00", sourceText })).toMatchObject({ status: "created" });
  clock += 60000; await tasks.tick(); expect(outbox).toEqual([]);
  fresh = true; await tasks.tick();
  expect(outbox).toEqual(["原有完整日报\n 空格和换行保留。", "你应该活动一下了。"]);
});

it("reports reconciliation pending before a news identity exists without blocking known generic tasks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceText = "查看并停用 AI 新闻日报";
  const tasks = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => Date.parse("2026-10-16T00:00:00Z"), readOriginalText: () => sourceText, dailyNewsActive: () => false });
  cleanups.push(() => tasks.close());
  expect(await call(tasks, "list", {})).toMatchObject({ status: "ok", total: 0, reconciliation: { code: "daily_news_reconciliation_pending" } });
  expect(await call(tasks, "inspect", { reference: "AI 新闻日报" })).toMatchObject({ status: "blocked", code: "daily_news_reconciliation_pending" });
  expect(await call(tasks, "disable", { reference: "AI 新闻日报", expectedRevision: 1, sourceText })).toMatchObject({ status: "blocked", code: "daily_news_reconciliation_pending" });
  expect(await call(tasks, "create", { name: "活动提醒", instruction: "活动一下", reminderText: "你应该活动一下了。", reminderMode: "natural", at: "2026-10-16T08:01:00+08:00", sourceText })).toMatchObject({ status: "created" });
  expect(await call(tasks, "inspect", { reference: "活动提醒" })).toMatchObject({ status: "ok", task: { name: "活动提醒" } });
});

it("does not let unavailable news ownership block ordinary reminders when archiving is configured", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-owner-archive-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:00:00Z");
  const sourceText = "一分钟后提醒我活动一下";
  const tasks = new ScheduledTasks({ databasePath: path.join(directory, "tasks.sqlite"), now: () => clock, readOriginalText: () => sourceText,
    dailyNewsActive: () => false, dailyNews: { researcher: { generate: async () => { throw new Error("must not research"); } }, archive: { archive: async () => { throw new Error("must not archive"); } } } });
  cleanups.push(() => tasks.close());
  await call(tasks, "create", { name: "活动提醒", instruction: "活动一下", reminderText: "你应该活动一下了。", reminderMode: "natural", at: "2026-10-16T08:01:00+08:00", sourceText });
  clock += 60_000;
  await tasks.tick();
  expect(await call(tasks, "inspect", { reference: "活动提醒" })).toMatchObject({ history: [{ execution: "succeeded", body: "你应该活动一下了。" }] });
});

it("bounds a stuck archive attempt and ignores its late completion after a newer attempt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "news-archive-deadline-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:30:00Z"), finish!: () => void, calls = 0;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const state = legacyState(); state.runs = [];
  const service = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "archive-timeout" }, dailyNews: { archiveTimeoutMs: 20,
      researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: clock, items: [] }) },
      archive: { archive: async () => { if (++calls === 1) await blocked; } } } });
  cleanups.push(() => service.close());
  const first = service.tick();
  const guard = setTimeout(finish, 200);
  try {
    await first;
    expect(service.newsSnapshot().occurrences[0]?.news?.archiveWork).toMatchObject({ status: "pending", attempts: 1 });
    clock += 600_000; await service.tick(); finish(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.newsSnapshot().occurrences[0]?.news?.archiveWork).toEqual({ status: "succeeded", attempts: 2 });
  } finally { clearTimeout(guard); finish(); }
});

it("retains each pending preview archive and exhausts only that snapshot's bounded retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "news-preview-archive-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-16T00:00:00Z"), generations = 0;
  const archived: string[] = [];
  const state = legacyState(); state.runs = []; state.enabledTarget = null;
  const service = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
    dailyNewsImport: { state, sourceHash: "preview-queue" }, dailyNews: {
      researcher: { generate: async () => ({ date: "2026-10-16", generatedAt: clock, items: [{ title: `snapshot-${++generations}`, source: "研究", url: `https://example.com/${generations}`, publishedAt: "2026-10-16T00:00:00Z", summary: "完整观点。", brief: "完整观点。" }] }) },
      archive: { archive: async (digest) => { archived.push(digest.items[0]!.title); if (digest.items[0]!.title === "snapshot-1") throw new Error("archive unavailable");
        return { summaryPath: "news/latest.md", archived: [], skipped: [] }; } } } });
  cleanups.push(() => service.close());
  await service.previewDailyNews(); await service.previewDailyNews();
  for (const minutes of [10, 30, 60, 60]) { clock += minutes * 60_000; await service.tick(); }
  expect(archived).toEqual(["snapshot-1", "snapshot-2", "snapshot-1", "snapshot-1", "snapshot-1"]);
  expect(service.newsSnapshot().owner?.previewArchives?.map((job) => job.work)).toEqual([
    { status: "failed", attempts: 4, errorCode: "archive_unavailable" }, { status: "succeeded", attempts: 1 }]);
  expect(service.newsSnapshot().owner?.archive?.summaryPath).toBe("news/latest.md");
  expect(generations).toBe(2);
});
