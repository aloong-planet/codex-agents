# 正文发送与 typing 关闭并行设计

## 目标

模型产生最终正文后，立即并行启动两个互不决定对方结果的副作用：

1. 向腾讯 iLink 发送 `sendtyping(status=2)`；
2. 发送最终正文。

正文不得等待 typing 关闭响应。typing 关闭失败或超时不得把已接受的正文改判为失败；正文发送失败也不得取消 best-effort typing 关闭。

## 用户操作序列与状态

### 正常回复

1. 模型完成，安全工具进度已排空；
2. 同一事件循环中启动 typing 关闭和正文发送；
3. 正文按自身 iLink 结果记录 `completed`、`failed` 或 `unknown`；
4. typing 关闭按自身结果记录 `completed` 或 `unknown`；
5. 两项都收口后结束本次运行并释放同目标 FIFO。

用户可在 typing 关闭仍等待时收到正文。运行状态总耗时仍包含较慢的清理请求，但“发送最终回复”的耗时只覆盖正文请求本身。

### 模型失败或模型不可用

固定失败说明或模型不可用说明与 typing 关闭按同样规则并行。用户提示不能被辅助 UI 状态清理阻塞。

### typing 关闭失败或超时

正文结果保持原判；typing 阶段显示 `unknown`。不自动重发 `status=2`，避免未知结果重复。

### 正文发送失败或结果未知

typing 关闭继续完成一次；正文遵循现有不自动重发规则。

### 同目标紧接下一条消息

为避免上一轮未完成的 typing 清理与下一轮 typing 状态交错，本次运行仍等待两项都收口后才释放现有 FIFO。此次改造只移除正文的等待，不改变同目标串行处理不变量。

## 深模块与 seam

不扩大 `InboundTextEvent` 或 `IlinkTypingLease` 的外部 interface。在 `WeixinCodexService` 内新增一个私有深模块方法：

```ts
sendReplyWhileStoppingTyping(event, runId, stopTyping, message): Promise<SendTextResult>
```

实现隐藏并行启动、独立计时、错误隔离和统一收口。成功回复、固定失败回复和模型不可用回复都经过同一方法，避免三个调用点分别维护竞态规则。

## 计时语义

- `typing_stop`：仅从调用 `stopTyping()` 到其结束；
- `outbound`：仅从调用 `replyText()` 到渠道结果；
- 两个区间允许重叠；
- `totalDurationMs`：仍到两项均结束后才完成，因此可能接近两者中的较慢值，而不是两者之和；
- 面板按各自 `startedAt/completedAt` 展示真实并发，不伪造缩短后的 typing 耗时。

## 验证

- 使用 deferred typing stop，断言 stop 尚未完成时 `replyText` 已调用并可返回；
- typing stop 失败时正文仍按渠道结果完成；
- 正文失败时 stop 仍只调用一次；
- 阶段计时重叠，`outbound` 不包含 typing stop 等待；
- 原有工具进度顺序、同目标 FIFO、memory capture 与不重试规则保持。
