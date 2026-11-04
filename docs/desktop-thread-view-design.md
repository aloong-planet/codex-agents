# Codex Desktop 任务查看设计

## 目标

在现有 Codex Plugin 面板中，为已启用微信转发且已经创建专用 Codex thread 的目标提供“在 Codex Desktop 中查看（实验）”按钮。用户点击后，由本地后端请求 Codex Desktop 导航到该受管 thread。

本功能用于观察原生 Desktop 的实际呈现效果，不承诺原生页面可编辑或处于强制只读模式。

## 已确认事实

- 当前后端已经按 `(accountId, target)` 私密持久化受管 `threadId`，公开状态不暴露该 ID。
- OpenAI App Server 的 `thread/read` 可以不恢复、不订阅地读取 thread，但官方文档没有提供“让 Codex Desktop 原生任务页面强制只读”的导航参数。
- 已调研实现使用 macOS `open -b com.openai.codex codex://threads/<threadId>` 请求 Desktop 导航。
- 当前 Plugin 面板通过 MCP tool 调用 loopback 后端；后端写接口已经要求 same-origin POST。

## 用户操作序列

1. 用户在 Plugin 面板选择一个微信账户与入站目标。
2. 该目标已经启用 Codex 转发，并已创建或恢复受管 thread。
3. 用户点击“在 Codex Desktop 中查看（实验）”。
4. Plugin 调用 app-only MCP tool；MCP client 调用 loopback POST endpoint。
5. 后端只从私有会话映射解析对应 thread，不接受浏览器传入 thread ID。
6. 后端校验 UUID 后，通过 macOS `open` 请求 Codex Desktop 导航。
7. 面板显示“已请求打开”；如果 Desktop 认为任务被其他 App Server 占用，原生页面可能显示 `active elsewhere`。

## 接口与边界

- 后端新增 `openCodexDesktop(accountId, target)`。
- HTTP 新增 `POST /api/codex/desktop/open`，仅接收 `accountId` 与 `target`。
- MCP 新增 app-only tool `open_weixin_codex_desktop_thread`。
- 不向浏览器、MCP structured content 或模型内容返回 thread ID。
- 不调用 `thread/resume`、`turn/start`、`turn/steer`，不改变微信转发所有权。
- 仅支持 macOS Codex Desktop；其他平台返回明确错误。

## 失败模式

- 目标未启用：拒绝打开，提示先启用当前目标。
- thread 尚未创建：拒绝打开，提示先让微信完成一次 Codex 交互。
- 会话映射损坏或 thread ID 非 UUID：失败关闭，不拼接或执行深链。
- Codex Desktop 未安装、Bundle ID 不可用或 `open` 失败：返回脱敏错误，不泄露命令与路径。
- Desktop 打开但显示任务正在其他位置运行：面板说明这是当前产品边界，不假称只读查看成功。
- 重复点击：允许幂等重复导航；按钮调用期间禁用，避免并发启动。

## 验证标准

- 单元测试证明只允许打开所选目标对应的私有受管 thread。
- 非 UUID、未知目标、无 session 都不会调用系统 opener。
- HTTP/MCP 不返回 thread ID。
- Plugin UI E2E 证明按钮仅在目标启用且已有受管任务时可点击，点击调用正确 tool 并显示反馈。
- lint、typecheck、单测、build、Plugin fixture/UI E2E 全绿。
- 实机验证只请求 Desktop 导航，不触发二维码、微信发送或任务 turn。
