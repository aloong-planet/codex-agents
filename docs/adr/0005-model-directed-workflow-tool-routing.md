# ADR-0005: 由主微信 Codex 回合选择工作流工具

- 状态: 已被 ADR-0007 取代

## 背景与问题

ADR-0001 把宿主关键词候选路由和独立 Intent Planner 放在普通 Codex 回合之前。真实微信请求证明，该前置门禁会在自然语言没有命中宿主枚举时剥夺模型选择工具的机会，并形成与普通 Codex 工具循环不同的第二套语义路由；系统仍需要保留持久化 WorkflowEngine、可信 WorkflowGateway、权限校验和 effect ledger 来承载可恢复副作用。

## 备选项

1. **让主微信 Codex 回合看到当前可用的工作流工具，由模型选择普通回复或结构化工具调用；宿主在调用后通过 Gateway 校验和执行**
2. 保留宿主关键词/正则候选过滤，再交独立 Intent Planner——自然语言覆盖取决于业务枚举，双模型路由增加延迟、失败面和语义分歧
3. 用另一个通用 Router 模型替代关键词过滤——仍保留主模型之外的第二次意图判断，无法消除两个语义 owner 的冲突
4. 让主模型直接调用文件、媒体和微信底层能力——会绕过模板、可信绑定、持久恢复、权限与 effect 约束

## 决策

选定**方案 1**：主微信 Codex 回合装配当前账户已启用且协议兼容的工作流工具，使用模型的正常工具选择能力决定普通回复或工具调用。宿主不得再用业务关键词、正则或硬编码意图枚举作为进入工作流的正确性门禁，也不再运行独立 Intent Planner；模型产生的工具调用仍是不可信请求，必须经 WorkflowGateway 绑定账户、目标、授权证据和 opaque reference，并映射到已审查模板后才能提交持久化、有界的 WorkflowEngine。

WorkflowEngine、Input Gate、Workflow Response Bridge、能力 Provider、effect ledger 与 unknown 不重放语义继续保留。ADR-0004 的待处理响应恢复仍优先处理当前唯一 pending request；本决策只替换新工作流意图的前置识别路径。工具承载使用 App Server dynamic tools 还是稳定 MCP，以及模型可见工具采用单一入口还是按意图拆分，不在本 ADR 中锁定。

## 后果

- 正面：自然语言意图由拥有完整对话上下文的主模型判断，文件、媒体和未来笔记能力不再依赖宿主维护业务关键词表。
- 正面：普通回复和工作流调用只有一个语义 owner；Gateway 与 Engine 继续提供权限、幂等、恢复和副作用安全边界。
- 正面：工具目录、描述和 schema 成为模型可见的能力契约，新增能力不需要修改入站业务路由枚举。
- 负面：工具目录的协议兼容、版本演进、描述质量和模型调用率成为新的可靠性验证面，必须使用真实 App Server 协议测试与真实微信验收。
- 负面：模型可能不调用应该调用的工具；宿主不能回退旧关键词路由替它执行，只能记录诊断并给出与事实一致的用户回复。
- 中性：文件解析仍可在工作流内部使用受限 File Resolver 调用 `files.find/files.grep`；它不是被废弃的 Intent Planner。
- 中性：在完成代码迁移前，现有候选路由与 Planner 仅是待删除兼容实现，不能继续扩展。

## 来源

- `/Users/loong_zhou/research/agent-tool-intent-routing/claude-codex-langgraph.md`
- `../general-workflow-engine-design.md`
- `0001-durable-bounded-workflow-engine.md`
- `0004-use-trusted-pending-responses.md`
- 当前微信 Trigger Adapter、Intent Planner、WorkflowGateway 与 App Server dynamic tool 代码事实核查（2026-09-01）
