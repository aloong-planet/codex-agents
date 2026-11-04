# 腾讯转写唯一语音输入设计

## 目标

微信语音仅使用腾讯 iLink 已提供的 `voice_item.text`。任何原始语音都不得下载为长期媒体、不得作为 `localAudio` 进入主 Codex thread。腾讯未提供可用转写时，不启动 Codex turn，直接发送现有固定通知。

## 已确认现状

- `DirectIlinkChannel` 先读取 `voice_item.text`；缺失时返回拒绝事件。
- 转写存在时，当前仍会 materialize voice media，并由 `WeixinCodexService.buildInput` 添加 `localAudio`。
- 媒体存储默认保留 7 天；一旦音频进入主 Codex thread，事后删除本地文件也不会撤销 thread 历史。

## 用户可见流程

### 腾讯转写成功

1. 用户发送微信语音。
2. iLink 返回非空 `voice_item.text`。
3. 渠道构造 voice 入站事件，只保留转写文字，不下载语音媒体。
4. 主服务仍发送“已收到语音，正在处理”。
5. Codex 只收到标注为腾讯转写的文字，并正常回复。

### 腾讯转写缺失

1. 用户发送微信语音。
2. iLink 未返回非空转写。
3. 渠道产生 `voice_transcript_missing` 拒绝事件，不下载语音、不启动 Codex。
4. 用户收到现有固定通知：“这条语音没有可用的腾讯转写文字，请改发文字。”

### 非法或超长语音

保持现有 `voice_duration_invalid` / `voice_too_long` 行为；不下载语音、不启动 Codex。

### 引用语音

引用中的 voice media 也不得下载或进入 Codex。若引用消息提供标题或文字，仍按现有文本引用处理；否则仅保留“引用媒体”的文字占位，不尝试识别原音。

### 未来调用者误传 voice attachment

Codex 输入模块必须忽略 voice attachment。渠道层“不下载”和输入层“不提交”形成两层不变量，避免 fixture、迁移数据或未来代码绕过第一层。

## 模块与 seam

外部 interface 不新增方法。行为隐藏在现有两个深模块内：

- `DirectIlinkChannel`：决定哪些 iLink item 可以 materialize；voice 永不 materialize。
- `WeixinCodexService`：把规范化入站事件转换为 Codex 输入；只允许 text 和 image，不允许 audio。

`CodexUserInput` 删除 `localAudio` 联合成员，形成编译期约束。`IlinkMediaStore` 暂时保留 voice 解码能力，因为删除属于更大范围重构；本次只保证生产入站路径不再调用它。

## 状态与副作用

- 成功转写：不产生本地 voice 文件，不产生 Codex audio item。
- 无转写/非法/超长：只产生拒绝记录和一次固定通知。
- 图片、文件、视频行为不变。
- 既有历史 thread 中的音频不会被本次改动删除；后续需通过 thread 压缩或轮换处理历史膨胀。

## 验证

- 渠道测试：带腾讯转写和 voice media URL 的消息能生成 voice 文本事件，但 media store 不收到 voice materialize 调用，attachments 不含 voice。
- 渠道回归：无转写仍产生 `voice_transcript_missing` 且不产生入站事件。
- 服务测试：voice transcript 只以 text 输入进入 Codex；即使 fixture 附带 voice attachment，输入也不含 `localAudio`。
- 图片/引用文件回归保持。
- typecheck、相关单测、全量 lint/test/build、fixture E2E。

