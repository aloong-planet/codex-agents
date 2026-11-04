# Memory Curator 尝试诊断设计

## 目标

当账户记忆整理失败、随后自动重试并成功时，仍能回答“第一次为什么失败、何时失败、是否安排了重试、最终是否恢复”。诊断必须持久化并在 Memory Curator 面板可见，同时不得保存微信正文、原始账户 ID、文件路径、命令、令牌、工具输出或异常堆栈。

## 模块与 seam

诊断属于 `AccountMemorySystem` 深模块的实现：它已经拥有任务状态机、重试策略、持久化文件和公开状态接口。调用者仍只使用 `captureTurn`、`recall`、`getPublicState` 与生命周期方法；不新增诊断写入接口。

Curator 和存储 adapter 抛出的异常只在该模块内部分类。页面只消费 `getPublicState()` 返回的安全诊断，不读取任务文件。

## 数据模型

每个任务保存最近 5 次尝试：

- `attempt`：从 1 开始的本任务执行序号。
- `startedAt`、`finishedAt`、`durationMs`。
- `stage`：`snapshot`、`resolve_policy` 或 `curate`。
- `outcome`：`committed`、`noop`、`needs_clarification` 或 `failed`。
- `errorCode`：仅失败时存在，取允许列表中的稳定码；未知异常统一为 `curator_unexpected_error`。
- `retryScheduledAt`：仅确实安排自动重试时存在。

任务状态文件升为 v4；v2/v3 任务迁移时补空诊断数组，现有任务、记忆 ID 和 SQLite 数据不迁移。

## 状态路径

1. 任务进入 `curating` 时记录开始时间并将阶段设为 `snapshot`。
2. 读取快照后进入 `resolve_policy`；调用 Curator 前进入 `curate`。
3. 成功、noop 或需澄清时追加终态诊断；清理当前错误与重试时间，但不清理尝试历史。
4. 失败时分类错误、追加失败诊断，并同时写入实际的下一次重试时间；无剩余重试时进入 `dead_letter`。
5. 账户在执行中被停用时，任务恢复为 `pending`，仍记录本次取消失败，但不安排重试时间。
6. 每个任务最多保留 5 条尝试，避免状态无限增长。

诊断的执行序号与自动重试失败计数分开：停用导致的取消会占一个诊断序号，但不会消耗任何重试档位；恢复后执行序号继续递增。

## 安全错误分类

只透传以 `memory_` 或 `curator_` 开头、且由本项目定义的稳定错误码。Codex/App Server 运行错误按文本模式归类为有限集合，例如 `codex_transport_closed`、`codex_thread_invalid`、`codex_turn_busy`；其他错误统一为 `curator_unexpected_error`。永不持久化原始 `message`、`name`、`stack` 或 cause。

## 页面

Memory Curator 页新增“最近整理诊断”。按当前账户显示最近任务的尝试列表，包含时间、耗时、阶段、结果、安全错误码和计划重试时间。没有新格式诊断的历史任务明确显示“暂无尝试诊断”，不伪造旧失败原因。

## 验收

- 第一次失败、立即重试成功后，公开状态和持久文件仍包含两条尝试。
- 未知异常的原文与敏感片段不出现在持久文件或公开状态中。
- 页面能展示失败、重试计划与恢复成功。
- v2/v3 状态能无损加载为 v4。
- 现有 FIFO、停用、dead-letter 和记忆写入行为不变。
