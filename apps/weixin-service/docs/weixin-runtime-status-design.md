# Weixin `/echo`、Typing 与运行状态设计

日期：2026-08-15

## 1. 目标与成功标准

在独立腾讯 iLink + Codex App Server Demo 中实现三条真实链路：

1. 微信发送 `/echo <内容>` 时，不进入 Codex，直接回显内容并另发通道耗时。
2. 普通入站消息处理期间显示微信原生“正在输入”；正常结束、失败或服务关闭时可靠取消。Typing 不可用时才发送现有固定文字回执。
3. Codex 调用工具时，用腾讯 iLink 原生 `TOOL_CALL_START` / `TOOL_CALL_RESULT` 项展示开始与结果；网页按目标展示实时阶段、当前工具与最近步骤。

成功标准：

- `/echo hello` 只产生回显和耗时两次出站，不启动/恢复 Codex task，不发送 ACK 或 typing。
- 普通消息在 Codex 工作前开启 typing，每 5 秒续期，在最终文本发送前取消；任何退出路径都不泄漏定时器。
- getConfig 无 ticket、超时、非零 ret 或首次 sendtyping 失败时只降级为现有 ACK，不阻断 Codex。
- App Server 的受支持 item 在 `item/started` 与 `item/completed` 产生有序、脱敏的微信原生工具状态；最终正文必须等已排队的进度消息排空后再发送。
- 不把命令、参数、查询、路径、工具输出、thread ID、token 或完整目标 ID放入微信进度或网页运行记录。
- 同一目标继续 FIFO；不同目标并行时互不覆盖状态。

## 2. 已确认事实

### 腾讯插件 2.4.6（npm latest）

- `/echo` 直接发送参数，再发送“平台→插件、插件处理”耗时，并返回 `handled=true` 跳过 AI：`src/messaging/slash-commands.ts:39-99`。
- typing ticket 来自 `ilink/bot/getconfig`；typing 调用 `ilink/bot/sendtyping`，状态 `1=typing`、`2=cancel`：`src/api/api.ts:522-553`、`src/api/types.ts:231-255`。
- 官方处理期间每 5 秒续期 typing，完成后取消；typing 错误只记录，不阻断回复：`src/messaging/process-message.ts:291-320`。
- 工具进度使用 `MessageItemType.TOOL_CALL_START=11` 与 `TOOL_CALL_RESULT=12`，共享 `run_id`，发送顺序由 promise chain 保证：`src/api/types.ts:70-79`、`src/messaging/reply-progress-sender.ts:34-121`。
- 官方配置缓存按用户保存 typing ticket，成功后在 24 小时内随机刷新，失败采用 2 秒到 1 小时指数退避：`src/api/config-cache.ts:8-77`。

### Codex App Server

- 官方 OpenAI 文档确认所有 item 都有 `item/started` 与 `item/completed` 生命周期，completed 是权威终态。
- 可映射的工作 item 包括 `commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabToolCall`、`webSearch`、`imageView`、`contextCompaction`。
- 动态工具调用顺序为 `item/started` → `item/tool/call` → client response → `item/completed`。
- 依据：https://learn.chatgpt.com/docs/app-server （Item lifecycle / Dynamic tool calls）。

### 当前 Demo

- `CodexConversation` 当前只消费 agent 文本 delta 和 turn completed；没有公开 item 生命周期。
- `WeixinCodexService` 用全局 `status/notice`，不同目标并行时会相互覆盖。
- 每个 `(accountId,target)` 已有独立 FIFO；入站事件闭包捕获当条消息的 context token。
- 当前每条普通消息先发送固定 ACK，再调用 Codex。

## 3. 用户已确认的产品决策

- Typing 优先，固定文字 ACK 仅作 ticket 缺失或首次 typing 失败的兜底。
- 所有受支持工具步骤都显示，但只显示固定的安全中文标签和结果状态。
- 网页面板按目标显示实时状态和有界最近记录。
- `/echo` 按腾讯插件 2.4.6 的官方语义实现。

## 4. 模块与 seam

### 4.1 `InboundTextEvent`：上下文绑定的 iLink 反馈 seam

扩展事件接口：

```ts
type TypingLease = {
  active: boolean;
  stop(): Promise<void>;
};

type WeixinToolProgress = {
  runId: string;
  itemId: string;
  label: SafeToolLabel;
  phase: "start" | "end";
  status?: "completed" | "failed" | "blocked" | "unknown";
};

startTyping(): Promise<TypingLease>;
replyProgress(progress: WeixinToolProgress): Promise<SendTextResult>;
```

调用者不接触 token、baseUrl、typing ticket 或 iLink JSON。事件闭包固定当条入站的账户、目标、context token，避免异步期间误用“最新目标”的可变凭据。

### 4.2 `IlinkTypingManager`：深模块

接口只提供 `start(context): Promise<TypingLease>`；实现内部隐藏：

- getConfig 请求；
- 每目标 ticket 缓存；
- 24 小时内随机刷新；
- 2 秒起、最大 1 小时的失败退避；
- 首次 sendtyping 与 5 秒 keepalive；
- 幂等 stop、定时器清理和 cancel typing。

账户重绑或凭据失效时清空缓存。getConfig/sendtyping 失败不得泄露原始响应或凭据到公开状态。

### 4.3 `CodexConversation`：App Server item observer seam

`reply` 接受可选 `onProgress(event)` observer。只从与 active turn 的 `threadId/turnId` 匹配的 `item/started`、`item/completed` 生成规范化事件。observer 异常不能终止 App Server transport 或 Codex turn。

固定映射：

| App Server item type | 微信安全标签 |
|---|---|
| `commandExecution` | 执行本地命令 |
| `fileChange` | 修改文件 |
| `mcpToolCall` | 调用 MCP 工具 |
| `dynamicToolCall` | 调用本地工具 |
| `collabToolCall` | 协同处理 |
| `webSearch` | 搜索网页 |
| `imageView` | 查看图片 |
| `contextCompaction` | 整理会话上下文 |

不映射 user/agent message、reasoning、plan、review mode，也不发送任何 item 参数或输出。

### 4.4 `WeixinCodexService` 内的有序发送链

每轮创建一个独立 promise chain：

```ts
onProgress(event): void;
await progressChain;
```

内部用 promise chain 串行调用 `event.replyProgress`。单条进度发送失败只记为 `send_failed`，不取消 Codex；`finalize` 等队列排空，确保最终正文不会越过尚未发送的工具终态。

### 4.5 按目标持久化运行状态

持久化结构升级到 `CodexServiceState.version=4`：

```ts
type TargetRunRecord = {
  accountId: string;
  target: string;
  runId: string;
  phase: "queued" | "typing" | "thinking" | "tool" |
    "sending" | "completed" | "failed" | "interrupted";
  queueDepth: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  activeTool?: SafeToolLabel;
  recentSteps: Array<{
    itemHash: string;
    label: SafeToolLabel;
    status: "running" | "completed" | "failed" | "blocked" | "unknown";
    at: number;
  }>;
};
```

- 每目标最多保留一个 active/latest run 记录和跨 run 的最近 20 条步骤。新消息进入已有活动目标的 FIFO 时只增加 `queueDepth`，不能覆盖仍在执行的 run；该消息真正出队时才切换到新的 runId。
- `itemId` 只存不可逆短 hash；不存命令、参数、路径、输出。
- typing 配置缓存键为 `(accountId,target)`，重新绑定账户后即使目标字符串碰巧相同也不能复用旧 ticket。
- 服务启动时将持久化的非终态 run 标成 `interrupted`，不能假称仍在执行。
- 保留旧全局 `status/notice` 作为兼容概览；按目标卡片是并发运行时的权威状态。

## 5. 用户真实操作序列与状态路径

### 5.1 `/echo hello`

1. 入站去重记录成功：run 进入 `queued`。
2. 轮到该目标处理时识别精确 `/echo` 命令。
3. 发送 `hello`；仅当渠道接受后继续发送耗时消息。若回显失败或结果未知，尝试一次固定失败提示后结束，不发送可能误导的耗时成功消息。
4. 耗时包含事件时间、平台→Demo（`observedAt - receivedAt`）、Demo 处理时间。
5. 不开启 typing、不发送 ACK、不启动 Codex、不产生工具进度。
6. 需要发送的消息均被渠道接受则 `completed`；任一发送失败或未知则 `failed`，不自动重试。

`/echo` 无参数时仅发耗时消息。未知斜杠命令继续作为普通文本交给 Codex，保持与官方 handler 的 `handled=false` 一致。

### 5.2 普通文本、语音转写或媒体

1. 入站持久化后进入目标 FIFO，run=`queued`，queueDepth 增加。
2. 出队后调用 `startTyping()`：
   - 成功：run=`typing`，不发固定 ACK；
   - ticket 缺失或首次 typing 失败：发送现有文本/语音 ACK；ACK 失败不阻止 Codex，但记录降级失败。
3. Codex turn 开始：run=`thinking`。
4. item start：追加安全步骤；run=`tool`，发送原生 TOOL_CALL_START。
5. item completed：追加终态并发送 TOOL_CALL_RESULT；若无其他活动工具，回到 `thinking`。
6. Codex 成功或失败后，在 `finally` 中 stop typing；cancel 失败只记录，不改变 Codex 结果。
7. `progress.finalize()` 排空后，run=`sending`，发送最终正文或固定失败提示。
8. 渠道接受则 `completed`；失败、部分发送或结果未知则 `failed`。不自动重试整轮。

### 5.3 多条同目标消息

- 后续消息只增加该目标 queueDepth，不替换当前 run，也不抢占当前 typing 或 activeTool。
- 当前 run 完成后，下一条真正出队时 queueDepth 递减并用下一 run 替换 active/latest 记录。
- 每轮使用自己的 event 闭包、context token、runId 和 progress chain。

### 5.4 多目标并行

- 每个目标拥有独立 queue、typing lease、progress chain 与 run record。
- 公共页面按当前选择目标渲染运行卡片；切换目标即可查看各自的权威状态。

### 5.5 关闭、崩溃与恢复

- `close()` 先停止接受新入站并关闭 agent；活动 lease 的 stop 采用 best effort，不能阻塞进程无限等待。
- 意外崩溃无法发送 cancel；微信端 typing 由服务端自然失效。下次启动把旧非终态记录标为 `interrupted`。
- 已发送的进度或正文不因恢复自动补发，避免重复。

## 6. 失败模式

- **getConfig 超时/拒绝/无 ticket**：固定 ACK 兜底；Codex 继续。
- **typing 首次发送失败**：固定 ACK 兜底；缓存保留但按退避重新获取配置。
- **typing keepalive/cancel 失败**：记录降级，不插入迟到 ACK，不阻断正文。
- **进度开始发送失败**：仍接收 completed，网页记录发送失败；正文继续。
- **进度 completed 早于 start 或重复**：按 item hash 幂等合并，发送端不重复发送同一 phase。
- **未知 App Server item**：忽略，不能把原始 type 当成标签发送。
- **observer 在 turn/start 响应前收到 item**：active turn 允许首次有效通知绑定 turnId，与现有 agent delta 逻辑一致。
- **finalize 等待进度过久**：每次 iLink send 仍使用 15 秒上限；进度失败后 chain 继续，最终正文不会永久卡死。
- **状态文件 v1-v3**：迁移为 v4，新增 runtimeRuns=[]；现有 task、权限、去重与 transcript 不丢失。
- **状态文件伪造超长列表/非法标签/时间**：严格解析并拒绝；公开状态不读取未验证字段。
- **工具参数含秘密**：observer 在最早 seam 丢弃，只保留枚举标签、终态和 hash。

## 7. 测试 seam 与验证计划

按纵切 TDD：

1. `WeixinCodexService` 高层 seam：`/echo` 跳过 agent、两次出站与耗时格式。
2. `DirectIlinkChannel` seam：getConfig、typing start/keepalive/cancel、无 ticket/错误降级、定时器清理。
3. `CodexConversation` seam：App Server started/completed 映射、turn 隔离、未知 item/敏感字段不泄露。
4. `WeixinCodexService` 高层 seam：进度顺序、失败不阻断、promise chain 排空先于最终正文。
5. `CodexServiceStore` seam：v1-v3→v4、非法状态拒绝、恢复时 interrupted。
6. 页面 E2E：两个目标并行卡片、当前工具、最近步骤、别名/短 ID、无敏感详情。

整体网关：`pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm test:e2e`。真实微信验收最后由用户发送 `/echo hello` 和一个会触发工具的普通请求；我们只观察渠道结果，不代用户发送。

## 8. 范围外

- 不实现 `/toggle-debug`。
- 不展示 reasoning、模型内部思考、命令文本、工具参数或输出。
- 不修改腾讯插件源码、OpenClaw 配置、账户凭据或 context token 存储。
- 不为 typing、进度或正文增加跨轮自动重发。
- 不把原生工具卡片降级成多条普通文本；客户端不支持原生类型时，只在网页保留运行记录。
