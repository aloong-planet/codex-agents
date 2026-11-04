# 主微信模型驱动的领域工作流工具设计 Review

结论：通过，可进入 TDD 实施；以下问题已在设计中修正。

日期：2026-09-01

审查对象：[主微信模型驱动的领域工作流工具设计](model-directed-workflow-tools-design.md)

## 1. 是否仍存在第二个新意图 Router

原方案风险是把独立 Intent Planner 删除后，又在宿主用媒体/文件关键词选择工具，或把该逻辑藏进 `workflow.execute(intent,payload)`。

审查结论：设计已明确只有主微信 Codex 回合解释新业务意图；宿主只处理 Pending 协议、schema、可信绑定和执行。模型工具面采用 `files.send`、`media.send` 等严格 member，不提供万能 payload。File Resolver 只在已选定工作流内部查询文件，因此不是第二个新意图 Router。

## 2. 媒体来源是否会逼宿主恢复关键词判断

初稿的 `media.send` 没有 source 字段，但引用、当前、近期和本地来源互斥；若只靠原始文本，宿主仍可能需要枚举“刚才”“相册”等词选择来源。

修正：`media.send@1` 增加 `source=referenced|current|recent|local` 严格枚举。主模型负责语义选择，宿主只验证该来源的可信证据、权限和可用性；证据不成立时失败关闭，不改写 source、不跨来源兜底。

## 3. 工具参数是否重新变成任意 payload

`query` 和 `caption` 是自由字符串，存在模型传路径、未请求说明或提示注入的风险。

修正：二者只作为有界数据。Gateway 同时冻结原始消息；query 只是 Resolver hint，不是路径或权限；绝对/相对路径形态和额外字段失败关闭。caption 只有原始用户请求存在明确证据时才可保留。账户、目标、scope、路径、模板、DAG、Provider、effect 和幂等信息均不在模型 schema 中。

## 4. 多工具调用和并发是否可能建立两个 Run

App Server 可能允许模型在同一 turn 修正工具参数，也可能出现并发 tool call；简单“接受第一个”无法区分无副作用 schema 错误和已进入业务执行的请求。

修正：未知 member/schema 非法不锁 owner，并允许同一 turn 一次 effect 前修正；第一项 schema 合法且进入 Gateway 的请求通过 CAS 锁定 workflow owner。之后的串行或并发 effectful call 全部拒绝，确保一条入站最多一个有副作用 Run。

## 5. 模型最终文本是否可能覆盖真实执行结果

动态工具完成后模型仍可能生成“已发送”或“无法发送”等自由文本；如果直接外发，会与 Engine/effect 事实冲突。

修正：Tool Host 接受合法请求后锁定 workflow owner；模型后续文本只用于 App Server 协议收尾。微信用户回复只能由 WorkflowReplyProjector 根据 Run 与 effect receipt 生成。accepted 仍不等于手机已收到，unknown 不自动重发。

## 6. Pending 与新目标是否形成双状态真源

主模型工具选择不能绕过已有 Pending Request，否则“都要”“选第二张”可能被解释成新工具请求；反过来，Pending 也不能抢占完整新目标。

审查结论：PendingResponseCoordinator 仍先判断当前消息是 respond/cancel/new_goal/clarify/ordinary。respond/cancel 只操作原 Run；new_goal 先 supersede 旧 Pending，再进入主模型；ordinary 保留旧 Pending。Engine 与 Bridge 仍是唯一状态真源，主模型没有 Signal 工具。

## 7. 工具升级是否迫使每次权限调整都换 thread

现有 App Server 只在 thread/start 装配 dynamic tools，若 hash 设计不当，任何目录 grant 变化都会频繁丢失会话上下文。

修正：toolContractHash 只覆盖模型可见名称、版本、description、schema 和模块启用集合。实时权限、handler 修复、性能优化和 Provider 内部版本不进入 hash；它们由 Gateway 实时读取。只有模型可见契约变化才创建新 thread，并恢复 durable memory 与 Pending 投影。

## 8. namespace 协议是否被未经验证地假定可用

项目当前 DynamicToolDefinition 只有扁平 function 类型；官方 App Server 支持 namespace member 的事实不等于当前 Adapter 已兼容。

修正：阶段 0 必须先做真实 App Server namespace 协议测试。若当前安装版 wire shape 不兼容，可使用确定性扁平 wire Adapter，但领域逻辑 ID、Gateway 注册、权限和测试仍以 `files.send`、`media.send` 为准。不得用协议限制改回万能工具。

## 9. 工具未调用时是否应回退旧路由

模型可能漏调工具；恢复关键词路由可提高表面命中率，但会重新产生两个语义 owner，并使自动化无法证明哪条路径工作。

审查结论：不回退。记录 `model_no_tool_call`，用工具描述、模型配置、真实 App Server 协议和真实微信 eval 改进。普通回复不得被宿主转换成副作用。这个取舍是 ADR-0005 的核心负面后果，不应在实现中偷偷撤销。

## 10. 测试 seam 是否能发现真实微信和 fixture 分叉

只测 Gateway 或 Provider 会重复过去“fixture 绿、微信不符”的假通过。

修正：最高层 seam 固定为生产等价微信入站到脱敏 outbox/Run/effect；fixture 必须经过 Durable Inbox、Pending、主 Codex turn、真实动态工具协议 Adapter、Gateway 和 Engine。Provider 单测只作为下层补充。自动化通过后必须重启 LaunchAgent，再用相同口令做真实微信验收。

## 11. 实施边界

本轮设计只迁移已存在的原文件发送与图片发送，不同时实现 MCP、tool search、deferred loading、笔记新能力、scheduler 或任意执行。`notes.search/read/write` 只确定未来领域形状，不进入当前 Catalog。

## 12. 最终判断

方案满足以下设计不变量：

- 一个新意图语义 owner。
- 一个内部 Gateway、一个 Engine 状态真源。
- 模型可见严格领域 member，模型不可见 Provider 与 Signal。
- 一条入站最多一个 effectful Run。
- Pending 保持单请求、可恢复、可多选、可语义取消。
- 权限与 effect 在可信边界实时校验。
- 用户回复只基于已验证执行事实。
- 测试通过生产等价入口，而不是绕过模型与工具协议。

未发现需要继续向用户确认的设计分支，可以进入阶段 0 的真实协议红测试。
