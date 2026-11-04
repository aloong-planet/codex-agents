# 微信媒体闭环与引用消息设计

## 决策

- 出站仅允许本次/引用附件、同账户同目标最近 10 分钟内最多 5 张入站图片，或已授权根目录内的本地普通文件；不直接抓取远程 URL。
- 只有当前微信消息明确要求发送、回传、回发或生成媒体时，才为该 Codex turn 开启一次性媒体发送能力；目标和当次 `context_token` 固定，turn 结束即失效。同一账户与目标最近 10 分钟内最多 5 张入站图片可作为“刚才的图片”候选。
- 入站媒体在私有状态目录按目标滚动保留 7 天，每个目标最多 100 个。
- 所有入站/出站媒体统一上限 100 MiB；下载、解密、读盘和上传前后均校验。
- 覆盖图片、语音、文件、视频，以及引用文本和引用媒体；不新增群聊或远程 URL 外发。

## 复用结论

腾讯插件为 MIT。复用其协议字段、AES-128-ECB、CDN 上传下载和消息 item 构造算法；不直接 import 插件模块，因为其实现依赖 OpenClaw runtime、统一媒体仓库、logger、账户配置和 hooks。Demo 内形成自有深模块，避免运行时耦合或读取 OpenClaw 状态。

Codex App Server 当前 schema 支持 `localImage`、`localAudio`；普通文件和视频没有专用本地输入类型，使用受控绝对路径写入文本 prompt，由 Codex 在只读 sandbox 中处理。

## 模块与 seam

### `IlinkMediaTransport`

外部接口仅有：

- `materialize(message, context): Promise<InboundEnvelope>`：解析正文、引用和媒体，下载解密并保存。
- `sendLocal(input, capturedRoute): Promise<SendMediaResult>`：校验本地路径、上传加密并发送。
- `cleanup(): void`：按 7 天和每目标 100 个的规则清理。

其 implementation 隐藏协议 item、AES key 双编码、CDN header、MIME、路径、索引和大小限制。腾讯 HTTP 是 true external seam；测试注入 `fetch` adapter。

### `InboundEnvelope`

统一替代仅文本事件，包含：消息去重 key、账户、目标、正文、source、当前附件、可选引用摘要/附件、接收时间，以及捕获当次 token 的 `replyText`/`replyMedia`。调用方永远不接触 token。

### `WeixinTurnMediaHost`

作为 Codex dynamic tool adapter，只暴露 `weixin_send_media(path, caption?)`。App Server 请求带 `threadId/turnId`；host 只接受当前 active turn 的绑定。host 根据当前用户消息自行判定明确外发意图，并绑定固定目标、捕获 token、允许根目录、本次/引用附件以及同目标近期图片；调用方不再传递布尔门禁。成功、拒绝、超时均返回结构化脱敏结果；未知结果不自动重发。

## 用户操作序列与状态

1. 用户发送文本加媒体、仅媒体，或回复一条含文本/媒体的旧消息。
2. monitor 先持久化新 cursor/context token，再解析 envelope。
3. 媒体 URL 必须为 HTTPS 且 host 属于 `weixin.qq.com` 或其子域；流式读取超过 100 MiB立即中止。AES key 只在内存使用，不记录。
4. 明文以随机文件名写入私有 `media/inbound/<target-hash>/`，目录 `0700`、文件 `0600`；索引原子写入。
5. 保存去重记录后排入对应目标 FIFO；其他目标仍并行。
6. Codex 输入：正文和引用摘要进入 text；图片用 `localImage`；语音用 `localAudio`（腾讯转写仍同时提供）；文件/视频提供只读绝对路径及 MIME/名称。
7. 若当前消息明确要求外发媒体，turn host 获得一次性能力；否则工具调用 fail closed。“回发/发回”属于明确动作，“分析刚才发来的图片”不属于外发动作。
8. 工具校验路径为普通文件、非符号链接、realpath 位于授权根、本次/引用附件集合或同目标有效近期图片集合、大小不超过 100 MiB，再上传并发送。
9. turn 完成或失败后撤销能力；附件继续按 7 天/100 个策略保留。

## 引用规则

- `ref_msg.message_item` 的文本进入“引用消息”段；`title` 仅作摘要，不覆盖真实文本。
- 引用媒体与主消息媒体分开标记；引用媒体可下载时使用相同安全链路。
- 主消息媒体优先进入 Codex 的直接多模态 input；引用媒体也作为 input，但 prompt 明确标记来源。
- CDN 下载失败不丢掉正文：envelope 携带脱敏失败说明，Codex 可回答其余内容；仅媒体且全部失败时发送固定失败提示。

## 失败模式

- URL/MIME/AES/解密无效、超过上限、落盘失败：拒绝该附件，不记录秘密；正文仍可处理。
- 同一消息重复：持久去重，不重复调用 Codex或外发。
- token 后续被新消息覆盖：reply closure 仍使用该消息捕获的 token。
- CDN 上传 4xx：明确失败且不重试；5xx/网络错误最多沿用上游 3 次上传重试，但 sendmessage 不自动重试，避免重复媒体。
- Codex 未明确获得外发能力、路径越界/符号链接/目录、文件变化或超限：工具 fail closed。
- caption 仍走现有 1500 字分段；媒体本体单独发送。caption 部分成功后媒体失败时报告部分成功，不重发整组。
- 清理只处理索引中、私有媒体根下的普通文件；不跟随符号链接，不删除授权目录原文件。

## 验证

- 单测：协议解析、引用、key 双编码、解密、上限、URL allowlist、索引留存、路径门禁、上传 item、固定 token、turn 能力撤销、失败/部分成功。
- 集成：fixture `getupdates -> media store -> Codex input -> dynamic tool -> fixture sendmessage`。
- E2E：浏览器 fixture 状态与聊天反馈；不连接腾讯、不发送真实消息。
- 全量：`pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`。

## 实现回同步

- 服务端同时支持 `full_url` 和官方 `novac2c.cdn.weixin.qq.com/c2c` 的 `encrypt_query_param` 回退。
- 微信 SILK 语音使用与上游一致的 `silk-wasm@3.7.1` 尝试转为 24 kHz 单声道 WAV；解码失败才保留原始 SILK，并继续使用腾讯文字转写。
- 多附件使用稳定的消息序号派生 key，避免同一消息的同类附件覆盖。
- 明文文件通过同目录临时文件原子 rename 落盘。
- 私有媒体根只加入 Codex 只读输入范围，不自动成为外发授权根；外发根严格取权限向导已持久化的 `canonicalPath`。
- 明确外发判断集中在 media host：当前消息须有无歧义发送动作，且同时具备媒体/指代词或本轮/引用附件；调用方不传布尔权限。host 只向获准 turn 暴露同账户同目标最近 10 分钟、最多 5 张图片的内部路径提示，未满足时 dynamic tool fail closed。
