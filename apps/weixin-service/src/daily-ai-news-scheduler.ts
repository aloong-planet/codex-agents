import type { ArticleBodyLoader } from "./news-archive.js";
import { newsSourceWarning, type NewsSourceStatus } from "./news-source.js";
import type { NewsArticleProcessor } from "./news-article-store.js";
import type {
  ChannelSnapshot,
  InboundTextEvent,
  SendTextResult,
} from "./demo-service.js";
import { articleKey } from "./news-article-identity.js";
import { parseNewsBrief } from "./news-summary.js";

export type NewsItem = {
  section?: "general" | "hackernews";
  title: string;
  summary: string;
  brief?: string;
  source: string;
  url: string;
  publishedAt: string;
};

export type NewsSelection = { generalCount: number; hackerNewsCount: number };

export type NewsDigest = {
  selection?: NewsSelection;
  sources?: Partial<Record<"general" | "hackernews", NewsSourceStatus>>;
  date: string;
  generatedAt: number;
  items: NewsItem[];
  hackerNewsTop?: HackerNewsTopItem[];
  hackerNewsTopCapturedAt?: number;
};

export type HackerNewsTopItem = {
  rank: number;
  title: string;
  source: string;
  url: string;
  submittedAt: string;
  score: number;
  comments: number;
  status: "summarized" | "historical_duplicate" | "unreadable_or_unverified" | "not_selected";
};

export type PublicNewsDigest = Omit<NewsDigest, "items" | "hackerNewsTop" | "hackerNewsTopCapturedAt"> & {
  items: Array<Omit<NewsItem, "url">>;
};

export type NewsResearchWindow = {
  selection?: NewsSelection;
  articles?: NewsArticleProcessor;
  selectedArticleKeys?: string[];
  checkpoint?: (digest: NewsDigest) => void;
  observe?: (event: string, attributes: Record<string, unknown>) => void;
  instruction?: string;
  signal?: AbortSignal;
  date: string;
  windowStart: number;
  windowEnd: number;
  excludedArticleKeys?: string[];
};

export type DailyRunStatus =
  | "researching"
  | "ready"
  | "sending"
  | "accepted"
  | "partial"
  | "pending_inbound"
  | "context_refresh_required"
  | "auth_relogin_required"
  | "rejected"
  | "unknown"
  | "failed";

export type FailureNoticeStatus =
  | "accepted"
  | "pending_inbound"
  | "context_refresh_required"
  | "unknown"
  | "failed";

export type DailyAiNewsFailureStage = "research" | "archive" | "configuration";
export type DailyAiNewsFailureCode =
  | "codex_usage_limit"
  | "codex_rate_limit"
  | "codex_process"
  | "research_timeout"
  | "network_unavailable"
  | "insufficient_search"
  | "invalid_result"
  | "hacker_news"
  | "research_unknown"
  | "article_capacity"
  | "result_store_unavailable"
  | "archive_unavailable"
  | "target_changed";

export type DailyAiNewsRun = {
  runKey: string;
  accountId: string;
  target: string;
  status: DailyRunStatus;
  createdAt: number;
  updatedAt: number;
  message?: string;
  digest?: NewsDigest;
  error?: string;
  sendFailureReason?: SendTextResult["reason"];
  deliveryContextUpdatedAt?: number;
  providerRet?: number;
  providerErrcode?: number;
  attempt?: number;
  failureStage?: DailyAiNewsFailureStage;
  failureCode?: DailyAiNewsFailureCode;
  nextRetryAt?: number;
  lastFailure?: {
    stage: DailyAiNewsFailureStage;
    code: DailyAiNewsFailureCode;
    attempt: number;
    at: number;
  };
  failureNotice?: {
    status: FailureNoticeStatus;
    updatedAt: number;
    message?: string;
  };
};

export type DailyAiNewsState = {
  version: 2;
  enabledTarget: { accountId: string; target: string; enabledAt: number } | null;
  runs: DailyAiNewsRun[];
  seenItemKeys: string[];
  summarizedArticleKeys: string[];
  preview: NewsDigest | null;
};

export interface DailyAiNewsStore {
  load(): DailyAiNewsState;
  save(state: DailyAiNewsState): void;
}

export interface AiNewsResearcher {
  generate(window: NewsResearchWindow): Promise<NewsDigest>;
}

export interface NewsDigestArchive {
  archive(digest: NewsDigest, context?: { loadBody: ArticleBodyLoader; signal: AbortSignal; snapshotId: string; active: () => boolean }): Promise<unknown>;
}

export function isValidHackerNewsSelection(digest: NewsDigest): boolean {
  if (!digest.hackerNewsTop || digest.hackerNewsTop.length > (digest.selection?.hackerNewsCount ?? 5) ||
    !digest.hackerNewsTop.every((item) => item.status === "summarized" && item.rank >= 1 && item.rank <= 10)
  ) return false;
  const topKeys = new Set(digest.hackerNewsTop.map((item) => articleKey(item.url)));
  const ranks = new Set(digest.hackerNewsTop.map((item) => item.rank));
  const summaryKeys = new Set(
    digest.items
      .filter((item) => item.section === "hackernews")
      .map((item) => articleKey(item.url)),
  );
  return ranks.size === digest.hackerNewsTop.length &&
    topKeys.size === digest.hackerNewsTop.length && summaryKeys.size === digest.hackerNewsTop.length &&
    [...topKeys].every((key) => summaryKeys.has(key));
}

export function removeSeenItems(digest: NewsDigest, seen: Set<string>): NewsDigest {
  const items = digest.items.filter((item) => (digest.selection !== undefined && item.section === "hackernews") || !seen.has(itemKey(item)));
  const sources = digest.sources ? { ...digest.sources } : undefined;
  if (sources?.general?.requested !== undefined) {
    const selected = items.filter((item) => (item.section ?? "general") === "general").length;
    sources.general = { ...sources.general, selected,
      ...(selected < (sources.general.selected ?? 0) ? { status: selected ? "degraded" : "empty", code: sources.general.code ?? "already_delivered" } : {}) };
  }
  if (digest.hackerNewsTop === undefined) return { ...digest, items, ...(sources ? { sources } : {}) };
  const keptHackerNewsKeys = new Set(
    items
      .filter((item) => item.section === "hackernews")
      .map((item) => articleKey(item.url)),
  );
  return {
    ...digest,
    items,
    ...(sources ? { sources } : {}),
    hackerNewsTop: digest.hackerNewsTop.filter((item) =>
      keptHackerNewsKeys.has(articleKey(item.url))),
  };
}

type NewsChannel = {
  getSnapshot(): ChannelSnapshot;
  onSnapshotChanged?(listener: (snapshot: ChannelSnapshot) => void): () => void;
  onInboundCommand?(handler: (event: InboundTextEvent) => boolean | Promise<boolean>): () => void;
  onInboundText?(listener: (event: InboundTextEvent) => unknown): () => void;
  sendText(input: { accountId: string; target: string; message: string }): Promise<SendTextResult>;
};

export type PublicDailyAiNewsState = {
  status: "disabled" | DailyRunStatus | "idle";
  enabledTarget: { accountId: string; target: string } | null;
  nextRunAt: number | null;
  lastRun: {
    runKey: string;
    sources?: NewsDigest["sources"];
    archiveWork?: import("./daily-news-import.js").NewsArchiveWork;
    status: DailyRunStatus;
    updatedAt: number;
    attempt?: number;
    failureStage?: DailyAiNewsRun["failureStage"];
    failureCode?: DailyAiNewsRun["failureCode"];
    nextRetryAt?: number;
    failureNoticeStatus?: FailureNoticeStatus;
    lastFailure?: NonNullable<DailyAiNewsRun["lastFailure"]>;
    sendFailureReason?: SendTextResult["reason"];
    providerRet?: number;
    providerErrcode?: number;
  } | null;
  preview: PublicNewsDigest | null;
  previewMessage: string | null;
  archive: {
    summaryPath: string;
    hackerNewsTopPath: string | null;
    archivedCount: number;
    skippedCount: number;
    totalCount: number;
  } | null;
  notice: string;
};

type TimerHandle = unknown;

type SchedulerOptions = {
  channel: NewsChannel;
  store: DailyAiNewsStore;
  researcher: AiNewsResearcher;
  archive?: NewsDigestArchive;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  notifyLocal?: (title: string, body: string) => void;
};

const TIME_ZONE = "Asia/Shanghai";
const SEND_HOUR = 8;
const SEND_MINUTE = 30;
const RETRY_DELAYS_MS = [10, 30, 60].map((minutes) => minutes * 60 * 1000);

function retryDelayFor(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)]!;
}

export function classifyResearchFailure(error: unknown): NonNullable<DailyAiNewsRun["failureCode"]> {
  const message = error instanceof Error ? error.message : "";
  if (/CODEX_USAGE_LIMIT|usage limit|quota (?:is )?(?:exhausted|exceeded)|insufficient_quota/iu.test(message)) {
    return "codex_usage_limit";
  }
  if (/CODEX_RATE_LIMIT|rate.?limit|too many requests|(?:^|\D)429(?:\D|$)/iu.test(message)) {
    return "codex_rate_limit";
  }
  if (/SIGTERM|超时|timeout/iu.test(message)) return "research_timeout";
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/iu.test(message)) return "network_unavailable";
  if (/未至少完成|未执行实时网页搜索/iu.test(message)) return "insufficient_search";
  if (/Hacker News|Top 5/iu.test(message)) return "hacker_news";
  if (/结果格式无效|时间窗|摘要|候选外文章|news_selection_invalid/iu.test(message)) return "invalid_result";
  if (/Codex 新闻检索失败|找不到本机 Codex 可执行文件|spawn|ENOENT/iu.test(message)) return "codex_process";
  return "research_unknown";
}

function shanghaiParts(timestamp: number): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function scheduledAt(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!, SEND_HOUR - 8, SEND_MINUTE);
}

function tomorrow(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

export function retryAtFor(runKey: string, attempt: number, failedAt: number): number | undefined {
  const candidate = failedAt + retryDelayFor(attempt);
  return shanghaiParts(candidate).date === runKey ? candidate : undefined;
}

export const FAILURE_REASON_LABELS: Record<NonNullable<DailyAiNewsRun["failureCode"]>, string> = {
  codex_usage_limit: "Codex 使用额度已耗尽，等待额度恢复",
  codex_rate_limit: "Codex 请求频率受限，等待限流解除",
  codex_process: "新闻研究进程启动或执行失败",
  research_timeout: "实时新闻研究超时",
  network_unavailable: "新闻源或网络暂时不可用",
  insufficient_search: "实时网页搜索未达到核验要求",
  invalid_result: "新闻结果未通过格式或内容校验",
  hacker_news: "Hacker News 数据获取失败",
  research_unknown: "未分类的新闻研究错误",
  archive_unavailable: "本地 Vault 归档不可用",
  article_capacity: "文章成果缓存达到容量上限，请检查本地存储；已保存内容保留",
  result_store_unavailable: "文章成果或推送正文未能可靠保存，请检查本地存储",
  target_changed: "日报发送目标已变化",
};

function shanghaiDateTime(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function failureNoticeMessage(run: DailyAiNewsRun): string {
  const stage = run.failureStage === "archive" ? "本地归档" : "新闻研究";
  const reason = run.failureCode ? FAILURE_REASON_LABELS[run.failureCode] : "未分类错误";
  return [
    "AI 新闻日报执行失败",
    `阶段：${stage}`,
    `原因：${reason}`,
    `尝试：第 ${run.attempt ?? 1} 次`,
    `失败时间：${shanghaiDateTime(run.updatedAt)}`,
    `下次自动重试：${run.nextRetryAt !== undefined ? shanghaiDateTime(run.nextRetryAt) : "今日不再自动重试"}`,
    "如需立即重试，请回复：立即重试日报",
  ].join("\n");
}

function itemKey(item: NewsItem): string {
  return articleKey(item.url);
}

const MAX_WEIXIN_NEWS_DIGEST_CODE_POINTS = 1_500;
const MAX_WEIXIN_NEWS_ITEM_CODE_POINTS = 280;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateCodePoints(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const points = Array.from(normalized);
  if (points.length <= max) return normalized;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

function compactNewsSummary(summary: string, max: number): string {
  const original = summary.trim().replace(/\s+/gu, " ");
  return codePointLength(original) <= max && !/…|\.{3,}|⋯/u.test(original)
    ? original
    : "旧版摘要未提供完整短版，可查看本地详细归档。";
}

function compactNewsItem(item: NewsItem, number: number, max: number): string {
  const prefix = `${number}. `;
  let titleCap = Math.min(56, Math.max(18, Math.floor(max * 0.22)));
  let sourceCap = Math.min(48, Math.max(12, Math.floor(max * 0.16)));
  if (item.brief !== undefined) {
    const available = max - codePointLength(prefix) - codePointLength("\n\n来源：") - codePointLength(parseNewsBrief(item.brief));
    titleCap = Math.min(titleCap, Math.max(1, Math.floor(available * 0.6)));
    sourceCap = Math.min(sourceCap, Math.max(1, available - Math.min(titleCap, codePointLength(item.title))));
  }
  const title = truncateCodePoints(item.title, titleCap);
  const source = truncateCodePoints(item.source, sourceCap);
  const fixed = codePointLength(prefix) + codePointLength(title) +
    codePointLength("\n\n来源：") + codePointLength(source);
  const summary = item.brief !== undefined
    ? parseNewsBrief(item.brief)
    : compactNewsSummary(item.summary, Math.max(1, max - fixed));
  if (codePointLength(summary) > max - fixed) throw new Error("新闻摘要超过消息字数限制");
  return `${prefix}${title}\n${summary}\n来源：${source}`;
}

export function formatNewsDigest(digest: NewsDigest): string {
  const header = `${digest.date} AI 新闻`;
  const warnings = (["hackernews", "general"] as const).flatMap((source) => {
    const result = digest.sources?.[source];
    const warning = result ? newsSourceWarning(source, result) : undefined;
    return warning ? [warning] : [];
  });
  if (digest.items.length === 0) return warnings.length ? [header, "已完成来源暂无新增可推送内容。", ...warnings].join("\n\n") : `${header}\n今日暂无值得汇总的重大更新。`;
  const sections = [
    { key: "hackernews", title: "Hacker News 热门技术" },
    { key: "general", title: "AI 新闻" },
  ] as const;
  const populated = sections.map((section) => ({
    ...section,
    items: digest.items.filter((item) => (item.section ?? "general") === section.key),
  })).filter((section) => section.items.length > 0);
  const elementCount = 1 + populated.length + digest.items.length + warnings.length;
  const fixedLength = codePointLength(header) + warnings.reduce((sum, warning) => sum + codePointLength(warning), 0) +
    populated.reduce((total, section) => total + codePointLength(section.title), 0) +
    (elementCount - 1) * codePointLength("\n\n");
  const itemBudget = Math.min(
    MAX_WEIXIN_NEWS_ITEM_CODE_POINTS,
    Math.floor((MAX_WEIXIN_NEWS_DIGEST_CODE_POINTS - fixedLength) / digest.items.length),
  );

  const lines = [header];
  let itemNumber = 0;
  for (const section of populated) {
    lines.push(section.title);
    for (const item of section.items) {
      itemNumber += 1;
      lines.push(compactNewsItem(item, itemNumber, itemBudget));
    }
  }
  return [...lines, ...warnings].join("\n\n");
}

function acceptedSegments(result: SendTextResult): number {
  return result.acceptedSegments ?? (result.ok ? result.totalSegments ?? 1 : 0);
}

function classifiedSendStatus(result: SendTextResult): DailyRunStatus {
  if (result.ok) return "accepted";
  if (acceptedSegments(result) > 0) return "partial";
  if (result.reason === "context_missing" || result.reason === "context_stale") {
    return "context_refresh_required";
  }
  if (result.reason === "auth_stale") return "auth_relogin_required";
  if (result.reason === "unknown") return "unknown";
  return "rejected";
}

function withoutSendMetadata(run: DailyAiNewsRun): DailyAiNewsRun {
  const clean = { ...run };
  delete clean.sendFailureReason;
  delete clean.providerRet;
  delete clean.providerErrcode;
  return clean;
}

function withoutSendFailure(run: DailyAiNewsRun): DailyAiNewsRun {
  const clean = withoutSendMetadata(run);
  delete clean.error;
  return clean;
}

function withSendResult(run: DailyAiNewsRun, result: SendTextResult, updatedAt: number): DailyAiNewsRun {
  const clean = withoutSendFailure(run);
  return {
    ...clean,
    status: classifiedSendStatus(result),
    updatedAt,
    ...(!result.ok && result.error ? { error: result.error } : {}),
    ...(!result.ok && result.reason ? { sendFailureReason: result.reason } : {}),
    ...(!result.ok && result.providerRet !== undefined ? { providerRet: result.providerRet } : {}),
    ...(!result.ok && result.providerErrcode !== undefined
      ? { providerErrcode: result.providerErrcode }
      : {}),
  };
}

function segmentedNotice(result: SendTextResult, acceptedMessage: string): string {
  const total = result.totalSegments ?? 1;
  const details = [
    total > 1 ? `共 ${total} 段` : "",
    result.truncated ? "正文过长，末段已标记截断" : "",
    result.duplicatePossible ? "某段曾超时并重试，可能重复" : "",
  ].filter(Boolean);
  return details.length ? `${acceptedMessage}（${details.join("；")}）` : acceptedMessage;
}

export class DailyAiNewsScheduler {
  private state: DailyAiNewsState;
  private started = false;
  private closed = false;
  private timer: TimerHandle | null = null;
  private unsubscribe: () => void = () => {};
  private unsubscribeCommand: () => void = () => {};
  private unsubscribeSnapshot: () => void = () => {};
  private recoveryContextKey = "";
  private nextRunAt: number | null = null;
  private notice = "每日 AI 新闻尚未启用。";
  private activity: "researching" | "sending" | null = null;
  private previewReady = false;
  private archiveStatus: PublicDailyAiNewsState["archive"] = null;
  private queuedOperations = 0;
  private operationTail: Promise<unknown> = Promise.resolve();
  private commandRetryInFlight = false;

  constructor(private readonly options: SchedulerOptions) {
    this.state = options.store.load();
    this.recoverInterruptedWork();
    const lastRun = this.state.runs.at(-1);
    if (this.state.enabledTarget && this.notice === "每日 AI 新闻尚未启用。") {
      this.notice = "每日 AI 新闻已启用，等待下次后台运行。";
    }
    if (lastRun?.status === "failed" &&
      (lastRun.failureStage === "research" || lastRun.failureStage === "archive")
    ) {
      this.notice = lastRun.nextRetryAt !== undefined
        ? `${lastRun.failureStage === "research" ? "今天的 AI 新闻检索" : "今天的 AI 新闻归档"}失败；后台会按退避计划自动重试。`
        : `${lastRun.failureStage === "research" ? "今天的 AI 新闻检索" : "今天的 AI 新闻归档"}失败；今日不再自动重试。`;
    }
    this.previewReady = Boolean(
      this.state.preview && (!lastRun || this.state.preview.generatedAt >= lastRun.updatedAt),
    );
    if (this.previewReady) this.notice = "已加载最近成功生成的 AI 新闻预览，尚未发送微信。";
  }

  async start(): Promise<void> {
    if (this.started) return;
    const subscribe = this.options.channel.onInboundText;
    if (!subscribe) throw new Error("当前微信通道不支持日报会话刷新监听");
    this.unsubscribe = subscribe.call(this.options.channel, (event) => this.onInbound(event));
    this.unsubscribeCommand = this.options.channel.onInboundCommand?.call(
      this.options.channel,
      (event) => this.onInboundCommand(event),
    ) ?? (() => {});
    this.unsubscribeSnapshot = this.options.channel.onSnapshotChanged?.(() => {
      const target = this.state.enabledTarget;
      const account = this.options.channel.getSnapshot().accounts.find((item) => item.accountId === target?.accountId);
      const key = JSON.stringify([target?.accountId, target?.target, account?.credentialStatus,
        target ? this.contextUpdatedAt(target.accountId, target.target) : undefined]);
      if (key === this.recoveryContextKey) return;
      this.recoveryContextKey = key;
      if (this.started) void this.reconcileDelivery().catch(() => {
        this.notice = "缓存日报恢复未完成；内容已保留，请检查服务状态。";
      });
    }) ?? (() => {});
    this.started = true;
    if (this.state.preview) {
      this.cacheDigest(this.state.preview);
    }
    if (this.state.preview && this.options.archive) {
      try {
        const archived = await this.archiveDigest(this.state.preview);
        this.cacheDigest(archived);
      } catch {
        this.notice = "最近的 AI 新闻预览尚未写入本地归档；未发送微信。";
      }
    }
    await this.catchUpToday();
    this.scheduleNext();
  }

  async enable(accountId: string, target: string): Promise<void> {
    this.assertKnownUsableTarget(accountId, target);
    this.state = {
      ...this.state,
      enabledTarget: { accountId, target, enabledAt: this.now() },
    };
    this.save();
    this.notice = "每日 AI 新闻已启用；每天 08:30 发送，当天恢复运行会补发。";
    await this.catchUpToday();
    this.scheduleNext();
  }

  disable(): void {
    this.state = { ...this.state, enabledTarget: null };
    this.save();
    this.cancelTimer();
    this.nextRunAt = null;
    this.notice = "每日 AI 新闻已停用。";
  }

  async retryNow(): Promise<void> {
    if (this.commandRetryInFlight || this.activity !== null) {
      throw new Error("日报任务正在运行，请稍后重试");
    }
    const failed = this.retryableFailedRun();
    if (!failed) throw new Error("今天没有可立即重试的失败日报任务");
    this.commandRetryInFlight = true;
    this.cancelTimer();
    try {
      await this.runAutomatic(
        failed.runKey,
        { accountId: failed.accountId, target: failed.target },
        { preserveRetryAt: failed.nextRetryAt },
      );
    } finally {
      this.commandRetryInFlight = false;
      this.scheduleNext();
    }
  }

  async preview(): Promise<void> {
    this.previewReady = false;
    await this.runExclusive("researching", true, async () => {
      const windowEnd = this.now();
      const date = shanghaiParts(windowEnd).date;
      this.notice = "正在检索并核查 AI 新闻预览；不会发送微信。";
      try {
        const existingPreview = this.state.preview?.date === date &&
          (this.state.preview.hackerNewsTop === undefined ||
            isValidHackerNewsSelection(this.state.preview))
          ? this.state.preview
          : null;
        const reused = existingPreview !== null;
        const digest = existingPreview
          ? existingPreview
          : await this.options.researcher.generate({
              date,
              windowStart: windowEnd - 24 * 60 * 60 * 1000,
              windowEnd,
              excludedArticleKeys: this.state.summarizedArticleKeys,
            });
        formatNewsDigest(digest);
        this.cacheDigest(digest);
        const archived = await this.archiveDigest(digest);
        this.cacheDigest(archived);
        this.previewReady = true;
        this.notice = reused
          ? "已复用今天生成的 AI 新闻预览并确认本地归档，尚未发送微信。"
          : "已验证实时网页检索并生成过去 24 小时预览，尚未发送微信。";
      } catch {
        this.notice = "AI 新闻预览生成失败；未发送微信。";
        throw new Error("AI 新闻预览生成失败");
      }
    });
  }

  async sendPreview(accountId: string, target: string): Promise<void> {
    this.assertKnownUsableTarget(accountId, target);
    const digest = this.state.preview;
    if (!digest) throw new Error("请先生成 AI 新闻预览");
    await this.runExclusive("sending", true, async () => {
      const message = formatNewsDigest(digest);
      const timestamp = this.now();
      let run: DailyAiNewsRun = {
        runKey: `manual-${timestamp}`,
        accountId,
        target,
        status: "sending",
        createdAt: timestamp,
        updatedAt: timestamp,
        message,
        digest,
      };
      this.replaceRun(run);
      this.notice = "正在发送用户确认的 AI 新闻预览。";
      let result: SendTextResult;
      try {
        result = await this.options.channel.sendText({ accountId, target, message });
      } catch {
        result = { ok: false, reason: "unknown", error: "发送请求失败或超时" };
      }
      const accepted = acceptedSegments(result);
      const status: DailyRunStatus = result.ok
        ? "accepted"
        : accepted > 0
          ? "partial"
        : result.reason === "unknown"
          ? "unknown"
          : "failed";
      run = { ...run, status, updatedAt: this.now(), ...(result.error ? { error: result.error } : {}) };
      this.replaceRun(run);
      this.notice = result.ok
        ? segmentedNotice(result, "AI 新闻预览已被微信渠道接受，请在手机端确认。")
        : status === "partial"
          ? `AI 新闻预览已接受 ${accepted}/${result.totalSegments ?? "?"} 段；不会自动补发整篇。${result.duplicatePossible ? " 某段可能重复。" : ""}`
        : status === "unknown"
          ? "预览发送结果未知；为避免重复，不会自动重试。"
          : "预览发送被拒绝；没有自动重试。";
      if (!result.ok) throw new Error(this.notice);
      this.rememberItems(digest.items);
    });
  }

  getPublicState(): PublicDailyAiNewsState {
    const lastRun = this.state.runs.at(-1) ?? null;
    return {
      status: this.activity ?? (this.previewReady
        ? "ready"
        : this.state.enabledTarget ? lastRun?.status ?? "idle" : "disabled"),
      enabledTarget: this.state.enabledTarget
        ? { accountId: this.state.enabledTarget.accountId, target: this.state.enabledTarget.target }
        : null,
      nextRunAt: this.nextRunAt,
      lastRun: lastRun
        ? {
            runKey: lastRun.runKey,
            status: lastRun.status,
            updatedAt: lastRun.updatedAt,
            ...(lastRun.attempt !== undefined ? { attempt: lastRun.attempt } : {}),
            ...(lastRun.failureStage !== undefined ? { failureStage: lastRun.failureStage } : {}),
            ...(lastRun.failureCode !== undefined ? { failureCode: lastRun.failureCode } : {}),
            ...(lastRun.nextRetryAt !== undefined ? { nextRetryAt: lastRun.nextRetryAt } : {}),
            ...(lastRun.lastFailure !== undefined ? { lastFailure: lastRun.lastFailure } : {}),
            ...(lastRun.failureNotice !== undefined
              ? { failureNoticeStatus: lastRun.failureNotice.status }
              : {}),
            ...(lastRun.sendFailureReason !== undefined
              ? { sendFailureReason: lastRun.sendFailureReason }
              : {}),
            ...(lastRun.providerRet !== undefined ? { providerRet: lastRun.providerRet } : {}),
            ...(lastRun.providerErrcode !== undefined
              ? { providerErrcode: lastRun.providerErrcode }
              : {}),
          }
        : null,
      preview: this.state.preview
        ? {
            date: this.state.preview.date,
            generatedAt: this.state.preview.generatedAt,
            items: this.state.preview.items.map((item) => ({
              ...(item.section ? { section: item.section } : {}),
              title: item.title,
              summary: item.summary,
              source: item.source,
              publishedAt: item.publishedAt,
            })),
          }
        : null,
      previewMessage: this.state.preview ? formatNewsDigest(this.state.preview) : null,
      archive: this.archiveStatus,
      notice: this.activity ? this.notice : this.backlogNotice() ?? this.notice,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    this.unsubscribe();
    this.unsubscribe = () => {};
    this.unsubscribeCommand();
    this.unsubscribeCommand = () => {};
    this.unsubscribeSnapshot();
    this.unsubscribeSnapshot = () => {};
    this.started = false;
    await this.operationTail;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private async catchUpToday(): Promise<void> {
    const target = this.state.enabledTarget;
    if (!target) return;
    if (this.pendingReports(target.accountId, target.target).length) {
      await this.reconcileDelivery();
      if (this.state.enabledTarget !== target) return;
    }
    const local = shanghaiParts(this.now());
    const afterSendTime = local.hour > SEND_HOUR ||
      (local.hour === SEND_HOUR && local.minute >= SEND_MINUTE);
    if (!afterSendTime) return;
    const existing = this.state.runs.find((run) => run.runKey === local.date);
    if (existing) {
      const retryable = existing.status === "failed" &&
        (existing.failureStage === "research" || existing.failureStage === "archive") &&
        existing.nextRetryAt !== undefined && existing.nextRetryAt <= this.now();
      if (!retryable) return;
    }
    await this.runAutomatic(local.date, target);
  }

  private async runAutomatic(
    runKey: string,
    target: { accountId: string; target: string },
    retryPlan?: { preserveRetryAt: number | undefined },
  ): Promise<void> {
    const startedAt = this.now();
    const previous = this.state.runs.find((item) => item.runKey === runKey);
    let run: DailyAiNewsRun = {
      runKey,
      accountId: target.accountId,
      target: target.target,
      status: "researching",
      createdAt: previous?.createdAt ?? startedAt,
      updatedAt: startedAt,
      attempt: (previous?.attempt ?? 0) + 1,
      ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}),
    };
    this.replaceRun(run);
    await this.runExclusive("researching", false, async () => {
      this.notice = "正在检索并核查今天的 AI 新闻。";
      let digest: NewsDigest;
      let message: string;
      try {
        const generated = this.state.preview?.date === runKey
          ? this.state.preview
          : await this.options.researcher.generate({
              date: runKey,
              windowStart: startedAt - 24 * 60 * 60 * 1000,
              windowEnd: startedAt,
              excludedArticleKeys: this.state.summarizedArticleKeys,
            });
        const seen = new Set(this.state.seenItemKeys);
        digest = removeSeenItems(generated, seen);
        formatNewsDigest(digest);
        this.cacheDigest(generated);
      } catch (error) {
        const failedAt = this.now();
        const preserveRetryAt = retryPlan?.preserveRetryAt;
        const nextRetryAt = retryPlan
          ? preserveRetryAt !== undefined && preserveRetryAt > failedAt &&
              shanghaiParts(preserveRetryAt).date === runKey
            ? preserveRetryAt
            : undefined
          : retryAtFor(runKey, run.attempt ?? 1, failedAt);
        const failureCode = classifyResearchFailure(error);
        run = {
          ...run,
          status: "failed",
          updatedAt: failedAt,
          error: "AI 新闻研究失败",
          failureStage: "research",
          failureCode,
          lastFailure: {
            stage: "research",
            code: failureCode,
            attempt: run.attempt ?? 1,
            at: failedAt,
          },
          ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
        };
        this.replaceRun(run);
        run = await this.sendFailureNotice(run);
        this.notice = nextRetryAt !== undefined
          ? "今天的 AI 新闻检索失败；后台会按退避计划自动重试。"
          : "今天的 AI 新闻检索失败；已超过当日自动重试时间。";
        return;
      }
      try {
        digest = await this.archiveDigest(digest);
        message = formatNewsDigest(digest);
        this.cacheDigest(digest);
      } catch {
        const failedAt = this.now();
        const preserveRetryAt = retryPlan?.preserveRetryAt;
        const nextRetryAt = retryPlan
          ? preserveRetryAt !== undefined && preserveRetryAt > failedAt &&
              shanghaiParts(preserveRetryAt).date === runKey
            ? preserveRetryAt
            : undefined
          : retryAtFor(runKey, run.attempt ?? 1, failedAt);
        run = {
          ...run,
          status: "failed",
          updatedAt: failedAt,
          error: "AI 新闻归档失败",
          failureStage: "archive",
          failureCode: "archive_unavailable",
          lastFailure: {
            stage: "archive",
            code: "archive_unavailable",
            attempt: run.attempt ?? 1,
            at: failedAt,
          },
          ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
        };
        this.replaceRun(run);
        run = await this.sendFailureNotice(run);
        this.notice = nextRetryAt !== undefined
          ? "今天的 AI 新闻无法写入本地归档；后台会复用摘要自动重试。"
          : "今天的 AI 新闻无法写入本地归档；已超过当日自动重试时间。";
        return;
      }
      run = { ...run, status: "ready", updatedAt: this.now(), digest, message };
      this.state = { ...this.state, preview: digest };
      this.replaceRun(run);
      const enabled = this.state.enabledTarget;
      if (!enabled || enabled.accountId !== target.accountId || enabled.target !== target.target) {
        run = {
          ...run,
          status: "failed",
          updatedAt: this.now(),
          error: "日报在发送前已被停用或切换目标",
          failureStage: "configuration",
          failureCode: "target_changed",
          lastFailure: {
            stage: "configuration",
            code: "target_changed",
            attempt: run.attempt ?? 1,
            at: this.now(),
          },
        };
        this.replaceRun(run);
        this.notice = "日报在发送前已停用或切换目标；没有发送微信。";
        return;
      }
      if (this.pendingReports(target.accountId, target.target).some((pending) => pending.runKey < runKey)) {
        await this.drainReports(target.accountId, target.target);
        if (this.pendingReports(target.accountId, target.target).length) {
          this.notice = this.backlogNotice()!;
          this.options.notifyLocal?.("Codex 微信日报待续发", this.notice);
        }
        return;
      }
      this.activity = "sending";
      run = {
        ...run, status: "sending", updatedAt: this.now(),
        deliveryContextUpdatedAt: this.contextUpdatedAt(target.accountId, target.target) ?? 0,
      };
      this.replaceRun(run);
      let result: SendTextResult;
      try {
        result = await this.options.channel.sendText({
          accountId: target.accountId,
          target: target.target,
          message,
        });
      } catch {
        result = { ok: false, reason: "unknown", error: "发送请求失败或超时" };
      }
      const accepted = acceptedSegments(result);
      const status = classifiedSendStatus(result);
      run = withSendResult(run, result, this.now());
      this.replaceRun(run);
      this.notice = result.ok
        ? segmentedNotice(result, "今天的 AI 新闻已被微信渠道接受。")
        : status === "partial"
          ? `今天的 AI 新闻已接受 ${accepted}/${result.totalSegments ?? "?"} 段；不会自动补发整篇。${result.duplicatePossible ? " 某段可能重复。" : ""}`
        : status === "context_refresh_required"
          ? "日报未发送；请从微信发一条新消息刷新会话，届时自动补发一次。"
        : status === "auth_relogin_required"
          ? "日报已保存；请重新绑定原微信账户并发送一条新消息，恢复后将按日期顺序续发。"
        : status === "rejected"
          ? "日报被微信渠道明确拒绝；不会自动重试。"
          : "日报发送结果未知；为避免重复，不会自动重试。";
      if (!result.ok) this.notifySendFailure(status, result);
      if (result.ok) this.rememberItems(digest.items);
    });
  }

  private replaceRun(run: DailyAiNewsRun): void {
    this.state = {
      ...this.state,
      runs: [...this.state.runs.filter((item) => item.runKey !== run.runKey), run].slice(-31),
    };
    this.save();
  }

  private notifySendFailure(status: DailyRunStatus, result: SendTextResult): void {
    if (!this.options.notifyLocal) return;
    const code = result.providerRet ?? result.providerErrcode;
    const suffix = code !== undefined ? `（iLink ${code}）` : "";
    const message = status === "context_refresh_required"
      ? `微信发送上下文需要刷新${suffix}。请从微信发一条消息。`
      : status === "auth_relogin_required"
        ? `微信 bot 凭据需要重新绑定${suffix}。`
        : status === "unknown"
          ? "微信发送结果未知；没有自动重试。"
          : `微信渠道明确拒绝了日报发送${suffix}。`;
    const backlog = this.backlogNotice(status === "auth_relogin_required");
    this.options.notifyLocal("Codex 微信日报未发送", backlog ? `${backlog}${suffix}` : message);
  }

  private async sendFailureNotice(run: DailyAiNewsRun): Promise<DailyAiNewsRun> {
    const message = failureNoticeMessage(run);
    let result: SendTextResult;
    try {
      result = await this.options.channel.sendText({
        accountId: run.accountId,
        target: run.target,
        message,
      });
    } catch {
      result = { ok: false, reason: "unknown", error: "失败通知发送请求失败或超时" };
    }
    const status: FailureNoticeStatus = result.ok
      ? "accepted"
      : result.reason === "context_missing" || result.reason === "context_stale"
        ? "context_refresh_required"
        : result.reason === "unknown"
          ? "unknown"
          : "failed";
    const clean = withoutSendMetadata(run);
    const updated: DailyAiNewsRun = {
      ...clean,
      failureNotice: {
        status,
        updatedAt: this.now(),
        ...(status === "context_refresh_required" ? { message } : {}),
      },
      ...(!result.ok && result.reason ? { sendFailureReason: result.reason } : {}),
      ...(!result.ok && result.providerRet !== undefined ? { providerRet: result.providerRet } : {}),
      ...(!result.ok && result.providerErrcode !== undefined
        ? { providerErrcode: result.providerErrcode }
        : {}),
    };
    this.replaceRun(updated);
    if (!result.ok) this.notifySendFailure(classifiedSendStatus(result), result);
    return updated;
  }

  private rememberItems(items: NewsItem[]): void {
    this.state = {
      ...this.state,
      seenItemKeys: [...this.state.seenItemKeys, ...items.map(itemKey)].slice(-500),
    };
    this.save();
  }

  private cacheDigest(digest: NewsDigest): void {
    this.state = {
      ...this.state,
      preview: digest,
      summarizedArticleKeys: [
        ...new Set([...this.state.summarizedArticleKeys, ...digest.items.map((item) => articleKey(item.url))]),
      ].slice(-100_000),
    };
    this.save();
  }

  private async archiveDigest(digest: NewsDigest): Promise<NewsDigest> {
    if (!this.options.archive) return digest;
    const result = await this.options.archive.archive(digest);
    if (!result || typeof result !== "object") return digest;
    const value = result as Record<string, unknown>;
    const archivedDigest = value.digest && typeof value.digest === "object"
      ? value.digest as NewsDigest
      : digest;
    if (typeof value.summaryPath !== "string" ||
      !Array.isArray(value.archived) || !Array.isArray(value.skipped)
    ) return archivedDigest;
    this.archiveStatus = {
      summaryPath: value.summaryPath,
      hackerNewsTopPath: typeof value.hackerNewsTopPath === "string" ? value.hackerNewsTopPath : null,
      archivedCount: value.archived.length,
      skippedCount: value.skipped.length,
      totalCount: digest.items.length,
    };
    return archivedDigest;
  }

  private recoverInterruptedWork(): void {
    let changed = false;
    const runs = this.state.runs.flatMap((run) => {
      if (run.status === "researching" || (run.status === "ready" && !run.message)) {
        changed = true;
        return [];
      }
      if (run.status !== "sending") return [run];
      changed = true;
      return [{ ...run, status: "unknown" as const, updatedAt: this.now(), error: "发送期间进程中断" }];
    });
    if (changed) {
      this.state = { ...this.state, runs };
      this.save();
      this.notice = "发现中断的发送；结果未知，为避免重复不会自动重试。";
    }
  }

  private async onInboundCommand(event: InboundTextEvent): Promise<boolean> {
    if (event.text.trim() !== "立即重试日报") return false;
    const enabled = this.state.enabledTarget;
    if (!enabled || enabled.accountId !== event.accountId || enabled.target !== event.target) {
      return false;
    }
    if (this.commandRetryInFlight || this.activity !== null) {
      await event.replyText("日报任务正在运行，请稍后查看结果。").catch(() => {});
      return true;
    }
    if (this.pendingReports(event.accountId, event.target).length > 0) {
      await this.onInbound(event);
      if (!this.retryableFailedRun()) return true;
    }
    const failed = this.retryableFailedRun();
    if (!failed) {
      await event.replyText("今天没有可立即重试的失败日报任务。").catch(() => {});
      return true;
    }
    this.commandRetryInFlight = true;
    this.cancelTimer();
    const preserveRetryAt = failed.nextRetryAt;
    try {
      await this.retryFromCommand(event, failed, preserveRetryAt);
    } finally {
      this.commandRetryInFlight = false;
      this.scheduleNext();
    }
    return true;
  }

  private retryableFailedRun(): DailyAiNewsRun | undefined {
    const date = shanghaiParts(this.now()).date;
    return this.state.runs.find((run) =>
      run.runKey === date && run.status === "failed" &&
      (run.failureStage === "research" || run.failureStage === "archive"),
    );
  }

  private async retryFromCommand(
    event: InboundTextEvent,
    failed: DailyAiNewsRun,
    preserveRetryAt: number | undefined,
  ): Promise<void> {
    const retryPlan = preserveRetryAt !== undefined
      ? `若仍失败，原定自动重试时间 ${shanghaiDateTime(preserveRetryAt)} 保持不变。`
      : "若仍失败，今天不会自动增加新的重试时间。";
    const acknowledgement = event.replyText(`已收到，正在立即重试日报。${retryPlan}`).catch(() => {});
    const retry = this.runAutomatic(
      failed.runKey,
      { accountId: failed.accountId, target: failed.target },
      { preserveRetryAt },
    );
    await Promise.all([acknowledgement, retry]);
  }

  private canResumeDelivery(accountId: string, target: string): boolean {
    const enabled = this.state.enabledTarget;
    const snapshot = this.options.channel.getSnapshot();
    return this.started && enabled?.accountId === accountId && enabled.target === target &&
      snapshot.accounts.some((account) =>
        account.accountId === accountId && account.credentialStatus === "usable") &&
      snapshot.targets.some((item) => item.accountId === accountId && item.target === target);
  }

  private pendingReports(accountId: string, target: string): DailyAiNewsRun[] {
    return this.state.runs.filter((run) =>
      (run.status === "ready" || run.status === "pending_inbound" || run.status === "context_refresh_required" ||
        run.status === "auth_relogin_required") &&
      run.accountId === accountId && run.target === target && Boolean(run.message),
    ).sort((a, b) => a.runKey.localeCompare(b.runKey));
  }

  private backlogNotice(credentialFailure = false): string | undefined {
    const target = this.state.enabledTarget;
    if (!target) return;
    const pending = this.pendingReports(target.accountId, target.target);
    const oldest = pending[0];
    if (!oldest) return;
    const prefix = `已缓存 ${pending.length} 份日报，最早为 ${oldest.runKey}。`;
    const snapshot = this.options.channel.getSnapshot();
    const usable = snapshot.accounts.some((account) =>
      account.accountId === target.accountId && account.credentialStatus === "usable");
    if (!usable || credentialFailure) {
      return `${prefix}请重新绑定原微信账户并发送一条新消息，恢复后按日期顺序续发。`;
    }
    if (this.canResumeDelivery(target.accountId, target.target) && this.hasRefreshedContext(oldest)) {
      return `${prefix}会话已恢复，正在按日期顺序续发。`;
    }
    const stopped = this.state.runs.some((run) =>
      run.accountId === target.accountId && run.target === target.target &&
      (run.status === "unknown" || run.status === "partial" || run.status === "rejected") &&
      run.deliveryContextUpdatedAt !== undefined &&
      (this.contextUpdatedAt(target.accountId, target.target) ?? 0) <= run.deliveryContextUpdatedAt);
    return stopped
      ? `${prefix}上次补发未全部成功，已停止该批次且不会重发结果不确定或被拒绝的日报；请从原微信会话发送一条新消息，继续发送其余缓存日报。`
      : `${prefix}请从原微信会话发送一条新消息，恢复后按日期顺序续发。`;
  }

  private onInbound(event: InboundTextEvent): Promise<void> {
    return this.runExclusive("sending", false, async () => {
      if (!this.canResumeDelivery(event.accountId, event.target)) return;
      await this.resumeFailureNotice(event);
      await this.drainReports(event.accountId, event.target, event.observedAt ?? event.receivedAt);
    });
  }

  private contextUpdatedAt(accountId: string, target: string): number | undefined {
    return this.options.channel.getSnapshot().targets.find((item) =>
      item.accountId === accountId && item.target === target)?.contextUpdatedAt;
  }

  private hasRefreshedContext(run: DailyAiNewsRun, inboundAt?: number): boolean {
    const context = this.contextUpdatedAt(run.accountId, run.target) ?? inboundAt;
    return context !== undefined && context > 0 &&
      !this.state.runs.some((attempt) =>
        attempt.accountId === run.accountId && attempt.target === run.target &&
        (attempt.status === "unknown" || attempt.status === "partial" || attempt.status === "rejected") &&
        attempt.deliveryContextUpdatedAt !== undefined && context <= attempt.deliveryContextUpdatedAt) &&
      (run.status === "ready" || run.status === "pending_inbound" ||
        context > (run.deliveryContextUpdatedAt ?? run.updatedAt));
  }

  private async reconcileDelivery(): Promise<void> {
    const target = this.state.enabledTarget;
    if (!target || !this.pendingReports(target.accountId, target.target).length) return;
    await this.runExclusive("sending", false, () => this.drainReports(target.accountId, target.target));
  }

  private async drainReports(accountId: string, target: string, inboundAt?: number): Promise<void> {
    for (const pending of this.pendingReports(accountId, target)) {
      if (!this.canResumeDelivery(accountId, target)) break;
      if (!this.hasRefreshedContext(pending, inboundAt)) break;
      this.previewReady = false;
      const message = pending.message!;
      const sending = {
        ...pending, status: "sending" as const, updatedAt: this.now(),
        deliveryContextUpdatedAt: this.contextUpdatedAt(accountId, target) ?? inboundAt ?? 0,
      };
      this.replaceRun(sending);
      this.notice = `会话已恢复，正在按日期顺序续发 ${sending.runKey} 日报。`;
      let result: SendTextResult;
      try {
        result = await this.options.channel.sendText({
          accountId: sending.accountId,
          target: sending.target,
          message,
        });
      } catch {
        result = { ok: false, reason: "unknown", error: "补发请求失败或超时" };
      }
      const accepted = acceptedSegments(result);
      const status = classifiedSendStatus(result);
      this.replaceRun(withSendResult(sending, result, this.now()));
      this.notice = result.ok
        ? segmentedNotice(result, "保存的 AI 新闻已在会话恢复后按日期顺序被微信渠道接受。")
        : status === "partial"
          ? `保存的 AI 新闻已接受 ${accepted}/${result.totalSegments ?? "?"} 段；不会再次补发。${result.duplicatePossible ? " 某段可能重复。" : ""}`
        : status === "unknown"
          ? "补发结果未知；为避免重复，不会自动重试。"
        : status === "context_refresh_required" || status === "auth_relogin_required"
          ? "会话仍不可用，日报已保留；恢复后再按日期顺序续发。"
          : "补发被渠道明确拒绝；不会自动重试。";
      if (result.ok && sending.digest) this.rememberItems(sending.digest.items);
      if (!result.ok) {
        this.notifySendFailure(status, result);
        break;
      }
    }
  }

  private async resumeFailureNotice(event: InboundTextEvent): Promise<void> {
    const pendingNotice = [...this.state.runs].reverse().find(
      (run) =>
        run.status === "failed" &&
        run.accountId === event.accountId &&
        run.target === event.target &&
        (run.failureNotice?.status === "pending_inbound" ||
          run.failureNotice?.status === "context_refresh_required") &&
        Boolean(run.failureNotice.message),
    );
    if (pendingNotice?.failureNotice?.message) {
      const message = pendingNotice.failureNotice.message;
      const reserved: DailyAiNewsRun = {
        ...pendingNotice,
        failureNotice: { status: "failed", updatedAt: this.now() },
      };
      this.replaceRun(reserved);
      let result: SendTextResult;
      try {
        result = await this.options.channel.sendText({
          accountId: reserved.accountId,
          target: reserved.target,
          message,
        });
      } catch {
        result = { ok: false, reason: "unknown", error: "失败通知补发请求失败或超时" };
      }
      const status: FailureNoticeStatus = result.ok
        ? "accepted"
        : result.reason === "unknown"
          ? "unknown"
          : "failed";
      const clean = result.ok ? withoutSendMetadata(reserved) : reserved;
      this.replaceRun({
        ...clean,
        failureNotice: { status, updatedAt: this.now() },
      });
    }
  }

  private scheduleNext(): void {
    this.cancelTimer();
    if (this.closed) return;
    if (!this.state.enabledTarget) {
      this.nextRunAt = null;
      return;
    }
    const now = this.now();
    const local = shanghaiParts(now);
    const today = scheduledAt(local.date);
    const nextDailyRun = now < today ? today : scheduledAt(tomorrow(local.date));
    const retry = this.state.runs.find((run) =>
      run.runKey === local.date && run.status === "failed" &&
      (run.failureStage === "research" || run.failureStage === "archive") &&
      run.nextRetryAt !== undefined && run.nextRetryAt > now,
    );
    this.nextRunAt = retry?.nextRetryAt !== undefined
      ? Math.min(nextDailyRun, retry.nextRetryAt)
      : nextDailyRun;
    const setTimer = this.options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.catchUpToday().finally(() => this.scheduleNext());
    }, Math.max(0, this.nextRunAt - now));
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clearTimer = this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    clearTimer(this.timer);
    this.timer = null;
  }

  private assertKnownUsableTarget(accountId: string, target: string): void {
    const snapshot = this.options.channel.getSnapshot();
    const account = snapshot.accounts.find((item) => item.accountId === accountId);
    if (!account || account.credentialStatus !== "usable") throw new Error("微信账户不可用于日报发送");
    if (!snapshot.targets.some((item) => item.accountId === accountId && item.target === target)) {
      throw new Error("只能为已发现的微信入站目标启用日报");
    }
  }

  private runExclusive<T>(
    activity: "researching" | "sending",
    rejectIfBusy: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("daily_news_closed"));
    if (rejectIfBusy && this.queuedOperations > 0) {
      return Promise.reject(new Error("每日 AI 新闻已有操作正在执行"));
    }
    this.queuedOperations += 1;
    const result = this.operationTail.then(async () => {
      this.activity = activity;
      try {
        return await operation();
      } finally {
        this.activity = null;
        this.queuedOperations -= 1;
      }
    });
    this.operationTail = result.catch(() => undefined);
    return result;
  }

  private save(): void { this.options.store.save(this.state); }
}
