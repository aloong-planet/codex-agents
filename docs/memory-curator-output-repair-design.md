# Memory Curator 结构化输出修复设计

## 目标

当 Curator 偶发返回无法解析或不符合提交契约的数据时，在同一后台整理任务内立即进行一次受约束的格式修复；若仍失败，再进入既有持久化重试。面向用户的状态与诊断只显示可行动的中文原因和下次重试时间，不显示内部错误码。

## 事实与边界

- App Server 的 `outputSchema` 约束单次 turn，但模型输出仍必须经过宿主解析与可信工具校验。
- `CodexAccountMemoryCurator.curate` 当前只执行一次 `reply -> parse -> commit`；任一步抛错都会交给 `AccountMemorySystem` 调度重试。
- `AccountMemorySystem` 必须继续持久化稳定的内部错误码，供去敏诊断与重试分类使用。
- 微信账户、目标、证据、revision、路径和写入权限仍由宿主绑定；修复 turn 不能改变这些可信字段。
- 不对语义歧义、日期冲突、证据冲突、revision 冲突或存储错误执行即时格式修复；它们仍按各自既有的终态或持久化重试规则处理。

## 用户操作序列与失败模式

1. 用户完成一轮微信对话，后台创建一个记忆整理任务。
2. Curator 第一次输出有效：宿主提交，流程不变。
3. 第一次输出不是 JSON：同一 Curator thread 追加一次固定修复提示，仍使用同一 `outputSchema`。
4. 第一次输出是 JSON，但工具参数不符合模型提交契约：同样只修复一次。
5. 第二次仍不合规：结束本次执行，记录内部错误码，进入原有 1/5/30 分钟重试。
6. 第一次输出通过结构校验，但触发日期、证据、范围或存储校验：不做格式修复，按现有语义处理和重试规则执行。
7. 页面查看失败任务：显示中文原因、下次重试时间；最近诊断也显示中文原因，不出现 `memory_*` 或 `curator_*`。

## 设计

### Curator 深模块

保持外部 `AccountMemoryCurator.curate(input)` interface 不变。实现内部增加一个最多两轮的提交循环：

- 第一轮使用完整可信输入 prompt。
- 仅当错误码属于 `curator_output_invalid`、`memory_arguments_invalid` 或 `memory_policy_violation` 时，执行一次修复轮。
- 修复 prompt 不回显第一次原始输出，只包含固定动作、稳定错误类别、`batchId`、`basedOnRevision` 和允许的 evidence IDs，避免把不可信输出再次注入。
- 第二轮复用同一 thread；每次 `reply` 都携带相同 revision、只读权限和 output schema。
- 第二轮之后的任何错误直接抛给既有调度器，绝不形成无限循环。

### 用户可见错误格式化

新增纯函数，将内部错误码映射为可行动中文：

- 输出/参数契约错误：`记忆整理结果格式不符合要求，系统将自动重试。`
- 日期冲突：`计划日期解析结果不一致，系统将重新整理。`
- 证据/计划匹配错误：`没有唯一匹配到要更新的计划，系统将重新整理。`
- App Server 超时：`记忆整理服务响应超时，系统将自动重试。`
- 未知错误：`记忆整理暂时失败，系统将自动重试。`

内部 job 与 attempt diagnostics 仍保存错误码；`getPublicState()` 只暴露格式化后的 `lastError` 与 attempt `errorMessage`，不再暴露 `errorCode`。这样调用者不必理解内部错误分类，格式化逻辑集中在 AccountMemorySystem 深模块。

## 不变量

- 每次任务最多一次即时修复生成。
- 修复失败后仍只由现有持久化调度器重试。
- 同一 batch/revision/binding 不变，修复 turn 不可改变账户或证据范围。
- 用户界面没有原始异常、路径、token、模型原始输出或内部错误码。
- 不自动发送真实微信消息；本地测试只验证公开状态和页面渲染。

## 验证

- Curator 单测：首轮非法 JSON、次轮有效时提交成功且只创建一个 thread。
- Curator 单测：两轮都非法时抛稳定错误且恰好调用两次。
- Curator 单测：日期冲突不触发即时格式修复。
- AccountMemorySystem 单测：公开状态和 recent attempts 使用中文原因，持久化文件仍保存内部码。
- 页面测试：摘要、诊断区均不出现 `memory_` / `curator_`。
- 全量 lint、typecheck、unit/integration、Playwright E2E、build。

## 设计审查

- 不增加外部 interface，修复策略完全隐藏在 Curator 模块内部。
- 不回显首轮坏输出，避免二次 prompt injection 和 token 膨胀。
- 不把所有宿主校验失败都归为“格式问题”；语义冲突不会被即时重复生成掩盖。
- 公开错误去敏与持久化诊断分离，既保留排障证据，也满足用户界面不泄漏内部实现。
- 修复次数固定为一，避免模型持续生成造成资源失控。
