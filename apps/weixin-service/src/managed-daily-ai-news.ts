import { formatNewsDigest, type DailyRunStatus, type PublicDailyAiNewsState } from "./daily-ai-news-scheduler.js";
import { newsDate } from "./daily-news-import.js";
import type { ScheduledTasks, ScheduledOccurrence } from "./scheduled-tasks.js";

/** Compatibility controls project the common owner; this class has no timer or sender. */
export class ManagedDailyAiNews {
  constructor(private readonly tasks: ScheduledTasks) {}
  async enable(accountId: string, target: string): Promise<void> { this.tasks.setDailyNewsEnabled({ accountId, target }, true); }
  disable(): void {
    const snapshot = this.tasks.newsSnapshot();
    const destination = this.getPublicState().enabledTarget ?? snapshot.owner?.state.enabledTarget;
    if (destination) this.tasks.setDailyNewsEnabled(destination, false);
  }
  getPublicState(): PublicDailyAiNewsState {
    const snapshot = this.tasks.newsSnapshot(), owner = snapshot.owner;
    const destination = owner?.state.enabledTarget;
    const selected = snapshot.tasks.find((item) => item.destination.accountId === destination?.accountId && item.destination.target === destination.target);
    const task = selected?.enabled && selected.deletedAt === undefined ? selected
      : snapshot.tasks.find((item) => item.enabled && item.deletedAt === undefined) ?? selected ?? snapshot.tasks.at(-1);
    const runs = snapshot.occurrences.filter((item) => item.taskId === task?.id && item.execution !== "skipped").sort((a, b) => a.plannedAt.localeCompare(b.plannedAt) || a.id.localeCompare(b.id));
    const last = runs.at(-1), enabled = Boolean(snapshot.active && task?.enabled && task.deletedAt === undefined);
    const pending = runs.filter((item) => item.execution === "succeeded" && ["ready", "pending_inbound", "context_refresh_required", "auth_relogin_required"].includes(item.delivery));
    const preview = owner?.state.preview;
    const retry = runs.flatMap((item) => item.execution === "failed" && item.news?.runKey === newsDate(snapshot.now) && item.news.nextRetryAt !== undefined ? [item.news.nextRetryAt] : []);
    const next = enabled && task?.nextExecutionAt ? Math.min(Date.parse(task.nextExecutionAt), ...retry) : null;
    return { status: owner?.previewReady ? "ready" : !owner || !enabled ? "disabled" : owner.previewWork?.status === "running" ? "researching" : last ? newsStatus(last) : "idle",
      enabledTarget: enabled && task ? task.destination : null, nextRunAt: next,
      lastRun: last ? { runKey: last.news?.runKey ?? last.id, status: newsStatus(last), updatedAt: last.news?.lastFailure?.at ?? last.claimedAt ?? Date.parse(last.plannedAt),
        ...((last.news?.digest?.sources ?? last.news?.sources) ? { sources: last.news!.digest?.sources ?? last.news!.sources } : {}),
        ...(last.news?.archiveWork ? { archiveWork: last.news.archiveWork } : {}),
        ...(last.news?.attempt !== undefined ? { attempt: last.news.attempt } : {}),
        ...(last.news?.failureStage ? { failureStage: last.news.failureStage } : {}),
        ...(last.news?.failureCode ? { failureCode: last.news.failureCode } : {}),
        ...(last.news?.nextRetryAt !== undefined ? { nextRetryAt: last.news.nextRetryAt } : {}),
        ...(last.news?.lastFailure ? { lastFailure: last.news.lastFailure } : {}) } : null,
      preview: preview ? { date: preview.date, generatedAt: preview.generatedAt, items: preview.items.map((item) => ({
        ...(item.section ? { section: item.section } : {}), title: item.title, summary: item.summary, source: item.source, publishedAt: item.publishedAt })) } : null,
      previewMessage: preview ? formatNewsDigest(preview) : null, archive: owner?.archive ?? null,
      notice: !owner || !snapshot.active ? "日报迁移待核对：旧调度尚未完成停止与所有权交接，日报不会执行或推送。"
        : pending.length ? `已缓存 ${pending.length} 份日报，最早为 ${pending[0]!.news?.runKey ?? pending[0]!.plannedAt}。${task?.recoveryAction ?? ""}`
        : owner.previewReady ? "已生成 AI 新闻预览，尚未发送微信。"
        : !enabled ? "每日 AI 新闻已停用。" : task?.recoveryAction ?? "每日 AI 新闻已启用，等待下次后台运行。" };
  }
  async preview(): Promise<void> { await this.tasks.previewDailyNews(); }
  async sendPreview(accountId: string, target: string): Promise<void> { await this.tasks.sendDailyNewsPreview({ accountId, target }); }
  async retryNow(): Promise<void> {
    const destination = this.getPublicState().enabledTarget;
    if (!destination) throw new Error("daily_news_retry_unavailable");
    await this.tasks.retryDailyNews(destination);
  }
  close(): void { /* The common scheduler owns its own lifetime. */ }
}
function newsStatus(item: ScheduledOccurrence): DailyRunStatus {
  if (item.execution === "running") return "researching";
  if (item.execution === "failed") return "failed";
  if (item.execution === "unknown") return "unknown";
  return ["not_generated", "cancelled"].includes(item.delivery) ? "failed" : item.delivery as DailyRunStatus;
}
