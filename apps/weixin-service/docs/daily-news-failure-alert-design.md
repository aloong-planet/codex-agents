# 日报失败微信通知与立即重试设计

日期：2026-08-15

## 1. 已确认需求

- 后台日报的研究或 Vault 归档失败后，立即向已绑定微信目标发送一次失败通知。
- 通知只展示安全分类：失败阶段、中文原因、尝试次数、失败时间与下次自动重试时间；不发送原始异常、本地路径、命令、token、URL 或正文。
- 通知提示用户回复固定中文命令 `立即重试日报`；不支持 `/retry-news`，不新增网页立即重试按钮。
- 用户发出该命令后立即重试同一天失败任务；成功后原计划重试自动取消。
- 立即重试若仍在研究或归档阶段失败，保留命令触发前的原定 `nextRetryAt`，不因本次即时尝试把后台时间向后推。
- 失败通知若被渠道明确拒绝，等同一目标下一条普通入站刷新上下文后安全补发一次；若发送超时或结果未知，绝不重发。
- 不对手动预览失败发微信通知。日报正文发送失败也不尝试再用同一渠道发送“发送失败通知”，避免循环与重复。

## 2. 已核实事实

- `DailyAiNewsScheduler` 已持久化 `failureStage`、`failureCode`、`attempt` 和 `nextRetryAt`，但失败 catch 只更新本地 notice 后返回。
- scheduler 与 `WeixinCodexService` 都独立订阅 `onInboundText`；当前通道会把同一事件同步广播给所有 listener，没有消费语义。若 scheduler 直接识别命令，普通 Codex 仍会并行回复。
- iLink `sendText` 可区分 `rejected` 与 `unknown`：明确拒绝可确定未发送；超时/异常只能判未知。
- Failure notices remain independent from cached report delivery and its [ordered recovery policy](../../../docs/specs/daily-ai-news.md). Notices do not change the report retry state; unknown outcomes are never retried.

## 3. 模块与 seam

### 3.1 通道命令消费 seam

在 `WeixinChannel` 增加可选接口：

```ts
onInboundCommand?(handler: (event: InboundTextEvent) => boolean | Promise<boolean>): () => void;
```

`DirectIlinkChannel` 在广播普通 `onInboundText` 前，先按注册顺序调用命令 handler；第一个返回 `true` 的 handler 消费事件，普通 listener 不再收到它。Handlers are awaited within durable inbound processing; a consumed command completes its work before the inbound lease completes. The fixture adapter follows the same contract.

这个 seam 把“是否是基础设施命令”放在唯一分发点，调用方不需要共享可变 flag，也不依赖 listener 注册顺序。普通消息路径完全不变。

### 3.2 `DailyAiNewsScheduler` 深模块

不新增 scheduler 公共控制方法，也不增加面板/HTTP 接口。scheduler 在 `start()` 时同时订阅：

- `onInboundCommand`：只对已启用日报的同一 `accountId + target`，并且文本严格 trim 后等于 `立即重试日报` 时返回 `true`；
- `onInboundText`：继续处理日报正文待补发，以及被明确拒绝的失败通知待补发。

立即重试的并发、日期、状态、目标校验全部留在 scheduler。通道只知道 handler 是否消费，不知道日报状态。

### 3.3 持久化失败通知

`DailyAiNewsRun` 新增私有且可公开映射的通知状态：

```ts
type FailureNoticeStatus =
  | "accepted"
  | "pending_inbound"
  | "unknown"
  | "failed";

failureNotice?: {
  status: FailureNoticeStatus;
  message?: string;       // 仅 pending_inbound 时保存，用于一次安全补发
  updatedAt: number;
};
```

通知不能改变 run 的 `failed` 状态或 `nextRetryAt`。公开状态只映射 `failureNoticeStatus`，不返回通知正文或持久化的待补发消息。

## 4. 用户操作与状态路径

### 4.1 自动尝试失败，通知被接受

1. `researching -> failed(stage, code, nextRetryAt)` 并先持久化。
2. 格式化安全通知并调用 `channel.sendText`。
3. 渠道接受后写 `failureNotice.status=accepted`。
4. 原后台 timer 仍指向 `nextRetryAt`。

### 4.2 通知明确拒绝或结果未知

- `reason=rejected`：写 `pending_inbound + message`。同目标下一条普通入站后，用该事件绑定的新 context 只补一次；补发无论 accepted、rejected 还是 unknown 都进入终态，不再补第二次。
- `reason=unknown` 或调用抛错：写 `unknown`，不保存可重发消息。
- `auth_stale` 或其他确定不可用：写 `failed`，等待用户重新连接；不把它伪装成已通知。

### 4.3 用户回复“立即重试日报”

1. 命令消费 seam 阻止普通 Codex 收到该消息。
2. Reject a mismatched binding. If idle with cached eligible content, resume it first; do not regenerate that content. Without cached work or a same-day research/archive failure, consume the command and reply “今天没有可立即重试的失败日报任务。”
3. 若已有研究/发送在运行，消费并回复“日报任务正在运行”。
4. 捕获失败 run 的原 `nextRetryAt`，异步发送“已开始”确认；不等待该协议请求结束，立即进入 `runAutomatic(attempt+1)`。
5. 成功进入 ready/send 之后，run 不再含 `nextRetryAt`；`scheduleNext()` 只安排次日 08:30。
6. 若研究/归档再次失败且原 `nextRetryAt` 仍是今天的未来时间，恢复该时间；否则不创建新的即时重试时间。随后按新的安全原因发送失败通知。

### 4.4 原定 timer 与即时命令竞争

- Research retries reserve `commandRetryInFlight` before joining the serial queue. Cached recovery selects and reserves reports inside that same queue. A busy command receives the existing busy reply without starting another operation.
- 私有即时重试流程开始前取消当前 timer；完成后统一 `scheduleNext()`。
- 若 timer 已先进入任务，命令只回复“正在运行”，不排第二次。
- 若命令成功，旧 timer 已取消且新的状态不是 retryable；若命令失败，重新安排被保留的原时间。

## 5. 通知文案

固定纯文本，不超过单段限制：

```text
AI 新闻日报执行失败
阶段：新闻研究
原因：实时新闻研究超时
尝试：第 2 次
失败时间：2026-08-15 09:12:00
下次自动重试：2026-08-15 09:42:00
如需立即重试，请回复：立即重试日报
```

无后续计划时显示 `下次自动重试：今日不再自动重试`，仍允许同一天主动命令重试。

## 6. 验证

- scheduler 高层 seam：研究失败/归档失败分别发送安全通知，字段完整且无原始错误。
- 命令路由 seam：精确中文命令被消费且 Codex listener 不收到；大小写、附加文字、其他目标不消费。
- 即时成功：取消旧 timer，不再执行原定重试。
- 即时失败：保留原 `nextRetryAt`，到点仍执行；重复命令或 timer 竞争不并发。
- 通知发送：accepted、rejected→下一入站补一次、unknown 不补、第二次拒绝不再补。
- 持久化与重启：pending failure notice 可恢复；accepted/unknown 不会重复发送。
- 全量 lint、typecheck、单测、build 与 fixture E2E；不在自动测试中连接腾讯或真实发送。
