# ADR-0006: 使用领域工作流工具而非万能入口

- 状态: 已被 ADR-0007 取代

## 背景与问题

ADR-0005 已决定由主微信 Codex 回合选择工作流工具，但尚未决定模型可见工具面的粒度。系统既要让模型依靠名称、描述和 schema 正确选择能力，又要让宿主复用统一的 Workflow Gateway、权限、Pending 和 effect 机制；未来还会增加笔记及其他个人助理能力。

## 备选项

1. **按 `files.*`、`media.*`、`notes.*` 等领域暴露少量严格 member 工具，宿主内部共享 Workflow Gateway**
2. 暴露一个 `workflow.execute(intent, payload)` 万能工具——会把工具选择重新藏进 payload，退化 schema，并形成第二个隐式 Router
3. 把每个 Provider 原子能力都直接暴露给主模型——工具数量、权限和状态负担过大，也允许模型绕过受审模板编排副作用
4. 为每个业务流程保留独立 Planner 和模型工具——会继续维护两套语义 owner，无法兑现 ADR-0005

## 决策

选定**方案 1**：模型可见工具面采用按领域组织的少量深工具，每个 member 保留稳定名称、用途描述、严格输入 schema、版本与明确的权限/effect 语义。搜索、读取、写入和外发不得合并成跨权限的万能动作；同一资源上的同构动作只有在输入、权限和 effect 语义一致时才能合并。

所有领域工具在可信宿主内共享 Workflow Gateway。Gateway 注入账户、目标、当前入站、Pending、授权与 trace，映射到已审查模板并提交 WorkflowEngine；模型不得提供路径、账户、目标、模板、DAG、Provider、effect 或幂等标识。`files.find/files.grep/files.read` 等能力仍可作为工作流内部 Resolver/Provider 能力，不因模型工具面采用领域工具而直接暴露。

第一阶段只迁移当前已有的文件原件发送和图片发送目标；模型可见名称分别归入 `files.send` 与 `media.send`。`notes.search`、`notes.read`、`notes.write` 作为后续领域扩展方向，只有对应权限、模板、失败语义和测试闭环后才进入生产工具目录。

## 后果

- 正面：主模型能用标准工具选择机制区分文件、媒体和笔记目标，不再依赖宿主业务关键词或第二个 Planner。
- 正面：工具名和 schema 可独立测试、审计、授权和演进；内部可靠性仍集中在一个深 Gateway 与 Engine 中。
- 正面：新增领域能力不会扩大一个万能 payload，也不会迫使主模型学习内部 Provider、DAG 或 effect 细节。
- 负面：工具目录、描述和 schema 变化需要版本与兼容策略；当前 App Server 恢复旧 thread 时不能假定工具契约会自动刷新。
- 负面：模型可能选择错误工具或不调用工具；宿主不得用旧关键词路由回退，只能记录诊断并返回与真实状态一致的结果。
- 中性：模型可见工具使用 App Server dynamic tools 还是 MCP 是传输 Adapter 决策；两者都必须呈现相同的领域 member 契约。
- 中性：内部 File Resolver、Capability Registry、Input Gate 和 Pending Response Router 保持各自职责，不成为模型可见万能工具。

## 来源

- `/Users/loong_zhou/research/agent-tool-surface-design/claude-codex-langgraph.md`
- `/Users/loong_zhou/research/agent-tool-intent-routing/claude-codex-langgraph.md`
- `0003-generic-file-query-capabilities.md`
- `0004-use-trusted-pending-responses.md`
- `0005-model-directed-workflow-tool-routing.md`
- 用户于 2026-09-01 确认采用领域工具与内部统一 Gateway 方案
