# ADR-0001: 使用持久化、有界的工作流引擎承载副作用

- 状态: 已被 ADR-0005 取代

> 本记录保留用于说明历史背景，不再作为现行实现依据。ADR-0005 保留持久化、有界 WorkflowEngine 与 WorkflowGateway 的安全边界，但废弃本记录中的宿主候选路由和独立 Intent Planner。

## 背景与问题

媒体、笔记、微信发送和定时任务目前通过多条路径执行，直接依赖模型选择工具会使副作用路由、恢复和审计不稳定。系统需要共享的执行语义，同时必须保留已经验证的微信入站、媒体安全检查和笔记并发保护。

## 备选项

1. **宿主路由到持久化、有界 DAG 工作流引擎，并通过版本化能力提供者执行步骤**
2. 继续让 Codex 直接选择全部动态工具——旧会话工具契约无法热更新，且模型是否调用正确工具不能作为可靠性保证
3. 建立用户可编辑 JSON DSL、可视化编排器或分布式 worker——首个真实闭环尚不需要，复杂度会先于验证出现

## 决策

选定**方案 1**：我们使用宿主候选路由、短上下文结构化 Planner、统一 WorkflowGateway、经审查模板、有界 DAG、持久运行日志与版本化能力提供者承载副作用工作流。普通聊天绕过该引擎；显式结构化命令可跳过 Planner，但不能跳过 Gateway、授权或 Engine。人工补参由 Engine 的持久 Input Gate/SignalInbox 管理，Provider 不拥有聊天状态。迁移按完整用户场景逐步接管，且每个触发只有一个最终回复 owner 和一个副作用 owner。

## 后果

- 正面：微信与 scheduler 共享去重、状态、恢复、权限和 unknown 语义；能力升级不再要求把底层工具目录固化为会话协议。
- 正面：自然语言理解、可信意图映射和确定性执行形成三个深边界；歧义补参可以恢复同一冻结运行，而不是依赖下一轮模型记住上下文。
- 负面：需要维护计划编译、运行日志、能力版本和恢复规则，首批纵切的实现成本高于直接增加一个动态工具。
- 中性：现有可靠入站、媒体安全校验、笔记并发控制和微信 effect ledger 保留，由适配层与能力提供者复用。

## 来源

- `../general-workflow-engine-design.md`
- `../general-workflow-engine-design-review.md`
- `/Users/loong_zhou/research/agent-workflow-architecture/mainstream-patterns.md`
- 当前媒体、笔记、持久入站与 effect ledger 代码事实核查（2026-08-24）
