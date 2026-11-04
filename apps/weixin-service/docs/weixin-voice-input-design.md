# 微信语音入站与 Codex 回答设计

## 目标

在不复用 OpenClaw 通道、不过度扩大凭据暴露面的前提下，让独立 iLink Demo 接收真实个人微信 USER 语音消息：

1. 从 `voice_item.text` 读取腾讯 iLink 已提供的转写；
2. 把有效转写作为同一微信目标、同一 Codex 任务的新用户输入；
3. 将 Codex 的纯文本回答使用该条入站消息捕获的 `context_token` 回复到原微信目标；
4. Demo 面板以 `[语音转写] …` 明确展示识别文字；
5. 腾讯没有给出可用转写、语音超过 60 秒或时长元数据无效时，不调用 Codex，发送一次固定、诚实的提示。

第一版明确只使用腾讯 iLink 自带转写，不下载语音、不调用本地 Whisper、OpenAI 转写 API 或 Codex 实验性音频输入。

## 用户已确认的决策

- 转写来源：仅使用 `voice_item.text`。
- 单条语音上限：60 秒。
- 本地展示：保存并显示 `[语音转写] …`。

## 已确认事实

- 腾讯插件 2.4.6 的 `MessageItemType.VOICE` 为 `3`；`VoiceItem` 提供 `playtime`（毫秒）和可选 `text`。
- 插件在 `voice_item.text` 存在时直接把它作为消息正文；只有缺少该字段时才尝试 CDN 下载、AES 解密与 SILK 转 WAV。
- 当前 Demo 的 `DirectIlinkChannel` 只发布 `TEXT` item，因而语音虽然会刷新目标的 `context_token`，却不会进入 Codex 服务。
- `InboundTextEvent.replyText` 捕获事件当时的账户、目标和 `context_token`，异步回答不会误用后来入站消息的上下文。
- 官方稳定 App Server 文档只列出 `text`、`image` 和 `localImage` turn 输入。本机生成类型虽包含实验性音频变体，但本功能不依赖该未文档化路径。

## 模块边界

### `DirectIlinkChannel`

继续负责协议解析和消息级身份：

- 文本保持原有 `InboundTextEvent` 路径；
- 有效语音转写也转换成 `InboundTextEvent`，新增 `source: "voice"`；
- 文本事件使用 `source: "text"`；
- 无转写、超时长或时长元数据无效的语音发布 `InboundRejectedEvent`，只包含固定原因枚举、时长和回复闭包，不包含媒体 URL、AES key 或 token；
- 文本和语音拒绝事件复用同一个基于消息身份的去重 key；
- 每条入站最多发布一个可处理事件或一个拒绝事件。

新增的订阅 seam 为 `onInboundRejected`。不把媒体下载、模型调用或用户提示文案塞进协议层。

### `WeixinCodexService`

仍是自动回复的唯一编排层：

- 对有效语音走现有 per-target 串行队列；
- 先持久化 `[语音转写] …`，再发“已收到语音，正在处理。”，然后把原始转写交给 Codex；
- prompt 明确标注这是用户语音的转写，但不要求 Codex复述转写；
- 对拒绝事件先持久化 `[语音未处理]`，直接回复固定提示，不启动/恢复 Codex turn；
- 拒绝提示与正常回复都只尝试一次；渠道超时或结果未知时不自动重试。

### `DemoService`

自动绑定仍只消费 `onInboundText`。因此带有效腾讯转写的首条语音可以像文本一样完成目标绑定；无转写或非法时长的语音只刷新 channel snapshot，不触发问候或错误绑定。

## 状态与事件流

```text
getupdates USER message + context_token
  -> 保存最新 context_token / target metadata
  -> TEXT item
       -> InboundTextEvent(source=text)
  -> VOICE item + 0 < playtime <= 60000 + nonblank text
       -> InboundTextEvent(source=voice)
  -> VOICE item + missing text / invalid duration / over 60000
       -> InboundRejectedEvent(reason)

InboundTextEvent(source=voice)
  -> 持久化 [语音转写]
  -> 单次语音 ACK
  -> 同目标 Codex thread
  -> 单次 iLink 文本回答

InboundRejectedEvent
  -> 持久化 [语音未处理]
  -> 单次固定提示
  -> 不创建 Codex turn
```

## 用户真实操作序列与失败模式

1. **已启用目标发送正常文本**：行为与当前版本相同，不显示语音标记。
2. **已启用目标发送 60 秒以内、带腾讯转写的语音**：面板显示转写，微信先收到语音处理回执，随后收到 Codex 回答。
3. **扫码后第一条消息是可转写语音**：它能建立目标、触发原有首次问候，并在已启用 Codex 服务时进入回答队列。
4. **语音恰好 60 秒**：允许处理；超过 60 秒即拒绝。
5. **`playtime` 缺失、非整数、为零或负数**：无法证明满足上限，拒绝并提示改发文字。
6. **腾讯未返回 `voice_item.text` 或只返回空白**：不下载媒体、不猜测内容、不调用 Codex，固定提示改发文字。
7. **同一消息被 getupdates 重放**：与文本相同，持久化去重后最多处理一次。
8. **语音和后续文本快速连续到达**：同一目标队列严格串行；每个 job 使用各自事件闭包中的 context token。
9. **语音属于未启用目标**：目标和 context 会被发现，但 Codex 服务不回复；页面可由用户明确启用。
10. **Codex 失败或超时**：发送一次现有固定失败提示，不重新转写、不自动重发。
11. **ACK 或最终回复发送超时**：结果标记为未知/失败，仍不自动重试，避免重复微信消息。
12. **Demo 重载发生在处理前**：已持久化的消息 key 阻止重放；没有 exactly-once 承诺，但不会主动盲重试。

## 数据与隐私

- `codex-service.json` 会像文本消息一样保存转写和 `[语音转写]` 标记；Codex rollout 会保存交给模型的转写文字。
- 不保存原始语音、CDN URL、AES key、bot token 或 `context_token` 到聊天记录。
- 不在 stdout/stderr 打印语音正文或任何媒体/认证字段。
- 单条转写沿用文本的 8,000 字符协议边界；微信最终回复仍限制为 500 字符。

## 验证标准

- 单测：协议层能区分文本、有效语音、60 秒边界、超长、无文字、非法时长和重放。
- 单测：服务层对有效语音显示标记、使用语音 ACK、把原始转写交给 Codex；拒绝语音不调用 Codex且只发送一次固定提示。
- 回归：自动绑定能由有效语音触发；普通文本行为不变。
- 全量：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、fixture 浏览器 e2e。
- 真实验证：由用户从已绑定微信发送一条不含敏感信息、60 秒以内的语音；以面板出现转写、Codex transcript 有回答、腾讯渠道接受和用户手机实际收到为四个独立证据。不会由自动化代替用户发送真实语音。
