# 每日 AI 新闻后台恢复设计

> Historical design: the current owner, bounded retry, immutable article result and independent archive behavior are defined by the [daily-news specification](../../../docs/specs/daily-ai-news.md) and [ADR-0017](../../../docs/adr/0017-daily-news-results-and-archives.md). The coupled archive gate and unlimited same-day retry descriptions below are historical, not the current contract.

日期：2026-08-15

## 1. 目标与成功标准

已启用的日报必须在服务后台运行，不依赖打开页面或点击“生成今日预览”。每天 08:30（Asia/Shanghai）自动研究、归档并发送；研究或归档失败时按 10 分钟、30 分钟、60 分钟退避，之后每 60 分钟重试到当天结束。

成功标准：

- 08:30 到点自动开始，页面按钮只保留手动预览用途。
- 同日 `research` / `archive` 失败会持久化下一次重试时间；服务持续运行或当天重启后均能恢复。
- `sending`、`unknown`、`partial`、`accepted` 不进入定时重试，避免重复发送。
- Cached `ready`, legacy `pending_inbound`, context-refresh and credential-recovery reports resume serially, oldest first, after usable credentials and a newer saved conversation refresh from the same enabled account/target. Startup, channel updates and scheduled work reconcile that evidence even when the original inbound was consumed before restart. See the [current recovery specification](../../../docs/specs/daily-ai-news.md).
- 页面公开当前失败阶段、安全错误类别、尝试次数和下次后台重试时间，不公开 stderr、prompt、URL、token、账户秘密或正文。

## 2. 已确认故障

用户操作序列：

1. 日报已绑定并启用。
2. 2026-08-15 08:30:02 后台自动进入研究。
3. 08:31:20 研究失败，状态仅保存 `failed / AI 新闻研究失败`。
4. `catchUpToday()` 因看到同日任意 run 而直接返回。
5. `scheduleNext()` 无条件安排明日 08:30，因此当天不会后台恢复。
6. 今日没有 digest、归档或发送请求；手动预览只是目前唯一可见恢复入口。

根因是同日 run 的存在性被错误地当成完成性，且失败异常在 catch seam 被压成单一字符串。

## 3. 状态接口

`DailyAiNewsState` 升级为 version 2。每个自动 run 新增：

```ts
type DailyFailureStage = "research" | "archive" | "configuration";
type DailyFailureCode =
  | "codex_process"
  | "research_timeout"
  | "network_unavailable"
  | "insufficient_search"
  | "invalid_result"
  | "hacker_news"
  | "research_unknown"
  | "archive_unavailable"
  | "target_changed";

type DailyAiNewsRun = {
  // existing fields
  attempt: number;          // 本 run 已开始的自动尝试次数，首次为 1
  failureStage?: DailyFailureStage;
  failureCode?: DailyFailureCode;
  nextRetryAt?: number;
};
```

v1 迁移规则：仅当私有 `error` 精确等于旧版固定值“AI 新闻研究失败”或“AI 新闻归档失败”时，迁移为对应可重试阶段并允许同日立即恢复；其他历史 `failed` 不自动重试，避免把目标切换等配置失败误判成研究失败。

公开 `lastRun` 只增加上述安全字段，不公开原始 error。旧 `error` 保留在私有账本供兼容，但新研究异常只存固定中文概述。

## 4. 深模块与 seam

复杂性留在 `DailyAiNewsScheduler` 模块，外部接口不新增控制方法：调用者仍只需 `start/enable/disable/preview/sendPreview/close/getPublicState`。

内部 seam：

- `retryDelayFor(attempt)`：第 1 次失败 +10m，第 2 次 +30m，第 3 次及以后 +60m。
- `retryableRunForToday(now)`：只识别今天、`failed`、阶段为 research/archive、具有合法 `nextRetryAt` 的 run。
- `nextWakeAt(now)`：取“今天可重试时间”和“下一个 08:30”中更早者。
- `classifyResearchFailure(error)`：在异常最早 catch seam 映射固定安全类别，原始异常不进入公开状态。

定时器回调始终调用同一个 `catchUpToday()`；它决定是首次运行、到点重试还是无操作，完成后重新计算下一次唤醒。

## 5. 状态路径

### 5.1 首次成功

`idle -> researching(attempt=1) -> ready -> sending -> accepted/partial/unknown/pending_inbound`

发送阶段的任何终态均清除 `nextRetryAt`，绝不回到研究。

### 5.2 研究失败

`researching(attempt=N) -> failed(stage=research, nextRetryAt=now+delay(N))`

到点且仍为同一天、目标仍相同：

`failed -> researching(attempt=N+1)`

新尝试重新使用当时向前 24 小时窗口；历史文章去重集合继续生效。

### 5.3 归档失败

研究完成后 `cacheDigest(generated)` 已持久化当天 preview。归档失败进入：

`ready/archive -> failed(stage=archive, nextRetryAt=...)`

重试优先复用同日 preview，不重复调用 Codex 摘要；重新归档成功后才进入发送。

### 5.4 服务停止与恢复

- 定时器不是持久化对象；`nextRetryAt` 是。
- 当天重启后 `start()` 调用 `catchUpToday()`：若已过重试时间立即恢复，否则安排到 `nextRetryAt`。
- Do not rerun missed historical research. Saved reports can recover across days; a new report waits behind older recoverable content.
- Restart clears unfinished `researching` and contentless legacy `ready`; a cached `ready` survives. Interrupted `sending` becomes `unknown` and is never automatically resubmitted.

## 6. 失败模式与安全边界

- Codex 子进程退出：`research/codex_process`，定时重试。
- 超时或 SIGTERM：`research/research_timeout`，定时重试。
- 新闻源或检索网络暂不可用：`research/network_unavailable`，定时重试。
- 未完成要求的网页搜索：`research/insufficient_search`，定时重试。
- schema、时间窗、摘要校验失败：`research/invalid_result`，定时重试。
- HN 单篇获取或深读失败：剔除并顺延到官方前 10 名中的下一篇，不触发整份日报重试；HN 整体不可用时继续普通新闻。只有普通新闻研究等整体生成失败才进入定时重试。
- Vault 不可用：`archive/archive_unavailable`，复用同日 preview 重试归档。
- 目标在发送前变化：`configuration/target_changed`，不可重试；用户需重新启用。
- 发送超时/未知或部分接受：保持原有防重复终态。
- 到 23:59 后不再安排当日 retry；次日 08:30 正常新建 run。
- 手动预览与后台 run 继续通过现有 `runExclusive` 串行，不能并发覆盖。
- Research retries from the Weixin command “立即重试日报” and local `POST /api/news/retry` share the existing same-day research/archive retry state machine and preserve the original retry deadline on failure. When idle, the Weixin command also supplies fresh inbound for cached recovery before considering a research retry; the local HTTP action does not supply conversation context.

## 7. TDD 与验证

纵切 1：定时器 seam 固定时间，证明研究失败在 10 分钟后自动重试并成功，无需 `preview()`。

纵切 2：连续失败验证 10/30/60/60 分钟；跨日停止；服务重启按持久化 `nextRetryAt` 恢复。

纵切 3：归档失败复用同日 preview，不重复研究；发送 `unknown/partial` 不进入 retry。

纵切 4：错误分类和 public state/UI，只暴露安全字段。

整体验证：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e`。fixture E2E 不访问网络、不发送真实微信。Deployment of the verified candidate may restart the authorized existing service and resume its already-enabled schedule. Automated tests do not submit to real Weixin; manual test sends require the user’s confirmation.
