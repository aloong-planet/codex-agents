# 日报 Codex 额度失败分类与通知设计

日期：2026-08-20

## 1. 问题与证据

2026-08-20 的自动日报从 08:30 起执行，最终以第 6 次尝试在 12:24 被微信渠道接受。此前 Codex 明确给出额度恢复时间 11:54；时间关系强烈支持前几次失败由额度耗尽导致，但当前状态只保存最终成功 run，原始失败已经不可追溯，因此本次只能给出高置信度结论，不能伪装成完整取证。

现有 `createCodexCliNewsRun()` 在非零退出时只把 stderr 尾部带给调度器；Codex `--json` 的错误也可能出现在 stdout。`classifyResearchFailure()` 又会把所有带“Codex 新闻检索失败”的错误归为 `codex_process`，所以微信通知只能显示“新闻研究进程启动或执行失败”。

## 2. 目标与边界

- 识别 Codex 使用额度耗尽和短时请求限流，微信通知展示明确、安全的中文原因。
- 同时检查 stderr 与 JSONL stdout，但只向上游传递固定安全标记，不持久化或发送原始输出。
- 每个日期保留最近一次安全失败诊断；后续重试成功后仍可在面板确认“曾失败、已恢复”。
- 不改变重试退避、新闻研究、归档、微信发送、context token 或自动补发策略。
- 不补发今天已经成功发送的日报或历史失败通知。

## 3. 分类

新增两种稳定 failure code：

- `codex_usage_limit`：命中 `usage limit`、`quota exceeded`、`insufficient_quota` 等额度耗尽信号。通知原因：`Codex 使用额度已耗尽，等待额度恢复`。
- `codex_rate_limit`：命中 `rate limit`、`too many requests` 或 HTTP 429。通知原因：`Codex 请求频率受限，等待限流解除`。

匹配顺序必须在通用 `codex_process` 之前。超时、网络、搜索不足、内容校验等既有分类不变。

CLI runner 对 stdout/stderr 只做固定模式识别：命中后分别产生 `CODEX_USAGE_LIMIT` 或 `CODEX_RATE_LIMIT` 安全标记；未命中时保留当前 stderr 尾部行为。任何原始 stdout、路径、URL、账户或 token 都不进入通知和持久状态。

## 4. 安全留痕

`DailyAiNewsRun` 新增：

```ts
lastFailure?: {
  stage: "research" | "archive" | "configuration";
  code: FailureCode;
  attempt: number;
  at: number;
};
```

失败时与当前 `failureStage/failureCode` 同步写入；开始下一次尝试时从前一个 run 继承。成功后清除当前失败态，但保留 `lastFailure`。文件 store 严格校验 enum、次数和时间；公开状态只返回安全 code，不返回异常文本。

面板在最终状态已恢复时显示“最近失败：第 N 次 · 原因 · 已恢复”，避免成功覆盖后无法诊断。

## 5. 用户操作序列与失败模式

1. 自动研究命中额度耗尽：持久化 `codex_usage_limit`，立即发微信失败通知，显示原因、尝试次数和下一次重试时间。
2. 命中短时 429：记录 `codex_rate_limit`，通知与退避同上。
3. 通知本身因 context token 失效未送达：沿用既有单次入站刷新门禁，不把研究额度错误误报为微信错误。
4. 后续重试成功：取消本次失败态和重试时间，但保留 `lastFailure`；日报只发送一次。
5. CLI 错误只出现在 JSONL stdout：仍能产生安全分类。
6. 无法识别的 Codex 退出：继续归为 `codex_process`，不猜测额度耗尽。

## 6. 验证

- 调度器高层 seam：额度错误必须生成含“Codex 使用额度已耗尽”的微信通知；修复前该断言为红。
- runner seam：stderr 和 JSONL stdout 两条路径都转成安全标记，通知/状态不含原始错误。
- store：`lastFailure` 往返、非法 code/时间拒绝、旧 v2 状态兼容。
- 重试成功：状态 accepted，保留 `lastFailure`，不保留当前 `failureCode/nextRetryAt`。
- 全量 lint、typecheck、unit/integration、build、Playwright E2E。
