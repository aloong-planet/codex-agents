# Codex 微信助理上下文

This context describes personal Weixin/Feishu conversations, authorized Feishu groups, shared workflow capabilities and local module permissions.

## Contents

- Group requester
- Dispatch Request
- Sending Agent
- Coordinator
- Agent Team
- Team Leader
- Executor
- Assignment
- Brief
- Team Directory
- Agent Profile
- MCP Catalog
- Skill Library
- Draining
- Revocation
- 模块（Module）
- 能力（Capability）
- 工作流模板（Workflow Template）
- 运行（Run）
- 输入门（Input Gate）
- 待处理请求（Pending Request）
- 待处理响应（Pending Response）
- 待选上下文投影（Pending Context Projection）
- 信号（Signal）
- 回合路由器（Turn Router）
- 映射能力步骤（Map Capability Step）
- 工作流响应桥（Workflow Response Bridge）
- 候选重绑定（Candidate Rebinding）
- 微信 Trigger Adapter
- 主微信 Codex 回合（Main Weixin Codex Turn）
- 工作流工具请求（Workflow Tool Request）
- 领域工作流工具（Domain Workflow Tool）
- 内联查询（Inline Query）
- 文件搜索观察（File Search Observation）
- 文件查询迭代（File Query Iteration）
- 内联修改（Inline Mutation）
- 终止型工作流（Terminal Workflow）
- 文件操作日志（File Operation Journal）
- 不可变发送快照（Immutable Send Snapshot）
- 访问上下文代际（Access Context Epoch）
- 工作流工具目录（Workflow Tool Catalog）
- 工作流网关（Workflow Gateway）
- Owner
- Effect
- 模块权限（Module Permission）
- 资源范围（Resource Scope）
- 渠道上下文（Channel Context）
- 微信文件发送（Weixin File Send）
- 微信单文件提交（Weixin File Submission）
- 图片来源（Image Source）
- 近期图片（Recent Image）
- 最新单项选择（Latest-one Selection）
- Scheduled Task
- Research Task
- Daily News Ownership
- News Article Result
- Current HN Selection
- Execution Summary
- Known Execution Count
- News Archive
- Reminder Text
- Scheduled Occurrence
- Cadence Revision
- Skipped Range
- Cached Output
- Scheduled Delivery Attempt
- Completed Scheduled Task
- Reminder Intent Ownership

## Language（术语）

**Group requester**:
The authorized member whose message initiated a group request, whether by a mention or by enabled automatic dispatch. This person is distinct from the group sharing discussion and tasks, and from the reply Owner.
_Avoid_: group owner, personal owner

**Dispatch Request**:
A business request handled by Agent Teams under its original requester's authority, started from a group message or from the owner's private conversation with the Coordinator or a Team Leader. It is distinct from an Assignment, the source platform message, a Workflow Run, a Pending Request and a Scheduled Task.
_Avoid_: message ID, workflow run, reminder

**Sending Agent**:
The Coordinator or Team Leader whose identity speaks for a Dispatch Request and its resulting deliveries. It is distinct from the human Group requester, from an Executor, and from the canonical group identity used for group memory and tasks.
_Avoid_: requester, group owner, reply Owner

**Coordinator**:
The group-level agent, configured as Sam, that routes Dispatch Requests to Agent Teams and mediates cooperation between teams without executing business work. It is distinct from a Team Leader, which coordinates only inside its own team.
_Avoid_: supervisor, main agent, 总管

**Agent Team**:
A domain unit of one Team Leader and at least one preset Agent Profile for its Executors, defined once and bound to dispatch groups. It is distinct from a group conversation and from a Module.
_Avoid_: specialist (one agent under ADR-0024), department

**Team Leader**:
The agent that divides its Agent Team's Dispatch Requests into Assignments, coordinates and summarises them, and speaks for the team, holding no side-effecting tools. It is distinct from the Coordinator and from an Executor.
_Avoid_: specialist, lead

**Executor**:
A task-created agent, without bot identity or private chat, that performs exactly one Assignment using one of its team's preset Agent Profiles. It is distinct from a Sending Agent and from Codex's built-in sub-agents.
_Avoid_: Team Member (implies a fixed roster), sub-agent, 子 Agent, 成员

**Assignment**:
One part of a Dispatch Request that a Team Leader gives to exactly one Executor. It is distinct from the Dispatch Request itself and from a Scheduled Task.
_Avoid_: subtask, 任务 (ambiguous)

**Brief**:
The content an assigning agent hands to the agent it assigns, which together with that agent's own memory is its only view of outside context. It is distinct from group memory and from shared discussion.
_Avoid_: shared context, 交办记录

**Team Directory**:
The names and responsibilities of the Agent Teams bound to a group, as given to that group's Coordinator and Team Leaders. It is distinct from a Brief and holds no team's work content.
_Avoid_: roster memory, 团队记忆

**Agent Profile**:
The instructions, host-tool allowlist, MCP servers, skills and memory scope bound to the Coordinator, a Team Leader, or one of a team's Executor presets. It is distinct from a Module Permission, which grants local resources, and from the Workflow Tool Catalog, which lists what a turn may request.
_Avoid_: role prompt, persona, executor template (an Executor preset is an Agent Profile)

**MCP Catalog**:
The MCP servers registered in the local console, whose connections the host service holds and whose tools reach only agents whose Agent Profile attaches the server. It is distinct from MCP servers configured for the host's own Codex, which isolated runtimes never load.
_Avoid_: MCP list, plugin

**Skill Library**:
The skills imported into the local console from local folders, from which Agent Profiles select skills. It is distinct from the host's own skills, which isolated runtimes never discover.
_Avoid_: skill folder, host skills

**Draining**:
The state of an Agent Team's binding to one group between the start of its removal and the end of its remaining work and scheduled tasks there. It is distinct from removal, which completes only after draining, and from cancelling that work, which draining never does.
_Avoid_: removed (only once draining completes), disabled

**Revocation**:
A saved change that takes capability away from agents: unbinding an MCP server, disabling a server or tool, removing a host tool from an Agent Profile, or narrowing a Module Permission. It is distinct from every other saved change, which reaches only requests admitted afterwards, whereas a revocation also binds running requests.
_Avoid_: unbind (only one kind of revocation), permission change

**模块（Module）**：
一组可安装或启用的个人助理能力，并声明自己能够操作的资源类型。
_Avoid_：插件能力、工具包

**能力（Capability）**：
模块向工作流提供的一项受约束操作，具有明确的输入、输出和 effect 类型。
_Avoid_：底层工具、任意工具调用

**工作流模板（Workflow Template）**：
经过审查、带版本且有界的步骤关系，用于描述允许执行的副作用流程。
_Avoid_：脚本、自由规划

**运行（Run）**：
一次触发被持久接受后形成的工作流实例，拥有冻结的计划和可审计状态。
_Avoid_：任务进程、会话

**输入门（Input Gate）**：
冻结计划中的控制步骤；唯一候选自动通过，多候选持久暂停同一个运行，等待受约束输入。
_Avoid_：Provider 追问、第二个选择任务

**待处理请求（Pending Request）**：
Input Gate 为等待中的运行持久化的受约束选择请求；它属于 Engine 状态，不属于聊天历史。
_Avoid_：上一条对话、模型记住的候选

**待处理响应（Pending Response）**：
用户对待处理请求的本轮回答，经语义解释后只能成为一个或多个选择、明确取消、澄清、独立新目标或普通消息之一。
_Avoid_：裸 Signal、任意工具参数

**待选上下文投影（Pending Context Projection）**：
The redacted Pending Requests visible to the current conversation and, in a group, the current requester. It is distinct from shared discussion history.
_Avoid_：运行快照、内部路径、完整 Signal 参数

**信号（Signal）**：
A trusted host response bound to a Pending Request and its original conversation, with the original requester additionally bound for group requests. It is not authority supplied by model arguments.
_Avoid_：模型工具、用户消息、任意下一条聊天

**回合路由器（Turn Router）**：
把当前用户文本与待选上下文投影解释为单选或多选、明确取消、独立新目标、澄清或普通消息的受限语义组件；新目标是开放自然语言，不是业务 intent 枚举。它不持有 Engine 状态，也不执行副作用。取消必须由模型语义判断，不由宿主枚举自然语言关键词。
_Avoid_：工作流所有者、自由工具 Agent

**映射能力步骤（Map Capability Step）**：
把输入门冻结的候选集合展开为多个独立、持久、可审计的能力调用，并聚合每一项的确定结果；它属于 Engine 控制流，不属于 Provider 批量接口。
_Avoid_：批量 Provider、单条 effect 包住多次外部发送

**工作流响应桥（Workflow Response Bridge）**：
把受约束的待处理响应与可信微信回合绑定合成为 Engine Signal 的宿主深模块。
_Avoid_：模型可见的 workflow_signal、第二套工作流状态

**候选重绑定（Candidate Rebinding）**：
用户回答期间待处理请求发生变化时，工作流响应桥按稳定资源身份把首次展示的选择映射到当前候选；只有选中资源仍存在且语义内容未变时才可继续。全选范围变化、选中资源消失或内容改变时必须停止执行并展示最新选择。
_Avoid_：只比较 revision、把陈旧引用直接提交、向用户暴露 stale

**微信 Trigger Adapter**：
微信可靠入站、待处理响应协调器与主微信 Codex 回合之间的宿主适配层。它负责可信回合绑定、工具目录装配与确定性待处理响应快路径；本身不解释新工作流的业务意图，也不拥有模板、Provider 或副作用。
_Avoid_：工作流状态源、业务关键词门禁、独立 Intent Planner

**主微信 Codex 回合（Main Weixin Codex Turn）**：
拥有当前微信对话上下文并看到当前可用工作流工具的唯一新意图语义 owner；它决定生成普通回复或提出结构化工作流工具调用。
_Avoid_：前置 Intent Planner、宿主关键词分类器

**工作流工具请求（Workflow Tool Request）**：
主微信 Codex 回合依据模型可见工具的名称、描述和 schema 产生的结构化请求；它表达语义目标与公开槽位，但仍是不可信输入，不携带账户、目标、授权、路径、模板、DAG 或 effect 标识。
_Avoid_：已授权命令、可直接执行的计划

**领域工作流工具（Domain Workflow Tool）**：
模型可见、按资源领域命名且拥有严格 member schema 的深工具；每个工具只表达一种稳定目标，并按执行语义绑定受限的本地能力或由工作流网关映射到已审查模板。
_Avoid_：万能 workflow.execute、Provider 能力、任意 action/payload

**内联查询（Inline Query）**：
A scoped read operation that returns structured facts to the Main Weixin Codex Turn without taking final reply ownership.
_Avoid_：读取 Run、查询工作流

**文件搜索观察（File Search Observation）**：
一次 `files.find` 或 `files.grep` 调用返回给主微信 Codex 回合的结构化事实，包括候选、扫描完整性、截断、跳过项和错误；零候选只描述这一次查询，不等于用户目标已经无解。
_Avoid_：未找到结论、宿主查询决策

**文件查询迭代（File Query Iteration）**：
主微信 Codex 回合根据文件搜索观察自行缩短、改写、换模式或收窄范围并再次调用文件工具的标准工具循环；它不由独立 Resolver、Query Rewriter 或宿主词表接管。
_Avoid_：自动删词、零结果兜底工作流

**内联修改（Inline Mutation）**：
A deterministic local change with durable operation identity and a stored result; the Main Weixin Codex Turn continues after the result. It does not own an external delivery.
_Avoid_：写入工作流、无记录副作用

**终止型工作流（Terminal Workflow）**：
完成持久预检并被 Engine 接受后取得当前微信回合最终回复 Owner 的工作流；首版每个入站最多一个。
_Avoid_：所有有副作用的工具、预检失败

**文件操作日志（File Operation Journal）**：
本地文件修改的持久进度与结果记录，用于中断后核对同一次操作是否已经完成、避免重复修改；不等同于微信发送回执。
_Avoid_：Workflow Run、沙箱内存状态

**不可变发送快照（Immutable Send Snapshot）**：
从当前仍获授权的普通文件生成、绑定内容 hash 与安全文件名、只供渠道提交读取的私有副本；渠道不得重新打开用户原始路径。
_Avoid_：原始绝对路径、文件查询结果

**访问上下文代际（Access Context Epoch）**：
账户读取权限可见范围的单调版本；收窄读取权限时递增并阻止旧 App Server thread 恢复，独立于工具契约 hash。
_Avoid_：permission revision、toolContractHash

**工作流工具目录（Workflow Tool Catalog）**：
主微信 Codex 回合当前可见的领域工作流工具契约集合；目录只描述模型可请求的能力，不代表任何请求已获授权或已经执行。
_Avoid_：能力 Provider 注册表、权限快照、执行计划

**工作流网关（Workflow Gateway）**：
把工作流工具请求映射到已审查模板的唯一深入口；真实账户、目标、artifact reference 与模板由可信宿主绑定。
_Avoid_：能力目录、任意 DAG 提交器

**Owner**：
某个微信回合当前唯一的最终回复归属；内联操作不改变 Owner，只有完成持久预检并被 Engine 接受的终止型工作流可以从主微信 Codex 回合取得 Owner。`legacy` 与 `shadow` 只表示迁移中的旧实现状态，不能扩展为新的路由路径。
_Avoid_：两个路径同时试运行

**Effect**：
一次可能改变本地或外部世界的操作尝试；渠道接受不等于用户实际收到。
_Avoid_：动作结果、已送达

**模块权限（Module Permission）**：
用户在模块安装、首次启用或设置页中持久配置的本地资源授权。
_Avoid_：会话授权、运行中审批

**资源范围（Resource Scope）**：
模块获准读取或写入的一个目录边界；写入包含读取，只读不包含写入。
_Avoid_：工作区权限、全盘权限

**渠道上下文（Channel Context）**：
微信通道执行回复或推送所需的当前账户、目标与可发送条件，不属于模块文件权限。
_Avoid_：外部发送权限

**微信文件发送（Weixin File Send）**：
把一个或多个已经选定的授权文件提交到当前微信目标的领域工作流目标；模型可见规范名为 `weixin.send_files`。
_Avoid_：files.send、文件操作

**微信单文件提交（Weixin File Submission）**：
工作流内部向微信通道提交一个已解析文件的一次 Effect；规范能力名为 `weixin.submit_file`，只表示发送尝试，不表示用户已经收到。
_Avoid_：weixin.send_file、文件送达

**图片来源（Image Source）**：
一次图片发送请求被允许解析的唯一候选域，取值为引用图片、当前消息图片、同账户同目标近期图片或已授权本地图片目录；明确来源之间不互相回退。
_Avoid_：任意本地路径、模型猜测来源

**近期图片（Recent Image）**：
同一微信账户与目标在最近十分钟内收到的最多五张入站图片，只能在用户明确说“刚才”“上一张”或“最近”等近期指代时成为候选。
_Avoid_：全局图片历史、跨目标附件

**最新单项选择（Latest-one Selection）**：
用户明确要求已授权本地图片来源中的最新一项时形成的有序单项约束；“最新”以文件最后修改时间为准，时间相同则使用稳定路径顺序确定唯一结果。
_Avoid_：从普通多候选中猜第一项、创建时间、拍摄时间

**Scheduled Task**:
A durable instruction, schedule and trusted destination with a stable identity. It is distinct from a Workflow Run and from any individual execution.
_Avoid_: chat turn, timer process

**Research Task**:
A Scheduled Task whose accepted instruction produces a fresh, complete text report from public web sources at execution time. Its report is distinct from a static Reminder Text and from its management receipt.
_Avoid_: creating chat turn, arbitrary program, prewritten reminder

**Daily News Ownership**:
The exclusive authority to execute the existing specialised news task and deliver its retained output. A prepared transfer may have no active owner; a committed transfer never reactivates the former owner automatically.
_Avoid_: final reply Owner, second news scheduler

**News Article Result**:
The durably validated original body and detailed/short summaries for one stable article identity within a daily-news owner. Success is retained across ordinary later encounters. Legacy results can receive one separate content-eligibility assessment; rejection excludes new selection without rewriting the saved body or summaries.
_Avoid_: ranking snapshot, temporary summary flag

**Current HN Selection**:
The first requested number of eligible articles in the current hot-list order for a new news occurrence. Prior delivery does not exclude an otherwise eligible article; its successful News Article Result is reused.
_Avoid_: never-delivered articles, newly generated summaries

**Execution Summary**:
The permanent identity, time and outcome of an occurrence, independent of whether its detailed output remains available.
_Avoid_: Cached Output, full execution log

**Known Execution Count**:
The number of distinct recorded executions, excluding skipped ranges. It is cumulative for tasks with complete history and a known minimum when earlier history may have been lost.
_Avoid_: retry count, page size, fabricated lifetime total

**News Archive**:
The user-readable local article, summary and ranking notes derived from saved News Article Results. Archive completion is distinct from result persistence and delivery acceptance.
_Avoid_: Cached Output, mandatory result store

**Reminder Text**:
The complete recipient-facing message selected when a reminder is created or its content is explicitly edited. It is distinct from the task's semantic instruction and the original request; verbatim text preserves the specified payload.
_Avoid_: management instruction, regenerated reminder

**Scheduled Occurrence**:
One accepted opportunity to execute a Scheduled Task, with its own planned instant and frozen settings revision.
_Avoid_: recurring plan, delivery attempt

**Cadence Revision**:
The version of a Scheduled Task's time rule and anchor. Name/content edits preserve it; changing the rule establishes a new future cadence.
_Avoid_: settings revision, pause generation

**Skipped Range**:
A compact record of older unclaimed recurring slots superseded by the latest eligible slot, with first/last planned instants and cadence revision. It has no generated output.
_Avoid_: failed execution, cached backlog

**Cached Output**:
The complete persisted text produced by a Scheduled Occurrence and retained while its delivery remains pending.
_Avoid_: draft to regenerate, successful delivery

**Scheduled Delivery Attempt**:
One claim to submit Cached Output under captured channel prerequisites, with separately recorded outcomes for submitted parts.
_Avoid_: phone receipt, execution result

**Completed Scheduled Task**:
A one-time Scheduled Task whose occurrence succeeded and whose complete output was accepted by its channel. It remains inspectable history, independently of the task's enabled setting; it is not proof of phone receipt.
_Avoid_: deleted task, paused task, generated output

**Reminder Intent Ownership**:
The durable assignment of a specific reminder intent to either Scheduled Tasks or memory follow-ups. It applies to that intent, not every plan in the same message.
_Avoid_: message-wide suppression, final reply Owner

## Relationships（关系）

- 一个模块可以提供多个能力，并拥有多个资源范围。
- 一个工作流模板只引用已登记的能力；一次运行使用模板编译出的冻结计划。
- Input Gate 属于 Engine 控制流，不属于 Capability Provider；合法 Signal 恢复原冻结运行。
- Engine 是 Pending Request 与 Signal 的唯一状态源；Turn Router 只消费脱敏投影，Workflow Response Bridge 必须在提交前重新读取并校验实时状态。
- Private Pending Requests belong to their conversation; group Pending Requests additionally belong to their requester. Shared group discussion and shared group task management do not transfer that ownership (ADR-0023).
- A pending presentation belongs to the same conversation and requester as its Pending Request; sharing a group transcript does not make another member its recipient (ADR-0023).
- 输入门由模板显式声明单选或多选；多选只接受同一实时待处理请求中的非空候选集合，“都要”在可信宿主边界展开为该 revision 的完整候选引用集合。
- 映射能力步骤为每个选中项建立独立 effect；微信图片与文件批量发送按候选顺序串行执行，单项明确失败不阻断后续项。
- 模块权限约束本地资源 effect；渠道上下文约束微信 effect。
- 一个触发最多由一个副作用 owner 接管并产生一个运行。
- 图片发送 intent 由宿主按引用、当前附件、明确近期指代、明确授权本地目录的顺序绑定单一图片来源；一旦绑定不得跨来源兜底。
- 图片本地目录的用户表达可使用任意大小写的 Downloads、Pictures、Documents 或中文“下载”“相册”“文档”；主微信 Codex 回合只能在宿主提供的已授权目录引用内调用 `files.find/files.grep`，不能生成目录 ID、账户、目标或任意文件路径。
- 最新单项选择只在主微信 Codex 回合通过 `files.*` 选定的已授权本地图片范围内生效：查询必须显式请求稳定时间排序和单项返回；宿主只校验查询边界与结果引用，不替模型选择业务参数。引用、当前消息和近期图片来源继续走冻结的旧媒体来源流程。
- Photos Library 是本地媒体目录内不可进入的 Apple 隐私边界：任何已授权根目录中的 `.photoslibrary` 都不参与递归搜索，其中的旧路径也不能通过发送前再校验；其他目录包按普通目录处理，除非以后有独立证据证明它会触发额外 Apple 隐私授权。
- 主微信 Codex 回合根据当前工具目录决定普通回复或工作流工具请求；宿主不得用业务关键词、正则或硬编码 intent 枚举作为新工作流入口门禁。
- 文件搜索观察始终返回同一个主微信 Codex 回合；一次窄查询的零候选不触发宿主终局或第二个语义组件，后续是否重试及如何改写仍由主模型决定。
- 工作流工具请求是不可信输入；Gateway 不能接受模型提供的账户、目标、路径、模板、capability、DAG 或 effect 标识。
- 工作流工具目录按职责命名：`files.*` 只表示本地文件系统操作，`weixin.send_files` 表示微信渠道文件发送目标；宿主内部可以共享一个 Workflow Gateway，但模型侧不得暴露万能入口。
- 文件工具目录按执行语义区分内联查询、内联修改和终止型工作流；该分类属于宿主执行契约，不替模型解释用户业务意图。
- 文件内联修改由 Local File Tools 的文件操作日志持久化，不创建 Workflow Run；终止型工作流只有在 disposition 所需产物与 Run 均持久化后才取得 Owner。
- 内联修改的临时文件身份须经文件操作日志持久确认后才允许替换目标；恢复只清理日志登记且身份与内容仍匹配的文件，不按文件名模式清理用户目录。未登记或无法确认归属的中断残留保留，不借恢复流程扩大删除能力。
- 已选文件在外发 Run 接受前生成不可变发送快照；待选文件只持久化候选身份，用户选择并重新绑定成功后才生成快照。
- 账户目录授权可供该账户下明确启用的目标使用；未启用目标不能进入主微信 Codex 回合或文件工具宿主。
- 独立 Intent Planner 及其 shadow 观测不属于现行目标架构；迁移期间的旧实现不得接管新工具路由、产生第二份回复或双跑副作用。

- Scheduled Task management returns to the Main Weixin Codex Turn; the service owns the later occurrence and does not retain the creating turn's reply ownership.
- A Scheduled Task kind selects a fixed reviewed reminder, public-web research or existing specialised daily-news behavior; it is not a Workflow Template identifier and grants no new authority.
- One Scheduled Occurrence may have Cached Output and several prerequisite-failed attempts; its execution result and its current delivery eligibility are separate facts.

## Invariants（不变量）

- Current Scheduled Task settings are authoritative; historical conversation and personal memory cannot authorize restoring an older configuration. Querying, refreshing delivery prerequisites or executing once preserves settings unless the current request explicitly asks for a change.
- Task-owned settings do not remain a second active personal-memory configuration. Retiring them preserves independent personal preferences and the original evidence; retirement never changes the task itself.

- Daily News Ownership transfers only after the former owner cannot start more work. Import preserves surviving identities, exact output and known outcomes; a new owner never regenerates cached delivery or reconstructs pruned history.
- A new Current HN Selection may redisplay previously delivered articles; it never authorises replay of the same settled Scheduled Occurrence.
- Newly processed news requires a supported candidate/body correspondence assessment before it becomes a News Article Result. Wrong-topic or insufficient bodies cannot be substituted as news; unsuccessful admission does not grant a new delivery.
- A successful News Article Result is not regenerated because its ranking/date changed or its archive/delivery failed. Missing or damaged saved results do not reopen processing automatically.
- A News Archive failure cannot withhold durably saved eligible Cached Output. Archive recovery cannot modify or resend that output.
- News research retries and delivery recovery are separate: failed research has no deliverable, while channel recovery uses already persisted output. History cleanup cannot remove a still-valid promised retry.

- Every explicit disable advances a durable pause generation. A manual occurrence may send while paused only under its still-current grant; re-enabling never continues a partially submitted occurrence.
- Task deletion retains Reminder Intent Ownership. Execution-detail cleanup cannot reopen automatic claims or management requests, discard pending bodies, or erase an unresolved outcome from the current task classification.
- Fixed intervals preserve their anchor across completion, content edits and restart. Intentional pause resumes at the next future slot; downtime admits only the latest unclaimed slot and compacts older slots. Cursor/claim/range updates are atomic, and detail cleanup cannot reverse them.
- Schedule exhaustion alone never makes a Scheduled Task completed. Pending Cached Output remains recoverable; completion never revives an occurrence or deletes its evidence.
- Research content and fetched-page instructions never grant task-management, local-resource or additional outbound authority. Research completion, persisted Cached Output and channel acceptance remain separate facts.
- Scheduled recovery uses the original account and conversation and preserves the exact Cached Output. Accepted, partial, rejected and unknown delivery outcomes cannot be automatically replayed.
- A historical failure cannot invalidate a newer usable channel binding or context. Repeated delivery of the same inbound event is not a fresh context.
- Every participating reminder subsystem must establish Reminder Intent Ownership before activation. A confirmed rolled-back memory write must not retain a newly created effective ownership claim; an uncertain activation retains its claim until reconciled.


- 微信链路诊断只提供观察证据，不改变业务权限、运行状态或重放副作用；缺失结束证据不能被解释为运行仍在执行、成功或失败。

- 模块权限只能在安装、首次启用或设置页中改变，运行过程中只校验权限。
- 所有已列资源默认预选读取且不预选写入；用户保存前不产生授权。
- 写入包含读取，但不包含删除或执行；只读不允许修改。
- 用户文件、脚本和二进制的执行始终禁止。
- 文件查询分为 `find`（名称/路径）与 `grep`（正文命中）；`read` 是独立动作。发送已有原文件不读取正文。
- `files.*` 命名空间不得包含外部发送；微信文件发送由 `weixin.send_files` 表达，并把每个选中文件映射为独立的 `weixin.submit_file` Effect。
- 搜索、读取、写入与外发的权限、结果和 effect 语义不同，必须保持为不同的领域工作流工具；同一资源上的同构动作只有在 schema、权限和 effect 等价时才可合并。
- 主微信 Codex 回合直接调用宿主提供的 `files.find/files.grep/files.read` 并自行决定公开查询参数与候选选择；宿主执行查询并校验授权、预算、结果引用与结构，不解释业务语义，也不维护通用词删除表。模型不能提供权限、账户、目标或 effect。
- 模糊匹配可以做 Unicode 规范化、字符体系边界切分和机械相关度排序，但不能把“笔记”“文件”等词维护为业务停用词；查询语义改写属于文件查询迭代。
- 通用文件能力不拥有目录；目录与读写授权仍由模块权限 registry 按 module/scope 管理。
- 权限不足时不得执行相关 effect；调整权限后不得自动恢复旧运行。
- 收窄读取权限必须递增访问上下文代际并轮换该账户已启用目标的旧 App Server thread；旧文件正文、grep 片段和自动摘要不得复制到新 thread。
- reference 的认证身份与实时可用性必须分开；内容变化造成引用 stale 时，宿主仍可用冻结身份查询既有文件操作日志，但不能据此授权新的访问。
- 微信通道只能读取不可变发送快照，不能根据 file reference 重新打开用户原始路径。
- 旧冻结文件 Run 的 version=1 路径 artifact 只在兼容边界解析，选择后经当前授权、文件沙箱和账户快照配额转成私有快照；它没有搜索时内容摘要，不能提供历史内容冲突检测，也不能恢复旧搜索器。
- 已 superseded、expired 或 consumed 的待处理请求不能被迟到回复重新激活。
- 外部 effect 的未知结果不得当作失败自动重试，也不得表述为已送达。
- 旧文件查找退役与待通知记录原子持久化；通知只使用原 Run 的接收人绑定，不借用当前目标。通知发送中的崩溃按 unknown 保留，不自动重发或恢复旧任务。
- 多候选不得猜测；Signal 与 gate 输出、请求消费和 Run 恢复必须原子提交，已成功前置步骤不得重跑。
- 模型不得提供 Signal 的账户、目标、run、revision、候选 hash、路径或幂等键；这些字段只能来自可信回合绑定与 Engine 实时状态。
- 待处理响应一旦被工作流接管，普通聊天不得再生成该回合的最终回复或副作用。
- 明确取消只终结仍在等待的待处理请求，不执行后续 capability；完整新目标仍以 superseded 终结旧请求。
- 批量外部 effect 的 accepted、rejected 与 unknown 必须逐项保存；任一 unknown 都不得触发自动重发。
- 未声明最新单项选择的图片来源中，多个合法候选必须经过 Input Gate；没有候选时结束当前运行，不把请求交回旧媒体动态工具。

## Flagged ambiguities（已消解歧义）

- “Specialist” no longer names Alice, Bill or Jack: they are Team Leaders, and the agents that execute work are Executors (ADR-0026).
- “任务” no longer names a unit of agent work on its own: a whole request is a Dispatch Request, and one Executor's part is an Assignment (ADR-0026).
- “外部发送权限”不再作为模块权限维度：微信回复由渠道上下文约束，定时推送目标由 schedule 配置约束。
- “审批”不再表示运行中升级本地权限：本地权限不足时任务终止并引导用户前往设置页。
- `files.send` 不再表示微信文件工作流，因为它会与本地文件操作混淆；模型可见名称统一为 `weixin.send_files`，内部单文件通道能力统一为 `weixin.submit_file`。
