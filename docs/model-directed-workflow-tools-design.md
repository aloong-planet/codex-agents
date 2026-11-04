# 主微信模型驱动的领域工作流工具设计

状态：方案已确认，待实现

日期：2026-09-01

关联：ADR-0003、ADR-0004、ADR-0005、ADR-0006

## 1. 目标

把微信新意图的语义 owner 收敛到主微信 Codex 回合：模型基于完整对话上下文决定直接回复，或调用一个具名、严格的领域工作流工具。宿主不再用业务关键词、正则或独立 Intent Planner 决定新消息是否进入工作流。

这次改造不替换可靠执行层。工具调用只是一份不可信的目标请求；账户、目标、当前入站、授权、Pending、模板、DAG、Provider、effect 与幂等键仍由可信宿主、Workflow Gateway 和 WorkflowEngine 管理。

成功后的结构应同时满足：

1. 普通聊天和工作流只有一个新意图语义 owner。
2. 模型看到的是少量领域 member 工具，而不是 `workflow.execute(intent, payload)`。
3. 文件检索、候选选择、Pending、权限和外发不会泄漏成模型需要拼装的内部协议。
4. 一条微信入站最多创建一个有副作用的 Run；被工作流接管后，模型最终文本不再拥有用户回复权。
5. 自动化测试走与生产相同的入站、主模型工具调用、Gateway、Engine 和 outbox 路径；真实微信仍是最终验收。

## 2. 明确不变的边界

以下模块继续保留，不属于本次废弃范围：

- Durable Inbox、账户与目标 FIFO、入站幂等。
- WorkflowEngine 的冻结计划、lease、CAS、Input Gate、Pending Request、Signal、effect ledger 和恢复。
- Workflow Response Bridge 与语义 Turn Router。它们只解释已经存在的 Pending Response，不再识别新的业务工作流。
- Workflow Gateway 对受审模板的唯一映射和可信字段注入。
- File Resolver 及其内部 `files.find`、`files.grep`、`files.read` 职责拆分。
- 模块目录权限、渠道上下文、私有 artifact、no-follow、大小限制、unknown 不重发。
- 渠道 accepted 与用户实际收到的证据等级区分。

以下旧模块要退出生产新意图路径：

- 宿主业务关键词或正则 Candidate Filter。
- 独立 Workflow Intent Planner。
- Planner shadow observation 与 `legacy|shadow|workflow` owner 切换。
- 被工作流接管失败后回退普通 Codex、旧文件发送或旧媒体 Dynamic Tool 的路径。

旧组件可以在迁移期只读加载冻结旧 Run，但不得接管新入站、生成第二份回复或产生新 effect。

## 3. 总体结构

```text
微信入站
  │
  ▼
Durable Inbox + 账户/目标 FIFO
  │
  ├─ 存在当前 Pending Request
  │    └─ PendingResponseCoordinator
  │         ├─ respond/cancel  → Workflow Response Bridge → 原 Run
  │         ├─ new_goal       → supersede 旧 Pending → 主微信 Codex 回合
  │         ├─ clarify        → 保留旧 Pending
  │         └─ ordinary       → 保留旧 Pending → 主微信 Codex 回合
  │
  └─ 无 Pending / 已确定为新目标
       ▼
主微信 Codex 回合
  ├─ 普通回复
  └─ 领域工作流工具调用
       ▼
WorkflowToolHost（本回合可信绑定、schema、owner）
       ▼
Workflow Gateway（工具 member → 受审模板）
       ▼
WorkflowEngine（持久 Run、Input Gate、effect、恢复）
       ▼
WorkflowReplyProjector（只依据 Run/effect receipt 生成用户回复）
       ▼
微信发送
```

模型负责“选择哪个目标工具”和补充工具公开语义参数；宿主负责“这个请求是否有效、允许映射到哪个模板、实际能访问什么、执行到了什么状态”。两者不共享权限判断或副作用真相。

## 4. 模型可见工具面

### 4.1 命名与粒度

工具按领域 namespace 组织，member 是模型实际调用与审计的键：

- `files.send`：查找并把一个或多个已有本地原文件发送到当前微信；不读取文件正文。
- `media.send`：把引用、当前、近期或已授权本地媒体发送到当前微信；第一阶段只启用图片 kind。
- `notes.search`：后续只读搜索笔记，返回安全候选引用。
- `notes.read`：后续读取已选笔记，用于问答；与搜索和发送分离。
- `notes.write`：后续创建或修改笔记；写权限与并发语义独立。

第一阶段生产目录只包含 `files.send@1` 和 `media.send@1`。`notes.*` 是已确定的扩展形状，不在实现闭环前注册到模型工具目录。

不提供以下模型工具：

- `workflow.execute`、`assistant_workflow` 或任意 `action + payload` 万能入口。
- `workflow_signal` 或允许模型填写 request/run/revision 的恢复入口。
- `files.find`、`files.grep`、`files.read` 等内部 Resolver/Provider 能力。
- `weixin.send_file`、`weixin.send_image` 等外部 effect Provider。
- 任意 shell、用户文件执行或自定义 DAG 提交工具。

### 4.2 第一阶段严格 schema

工具参数只表达语义目标，不接受绝对路径、账户、目标、目录授权、内部引用或 effect 信息。

`files.send@1`：

```ts
type FilesSendRequest = {
  query?: string; // 从当前对话解析出的文件名、标题、主题或相对位置线索
  selection?: "best_match" | "latest" | "all_matches";
  kind?: "markdown" | "document" | "file";
};
```

`media.send@1`：

```ts
type MediaSendRequest = {
  kind: "image";
  source: "referenced" | "current" | "recent" | "local";
  query?: string; // 文件名、主题或用户在对话里指代的媒体线索
  selection?: "best_match" | "latest" | "all_matches";
  caption?: string;
};
```

约束：

- `query` 是不可信检索提示，不是路径或授权；Gateway 同时冻结原始用户消息，Resolver 以两者为语义输入，宿主仍控制可查询 scope。
- `source` 由拥有完整对话上下文的主模型做语义选择；宿主只验证引用、当前附件、同目标近期媒体或本地授权范围是否真实存在。证据不成立时失败关闭，不靠关键词改写 source，也不跨来源兜底。
- `selection` 只表达用户语义。`latest` 必须由完整扫描与可信排序证明；`best_match` 不能把多个合理候选强行变成唯一；`all_matches` 仍受模板上限与 Input Gate 规则限制。
- `caption` 只有用户明确要求时才能保留；宿主不能让模型自行添加未请求说明。
- 任何额外字段、未知 enum、超长字符串或路径形态都在 Gateway 前失败关闭。

### 4.3 工具描述

每个工具描述必须同时写清：

- 何时调用，以及与相邻工具的排除关系。
- 输入字段的含义与非含义。
- 工具可能进入“唯一结果自动继续”“多候选等待选择”“权限不足”“结果未知”的状态。
- 工具调用不代表已授权、已发送或已收到。
- 失败时禁止改用普通文本谎称没有能力，禁止改调底层 effect 工具。

描述和 schema 是产品契约，必须有回归 fixture；不能只放在 prompt 中靠人工维护。

## 5. Workflow Tool Catalog

新增一个深的 Workflow Tool Catalog，负责从已启用模块和兼容协议生成模型工具目录。它不读取用户消息，不判断业务意图，也不执行工具。

目录条目至少包含：

```ts
type WorkflowToolMember = {
  id: "files.send" | "media.send" | string;
  version: number;
  description: string;
  inputSchema: JsonSchema;
  effectClass: "read" | "write" | "external_send";
  templateId: string;
};
```

不变量：

- 工具是否出现在目录由模块启用状态和协议兼容决定；目录不按本轮关键词过滤。
- 目录出现不表示当前目录授权或渠道 context 有效；执行时必须重新读取实时权限和渠道状态。
- 工具契约 hash 只包含模型可见的 member 名称、版本、description 和 schema，以及启用集合。
- handler 修复、性能优化、实时授权变化和 Provider 内部版本不改变工具契约 hash。
- member 新增、删除、改名、description 语义变化或 schema 变化会改变 hash。

## 6. App Server 工具承载与 thread 兼容

第一阶段复用现有 App Server dynamic tool 通道，不同时迁移到 MCP。Catalog、Gateway 和 Tool Host 保持传输无关，后续可增加 MCP Adapter 而不改变领域 member 契约。

当前 App Server 的 `thread/start` 能装配 dynamic tools，而恢复已有 thread 不能被假定会刷新工具契约。因此：

1. 每个账户与目标的会话映射持久化 `toolContractHash`。
2. 新建 thread 时保存本次 Catalog hash。
3. 恢复前先比较当前 hash；一致才 resume。
4. hash 不一致时不 resume 旧 thread，创建新 thread，并只恢复 durable memory、当前 Pending 投影和必要的安全会话摘要；不复制旧工具调用或媒体 bytes。
5. 同一 hash 下的权限变化不轮换 thread，由 Gateway 执行时实时校验。
6. App Server 将来支持同 thread 工具刷新，或改用支持 `tools/list_changed` 的 MCP 后，hash 继续用于审计和兼容判断，不再必然触发 thread 轮换。

实现前必须用真实 App Server 协议测试确认 namespace member 的 wire shape。如果当前安装版不支持 namespace dynamic tool，兼容 Adapter 可以使用确定性的扁平 wire name，但 Catalog 的逻辑 ID、Gateway 注册和测试仍以 `files.send`、`media.send` 为准；不得因此退化成万能工具。

## 7. WorkflowToolHost 深接口

WorkflowToolHost 是 App Server 动态工具调用与 Workflow Gateway 之间的 Adapter。它的职责是：

1. 在 turn 开始时绑定可信 `accountId + target + eventKey + originalText + attachments + quote + threadId + turnId`。
2. 只接受当前 Catalog 中的 member 和严格 schema。
3. 拒绝模型提供的路径、账户、目标、授权、模板、DAG、Provider、effect 和幂等字段。
4. 把 member、version、公开参数与可信绑定提交给 Gateway。
5. 一旦 Gateway 接受一个 schema 合法的请求，或在该请求上返回确定的业务错误，原子地把本回合 owner 锁为 workflow。
6. 将 Engine 的安全投影保存到 turn binding，供最终回复阶段读取。
7. turn 结束或异常时释放绑定；已提交 Run 不因模型 turn 关闭而丢失。

同一微信入站允许模型进行推理，但最多接受一个会产生副作用的领域工作流调用。未知 member 或 schema 非法属于 effect 前工具错误，不锁 owner；模型在同一 turn 最多有一次修正后重试。第一项 schema 合法且被 Gateway 接受或得到确定业务错误后，使用 CAS 锁定 owner，后续或并发 effectful member 调用返回 `workflow_turn_already_claimed`，不得建立第二个 Run。后续若引入纯只读工具链，需要单独声明只读调用预算，不能隐式放宽这个不变量。

## 8. Gateway 与模板映射

Gateway 的外部深接口从旧 Intent Proposal 改成工具请求：

```ts
type WorkflowToolRequest = {
  toolId: string;
  toolVersion: number;
  arguments: JsonValue;
};

type TrustedWorkflowTurn = {
  eventKey: string;
  accountId: string;
  target: string;
  occurredAt: number;
  originalTextRef: string;
  attachmentRefs: string[];
  quoteRef?: string;
};

interface WorkflowGateway {
  submit(request: WorkflowToolRequest, trusted: TrustedWorkflowTurn): Promise<WorkflowHandoffReceipt>;
}
```

Gateway 内部执行顺序固定为：

1. 查找 `toolId@version` 注册项。
2. 再次校验严格 schema 与字段上限。
3. 根据工具注册确定模板，不接受模型提供模板 ID。
4. 从可信回合生成或取得原始请求、附件、引用与查询 hint 的私有 artifact。
5. 读取当前模块启用状态、目录权限和渠道上下文；权限不足不得创建可继续执行 effect 的假计划。
6. 生成只含 opaque refs 的 input bindings。
7. 用稳定 event key 与 tool member 生成幂等提交键。
8. 提交 Engine，并返回 Run/状态/安全回复投影。

第一阶段映射：

- `files.send@1` → 现有原文件发送受审模板，内部调用 `files.resolve → input_gate → map/weixin.send_file`。
- `media.send@1(kind=image)` → 现有图片发送受审模板；模型提交严格 `source` 枚举，宿主以可信引用、当前附件、同目标近期媒体或本地授权范围验证该来源，内部调用 `files.resolve` 或冻结媒体 artifact，再进入 `media.prepare_image → input_gate/map → weixin.send_image`。

Gateway 不再维护 `ordinary_chat`、`needs_clarification`、confidence 或 candidate intent。是否调用工具已经由主模型决定；参数不足由 member schema、Gateway 或工作流中的 Input Gate 处理。

## 9. 回复所有权与用户语义

主模型未调用领域工作流工具时，其文本是本轮普通回复候选。

一旦 WorkflowToolHost 接受工具调用：

- workflow owner 覆盖本轮最终回复权。
- App Server 后续生成的模型文本只用于协议收尾，不发送给微信。
- 用户回复只能来自 WorkflowReplyProjector，并且只依据 Gateway/Engine 状态和已验证 effect receipt。
- 不得把“模型调用了发送工具”表述为“文件已发送”。
- accepted、rejected、unknown、needs_input、blocked 和 waiting_external 使用现有稳定用户语义。
- 内部名词 App Server、dynamicTools、iLink、Gateway、Run、revision、stale、Provider 和错误码不出现在用户文案中。

若模型没有调用本应调用的工具，宿主不使用关键词规则补发、不启动旧 Planner、不创建 Run。系统记录 `model_no_tool_call` 诊断，用户看到主模型的普通回复；该问题通过工具描述、模型配置和真实对话 eval 修复，而不是恢复双路由。

## 10. Pending 与新意图

Pending Response 协议仍先于主模型工具选择，但只处理“这条消息是否在回答当前唯一 Pending”：

- 明确选择或取消：恢复/结束原 Run，不启动新主模型回合。
- 明确新目标：先原子 supersede 旧 Pending，再把开放自然语言交给主微信 Codex 回合。
- 普通消息：保留旧 Pending，并交给主微信 Codex 回合。
- 歧义：保持 Pending，展示安全澄清，不启动可能产生副作用的新工作流。

Turn Router 仍由模型做语义判断，宿主只保留六位引用、纯序号等无歧义快路径；不得把新工作流业务 intent 枚举重新塞进 Router。

## 11. 权限与安全

- Catalog 可展示已启用模块的工具，但 Gateway 每次调用都读取实时权限和渠道上下文。
- 模块权限继续在安装、首次启用和设置页配置；运行中不弹出文件权限升级审批。
- 读取与写入独立；文件执行始终禁止。
- 搜索、读取、写入与发送使用不同 member 或内部 capability，不能因同属一个 namespace 互相继承权限。
- 模型提供的 query/caption 视为数据，执行器不把它当路径、命令、模板或 Provider 参数。
- 绝对路径、完整文件正文、媒体 bytes、context token、完整账户/目标和内部句柄不得进入模型工具定义、公开 tool result、运行投影或用户回复。
- effect unknown 不自动重试；同一 event 的工具调用、Run 和 effect 都必须幂等。

## 12. 可观测性

每次主模型回合增加以下脱敏诊断：

- Catalog revision 与 toolContractHash 前缀。
- 本轮可见 member ID 列表，不记录 description 全文。
- 模型是否产生 tool call、member ID、schema 校验结果。
- Gateway accepted/rejected、Run ID 的短安全引用、owner 锁定时间。
- 从入站到 tool call、Gateway、Run 稳定状态、最终微信发送的阶段耗时。
- 未调用工具时记录 `model_no_tool_call`，但不推断用户本来一定需要哪个工具。
- 旧 Planner、Candidate Filter 或旧 Dynamic Tool 若意外被调用，记录 `retired_route_invoked` 并拒绝产生 effect。

日志不得记录原始用户文本、工具参数值、路径、完整 ID、token、正文或媒体数据。

## 13. 用户真实操作序列与失败模式

### 13.1 普通聊天

1. 用户问天气或知识问题，模型不调用领域工具：普通回复一次，Engine 不创建 Run。
2. 用户话里出现“文件”“图片”等词但并非操作请求：宿主不关键词抢占，模型仍可普通回复。
3. 模型错误调用工具：未知 member/schema 非法可在 effect 前修正一次；schema 合法但业务来源或授权不足时由 Gateway 安全失败并锁定 owner，不回退另一路发送。

### 13.2 文件或图片发送

1. 用户模糊要求发送已有文件：模型调用对应领域工具，Resolver 查询；唯一候选自动继续，多候选进入同一 Run 的 Input Gate。
2. 用户要求“最新一张”：模型传递 `latest`，宿主只有在完整扫描和稳定排序成立时自动选唯一项，否则说明无法确认最新结果。
3. 用户说“都要”：多候选选择由现有 Pending 协议恢复，逐项 effect、按序发送、分别保存 accepted/rejected/unknown。
4. 文件不存在：只在 Resolver 完整查询成功且结果为空时提示未找到；Resolver 或协议故障不得伪装成零结果。
5. 权限不足：说明需要在本地权限中启用对应读取；不弹会话中授权、不自动重试。
6. 发送 unknown：提示结果暂时无法确认，禁止自动重发。

### 13.3 Pending 交互

1. 用户回复候选序号或自然语言选择：继续原 Run，主模型不创建新 Run。
2. 用户提出完整新目标：旧 Pending 先 supersede，再进入主模型工具选择；同一目标不保留两个 Pending。
3. 用户明确取消：模型语义 Router 返回 cancel，原 Run 结束，无 effect。
4. 候选已变化：按稳定资源身份重绑定；全选范围变化、所选项消失或内容变化时展示最新列表重新确认，不暴露内部 revision。

### 13.4 工具契约与会话

1. 服务升级但工具契约未变：恢复原 thread。
2. member/schema/description 语义变化：hash 不同，启动新 thread；旧 Pending 仍由 Engine 恢复，不依赖旧聊天历史。
3. 当前 App Server 不支持 namespace wire shape：协议测试失败后使用兼容扁平 Adapter；逻辑 member 与 Gateway 契约不变。
4. App Server 在 tool call 前失败：尚未创建 Run，可按现有主会话恢复策略处理。
5. Gateway 已提交 Run 后 App Server 断开：Run 继续由 Engine 对账；不得因模型 turn 失败重复提交。

### 13.5 并发与幂等

1. 同一入站重放：相同 event key 只得到原 handoff receipt，不重复创建 Run。
2. 模型同 turn 并发或串行调用两个 effectful member：CAS 只接受第一个 schema 合法且进入 Gateway 的请求，第二个拒绝且不产生 effect。
3. 用户在旧回复尚未发完时发送新消息：继续按账户与目标 FIFO 排队，不能覆盖前一 Run 的 owner 或 outbox。
4. 工具调用已接受但最终用户回复发送 unknown：保存 unknown，不重新执行工作流，也不自动重发回复。

## 14. 实施顺序

### 阶段 0：协议与测试 seam

- 建立真实 App Server namespace dynamic tool 协议测试，确认 member 定义、调用名、arguments 和 tool result。
- 为主微信会话增加生产等价 fixture：必须走可靠入站、Pending 协调、主 Codex turn、动态工具、Gateway、Engine 和脱敏 outbox。
- 测试 seam 选择主微信入站的公开 `process inbound → outbox/run projection` 行为，不直接测试 Provider 作为最终验收。

### 阶段 1：Catalog 与 Tool Host

- 实现传输无关 Workflow Tool Catalog、contract hash 和 current catalog projection。
- 扩展 DynamicToolHost 以绑定本轮可信上下文并返回 handoff receipt。
- 先注册 `files.send@1`，用一个失败的生产等价测试证明模糊文件请求由主模型工具调用进入现有模板。
- 再注册 `media.send@1`，用图片本地目录、最新一张和多候选分别纵切。

### 阶段 2：Gateway 深化与回复 owner

- 把 Gateway 输入从 Intent Proposal 改为 Workflow Tool Request。
- 迁移现有文件与媒体 binder，复用私有 artifact 和模板。
- 实现单 turn 一个 effectful Run、workflow owner 锁和 WorkflowReplyProjector。
- 确保模型最终文本在 workflow owner 下不会发给微信。

### 阶段 3：Pending 与新目标接合

- 保留现有 PendingResponseCoordinator/Router/Bridge。
- 把 `new_goal` 的下游从旧 Planner 改为主 Codex turn。
- 删除新意图候选过滤、Planner、shadow 与回退；保留旧冻结 Run 的只读兼容迁移。

### 阶段 4：thread 契约演进

- 持久化 toolContractHash 并在 resume 前比较。
- 契约变化时创建新 thread，恢复 durable memory 与 Pending 投影。
- 证明权限变化和 handler 修复不触发 thread 轮换，schema 变化会触发。

### 阶段 5：清理与后续领域

- 移除无调用者的 Intent Planner、Candidate Filter、shadow store、owner 开关及旧测试。
- 更新面板与运行诊断，只展示新 Catalog/Tool/Gateway 路径。
- 文件和媒体真实微信验收通过后，再分别设计并实现 `notes.search`、`notes.read`、`notes.write`，不提前暴露空工具。

## 15. 测试与验收

### 15.1 必须保留的测试层

1. Catalog contract：名称、版本、description、schema、权限暴露与 hash 稳定性。
2. Tool Host：可信绑定、严格 schema、一次 effect 前修正、并发 CAS、一个 effectful call、释放与异常路径。
3. Gateway：member 到模板映射、禁止内部字段、实时权限、幂等提交。
4. Engine 集成：唯一/多候选、Pending、批量选择、effect 结果与恢复。
5. App Server 协议：真实 dynamic tool member 定义和调用，不用假协议对象代替。
6. 生产等价微信 fixture：完整入站到脱敏 outbox，并记录模型实际 tool call。
7. 真实微信验收：使用与 fixture 相同口令，核对回复、Run、effect、渠道 accepted 与手机实际收到。

### 15.2 关键回归口令

- 普通聊天：`今天星期几？`
- 模糊原文件：`把那篇讲外设固件逆向的笔记原文件发给我`
- 唯一最新图片：`把相册里最新一张图片发给我`
- 图片多候选：`把 Pictures 里的王林图片发给我`，随后回复 `都要`
- 新目标 supersede：候选出现后发送 `把 Downloads 里的 holiday 图片发给我`
- 明确取消：候选出现后发送自然语言取消表达，由 Turn Router 语义判断。
- 权限不足：关闭相应目录读取后重发同一请求。
- 结果 unknown：用渠道 Adapter fixture 制造发送结果未知，验证不自动重发。

### 15.3 完成标准

- 代码中没有业务关键词/正则决定新工作流入口。
- 独立 Intent Planner 不再参与生产新入站；shadow 不再运行。
- 主模型可见 `files.send`、`media.send` 严格契约，并能在真实 App Server 协议中实际调用。
- 普通聊天不创建 Run；工作流请求只创建一个 Run，并由 Engine 投影用户回复。
- 旧 Pending 的回答、取消和新目标都保持单 Pending 不变量。
- 自动化全绿后重启 LaunchAgent；提交包含完整测试报告。
- 用户在真实微信发送相同口令并确认收到预期文件/图片后，才标记真实微信验收通过。

## 16. 明确不做

- 本阶段不迁移 MCP，不同时实现 tool search/deferred loading。
- 不开放万能工作流 payload、任意 DAG、shell 或文件执行。
- 不让模型直接调用 Provider、填写路径、账户、目标、权限或 effect 信息。
- 不恢复旧关键词路由作为兜底。
- 不在本轮实现 `notes.search/read/write`；只保留已确认的领域扩展形状。
- 不把自动化 accepted 当作手机已收到。
