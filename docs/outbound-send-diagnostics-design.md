# 正文发送脱敏耗时明细设计

## 目标

把运行状态中的“发送最终回复”拆成四个可解释、可持久化、不会暴露消息或凭据的阶段：

1. `prepare`：正文分段、client id 与每次请求体准备；多段或重试时累计。
2. `sendMessage`：调用 `fetch` 到收到 HTTP 响应头。
3. `responseRead`：读取并解析 iLink JSON 响应。
4. `stateSave`：渠道接受后持久化 `lastSendAcceptedAt`。

总桶 `outbound` 保持不变。它仍是用户可见的端到端发送时间；明细只解释总桶，不改变发送、分段、重试或未知结果处理策略。

## 已确认事实

- `WeixinCodexService.replyTextTimed()` 只知道 `event.replyText()` 的总结果，不应该了解 iLink HTTP 细节。
- `DirectIlinkChannel.sendTextWithContext()` 负责分段与重试，`sendTextSegment()` 负责真实 `sendmessage` 请求，细分计时应留在这个深模块内。
- 改造前 `postAuthenticated()` 把 `fetch` 与 `readJson()` 合并；实现已抽出 authenticated request 准备，让 `sendmessage` 单独计量响应头等待与响应体读取。
- 运行状态按 `(accountId,target)` 只保留最近一次 run；新增明细必须进入 `TargetRuntimeRun` 并经过 store allowlist，才能跨刷新和重启显示。
- `SendTextResult` 已经是渠道与聊天主流程之间的 seam，适合携带可选的脱敏 diagnostics；调用者不需要知道 URL、token、正文或响应正文。

## Interface

在 `SendTextResult` 增加可选字段：

```ts
type OutboundDeliveryDiagnosticStep = {
  durationMs: number;
  outcome: "completed" | "failed" | "skipped";
};

type OutboundDeliveryDiagnostics = {
  prepare: OutboundDeliveryDiagnosticStep;
  sendMessage: OutboundDeliveryDiagnosticStep;
  responseRead: OutboundDeliveryDiagnosticStep;
  stateSave: OutboundDeliveryDiagnosticStep;
  requestCount: number;
};
```

`WeixinCodexService` 只把 `result.diagnostics` 存入当前 run；页面只渲染上述 allowlist。接口不包含 endpoint、目标、正文、响应正文、context token、typing ticket、client id 或账户凭据。

## 计时与聚合语义

- 使用渠道已有的注入式 `now()`，便于确定性测试。
- 多段和一次重试会把同类阶段的耗时求和；`requestCount` 是实际发起的 `sendmessage` 请求数。
- 某阶段只要有一次失败，聚合 outcome 为 `failed`；至少执行一次且从未失败为 `completed`；从未执行为 `skipped`。
- `sendMessage` 只覆盖等待 HTTP 响应头；`responseRead` 单独覆盖 `response.json()`。
- `stateSave` 只在 iLink 接受该段后执行。保存失败不能推翻渠道已经接受的事实，但 diagnostics 标为 `failed`。
- 账户、目标或 context 的前置校验未通过时不会进入 `sendTextWithContext()`，因此不生成这组明细；总 `outbound` 仍显示快速失败。

## 失败模式

按用户真实操作序列：

1. 单段成功：四段 completed，requestCount=1。
2. iLink 返回业务拒绝：sendMessage/responseRead completed，stateSave skipped；若重试，耗时累计、requestCount=2。
3. 网络失败或超时：sendMessage failed，responseRead/stateSave skipped；现有策略至多复用相同 client id 重试一次。
4. 响应 JSON 无效：sendMessage completed，responseRead failed，stateSave skipped。
5. iLink 接受但本地状态写盘失败：发送结果仍 ok，stateSave failed。
6. 多段部分成功：各阶段累计到停止位置，不会把未执行步骤伪装为 completed。
7. 页面刷新或进程重启：store 只恢复合法整数、合法 outcome 和有限 requestCount；异常数据使状态文件校验失败，不把秘密或任意对象透传到页面。
8. 请求体准备异常：prepare failed，并立即清理 Abort 定时器；不会留下 15 秒资源尾巴。

## 测试 seam

1. `DirectIlinkChannel.sendText()`：用受控时钟和延迟 fetch/JSON 验证四段耗时及失败分支。
2. `WeixinCodexService.getPublicState()`：验证渠道 diagnostics 被保存到当前 run，且总 `outbound` 行为不变。
3. `CodexServiceStore`：验证 allowlist、范围校验和未知字段剥离。
4. fixture E2E：验证“发送最终回复”下显示四行耗时与一行请求次数，不显示任何敏感字段。

## 非目标

- 不更改正文并行发送策略。
- 不更改 15 秒超时、分段上限或重试策略。
- 不主动发送探针消息。
- 本次不拆 DNS、TCP、TLS；如果 `sendMessage` 仍慢，再增加底层网络 adapter 的受控诊断。
