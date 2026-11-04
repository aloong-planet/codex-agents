# Memory Curator 单轮结构化决策优化设计

## 目标与已确认取舍

- 保留当前常驻 App Server transport；每个 job 仍创建普通、可持久化的新 thread，不使用 ephemeral thread，也不跨 job 复用 thread。
- 规范化文本的 Unicode 字素数小于等于 3 时，宿主无条件直接记为 no-op。
- 不再向模型发送完整 `MEMORY.md`；宿主从当前账户 SQLite 混合检索结果中选择至多 20 条候选记忆。
- 使用 `turn/start.outputSchema` 约束一次最终结构化决策；模型不再调用 `account_memory_commit` 动态工具。
- 宿主在 `turn/completed` 后解析结构化决策，并直接调用可信记忆提交模块。只有提交回执可以表示记忆已落盘。
- 本次不启用 experimental collaboration mode，也不把更换子进程 cwd 当作性能优化。

## 深模块与 seam

外部 seam 保持 `AccountMemorySystem.captureTurn()` 和 `AccountMemoryCurator.curate()`。调用方不需要知道 App Server、JSON Schema、候选检索或提交协议。

`MemoryCurationInput` 只暴露 Curator 做判断所需的数据：账户/job/batch/revision、trigger、mutation policy、候选记忆和本批 turns。完整 snapshot 与 Markdown 不跨过 Curator seam。

可信提交模块新增直接提交 interface：接收由宿主绑定的账户、batch、revision、证据和 mutation policy，再接收模型候选决策；它复用现有的去重、目标解析、敏感信息、CAS、锁和原子写实现。旧动态工具 adapter 可继续委托给同一实现，但不再用于 Curator 主路径。

## 流程

```text
capture completed turn
  -> low-information short-turn gate
  -> durable job
  -> read authoritative snapshot
  -> resolve explicit mutation policy
  -> search each user entry in account SQLite
  -> select <= 20 candidate entries, always including explicit target
  -> start fresh normal thread
  -> turn/start(outputSchema)
  -> wait for authoritative turn/completed + final agent message
  -> parse structured decision envelope
  -> trusted host commit
  -> committed / noop / needs_clarification / retry
```

### 短消息 gate

使用 `Intl.Segmenter("zh-CN", { granularity: "grapheme" })` 统计 `NFKC + trim` 后的可见 Unicode 字素。字素数 `<= 3` 时无条件 no-op，不再进行白名单或语义判断；因此 `去上海`、`爱咖啡` 会跳过 Curator，而 4 字素的 `pnpm` 仍会进入 Curator。

直接 no-op 仍创建持久 job 并立即以 `noop` 终态保存，从而在面板诊断中可见；不启动 App Server，不增加重试。

### 候选记忆

- 查询来源仅是当前 job 的用户正文。
- 每个查询调用已有账户内 FTS + exact vector search；失败或超时降级为空候选，不回退完整 Markdown。
- 合并结果按 query 顺序与 rank 排序，按 ID 去重并限制 20 条。
- `single_update` / `single_remove` 的可信 target 必须加入候选，即使搜索没有命中。
- 提交时仍重新读取完整权威 entries 做去重和目标解析；候选集只影响模型判断，不授权写入。

### outputSchema 与提交

最终输出 envelope 继续包含 `basedOnRevision`、`batchId` 和 `decisions`。Schema 与可信提交模块使用同一份定义，避免协议漂移。

当前 App Server 的 structured-output 子集要求 union 使用 `anyOf`（不接受 `oneOf`），每个 `const` / `enum` 同时声明 `type`，并且对象的 `required` 覆盖其全部 properties。共享 schema 和回归测试固定这些约束，避免动态工具 schema 可用但 response format 在真实服务端被拒绝。

App Server 的 `outputSchema` 只约束当前 turn 的最终 assistant message。宿主必须等待 `turn/completed(status=completed)`，解析最终文本后再调用提交模块。缺失文本、非法 JSON、schema 外字段、batch/revision 不匹配或提交失败都按现有 job 重试/死信路径处理，不声称成功。

该 schema 遵守 strict structured outputs 约束：每个 object 分支的
`required` 必须覆盖其全部 `properties`。语义上可选的事件字段仍出现在
`required` 中，但允许返回 `null`；宿主将 `null` 视为未提供并继续执行
可信校验。递归单测覆盖所有 `anyOf` 分支，防止新增字段时再次生成会被
App Server 直接拒绝的 schema。

直接提交使用现有 batch receipt 幂等：进程在模型完成后、状态落盘前崩溃，重试相同 batchId 只返回既有回执，不重复写入。

## 失败模式

- **短重要事实**：只要长度 `<= 3` 就直接 no-op，即使它具有语义；这是用户明确选择的性能优先边界。
- **emoji 组合**：按 grapheme 而非 UTF-16 code unit 计数。
- **搜索不可用**：候选为空，模型仍可识别新事实；可信提交在完整 store 上去重。
- **显式修订候选缺失**：可信 policy target 强制加入。
- **模型返回无效 JSON**：不提交，进入有限重试。
- **模型返回错误 batch/revision**：可信提交拒绝。
- **模型返回歧义 revise**：返回 needs_clarification，不重试、不写入。
- **App Server 第二次工具回合**：主路径没有 dynamic tool，因此不存在；提交在 turn 完成后由宿主执行。
- **普通微信聊天回归**：未配置 output schema 的 conversation payload 保持原状。

## 验收

1. 用户可见纵切测试证明 `好的`、`去上海`、`爱咖啡` 直接 no-op 且 Curator 未被调用；4 字素的 `pnpm` 仍调用 Curator。
2. 测试证明 emoji grapheme 与 NFKC/空白处理正确。
3. Curator prompt 不含 `memoryMarkdown` 或完整 snapshot，只含至多 20 个候选。
4. `turn/start` 仅对 Curator profile 携带 `outputSchema`；普通 conversation 不新增该字段。
5. Curator 从最终 JSON 调用可信直接提交，覆盖 add/update/event/noop/clarification/非法输出。
6. Curator `thread/start` 不再注册记忆 dynamic tool；主聊天动态工具不受影响。
7. 定向测试与 typecheck 每纵切通过；最终 lint、全量单测和可控 App Server no-write probe 通过。

## 实测结果

2026-08-17 使用临时账户、临时 SQLite 目录且不连接微信运行真实 App Server no-op 探针：

- App Server 接受 `outputSchema`，turn 状态 `completed`；
- Curator 结果 `noop`，SQLite revision 保持 `0`，没有记忆写入；
- 单次端到端耗时 6,738 ms；
- 探针曾明确发现并修复 `oneOf`、缺失显式 `type`、`required` 未覆盖全部 properties 三类真实 schema 兼容错误；对应约束已进入测试。

该单次耗时只用于确认协议和给出方向性对比，不作为稳定性能基准。
