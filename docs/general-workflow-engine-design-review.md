# 通用工作流引擎设计审查

> 历史方案审查：下文“通过”仅表示当时方案审查结论，不是当前代码或真实微信验收凭据。现行文件工具与主模型循环以 [微信工作流规格](specs/workflow-runs.md) 及 ADR-0008/0009 为准。

日期：2026-08-25（包含 2026-08-24 初审与后续补充审查）
审查对象：`general-workflow-engine-design.md`
结论：**修改后通过，可以进入分阶段实现；不允许一次性替换现有所有路径。**

## 1. 审查范围

本文只审查设计逻辑，不替代代码与测试审查。初审重点检查模块深度、权限边界、模型不确定性、DAG 上限、持久恢复、外部副作用、与现有 durable inbound/effect ledger 的兼容、scheduler 与微信共享引擎后的冲突，以及 UI 是否会误导用户；后续补充审查覆盖可信触发输入、笔记文件发送、混合 Agent 路由和补参恢复。

## 2. 关键发现与修订

### 2.1 不能把“模型会调用正确工具”当作可靠路由

**风险**：若唯一入口是 Codex Dynamic Tool，模型可能不调用、调用错误或旧 thread 没有新工具。

**修订**：明确媒体/笔记候选先由宿主路由；模型只输出结构化 intent/slots。单一 `assistant_workflow` gateway 只是普通对话中的补充入口，不能成为正确性的唯一依赖。

### 2.2 通用引擎不能顺手替换已验证的可靠入站

**风险**：重新实现 cursor、context token、inbound lease 会破坏已验证的不变量。

**修订**：`DurableInboundStore` 保持渠道事实来源，WeixinTriggerAdapter 只消费稳定 event key 并提交 run。第一阶段不迁移物理表。

### 2.3 双路径会造成重复副作用

**风险**：同一个“发送图片”请求同时进入新工作流和旧 Dynamic Tool，可能发送两次。

**修订**：采用 strangler ownership。每个已迁移 intent 必须有唯一 owner；新路由接管后关闭该 intent 的旧副作用分支，并用 trigger/effect idempotency 测试验证。

### 2.4 SQLite run 成功不等于外部送达

**风险**：把 provider accepted 或本地 HTTP 200 显示为“已收到”。

**修订**：状态与文案区分 `accepted`、`rejected`、`unknown` 和真实用户确认。微信 timeout 进入 `outcome_unknown`，禁止盲目重发。

### 2.5 Planner 非法输出不能降级为自由执行

**风险**：structured output 失败后交给普通 Codex 自行用 shell/工具完成，会绕过授权。

**修订**：最多一次同 schema 修复；失败后 `needs_input` 或 `failed`。所有 effectful DAG 必须来自已审查模板。

### 2.6 模板或 Provider 升级可能破坏恢复

**风险**：活跃 run 恢复时 capability contract 已变化，旧输入被新实现解释。

**修订**：PlanIR 冻结 spec/version、capability versions 与 hash；Provider 保留兼容版本窗口。旧版不存在时 block，不静默替换。

### 2.7 DAG 与多资源锁可能死锁或无限膨胀

**风险**：模型产生超大图、环、无限重试，或步骤以不同顺序争抢多个资源。

**修订**：节点 32、深度 8、并行 4；编译期拒绝环和非法引用；resource keys canonical 排序；所有 retry 有次数和时间上限。

### 2.8 scheduler 的授权与微信 context 不是永久成立

**风险**：定时任务拥有过期目标或失效 context，仍尝试发送并声称完成。

**修订**：scheduler grant 冻结 recipient/scope 但执行前重新检查；缺 context 进入 `waiting_external(pending_inbound)`。不把二维码连接当成 outbound ready。

### 2.9 `needs_input` 会误消费下一条无关消息

**风险**：多个 run 同时等待，或用户转而聊天，系统错误地把消息作为上一个 run 的参数。

**修订**：只有唯一待确认 run 且消息语义匹配，或用户显式引用 run，才能形成 signal；否则不消费。

### 2.10 持久日志可能泄露正文、路径和凭据

**风险**：为了可恢复直接把 context token、消息正文、笔记正文、绝对路径写入 SQLite/UI。

**修订**：journal 只存 opaque refs、hash、状态和脱敏 metadata；短期 payload 存 0600 私有 artifact 并带 TTL；UI 使用只读投影。

### 2.11 抽象过度会延误第一个可用闭环

**风险**：先实现分布式 worker、通用 DSL、MCP 总线，最终没有真实媒体/笔记场景验证。

**修订**：限定首批为进程内 Engine + SQLite + 本地 Provider；按媒体发送、笔记读取、笔记写入、scheduler 四个纵切实施。只有出现第二个真实 remote provider 时再建立对应 Adapter seam。

### 2.12 运行中审批与安装期权限配置互相矛盾

**风险**：若任务运行到一半再请求目录写入权限，用户无法在安装阶段看清模块能力，工作流状态还会混入权限配置生命周期；服务也可能在无人在场时永久等待。

**修订**：权限改为模块安装/首次启用时配置、设置页持久调整、运行期只校验。所有已列目录默认预选读取、写入关闭，保存前不授权；新增目录同样默认只读。权限不足的任务在任何相关 effect 前结束并引导到设置页，调整后必须手动重试。

### 2.13 模糊笔记检索不能让正文候选淹没标题候选

**风险**：若标题、路径和正文使用同一包含规则，标题已经明确命中的请求仍可能返回大量仅在正文提及该词的文件，迫使用户在无关候选中选择；若让 Planner 读取正文再判断，又会扩大上下文与泄露面。

**修订**：批准通用文件模块与隔离 File Resolver。Resolver 根据原始请求选择 `files.find`（文件名/相对路径）或 `files.grep`（正文 lexical search），但两个工具都由宿主绑定模块、当前已授权 scopes、扩展名、排序枚举和上限；`files.read` 仍是独立能力。模型只返回本次工具结果中的引用，宿主校验后唯一候选自动继续，多候选必须由 Input Gate 让用户选择。

## 3. 状态机审查

- `accepted` 与 `planning` 分开：通过，避免“已入库”被误解为“已规划”。
- `needs_input` 与 `waiting_external` 分开：通过。模块权限不进入运行状态机；权限不足是预检或 effect 前校验的终止结果。
- `unknown` 是 effect/step 结果，run 对应 `outcome_unknown`：通过。
- `blocked` 用于无法继续但结果已知未执行，不能替代 unknown：通过。
- 取消只影响未开始或可安全中断的步骤；不能撤销已 accepted 的外部 effect：已要求实现时写入 invariant。

## 4. 权限审查

- account、target、context token、真实 path 由可信 TriggerContext/Provider 绑定，不在模型 schema 中：通过。
- Planner 只能缩小或填充 slots，不能扩大 AuthorizationGrant：通过。
- 每个 effect 前重新检查撤销、过期和资源 scope：通过。
- 本地权限按模块、按目录分离 read/write，并在设置页持久化：通过。
- 所有已列目录默认预选 read、默认关闭 write；保存前不生效：通过。
- 允许添加目录并逐目录调整读写；嵌套目录按最具体显式设置生效：通过。
- 文件执行始终禁止，write 不包含 delete 或 execute：通过。
- 微信回复不属于模块文件权限，scheduler 目标由 schedule 配置管理：通过。
- 跨目标、批量、删除在 v1 不支持，不通过运行中审批放行：通过。
- scheduler 的授权证据与微信当前消息授权分开：通过。

## 5. 恢复与幂等审查

- trigger ID 唯一约束返回原 run：通过。
- lease 使用 CAS/expiry，不能只依赖内存 active map：通过。
- effect 在外部调用前 prepare：通过。
- 外部发送 timeout 不自动重放：通过。
- 本地 notes update 使用 expectedSha256：通过。
- capability 无法对账时允许 unknown，不伪造成功：通过。

## 6. 分阶段门禁

初始核心阶段按以下顺序开展，其中 1–5 已有实现；真实 owner 切换仍受后续补充门禁约束：

1. Engine contracts + SQLite RunStore + trigger 去重。
2. 编译器与 fixture DAG executor。
3. 模块目录权限持久化、设置页、预检与 Provider 二次校验。
4. resource locks、effect unknown/recovery。
5. 工作流运行 UI 投影。
6. 媒体真实纵切。
7. notes read、create/update 纵切。
8. scheduler Adapter。

每一纵切都需要：用户可见行为红测、最小实现、typecheck/相关测试、代码 review、测试 review。真实微信发送只在用户在场并明确操作时验证。当前下一项不是重做核心层，而是 10.5 规定的 Input Gate/SignalInbox。

## 7. 最终结论

设计已把关键复杂度收进 `WorkflowEngine`、`WorkflowCompiler` 与 `CapabilityProvider` 三个深模块，同时把模块权限固定在安装/设置阶段配置、运行期校验。它没有依赖模型必然调用某个工具，没有用运行中审批掩盖缺失授权，也没有许诺外部 exactly-once；现有可靠入站、媒体安全校验、笔记 CAS 与微信 effect ledger 均有明确复用路径。

审查结论为**通过**，但只批准按纵切逐步实施。核心持久 run 与 fixture/真实 Provider 基础已经落地；后续仍不得一次迁移全部媒体、笔记、新闻和记忆功能，下一阶段以第 10 节的门禁为准。

## 8. 可信触发输入补充审查

- **通过**：只允许固定数量、受限字符集的 opaque reference；消息正文、路径和任意 JSON 不进入 trigger 输入。
- **通过**：模板显式声明 reference 到 capability 字符串字段的绑定，模型和调用方不能借此增加 capability、effect 或资源权限。
- **通过**：首次 trigger 的 reference 集合参与去重冲突判断；重启后继续用持久 reference 编译同一计划。
- **通过**：公共投影省略 reference；Provider 前仍执行 schema 与模块权限校验。
- **边界保留**：本补充只批准 Engine seam，不批准在没有 artifact 收敛、renderer 和唯一 owner 测试时直接切换微信笔记路由。

## 9. 笔记候选文件发送补充审查（2026-08-24）

- **通过**：选择后发送原 Markdown 文件，而非把正文读取进 Codex。正文不进入模型、workflow SQLite、公共投影或文本回复。
- **已被 9.1 节取代**：原纵切通过 `notes.export_file` 收敛 note handle；生产模板现已改为由通用 `files.find/files.grep` 直接生成短期 file handle，仍由 `weixin.send_file` 在 effect 前复核授权和文件安全。
- **通过**：文件发送复用现有 iLink 通用媒体上传、`file_item` 和稳定 operation ledger；accepted 仅表示渠道接受，超时保持 unknown 且不自动重放。
- **通过**：待选候选按账户与目标隔离并持久化 24 小时；多批待选时要求显式搜索引用，裸序号不得猜测。
- **回归门**：普通聊天继续旁路；同一入站只允许一个 owner；权限撤销、句柄过期、文件移动/符号链接、超限和 target/context 缺失均须在真实发送前失败。

审查结论：原纵切已验证发送边界，但查询能力应迁移到通用 `files.*`；本地授权和外部发送语义仍由两个独立深模块集中，不把跨模块安全校验散落到微信路由调用者。

## 9.1 通用文件查询能力补充审查（2026-08-25）

- **通过**：`find`、`grep`、`read` 是三个独立契约；grep 只返回候选与安全命中元数据，不能返回完整正文或偷偷创建 read 结果。
- **通过**：`files.locate` 仅是 durable template 的确定性组合，保证 name/path 有结果时不执行正文 grep；不是第四种搜索语义。
- **通过**：原文件发送直接使用搜索产生的 opaque file handle，不调用 read。内容问答与更新必须显式出现 read step。
- **通过**：通用 Provider 不拥有目录；目录所有权仍属于 module permission registry。模板中的 moduleId 必须是 literal trusted input，不能由 Planner、Signal 或依赖输出绑定。
- **通过**：执行用户文件仍不在 catalog；固定 lexical 搜索实现不能通过 shell 拼接用户输入。
- **已验证**：候选/文件上限返回 `truncated`；符号链接目录、隐藏/控制字符条目、越权目录、二进制与超限文本会 fail closed 或跳过，并保持稳定排序。
- **已验证**：兼容期旧 `notes.*` 只用于恢复旧冻结计划；新 `files.*` 由同一个自然请求 owner 提交，owner/router 集成测试证明一条入站只产生一个 Run。

## 10. 混合 Agent 与补参协议补充审查（2026-08-25）

### 10.1 研究结论与本项目匹配度

OpenAI Agents 的常规 tool loop、LangGraph/Temporal/Microsoft 的持久执行，以及 OpenAI/LangGraph/Microsoft/Bedrock 的人工补参实践共同支持分层方案：开放式聊天不需要全部进入 durable DAG；跨重启、等待输入和真实副作用才需要 checkpoint 与确定性宿主执行。当前方案与该主流分层一致，同时因为涉及个人文件和微信外发，保留更严格的 reviewed template、permission recheck、effect ledger 和 unknown/no-replay。

依据：[`mainstream-patterns.md`](/Users/loong_zhou/research/agent-workflow-architecture/mainstream-patterns.md)。

### 10.2 Planner 与 Gateway 边界

- **通过**：Planner 使用短上下文和固定 output schema，无工具、web、workspace 或真实标识；它只产生不可信 proposal。
- **通过**：Gateway 是 intent 到 reviewed template 的唯一 mapper；显式命令可跳过 Planner，但不能绕过 Gateway。
- **通过**：可选 `assistant_workflow` 工具调用同一 Gateway，只是普通聊天中途升级入口，不是可靠路由的唯一根。
- **新增门禁**：候选过滤命中 workflow owner 后即锁定当前入站的回复所有权；Planner 返回 `ordinary_chat`、仍非法或后续启动失败时，只能澄清或安全失败，不能回退普通 Codex 自由执行。Gateway 接管后普通 Codex 同样不能再产生第二份最终回复。
- **新增门禁**：Gateway protocol、intent catalog、template 和 capability 分别版本化；只有模型可见 envelope 的不兼容变化才要求刷新工具契约。

### 10.3 Input Gate 不能塞进 Provider

若 Provider 返回 `needs_input` 并自行组织追问，它会同时拥有能力执行、聊天关联和恢复语义，接口变浅且难以跨模块复用。修订后 Input Gate 是 `WorkflowStepSpec` 的控制步骤，Provider 仍只执行 capability。

- 唯一候选自动完成 gate；多个候选持久化 signal request 与脱敏 artifact。
- signal 必须校验账户、目标、run、稳定 signal ID、schema、expiry、候选 revision 和模板版本。
- 合法 signal 原子完成 gate 并恢复同一冻结 Run，不重新搜索、不创建第二个 Run。
- 同一账户与目标只保留最新等待 Run；完整新目标 supersede 旧 Run，普通聊天不消费，歧义保留当前请求，重复 signal 返回原 receipt。
- `needs_input` 状态枚举已经存在不等于机制已完成，以上条件缺一不可。

### 10.4 Checkpoint 与副作用恢复

发现一项必须前置的不变量：步骤 `succeeded` 与下游恢复需要的 output handle 必须同事务提交。若先成功后存输出，崩溃会留下无法解释的假 checkpoint。若外部 effect 已 accepted 而输出不可恢复，只能 `blocked(workflow_recovery_output_unavailable)`；禁止为了补输出重放 effect。

### 10.5 单一 owner 与迁移顺序

每个 intent 使用 `legacy|shadow|workflow` 显式 owner：shadow 只比较计划，绝不执行副作用；workflow 生效前必须关闭旧 owner。依赖顺序应为：Input Gate/SignalInbox → Planner/Gateway → 笔记一消息闭环 → 笔记 owner 切换 → 媒体 owner 切换 → 可选 gateway tool → 写入与真实 scheduler。先增加 tool、后补 input gate 或 owner 切换会重现当前两轮对话和工具不可见问题，因此不批准。

### 10.6 补充审查结论

**修改后通过。** 方案现在把语义理解、可信意图映射、持久控制流和能力执行分成清晰深模块，并补齐了 `needs_input` 的协议含义。2026-08-26 已完成 Engine 内 Input Gate/SignalInbox、Planner/Gateway、微信 Trigger Adapter 核心，以及 `notes.send-file@1`、`media.send-image@1` 的生产 owner 切换。切换测试证明：自然请求命中候选后只由 workflow 宿主产生回复；已有笔记引用选择优先兼容 legacy；只有从未命中候选的普通消息才可进入既有路径；候选命中后的 Planner 降级、解析失败或启动失败均不会重放旧路径。仍需用户在场确认真实手机图片；不得把渠道 accepted 表述为手机已收到。

## 11. App Server 协议兼容与隔离恢复补充审查（2026-08-27）

- **通过**：模型隔离回合已迁移到当前命名权限 profile；wire 测试断言不再发送废弃字段。
- **通过**：启动门禁检查实际安装版 schema 的 structured output 与 permission-profile list 协议。审查时发现仅检查 `TurnStartParams.permissions.type` 会对当前生成 schema 产生假阴性，已补红绿测试并改为识别完整生成协议面。
- **通过**：timeout/初始化/thread/turn 协议错误关闭 transport，`CodexConversation.close()` 清空 transport、订阅、活动回合和 thread 集合；后续调用重新创建并 initialize。模型业务输出非法不触发 transport 重启。
- **通过**：真实协议测试拆分 Planner 与 Router，各自使用独立 transport 和临时 cwd；浏览器真实 Planner/Router 纵切另行验证多选与取消，fixture 结果不再替代协议兼容性证据。
- **审查修正**：移除了 `PendingResponseRouterAgent.close` 的重复声明；默认跳过的真实协议用例有显式脚本，最终回归必须单独执行并报告，不能把 skipped 计为通过。

### 10.7 图片来源与单 owner 审查（2026-08-25）

- **通过**：来源优先级由可信宿主冻结，模型不提供绝对路径、账户、目标或 media handle；引用、当前、近期与本地目录不会混排。
- **通过**：近期图片严格绑定同账户与目标，并限制十分钟、最多五张；“刚才/上一张/最近”之外的模糊请求不会静默使用历史图片。
- **通过**：引用或当前来源存在但失效时不跨源回退，本地目录零候选也不借用近期图片；这避免发送一张“碰巧可用”的错误图片。
- **通过**：所有来源统一收敛为 opaque media artifact，再经过 Engine Input Gate 与 `weixin.send_image` effect；多候选恢复同一 Run，accepted/unknown 继续沿用现有渠道语义。
- **通过**：workflow owner 命中后旧媒体动态工具不得处理当前入站；视频等未迁移能力可以继续保留旧工具，但不能成为图片失败后的 fallback。
- **实现门禁**：自动化必须从 fixture 微信入口覆盖四种来源、无来源澄清、多候选选择、无权限、句柄失效、跨目标隔离、重启恢复、unknown 不重发及单 owner；真实图片发送仍需用户在场确认手机收到。
