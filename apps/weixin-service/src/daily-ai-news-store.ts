import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  DailyAiNewsFailureCode,
  DailyAiNewsFailureStage,
  DailyAiNewsRun,
  DailyAiNewsState,
  DailyAiNewsStore,
  FailureNoticeStatus,
  HackerNewsTopItem,
  NewsDigest,
  NewsItem,
} from "./daily-ai-news-scheduler.js";
import { articleKey } from "./news-article-identity.js";
import { parseNewsBrief } from "./news-summary.js";

const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9._-]+@im\.wechat$/;
const RUN_KEY = /^(?:\d{4}-\d{2}-\d{2}|manual-\d{1,20})$/;
const ITEM_KEY = /^[0-9a-f]{64}$/;
const STATUSES = new Set([
  "researching",
  "ready",
  "sending",
  "accepted",
  "partial",
  "pending_inbound",
  "context_refresh_required",
  "auth_relogin_required",
  "rejected",
  "unknown",
  "failed",
]);
const FAILURE_STAGES = new Set(["research", "archive", "configuration"]);
const FAILURE_CODES = new Set([
  "codex_usage_limit", "codex_rate_limit", "codex_process", "research_timeout", "network_unavailable", "insufficient_search", "invalid_result",
  "hacker_news", "research_unknown", "archive_unavailable", "target_changed", "article_capacity", "result_store_unavailable",
]);
const FAILURE_NOTICE_STATUSES = new Set<FailureNoticeStatus>([
  "accepted", "pending_inbound", "context_refresh_required", "unknown", "failed",
]);
const SEND_FAILURE_REASONS = new Set([
  "context_missing", "context_stale", "auth_stale", "rejected", "unknown", "unavailable",
]);
const HN_AUDIT_STATUSES = new Set<HackerNewsTopItem["status"]>([
  "summarized",
  "historical_duplicate",
  "unreadable_or_unverified",
  "not_selected",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseItem(value: unknown): NewsItem {
  const item = record(value);
  if (!item ||
    typeof item.title !== "string" || !item.title.trim() || item.title.length > 300 ||
    typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > 1000 ||
    typeof item.source !== "string" || !item.source.trim() || item.source.length > 200 ||
    typeof item.url !== "string" || item.url.length > 2000 ||
    typeof item.publishedAt !== "string" || item.publishedAt.length > 100
  ) throw new Error("每日 AI 新闻状态格式无效");
  let url: URL;
  try { url = new URL(item.url); } catch { throw new Error("每日 AI 新闻状态格式无效"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("每日 AI 新闻状态格式无效");
  }
  return {
    ...(item.section === "general" || item.section === "hackernews"
      ? { section: item.section }
      : {}),
    title: item.title,
    summary: item.summary,
    ...(item.brief !== undefined ? { brief: parseNewsBrief(item.brief) } : {}),
    source: item.source,
    url: url.toString(),
    publishedAt: item.publishedAt,
  };
}

function parseHackerNewsTopItem(value: unknown): HackerNewsTopItem {
  const item = record(value);
  if (!item || !integer(item.rank) || item.rank < 1 || item.rank > 10 ||
    typeof item.title !== "string" || !item.title.trim() || item.title.length > 300 ||
    typeof item.source !== "string" || !item.source.trim() || item.source.length > 200 ||
    typeof item.url !== "string" || item.url.length > 2000 ||
    typeof item.submittedAt !== "string" || item.submittedAt.length > 100 ||
    !Number.isFinite(Date.parse(item.submittedAt)) ||
    !integer(item.score) || !integer(item.comments) ||
    typeof item.status !== "string" ||
    !HN_AUDIT_STATUSES.has(item.status as HackerNewsTopItem["status"])
  ) throw new Error("每日 AI 新闻状态格式无效");
  let url: URL;
  try { url = new URL(item.url); } catch { throw new Error("每日 AI 新闻状态格式无效"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("每日 AI 新闻状态格式无效");
  }
  return {
    rank: item.rank,
    title: item.title,
    source: item.source,
    url: url.toString(),
    submittedAt: item.submittedAt,
    score: item.score,
    comments: item.comments,
    status: item.status as HackerNewsTopItem["status"],
  };
}

function parseDigest(value: unknown): NewsDigest {
  const digest = record(value);
  if (!digest ||
    typeof digest.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(digest.date) ||
    !integer(digest.generatedAt) ||
    !Array.isArray(digest.items) || digest.items.length > 10 ||
    (digest.hackerNewsTop !== undefined &&
      (!Array.isArray(digest.hackerNewsTop) || digest.hackerNewsTop.length > 10)) ||
    (digest.hackerNewsTopCapturedAt !== undefined && !integer(digest.hackerNewsTopCapturedAt))
  ) throw new Error("每日 AI 新闻状态格式无效");
  const hackerNewsTop = digest.hackerNewsTop?.map(parseHackerNewsTopItem);
  if (hackerNewsTop && new Set(hackerNewsTop.map((item) => item.rank)).size !== hackerNewsTop.length) {
    throw new Error("每日 AI 新闻状态格式无效");
  }
  return {
    date: digest.date,
    generatedAt: digest.generatedAt,
    items: digest.items.map(parseItem),
    ...(hackerNewsTop ? { hackerNewsTop } : {}),
    ...(digest.hackerNewsTopCapturedAt !== undefined
      ? { hackerNewsTopCapturedAt: digest.hackerNewsTopCapturedAt }
      : {}),
  };
}

function parseRun(value: unknown, legacy = false): DailyAiNewsRun {
  const run = record(value);
  if (!run ||
    typeof run.runKey !== "string" || !RUN_KEY.test(run.runKey) ||
    typeof run.accountId !== "string" || !ACCOUNT_ID.test(run.accountId) ||
    typeof run.target !== "string" || !TARGET_ID.test(run.target) ||
    typeof run.status !== "string" || !STATUSES.has(run.status) ||
    !integer(run.createdAt) || !integer(run.updatedAt) ||
    (run.message !== undefined && (typeof run.message !== "string" || run.message.length > 20_000)) ||
    (run.error !== undefined && (typeof run.error !== "string" || run.error.length > 500)) ||
    (run.sendFailureReason !== undefined &&
      (typeof run.sendFailureReason !== "string" || !SEND_FAILURE_REASONS.has(run.sendFailureReason))) ||
    (run.providerRet !== undefined && !Number.isSafeInteger(run.providerRet)) ||
    (run.providerErrcode !== undefined && !Number.isSafeInteger(run.providerErrcode)) ||
    (run.attempt !== undefined && (!integer(run.attempt) || run.attempt < 1 || run.attempt > 100)) ||
    (run.failureStage !== undefined && (typeof run.failureStage !== "string" || !FAILURE_STAGES.has(run.failureStage))) ||
    (run.failureCode !== undefined && (typeof run.failureCode !== "string" || !FAILURE_CODES.has(run.failureCode))) ||
    (run.deliveryContextUpdatedAt !== undefined && !integer(run.deliveryContextUpdatedAt)) ||
    (run.nextRetryAt !== undefined && !integer(run.nextRetryAt))
  ) throw new Error("每日 AI 新闻状态格式无效");
  let failureNotice: DailyAiNewsRun["failureNotice"];
  let lastFailure: DailyAiNewsRun["lastFailure"];
  if (run.lastFailure !== undefined) {
    const failure = record(run.lastFailure);
    if (!failure || typeof failure.stage !== "string" || !FAILURE_STAGES.has(failure.stage) ||
      typeof failure.code !== "string" || !FAILURE_CODES.has(failure.code) ||
      !integer(failure.attempt) || failure.attempt < 1 || failure.attempt > 100 ||
      !integer(failure.at)
    ) throw new Error("每日 AI 新闻状态格式无效");
    lastFailure = {
      stage: failure.stage as DailyAiNewsFailureStage,
      code: failure.code as DailyAiNewsFailureCode,
      attempt: failure.attempt,
      at: failure.at,
    };
  }
  if (run.failureNotice !== undefined) {
    const notice = record(run.failureNotice);
    if (!notice || typeof notice.status !== "string" ||
      !FAILURE_NOTICE_STATUSES.has(notice.status as FailureNoticeStatus) ||
      !integer(notice.updatedAt) ||
      (notice.message !== undefined &&
        (typeof notice.message !== "string" || !notice.message.trim() || notice.message.length > 2_000)) ||
      ((notice.status === "pending_inbound" || notice.status === "context_refresh_required") &&
        typeof notice.message !== "string") ||
      (notice.status !== "pending_inbound" && notice.status !== "context_refresh_required" &&
        notice.message !== undefined)
    ) throw new Error("每日 AI 新闻状态格式无效");
    failureNotice = {
      status: notice.status as FailureNoticeStatus,
      updatedAt: notice.updatedAt,
      ...(typeof notice.message === "string" ? { message: notice.message } : {}),
    };
  }
  const legacyFailure = legacy && run.status === "failed"
    ? run.error === "AI 新闻研究失败"
      ? { attempt: 1, failureStage: "research" as const, failureCode: "research_unknown" as const, nextRetryAt: run.updatedAt }
      : run.error === "AI 新闻归档失败"
        ? { attempt: 1, failureStage: "archive" as const, failureCode: "archive_unavailable" as const, nextRetryAt: run.updatedAt }
        : {}
    : {};
  return {
    runKey: run.runKey,
    accountId: run.accountId,
    target: run.target,
    status: run.status as DailyAiNewsRun["status"],
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(typeof run.deliveryContextUpdatedAt === "number" ? { deliveryContextUpdatedAt: run.deliveryContextUpdatedAt } : {}),
    ...(typeof run.message === "string" ? { message: run.message } : {}),
    ...(run.digest !== undefined ? { digest: parseDigest(run.digest) } : {}),
    ...(typeof run.error === "string" ? { error: run.error } : {}),
    ...(typeof run.sendFailureReason === "string"
      ? { sendFailureReason: run.sendFailureReason as DailyAiNewsRun["sendFailureReason"] }
      : {}),
    ...(typeof run.providerRet === "number" ? { providerRet: run.providerRet } : {}),
    ...(typeof run.providerErrcode === "number" ? { providerErrcode: run.providerErrcode } : {}),
    ...(typeof run.attempt === "number" ? { attempt: run.attempt } : {}),
    ...(typeof run.failureStage === "string" ? { failureStage: run.failureStage as NonNullable<DailyAiNewsRun["failureStage"]> } : {}),
    ...(typeof run.failureCode === "string" ? { failureCode: run.failureCode as NonNullable<DailyAiNewsRun["failureCode"]> } : {}),
    ...(typeof run.nextRetryAt === "number" ? { nextRetryAt: run.nextRetryAt } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    ...(failureNotice ? { failureNotice } : {}),
    ...legacyFailure,
  };
}

export function parseDailyAiNewsState(value: unknown): DailyAiNewsState {
  const root = record(value);
  if (!root || (root.version !== 1 && root.version !== 2) || !Array.isArray(root.runs) || root.runs.length > 31 ||
    !Array.isArray(root.seenItemKeys) || root.seenItemKeys.length > 500 ||
    (root.summarizedArticleKeys !== undefined &&
      (!Array.isArray(root.summarizedArticleKeys) || root.summarizedArticleKeys.length > 100_000))
  ) throw new Error("每日 AI 新闻状态格式无效");
  let enabledTarget: DailyAiNewsState["enabledTarget"] = null;
  if (root.enabledTarget !== null) {
    const target = record(root.enabledTarget);
    if (!target || typeof target.accountId !== "string" || !ACCOUNT_ID.test(target.accountId) ||
      typeof target.target !== "string" || !TARGET_ID.test(target.target) || !integer(target.enabledAt)
    ) throw new Error("每日 AI 新闻状态格式无效");
    enabledTarget = {
      accountId: target.accountId,
      target: target.target,
      enabledAt: target.enabledAt,
    };
  }
  const seenItemKeys = root.seenItemKeys.map((key) => {
    if (typeof key !== "string" || !ITEM_KEY.test(key)) throw new Error("每日 AI 新闻状态格式无效");
    return key;
  });
  const storedSummarizedKeys = (root.summarizedArticleKeys ?? []).map((key: unknown) => {
    if (typeof key !== "string" || !ITEM_KEY.test(key)) throw new Error("每日 AI 新闻状态格式无效");
    return key;
  });
  const runs = root.runs.map((run) => parseRun(run, root.version === 1));
  const preview = root.preview === null ? null : parseDigest(root.preview);
  const migratedKeys = [
    ...(preview?.items ?? []),
    ...runs.flatMap((run) => run.digest?.items ?? []),
  ].map((item) => articleKey(item.url));
  return {
    version: 2,
    enabledTarget,
    runs,
    seenItemKeys,
    summarizedArticleKeys: [...new Set([...storedSummarizedKeys, ...migratedKeys])].slice(-100_000),
    preview,
  };
}

function emptyState(): DailyAiNewsState {
  return {
    version: 2,
    enabledTarget: null,
    runs: [],
    seenItemKeys: [],
    summarizedArticleKeys: [],
    preview: null,
  };
}

export class DailyAiNewsFileStore implements DailyAiNewsStore {
  constructor(private readonly filePath: string) {}

  load(): DailyAiNewsState {
    if (!fs.existsSync(this.filePath)) return emptyState();
    const file = fs.lstatSync(this.filePath);
    const directory = fs.statSync(path.dirname(this.filePath));
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || (directory.mode & 0o077)) {
      throw new Error("每日 AI 新闻状态文件权限不安全");
    }
    try {
      return parseDailyAiNewsState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && error.message.includes("权限不安全")) throw error;
      throw new Error("每日 AI 新闻状态格式无效");
    }
  }

  save(state: DailyAiNewsState): void {
    const normalized = parseDailyAiNewsState(state);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.daily-ai-news-${crypto.randomUUID()}.tmp`);
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(normalized), "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
}
