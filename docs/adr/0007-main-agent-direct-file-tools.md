# ADR-0007: 主微信 Codex 直接使用受限文件工具

- 状态: 已被 ADR-0008 取代

## 背景与问题

现有文件发送入口把自然语言查询、文件查找、候选选择和微信发送封装在 `files.send` 与独立 File Resolver 中。它形成第二个语义执行者，也使主微信 Codex 无法像通用编码 Agent 一样在同一回合迭代使用查找、grep、读取和后续动作；同时 `files.send` 把文件系统操作与微信外发混在同一命名空间。

## 备选项

1. **主微信 Codex 直接调用受文件沙箱约束的 `files.*` 工具，并把微信文件外发独立为 `weixin.send_files`**
2. 保留独立 File Resolver——会继续存在第二个语义 owner、额外模型回合、独立超时和与主会话上下文不一致的问题
3. 保留查询式 `files.send(query, selection)`——接口仍同时承担查找、选择和发送，无法复用为通用文件操作
4. 向主模型开放 shell 或任意绝对路径——会绕过模块目录授权、结构校验和禁止执行的不变量

## 决策

选定**方案 1**：主微信 Codex 回合继续作为新意图的唯一语义 owner，并直接使用 `files.find`、`files.grep`、`files.read`、`files.edit` 与 `files.write`。这些工具的公开参数由模型决定；宿主只执行结构、授权、预算、路径包含关系、引用和并发校验，不解释业务意图，也不替模型生成查询、排序或选择。

`files.*` 只表示本地文件系统操作，并由同一个受限文件 Module 隐藏目录遍历、Unicode/大小写处理、有界结果、opaque reference、no-follow、原子写入和修订冲突。读取类调用在同一模型回合内返回结果，不取得最终回复所有权；写入类调用经受审模板和 WorkflowEngine 形成持久 Effect。

微信文件外发使用模型可见的 `weixin.send_files`。主模型把已经通过本轮受限文件工具取得的一个或多个 opaque file reference 提交给它；有歧义时提交候选进入既有 Input Gate，明确选择时提交选中集合。Gateway 绑定当前账户、目标和幂等信息，并把每个文件映射为内部 `weixin.submit_file` Effect。发送已有原文件不调用 `files.read`。

不再设置 File Resolver、Resolver Agent 或 `files.resolve` 层，未来也不以其他名称恢复第二个文件语义模型。旧 `files.send`、`weixin.send_file`、`files.resolve` 与 Resolver 代码只作为迁移输入，不再成为新协议。

## 后果

- 正面: 文件搜索、内容 grep、读取、修改、创建和微信发送的职责、权限与 Effect 被分开，主模型可以在一个标准工具循环中迭代完成任务。
- 正面: 文件安全规则集中在一个深 Module；未来笔记和其他本地文件能力复用同一 Interface，不需要各自实现搜索器或 Resolver。
- 正面: 查询、排序、返回数量和候选选择由拥有完整对话上下文的主模型决定，宿主不再承担业务决策。
- 负面: 模型可见工具契约扩大，工具名称、schema 与描述变化会更新 contract hash，并要求主微信会话轮换到新契约。
- 负面: 文件元数据、grep 片段与有界读取内容会进入主模型上下文，因此必须严格限制结果量、片段和读取窗口。
- 负面: 旧 Resolver 冻结运行与待选请求需要显式迁移或终结；不能在删除实现后让它们静默恢复。
- 中性: WorkflowEngine、WorkflowGateway、模块权限、Input Gate、Pending Response、Effect ledger 与 unknown 不自动重发语义继续保留。

## 来源

- `0003-generic-file-query-capabilities.md`
- `0005-model-directed-workflow-tool-routing.md`
- `0006-use-domain-workflow-tools.md`
- `/Users/loong_zhou/research/agent-tool-surface-design/claude-codex-langgraph.md`
- `/Users/loong_zhou/research/agent-tool-intent-routing/claude-codex-langgraph.md`
- 2026-09-03 用户确认删除 Resolver、直接复刻 Codex/Claude Code 文件工具边界并拆分微信发送命名
