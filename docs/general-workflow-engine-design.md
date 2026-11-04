# 通用工作流引擎设计

> 历史设计记录：本文的状态、迁移待办与工具名称描述的是当时方案，不代表当前实现。现行要求以 [微信工作流规格](specs/workflow-runs.md)、[模块权限规格](specs/workflow-module-permissions.md) 及 ADR-0008/0009 为准；独立 Resolver、Query Rewriter 和 files.locate 查询编排不再适用于新请求。

> 架构更新（2026-09-01）：ADR-0005 与 ADR-0006 已废弃本文中“宿主候选路由 → 独立 Intent Planner”以及模型可见万能 gateway 的新意图路径。现行完整迁移方案见 [主微信模型驱动的领域工作流工具设计](model-directed-workflow-tools-design.md)。本文关于 Intent Planner、CandidateFilter、shadow Planner、`assistant_workflow` 和旧 owner 迁移的段落仅保留为历史实现记录，不再作为后续实现依据；持久化 Engine、Input Gate、权限、Provider 与 effect ledger 的约束继续有效。

状态：核心执行层已实现；新意图路由已由 ADR-0005 改为主微信 Codex 工具选择，代码迁移与旧路径下线待实施
日期：2026-08-25
适用项目：`codex-weixin-assistant`

## 1. 背景与目标

当前项目已经具备真实微信入站、Codex 对话、媒体查找/发送、Obsidian Markdown 读写、定时任务、持久入站队列与出站 effect ledger。这些能力目前分散在不同路径中：有些由宿主直接调度，有些作为 Dynamic Tools 暴露给 Codex，有些拥有自己的调度和恢复逻辑。

本设计新增一个通用但受约束的工作流引擎。它首先承载媒体与笔记类副作用工作流，之后可以扩展到更多个人助理能力。普通聊天仍直接进入 Codex；现有成熟的新闻与 Memory Curator 路径第一阶段不迁移。

设计目标：

- 把“理解用户要做什么”和“实际执行副作用”分开。
- 让微信消息与定时触发共用同一套计划、权限、持久化和恢复语义。
- 让媒体、笔记及未来能力通过稳定、可替换的 Capability Provider 接入。
- 支持有界 DAG，而不是只支持固定线性脚本。
- 对外部发送、文件修改等真实副作用做到可审计、可恢复且不夸大 exactly-once。
- 在面板中完整呈现每次运行，而不暴露 token、正文或完整敏感路径。

## 2. 已确认的产品决策

1. **范围**：副作用工作流优先。普通问答不经过工作流引擎；新闻与记忆暂不迁移。
2. **持久化**：采用完整 SQLite journal，而不是内存队列或只存最终状态。
3. **能力边界**：使用进程内 `CapabilityProvider` seam；只有出现真实 MCP/HTTP 后端时才新增 Adapter。
4. **权限策略**：模块安装或首次启用时配置本地资源权限，之后只在“本地权限”设置页调整。按模块、按目录授权，写入包含读取而只读不能写入；运行过程中只校验，不临时申请权限。
5. **可见性**：新增“工作流运行”Tab，展示运行、步骤、等待、失败、重试和未知结果。
6. **规划权**：受约束混合模式。模型只提取结构化意图和 slots；宿主从已审查模板编译副作用计划。仅只读能力允许有限动态规划。
7. **执行形态**：有界 DAG。
8. **模板形式**：TypeScript 类型化 `WorkflowSpec`，启动时编译与校验；不引入 JSON DSL 或可视化编辑器。
9. **触发源**：微信与 scheduler 同时作为一等触发源。
10. **迁移方式**：strangler vertical slices；每次迁移一个完整用户场景，并关闭该场景的旧副作用路径，避免重复执行。
11. **渠道边界**：微信回复不是模块文件权限；当前回复依赖渠道上下文，定时推送目标由 schedule 配置。

## 3. 当前代码事实与复用边界

### 3.1 可复用能力

- 当前 `DynamicToolHost` 只有 `definitions()` 与 `execute()`，适合模型直接调用工具，但没有工作流计划、授权快照、持久状态或恢复语义（`apps/weixin-service/src/dynamic-tool-host.ts:1-16`）。
- `CodexConversation` 只在 `thread/start` 注入 Dynamic Tools；保存的 thread 通过 `thread/resume` 恢复时没有工具刷新参数（`apps/weixin-service/src/codex-conversation.ts:123-159`）。工具调用由 `item/tool/call` 转发给宿主（同文件 `520-539`）。因此底层工具目录不应成为会话协议的长期稳定面。
- 媒体模块已经实现明确发送意图检查、按 thread 绑定可信账户/目标、短期媒体句柄、根目录和符号链接校验，以及微信回传（`apps/weixin-service/src/weixin-media-tool-host.ts:16-101`）。这些安全规则应复用到媒体 Provider，而不是重写。
- Obsidian 模块已有 search/read/create/update 契约，其中 update 使用 `expectedSha256`（`apps/weixin-service/src/vault-dynamic-tool-host.ts:47-97`）；底层 `DirectMarkdownVault` 使用 no-follow、大小限制、CAS 与临时文件原子替换（`apps/weixin-service/src/direct-markdown-vault.ts:109-185`）。
- `DurableEffectLedger` 已使用 SQLite WAL、`synchronous=FULL` 和 `prepared|accepted|rejected|unknown` 状态，但 effect kind 目前是微信专用（`apps/weixin-service/src/durable-effect-ledger.ts:10-17,64-92`）。
- `DurableInboundStore` 已持久化 event key、账户、目标、cursor/context 与 lease 状态，并保持按账户和目标索引的队列（`apps/weixin-service/src/durable-inbound-store.ts:13-61,87-134`）。新引擎不替换它。
- 当前服务在进入 Codex 前按 thread 绑定媒体权限与当前 inbound event（`apps/weixin-service/src/weixin-codex-service.ts:644-686`）。迁移后相同可信上下文由 Workflow Trigger Adapter 绑定。

### 3.2 模块边界

新引擎是一个深 `WorkflowEngine` Module。微信服务、scheduler 和 UI 只依赖它的小 Interface；调用方不理解 planner、DAG、lease、effect reconciliation 或 Provider 细节。

```ts
interface WorkflowEngine {
  submit(trigger: TriggerEnvelope): Promise<WorkflowSubmission>;
  signal(signal: WorkflowSignal): Promise<WorkflowSignalReceipt>;
  get(runId: string): WorkflowRunView | undefined;
  list(query: WorkflowRunQuery): WorkflowRunSummary[];
  start(): Promise<void>;
  close(): Promise<void>;
}
```

`submit` 只承诺触发已被去重并持久接受，不承诺计划已完成或副作用已送达。`signal` 用于补充歧义参数或提交外部对账结果，不允许调用方直接修改 run/step 状态，也不用于升级模块权限。

## 4. 总体架构

```text
微信 DurableInboundStore
  ├─ 普通聊天 ────────────────────────────────> Codex tool loop
  └─ 候选副作用 ─ CandidateFilter ─> WorkflowIntentPlanner ─> WorkflowGateway
Scheduler occurrence ────────────────────────────────────────────────┘
显式宿主命令 ────────────────────────────────────────────────────────┘
可选 assistant_workflow tool ───────────────────────────────────────┘
                                                                    │
                                                                    v
                                                            WorkflowEngine
                                                              ├─ TemplateRegistry
                                                              ├─ WorkflowCompiler
                                                              ├─ InputGate / SignalInbox
                                                              ├─ AuthorizationPolicy
                                                              ├─ DurableRunStore
                                                              ├─ DagExecutor / LeaseManager
                                                              └─ CapabilityRegistry
                                                                   ├─ MediaProvider
                                                                   ├─ WeixinOutboundProvider
                                                                   ├─ NotesProvider
                                                                   └─ future MCP/HTTP Adapter
```

这是一个混合 Agent 架构，而不是把所有聊天都编译成工作流：普通、低风险且无副作用的对话继续使用 Codex tool loop；需要跨重启恢复、人工补参或产生文件/渠道副作用的请求，才进入持久工作流。模型负责把自然语言理解成受约束 proposal，宿主负责选择已审查模板、绑定可信上下文并确定性执行。

`WorkflowGateway` 是意图层的唯一深入口，不是底层能力目录。宿主候选路由、scheduler、显式命令和可选的 `assistant_workflow` 工具都调用同一个 Gateway；它们不能自行拼 DAG 或直接调用 Provider。显式、已经结构化的宿主命令可跳过 Planner，但不能跳过 Gateway、模板校验、授权或 Engine。

### 4.1 触发信封

```ts
type TriggerEnvelope = {
  triggerId: string;
  source: "weixin" | "scheduler" | "fixture";
  occurredAt: number;
  accountRef?: OpaqueRef;
  targetRef?: OpaqueRef;
  text?: string;
  attachments?: ArtifactHandle[];
  scheduleRef?: OpaqueRef;
  requestedWorkflowId?: string;
  authorizationEvidence: AuthorizationEvidence;
};
```

- 微信 `triggerId` 使用 DurableInboundStore 的稳定 event key。
- scheduler 使用稳定 occurrence ID，例如 `schedule-id + local-date + occurrence`。
- 重复 `submit` 必须返回同一个 `runId`。
- `accountRef`、`targetRef` 是宿主内的 opaque reference；不会写入模型 prompt，也不会由模型生成。

## 5. 识别与规划

### 5.1 两级路由

1. **确定性候选过滤**：识别明显的媒体/笔记动作与对象，只决定“是否可能进入工作流”，不决定要调用哪个底层工具。
2. **结构化 Planner**：只接收当前消息、本地日期/时区、候选 intent 摘要和必要的脱敏上下文，输出受 schema 约束的 `IntentProposal`。

```ts
type IntentProposal = {
  disposition: "ordinary_chat" | "workflow" | "needs_clarification";
  intent?: string;
  intentVersion?: number;
  confidence: number;
  slots: Record<string, JsonValue>;
  missingSlots: string[];
};
```

Planner 使用独立的短上下文 runtime、固定 output schema，并禁用工具、web、workspace 和长会话历史。它只解释语义，不执行能力，也看不到 account、target、context token、绝对路径、capability ID、模板 ID、DAG 或 effect reference。输出始终是不可信数据；宿主必须做 schema、intent catalog、slot 类型、长度和枚举校验。

App Server 的严格 wire schema 不直接使用开放 object 承载 slots，而使用 `slotEntries[{key,valueJson}]`：每层 object 都关闭额外字段，可选 intent/version 以 required nullable 字段表示。宿主先拒绝非法/重复 key 并解析 valueJson，再重建上述领域 `IntentProposal.slots`；Gateway 与 registration-owned slot schema 不感知这个传输细节。

普通聊天绕过引擎。确定性候选过滤一旦命中已由 workflow owner 接管的 intent，宿主便锁定当前入站的最终回复所有权；即使 Planner 首次合法返回 `ordinary_chat`，也只能由宿主返回自然澄清，不创建 Run，不能回退普通 Codex 或旧发送路径。命中候选后若 Planner 不能满足 schema，只允许一次使用同一 schema 的修复；修复请求必须携带冻结的原始 Planner 输入与首次非法输出，不能让修复轮脱离语义上下文重新猜测。首次非法输出若仍能确定地识别出本次候选 workflow intent，修复轮只允许保留同一 intent 并返回 `workflow` 或 `needs_clarification`，不能静默降级为 `ordinary_chat` 或切换 intent；仍失败则返回安全失败或请求用户重述。Planner 不能产生用户可见回复；一旦候选过滤锁定或 Gateway 接管当前入站，普通 Codex 的自由文本结果不能再作为该入站的最终回复。只有从未命中任何工作流候选的普通消息才能继续既有 Codex 对话。

文件发送候选采用高召回但互斥的宿主过滤：明确的“笔记/Obsidian/Vault/Markdown/文件/文档”与“发送/发给/回传”组合进入文件 Planner 候选；含图片、照片、视频、音频或语音的请求排除，由媒体路由继续处理。宿主只决定是否提供 intent，不提取路径或选择文件。

### 5.2 WorkflowGateway 与 IntentRegistry

```ts
interface WorkflowGateway {
  submit(input: WorkflowGatewayInput): Promise<WorkflowSubmission>;
}

type WorkflowGatewayInput = {
  trigger: TriggerEnvelope;
  proposal: IntentProposal | StructuredIntentCommand;
  protocolVersion: number;
};
```

Gateway 用 `(intent, intentVersion)` 从 `IntentRegistry` 选择一个已审查模板，并把 Trigger Adapter 提供的可信账户、目标、授权证据和 opaque references 绑定到模板允许的槽位。它拒绝未知 intent、越权字段、缺少必填槽位、effect 数量超预算或 owner 不唯一的请求。`protocolVersion` 只描述稳定 Gateway envelope；intent catalog revision、模板版本和 capability version 分别演进，避免内部能力升级迫使现有 Codex thread 重建。

同一 intent 在切换 owner 时必须是显式配置：`legacy | shadow | workflow`。`shadow` 只能规划和比较，不能执行副作用；`workflow` 接管后旧路径必须在产生 effect 前关闭。任何时刻一个 trigger 只能有一个最终回复 owner 和一个副作用 owner。

### 5.3 工作流模板

```ts
type WorkflowSpec<I, O> = {
  id: string;
  version: number;
  intents: string[];
  inputSchema: JsonSchema;
  risk: RiskTier;
  authorization: AuthorizationRequirement;
  effectBudget: EffectBudget;
  maxSteps: number;
  maxDepth: number;
  maxParallelism: number;
  steps: WorkflowStepSpec[];
  result: ResultProjection<O>;
};

type WorkflowStepSpec = CapabilityStepSpec | InputGateStepSpec;

type CapabilityStepSpec = {
  kind: "capability";
  id: string;
  capability: CapabilityId;
  capabilityVersion: number;
  dependsOn?: string[];
  when?: SafeCondition;
  input: InputBinding;
  output: OutputBinding;
  resourceKeys: ResourceKeyBinding[];
  timeoutMs: number;
  retry: RetryPolicy;
  unknownOutcome: UnknownOutcomePolicy;
};

type InputGateStepSpec = {
  kind: "input_gate";
  id: string;
  dependsOn: string[];
  candidates: InputBinding;
  selectionSchema: JsonSchema;
  autoSelect: "unique_only";
  expiresInMs: number;
  output: OutputBinding;
};
```

模板由 TypeScript builder 定义，但在启动时编译为不可变 `PlanIR`。编译器必须校验：

- 节点数不超过 32、深度不超过 8、并行度不超过 4。
- 无环；依赖、条件和引用的 output 均存在且类型兼容。
- 每个 capability/version 在 registry 中可用。
- 所有 effect 都被风险策略、授权范围和 effect budget 覆盖。
- 有副作用的步骤不能位于无法确定重放安全性的自动循环中。
- resource keys 可在运行前确定或由受信任的前置步骤产生。

首版 binding 采用两个受限结构，而不是开放表达式：

- `inputBindings[target] = { dependency, path }` 只把已列依赖 output schema 中的路径写入下游 input 的顶层字段。编译器验证 source/target schema 的保守兼容性，运行时解析实际值后再次验证完整 input；缺值、类型漂移或静态输入覆盖同一 target 都 fail closed。
- capability descriptor 可用 `resourceKeyOutputs[name] = { path }` 声明某个字符串 output 是受信任资源键导出；下游 `resourceKeyBindings` 只能引用该名称。运行时解析后的键须满足 bounded identifier，和静态键合并、去重、排序并写入步骤记录后，才能调用 Provider。

绑定声明进入冻结 `PlanIR` 与 plan hash。前置输出本身不进入 plan hash；它只在依赖成功后解析并留在对应步骤的运行态资源键投影中。首版仍保留 `dependencyResults` 供 Provider 读取完整依赖结果，但权限与资源判断只能使用已编译的 `input` 和 `resourceKeys`，不能从任意依赖对象自行扩大范围。

`PlanIR` 冻结 `specId/specVersion`、capability contract versions、plan hash、授权快照和 effect budget。正在运行的计划不随模板升级改变。

### 5.4 Input Gate 与补参协议

对象搜索和用户选择属于 Engine 的控制流，不属于 Capability Provider。Provider 只执行能力并返回结构化结果，不负责发问、读取下一条微信消息或持有对话状态。

- 候选唯一时，Input Gate 自动产生选择结果，Run 不进入 `needs_input`。
- 候选为空时，按模板决定安全结束或请求补充搜索条件；不能让模型虚构对象。
- 候选多个时，引擎复用可信前置步骤已原子持久化的候选输出作为冻结快照，并持久化 candidate hash、`signalRef`、selection schema、revision、expiry、来源绑定与 continuation，Run/step 进入等待输入。
- 同一账户与目标最多保留一个等待请求。Trigger Adapter 只在消息显式引用当前 `signalRef`，或当前文本可唯一映射到该请求时，才转换成 `WorkflowSignal`；完整新目标先 supersede 旧请求，语义歧义则保留旧请求并澄清。
- Turn Router 只解释首次脱敏投影里的选择语义；可信 Workflow Response Bridge 随后重新读取当前请求，并以稳定资源身份重绑定所选候选。对象字段顺序、临时 handle、expiry 和检索排名等表示变化不影响身份或语义比较。
- 明确单选或子集选择只要所选资源仍存在且可执行语义内容未变，就使用当前 revision 和当前候选值继续；未选候选的增删不会阻断。覆盖首次完整集合的“都要”在集合增删时必须重新确认，不能把旧全选静默解释成新集合。
- 所选资源消失或内容改变、请求过期、结束或被替换时不提交 Signal。Bridge 返回封闭的结构化变化事实和最新安全标签，Trigger Adapter 生成可操作的自然语言提示；用户不会看到 stale、revision、hash 或内部标识。
- `signal` 校验稳定 signal ID、账户、目标、run、schema、expiry、候选 revision 和模板版本；同一 signal 重复提交返回原 receipt。
- 合法 signal 与 gate 完成、选择输出持久化、Run 恢复必须在一个事务中完成。恢复同一冻结计划，不重跑已经成功的搜索，也不创建第二个 Run。
- 普通聊天不消费 signal；已 superseded 的请求不能被迟到消息恢复；过期候选、失效 artifact 或不可用模板使原 Run `blocked`，要求重新发起。

这套协议也作为未来人工确认、表单输入和外部回执的统一基础，但 v1 只实现候选选择。模块文件权限不通过 signal 获取，仍只在安装/设置页配置。

### 5.5 有限只读动态规划

只有 `effect=read` 且显式标记 `dynamicPlanAllowed` 的能力可由 Planner 组成临时 DAG。临时 DAG 同样通过编译器的节点、深度、类型、超时与资源限制。任何 write/send/destructive 节点都必须来自已审查模板。

## 6. Capability Registry

```ts
interface CapabilityProvider {
  catalog(): CapabilityDescriptor[];
  invoke(request: CapabilityInvocation): Promise<CapabilityOutcome>;
  reconcile?(effectRef: string): Promise<ReconcileOutcome>;
}

type CapabilityDescriptor = {
  id: CapabilityId;
  version: number;
  effect: "read" | "write" | "external_send" | "destructive";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  defaultTimeoutMs: number;
  retryClass: "pure" | "idempotent" | "non_idempotent";
};
```

初始能力：

- `files.find.v1`
- `files.grep.v1`
- `files.read.v1`
- `files.locate.v1`
- `media.find_images.v1`
- `media.resolve_images.v1`
- `weixin.send_image.v1`
- `weixin.send_file.v1`
- `notes.search.v1`
- `notes.read.v1`
- `notes.export_file.v1`
- `notes.create.v1`
- `notes.update.v1`

`notes.search/read/export_file` 仅为已有冻结运行的兼容能力；新文件查询模板使用 `files.*`。

Provider 内部复用现有 `MediaExportLibrary`、微信媒体发送闭包、`DirectMarkdownVault` 等模块。模型与 `WorkflowSpec` 都不持有真实绝对路径、account ID、target ID、context token 或发送闭包；它们只交换短期 typed handles。Provider 在 invoke 时从受信任的 `RunContext` 解析句柄并重新验证当前权限。

Registry 在启动时拒绝重复 capability ID/version、不兼容 schema、缺失风险分类和非法 retry class。未来 MCP/HTTP 连接只需实现 Adapter，不改变 WorkflowEngine Interface。

首版内置 validator 只接受工作流需要的有界 JSON Schema 子集：`type`、标量 `enum`、对象 `required/properties/additionalProperties` 与数组 `items`。schema 必须自洽，输入输出还必须是可稳定序列化的 JSON 数据；不支持的 JSON Schema 关键字不能静默假装生效。后续若切换完整 validator，Capability Registry Interface 保持不变。

## 7. 权限模型

权限属于模块配置，不属于一次对话或一次运行。模块安装或首次启用时展示其资源目录；所有已列目录默认预选读取、默认不选写入，但保存前不产生授权。用户可通过系统目录选择器增加目录，并在设置页逐目录调整读取与写入。

- `read`：允许在目录范围内列出、搜索和读取。
- `write`：允许在目录范围内新建和修改；包含读取，不包含删除或执行。
- `execute`：用户文件、脚本和二进制始终禁止，权限模型不提供开启入口。
- 微信回复和定时推送不属于模块文件权限。回复由当前渠道上下文约束；定时推送目标由 schedule 配置约束。
- 运行前做权限预检，每个 effect 执行前再次校验。权限不足时不执行任何相关文件 effect，任务以权限不足结束并引导用户前往设置页；设置变更后由用户手动重试，不自动恢复旧任务。

同一模块内目录 scope 使用规范化路径标识。重复目录合并为一条；父子目录同时存在时，以最具体目录的显式读写设置为准。符号链接和实际路径必须在 Provider 执行时重新校验，不能借链接越出授权目录。

首版实现把模块 grant 存在权限为 `0600`、父目录为 `0700` 的独立 SQLite 中；工作流计划只保存 `moduleId/revision/scopeId/read/write`，不保存目录绝对路径。安装草稿由推荐目录生成 `read=true/write=false`，只有带当前 revision 且用户确认的 `save` 才产生新授权 revision。相同 canonical directory 且权限一致的重复行合并；同路径权限冲突拒绝保存，避免由数组顺序隐式扩大权限。

需要本地文件权限的 capability descriptor 声明 `modulePermission={moduleId, access, scopeInput}`；`scopeInput` 必须是 required string。静态 scope 在 plan 编译期精确预检；由前置步骤绑定的动态 scope 在 effect 前解析。计划冻结当时的 scope 权限，执行前还要检查当前 grant：撤销会阻断，后来新增的 scope 也不能推进旧运行。权限不足时 Run 进入 `blocked(workflow_module_permission_denied)`，旧 Run 不自动恢复。

引擎的 scope 检查不是文件安全检查的替代品。Provider 仍须把真实 absolute path 交给私有 permission store 选择最具体目录并 realpath 校验，再使用既有 no-follow/CAS/原子写机制打开文件。`write` 不隐含 `read`；类型、表结构和设置输入均不存在 `execute` 位，运行时收到伪造 execute 值也必须拒绝。

### 7.1 冻结授权

```ts
type AuthorizationSnapshot = {
  permissionRevision: number;
  allowedCapabilities: string[];
  resourceScopes: OpaqueScope[];
  maxEffects: number;
  evidenceHash: string;
};
```

计划保存授权 revision 与 scope 快照，但每个 effect 执行前仍检查当前 grant 是否被撤销、资源是否仍在 scope 内。Planner 不能增加 capability、目录、目标或 effect 数量。运行中新增权限不会自动推进已因权限不足结束的任务。

## 8. 状态机

### 8.1 Run 状态

```text
accepted -> planning -> ready -> running -> succeeded
                              \-> needs_input --signal--> running
running -> waiting_external --signal/reconcile--> running
running -> failed | blocked | outcome_unknown | cancelled
```

`needs_input` 恢复后继续同一冻结 PlanIR，而不是重新自然语言规划。终态：`succeeded|failed|blocked|outcome_unknown|cancelled`。`accepted` 只表示 SQLite 已接收；`succeeded` 只表示所有要求步骤达到其成功合同。微信 provider 返回 accepted 仍不等于手机实际收到。

### 8.2 Step 状态

```text
pending -> ready -> leased -> running -> succeeded
                                  \-> failed | rejected | unknown
input_gate: pending -> ready -> waiting_input -> succeeded | blocked
pending/ready -> skipped | cancelled
```

所有转换由 `DurableRunStore.transition(expectedRevision, event)` 以 CAS 完成，禁止业务代码直接 update 投影状态。

## 9. SQLite 持久化

建议独立数据库 `workflow.sqlite`，使用 WAL、`synchronous=FULL`、busy timeout、foreign keys，目录 0700、文件 0600。

核心表：

- `workflow_run`：当前投影、trigger key、spec/version、plan hash、revision。
- `workflow_plan`：冻结且已脱敏的 PlanIR。
- `workflow_step`：步骤投影、attempt、lease、输出 handle。
- `workflow_transition`：append-only 状态事件。
- `workflow_signal`：澄清和 reconciliation 输入，按 signal ID 去重。
- `workflow_signal_request`：等待输入的 schema、来源绑定、expiry、候选 artifact revision 与 continuation。
- `workflow_effect`：prepare/accepted/rejected/unknown 及 provider reference。
- `workflow_artifact`：opaque handle、类型、hash、TTL 与最小展示 metadata。

不持久化 context token、完整微信正文、完整笔记正文、媒体 bytes 或完整绝对路径。必须跨重启保留的 payload 存在权限为 0600 的私有 artifact 目录，SQLite 只保存 opaque handle、hash 和到期时间。

现有 DurableInboundStore 与 DurableEffectLedger 第一阶段不迁移表结构：Trigger Adapter 读取前者；微信 Provider 继续通过后者记录真实渠道副作用，同时 `workflow_effect` 保存对应 operation/attempt reference。后续确认语义稳定后再考虑统一物理表。

## 10. 执行、并发与恢复

### 10.1 Lease 与资源锁

- step 通过 owner、leaseUntil、revision 领取；续租与完成均 CAS。
- 同一微信 `(account,target)` 继续 FIFO，resource key 为 opaque `weixin-target:<hash>`。
- 笔记写入锁使用 `vault:<grant>:<relative-path-hash>`。
- 一次 DAG 获取多个 key 时按 canonical 字典序获取，避免死锁。
- 不同目标/资源可在全局并行度 4 内并发。

### 10.2 Retry 与 unknown

- 纯 read：指数退避、有界重试。
- 可证明幂等的本地步骤：使用稳定 operation ID 后有界重试。
- CAS 写冲突：不覆盖；重新读后进入 `needs_input` 或重新规划。
- 外部发送 timeout/连接断开：记录 `unknown`，不自动重发。
- effect 已 `prepared` 但崩溃：先调用 Provider `reconcile`；没有可靠对账能力则进入 `outcome_unknown`。
- capability version 已不可用：进入 `blocked(capability_version_unavailable)`，不得偷偷换到新版本。

首版模板未声明 retry 时规范化为单次尝试；显式 retry 的最坏耗时预算必须覆盖全部 attempt timeout 与指数退避。只有 `retryClass=pure` 可以超过一次尝试；attempt 数进入运行投影，逐次错误历史随 effect ledger 阶段补齐。

首版实现中，所有经过审查模板产生的非 read step 都先生成稳定的 `effectRef/operationId`，再调用 Provider。通用 `workflow_effect` 只记录 run/step/capability reference、状态和脱敏错误码；微信 Provider 接入后仍须用现有 `DurableEffectLedger` 记录真实渠道 attempt，不能把通用投影当作渠道事实来源。Provider 明确失败记为 `rejected`；timeout、连接断开、显式 unknown 或调用异常记为 `unknown`。服务重开只对 `prepared|unknown` 调用同版本 Provider 的 `reconcile(effectRef)`，没有对账能力时保持 `outcome_unknown`，绝不重新调用 `invoke`。

若对账确认 effect 已 accepted，但后继步骤依赖的输出并没有可恢复 artifact，Run 进入 `blocked(workflow_recovery_output_unavailable)`；它不能凭空补造输出，也不能重新执行已 accepted 的 effect。后续真实 Provider 必须把跨重启所需输出收敛为短期 typed artifact handle，才允许从该边界继续 DAG。

步骤成功状态和所有下游恢复所需的输出 handle 必须在同一 SQLite 事务中提交。不能先把步骤标记为 `succeeded` 再异步保存 artifact；否则崩溃后会出现“步骤成功但无法继续”的假 checkpoint。外部 effect 已被渠道接受但输出无法恢复时只能进入 `blocked(workflow_recovery_output_unavailable)`，不能重放 effect 补输出。

非 read step 在调用 Provider 前领取其全部 opaque resource keys。键先去重并按 canonical 字典序排列，再在一个 SQLite `BEGIN IMMEDIATE` 事务内整体领取；同键 effect 因此串行，不同键仍可并行。资源租约仅协调 effect 执行，不替代笔记 expected hash、文件 no-follow 或微信渠道 ledger。纯 read step 不获取排他资源锁。

## 11. 触发源行为

### 11.1 微信

Weixin Adapter 在 durable inbound 被领取后提交 run。明确工作流候选由引擎接管；未命中则继续普通 Codex。接管规则必须是互斥的：一个 inbound event 只能由工作流或旧路径产生副作用，不能两者都执行。

若 run 进入 `needs_input`，下一条微信消息只有在能够唯一关联目标 run，或用户显式引用该 run 时才作为 signal；否则创建新 run/普通聊天，避免抢走无关消息。

### 11.2 Scheduler

Scheduler 直接提交 `requestedWorkflowId` 与配置好的 slots，不需要自然语言分类。每个 schedule occurrence 有稳定 idempotency key。

计划向微信发送时仍需：

- 已确认的 schedule 目标配置；
- 当前账户和目标存在有效 outbound context；
- 发送结果使用 `accepted/rejected/unknown`，不能把 accepted 说成手机已收到。

缺少 context 时进入 `waiting_external(pending_inbound)`，而不是盲目发送或假称成功。

## 12. 面板设计

新增“工作流运行”Tab，默认展示：

- run 时间、触发源、模板名/version、当前状态、总耗时；
- DAG/时间线、并行关系、每步耗时、attempt 与重试原因；
- 当前等待：缺参数、外部 context、reconciliation；
- effect 状态：prepared、accepted、rejected、unknown；
- 脱敏错误码和可采取动作。

允许的人工动作仅来自状态机：提交澄清、对 unknown 标记已确认结果、取消尚未执行的步骤。权限不足的运行提供“打开本地权限”入口，但不会在运行详情中审批或改变权限。面板不展示 token、微信完整 ID、正文、绝对路径或媒体内容。

首个 UI 纵切先保持全只读：列表和详情只消费 `WorkflowEngine.getPublicState()` 的有界脱敏投影，不暴露内部 run/trigger/effect/operation/resource 标识，也不提供任何可能重放副作用的按钮。上述状态机动作要等 signal/取消协议单独实现并审查后才开放，不能用前端按钮直接改 SQLite。当前投影展示模板版本、运行总耗时、步骤状态/依赖/attempt 与 effect 结果；逐步骤精确耗时需要持久步骤起止时间后再接入，不能用更新时间伪造。

## 13. 与 Codex Dynamic Tools 的关系

可靠的媒体/笔记请求由宿主候选路由经 `WorkflowIntentPlanner -> WorkflowGateway` 进入 WorkflowEngine，不依赖模型“记得先调用发现工具”。

为了支持普通对话中途发现工作流需求，可以向 Codex 只暴露一个长期稳定的 `assistant_workflow` gateway：

```ts
assistant_workflow({ protocolVersion, intent, intentVersion, slots })
```

该工具调用同一个 `WorkflowGateway`，不能直接调用 `WorkflowEngine.submit`、模板或底层 Provider。首次加入 gateway 可能需要新建 Codex thread，因为当前 `thread/resume` 不能刷新 Dynamic Tools。以后底层 capability 新增/升级不改变 gateway schema，也不触发 thread 重建；只有模型可见 envelope 发生不兼容变化才升级 `protocolVersion`。gateway tool 是普通对话中途发现工作流需求的补充入口，不是正确性的唯一依赖。

## 14. 后续迁移顺序

核心 RunStore、编译器、DAG executor、权限、Provider、可信触发输入、scheduler adapter 和只读运行投影已经落地。接下来按依赖关系实施，不按模块数量并行切 owner：

1. **Input Gate / SignalInbox（Engine 与 Trigger Adapter 核心已完成）**：现有搜索输出可唯一自动选择、多候选持久等待并在同一 Run 恢复；Adapter 支持按账户/目标查询、显式六位引用、单一等待的明确序号、多等待不猜和无关聊天旁路。生产选择回复仍由旧 Router 持有。
2. **WorkflowIntentPlanner / WorkflowGateway（生产可执行）**：已实现短上下文 structured output、同 thread 一次修复、候选 intent 限制、IntentRegistry 与 `legacy|shadow|workflow` owner 开关。`notes.send-file@1` 的候选在当前入站关键路径中调用独立 Planner；普通聊天和旧显式搜索仍可旁路。
3. **笔记“一条消息发原文件”纵切（已接管）**：`notes.send-file@1` 已绑定 reviewed workflow 并成为自然原文件发送请求的唯一 owner；唯一命中自动完成，多命中在同一 Run 等待选择，零命中稳定结束；全过程不把正文交给模型。
4. **旧路径兼容**：既有“发送笔记 六位引用 序号”在 Planner 前交给 legacy artifact；新 workflow 不接管或初始化不可用时，旧显式搜索继续可用。已被 workflow 接管的请求失败时不回放 legacy，避免重复副作用。
5. **媒体 owner 切换**：已复用现有 Provider，并接入同一 Input Gate 与 Gateway；真实手机图片仍待用户在场验收。
6. **可选稳定 `assistant_workflow` 工具**：只作为普通聊天中途升级入口；不阻塞前五步。
7. **笔记写入与真实 scheduler 场景**：分别补齐生成内容、写入对账和具体 schedule 产品语义后再迁移。

以下纵切描述保留为能力边界和验收依据；其中 Provider 已实现不等于真实 intent 已完成 owner 切换。

### 纵切 1：媒体查找并发送

`media.find_images -> select/needs_input -> weixin.send_image`

- 复用现有媒体库、root grant、handle、文件安全校验和 effect ledger。
- 切换后，同类显式媒体请求不再进入旧 media dynamic-tool 副作用路径。

实现同步：媒体 Provider 与图片发送 owner 已接入生产 Engine catalog。`media.resolve_images.v1` 从触发时冻结的引用、当前、近期或本地目录请求解析候选，并把图片收敛为 0600 私有 sidecar 支撑的 opaque handle；sidecar 内的绝对路径不进入 workflow SQLite、模型或 UI。`weixin.send_image.v1` 只从可信 run target store 解析账户与目标，发送前重新检查来源授权、realpath、普通图片文件和 100 MiB 上限，并把引擎的稳定 operation ID 传入现有 iLink 媒体 effect ledger。渠道对账只读 operation attempts，不重放发送。

本次只完成 Provider 与可信端口，没有注册真实媒体模板，也没有把显式媒体入站从旧 dynamic-tool 路径切走。因此生产行为保持不变；路由切换必须等 `select/needs_input` 状态与目标绑定 adapter 一起完成，不能只凭 capability 已注册就宣称媒体工作流闭环。

### 纵切 2：通用文件查询与笔记原文件发送

`files.resolve -> select/needs_input -> weixin.send_file`

文件能力按 Claude Code 式职责边界拆开：`files.find` 只查文件名与相对路径，`files.grep` 只查正文命中，`files.read` 才读取选定文件。自然语言入口的 Intent Planner 只判断是否进入文件工作流；独立 File Resolver 接收冻结的原始请求，通过绑定的 `files.find/files.grep` 工具迭代查询，并只返回它实际发现过的 opaque file refs。可信宿主负责权限、范围、查询上限、完整性、稳定排序与引用校验，不维护“文件/原文件”等停用词删除表。Resolver 失败与真实零结果使用不同错误语义。旧 `files.locate` 及其一次改写只为冻结运行保留兼容，不再承担新自然语言入口的规划职责。

查询采用 Unicode NFKC 规范化、标题/路径优先、有界分词与轻量近似匹配；正文后备是有界 lexical grep，不使用 embedding。候选返回 opaque `fileHandle`、安全展示路径、命中来源、到期时间与 `truncated`，不返回绝对路径或正文。唯一候选自动继续，多候选进入同一 Run 的 Input Gate。

- 搜索只访问安装/设置页已授权的 module/scope；引擎冻结可信模板里的 literal `moduleId`，effect 前再次复核。
- 原文件发送直接把 `fileHandle` 交给 `weixin.send_file`，不调用 `files.read`；正文不进入 Codex、workflow SQLite 或文本 renderer。
- 内容问答必须显式走 `files.find/files.grep -> select -> files.read -> generate`；文件更新则在 `files.read` 后使用 revision/CAS 写入能力。
- 搜索候选以 24 小时私有 artifact 绑定到账户与目标；存在多批待选时，必须用“搜索引用 + 序号”明确选择，不能由裸序号抢占。
- `weixin.send_file` 在 effect 前重新校验 module read grant、realpath、普通文件、no-follow 与 100 MiB 上限，并复用 iLink `media_type=3`/`file_item` 与 effect ledger。

兼容期内保留既有 `notes.search/read/export_file`，但新模板不再使用它们；后续确认无调用者后单独移除。

### 纵切 2.5：图片发送 owner 迁移

图片发送保留 `media.send-image@1` 处理引用、当前消息与近期入站图片，并新增 `media.send-local-image@1` 处理本地已授权目录。宿主候选路由在普通 Codex 之前接管；来源选择由可信宿主按固定优先级冻结：引用图片优先，其次为当前消息图片；只有用户明确使用“刚才”“上一张”或“最近”等指代时才读取同账户同目标最近十分钟、最多五张的近期图片；其余本地图片请求由 File Resolver 通过当前可读的 Downloads、Pictures、Documents 范围查询。目录中英文别名可以成为 Resolver 查询依据，但不能解析为任意路径或越过授权范围。来源一旦冻结，零候选、句柄失效或权限撤销都在当前运行内失败，不跨来源寻找替代图片，也不回退旧 Dynamic Tool。

引用、当前与近期图片模板为 `media.resolve_images -> input_gate -> weixin.send_image`；本地图片模板为 `files.authorized_scopes -> files.resolve -> input_gate -> media.prepare_image -> weixin.send_image`。引用、当前与近期入站图片先由宿主复制为短期 opaque media artifact；本地图片通过文件引用重新绑定到 `MediaExportLibrary` 的授权与 no-follow 校验。唯一候选由 Input Gate 自动选中；多个候选持久暂停同一 Run，只向微信展示文件名与安全相对位置。选择 Signal 恢复原冻结运行，不重新搜索。

Intent Planner 只识别本地图片发送意图；File Resolver 根据原始请求决定查询词和受支持的排序。用户要求“最新”时，Resolver 请求 `modified_at desc`，但宿主只有在扫描完整、排序合同有效且第一项身份可验证时才生成可信 `preselected`，模型不得输出路径、时间戳或自行声称全局最新。账户、目标、绝对路径、候选句柄与 effect 标识均由宿主绑定。用户没有明确 caption 时不自行生成说明。`weixin.send_image` 继续复用渠道 operation/effect ledger；accepted 只表示渠道接受，unknown 不自动重发。

本地目录扫描只把 `.photoslibrary` 作为不可进入的 Apple Photos 隐私边界，在加入 BFS 队列前跳过。该规则统一用于 Downloads、Pictures、Documents；发送前路径再校验还会检查授权根到目标文件之间的每个目录组件，防止修复前生成的 token 或持久 handle 继续读取照片图库内部资源。应用 bundle、Pages/Keynote/Numbers/RTFD 等其他目录包、普通子目录和点号目录均正常递归；没有额外 Apple 隐私授权证据时不按 package 身份扩大跳过范围。

旧 `weixin_find_images`、`weixin_send_image` 与 `weixin_send_media` 可暂时服务尚未迁移的视频或兼容场景，但图片发送候选一旦命中 workflow owner，旧分支不得再接收当前入站。迁移测试必须覆盖引用、当前、近期、本地目录、多候选、零候选、权限撤销、跨账户/目标隔离、重启恢复、accepted/unknown 以及单 owner 不双发。

### 纵切 3：笔记创建与更新

- 创建：`validate_path -> notes.create`
- 更新：`notes.search -> select -> notes.read -> generate_content -> notes.update(expectedSha256)`
- “追加”编译为 read + complete-body update，不新增不安全的 blind append。

实现同步：`notes.create.v1` 与 `notes.update.v1` 已注册进生产 Engine。两者只接受私有 content handle，不让正文进入 capability 参数、workflow SQLite 或 UI。create 使用 exclusive create，update 要求读取阶段生成的 `expectedSha256` 并由 Vault 做 CAS；外部编辑后必须冲突退出，不能覆盖。write scope 与 read scope 分开验证，默认只读 grant 无法写入；尚不存在的目标子目录以最近存在父目录验证授权，真正创建时仍由 Vault 逐段拒绝符号链接。

本阶段没有注册真实笔记工作流模板，也没有内容生成步骤、设置页 grant 接线或宿主意图路由。Provider 的 write effect 由 Engine effect ledger 管理；超时保持 `outcome_unknown` 且不自动重放。在设计持久 write-intent/结果对账前，不为笔记写入伪造 reconcile 成功。

### 纵切 4：scheduler Adapter

先用 fixture/安全工作流验证 occurrence 去重、恢复和 UI，再启用一个真实已授权的定时媒体或笔记场景。现有每日新闻保持原路径，直到另行设计迁移。

实现同步：`WorkflowSchedulerAdapter` 接收固定 schedule definitions，把稳定的 `scheduleId + occurrenceId` 直接提交为 `source=scheduler` 的 trigger，不做自然语言分类。定义可选配置账户/目标，但必须成对存在；Engine 仅在新 run 被接受时调用同步可信 hook，把目标写入私有 run target store 后才允许 process，因此 scheduled external effect 看不到“尚未绑定”的窗口。相同 occurrence 后续重复投递只返回原 run，不会用后来更改的 schedule 目标覆盖第一次绑定。

本阶段只用 fixture external-send capability 验证目标在 effect 前已固化、重复 occurrence 不重复执行。没有注册任何真实 schedule，也没有迁移每日 AI 新闻；现有 scheduler 继续原路径，避免两个 owner 同时发送。schedule definitions 的持久配置、设置 UI 和真实模板迁移需要按各功能另行设计。

### 纵切 5：可信触发输入

真实微信请求会为同一模板带来不同的 note/media artifact handle，但当前模板输入完全静态。首个路由纵切前，Engine 增加一条受限输入通道：trigger 只能携带少量命名的 opaque reference，模板只能把声明过的 reference 绑定到字符串输入字段。完整消息、笔记正文、相对/绝对路径和任意 JSON 都不能通过该通道持久化。

可信触发输入随首次接受的 trigger 一起持久化，并参与重复 trigger 冲突判断；服务重启后编译相同冻结计划。编译时把 reference 合并进步骤 input，之后仍走 capability input schema、模块权限与 effect 边界。公共运行投影不展示 reference。模板绑定缺失、目标字段非字符串、同一字段同时被静态值、依赖输出或 trigger reference 占用时，在执行 Provider 前失败。

本阶段只建立模板安全输入 seam 与 fixture 验证，不注册真实笔记模板，也不切换微信入站 owner。下一纵切再使用私有 artifact store 先把明确 `.md` 请求收敛为 handle，然后接入只读模板与回复 renderer。

## 15. 用户操作序列与失败模式

| 用户操作序列 | 预期行为 |
|---|---|
| 用户重复发送同一消息 | 同一 trigger key 返回同一 run，不重复 effect |
| 用户要求“把 Downloads 最新一张图片发给我”，完整扫描找到多张 | 按最后修改时间归约为唯一候选并直接继续；同时间用稳定目录与相对路径顺序决胜，不进入 `needs_input` |
| 用户要求“把 Downloads 最新一张图片发给我”，扫描达到上限或局部目录不可读 | 不发送部分结果；返回安全的暂时查找失败提示 |
| 用户从多张里明确选择一张，等待期间只有其他候选变化 | 按稳定资源身份重绑定所选项，使用当前 revision 继续 |
| 用户回复“都要”，等待期间候选集合增删 | 不发送；说明列表已更新，展示最新候选并要求重新确认 |
| 用户选中的文件消失或内容改变 | 不发送；说明所选项的具体变化，展示最新候选并要求重新选择 |
| 用户回答时原请求已过期、结束或被新请求替换 | 不发送；说明具体生命周期结果；有替代请求时展示其最新候选 |
| 用户保存模块权限前触发工作流 | 权限预检失败，不读写文件；引导到设置页 |
| 用户授权后中途撤销目录权限 | 下一 effect 前变为 `blocked`，已完成 effect 不回滚 |
| 用户在设置页新增目录 | 默认读取开启、写入关闭；保存后只影响后续执行 |
| 用户修改目录读写权限后返回失败任务 | 原任务不自动恢复；用户手动重试产生新运行 |
| 用户要求修改笔记，文件随后被外部编辑 | sha256 CAS 冲突，不覆盖 |
| 微信 send 请求超时 | `outcome_unknown`，不自动重发 |
| 服务在 effect prepare 后崩溃 | 对账；不能对账则 unknown |
| 用户在等待澄清时发无关聊天 | 不消费为 signal |
| scheduler 与微信同时修改同一笔记 | resource lock + CAS，避免互相覆盖 |
| 模板在 run 中途升级 | 当前 run 使用冻结旧 plan |
| capability 旧版本被删除 | blocked，不隐式替换 |
| Planner 返回非法结构 | 同 thread 最多修复一次；仍非法则停止，不重建 transport |
| Planner 初始化、请求或回合超时 | 在 Run 创建前关闭隔离 transport 并重建后重试一次；第二次仍超时则说明尚未查找或发送 |
| 普通聊天包含“图片”但没有动作 | 不进入副作用工作流 |
| 批量/跨目标/删除请求 | v1 不支持，不进入运行中审批，也不执行 |

## 16. 明确不做

- 分布式 worker、多机协调。
- 可视化工作流编辑器或用户自定义 DSL。
- 无界循环、任意代码节点、模型自由调用所有本地工具。
- 对微信或第三方副作用宣称 exactly-once。
- 第一阶段迁移新闻、Memory Curator 或所有普通聊天。
- 为了“通用”而预先创建尚无第二个真实实现的 MCP/HTTP 抽象。
- v1 暴露删除能力。
- 运行途中申请、批准或升级模块权限。
- 读取、写入或执行用户文件中的脚本与二进制。

## 17. 成功标准

1. 同一真实微信媒体请求只产生一个持久 run 和至多一个发送 effect。
2. 服务在任意 step 边界重启后，run 能恢复或诚实进入 blocked/unknown，不重复非幂等副作用。
3. 笔记更新在外部并发修改时拒绝覆盖。
4. scheduler occurrence 重复投递不重复执行。
5. 普通聊天的 Codex 路径与延迟不受工作流 planner 影响。
6. UI 能从 SQLite 投影解释“在哪一步、为什么等待/失败、能否安全重试”。
7. 所有模型输出、Provider 输入输出、状态迁移和授权均经过 schema/invariant 校验。
8. 所有已列目录的安装草稿默认读取开启、写入关闭；保存前无授权，保存后可在设置页逐目录调整。

## 18. 实施验证策略

实现阶段按纵切 TDD：

1. 先在 `WorkflowEngine.submit` seam 测 trigger 去重和 run 持久化。
2. 再用 fixture Provider 测 DAG、依赖、并发上限、lease/restart。
3. 加 effect unknown/no-replay、授权撤销、signal correlation。
4. 接真实媒体 Provider，保留由用户发起的真实微信 E2E；不自动发送测试消息。
5. 接 notes read，再接 create/update CAS。
6. 接 scheduler occurrence 去重。
7. 全量运行 lint、typecheck、单元/集成、fixture browser E2E；真实渠道最后由用户在场确认 channel accepted 与手机实际收到。

## 19. 当前实施状态补充（2026-08-24）

- 微信显式笔记搜索已成为首个真实入站路由纵切：宿主只识别明确的搜索/查找/检索动作，普通聊天旁路。
- 搜索词先进入私有 request artifact，模板只绑定 opaque handle；步骤输出持久化供可信 renderer 跨重启读取，但公共投影不展示输出。
- renderer 只返回经过消毒和 Unicode 安全截断的文件名；空结果、缺参和权限不足均不回退自由工具执行。
- 多结果选择与 Markdown 文件附件发送是下一纵切；读取正文不属于该纵切，笔记写入仍留在后续模板中。

## 20. 研究后方案增补（2026-08-25）

对 OpenAI Agents、LangGraph、Temporal、Microsoft Agent Framework、Amazon Bedrock 和 Google ADK 的一手资料核查后，本项目继续采用混合架构，而不把完整 durable DAG 强加给每次聊天。常规 Agent loop 负责开放式理解；持久工作流负责跨重启、人工补参和真实副作用；宿主校验与 effect ledger 保持最终执行权。

研究证据与逐项来源见 [`mainstream-patterns.md`](/Users/loong_zhou/research/agent-workflow-architecture/mainstream-patterns.md)。

本轮明确了四个此前尚不够深的 seam：

1. `WorkflowIntentPlanner` 只输出固定 schema 的语义 proposal，不调用工具，也不生成真实执行标识。
2. `WorkflowGateway` 统一宿主路由、scheduler、显式命令和可选 Codex tool 的 intent 提交；调用者看不到模板、DAG 和 Provider。
3. `InputGate / SignalInbox` 归 Engine 管理，Provider 不拥有聊天或等待输入；合法补参恢复同一个冻结 Run。
4. 步骤成功与可恢复输出原子提交；一个 trigger 同时只有一个最终回复 owner 和一个副作用 owner。

实现同步：Planner 使用独立短 thread、严格 wire output schema、`gpt-5.6-luna/low` 默认 runtime、空 workspace roots 与禁用 tools/web/plugins 的 feature 集；wire slots 经 `slotEntries` 安全重建为领域 slots。非法输出在同一 thread 修复一次，修复轮收到冻结原始输入与首次输出；若首次输出已识别当前候选 intent，宿主阻止修复轮降级为普通聊天或改换 intent，同时允许同 intent 的 `needs_clarification`。每次 Planner 尝试记录 App Server 准备、turn accepted、首次模型事件和结构化输出的脱敏阶段。初始化、App Server 请求或回合超时会关闭当前专用 runtime；因为此时尚未创建 Run 或 effect，宿主可重建隔离 transport 后自动重试一次。第二次仍超时则停止并明确说明尚未查找或发送；业务 schema 非法不走该重试。IntentRegistry 深冻结 slot schema，并将 registry-owned binder 与 owner 一起注册。Gateway 先校验 proposal 与 slot schema；`legacy`/`shadow` 在 binder 前返回，只有 `workflow` 才把可信 trigger 与 binder 生成的 opaque refs 提交给 Engine。微信 Trigger Adapter 核心先查询当前账户与目标的等待请求，再处理显式引用或唯一等待序号；否则才把宿主过滤后的候选交给 Planner/Gateway。过期显式引用仍交给 Engine 原子关闭；`legacy`/`shadow` 与未命中候选的 ordinary chat 不接管回复。生产已把 `notes.send-file@1` 注册为 workflow owner：宿主候选一旦命中便锁定当前入站的回复所有权，再交给独立 Planner；可信 binder 生成 opaque query handle 并提交 Engine；唯一候选继续到原文件发送，多候选持久等待 Signal。旧引用选择在 Planner 前兼容，未被新 intent 候选命中的显式搜索继续 legacy；候选命中后的 Planner `ordinary_chat` 转为宿主澄清，失败转为安全失败，二者均不回退，避免错误能力声明或双发。

App Server 协议兼容性在服务启动时从当前实际 Codex 可执行文件生成的 v2 schema 检查，而不是等第一条微信消息触发。Planner、Turn Router 与 Curator 的回合使用命名权限 profile `permissions: ":read-only"`，不再发送已废弃的 `permissionProfile`；同时要求 structured output 与 permission-profile list 协议存在。Planner 初始化、thread/start、turn/start 或回合超时会关闭隔离 `CodexConversation` 的 transport，并在同一消息的无副作用规划边界重建、重试一次；其他模块仍按各自恢复策略处理。合法但不满足业务 schema 的模型输出只走同 thread 一次修复，不把语义错误误判成 transport 故障。真实协议验证将 Planner 与 Turn Router 分成两个独立测试，防止前一个失败污染后一个结论；Planner-only 基准分别测量新 transport 与复用 transport 的冷/热样本，不提交 Gateway。

因此，现有 `needs_input` 枚举本身不代表补参闭环已经实现。完成条件是 signal request 可持久恢复、来源与 revision 可校验、重复 signal 幂等、无关聊天不被消费、前置成功步骤不重跑，并且 owner 切换有 shadow 验证和回归门。
