export type NewsSourceStatus = { status: "complete" | "empty" | "degraded" | "failed"; code?: string; requested?: number; selected?: number };

export function newsSourceError(error: unknown): string {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const value = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED"].includes(String(value.code))) return String(value.code);
    if (value.name === "TimeoutError" || /source_deadline|research_timeout/.test(String(value.message))) return "source_deadline";
    if (["article_content_mismatch", "article_content_unverified"].includes(String(value.message))) return String(value.message);
    if (value.message === "article_cache_unavailable") return "article_cache_unavailable";
    if (/CODEX_USAGE_LIMIT/.test(String(value.message))) return "usage_limit";
    if (/CODEX_RATE_LIMIT/.test(String(value.message))) return "rate_limit";
    current = value.cause;
  }
  return "source_unavailable";
}

export function newsSourceWarning(source: "general" | "hackernews", result: NewsSourceStatus): string | undefined {
  const shortfall = result.requested !== undefined && result.selected !== undefined && result.selected < result.requested;
  if (!shortfall && !["failed", "degraded"].includes(result.status)) return;
  const label = source === "hackernews" ? "Hacker News" : "AI 新闻";
  const reason = result.code === "ECONNRESET" ? "获取时连接中断，有限重试后仍未恢复"
    : result.code === "source_deadline" ? "本来源研究超时"
    : result.code === "article_content_mismatch" ? "部分候选标题与正文不一致，已跳过"
    : result.code === "article_content_unverified" ? "部分候选正文不足或无法核验，已跳过"
    : result.code === "article_cache_unavailable" ? "已有处理记录无法完整读取，未重新生成摘要"
    : result.code === "usage_limit" ? "模型额度不足"
    : result.code === "rate_limit" ? "模型服务限流"
    : result.code === "insufficient_candidates" ? "当前候选中符合时间和内容要求且可核验的文章不足"
    : result.code === "already_delivered" ? "其余内容已推送，本次没有重复纳入"
    : "获取或核验失败";
  if (shortfall) return `${label}：目标 ${result.requested} 条，本次 ${result.selected} 条；${reason}。`;
  return `${result.status === "failed" ? "本次未包含" : "本次未完整包含"} ${label}：${reason}。`;
}
