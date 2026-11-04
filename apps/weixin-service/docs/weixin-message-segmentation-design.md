# 微信正文截断与分段发送设计

日期：2026-08-14

2026-08-23 可靠性第二阶段修订：未知发送结果不再自动重试；只有腾讯明确返回拒绝时才允许当前段重试一次。以下行为与失败场景已按新约束回同步。

## 目标与已确认决策

腾讯个人微信正文按单条最多 1,500 个 Unicode 字符处理。用户确认：

- 所有出站文本统一应用分段，包括日报、Codex 回答、语音提示、自动问候和测试消息；
- 一次逻辑发送最多 8 段，超过约 12,000 字符的部分截断并明确标记；
- 多段消息每段显示 `[序号/总数]`；单段消息不显示序号；
- 每段顺序发送；腾讯明确拒绝时重试当前段一次；超时、断线或响应无法解析时立即停止，不自动重试；
- 每个实际 iLink 请求在调用前写入持久出站账本；未知结果保守停止，避免重复段落。

完成标准：

1. 任意提交给真实 iLink 的 `text_item.text` 按 Unicode code point 计数均不超过 1,500。
2. 优先在空行、换行、句末或空格处分段；找不到安全断点时按 code point 硬切，不拆 UTF-16 surrogate pair。
3. 多段编号本身计入 1,500 字符；单段保持原文，不增加系统前缀。
4. 最多发送 8 段；截断时最后一段包含 `（内容过长，已截断）`，该标记也计入限制。
5. 同一段只有明确 `rejected` 时最多尝试两次并复用同一个 `client_id`；每次网络调用使用独立持久 attempt。`unknown` 只尝试一次。
6. 首个最终失败后不继续后续段；返回已接受段数、总段数、截断、重试和重复可能性。
7. Daily news preserves up to ten selected articles using complete short summaries within 1,500 code points. It still enters the shared segmenter, which produces one segment for a newly formatted valid report.
8. 部分成功不能进入 `pending_inbound` 自动整篇补发，否则会重复已接受的前段。
9. 测试和 E2E 不调用真实腾讯接口；真实长消息最后由用户明确触发并在手机端确认。

## 已确认事实

- `DailyAiNewsScheduler.formatNewsDigest()` keeps all selected articles within 1,500 code points using validated complete briefs and bounded metadata; it does not cut summary sentences.
- `WeixinCodexService` 当前把模型最终回答截到 500 字符；`DemoService.sendTestMessage()` 也拒绝超过 500 字符的消息。
- `DirectIlinkChannel.sendText()` 和入站事件的 `replyText()` 最终都进入 `sendTextWithContext()`；后者是覆盖所有真实文本出站的最低共同 seam。
- iLink 的一次 `sendmessage` 请求只携带一个文本 item。每次请求有独立结果，协议未承诺跨请求事务或 exactly-once。
- 当前超时为 15 秒，异常/超时归类为 `unknown`。不能证明消息未送达。
- 日报的 `pending_inbound` 会在同目标入站后重新发送整个 `run.message`；因此只有零段被接受的明确失败可以进入该状态。

## 模块与接口

### `WeixinTextSegmenter`

纯函数模块，接口只暴露一个逻辑正文到确定性发送计划：

```ts
type WeixinTextPlan = {
  segments: string[];
  truncated: boolean;
  originalLength: number;
};

function segmentWeixinText(text: string): WeixinTextPlan;
```

implementation 隐藏 code point 计数、断点优先级、编号预算、8 段上限和截断标记。调用方不能自行传入更大的限制。

分段规则：

1. trim 后为空则拒绝；保留正文内部换行。
2. 单段不超过 1,500 时原样返回。
3. 多段先为 `[N/N]\n` 预留最坏编号空间，再按空行、换行、中文/英文句末、空格的优先级寻找最后一个断点。
4. 断点过早（不足本段容量一半）时忽略，改为硬切，避免产生大量短段。
5. 超过 8 段时缩短第 8 段，为截断标记留出空间；不生成第 9 段。
6. 结果最终逐段复核 code point 长度，任何超限视为 implementation bug 并拒绝发送。

### `DirectIlinkChannel`

外部 `sendText(input)` 与入站事件 `replyText(message)` 的接口保持一个逻辑正文。`sendTextWithContext()` 内部：

```text
segmentWeixinText(message)
  -> segment 1 attempt 1
       -> accepted: next segment
       -> rejected: same client_id, new ledger attempt 2
            -> accepted: next segment
            -> rejected/unknown: stop
       -> unknown: stop without retry
  -> aggregate SendTextResult
```

`SendTextResult` 扩展为：

```ts
type SendTextResult = {
  ok: boolean;
  messageId?: string;
  messageIds?: string[];
  totalSegments?: number;
  acceptedSegments?: number;
  truncated?: boolean;
  retriedSegments?: number;
  duplicatePossible?: boolean;
  error?: string;
  reason?: "auth_stale" | "rejected" | "unknown";
};
```

聚合字段在类型层保持可选，以兼容既有测试端口和第三方 `WeixinChannel` 实现；真实
`DirectIlinkChannel` 对每次返回（包括发送前失败）都会填充这些字段，调用方对旧实现使用
单段或零段的保守默认值。

- `messageIds` 只包含被 iLink 接受的段；现有 `messageId` 保留为最后一段兼容字段。
- `auth_stale` 是安全例外：凭据已明确失效时不做第二次请求，直接停止。
- `unknown` 不再产生第二次请求，因此新版本不会因内部重试设置 `duplicatePossible=true`；字段保留用于兼容历史状态和旧通道实现。
- 第一段发送前账户、目标和 context token 仍按现有方式校验；每次尝试前再次确认账户未变化。
- 每个逻辑发送内部严格串行，不并发段落，保持可见顺序。

## 调用方状态映射

### Codex 与语音回复

- 模型回答上限从 500 提升到 12,000 code points，超过时先在逻辑正文处截到安全持久化上限；通道仍做最终 8 段门禁。
- 全部接受：transcript `accepted`。
- 接受部分段：transcript 新状态 `partial`，notice 显示 `已接受 X/Y 段`，不自动继续或重发。
- 零段接受：沿用 `send_failed`。
- 历史或外部通道返回 `duplicatePossible` 时 notice 仍明确“可能重复”；新直连通道的 unknown 不重试。

### 日报

- `formatNewsDigest()` formats all selected articles, up to ten, within 1,500 code points; detailed prose remains in the local archive. See [the single-message design](weixin-single-message-news-digest-design.md).
- `DailyRunStatus` 新增 `partial`；部分成功永不进入入站补发。
- All accepted segments produce `accepted`. Newly formatted reports fit one segment; historical frozen bodies retain the general eight-segment safety limit and its explicit truncation notice.
- 零段明确失败：仍可 `pending_inbound`；零段未知：`unknown`。
- `run.message` 持久化上限提升到 20,000 code units，覆盖最多 10 条 schema 允许的新闻正文。

### 测试消息与自动问候

- 测试消息上限提升为 12,000 code points；HTTP body 上限调整到 64 KiB，仍拒绝控制字符。
- 自动问候和固定提示通常保持单段；若请求未知则停止，不自动重试。
- 页面反馈显示段数、截断、部分成功或重复可能性，不展示 `client_id`。

## 用户真实操作序列与失败模式

1. **发送 1,500 字符以内正文**：一次请求，无编号；成功行为与现有版本相同。
2. **发送恰好需要两段的正文**：收到 `[1/2]`、`[2/2]`，每段含编号后不超过 1,500。
3. **一个段落超过容量**：优先句末；仍无断点时按 code point 硬切，emoji surrogate pair 不被拆开。
4. **正文超过 8 段**：只发送 8 段，第 8 段结尾标明截断；返回 `truncated=true`。
5. **第 3 段首次明确拒绝、第二次接受**：继续第 4 段；`retriedSegments=1`，不标重复可能。
6. **第 3 段首次超时/断线/响应解析失败**：记录 unknown，立即停止，不发送第 4 段，也不重试第 3 段。
7. **第 3 段明确拒绝、第二次仍拒绝或变为 unknown**：停止，不发送第 4 段；返回 `acceptedSegments=2`，调用方记录部分成功。
8. **第一段明确失败或 unknown**：日报分别记录 rejected/unknown；unknown 不补发。
9. **发送中账户变化或凭据 stale**：立即停止，不重试；已接受前段不可撤回。
10. **进程在第 3 段请求期间退出**：没有跨段事务；重启后日报发送态转 `unknown`，不自动重放。
11. **用户连续发两条消息**：既有 per-target FIFO 保证第二个 Codex job 等待第一个逻辑发送结束；每个逻辑发送内部也串行。
12. **页面预览很长**：可以显示完整逻辑正文；实际发送后的反馈显示真实段数与截断，不把预览等同于已送达。

## 验证策略

- 纯函数：1/1,500/1,501 边界，换行/句末/硬切，emoji，编号预算，8 段截断标记及确定性。
- 通道集成 seam：单段、多段顺序、明确 rejected 时同 client ID/独立 attempt 重试、unknown 只调用一次、第二次失败停止、auth stale 不重试。
- 调用方：Codex partial transcript；日报 partial 不进入 inbound 补发；测试消息长正文反馈。
- 状态迁移：旧日报与 Codex 状态继续可读，新状态和更长正文受严格上限校验。
- 全量：`pnpm lint`、`pnpm typecheck`、单元/集成测试、build、fixture E2E。
- 真实验证：自动化完成后，由用户明确发送一条无敏感信息的长测试正文；记录每段渠道接受，用户在手机确认段数、顺序与是否重复。
