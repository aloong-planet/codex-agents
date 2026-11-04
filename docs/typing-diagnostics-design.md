# Typing 脱敏诊断设计

## 目标

在不记录账户、目标、`context_token`、typing ticket、URL 或请求正文的前提下，把现有聚合的 `typing_start` 拆出三个可观测字段：

1. ticket 缓存：`hit` 或 `miss`；
2. `getconfig`：耗时与 `completed` / `failed`；缓存命中时为 `skipped`；
3. `sendtyping(status=1)`：耗时与 `completed` / `failed`。

现有 `typing_start` 总计时继续保留，保证历史页面和运行状态兼容。

## 已确认的数据流

当前 `IlinkTypingManager.start()` 先解析 ticket，再发送 typing。缓存未命中时，ticket 解析会串行调用 `getconfig`；命中时跳过。首次 typing 发送成功后才创建 5 秒 keepalive，停止阶段另行发送 `status=2`，不属于本次三个字段。

官方插件将 `getConfig` 放在 monitor 的入站处理阶段，再把 ticket 传给消息处理器。这个“提前”仍依赖具体目标与该入站提供的 `context_token`，不能在扫码完成但尚无入站上下文时安全执行。完整源码调研见 [`typing-ticket-prefetch.md`](/Users/loong_zhou/research/codex-weixin-typing-latency/typing-ticket-prefetch.md)。

## 模块与接口

`IlinkTypingManager` 保持唯一外部方法 `start(context)`。返回的 lease 新增只读诊断快照：

```ts
type TypingInitializationDiagnostics = {
  ticketCache: "hit" | "miss";
  getConfig: { durationMs: number; outcome: "completed" | "failed" | "skipped" };
  sendStart: { durationMs: number; outcome: "completed" | "failed" | "skipped" };
};
```

缓存判断、计时和失败归类全部封装在 typing 模块内。渠道只透传 lease；Codex 宿主只把快照写进对应 run，页面只读展示，不理解 ticket 生命周期。

选择返回快照而不是 observer callback：三个值只需在 `start()` 结束后用于事后诊断；callback 会把内部步骤和调用顺序泄漏给所有调用者，扩大 interface。现有总计时仍能在请求未完成时显示“进行中”。

## 持久化与兼容

`TargetRuntimeRun` 新增可选 `typingDiagnostics`。旧状态没有该字段时按不存在加载，不伪造历史数据。加载器只接受固定枚举和非负有限毫秒数；其余内容整块丢弃。公共状态不增加任何原始标识符。

页面在 `typing_start` 行下展示：

- `ticket 缓存：命中/未命中`
- `getconfig：<耗时> · 完成/失败/已跳过`
- `sendtyping：<耗时> · 完成/失败/已跳过`

## 失败模式

- `getconfig` 失败或没有 ticket：`miss + getConfig.failed + sendStart.skipped`，lease inactive。
- ticket 命中但首次 `sendtyping` 失败：`hit + getConfig.skipped + sendStart.failed`，并按现有行为失效缓存。
- ticket 未命中、获取成功、发送失败：`miss + getConfig.completed + sendStart.failed`。
- keepalive 或 stop 失败不改写初始化诊断；分别保持现有吞错/`typing_stop` 语义。
- 计时使用注入的 `now()`，测试可确定复现；毫秒数取非负值。

## 验证

- `IlinkTypingManager`：冷成功、热成功、getconfig 失败、sendtyping 失败四条纵切。
- `WeixinCodexService`：lease 诊断进入 public state。
- `CodexServiceStore`：合法字段往返；恶意或畸形字段不进入公共状态。
- 页面 fixture：三个字段按中文标签显示，旧 run 不显示空诊断。
- 全量：lint、typecheck、单元/集成测试；浏览器打开本地页面检查 DOM，不触发真实微信请求。

## ticket 提前获取结论

可行的最早安全时机是“某条入站已经提供 account、target、context token 之后，进入目标 FIFO 或模型处理之前”。不能在扫码完成时预取，因为当时未必有可发送目标和对应上下文。

如果后续实施，推荐不是简单把 `await getConfig` 前移，而是：入站持久化后立即非阻塞预取、按 `(account,target)` 合并 in-flight 请求、`startTyping` 命中缓存或等待同一 promise。服务重启后可对持久化的最近目标做限量后台 warm-up，但 ticket 本身仍只保存在内存。这样才能与 FIFO/可靠入站并行，而不是仅把耗时从 `typing_start` 搬到 `inbound`。本次先增加可观测性，取得 3–5 个真实样本后再决定是否单独实施预取。
