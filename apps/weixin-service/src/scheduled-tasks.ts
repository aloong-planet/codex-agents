import type { ManagedTaskMemorySource } from "./account-memory-tool-host.js";
import { NewsArticleStore } from "./news-article-store.js";
import { generateDailyNews, DailyNewsExecutionError, DailyNewsPersistenceError } from "./scheduled-daily-news.js";
import { formatNewsDigest, retryAtFor, FAILURE_REASON_LABELS, type AiNewsResearcher, type DailyAiNewsState, type NewsDigestArchive, type NewsDigest } from "./daily-ai-news-scheduler.js";
import { articleKey } from "./news-article-identity.js";
import { importedDailyNews, dailyNewsTaskId, DAILY_NEWS_INSTRUCTION, newsDate, type ScheduledNewsOwner, type DailyNewsImport, type ScheduledNewsMetadata, type NewsArchiveWork } from "./daily-news-import.js";
import type { LocalDiagnostics } from "./local-diagnostics.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryReminderAdmission, OwnedReminderIntent, ReminderIntent } from "./reminder-intent-ownership.js";
import type { SendTextResult } from "./channel-contract.js";
import type { NotificationAddress, NotificationDestination, NotificationChannel, NotificationChannelState, OwnerNotificationRoute } from "./notification-channel.js";
import type { TrustedWorkflowTurn, WorkflowToolRequest } from "./workflow-tool-host.js";
import { SCHEDULE_TOOL_MEMBERS } from "./scheduled-task-tools.js";
import { nextInstant, latestInstant, type Schedule } from "./scheduled-time.js";
import { WorkflowToolCatalog } from "./workflow-tool-catalog.js";

const catalog = new WorkflowToolCatalog(SCHEDULE_TOOL_MEMBERS);

type Destination = NotificationAddress;
export type ScheduledTask = {
  template?: "reminder" | "researched_text" | "daily_ai_news";
  historyComplete?: true;
  id: string; name: string; instruction: string; reminderText?: string; reminderMode?: "natural" | "verbatim"; timezone: string; enabled: boolean;
  destination: Destination; notificationDestination?: NotificationDestination; nextExecutionAt: string | null; revision: number;
  schedule: Schedule; cadenceRevision?: number; createdAt: number; pauseGeneration?: number; deletedAt?: number; automaticClaimed?: boolean; historyIssue?: ScheduledOccurrence;
  blocker?: { code: string; usage: CapacityUsage; limits: ScheduledTaskLimits; action: string };
};
export type ScheduledChannelState = NotificationChannelState;
export type ScheduledChannel = NotificationChannel;
export type ScheduledTaskLimits = { maxBodyBytes: number; recipientPendingCount: number; recipientPendingBytes: number; globalPendingCount: number; globalPendingBytes: number; minimumRecurringSeconds: number };
export type ScheduledTasksOptions = {
  dailyNewsActive?: () => boolean;
  dailyNewsImport?: DailyNewsImport;
  dailyNews?: { researcher: AiNewsResearcher; archive?: NewsDigestArchive; archiveTimeoutMs?: number; notifyLocal?: (title: string, body: string) => void };
  channel?: ScheduledChannel;
  notificationRoute?: OwnerNotificationRoute;
  renderReminder?: (task: Readonly<ScheduledTask>) => Promise<string>;
  diagnostics?: LocalDiagnostics;
  research?: (input: { destination?: NotificationAddress; name: string; instruction: string; timezone: string; plannedAt: string; signal: AbortSignal }) => Promise<string>;
  researchTimeoutMs?: number;
  limits?: Partial<ScheduledTaskLimits>;
  historyRetention?: { maxAgeMs?: number; maxBytes?: number };
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number;
  clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void;
  onError?: (error: unknown) => void;
  databasePath: string; now?: () => number;
  readOriginalText(ref: string): string | undefined;
};

export type ScheduledOccurrence = {
  id: string; taskId: string; revision: number; plannedAt: string; destination: Destination;
  deliveryDestination?: NotificationDestination;
  execution: "running" | "succeeded" | "failed" | "unknown" | "skipped";
  skippedRange?: { from: string; through: string; cadenceRevision: number };
  delivery: "not_generated" | "pending_inbound" | "ready" | "sending" | "accepted" | "partial" | "rejected" | "unknown" | "auth_relogin_required" | "context_refresh_required" | "cancelled";
  kind?: "automatic" | "manual"; manualPauseGeneration?: number; claimedAt?: number;
  stage?: "research";
  news?: ScheduledNewsMetadata;
  body?: string; reason?: string; worker: string; reservedBytes?: number;
  detailsEligibleAt?: number; detailsClearedAt?: number; detailsClearReason?: "age" | "capacity"; originalBodyBytes?: number;
  attempts?: Array<{ id: string; pauseGeneration?: number; context: ScheduledChannelState; result: ScheduledOccurrence["delivery"]; parts: Array<{ message: string; characters?: number; result?: SendTextResult }> }>;

};
type CapacityUsage = { recipientCount: number; recipientBytes: number; globalCount: number; globalBytes: number };
type ScheduledNotification = {
  id: string; taskId: string; occurrenceId?: string; destination: Destination; deliveryDestination?: NotificationDestination; stage: "execution" | "research" | "archive" | "delivery" | "admission";
  code: string; action: string; message: string; delivery: "pending" | "sending" | "accepted" | "rejected" | "unknown" | "suppressed";
  worker?: string; pauseGeneration?: number; context?: ScheduledChannelState; result?: SendTextResult;
};
type ArchiveClaim = { id: string; digest: NewsDigest; scope: string; work: NewsArchiveWork; occurrence?: ScheduledOccurrence };
type JsonRow = { json: string };

export class ScheduledTasks {
  private readonly database: DatabaseSync;
  private readonly articles: NewsArticleStore;
  private closed = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | number | undefined;
  private unsubscribe: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private wakeRequested = false;
  private resumePump: (() => void) | undefined;
  private previewController: AbortController | undefined;
  private readonly researchControllers = new Map<string, { controller: AbortController; occurrence: ScheduledOccurrence }>();
  private readonly executionQueue: Array<{ task: ScheduledTask; occurrence: ScheduledOccurrence }> = [];
  private readonly worker = crypto.randomUUID();
  private readonly limits: ScheduledTaskLimits;
  private readonly historyRetention: { maxAgeMs: number; maxBytes: number };

  constructor(private readonly options: ScheduledTasksOptions) {
    this.historyRetention = { maxAgeMs: 90 * 86_400_000, maxBytes: 100 * 1024 * 1024, ...options.historyRetention };
    if (Object.values(this.historyRetention).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("scheduled_history_retention_invalid");
    this.limits = { maxBodyBytes: 65_536, recipientPendingCount: 100, recipientPendingBytes: 10 * 1024 * 1024,
      globalPendingCount: 1000, globalPendingBytes: 100 * 1024 * 1024, minimumRecurringSeconds: 60, ...options.limits };
    if (options.researchTimeoutMs !== undefined && (!Number.isSafeInteger(options.researchTimeoutMs) || options.researchTimeoutMs < 1)) throw new Error("research_timeout_invalid");
    if (Object.values(this.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) throw new Error("scheduled_limits_invalid");
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(options.databasePath);
    fs.chmodSync(options.databasePath, 0o600);
    this.database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS reminder_intent (id TEXT PRIMARY KEY, account TEXT NOT NULL, target TEXT NOT NULL, event_key TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_task (id TEXT PRIMARY KEY, account TEXT NOT NULL, target TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_occurrence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scheduled_history_order ON scheduled_occurrence(task_id, json_extract(json, '$.plannedAt') DESC, id DESC);
      CREATE TABLE IF NOT EXISTS scheduled_blocker (recipient TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_notification (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scheduled_notice_history ON scheduled_notification(json_extract(json, '$.taskId'), id);
      CREATE TABLE IF NOT EXISTS scheduled_fenced_worker (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS scheduled_worker (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_news_barrier (recipient TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_news_owner (id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_operation (id TEXT PRIMARY KEY, hash TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_schedule_operation (request_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(request_id, operation_id));
    `);
    this.articles = new NewsArticleStore(this.database);
    try {
      if (options.dailyNewsImport) this.importNews(options.dailyNewsImport);
      this.migrateNotificationPreferences();
    } catch (error) { this.database.close(); throw error; }
    this.database.prepare("INSERT INTO scheduled_worker VALUES (?, ?)").run(this.worker, this.now() + 60_000);
  }

  memoryContext(accountId: string, targets: string[]): ManagedTaskMemorySource[] {
    if (this.closed || targets.length === 0) return [];
    if (this.options.notificationRoute) {
      const scope = this.options.notificationRoute.memoryScope(accountId, targets);
      if (!scope) return [];
      accountId = scope.accountId; targets = [scope.target];
    }
    // Identity-only context never becomes a second copy of task settings. Deleted tasks retain ownership.
    return this.tasks().filter((task) => task.destination.accountId === accountId && targets.includes(task.destination.target))
      .slice(0, 100).map((task) => ({ id: task.id, name: task.name, revision: task.revision, template: task.template ?? "reminder" }));
  }

  newsSnapshot() {
    this.reconcilePending();
    const row = this.database.prepare("SELECT json, source_hash FROM scheduled_news_owner WHERE id = 'daily-news'").get() as (JsonRow & { source_hash: string }) | undefined;
    const owner = row ? JSON.parse(row.json) as ScheduledNewsOwner : undefined;
    const tasks = this.tasks().filter((task) => task.template === "daily_ai_news");
    return { owner, now: this.now(), sourceHash: row?.source_hash, active: this.options.dailyNewsActive?.() ?? true, tasks: tasks.map((task) => ({ ...task, recoveryAction: this.taskOccurrence(task) ? this.recoveryAction(this.taskOccurrence(task)!) : undefined })),
      occurrences: this.occurrences().filter((item) => tasks.some((task) => task.id === item.taskId)) };
  }

  reconcileDailyNews(source: DailyNewsImport): void { this.importNews(source); this.migrateNotificationPreferences(); }

  setDailyNewsEnabled(destination: Destination, enabled: boolean): void {
    if (this.options.dailyNewsActive && !this.options.dailyNewsActive()) throw new Error("daily_news_reconciliation_pending");
    this.transaction(() => {
      const row = this.database.prepare("SELECT json FROM scheduled_news_owner WHERE id = 'daily-news'").get() as JsonRow | undefined;
      if (!row) throw new Error("daily_news_reconciliation_pending");
      const state = this.scopeState(destination);
      if (enabled && (!state?.enabled || state.credentialStatus !== "usable")) throw new Error("微信账户不可用于日报发送");
      const id = dailyNewsTaskId(destination);
      let task = this.tasks(destination).find((item) => item.id === id);
      if (task?.deletedAt !== undefined) throw new Error("task_deleted");
      if (!task) {
        if (!enabled) return;
        task = importedDailyNews({ version: 2, enabledTarget: { ...destination, enabledAt: this.now() },
          runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null }, this.now()).tasks[0]!;
        task.historyComplete = true;
        if (this.options.notificationRoute?.capturesCreationDestination) task.notificationDestination = this.options.notificationRoute.resolve(destination)!;
        this.database.prepare("INSERT INTO scheduled_task VALUES (?, ?, ?, ?)").run(task.id, destination.accountId, destination.target, JSON.stringify(task));
      } else {
        const updated = { ...task, enabled, revision: task.revision + 1,
          pauseGeneration: (task.pauseGeneration ?? 0) + (enabled ? 0 : 1) };
        if (enabled && !task.enabled && task.schedule.kind !== "once") updated.nextExecutionAt = nextInstant(task.schedule, this.now(), task.timezone);
        this.saveTask(updated);
      }
      if (!enabled) this.stopNewsRetries(task);
      if (enabled) for (const previous of this.tasks()) {
        if (previous.template !== "daily_ai_news" || previous.id === task.id || !previous.enabled) continue;
        this.saveTask({ ...previous, enabled: false, revision: previous.revision + 1, pauseGeneration: (previous.pauseGeneration ?? 0) + 1 });
        this.stopNewsRetries(previous);
      }
      const owner = JSON.parse(row.json) as { state: DailyAiNewsState };
      owner.state.enabledTarget = enabled ? { ...destination, enabledAt: this.now() } : null;
      this.database.prepare("UPDATE scheduled_news_owner SET json = ? WHERE id = 'daily-news'").run(JSON.stringify(owner));
    });
    if (this.started) this.wake();
  }

  private stopNewsRetries(task: ScheduledTask): void {
    if (task.template !== "daily_ai_news") return;
    for (const item of this.occurrences()) if (item.taskId === task.id && item.news?.nextRetryAt !== undefined) {
      delete item.news.nextRetryAt; this.saveOccurrence(item);
    }
  }

  private newsOwner(): ScheduledNewsOwner {
    if (this.options.dailyNewsActive && !this.options.dailyNewsActive()) throw new Error("daily_news_reconciliation_pending");
    const row = this.database.prepare("SELECT json FROM scheduled_news_owner WHERE id = 'daily-news'").get() as JsonRow | undefined;
    if (!row) throw new Error("daily_news_reconciliation_pending");
    return JSON.parse(row.json) as ScheduledNewsOwner;
  }

  private saveNewsOwner(owner: ScheduledNewsOwner): void {
    this.database.prepare("UPDATE scheduled_news_owner SET json = ? WHERE id = 'daily-news'").run(JSON.stringify(owner));
  }

  private activeGenerations(): number {
    const row = this.database.prepare("SELECT json FROM scheduled_news_owner WHERE id = 'daily-news'").get() as JsonRow | undefined;
    const preview = row ? (JSON.parse(row.json) as ScheduledNewsOwner).previewWork?.status === "running" : false;
    return this.occurrences().filter((item) => item.execution === "running").length + (preview ? 1 : 0);
  }

  async previewDailyNews(): Promise<void> {
    this.reconcileWorkers();
    const owner = this.transaction(() => {
      if (!this.renewWorker()) throw new Error("worker_fenced");
      const current = this.newsOwner();
      if (!this.options.dailyNews) throw new Error("research_unavailable");
      if (current.previewWork?.status === "running" || this.occurrences().some((item) => item.execution === "running" && this.tasks().some((task) => task.id === item.taskId && task.template === "daily_ai_news"))) throw new Error("日报任务正在运行，请稍后重试");
      if (this.activeGenerations() >= 2) throw new Error("execution_capacity");
      current.previewWork = { worker: this.worker, status: "running" }; current.previewReady = false;
      this.saveNewsOwner(current); return current;
    });
    const controller = new AbortController(); this.previewController = controller;
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      try { if (!this.transaction(() => this.renewWorker())) controller.abort(); }
      catch (error) { heartbeatError = error; controller.abort(); }
    }, 10_000); heartbeat.unref();
    try {
      const result = await generateDailyNews({ ...this.options.dailyNews!, state: owner.state, deferArchive: true, date: newsDate(this.now()), now: this.now(),
        instruction: DAILY_NEWS_INSTRUCTION, previewOnly: true, signal: controller.signal,
        articles: this.articles.processor(owner.state.enabledTarget ? dailyNewsTaskId(owner.state.enabledTarget) : "preview", () => !this.closed && this.workerActive() && this.newsOwner().previewWork?.status === "running" && this.newsOwner().previewWork?.worker === this.worker, controller.signal),
        saveDigest: (generated) => {
          if (this.closed || !this.workerActive()) throw new DailyNewsPersistenceError("worker_fenced");
          try { this.transaction(() => {
            const current = this.newsOwner();
            if (current.previewWork?.status !== "running" || current.previewWork.worker !== this.worker) throw new Error("worker_fenced");
            current.state.preview = generated; current.state.previewInstruction = DAILY_NEWS_INSTRUCTION;
            current.state.summarizedArticleKeys = [...new Set([...current.state.summarizedArticleKeys, ...generated.items.map((item) => articleKey(item.url))])].slice(-100_000);
            this.saveNewsOwner(current);
          }); } catch (error) { throw new DailyNewsPersistenceError(error instanceof Error ? error.message : "daily_news_store_failed"); }
        } });
      if (heartbeatError) throw heartbeatError;
      if (this.closed || !this.workerActive()) throw new Error("worker_fenced");
      this.transaction(() => {
        const current = this.newsOwner();
        if (current.previewWork?.status !== "running" || current.previewWork.worker !== this.worker) return;
        current.state.preview = result.digest; current.previewReady = true; current.previewWork.status = "succeeded";
        if (this.options.dailyNews?.archive) {
          const pending = (current.previewArchives ?? []).filter((job) => ["pending", "running"].includes(job.work.status));
          const terminal = (current.previewArchives ?? []).filter((job) => !["pending", "running"].includes(job.work.status)).slice(-30);
          current.previewArchives = [...pending, ...terminal, { id: `preview-${crypto.randomUUID()}`, digest: result.digest,
            scope: owner.state.enabledTarget ? dailyNewsTaskId(owner.state.enabledTarget) : "preview",
            work: pending.length >= 200 ? { status: "failed", attempts: 0, errorCode: "archive_capacity" } : { status: "pending", attempts: 0 } }];
        }
        if (result.archive) current.archive = result.archive;
        this.saveNewsOwner(current);
      });
      await this.tick();
      if (this.closed) throw new Error("worker_fenced");
    } catch (error) {
      if (!this.closed && this.workerActive()) this.transaction(() => {
        const current = this.newsOwner();
        if (current.previewWork?.status === "running" && current.previewWork.worker === this.worker) {
          current.previewWork.status = "failed"; this.saveNewsOwner(current);
        }
      });
      throw error;
    } finally { clearInterval(heartbeat); this.previewController = undefined; if (this.started && !this.closed) this.wake(); }
  }

  async sendDailyNewsPreview(destination: Destination): Promise<void> {
    const id = this.transaction(() => {
      if (!this.renewWorker()) throw new Error("worker_fenced");
      const owner = this.newsOwner(), digest = owner.state.preview;
      if (owner.previewWork?.status === "running") throw new Error("task_busy");
      if (!digest) throw new Error("请先生成 AI 新闻预览");
      const channel = this.scopeState(destination);
      if (!channel?.enabled || channel.credentialStatus !== "usable") throw new Error("微信账户不可用于日报发送");
      const taskId = dailyNewsTaskId(destination);
      let task = this.tasks(destination).find((item) => item.id === taskId);
      if (task?.deletedAt !== undefined) throw new Error("task_deleted");
      if (!task) {
        task = importedDailyNews({ version: 2, enabledTarget: { ...destination, enabledAt: this.now() }, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null }, this.now()).tasks[0]!;
        task.enabled = false; task.historyComplete = true;
        if (this.options.notificationRoute?.capturesCreationDestination) task.notificationDestination = this.options.notificationRoute.resolve(destination)!;
        this.database.prepare("INSERT INTO scheduled_task VALUES (?, ?, ?, ?)").run(task.id, destination.accountId, destination.target, JSON.stringify(task));
      }
      if (this.occurrences().some((item) => item.taskId === taskId && (item.execution === "running" || item.delivery === "sending"))) throw new Error("task_busy");
      const body = formatNewsDigest(digest), bytes = Buffer.byteLength(body, "utf8");
      const usage = this.capacity(destination), limits = this.limits;
      if (bytes > limits.maxBodyBytes || usage.recipientCount + 1 > limits.recipientPendingCount || usage.recipientBytes + bytes > limits.recipientPendingBytes ||
        usage.globalCount + 1 > limits.globalPendingCount || usage.globalBytes + bytes > limits.globalPendingBytes) throw new Error("pending_capacity");
      const occurrence: ScheduledOccurrence = { id: `${taskId}:preview:${crypto.randomUUID()}`, taskId, revision: task.revision,
        destination, plannedAt: new Date(this.now()).toISOString(), claimedAt: this.now(), kind: "manual", manualPauseGeneration: task.pauseGeneration ?? 0,
        execution: "succeeded", delivery: "pending_inbound", worker: this.worker, body, news: { runKey: `manual-${this.now()}`, digest, oneShotPreview: true } };
      this.insertOccurrence(occurrence);
      owner.previewReady = false; this.saveNewsOwner(owner); return occurrence.id;
    });
    await this.tick();
    const settled = this.transaction(() => {
      const current = this.occurrences().find((item) => item.id === id)!;
      if (isPending(current)) {
        current.delivery = "rejected"; current.reason = "preview_submission_unavailable"; this.saveOccurrence(current);
      }
      return current;
    });
    if (settled.delivery !== "accepted") throw new Error(this.recoveryAction(settled));
  }

  private admitNewsRetry(task: ScheduledTask, admitted: Array<{ task: ScheduledTask; occurrence: ScheduledOccurrence }>): { task: ScheduledTask; occurrence: ScheduledOccurrence } {
    if (!this.renewWorker()) throw new Error("worker_fenced");
    if (task.template !== "daily_ai_news" || !task.enabled || task.deletedAt !== undefined) throw new Error("daily_news_retry_unavailable");
    if (this.newsOwner().previewWork?.status === "running" || this.occurrences().some((item) => item.taskId === task.id && (item.execution === "running" || item.delivery === "sending"))) throw new Error("task_busy");
    const failed = this.occurrences().find((item) => item.taskId === task.id && item.execution === "failed" &&
      item.news?.runKey === newsDate(this.now()) && ["research", "archive"].includes(item.news.failureStage ?? ""));
    if (!failed) throw new Error("daily_news_no_failed_run");
    if (this.options.channel && !this.deliveryState(failed).enabled) throw new Error("target_disabled");
    const before = { plannedAt: new Date(this.now()).toISOString(), taskId: task.id };
    while (true) {
      const earlier = this.claimAutomatic(new Set([task.id]), before);
      if (!earlier) break;
      admitted.push(earlier);
    }
    if (this.activeGenerations() >= 2) throw new Error("execution_capacity");
    const usage = this.capacity(task.destination), limits = this.limits;
    if (usage.recipientCount + 1 > limits.recipientPendingCount || usage.recipientBytes + limits.maxBodyBytes > limits.recipientPendingBytes ||
      usage.globalCount + 1 > limits.globalPendingCount || usage.globalBytes + limits.maxBodyBytes > limits.globalPendingBytes) throw new Error("pending_capacity");
    const occurrence: ScheduledOccurrence = { ...failed, execution: "running", delivery: "not_generated", worker: this.worker,
      claimedAt: this.now(), reservedBytes: limits.maxBodyBytes, news: { ...failed.news!, explicitRetry: failed.news?.nextRetryAt !== undefined ? { nextRetryAt: failed.news.nextRetryAt } : {} } };
    this.saveOccurrence(occurrence);
    return { task: { ...task, ...failed.news?.settings }, occurrence };
  }

  async retryDailyNews(destination: Destination): Promise<void> {
    const admitted: Array<{ task: ScheduledTask; occurrence: ScheduledOccurrence }> = [];
    const failure = this.transaction(() => {
      const task = this.tasks(destination).find((item) => item.id === dailyNewsTaskId(destination));
      if (!task) return new Error("daily_news_no_failed_run");
      try { admitted.push(this.admitNewsRetry(task, admitted)); return undefined; }
      catch (error) { return error; }
    });
    this.executionQueue.push(...admitted); await this.tick();
    if (failure) throw failure;
  }

  private importNews(source: DailyNewsImport): void {
    this.transaction(() => {
      const owner = this.database.prepare("SELECT source_hash FROM scheduled_news_owner WHERE id = 'daily-news'").get();
      if (owner) {
        if (owner.source_hash !== source.sourceHash) throw new Error("daily_news_import_conflict");
        return;
      }
      const imported = importedDailyNews(source.state, this.now());
      for (const task of imported.tasks) this.database.prepare("INSERT INTO scheduled_task VALUES (?, ?, ?, ?)")
        .run(task.id, task.destination.accountId, task.destination.target, JSON.stringify(task));
      for (const item of imported.occurrences) this.database.prepare("INSERT INTO scheduled_occurrence VALUES (?, ?, ?)")
        .run(item.id, item.taskId, JSON.stringify(item));
      for (const task of imported.tasks) {
        const runs = source.state.runs.filter((run) => run.accountId === task.destination.accountId && run.target === task.destination.target);
        const boundaries = runs.flatMap((run) => ["context_refresh_required", "auth_relogin_required"].includes(run.status)
          ? [run.deliveryContextUpdatedAt ?? run.updatedAt]
          : ["partial", "rejected", "unknown", "sending"].includes(run.status) && run.deliveryContextUpdatedAt !== undefined ? [run.deliveryContextUpdatedAt] : []);
        if (boundaries.length) this.database.prepare("INSERT INTO scheduled_news_barrier VALUES (?, ?)")
          .run(hash(task.destination), JSON.stringify({ after: Math.max(...boundaries), context: this.options.channel?.state(task.destination) ?? null }));
      }
      this.database.prepare("INSERT INTO scheduled_news_owner VALUES ('daily-news', ?, ?)")
        .run(source.sourceHash, JSON.stringify({ phase: "committed", importedAt: this.now(), state: source.state }));
    });
  }

  private newsReconciliation(scope: NotificationAddress) {
    if (scope.target.startsWith("feishu.group.")) return undefined;
    return this.options.dailyNewsActive && !this.options.dailyNewsActive()
      ? { status: "blocked", code: "daily_news_reconciliation_pending", action: "日报所有权交接待核对；列表暂不完整，不能据此认定原日报不存在。请完成交接后再操作日报。" } : undefined;
  }

  dispatchEvidence(requestId: string): number {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM dispatch_schedule_operation WHERE request_id = ?").get(requestId)!.count);
  }

  private recordOperation(key: string, requestHash: string, result: unknown, trusted: TrustedWorkflowTurn): void {
    this.database.prepare("INSERT INTO scheduled_operation VALUES (?, ?, ?)").run(key, requestHash, JSON.stringify(result));
    if (trusted.dispatchRequestId) this.database.prepare("INSERT INTO dispatch_schedule_operation VALUES (?, ?)").run(trusted.dispatchRequestId, key);
  }

  async execute(request: WorkflowToolRequest, trusted: TrustedWorkflowTurn): Promise<unknown> {
    if (this.closed) return { status: "error", code: "scheduler_closed" };
    if (!catalog.accepts(request.toolId, request.toolVersion, request.arguments)) {
      return { status: "error", code: "invalid_settings", fields: catalog.validationIssues(request.toolId, request.toolVersion, request.arguments) };
    }
    const queryDestination = { accountId: trusted.accountId, target: trusted.target };
    const creationDestination = this.options.notificationRoute?.capturesCreationDestination
      ? this.options.notificationRoute.capture(trusted) : undefined;
    if (this.options.notificationRoute) {
      const scope = this.options.notificationRoute.scopeFor(trusted);
      if (!scope) return { status: "error", code: "target_disabled" };
      trusted = { ...trusted, ...scope };
    }
    const args = request.arguments as Record<string, unknown>;
    this.reconcilePending();
    this.syncNotifications();
    if (request.toolId === "schedules.list") {
      return this.transaction(() => {
        const tasks = this.tasks(trusted).filter((task) => {
          const destination = task.notificationDestination ?? this.options.notificationRoute?.resolve(task.destination) ?? task.destination;
          return args.scope === "all_channels" || (destination.accountId === queryDestination.accountId && destination.target === queryDestination.target);
        }), view = String(args.view ?? "active");
        const completed = new Set(tasks.filter((task) => this.taskLifecycle(task) === "completed").map((task) => task.id));
        const selected = tasks.filter((task) => view === "all" || (view === "completed" ? completed.has(task.id) : task.deletedAt === undefined && !completed.has(task.id)));
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 25);
        return { status: "ok", view, ...(this.newsReconciliation(trusted) ? { reconciliation: this.newsReconciliation(trusted) } : {}), totalAll: tasks.length, completedTotal: completed.size, ...this.taskPage(selected, offset, limit) };
      });
    }
    if (request.toolId === "schedules.read_text") {
      const tasks = this.tasks(trusted);
      const outputRow = args.field === "output" ? this.database.prepare("SELECT o.json FROM scheduled_occurrence o JOIN scheduled_task t ON t.id = o.task_id WHERE o.id = ? AND t.account = ? AND t.target = ?").get(String(args.reference), trusted.accountId, trusted.target) as JsonRow | undefined : undefined;
      const output = outputRow ? JSON.parse(outputRow.json) as ScheduledOccurrence : undefined;
      if (output?.detailsClearedAt !== undefined && output.originalBodyBytes !== undefined) return { status: "unavailable", code: "history_details_cleared", clearedAt: output.detailsClearedAt, reason: output.detailsClearReason };
      const content = args.field === "reminderText" ? tasks.find((task) => task.id === args.reference)?.reminderText
        : args.field === "instruction" ? tasks.find((task) => task.id === args.reference)?.instruction
        : output?.body;
      if (content === undefined) return { status: "not_found" };
      const points = Array.from(content), offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 4000);
      return { status: "ok", text: points.slice(offset, offset + limit).join(""), totalCharacters: points.length,
        ...(offset + limit < points.length ? { nextOffset: offset + limit } : {}) };
    }
    if (request.toolId === "schedules.inspect") {
      return this.transaction(() => {
        const tasks = this.tasks(trusted).filter((task) => task.id === args.reference || task.name === args.reference);
        if (tasks.length !== 1) {
          if (!tasks.length && this.newsReconciliation(trusted)) return this.newsReconciliation(trusted);
          const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 5);
          return { status: tasks.length ? "needs_choice" : "not_found", ...this.taskPage(tasks, offset, limit) };
        }
        const task = tasks[0]!;
        const counts = this.database.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(json_extract(json, '$.execution') != 'skipped'), 0) AS executions FROM scheduled_occurrence WHERE task_id = ?").get(task.id) as { total: number; executions: number };
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 5);
        const selected = (args.occurrenceId === undefined
          ? this.database.prepare("SELECT json FROM scheduled_occurrence WHERE task_id = ? ORDER BY json_extract(json, '$.plannedAt') DESC, id DESC LIMIT ? OFFSET ?").all(task.id, limit, offset)
          : this.database.prepare("SELECT json FROM scheduled_occurrence WHERE task_id = ? AND id = ?").all(task.id, String(args.occurrenceId))) as JsonRow[];
        if (args.occurrenceId !== undefined && !selected.length) return { status: "not_found", code: "occurrence_not_found" };
        const history = selected.map((row) => {
          const item = JSON.parse(row.json) as ScheduledOccurrence;
          const { body, attempts = [], news, ...summary } = item;
          const attemptOffset = Number(args.attemptOffset ?? 0), attemptLimit = Number(args.attemptLimit ?? 5);
          return { ...summary, ...(news ? { news: { runKey: news.runKey, attempt: news.attempt, archiveWork: news.archiveWork, sources: news.digest?.sources ?? news.sources, sourceProgress: news.sourceProgress, failureStage: news.failureStage,
              failureCode: news.failureCode, nextRetryAt: news.nextRetryAt, lastFailure: news.lastFailure,
              ...(news.original ? { originalStatus: news.original.status, sendFailureReason: news.original.sendFailureReason,
                providerRet: news.original.providerRet, providerErrcode: news.original.providerErrcode, failureNotice: news.original.failureNotice } : {}) } } : {}), recoveryAction: this.recoveryAction(item), bodyAvailable: body !== undefined,
            ...(body !== undefined ? { bodyBytes: Buffer.byteLength(body, "utf8"), ...(Buffer.byteLength(JSON.stringify(body), "utf8") < 8000 ? { body } : {}) } : {}),
            attempts: attempts.slice(attemptOffset, attemptOffset + attemptLimit).map((attempt) => ({ ...attempt,
              parts: attempt.parts.map(({ message, ...part }) => ({ ...part, characters: part.characters ?? Array.from(message).length })) })),
            totalAttempts: attempts.length,
            ...(attemptOffset + attemptLimit < attempts.length ? { nextAttemptOffset: attemptOffset + attemptLimit } : {}),
          };
        });
        const notificationOffset = Number(args.notificationOffset ?? 0), notificationLimit = Number(args.notificationLimit ?? 5);
        const totalNotifications = Number(this.database.prepare("SELECT COUNT(*) AS total FROM scheduled_notification WHERE json_extract(json, '$.taskId') = ?").get(task.id)!.total);
        const notices = this.database.prepare("SELECT json FROM scheduled_notification WHERE json_extract(json, '$.taskId') = ? ORDER BY id LIMIT ? OFFSET ?").all(task.id, notificationLimit, notificationOffset) as JsonRow[];
        return { status: "ok", task: this.taskView(task), history, totalOccurrences: counts.total, executionCount: counts.executions,
          executionCountKind: task.historyComplete ? "cumulative" : "known_minimum",
          historyCountKind: "retained", terminalHistoryLimit: null, historyOrder: "planned_at_desc",
          ...(args.occurrenceId === undefined && offset + limit < counts.total ? { nextOffset: offset + limit } : {}),
          totalNotifications, ...(notificationOffset + notificationLimit < totalNotifications ? { nextNotificationOffset: notificationOffset + notificationLimit } : {}),
          notifications: notices.map((row) => JSON.parse(row.json) as ScheduledNotification).map((notice) => ({
            id: notice.id, occurrenceId: notice.occurrenceId, stage: notice.stage, recordedCode: notice.code,
            delivery: notice.delivery, ...(notice.result ? { result: notice.result } : {}),
          })) };
      });
    }
    const result = request.toolId === "schedules.create" ? this.create(args, trusted, creationDestination) : this.manage(request.toolId, args, trusted, creationDestination);
    this.pruneHistory();
    if (this.started) this.wake();
    return result;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribe = this.options.channel?.subscribe?.(() => this.wake());
    await this.tick();
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) { this.wakeRequested = true; this.resumePump?.(); return this.running; }
    const work = (async () => {
      const admittedTasks = new Set<string>();
      do { this.wakeRequested = false; await this.performTick(admittedTasks); }
      while (this.wakeRequested && !this.closed);
    })().finally(() => { this.running = undefined; if (!this.closed && this.started) this.arm(); });
    this.running = work;
    return work;
  }

  private wake(): void {
    if (this.closed) return;
    void this.tick().catch((error) => this.options.onError?.(error));
  }

  private arm(): void {
    if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer);
    const future = this.tasks().filter((task) => task.enabled && task.nextExecutionAt && Date.parse(task.nextExecutionAt) > this.now())
      .map((task) => Date.parse(task.nextExecutionAt!) - this.now());
    const retries = this.occurrences().filter((item) => item.execution === "failed" && item.news?.nextRetryAt !== undefined && item.news.nextRetryAt > this.now())
      .map((item) => item.news!.nextRetryAt! - this.now());
    const delay = Math.min(30_000, ...future, ...retries);
    this.timer = (this.options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; }))(() => {
      this.timer = undefined; this.wake();
    }, Math.max(1, delay));
  }

  private claimAutomatic(admittedTasks: Set<string>, before?: { plannedAt: string; taskId: string }): { task: ScheduledTask; occurrence: ScheduledOccurrence } | undefined {
    if (!this.renewWorker()) return undefined;
    const due = this.tasks().filter((item) => !admittedTasks.has(item.id) && item.enabled && (item.template !== "daily_ai_news" || (this.options.dailyNewsActive?.() ?? true))).flatMap((task): Array<{ task: ScheduledTask; plannedAt: string; retry?: ScheduledOccurrence }> => {
      const retry = task.template === "daily_ai_news" ? this.occurrences().find((item) => item.taskId === task.id && item.execution === "failed" &&
        item.news?.runKey === newsDate(this.now()) && item.news.nextRetryAt !== undefined && item.news.nextRetryAt <= this.now()) : undefined;
      if (retry) return [{ task, plannedAt: new Date(retry.news!.nextRetryAt!).toISOString(), retry }];
      return task.nextExecutionAt && Date.parse(task.nextExecutionAt) <= this.now()
        ? [{ task, plannedAt: latestInstant(task.schedule, this.now(), task.timezone) }] : [];
    })
      .filter((candidate) => !before || candidate.plannedAt < before.plannedAt || (candidate.plannedAt === before.plannedAt && candidate.task.id <= before.taskId))
      .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt) || a.task.id.localeCompare(b.task.id));
    const selected = due.find(({ task: candidate, retry }) => {
      if (this.occurrences().some((item) => item.taskId === candidate.id && (item.execution === "running" || item.delivery === "sending"))) return false;
      if (candidate.template === "daily_ai_news" && this.newsOwner().previewWork?.status === "running") return false;
      if (this.options.channel && !(retry ? this.deliveryState(retry) : this.scopeState(candidate.destination, candidate.notificationDestination)).enabled) return false;
      const usage = this.capacity(candidate.destination);
      const l = this.limits;
      if (this.activeGenerations() >= 2) {
        this.saveTask({ ...candidate, blocker: { code: "execution_capacity", usage, limits: l, action: "正在执行的任务达到上限，完成后将自动继续。" } });
        return false;
      }
      if (usage.recipientCount + 1 > l.recipientPendingCount || usage.recipientBytes + l.maxBodyBytes > l.recipientPendingBytes ||
          usage.globalCount + 1 > l.globalPendingCount || usage.globalBytes + l.maxBodyBytes > l.globalPendingBytes) {
        this.saveTask({ ...candidate, blocker: { code: "pending_capacity", usage, limits: l, action: "请恢复原微信会话以续发缓存；容量释放后将自动继续。" } });
        return false;
      }
      return true;
    });
    if (!selected) return undefined;
    const { task, plannedAt, retry } = selected;
    delete task.blocker;
    if (retry) {
      const automaticRetry = { ...retry.news! }; delete automaticRetry.explicitRetry;
      const occurrence: ScheduledOccurrence = { ...retry, news: automaticRetry, execution: "running", delivery: "not_generated", worker: this.worker,
        claimedAt: this.now(), reservedBytes: this.limits.maxBodyBytes };
      this.saveOccurrence(occurrence); this.saveTask(task);
      return { task: { ...task, ...retry.news?.settings }, occurrence };
    }
    if (plannedAt > task.nextExecutionAt!) {
      const skipped: ScheduledOccurrence = { id: `${task.id}:skipped:${task.cadenceRevision ?? 1}:${plannedAt}`, taskId: task.id,
        revision: task.revision, destination: task.destination, kind: "automatic", plannedAt: task.nextExecutionAt!,
        execution: "skipped", delivery: "not_generated", reason: "superseded_by_latest_slot", worker: this.worker,
        skippedRange: { from: task.nextExecutionAt!, through: latestInstant(task.schedule, Date.parse(plannedAt) - 1, task.timezone), cadenceRevision: task.cadenceRevision ?? 1 } };
      this.insertOccurrence(skipped);
    }
    const occurrence: ScheduledOccurrence = {
      id: task.schedule.kind === "once" ? `${task.id}:once` : `${task.id}:cadence:${task.cadenceRevision ?? 1}:${plannedAt}`, taskId: task.id, revision: task.revision,
      ...(task.template === "researched_text" ? { stage: "research" as const } : {}),
      plannedAt, destination: task.destination, kind: "automatic", claimedAt: this.now(),
      ...(task.template === "daily_ai_news" ? { news: { runKey: newsDate(Date.parse(plannedAt)), settings: { name: task.name, instruction: task.instruction, timezone: task.timezone } } } : {}),
      execution: "running", delivery: "not_generated", worker: this.worker, reservedBytes: this.limits.maxBodyBytes,
    };
    this.insertOccurrence(occurrence);
    this.saveTask({ ...task, nextExecutionAt: nextInstant(task.schedule, Date.parse(plannedAt), task.timezone), ...(task.schedule.kind === "once" ? { automaticClaimed: true } : {}) });
    return { task, occurrence };
  }

  private async performTick(admittedTasks: Set<string>): Promise<void> {
    if (this.closed) return;
    this.reconcileWorkers();
    const jobs = new Set<Promise<void>>();
    let failure: unknown;
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        const active = this.transaction(() => this.renewWorker());
        admittedTasks.clear();
        for (const { controller, occurrence } of this.researchControllers.values()) {
          if (!active || (this.options.channel && !this.deliveryState(occurrence).enabled)) controller.abort();
        }
        this.resumePump?.();
      } catch (error) { failure = error; for (const { controller } of this.researchControllers.values()) controller.abort(); this.resumePump?.(); }
    }, 10_000);
    heartbeat.unref();
    try {
      while (!this.closed) {
        if (failure) throw failure;
        this.wakeRequested = false;
        while (!this.closed) {
          const claim = this.executionQueue.shift() ?? this.transaction(() => this.claimAutomatic(admittedTasks));
          if (!claim) break;
          admittedTasks.add(claim.task.id);
          if ((claim.task.template === "researched_text" || claim.task.template === "daily_ai_news")) {
            const job = this.generate(claim).catch((error) => { failure = error; }).finally(() => { jobs.delete(job); this.wakeRequested = true; this.resumePump?.(); });
            jobs.add(job);
          } else await this.generate(claim);
        }
        if (failure) throw failure;
        if (this.closed) break;
        const archiveClaim = this.claimNewsArchive();
        if (archiveClaim) {
          const job = this.archiveNews(archiveClaim).catch((error) => { failure = error; }).finally(() => { jobs.delete(job); this.wakeRequested = true; this.resumePump?.(); });
          jobs.add(job);
        }
        this.reconcilePending();
        if (await this.drain() && !this.closed) this.wakeRequested = true;
        else if (this.wakeRequested) continue;
        else if (!this.closed) await this.notifyFailures();
        if (!this.closed) this.pruneHistory();
        if (!jobs.size) break;
        await Promise.race([...jobs, new Promise<void>((resolve) => { this.resumePump = resolve; })]);
        this.resumePump = undefined;
      }
    } finally { clearInterval(heartbeat); this.resumePump = undefined; }
  }

  private async generate(claim: { task: ScheduledTask; occurrence: ScheduledOccurrence }): Promise<void> {
    if (claim.task.template === "daily_ai_news") {
      if (this.options.diagnostics) await this.options.diagnostics.run("scheduled.daily_news", { taskRef: claim.task.id, occurrenceRef: claim.occurrence.id,
        revision: claim.occurrence.revision, plannedAt: claim.occurrence.plannedAt }, () => this.generateNews(claim));
      else await this.generateNews(claim);
      return;
    }
    if (claim.task.template === "researched_text" && this.options.diagnostics) {
      await this.options.diagnostics.run("scheduled.research", { taskRef: claim.task.id, occurrenceRef: claim.occurrence.id,
        revision: claim.occurrence.revision, plannedAt: claim.occurrence.plannedAt }, () => this.generateOutput(claim));
    } else await this.generateOutput(claim);
  }

  private async generateNews(claim: { task: ScheduledTask; occurrence: ScheduledOccurrence }): Promise<void> {
    const runKey = claim.occurrence.news?.runKey ?? newsDate(Date.parse(claim.occurrence.plannedAt));
    const attempt = (claim.occurrence.news?.attempt ?? 0) + 1;
    let result: Awaited<ReturnType<typeof generateDailyNews>> | undefined;
    let failure: DailyNewsExecutionError | undefined;
    const controller = new AbortController();
    this.researchControllers.set(claim.occurrence.id, { controller, occurrence: claim.occurrence });
    try {
      if (this.options.channel && !this.deliveryState(claim.occurrence).enabled) controller.abort();
      if (!this.options.dailyNews) throw new DailyNewsExecutionError("research", "codex_process");
      const row = this.database.prepare("SELECT json FROM scheduled_news_owner WHERE id = 'daily-news'").get() as JsonRow | undefined;
      if (!row) throw new DailyNewsPersistenceError("daily_news_reconciliation_pending");
      const owner = JSON.parse(row.json) as { state: DailyAiNewsState };
      result = await generateDailyNews({ ...this.options.dailyNews, state: owner.state, deferArchive: true, observe: (event, attributes) => {
          if (this.closed || !this.workerActive()) return;
          if (["source.start", "source.end"].includes(event) && (attributes.source === "general" || attributes.source === "hackernews") && typeof attributes.status === "string") {
            const source = attributes.source, status = attributes.status;
            try { this.transaction(() => {
              const current = this.occurrences().find((item) => item.id === claim.occurrence.id);
              if (current?.execution !== "running" || current.worker !== this.worker) return;
              current.news = { ...current.news, runKey, sourceProgress: { ...current.news?.sourceProgress,
                [source]: { status, ...(typeof attributes.code === "string" ? { code: attributes.code } : {}) } } };
              this.saveOccurrence(current);
            }); } catch { throw new DailyNewsPersistenceError("source_state_store_failed"); }
          }
          this.options.diagnostics?.checkpoint(`scheduled.daily_news.${event}`, { taskRef: claim.task.id, occurrenceRef: claim.occurrence.id, ...attributes });
        }, date: runKey, now: this.now(), instruction: claim.task.instruction, signal: controller.signal,
        articles: this.articles.processor(claim.task.id, () => !this.closed && this.workerActive() && this.occurrences().some((item) => item.id === claim.occurrence.id && item.execution === "running" && item.worker === this.worker), controller.signal, (event, attributes) => this.options.diagnostics?.checkpoint(`scheduled.daily_news.${event}`, { taskRef: claim.task.id, occurrenceRef: claim.occurrence.id, ...attributes })),
        ...(claim.occurrence.news?.digest ? { cachedDigest: claim.occurrence.news.digest } : {}),
        saveDigest: (generated, selected) => {
          if (this.closed || !this.workerActive()) throw new DailyNewsPersistenceError("worker_fenced");
          try {
            this.transaction(() => {
              const current = this.occurrences().find((item) => item.id === claim.occurrence.id);
              if (current?.execution !== "running" || current.worker !== this.worker) throw new DailyNewsPersistenceError("worker_fenced");
              this.saveOccurrence({ ...current, news: { ...current.news, runKey, attempt, digest: selected } });
              const latest = JSON.parse((this.database.prepare("SELECT json FROM scheduled_news_owner WHERE id = 'daily-news'").get() as JsonRow).json) as { state: DailyAiNewsState & { previewInstruction?: string } };
              latest.state.preview = generated;
              latest.state.previewInstruction = claim.task.instruction;
              latest.state.summarizedArticleKeys = [...new Set([...latest.state.summarizedArticleKeys, ...generated.items.map((item) => articleKey(item.url))])].slice(-100_000);
              this.database.prepare("UPDATE scheduled_news_owner SET json = ? WHERE id = 'daily-news'").run(JSON.stringify(latest));
            });
          } catch (error) { throw new DailyNewsPersistenceError(error instanceof Error ? error.message : "daily_news_store_failed"); }
        } });
    } catch (error) {
      if (error instanceof DailyNewsPersistenceError) {
        // If storage can still accept a status, stop automatic work rather than leave a live claim stuck forever.
        failure = new DailyNewsExecutionError("configuration", error.message === "article_capacity" ? "article_capacity" : "result_store_unavailable");
      } else {
        if (!(error instanceof DailyNewsExecutionError)) throw error;
        failure = error;
      }
    } finally { this.researchControllers.delete(claim.occurrence.id); }
    if (this.closed || !this.workerActive()) { this.options.diagnostics?.result({ status: "discarded", errorCode: "worker_fenced" }); return; }
    const outcome = this.transaction(() => {
      const current = this.occurrences().find((item) => item.id === claim.occurrence.id);
      if (current?.execution !== "running" || current.worker !== this.worker) return;
      delete current.reservedBytes;
      const news: ScheduledNewsMetadata = { ...current.news, runKey, attempt };
      const liveTask = this.tasks().find((task) => task.id === current.taskId)!;
      delete news.nextRetryAt;
      if (failure) {
        news.failureStage = failure.stage; news.failureCode = failure.code;
        news.lastFailure = { stage: failure.stage, code: failure.code, attempt, at: this.now() };
        const nextRetryAt = current.news?.explicitRetry ? current.news.explicitRetry.nextRetryAt !== undefined && current.news.explicitRetry.nextRetryAt > this.now() && newsDate(current.news.explicitRetry.nextRetryAt) === runKey
          ? current.news.explicitRetry.nextRetryAt : undefined : retryAtFor(runKey, attempt, this.now());
        delete news.explicitRetry;
        if (nextRetryAt !== undefined && current.kind !== "manual" && failure.stage !== "configuration" && failure.code !== "target_changed" && liveTask.enabled &&
          (liveTask.pauseGeneration ?? 0) === (claim.task.pauseGeneration ?? 0)) news.nextRetryAt = nextRetryAt;
        this.saveOccurrence({ ...current, news, stage: "research", execution: "failed", delivery: "not_generated", reason: failure.code });
        return { status: "failed", errorCode: failure.code, stage: failure.stage, attempt };
      } else {
        delete news.failureStage; delete news.failureCode;
        news.digest = result!.digest;
        if (this.options.dailyNews?.archive) news.archiveWork = { status: "pending", attempts: 0, nextRetryAt: this.now() };
        if (Buffer.byteLength(result!.body, "utf8") > this.limits.maxBodyBytes) {
          this.saveOccurrence({ ...current, news, stage: "research", execution: "failed", delivery: "not_generated", reason: "output_too_large" });
          return { status: "failed", errorCode: "output_too_large", attempt };
        } else {
          this.saveOccurrence({ ...current, news, stage: "research", execution: "succeeded", delivery: "pending_inbound", body: result!.body });
          const owner = this.newsOwner();
          owner.state.preview = result!.digest; owner.state.previewInstruction = claim.task.instruction; owner.previewReady = false;
          if (result!.archive) owner.archive = result!.archive;
          this.saveNewsOwner(owner);
          return { status: "cached", outputBytes: Buffer.byteLength(result!.body, "utf8"), attempt };
        }
      }
    });
    this.options.diagnostics?.result(outcome ?? { status: "discarded", errorCode: "worker_fenced" });
    if (outcome?.status === "cached") this.options.diagnostics?.checkpoint("scheduled.output.persisted", {
      taskRef: claim.task.id, occurrenceRef: claim.occurrence.id, ...outcome });
    this.wakeRequested = true; this.resumePump?.();
  }

  private claimNewsArchive(): ArchiveClaim | undefined {
    if (!this.options.dailyNews?.archive || this.closed || !(this.options.dailyNewsActive?.() ?? true) ||
      !this.database.prepare("SELECT id FROM scheduled_news_owner WHERE id = 'daily-news'").get()) return;
    return this.transaction(() => {
      if (!this.renewWorker()) return;
      const occurrences = this.occurrences(), owner = this.newsOwner();
      if (occurrences.some((item) => item.news?.archiveWork?.status === "running") || owner.previewArchives?.some((job) => job.work.status === "running")) return;
      const candidate = occurrences.filter((item) => item.execution === "succeeded" && item.news?.digest &&
        item.news.archiveWork?.status === "pending" && (item.news.archiveWork.nextRetryAt ?? 0) <= this.now() &&
        this.tasks().some((task) => task.id === item.taskId && this.deliveryAllowed(task, item))).sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))[0];
      if (candidate) {
        const work: NewsArchiveWork = { status: "running", attempts: candidate.news!.archiveWork!.attempts + 1, worker: this.worker };
        candidate.news!.archiveWork = work; this.saveOccurrence(candidate);
        return { id: candidate.id, digest: candidate.news!.digest!, scope: candidate.taskId, work, occurrence: candidate };
      }
      const preview = owner.previewArchives?.find((job) => job.work.status === "pending" && (job.work.nextRetryAt ?? 0) <= this.now());
      if (!preview) return;
      preview.work = { status: "running", attempts: preview.work.attempts + 1, worker: this.worker }; this.saveNewsOwner(owner);
      return { id: preview.id, digest: preview.digest, scope: preview.scope, work: preview.work };
    });
  }

  private async archiveNews(claim: ArchiveClaim): Promise<void> {
    let result: unknown, failed = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !controller.signal.aborted && !this.closed && this.workerActive() && (claim.occurrence
      ? this.occurrences().some((item) => item.id === claim.id && item.news?.archiveWork?.status === "running" && item.news.archiveWork.worker === this.worker && item.news.archiveWork.attempts === claim.work.attempts &&
        this.tasks().some((task) => task.id === item.taskId && this.deliveryAllowed(task, item)))
      : Boolean(this.newsOwner().previewArchives?.some((job) => job.id === claim.id && job.work.status === "running" && job.work.worker === this.worker && job.work.attempts === claim.work.attempts)));
    try {
      result = await Promise.race([this.options.dailyNews!.archive!.archive(structuredClone(claim.digest), {
        loadBody: async (url) => this.articles.body(claim.scope, url), signal: controller.signal, snapshotId: claim.id, active,
      }), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("archive_timeout")); }, this.options.dailyNews?.archiveTimeoutMs ?? 30_000);
      })]);
    } catch { failed = true; }
    finally { clearTimeout(timer); }
    if (this.closed || !this.workerActive()) return;
    this.transaction(() => {
      const current = claim.occurrence ? this.occurrences().find((item) => item.id === claim.id) : undefined;
      const owner = this.newsOwner();
      const work = claim.occurrence ? current?.news?.archiveWork : owner.previewArchives?.find((job) => job.id === claim.id)?.work;
      if (work?.status !== "running" || work.worker !== this.worker || work.attempts !== claim.work.attempts) return;
      const metadata = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
      if (metadata && Array.isArray(metadata.skipped) && metadata.skipped.length) failed = true;
      const delay = [600_000, 1_800_000, 3_600_000][work.attempts - 1];
      const updated: NewsArchiveWork = { status: failed ? delay === undefined ? "failed" : "pending" : "succeeded", attempts: work.attempts,
        ...(failed ? { errorCode: "archive_unavailable", ...(delay !== undefined ? { nextRetryAt: this.now() + delay } : {}) } : {}) };
      if (current) { current.news!.archiveWork = updated; this.saveOccurrence(current); }
      else owner.previewArchives!.find((job) => job.id === claim.id)!.work = updated;
      if (metadata && typeof metadata.summaryPath === "string" && Array.isArray(metadata.archived) && Array.isArray(metadata.skipped) && JSON.stringify(owner.state.preview) === JSON.stringify(claim.digest)) {
        owner.archive = { summaryPath: metadata.summaryPath,
          hackerNewsTopPath: typeof metadata.hackerNewsTopPath === "string" ? metadata.hackerNewsTopPath : null,
          archivedCount: metadata.archived.length, skippedCount: metadata.skipped.length, totalCount: claim.digest.items.length };
      }
      this.saveNewsOwner(owner);
      this.options.diagnostics?.checkpoint("scheduled.daily_news.archive", { occurrenceRef: claim.id, status: updated.status, attempts: work.attempts });
    });
  }

  private async generateOutput(claim: { task: ScheduledTask; occurrence: ScheduledOccurrence }): Promise<void> {
    let body: string | undefined, reason = "execution_failed";
    const research = claim.task.template === "researched_text";
    const controller = new AbortController();
    let timedOut = false;
    const timer = research ? setTimeout(() => { timedOut = true; controller.abort(); }, this.options.researchTimeoutMs ?? 300_000) : undefined;
    if (research) this.researchControllers.set(claim.occurrence.id, { controller, occurrence: claim.occurrence });
    try {
      if (research) {
        if (this.options.channel && !this.deliveryState(claim.occurrence).enabled) controller.abort();
        if (controller.signal.aborted) throw new Error("research_cancelled");
        if (!this.options.research) throw new Error("research_unavailable");
        body = await this.options.research({ destination: claim.task.destination, name: claim.task.name, instruction: claim.task.instruction,
          timezone: claim.task.timezone, plannedAt: claim.occurrence.plannedAt, signal: controller.signal });
        if (controller.signal.aborted) throw new Error(timedOut ? "research_timeout" : "research_cancelled");
        if (!body.trim()) throw new Error("research_output_invalid");
      } else body = this.options.renderReminder ? await this.options.renderReminder(structuredClone(claim.task)) : claim.task.reminderText ?? `提醒：${claim.task.name}\n\n${claim.task.instruction}`;
    } catch (error) {
      body = undefined;
      const code = error instanceof Error ? error.message : "";
      reason = research ? timedOut ? "research_timeout" : ["research_cancelled", "research_unavailable", "research_runtime_unavailable", "research_start_failed", "research_timeout", "research_usage_limit", "research_rate_limit", "research_search_missing", "research_source_read_missing", "research_output_invalid", "output_too_large"].includes(code) ? code : "research_failed" : "execution_failed";
    } finally { clearTimeout(timer); this.researchControllers.delete(claim.occurrence.id); }
    if (this.closed || !this.workerActive()) { if (research) this.options.diagnostics?.result({ status: "discarded", errorCode: "worker_fenced" }); return; }
    const result = this.transaction(() => {
      const current = this.occurrences().find((item) => item.id === claim.occurrence.id);
      if (current?.execution !== "running" || current.worker !== this.worker) return;
      delete current.reservedBytes;
      if (research) current.stage = "research";
      if (body === undefined) { this.saveOccurrence({ ...current, execution: "failed", reason, delivery: "not_generated" }); return { status: "failed", errorCode: reason }; }
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > this.limits.maxBodyBytes) {
        this.saveOccurrence({ ...current, execution: "failed", reason: "output_too_large", delivery: "not_generated" });
        return { status: "failed", errorCode: "output_too_large" };
      }
      this.saveOccurrence({ ...current, body, execution: "succeeded", delivery: "pending_inbound" });
      return { status: "cached", outputBytes: bytes };
    });
    if (research) {
      this.options.diagnostics?.result(result ?? { status: "discarded", errorCode: "worker_fenced" });
      if (result?.status === "cached") this.options.diagnostics?.checkpoint("scheduled.output.persisted", {
        taskRef: claim.task.id, occurrenceRef: claim.occurrence.id, ...result });
    }
    this.wakeRequested = true;
    this.resumePump?.();
  }

  private pruneHistory(): void {
    this.transaction(() => {
      const tasks = new Map(this.tasks().map((task) => [task.id, task]));
      const protectedNotices = new Set(this.notifications().filter((notice) => ["pending", "sending"].includes(notice.delivery)).map((notice) => notice.occurrenceId));
      const candidates: ScheduledOccurrence[] = [];
      const rows = this.database.prepare("SELECT json FROM scheduled_occurrence WHERE json_extract(json, '$.detailsClearedAt') IS NULL").all() as JsonRow[];
      for (const row of rows) {
        const item = JSON.parse(row.json) as ScheduledOccurrence, task = tasks.get(item.taskId);
        const protectedWork = item.execution === "running" || item.delivery === "sending" || isPending(item)
          || ["pending", "running"].includes(item.news?.archiveWork?.status ?? "") || protectedNotices.has(item.id)
          || (task?.deletedAt === undefined && item.kind === "automatic" && item.execution === "failed" && item.news?.runKey === newsDate(this.now()) && ["research", "archive"].includes(item.news.failureStage ?? ""));
        if (protectedWork) {
          if (item.detailsEligibleAt !== undefined) { delete item.detailsEligibleAt; this.saveOccurrence(item); }
          continue;
        }
        if (item.detailsEligibleAt === undefined) { item.detailsEligibleAt = this.now(); this.saveOccurrence(item); }
        candidates.push(item);
      }
      candidates.sort((a, b) => a.detailsEligibleAt! - b.detailsEligibleAt! || a.id.localeCompare(b.id));
      let retainedBytes = candidates.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
      for (const item of candidates) {
        const expired = this.now() - item.detailsEligibleAt! >= this.historyRetention.maxAgeMs;
        if (!expired && retainedBytes <= this.historyRetention.maxBytes) continue;
        retainedBytes -= Buffer.byteLength(JSON.stringify(item), "utf8");
        this.clearHistoryDetails(item, expired ? "age" : "capacity");
      }
    });
  }

  private clearHistoryDetails(item: ScheduledOccurrence, reason: "age" | "capacity"): void {
    if (item.body !== undefined) item.originalBodyBytes = Buffer.byteLength(item.body, "utf8");
    delete item.body;
    for (const attempt of item.attempts ?? []) for (const part of attempt.parts) {
      part.characters = Array.from(part.message).length; part.message = "";
    }
    if (item.news) {
      if (item.news.digest?.sources) item.news.sources = item.news.digest.sources;
      delete item.news.digest; delete item.news.settings;
      if (item.news.original) {
        delete item.news.original.message; delete item.news.original.digest;
        if (item.news.original.failureNotice) delete item.news.original.failureNotice.message;
      }
    }
    item.detailsClearedAt = this.now(); item.detailsClearReason = reason;
    this.saveOccurrence(item);
  }

  private reconcileWorkers(): void {
    this.transaction(() => {
      const expired = new Set(this.database.prepare("SELECT id FROM scheduled_worker WHERE expires_at <= ?").all(this.now()).map((row) => String(row.id)));
      for (const item of this.occurrences()) {
        if (item.news?.archiveWork?.status === "running" && expired.has(item.news.archiveWork.worker!)) {
          const work = item.news.archiveWork;
          item.news.archiveWork = { status: work.attempts < 4 ? "pending" : "failed", attempts: work.attempts,
            errorCode: "archive_interrupted", ...(work.attempts < 4 ? { nextRetryAt: this.now() + 600_000 } : {}) };
          this.saveOccurrence(item);
        }
        if (item.execution === "running" && expired.has(item.worker)) {
          this.fenceWorker(item.worker);
          delete item.reservedBytes;
          this.saveOccurrence({ ...item, execution: "unknown", reason: "execution_interrupted" });
        }
        if (item.delivery === "sending" && expired.has(item.worker)) {
          this.fenceWorker(item.worker);
          const attempt = item.attempts?.at(-1);
          if (attempt) {
            attempt.result = "unknown";
            this.database.prepare("INSERT INTO scheduled_blocker VALUES (?, ?) ON CONFLICT(recipient) DO UPDATE SET json = excluded.json")
              .run(hash(deliveryAddress(item)), JSON.stringify({ context: attempt.context, reason: "unknown" }));
          }
          this.saveOccurrence({ ...item, delivery: "unknown", reason: "submission_interrupted" });
        }
      }
      for (const notice of this.notifications()) {
        if (notice.delivery === "sending" && notice.worker && expired.has(notice.worker)) {
          this.fenceWorker(notice.worker);
          this.saveNotification({ ...notice, delivery: "unknown" });
          this.database.prepare("INSERT INTO scheduled_blocker VALUES (?, ?) ON CONFLICT(recipient) DO UPDATE SET json = excluded.json")
            .run(hash(deliveryAddress(notice)), JSON.stringify({ context: notice.context, reason: "unknown" }));
        }
      }
      const ownerRow = this.database.prepare("SELECT json FROM scheduled_news_owner WHERE id = 'daily-news'").get() as JsonRow | undefined;
      if (ownerRow) {
        const owner = JSON.parse(ownerRow.json) as ScheduledNewsOwner;
        for (const job of owner.previewArchives ?? []) if (job.work.status === "running" && expired.has(job.work.worker!)) {
          job.work = { status: job.work.attempts < 4 ? "pending" : "failed", attempts: job.work.attempts, errorCode: "archive_interrupted", nextRetryAt: this.now() + 600_000 };
          this.saveNewsOwner(owner);
        }
        if (owner.previewWork?.status === "running" && expired.has(owner.previewWork.worker)) {
          this.fenceWorker(owner.previewWork.worker); owner.previewWork.status = "unknown"; this.saveNewsOwner(owner);
        }
      }
      if (this.workerActive()) this.database.prepare("UPDATE scheduled_worker SET expires_at = ? WHERE id = ?").run(this.now() + 60_000, this.worker);
    });
  }

  private workerActive(): boolean {
    return !this.database.prepare("SELECT id FROM scheduled_fenced_worker WHERE id = ?").get(this.worker);
  }

  private renewWorker(): boolean {
    if (!this.workerActive()) return false;
    this.database.prepare("UPDATE scheduled_worker SET expires_at = ? WHERE id = ?").run(this.now() + 60_000, this.worker);
    return true;
  }

  private fenceWorker(worker: string): void {
    this.database.prepare("INSERT OR IGNORE INTO scheduled_fenced_worker VALUES (?)").run(worker);
  }

  private capacity(destination: Destination): CapacityUsage {
    const usage = { recipientCount: 0, recipientBytes: 0, globalCount: 0, globalBytes: 0 };
    for (const item of this.occurrences()) {
      if (item.execution !== "running" && !isPending(item) && item.delivery !== "sending") continue;
      const bytes = item.reservedBytes ?? Buffer.byteLength(item.body ?? "", "utf8");
      usage.globalCount += 1; usage.globalBytes += bytes;
      if (hash(destination) === hash(item.destination)) { usage.recipientCount += 1; usage.recipientBytes += bytes; }
    }
    return usage;
  }

  private currentDelivery(item: Pick<ScheduledOccurrence, "destination" | "deliveryDestination">): ScheduledOccurrence["delivery"] {
    const state = this.deliveryState(item);
    if (!state || !state.enabled) return "pending_inbound";
    if (state.credentialStatus !== "usable") return "auth_relogin_required";
    if (!state.contextGeneration) return "pending_inbound";
    const legacyRow = this.database.prepare("SELECT json FROM scheduled_news_barrier WHERE recipient = ?").get(hash(deliveryAddress(item))) as JsonRow | undefined;
    if (legacyRow) {
      const barrier = JSON.parse(legacyRow.json) as { after: number; context: ScheduledChannelState | null };
      if (state.contextUpdatedAt !== undefined ? state.contextUpdatedAt <= barrier.after : barrier.context && sameContext(barrier.context, state)) return "context_refresh_required";
    }
    const row = this.database.prepare("SELECT json FROM scheduled_blocker WHERE recipient = ?").get(hash(deliveryAddress(item))) as JsonRow | undefined;
    const blocker = row ? JSON.parse(row.json) as { context: ScheduledChannelState; reason: string } : undefined;
    if (blocker?.reason === "auth_relogin_required" && blocker.context.credentialGeneration === state.credentialGeneration) return "auth_relogin_required";
    if (blocker && sameContext(blocker.context, state)) return "context_refresh_required";
    return "ready";
  }

  private recoveryAction(item: ScheduledOccurrence): string {
    if (item.execution === "skipped") return "错过的较早时段已合并跳过，仅执行最近一次；不会补跑该范围。";
    if (item.delivery === "cancelled") return "任务已删除；该缓存已取消推送，历史记录仍保留。";
    if (item.execution === "running") return "正在生成正文，尚无可推送内容。";
    if (item.execution === "failed" && item.news?.failureStage === "configuration") return "本地存储需要处理；已保存成果保留，修复后可明确执行一次。";
    if (item.execution === "failed" && item.news?.runKey !== undefined && item.news.runKey !== newsDate(this.now())) return "历史日报研究或归档失败，不会补跑；需要新内容时可明确执行一次。";
    if (item.execution === "failed" && item.news) return item.news.nextRetryAt !== undefined
      ? "日报研究或归档失败；内容生成按当日退避计划重试，已缓存的推送不会重新研究。"
      : "日报研究或归档失败；今日不再自动重试，可明确立即重试日报。";
    if (item.execution === "failed") return item.reason === "output_too_large" ? item.stage === "research" ? "请缩小研究范围后再明确执行一次。" : "请缩短提醒内容后创建新提醒。" : item.stage === "research" ? "本次执行失败，不会自动重跑；请查看原因，处理后可明确执行一次，或等待下一计划时段。" : "本次执行失败，不会自动重跑；请查看失败原因。";
    if (item.execution === "unknown") return "执行结果无法确认，不会自动重跑；请先查看记录。";
    if (item.delivery === "accepted") return "无需补发；渠道已接受，手机是否收到需用户确认。";
    if (["partial", "rejected", "unknown"].includes(item.delivery)) return "本次推送不会自动补发；请先核对已收到的内容和发送记录。";
    if (item.delivery === "sending") return "正在提交，尚无最终发送结果。";
    const task = this.tasks(item.destination).find((candidate) => candidate.id === item.taskId);
    if (task && !this.deliveryAllowed(task, item)) return "任务已停用；缓存正文仍保留，启用后才会恢复符合条件的推送。";
    const state = this.deliveryState(item);
    if (state && !state.enabled) return "请先启用原账户和接收会话；已生成正文仍保留。";
    if (item.delivery === "auth_relogin_required") return "请重新绑定原微信账户，再从原会话发送消息以刷新会话。";
    if (["pending_inbound", "context_refresh_required"].includes(item.delivery)) return "请从原微信会话发送消息；条件恢复后将按时间顺序续发缓存。";
    return "已进入推送队列，等待当前会话中的较早内容完成。";
  }

  private deliveryAllowed(task: ScheduledTask, item: ScheduledOccurrence): boolean {
    return task.deletedAt === undefined && (task.template !== "daily_ai_news" || (this.options.dailyNewsActive?.() ?? true)) && (task.enabled || (item.kind === "manual" && item.manualPauseGeneration === (task.pauseGeneration ?? 0)));
  }

  private reconcilePending(): void {
    this.transaction(() => {
      const rows = this.database.prepare("SELECT json FROM scheduled_occurrence WHERE json_extract(json, '$.execution') = 'succeeded' AND json_extract(json, '$.delivery') IN ('ready', 'pending_inbound', 'auth_relogin_required', 'context_refresh_required')").all() as JsonRow[];
      for (const row of rows) {
        const item = JSON.parse(row.json) as ScheduledOccurrence;
        if (isPending(item)) this.saveOccurrence({ ...item, delivery: this.currentDelivery(item) });
      }
    });
  }

  private async drain(): Promise<boolean> {
    const channel = this.options.channel;
    if (!channel) return false;
    let freedCapacity = false;
    while (!this.closed) {
      const claimed = this.transaction(() => {
        if (!this.renewWorker()) return undefined;
        const all = this.occurrences();
        const tasks = this.tasks();
        const next = all.filter((item) => isPending(item) && this.currentDelivery(item) === "ready" &&
          tasks.some((task) => task.id === item.taskId && this.deliveryAllowed(task, item)) &&
          !this.notifications().some((notice) => notice.delivery === "sending" && hash(deliveryAddress(notice)) === hash(deliveryAddress(item))) &&
          !all.some((busy) => busy.delivery === "sending" && hash(deliveryAddress(busy)) === hash(deliveryAddress(item))))
          .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt) || a.id.localeCompare(b.id))[0];
        if (!next) return undefined;
        const attempt = { id: crypto.randomUUID(), pauseGeneration: tasks.find((task) => task.id === next.taskId)!.pauseGeneration ?? 0, context: this.deliveryState(next), result: "sending" as const, parts: [] };
        const item = { ...next, worker: this.worker, delivery: "sending" as const, attempts: [...(next.attempts ?? []), attempt] };
        this.saveOccurrence(item);
        return item;
      });
      if (!claimed) break;
      const attempt = claimed.attempts!.at(-1)!;
      const points = Array.from(claimed.body!);
      let acceptedParts = 0;
      for (let offset = 0; offset < points.length && !this.closed; offset += 1500) {
        const message = points.slice(offset, offset + 1500).join("");
        const ordinal = offset / 1500;
        const canSubmit = () => !this.closed && this.transaction(() => {
          const live = this.occurrences().find((item) => item.id === claimed.id);
          const task = this.tasks(claimed.destination).find((item) => item.id === claimed.taskId);
          const current = this.deliveryState(claimed);
          return this.renewWorker() && live?.delivery === "sending" && live.worker === this.worker && live.attempts?.at(-1)?.id === attempt.id &&
            task !== undefined && this.deliveryAllowed(task, live!) && (task.pauseGeneration ?? 0) === (attempt.pauseGeneration ?? 0) && current.enabled && current.credentialStatus === "usable" && sameContext(current, attempt.context);
        });
        const pausedSinceClaim = () => {
          const task = this.tasks(claimed.destination).find((item) => item.id === claimed.taskId);
          return !task || !this.deliveryAllowed(task, claimed) || (task.pauseGeneration ?? 0) !== (attempt.pauseGeneration ?? 0);
        };
        let result: SendTextResult;
        if (!canSubmit()) result = { ok: false, reason: "context_missing", acceptedSegments: 0 };
        else {
          this.transaction(() => {
            const live = this.occurrences().find((item) => item.id === claimed.id)!;
            live.attempts!.at(-1)!.parts.push({ message });
            this.saveOccurrence(live);
          });
          try {
            result = await channel.send({ ...deliveryAddress(claimed), message, operationId: `${attempt.id}:${ordinal}`, beforeSubmit: canSubmit });
          } catch { result = { ok: false, reason: "unknown" }; }
        }
        if (this.closed) return freedCapacity;
        const stoppedByPause = result.acceptedSegments === 0 && result.reason === "context_missing" && pausedSinceClaim();
        let status = deliveryResult(result);
        if (claimed.news?.oneShotPreview && ["pending_inbound", "context_refresh_required", "auth_relogin_required"].includes(status)) status = "rejected";
        if (status === "accepted") acceptedParts += 1;
        else if (acceptedParts > 0) status = "partial";
        const finished = status !== "accepted" || offset + 1500 >= points.length;
        this.transaction(() => {
          const live = this.occurrences().find((item) => item.id === claimed.id);
          if (!live || live.delivery !== "sending" || live.worker !== this.worker || live.attempts?.at(-1)?.id !== attempt.id) return;
          const latest = live.attempts.at(-1)!;
          const part = latest.parts[ordinal];
          if (part) part.result = result;
          if (finished) {
            live.delivery = status; latest.result = status;
            if (status === "accepted" && live.news?.digest) {
              const owner = this.newsOwner();
              owner.state.seenItemKeys = [...owner.state.seenItemKeys, ...live.news.digest.items.map((item) => articleKey(item.url))].slice(-500);
              this.saveNewsOwner(owner);
            }
          }
          this.saveOccurrence(live);
          if (status !== "accepted" && !stoppedByPause) this.database.prepare("INSERT INTO scheduled_blocker VALUES (?, ?) ON CONFLICT(recipient) DO UPDATE SET json = excluded.json")
            .run(hash(deliveryAddress(live)), JSON.stringify({ context: attempt.context, reason: status }));
        });
        if (finished) { if (["accepted", "partial", "rejected", "unknown"].includes(status)) freedCapacity = true; break; }
      }
      this.reconcilePending();
    }
    return freedCapacity;
  }

  private notifications(): ScheduledNotification[] {
    return (this.database.prepare("SELECT json FROM scheduled_notification ORDER BY id").all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as ScheduledNotification);
  }

  private saveNotification(notice: ScheduledNotification): void {
    this.database.prepare("INSERT INTO scheduled_notification VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(notice.id, JSON.stringify(notice));
  }

  private syncNotifications(): void {
    const localNewsNotices: string[] = [];
    this.transaction(() => {
      const active = new Set<string>();
      const remember = (task: ScheduledTask, stage: ScheduledNotification["stage"], code: string, action: string, cause: string, occurrenceId?: string) => {
        const id = hash([occurrenceId ?? task.id, stage, code]);
        active.add(id);
        if (this.notifications().some((notice) => notice.id === id)) return;
        const backlog = task.template === "daily_ai_news" ? this.occurrences().filter((item) => item.news && isPending(item) && hash(item.destination) === hash(task.destination))
          .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt)) : [];
        const message = `定时任务需要处理：${task.name}\n阶段：${stage === "archive" ? "本地归档" : stage === "research" ? "网页研究" : stage === "execution" ? "内容生成" : stage === "delivery" ? "消息推送" : "等待执行"}\n原因：${cause}\n${backlog.length ? `已缓存 ${backlog.length} 份日报，最早为 ${backlog[0]!.news!.runKey}。\n` : ""}${action}`;
        const occurrence = occurrenceId ? this.occurrences().find((item) => item.id === occurrenceId) : undefined;
        const deliveryDestination = occurrence ? occurrence.deliveryDestination : this.options.notificationRoute?.resolve(task.destination, task.notificationDestination);
        this.saveNotification({ ...(deliveryDestination ? { deliveryDestination } : {}), id, taskId: task.id, ...(occurrenceId ? { occurrenceId } : {}), destination: task.destination,
          stage, code, action, delivery: "pending", message });
        if (task.template === "daily_ai_news") localNewsNotices.push(message);
      };
      for (const task of this.tasks()) {
        if (task.deletedAt !== undefined) continue;
        if (task.blocker) remember(task, "admission", task.blocker.code, task.blocker.action, task.blocker.code === "execution_capacity" ? "执行名额已满，尚未开始执行" : "缓存容量已满，尚未开始执行");
      }
      const summaries = this.database.prepare("SELECT json_remove(json, '$.body', '$.attempts', '$.news.digest', '$.news.settings', '$.news.original.message', '$.news.original.digest') AS json, COALESCE(json_array_length(json, '$.attempts'), 0) AS attempts FROM scheduled_occurrence").all() as (JsonRow & { attempts: number })[];
      for (const row of summaries) {
        const item = JSON.parse(row.json) as ScheduledOccurrence;
        // Import preserves old notice evidence, not a new authorization to notify.
        if (item.news?.original && !row.attempts && (item.news.attempt ?? 0) <= (item.news.original.attempt ?? 0)) continue;
        const task = this.tasks(item.destination).find((candidate) => candidate.id === item.taskId)!;
        if (task.deletedAt !== undefined || (item.kind === "manual" && item.manualPauseGeneration !== undefined && item.manualPauseGeneration !== (task.pauseGeneration ?? 0))) continue;
        if (["failed", "unknown"].includes(item.execution)) {
          const code = item.reason ?? "execution_failed";
          remember(task, item.news?.failureStage === "archive" ? "archive" : item.stage ?? "execution", code, this.recoveryAction(item),
            (item.news?.failureCode ? FAILURE_REASON_LABELS[item.news.failureCode] : undefined) ?? researchFailureCause(code) ?? (code === "output_too_large" ? "内容过长，未生成可推送正文" : item.execution === "failed" ? "生成失败，未生成可推送正文" : "执行中断，结果无法确认"), item.id);
        } else if (item.execution === "succeeded" && !["ready", "sending", "accepted"].includes(item.delivery)) {
          const causes: Partial<Record<ScheduledOccurrence["delivery"], string>> = {
            pending_inbound: "原会话当前不满足推送条件", auth_relogin_required: "原账户需要重新绑定", context_refresh_required: "原会话需要刷新",
            rejected: "渠道明确拒绝本次推送", partial: "部分内容已被渠道接受，后续发送已停止", unknown: "发送结果无法确认",
          };
          remember(task, "delivery", item.delivery, this.recoveryAction(item), causes[item.delivery] ?? item.delivery, item.id);
        }
      }
      for (const notice of this.notifications()) {
        if (notice.delivery === "pending" && !active.has(notice.id)) this.saveNotification({ ...notice, delivery: "suppressed" });
      }
    });
    for (const message of localNewsNotices) {
      try { this.options.dailyNews?.notifyLocal?.("Codex 微信日报需要处理", message); } catch { /* Local notification failure cannot block cached delivery. */ }
    }
  }

  private notificationAllowed(notice: ScheduledNotification): boolean {
    const task = this.tasks(notice.destination).find((item) => item.id === notice.taskId);
    if (!task || task.deletedAt !== undefined) return false;
    const occurrence = this.occurrences().find((item) => item.id === notice.occurrenceId);
    if (occurrence?.kind === "manual" && occurrence.manualPauseGeneration !== undefined && occurrence.manualPauseGeneration !== (task.pauseGeneration ?? 0)) return false;
    return occurrence ? this.deliveryAllowed(task, occurrence) : task.enabled;
  }

  private async notifyFailures(): Promise<void> {
    this.syncNotifications();
    const channel = this.options.channel;
    if (!channel) return;
    while (!this.closed) {
      const notice = this.transaction(() => {
        if (!this.renewWorker()) return undefined;
        const candidate = this.notifications().find((item) => item.delivery === "pending" &&
          this.notificationAllowed(item) &&
          this.currentDelivery(item) === "ready" &&
          !this.occurrences().some((item2) => item2.delivery === "sending" && hash(deliveryAddress(item2)) === hash(deliveryAddress(item))) &&
          !this.notifications().some((item2) => item2.delivery === "sending" && hash(deliveryAddress(item2)) === hash(deliveryAddress(item))));
        if (!candidate) return undefined;
        const claimed: ScheduledNotification = { ...candidate, delivery: "sending", worker: this.worker, pauseGeneration: this.tasks(candidate.destination).find((task) => task.id === candidate.taskId)!.pauseGeneration ?? 0, context: this.deliveryState(candidate) };
        this.saveNotification(claimed); return claimed;
      });
      if (!notice) break;
      const beforeSubmit = () => !this.closed && this.transaction(() => {
        const live = this.notifications().find((item) => item.id === notice.id);
        const state = this.deliveryState(notice);
        return this.renewWorker() && live?.delivery === "sending" && live.worker === this.worker && state.enabled && state.credentialStatus === "usable" &&
          sameContext(state, notice.context!) && this.notificationAllowed(notice) &&
          (this.tasks(notice.destination).find((task) => task.id === notice.taskId)!.pauseGeneration ?? 0) === (notice.pauseGeneration ?? 0);
      });
      let result: SendTextResult;
      try { result = beforeSubmit() ? await channel.send({ ...deliveryAddress(notice), message: notice.message, operationId: `notice:${notice.id}`, beforeSubmit })
        : { ok: false, reason: "context_missing", acceptedSegments: 0 }; }
      catch { result = { ok: false, reason: "unknown" }; }
      if (this.closed) return;
      this.transaction(() => {
        const live = this.notifications().find((item) => item.id === notice.id);
        if (live?.delivery !== "sending" || live.worker !== this.worker) return;
        const task = this.tasks(notice.destination).find((item) => item.id === notice.taskId)!;
        if (result.acceptedSegments === 0 && result.reason === "context_missing" && (!this.notificationAllowed(notice) || (task.pauseGeneration ?? 0) !== (notice.pauseGeneration ?? 0))) {
          this.saveNotification({ ...live, result, delivery: "suppressed" }); return;
        }
        const settlement = deliveryResult(result);
        const delivery = settlement === "accepted" ? "accepted" : settlement === "rejected" ? "rejected" : "unknown";
        this.saveNotification({ ...live, result, delivery });
        if (delivery !== "accepted") this.database.prepare("INSERT INTO scheduled_blocker VALUES (?, ?) ON CONFLICT(recipient) DO UPDATE SET json = excluded.json")
          .run(hash(deliveryAddress(notice)), JSON.stringify({ context: notice.context, reason: "unknown" }));
      });
    }
  }

  private occurrences(): ScheduledOccurrence[] {
    return (this.database.prepare("SELECT json FROM scheduled_occurrence ORDER BY id").all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as ScheduledOccurrence);
  }

  private migrateNotificationPreferences(): void {
    const route = this.options.notificationRoute;
    if (!route?.capturesCreationDestination) return;
    this.transaction(() => {
      for (const task of this.tasks()) {
        if (task.notificationDestination) continue;
        const destination = route.resolve(task.destination);
        if (destination) this.saveTask({ ...task, notificationDestination: destination });
      }
    });
  }

  private scopeState(scope: Destination, preference?: NotificationDestination): ScheduledChannelState {
    const destination = this.options.notificationRoute?.resolve(scope, preference) ?? (this.options.notificationRoute ? undefined : scope);
    return destination ? this.options.channel?.state(destination) ?? unavailableChannel() : unavailableChannel();
  }

  private deliveryState(item: { destination: Destination; deliveryDestination?: NotificationDestination }): ScheduledChannelState {
    const destination = deliveryAddress(item);
    if (this.options.notificationRoute && !this.options.notificationRoute.isSelected(destination)) return unavailableChannel();
    return this.options.channel?.state(destination) ?? unavailableChannel();
  }

  private insertOccurrence(item: ScheduledOccurrence): void {
    if (this.options.notificationRoute) {
      const task = this.tasks(item.destination).find((task) => task.id === item.taskId);
      const destination = this.options.notificationRoute.resolve(item.destination, task?.notificationDestination);
      if (!destination) throw new Error("notification_scope_unbound");
      item.deliveryDestination = destination;
    }
    this.database.prepare("INSERT INTO scheduled_occurrence VALUES (?, ?, ?)").run(item.id, item.taskId, JSON.stringify(item));
  }

  private saveOccurrence(item: ScheduledOccurrence): void {
    this.database.prepare("UPDATE scheduled_occurrence SET json = ? WHERE id = ?").run(JSON.stringify(item), item.id);
  }

  private saveTask(task: ScheduledTask): void {
    this.database.prepare("UPDATE scheduled_task SET json = ? WHERE id = ?").run(JSON.stringify(task), task.id);
  }

  memoryAdmission(intents: OwnedReminderIntent[]): MemoryReminderAdmission {
    const inserted: string[] = [];
    return {
      reserve: (owner) => {
        let intent = intents.find((item) => item.owner === owner);
        if (!intent) return true;
        if (this.options.notificationRoute) {
          const scope = this.options.notificationRoute.memoryScope(intent.accountId, [intent.target]);
          if (!scope) return false;
          intent = { ...intent, ...scope };
        }
        return this.transaction(() => {
          const existing = new Set(this.database.prepare("SELECT id FROM reminder_intent WHERE owner = ?").all(`memory:${owner}`).map((row) => String(row.id)));
          if (!this.reserveIntent(intent, `memory:${owner}`)) return false;
          for (const row of this.database.prepare("SELECT id FROM reminder_intent WHERE owner = ?").all(`memory:${owner}`)) {
            if (!existing.has(String(row.id))) inserted.push(String(row.id));
          }
          return true;
        });
      },
      rollback: (rollbackMemory) => this.transaction(() => {
        for (const id of inserted) this.database.prepare("DELETE FROM reminder_intent WHERE id = ?").run(id);
        // Keep the ownership writer locked until the memory transaction has rolled back.
        rollbackMemory();
      }),
    };
  }

  private reserveIntent(intent: ReminderIntent, owner: string): boolean {
    const start = intent.originalText.indexOf(intent.sourceText), end = start + intent.sourceText.length;
    if (!intent.sourceText.trim() || start < 0 || intent.originalText.lastIndexOf(intent.sourceText) !== start) throw new Error("memory_arguments_invalid");
    const overlapping = this.database.prepare("SELECT owner FROM reminder_intent WHERE account = ? AND target = ? AND event_key = ? AND start < ? AND end > ?")
      .all(intent.accountId, intent.target, intent.eventKey, end, start);
    if (overlapping.some((item) => item.owner !== owner)) return false;
    this.database.prepare("INSERT OR IGNORE INTO reminder_intent VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(hash([intent.accountId, intent.target, intent.eventKey, start, end]), intent.accountId, intent.target, intent.eventKey, start, end, owner);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.previewController?.abort();
    for (const { controller } of this.researchControllers.values()) controller.abort();
    this.resumePump?.();
    this.unsubscribe?.();
    if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.database.prepare("UPDATE scheduled_worker SET expires_at = 0 WHERE id = ?").run(this.worker);
    this.database.close();
  }

  private create(args: Record<string, unknown>, trusted: TrustedWorkflowTurn, notificationDestination?: NotificationDestination): unknown {
    const sourceText = String(args.sourceText);
    const original = this.options.readOriginalText(trusted.originalTextRef);
    const start = original?.indexOf(sourceText) ?? -1;
    if (start < 0 || original!.lastIndexOf(sourceText) !== start) return { status: "error", code: "source_ambiguous" };
    const name = String(args.name).trim(), instruction = String(args.instruction).trim();
    const timezone = String(args.timezone ?? "Asia/Shanghai");
    const instant = args.at === undefined ? undefined : parseInstant(String(args.at));
    try { if (/^[+-]/u.test(timezone)) throw new Error("offset_timezone"); new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
    catch { return { status: "error", code: "timezone_invalid" }; }
    if (!name || !instruction || instant === null) return { status: "error", code: "invalid_settings" };
    if ([args.at, args.delaySeconds, args.intervalSeconds, args.calendar].filter((value) => value !== undefined).length !== 1 || (args.startAt !== undefined && args.intervalSeconds === undefined)) return { status: "error", code: "invalid_settings" };
    const key = hash([trusted.accountId, trusted.target, trusted.eventKey, start, sourceText.length]);
    const requestHash = hash([...(args.template !== undefined ? [args.template] : []), name, instruction, args.delaySeconds !== undefined ? ["delay", args.delaySeconds] : args.calendar !== undefined ? args.calendar : args.intervalSeconds === undefined ? instant : [args.intervalSeconds, args.startAt], timezone, ...(args.reminderText !== undefined || args.reminderMode !== undefined ? [args.reminderText, args.reminderMode] : [])]);
    return this.transaction(() => {
      const previous = this.database.prepare("SELECT hash, json FROM scheduled_operation WHERE id = ?").get(key) as { hash: string; json: string } | undefined;
      if (previous) {
        if (previous.hash !== requestHash) return { status: "error", code: "request_conflict" };
        const receipt = JSON.parse(previous.json) as { task: { id: string } };
        const current = this.tasks(trusted).find((task) => task.id === receipt.task.id);
        return current ? { ...receipt, task: this.taskView(current) } : receipt;
      }
      if (this.options.channel && !this.scopeState(trusted, notificationDestination).enabled) return { status: "error", code: "target_disabled" };
      const content = args.template === "researched_text" ? this.researchSettings(args) : this.reminderSettings(args, sourceText);
      if ("code" in content) return { status: "error", ...content };
      const resolved = this.resolveSchedule(args, timezone);
      if ("code" in resolved) return { status: "error", ...resolved };
      const task: ScheduledTask = {
        id: `task_${crypto.randomUUID()}`, name, instruction, timezone, enabled: true,
        ...content, ...(args.template !== undefined ? { template: args.template as "reminder" | "researched_text" } : {}),
        destination: { accountId: trusted.accountId, target: trusted.target },
        ...(notificationDestination ? { notificationDestination } : {}),
        nextExecutionAt: resolved.next, revision: 1, cadenceRevision: 1,
        schedule: resolved.schedule, createdAt: this.now(), historyComplete: true,
      };
      if (!this.reserveIntent({ accountId: trusted.accountId, target: trusted.target, eventKey: trusted.eventKey,
        originalText: original!, sourceText }, `scheduled:${task.id}`)) return { status: "error", code: "reminder_already_managed" };
      const result = { status: "created", task: this.taskView(task) };
      this.database.prepare("INSERT INTO scheduled_task VALUES (?, ?, ?, ?)").run(task.id, trusted.accountId, trusted.target, JSON.stringify(task));
      this.recordOperation(key, requestHash, result, trusted);
      return result;
    });
  }

  private researchSettings(args: Record<string, unknown>, news = false): Record<string, never> | { code: string } {
    if (args.reminderText !== undefined || args.reminderMode !== undefined) return { code: "invalid_settings" };
    if (news ? !this.options.dailyNews : !this.options.research) return { code: "research_unavailable" };
    return {};
  }

  private reminderSettings(args: Record<string, unknown>, source: string): { reminderText: string; reminderMode: "natural" | "verbatim" } | { code: string } {
    if (typeof args.reminderText !== "string" || !["natural", "verbatim"].includes(String(args.reminderMode))) return { code: "reminder_text_required" };
    if (!args.reminderText.trim()) return { code: "invalid_settings" };
    if (Buffer.byteLength(args.reminderText, "utf8") > this.limits.maxBodyBytes) return { code: "output_too_large" };
    if (args.reminderMode === "verbatim" && !source.includes(args.reminderText)) return { code: "verbatim_source_mismatch" };
    return { reminderText: args.reminderText, reminderMode: args.reminderMode as "natural" | "verbatim" };
  }

  private resolveSchedule(args: Record<string, unknown>, timezone: string): { schedule: Schedule; next: string } | { code: string } {
    if ((args.at !== undefined ? 1 : 0) + (args.delaySeconds !== undefined ? 1 : 0) + (args.intervalSeconds !== undefined ? 1 : 0) + (args.calendar !== undefined ? 1 : 0) !== 1 || (args.startAt !== undefined && args.intervalSeconds === undefined)) return { code: "invalid_settings" };
    if (args.delaySeconds !== undefined) {
      const seconds = Number(args.delaySeconds), instant = this.now() + seconds * 1000;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(seconds * 1000) || !Number.isFinite(new Date(instant).getTime())) return { code: "invalid_settings" };
      const next = new Date(instant).toISOString();
      return { schedule: { kind: "once", at: next }, next };
    }
    if (args.calendar !== undefined) {
      const calendar = args.calendar as { time: string; weekdays?: number[] };
      const schedule: Schedule = { kind: "calendar", time: calendar.time, weekdays: [...(calendar.weekdays ?? [0, 1, 2, 3, 4, 5, 6])].sort() };
      const next = nextInstant(schedule, this.now(), timezone)!;
      // Daily/weekly rules have minute precision. For a stricter configured bound,
      // check a full seasonal cycle, including timezone transitions.
      if (this.limits.minimumRecurringSeconds > 60) {
        let previous = Date.parse(next);
        const end = previous + 370 * 86_400_000;
        while (previous < end) {
          const following = Date.parse(nextInstant(schedule, previous, timezone)!);
          if (following - previous < this.limits.minimumRecurringSeconds * 1000) return { code: "interval_too_short" };
          previous = following;
        }
      }
      return { schedule, next };
    }
    if (args.intervalSeconds !== undefined) {
      const seconds = Number(args.intervalSeconds);
      if (!Number.isSafeInteger(seconds * 1000)) return { code: "invalid_settings" };
      if (seconds < this.limits.minimumRecurringSeconds) return { code: "interval_too_short" };
      const first = args.startAt === undefined ? this.now() + seconds * 1000 : parseInstant(String(args.startAt));
      if (first === null || !Number.isFinite(new Date(first).getTime()) || !Number.isFinite(new Date(first + seconds * 1000).getTime())) return { code: "invalid_settings" };
      if (first <= this.now()) return { code: "time_in_past" };
      const next = new Date(first).toISOString();
      return { schedule: { kind: "interval", everySeconds: seconds, firstAt: next }, next };
    }
    const instant = parseInstant(String(args.at));
    if (instant === null) return { code: "invalid_settings" };
    if (instant <= this.now()) return { code: "time_in_past" };
    const next = new Date(instant).toISOString();
    return { schedule: { kind: "once", at: next }, next };
  }

  private manage(tool: string, args: Record<string, unknown>, trusted: TrustedWorkflowTurn, notificationDestination?: NotificationDestination): unknown {
    const source = String(args.sourceText), original = this.options.readOriginalText(trusted.originalTextRef);
    const start = original?.indexOf(source) ?? -1;
    if (start < 0 || !source.trim() || original!.lastIndexOf(source) !== start) return { status: "error", code: "source_ambiguous" };
    const key = hash([trusted.accountId, trusted.target, trusted.eventKey, tool, start, source.length]);
    const requestHash = hash([args.reference, args.expectedRevision, args.name, args.instruction, args.at, args.timezone, ...(args.delaySeconds !== undefined ? ["delay", args.delaySeconds] : []), ...(args.intervalSeconds !== undefined || args.startAt !== undefined || args.calendar !== undefined ? [args.intervalSeconds, args.startAt, args.calendar] : []), ...(args.reminderText !== undefined || args.reminderMode !== undefined ? [args.reminderText, args.reminderMode] : [])]);
    const admitted: Array<{ task: ScheduledTask; occurrence: ScheduledOccurrence }> = [];
    const result = this.transaction(() => {
      const previous = this.database.prepare("SELECT hash, json FROM scheduled_operation WHERE id = ?").get(key) as { hash: string; json: string } | undefined;
      if (previous) {
        if (previous.hash !== requestHash) return { status: "error", code: "request_conflict" };
        const receipt = JSON.parse(previous.json) as { task: { id: string } };
        const current = this.tasks(trusted).find((task) => task.id === receipt.task.id)!;
        return { ...receipt, replayed: true, task: this.taskView(current) };
      }
      if (this.options.channel && !this.scopeState(trusted, notificationDestination).enabled) return { status: "error", code: "target_disabled" };
      const matches = this.tasks(trusted).filter((task) => task.id === args.reference || task.name === args.reference);
      if (!matches.length && this.newsReconciliation(trusted)) return this.newsReconciliation(trusted);
      if (matches.length !== 1) return { status: matches.length ? "needs_choice" : "not_found", ...this.taskPage(matches, 0, 5) };
      const task = matches[0]!;
      if (task.template === "daily_ai_news" && this.options.dailyNewsActive && !this.options.dailyNewsActive()) return { status: "blocked", code: "daily_news_reconciliation_pending", task: this.taskView(task) };
      if (task.deletedAt !== undefined) return { status: "error", code: "task_deleted", task: this.taskView(task) };
      if (task.revision !== args.expectedRevision) return { status: "conflict", code: "revision_conflict", task: this.taskView(task) };
      if (tool === "schedules.delete") {
        const occurrences = this.occurrences().filter((item) => item.taskId === task.id);
        if (occurrences.some((item) => item.execution === "running" || item.delivery === "sending") || this.notifications().some((item) => item.taskId === task.id && item.delivery === "sending")) {
          return { status: "busy", code: "task_busy", action: "任务正在执行或提交，暂不能删除；请先停用，等待结果确定后再删除。" };
        }
        const deleted = { ...task, enabled: false, nextExecutionAt: null, deletedAt: this.now(), revision: task.revision + 1 };
        delete deleted.blocker;
        this.saveTask(deleted);
        this.stopNewsRetries(deleted);
        for (const item of occurrences) if (isPending(item)) this.saveOccurrence({ ...item, delivery: "cancelled", reason: "cancelled_by_task_deletion" });
        for (const item of this.notifications()) if (item.taskId === task.id && item.delivery === "pending") this.saveNotification({ ...item, delivery: "suppressed" });
        const receipt = { status: "deleted", task: this.taskView(deleted) };
        this.recordOperation(key, requestHash, receipt, trusted);
        return receipt;
      }
      if (tool === "schedules.retry_news") {
        let claim: { task: ScheduledTask; occurrence: ScheduledOccurrence };
        try { claim = this.admitNewsRetry(task, admitted); }
        catch (error) { return { status: "blocked", code: error instanceof Error ? error.message : "daily_news_retry_unavailable", action: "请查看日报状态和执行名额，容量不足时等待较早任务完成；已缓存正文会按会话恢复续发，未知或已接受结果不会重发。" }; }
        admitted.push(claim);
        const receipt = { status: "started", occurrenceId: claim.occurrence.id, task: this.taskView(task) };
        this.recordOperation(key, requestHash, receipt, trusted);
        return receipt;
      }
      if (tool === "schedules.run_now") {
        if (task.template === "daily_ai_news" && this.newsOwner().previewWork?.status === "running") return { status: "busy", code: "task_busy", action: "日报预览正在生成，请等待结束后再执行一次。" };
        if (!this.renewWorker()) return { status: "error", code: "worker_fenced" };
        if (this.occurrences().some((item) => item.taskId === task.id && (item.execution === "running" || item.delivery === "sending"))) return { status: "busy", code: "task_busy", action: "任务正在执行或提交消息；请等待结果后再执行一次。" };
        const before = { plannedAt: new Date(this.now()).toISOString(), taskId: task.id };
        while (true) {
          const earlier = this.claimAutomatic(new Set(), before);
          if (!earlier) break;
          admitted.push(earlier);
        }
        if (admitted.some((claim) => claim.task.id === task.id)) return { status: "busy", code: "task_busy", action: "该任务较早的计划执行已领取；请等待结果后再执行一次。" };
        if (this.activeGenerations() >= 2) return { status: "blocked", code: "execution_capacity", action: "正在执行的任务达到上限，请稍后再试。" };
        const usage = this.capacity(task.destination), l = this.limits;
        if (usage.recipientCount + 1 > l.recipientPendingCount || usage.recipientBytes + l.maxBodyBytes > l.recipientPendingBytes ||
            usage.globalCount + 1 > l.globalPendingCount || usage.globalBytes + l.maxBodyBytes > l.globalPendingBytes) {
          return { status: "blocked", code: "pending_capacity", usage, limits: l, action: "请先恢复缓存推送或删除不再需要的任务，释放容量后再试。" };
        }
        const occurrence: ScheduledOccurrence = { id: `${task.id}:manual:${key}`, taskId: task.id, revision: task.revision,
          plannedAt: new Date(this.now()).toISOString(), claimedAt: this.now(), destination: task.destination,
          ...(task.template === "researched_text" ? { stage: "research" as const } : {}),
          kind: "manual", manualPauseGeneration: task.pauseGeneration ?? 0,
          ...(task.template === "daily_ai_news" ? { news: { runKey: newsDate(this.now()), settings: { name: task.name, instruction: task.instruction, timezone: task.timezone } } } : {}),
          execution: "running", delivery: "not_generated", worker: this.worker, reservedBytes: l.maxBodyBytes };
        this.insertOccurrence(occurrence);
        const receipt = { status: "started", occurrenceId: occurrence.id, task: this.taskView(task) };
        this.recordOperation(key, requestHash, receipt, trusted);
        admitted.push({ task, occurrence });
        return receipt;
      }
      if (tool === "schedules.disable" || tool === "schedules.enable") {
        if (tool === "schedules.enable" && task.schedule.kind === "once" && !task.enabled && task.nextExecutionAt && Date.parse(task.nextExecutionAt) <= this.now()) {
          return { status: "needs_input", code: "overdue_once", task: this.taskView(task), action: "停用期间已错过执行时间；请设置新的未来时间，或明确现在执行一次。" };
        }
        const updated = { ...task, enabled: tool === "schedules.enable", revision: task.revision + 1,
          pauseGeneration: (task.pauseGeneration ?? 0) + (tool === "schedules.disable" ? 1 : 0) };
        if (updated.enabled && !task.enabled && task.schedule.kind !== "once") updated.nextExecutionAt = nextInstant(task.schedule, this.now(), task.timezone);
        delete updated.blocker;
        this.saveTask(updated);
        if (!updated.enabled) this.stopNewsRetries(updated);
        const result = { status: updated.enabled ? "enabled" : "disabled", task: this.taskView(updated) };
        this.recordOperation(key, requestHash, result, trusted);
        return result;
      }
      const changesContent = args.instruction !== undefined || args.reminderText !== undefined || args.reminderMode !== undefined;
      const content = changesContent ? (task.template === "researched_text" || task.template === "daily_ai_news" ? this.researchSettings(args, task.template === "daily_ai_news") : this.reminderSettings(args, source)) : undefined;
      if (content && "code" in content) return { status: "error", ...content };
      if (changesContent && args.instruction === undefined) return { status: "error", code: "instruction_required" };
      const name = args.name === undefined ? task.name : String(args.name).trim();
      const instruction = args.instruction === undefined ? task.instruction : String(args.instruction).trim();
      const timezone = args.timezone === undefined ? task.timezone : String(args.timezone);
      const changesSchedule = args.at !== undefined || args.delaySeconds !== undefined || args.intervalSeconds !== undefined || args.startAt !== undefined || args.calendar !== undefined || (args.timezone !== undefined && timezone !== task.timezone && task.schedule.kind === "calendar");
      if (!name || !instruction || ![args.name, args.instruction, args.at, args.delaySeconds, args.timezone, args.intervalSeconds, args.startAt, args.calendar].some((value) => value !== undefined)) return { status: "error", code: "invalid_settings" };
      try { if (/^[+-]/u.test(timezone)) throw new Error("offset_timezone"); new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
      catch { return { status: "error", code: "timezone_invalid" }; }
      const scheduleArgs = task.schedule.kind === "calendar" && args.at === undefined && args.delaySeconds === undefined && args.intervalSeconds === undefined && args.calendar === undefined
        ? { ...args, calendar: { time: task.schedule.time, weekdays: task.schedule.weekdays } } : args;
      const resolved = changesSchedule ? this.resolveSchedule(scheduleArgs, timezone) : undefined;
      if (resolved && "code" in resolved) return { status: "error", ...resolved };
      if (changesSchedule && task.schedule.kind === "once" && (task.automaticClaimed || this.occurrences().some((item) => item.id === `${task.id}:once`))) return { status: "error", code: "schedule_exhausted", action: "一次性计划已领取；请另建提醒或明确执行一次。" };
      const updated: ScheduledTask = { ...task, ...content, name, instruction, timezone, revision: task.revision + 1,
        ...(resolved ? { schedule: resolved.schedule, nextExecutionAt: resolved.next, cadenceRevision: (task.cadenceRevision ?? 1) + 1 } : {}) };
      if (resolved) delete updated.blocker;
      this.saveTask(updated);
      const result = { status: "updated", task: this.taskView(updated) };
      this.recordOperation(key, requestHash, result, trusted);
      return result;
    });
    this.executionQueue.push(...admitted);
    return result;
  }

  private taskPage(tasks: ScheduledTask[], offset: number, limit: number) {
    const page: ReturnType<ScheduledTasks["taskView"]>[] = [];
    let bytes = 0;
    for (const task of tasks.slice(offset, offset + limit)) {
      const view = this.taskView(task, true), size = Buffer.byteLength(JSON.stringify(view), "utf8");
      if (bytes + size > 60_000) break;
      page.push(view); bytes += size;
    }
    return { tasks: page, total: tasks.length, ...(offset + page.length < tasks.length ? { nextOffset: offset + page.length } : {}) };
  }

  private taskOccurrence(task: ScheduledTask): ScheduledOccurrence | undefined {
    const row = this.database.prepare(`SELECT json FROM scheduled_occurrence WHERE task_id = ? AND json_extract(json, '$.execution') != 'skipped'
      ORDER BY CASE
        WHEN json_extract(json, '$.execution') = 'running' THEN 0
        WHEN json_extract(json, '$.delivery') = 'sending' THEN 1
        WHEN json_extract(json, '$.execution') = 'succeeded' AND json_extract(json, '$.delivery') IN ('ready', 'pending_inbound', 'auth_relogin_required', 'context_refresh_required') THEN 2
        WHEN json_extract(json, '$.execution') != 'succeeded' OR json_extract(json, '$.delivery') NOT IN ('accepted', 'cancelled') THEN 3
        ELSE 4 END, json_extract(json, '$.plannedAt') DESC, id DESC LIMIT 1`).get(task.id) as JsonRow | undefined;
    const all = row ? [JSON.parse(row.json) as ScheduledOccurrence] : [];
    if (task.historyIssue) all.push(task.historyIssue);
    const priority = (item: ScheduledOccurrence) => item.execution === "running" ? 0 : item.delivery === "sending" ? 1 : isPending(item) ? 2
      : item.execution !== "succeeded" || !["accepted", "cancelled"].includes(item.delivery) ? 3 : 4;
    return all.sort((a, b) => priority(a) - priority(b) || b.plannedAt.localeCompare(a.plannedAt) || b.id.localeCompare(a.id))[0];
  }

  private taskLifecycle(task: ScheduledTask, occurrence = this.taskOccurrence(task)): "scheduled" | "running" | "pending_delivery" | "sending" | "completed" | "failed" | "partial" | "rejected" | "unknown" | "deleted" {
    if (task.deletedAt !== undefined) return "deleted";
    if (occurrence?.execution === "running") return "running";
    if (occurrence?.execution === "failed") return "failed";
    if (occurrence?.execution === "unknown") return "unknown";
    if (!occurrence) return task.nextExecutionAt ? "scheduled" : "unknown";
    switch (occurrence.delivery) {
      case "accepted": return task.nextExecutionAt === null ? "completed" : "scheduled";
      case "sending": case "partial": case "rejected": case "unknown": return occurrence.delivery;
      case "ready": case "pending_inbound": case "auth_relogin_required": case "context_refresh_required": return "pending_delivery";
      case "not_generated": case "cancelled": return "unknown";
    }
  }

  private taskView(task: ScheduledTask, concise = false) {
    const { instruction, reminderText, ...settings } = task;
    const reminderBytes = reminderText === undefined ? 0 : Buffer.byteLength(JSON.stringify(reminderText), "utf8");
    const showReminder = !concise && reminderText !== undefined && reminderBytes < 16000;
    // Share the existing preview budget; history needs the remainder of the tool result.
    const instructionBudget = 16000 - (showReminder ? reminderBytes : 0);
    const state = this.options.channel ? this.scopeState(task.destination, task.notificationDestination) : undefined;
    const currentBlocker = task.template === "daily_ai_news" && this.options.dailyNewsActive && !this.options.dailyNewsActive()
      ? { code: "daily_news_reconciliation_pending", action: "日报迁移尚待核对，当前不会执行或推送。" }
      : state && !state.enabled && task.nextExecutionAt
      ? { code: "target_disabled", action: "请先启用原账户和接收会话；任务尚未开始执行。" }
      : task.blocker;
    const occurrence = this.taskOccurrence(task);
    return { ...settings, pauseGeneration: task.pauseGeneration ?? 0, deliveryEligibility: task.deletedAt !== undefined ? "deleted" : task.enabled ? "enabled" : occurrence && this.deliveryAllowed(task, occurrence) && (occurrence.execution === "running" || occurrence.delivery === "sending" || isPending(occurrence)) ? "manual_authorized" : "paused", lifecycle: this.taskLifecycle(task, occurrence),
      ...(occurrence ? { delivery: occurrence.delivery, recoveryAction: this.recoveryAction(occurrence) } : {}),
      ...(currentBlocker ? { currentBlocker } : {}), instructionAvailable: true, instructionCharacters: Array.from(instruction).length,
      ...(!concise && Buffer.byteLength(JSON.stringify(instruction), "utf8") < instructionBudget ? { instruction } : {}),
      reminderTextAvailable: reminderText !== undefined,
      ...(reminderText !== undefined ? { reminderTextCharacters: Array.from(reminderText).length,
        ...(showReminder ? { reminderText } : {}) } : {}) };
  }

  private tasks(destination?: Destination): ScheduledTask[] {
    const rows = (destination
      ? this.database.prepare("SELECT json FROM scheduled_task WHERE account = ? AND target = ? ORDER BY id").all(destination.accountId, destination.target)
      : this.database.prepare("SELECT json FROM scheduled_task ORDER BY id").all()) as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as ScheduledTask);
  }

  private transaction<T>(fn: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

function hash(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function parseInstant(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return null;
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1] || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function isPending(item: ScheduledOccurrence): boolean {
  return item.execution === "succeeded" && ["ready", "pending_inbound", "auth_relogin_required", "context_refresh_required"].includes(item.delivery);
}
function sameContext(a: ScheduledChannelState, b: ScheduledChannelState): boolean {
  return a.credentialGeneration === b.credentialGeneration && a.contextGeneration === b.contextGeneration;
}
function deliveryResult(result: SendTextResult): ScheduledOccurrence["delivery"] {
  if (result.ok && !result.truncated) return "accepted";
  if ((result.acceptedSegments ?? 0) > 0) return "partial";
  if (result.reason === "rejected") return "rejected";
  if (result.acceptedSegments !== 0) return "unknown";
  if (result.reason === "auth_stale") return "auth_relogin_required";
  if (result.reason === "context_stale") return "context_refresh_required";
  if (result.reason === "context_missing") return "pending_inbound";
  return "unknown";
}

function researchFailureCause(code: string): string | undefined {
  return ({ research_timeout: "研究超时，已停止本次执行，没有可推送报告", research_cancelled: "研究已因关闭或权限变化停止，没有可推送报告",
    research_unavailable: "研究执行器不可用，请检查服务配置", research_start_failed: "研究进程无法启动，请检查本机 Codex 安装",
    research_runtime_unavailable: "网页研究运行环境不可用，请检查 Code Mode 宿主配置；没有可推送报告",
    research_usage_limit: "Codex 使用额度不足，请等待额度恢复", research_rate_limit: "研究请求受到限流，请稍后明确执行一次",
    research_search_missing: "未取得实际网页搜索记录，没有生成可信报告", research_output_invalid: "研究结果或来源格式无效，没有可推送报告",
    research_source_read_missing: "未取得实际原文阅读记录，没有生成可信报告",
    research_failed: "研究进程执行失败，没有可推送报告" } as Record<string, string>)[code];
}

function deliveryAddress(item: { destination: Destination; deliveryDestination?: NotificationDestination }): NotificationDestination {
  const destination: NotificationDestination = item.deliveryDestination ?? item.destination;
  return { accountId: destination.accountId, target: destination.target, ...(destination.senderAccountId ? { senderAccountId: destination.senderAccountId } : {}), ...(destination.channel === "feishu" ? { channel: "feishu" as const } : {}) };
}
function unavailableChannel(): ScheduledChannelState {
  return { enabled: false, credentialStatus: "stale", credentialGeneration: "unavailable", contextGeneration: null };
}
