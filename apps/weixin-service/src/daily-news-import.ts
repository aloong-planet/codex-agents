import crypto from "node:crypto";
import type { DailyAiNewsRun, DailyAiNewsState, PublicDailyAiNewsState, NewsDigest } from "./daily-ai-news-scheduler.js";
import type { ScheduledOccurrence, ScheduledTask } from "./scheduled-tasks.js";
import { nextInstant } from "./scheduled-time.js";

export const DAILY_NEWS_INSTRUCTION = "检索过去24小时 AI 新闻和 Hacker News 热门技术，核验来源、生成完整中文摘要并写入本地归档。";
export type ScheduledNewsOwner = { phase: "committed"; importedAt: number;
  state: DailyAiNewsState & { previewInstruction?: string }; previewReady?: boolean;
  previewWork?: { worker: string; status: "running" | "succeeded" | "failed" | "unknown" };
  archive?: PublicDailyAiNewsState["archive"];
  previewArchives?: Array<{ id: string; scope: string; digest: NewsDigest; work: NewsArchiveWork }>;
};
export type DailyNewsImport = { state: DailyAiNewsState; sourceHash: string };
export type NewsArchiveWork = {
  status: "pending" | "running" | "succeeded" | "failed"; attempts: number; nextRetryAt?: number; worker?: string; errorCode?: string;
};
export type ScheduledNewsMetadata = {
  archiveWork?: NewsArchiveWork;
  sources?: NewsDigest["sources"];
  sourceProgress?: Partial<Record<"general" | "hackernews", { status: string; code?: string }>>;
  runKey: string; oneShotPreview?: boolean; attempt?: number; digest?: DailyAiNewsRun["digest"];
  failureStage?: DailyAiNewsRun["failureStage"]; failureCode?: DailyAiNewsRun["failureCode"];
  lastFailure?: DailyAiNewsRun["lastFailure"]; nextRetryAt?: number;
  original?: DailyAiNewsRun;
  explicitRetry?: { nextRetryAt?: number };
  settings?: Pick<ScheduledTask, "name" | "instruction" | "timezone">;
};
export function dailyNewsTaskId(destination: { accountId: string; target: string }): string {
  return `news_${crypto.createHash("sha256").update(JSON.stringify([destination.accountId, destination.target])).digest("hex").slice(0, 40)}`;
}
export function newsDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}

export function importedDailyNews(state: DailyAiNewsState, now: number): { tasks: ScheduledTask[]; occurrences: ScheduledOccurrence[] } {
  const destinations = new Map<string, { accountId: string; target: string }>();
  for (const value of [...state.runs, ...(state.enabledTarget ? [state.enabledTarget] : [])]) {
    const destination = { accountId: value.accountId, target: value.target };
    destinations.set(dailyNewsTaskId(destination), destination);
  }
  const tasks: ScheduledTask[] = [], occurrences: ScheduledOccurrence[] = [];
  for (const [id, destination] of destinations) {
    const runs = state.runs.filter((run) => run.accountId === destination.accountId && run.target === destination.target);
    const enabled = state.enabledTarget?.accountId === destination.accountId && state.enabledTarget.target === destination.target;
    const schedule = { kind: "calendar" as const, time: "08:30", weekdays: [0, 1, 2, 3, 4, 5, 6] };
    const today = newsDate(now), todayAt = new Date(`${today}T08:30:00+08:00`).toISOString();
    tasks.push({ id, name: "AI 新闻日报", instruction: DAILY_NEWS_INSTRUCTION,
      template: "daily_ai_news", timezone: "Asia/Shanghai", destination, enabled,
      schedule, revision: 1, cadenceRevision: 1, createdAt: Math.min(state.enabledTarget?.enabledAt ?? now, ...runs.map((run) => run.createdAt)),
      nextExecutionAt: enabled && Date.parse(todayAt) <= now && !runs.some((run) => run.runKey === today)
        ? todayAt : nextInstant(schedule, now, "Asia/Shanghai") });
    for (const run of runs) {
      const generated = run.message !== undefined && !["failed", "researching"].includes(run.status);
      const execution = generated ? "succeeded" : run.status === "failed" ? "failed" : "unknown";
      const delivery: ScheduledOccurrence["delivery"] = run.status === "sending" ? "unknown"
        : generated ? run.status === "ready" ? "ready"
          : ["accepted", "partial", "pending_inbound", "context_refresh_required", "auth_relogin_required", "rejected", "unknown"].includes(run.status)
            ? run.status as ScheduledOccurrence["delivery"] : "unknown" : "not_generated";
      occurrences.push({ id: `${id}:legacy:${run.runKey}`, taskId: id, revision: 1, destination,
        plannedAt: new Date(run.runKey.startsWith("manual-") ? run.createdAt : `${run.runKey}T08:30:00+08:00`).toISOString(),
        kind: run.runKey.startsWith("manual-") ? "manual" : "automatic",
        execution, delivery, stage: "research", worker: "legacy-daily-news",
        ...(run.message !== undefined ? { body: run.message } : {}),
        ...(run.error ? { reason: run.error } : {}),
        news: { runKey: run.runKey, original: structuredClone(run),
          ...(run.attempt !== undefined ? { attempt: run.attempt } : {}),
          ...(run.digest ? { digest: run.digest } : {}),
          ...(run.failureStage ? { failureStage: run.failureStage } : {}),
          ...(run.failureCode ? { failureCode: run.failureCode } : {}),
          ...(run.lastFailure ? { lastFailure: run.lastFailure } : {}),
          ...(run.nextRetryAt !== undefined ? { nextRetryAt: run.nextRetryAt } : {}) } });
    }
  }
  return { tasks, occurrences };
}
