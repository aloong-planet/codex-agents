# Codex App Server 当前任务交互探针设计

## 目标与边界

本纵切只验证微信 Demo 所在本机进程能否通过 Codex App Server 恢复当前 Codex
任务、追加一条固定无副作用消息并取得最终回复。它不接入微信入站监听、不自动发送微信
消息、不 fork 任务，也不把任意网页输入交给 Codex。

完成标准：

1. 使用本机 Codex App Server 的 stdio JSONL 协议完成 `initialize`。
2. 对显式提供的当前任务 ID 调用 `thread/resume`，且返回同一任务 ID。
3. 调用 `turn/start` 发送固定探针，接收 `item/agentMessage/delta` 与
   `turn/completed`，最终只输出脱敏后的回复文本。
4. 不传 `cwd`、模型、approval policy 或 sandbox override，避免改变当前任务后续默认值。
5. App Server 请求任何审批时一律拒绝并让探针失败；不执行工具、不写文件、不访问微信。
6. 超时、进程退出、协议错误、任务不匹配或空回复均确定性失败并终止子进程。

## 结构与 seam

- `CodexAppServerClient` 只负责 JSON-RPC 状态机：初始化、恢复、开始 turn、聚合回复、完成。
- `AppServerTransport` 是测试 seam，只提供发送消息、订阅消息与关闭。单测使用内存 transport
  驱动乱序、错误、审批和超时；生产 transport 才 spawn 本机 `codex app-server --stdio`。
- `scripts/probe-current-thread.mjs`（由 TypeScript build 产物执行）只接受环境变量中的任务
  ID，并发送代码内固定探针，避免 shell 参数或网页内容成为任意 prompt 通道。

## 真实操作序列与失败模式

1. **启动探针**：缺少/非法任务 ID 或 Codex 可执行文件不存在，立即失败。
2. **初始化**：App Server 未响应、返回 error 或提前退出，关闭 transport 并失败。
3. **恢复任务**：返回 ID 不一致、任务不存在、历史格式不支持或状态库被占用，禁止开始 turn。
4. **开始 turn**：只发送固定文本；若当前任务存在并发 turn 冲突，报告冲突，不自动重试。
5. **流式回复**：按事件顺序拼接 agent message delta；只接受当前 turn 的事件。
6. **审批请求**：命令、文件、权限、用户输入或 MCP elicitation 均拒绝；探针不得等待人工审批。
7. **完成**：仅 `completed` 且非空回复算成功；`failed`、`interrupted` 或空回复均失败。
8. **清理**：成功或失败都终止本探针启动的 App Server；不终止桌面 Codex 或 Demo 服务。

## 验证

- 单元测试覆盖成功、恢复 ID 不一致、审批拒绝、失败 turn、超时与非当前 turn 事件。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全绿。
- 真实验证只对当前任务发送固定消息：要求仅回复 `APP_SERVER_BRIDGE_OK`，不调用工具。

## 后续非目标

- 不在本纵切中把微信正文自动送入 Codex。
- 不实现网页审批 UI、对话持久队列、去重、速率限制或微信自动回复。
- 不承诺桌面 UI 与独立 App Server 同时写同一任务是稳定生产能力；本次只验证单次链路。

## 2026-08-11 真实探针结果

- 独立 App Server 的 `thread/list` 能识别当前桌面任务，证明双方使用同一持久化任务库。
- 对当前任务执行一次固定无工具探针时，`thread/resume` 返回
  `already has an active writer`；没有进入 `turn/start`，没有产生模型回复或工具调用。
- 当前 Codex CLI 提供的 `app-server proxy` 只代理到已运行 daemon 的控制 socket；本机桌面
  任务没有暴露可由 Demo 连接的 App Server listener。桌面进程间私有 socket 不属于公开协议，
  本 Demo 不探测或依赖它。
- 因此，“第二个 App Server 同时接管当前已打开的桌面任务”在当前版本不可行。若要持续交互，
  必须让 App Server 从一开始成为该任务的唯一 writer，再让客户端连接它；或者使用新/独立任务。
