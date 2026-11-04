# 微信工作流入站模拟器设计

## 目标

提供一个不会连接腾讯 iLink、不会发送真实微信消息的本地模拟入口，驱动与生产相同的微信文本入站、主模型工具选择、Workflow Gateway、WorkflowEngine、Input Gate 和文件发送 Provider 路径。维护者可以重复提交消息并检查本地回复、Run 和假外发收件箱，不再依赖用户每次从手机验证路由逻辑。

## Interface

- 仅在 `DEMO_MODE=fixture` 时开放 `POST /api/fixture/workflow/inbound`；既有 `/api/fixture/inbound` 继续服务二维码/绑定页面测试，不自动启用 Codex 目标。
- 请求体可包含一个有界 `text`；省略时保留既有“fixture 首条消息”。
- 同一个 fixture 进程中的多次请求共享临时 Engine 与 SignalInbox，因此第二条消息可以选择第一条消息产生的候选。
- `/api/state` 在 fixture 模式额外返回脱敏 `fixtureOutbox`：只包含外发类型、文件名、相对显示路径和 accepted 时间，不含绝对路径、账户、目标、operationId 或正文。
- 默认主模型是确定性 fixture adapter，供 CI 稳定回归。显式设置 `WORKFLOW_SIMULATOR_MODEL=live` 时使用与生产相同的主微信 Codex 回合；外发仍为假实现。

## 深模块与 seam

外部 seam 仍是 `FixturePort.emitFixtureInbound(text)`。它构造与真实 iLink 相同形态的 `InboundTextEvent`，随后由 `WeixinCodexService` 调用同一个 `InboundWorkflowControl`。模拟器不直接调用 Provider，也不手工提交 Run。

The fixture injects the same `WeixinMediaDelivery` adapter as production, backed by a fake transport implementing image/file submission and receipt lookup. The adapter implements `MediaDeliveryPort` (`WorkflowMediaSendPort` remains a compatibility type alias). The fake transport only records validated files in the fixture outbox and returns channel acceptance.文件解析、module/scope 权限、opaque handle、Input Gate 和 effect ledger 均继续由真实模块执行。

## 隔离与安全

- fixture 启动时创建独立临时 state 目录、Vault 和 SQLite，不读取生产凭据或 token。首次调用专用工作流入口时才为这个临时 Vault 保存只读权限并启用 fixture 目标，避免改变普通页面测试的初始状态。
- fixture Vault 只创建受控样本；不会写用户真实 Vault。
- HTTP fixture endpoint 在生产模式返回 404。
- 假外发永不调用 `DirectIlinkChannel`。
- live 主模型使用生产工具目录与同一入站编排；仍使用临时状态和假外发。

## 状态与交互

1. 文本进入 FixturePort。
2. WeixinCodexService 经 Durable Inbox 调度同一主模型路径；已有 Pending 的可信响应可走恢复快路径。新请求的工具决定由主模型给出。
3. 唯一文件候选：Run 完成，假外发收件箱新增一项；回复沿用生产文案“文件已发送，请查收。”，测试报告和 outbox 的 simulated 标记负责说明没有真实微信外发，不能据回复文字断言手机收到。
4. 多个候选：Run 进入 `needs_input`；下一次 fixture inbound 提交“选择 引用 序号”恢复同一 Run。
5. 查询无候选、文件工具权限失败或终止型预检失败：结构化观察返回主模型，不创建 Run；模型可以修正查询或解释原因。已经接受的待选运行在恢复时发现权限撤销则终结原 Run，不发送文件。
6. 主模型不调用终止型工具时保留普通回复 owner；Gateway 只在终止型工具预检并成功接受 Run 后接管回复。

## 验证

- HTTP 单测：fixture 文本透传；生产模式拒绝 endpoint；文本上限与类型校验。
- 集成测试：主模型通过 `files.find` 取得引用并调用 `weixin.send_files`；只为终止型发送创建 `weixin.send-files`（或单选变体）Run，发送已有原文件不调用 `files.read`。显式读取/修改请求可在同一 Turn 内继续工具循环。
- 多轮测试：多个候选后提交选择，恢复同一 Run 且只记录一个附件。
- live 主模型等价回归：`pnpm test:e2e:production-parity` 从 fixture 微信 HTTP 入口使用生产主 Codex 回合，覆盖修改/验证/发送组合、最新图片、普通聊天、文件待选恢复、最新 PDF、完整匹配集合发送、正文搜索后回答、读取后总结、新建文本、冲突编辑、扫描不完整，用例集合以脚本筛选与 Playwright --list 为准。精确“收到”只对真实主模型断言，确定性 fixture 的固定回复不充当语义验收。每条交互及已有工具诊断记录为测试附件，失败仍记录最后观察；可通过 Playwright JSON reporter 持久保存原文证据。每个用例使用独立fixture服务进程组、端口、状态与诊断目录；同一用例的多轮交互共享该服务。单轮交互默认30秒空闲超时（POST及终态等待期间，本交互的新模型流式/协议事件、工具事件或启动进度续期；HTTP轮询、重复状态、历史/无关trace及周期指标不续期），整例默认120秒总上限；测试服务启动最多20秒，失败取证与进程清理另设有界预算。超时不自动重跑，先保留证据并停止该用例的进程组。扫码/绑定固定回复用例显式使用fixture模型，live模式不会注入预设工具调用；模式拼写错误直接失败。它不连接腾讯，也不证明真实微信已收到；权限撤销等独立门禁、其余 spec 复合边界与手机收件仍需分别验证。
- Pending Router 等价回归：`pnpm test:e2e:pending-router-parity` 只验证已有待选任务的语义回复，不参与新工作流意图判断。
