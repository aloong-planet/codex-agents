# ADR-0004: 使用受控待处理响应恢复工作流

- 状态: 已接受(2026-08-26)

## 背景与问题

工作流可以在 Input Gate 持久等待用户选择，但当前只有裸序号和显式短引用能被确定性转换为 Signal。自然语言回答若进入普通 Codex，会缺少结构化候选上下文和恢复权限；直接把底层 Signal 工具暴露给主模型又会泄漏可信字段并形成第二条状态与副作用路径。

## 备选项

1. **Engine 保持状态真源，由受限 Turn Router 解释语义，再由可信 Workflow Response Bridge 合成并提交 Signal**
2. 把可填写 account、target、run、revision 和候选标识的 `workflow_signal` 暴露给普通 Codex——模型会接触不应伪造的可信字段，旧会话工具契约也难以热更新
3. 引入 OpenAI Agents SDK 的 RunState 与 HITL 作为新的恢复运行时——会与现有 Workflow Engine 形成双状态真源，并要求迁移当前 Codex App Server 会话
4. 只扩充正则和序号规则——无法稳定覆盖“合照那张”“不是证件照的”等语义选择，也不能解决普通会话缺少结构化上下文的问题

## 决策

选定**方案 1**：我们保持 Workflow Engine 为 Pending Request、revision 和恢复状态的唯一真源。宿主按当前微信账户与目标投影脱敏候选；确定性选择快路径或受限 Turn Router 只产生 `respond(requestRef, choiceRefs[])`、`cancel(requestRef)`、`new_goal(goal)`、`clarify` 或 `ordinary_message`。`goal` 是模型理解出的开放自然语言目标，不是业务 intent 枚举；它交给既有 Planner/Gateway 入口，并在启动新回合前把同账户与目标的旧 Pending Request 标记为 `superseded`。`cancel` 由 Turn Router 依据语义判断，宿主不维护取消词枚举；可信 Workflow Response Bridge 使用首次投影解释 Router 引用，再重新读取 Engine 实时状态，并按稳定资源身份把首次选择重绑定到当前候选。对象字段顺序、过期时间、临时 handle 和检索排名等无语义表示差异不得使引用失效；只有选中资源仍存在且其可执行语义内容未变时才可继续，并使用当前 revision 与当前候选值原子提交 Signal。单选或子集选择不受未选候选增删影响；“都要”等覆盖首次完整集合的回答在候选集合变化时必须重新确认，不能擅自扩大或缩小范围。选中资源消失、内容改变、请求过期、结束或被替换时不执行副作用；可信宿主用自然语言说明具体变化并展示仍有效的最新选择，不向用户暴露 stale、revision 或候选 hash。候选提示只有在微信渠道接受后才成为该账户与目标的“最近展示”绑定；裸序号优先解释为这次展示中的选择，重复相同请求则重显原候选而不创建新 Run。普通 Codex 可获得只读的待选上下文投影，但不获得裸 Signal 权限。

## 后果

- 正面：自然语言选择与裸序号共享同一恢复与幂等边界，模型不能伪造账户、目标、revision、路径或 effect 标识。
- 正面：同一账户与目标最多保留一个待选；未被渠道接受、已过期或已被新目标取代的提示不会参与绑定，revision 变化只会进入可信重绑定而不会直接沿用旧候选。
- 正面：存在旧待选项时，模型仍可把独立完整的新请求路由为开放目标；宿主不靠关键词或业务枚举抢占该消息，并确定性终结旧待选。
- 正面：无法判断是旧回答还是新目标时保持旧待选并澄清，不猜测、不并存两个 Pending。
- 正面：同一个待处理请求可接受单选或模板明确允许的多选；“全部”在宿主实时 revision 上展开，模型不能构造候选值。
- 正面：等待期间的无语义表示变化不会打断选择；与所选资源无关的候选增删也不会阻断明确的单选或子集选择。
- 正面：真正影响选择范围或资源内容的变化会转换为可操作的自然语言提示，用户可以基于最新列表重新选择，而不是看到内部并发控制术语。
- 正面：用户可用自然语言明确取消当前待选，取消作为持久终态而不是空选择或删除记录。
- 正面：现有 App Server thread 不需要因本阶段增加底层动态工具而轮换；未来若提供模型可见入口，也只能是稳定、窄化的待处理响应接口。
- 正面：Engine 继续拥有唯一状态和副作用所有权，避免 OpenAI Agents RunState 或普通聊天形成第二套恢复状态。
- 负面：每个可能包含待处理回答的回合会增加一次有界投影与必要时的一次受限语义判断，并需要维护歧义和失效时的澄清语义。
- 中性：已有短引用和绑定到最近已接受提示的纯序号解析保留为快路径，但从直接提交 Signal 改为调用同一个 Workflow Response Bridge。

## 来源

- `../specs/workflow-runs.md`
- `/Users/loong_zhou/research/agent-workflow-signals/best-practices.md`
- ADR-0001 与当前 Input Gate、SignalInbox、微信 Trigger Adapter 代码事实核查（2026-08-26）

## 后续裁定

ADR-0005 与 ADR-0006 只替换 `new_goal(goal)` 的下游：旧 Pending 仍先原子 supersede，但开放自然语言目标改交主微信 Codex 回合选择领域工作流工具，不再进入独立 Intent Planner。Pending Request、Turn Router、Workflow Response Bridge 与 Signal 的其余决策保持有效。

ADR-0007 进一步取代 ADR-0005 与 ADR-0006：主微信 Codex 回合改为直接调用受限 `files.*` 工具，并以 `weixin.send_files` 提交文件外发；本 ADR 的 Pending Request、Turn Router、Workflow Response Bridge 与 Signal 语义继续保持有效。
