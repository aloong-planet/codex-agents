# 微信工作流与运行面板

> 关联：[features](../features/workflow-runs.md) · ADR-0004 · ADR-0008 · ADR-0009

## Problem Statement

微信主会话需要像 Codex、Claude Code 一样，直接通过受限文件工具迭代查找、grep、读取并决定后续动作。现有 `files.send` 同时承担自然语言查询、文件解析、候选选择和微信外发，独立 File Resolver 又形成第二个语义执行者；主模型无法在同一工具循环里控制查询、排序和数量，错误也容易被误报为未找到。

系统还需要明确 Agent Loop 的唯一所有者。Codex App Server 背后的 Codex Agent Runtime 已经负责模型调用、工具选择、工具结果回灌、继续推理和 Turn 收口；如果微信宿主再次实现一套模型循环、重新提交 Turn，或在工具结果返回后自行决定下一步，就会形成第二个执行状态机，造成重复模型调用、工具结果错配、上下文分裂和终止状态不一致。

真实微信验证还暴露出另一层缺口：模型把自然语言名词短语原样作为一次搜索参数时，文件确实存在也可能得到零结果；现有协议测试用固定候选替代真实文件搜索，因此只能证明“模型调用了工具”，不能证明“模型生成的查询能命中真实文件”。

系统还必须保留已有的持久 Run、Input Gate、单 Pending、权限、Effect ledger 和 unknown 不重发语义。扩大模型能力不能扩大文件系统范围、暴露绝对路径、允许执行文件，或把渠道接受说成手机已经收到。

## Solution

主微信 Codex 回合是唯一新意图语义 owner。它直接看到并调用 `files.find`、`files.grep`、`files.read`、`files.edit`、`files.write`，自行决定公开查询参数、排序、返回数量、是否读取、选择哪些候选以及何时请求外发。宿主不设置业务关键词门禁，不生成查询词，不删停用词，不替模型决定 latest、all 或 best match。

Agent Loop 由 Codex Agent Runtime 通过 App Server 协议持有。微信宿主为一条进入主模型路径的用户入站最多提交一次 `turn/start`，随后保持双向传输并消费事件；确定性的 Pending 回答快路径可以不启动 App Server Turn。同一账户与目标已有活动 Turn 时，后续独立入站先进入 Durable Inbox 并按 FIFO 等待前一 Turn 收口，不使用 `turn/steer` 合并两条用户消息。当 App Server 发出 `item/tool/call` 服务端请求时，宿主校验和执行 Dynamic Tool，并使用同一个 JSON-RPC request id 返回一次有界工具结果。App Server 把结果加入同一 Turn 的模型上下文并自动继续模型执行，直至模型继续调用工具或产生最终消息。宿主不得为工具结果再次调用 `turn/start`，也不得自行编排模型下一步。

宿主通过一个 App Server Turn Driver 深 Module 驱动上述协议。它接收入站与可信上下文，成功时只返回 `model_owned + finalText` 或 `workflow_owned + receipt`，失败契约见 workflow-runs::REQ-067。连接 Module 隐藏 request-id 关联与连接消息分发，Driver 隐藏单回合事件状态机、权威最终消息选择、无进展检测、Tool Host binding 生命周期和接管后的事件排空；调用方不协调这些内部职责。Turn Driver 是协议 Adapter，不是第二个 Agent Loop；模型下一步始终由 Codex Agent Runtime 决定。

主微信统一使用 `runTurn`：Weixin Turn Adapter 装配与原入口等价的输入并取得可信绑定，Driver 等待准备、协议收口、工具排空与异步释放后交付判别结果；微信业务层不再 bind、snapshot 或通过空字符串判断接管。协议失败继续 reject，并携带 Tool Host 的可信 Owner/回执；清理失败保留业务事实与诊断，阻止不安全会话复用。专项 `reply` 保持 model-only 文本契约，显式 tool-only 空结果配置不变，误收到 workflow Owner 则报契约错误。连接内的已结束回合 ID 索引阻止旧事件污染新调用，连接失效即丢弃；不新增正文采集或持久化历史。

读取类工具可以在聚合预算原子预留后并行执行；修改类工具按稳定资源身份串行；终止型工具在同一 Turn 内互斥。终止型工具开始持久预检后形成并发屏障：不再接纳新的修改类或终止型调用，已经接纳的修改类调用完成后才允许建立快照并接管；已经运行的读取类调用可以完成，但不能改变回复 Owner。该并发策略只约束宿主执行，不改变由模型决定调用顺序和参数的语义所有权。

`files.*` 只表示本地文件系统操作。查询与修改都在同一模型回合内返回有界结构化结果并保持模型 owner；修改由 Local File Tools 通过持久操作日志、CAS、prepare/commit 与原子替换保证可恢复，不为每次修改创建 Workflow Run。所有操作都经过文件沙箱、保存过的读写授权、opaque reference、扫描/读取预算、no-follow 和并发校验。

微信文件外发使用 `weixin.send_files`。模型只能提交本轮文件工具产生的 opaque file reference，不能提交绝对路径、账户、目标、模板或幂等信息。明确目标时提交选中集合；存在歧义时提交候选集合进入同一个 Run 的 Input Gate。Gateway 将每个最终选中文件映射为一个内部 `weixin.submit_file` Effect。发送已有原文件不调用 `files.read`，因此正文不会进入模型上下文。

`weixin.send_files` 或 `media.send` 完成持久预检并由 Engine 接受后，Tool Host 向 App Server 返回结构化 `workflow_claimed` 工具结果，最终回复 Owner 不可逆地转移给 Durable Workflow；App Server Turn 仍按正常协议完成，Tool Host binding 保留到 Turn 完成或 watchdog 清理，期间后续工具请求统一返回 `workflow_turn_already_claimed`。Durable Workflow 的推进不等待模型最终消息。成功接管不得用 `turn/interrupt` 模拟结束；显式中断保持既有入口，本轮不将 idle 或本地资源释放转成自动远端中断，见 workflow-runs::REQ-067/AC-07。

本地图片继续由媒体工具表达图片消息语义，但目录搜索、排序和候选选择同样由主模型调用 `files.find` 完成；引用、当前附件和近期图片仍由可信微信上下文绑定。任何路径都不再调用 File Resolver 或 `files.resolve`。

一次 `files.find/files.grep` 的返回只是文件搜索观察。候选、零结果、截断、扫描不完整或参数错误都回到同一个主模型；主模型根据用户原意决定是否缩短关键词、切换文件名与正文搜索、调整大小写或范围，再次调用工具。宿主不把零结果升级为工作流终局，不调用独立 Query Rewriter，也不维护“文件、原文件、笔记”等业务停用词表。

模糊查找提供通用的机械容错：NFKC、smart-case、标点/空白切分以及拉丁字母、汉字、数字等 Unicode 字符体系边界切分。排序优先完整名称/路径连续命中，其次全部 term 命中，再次部分 term 覆盖；它不判断哪个词是业务描述，最终查询策略仍由主模型负责。

> Pending: 新请求已完成主模型文件查询迭代、真实执行器协议回归、既有文件工作流迁移、旧查询 Provider 退出、生产等价微信入口回归，以及完整服务进程重启后的 Pending 语义恢复与新目标替代回归。COM-03 已补契约升级的宿主持久化组合（模型边界假件）及读取权限撤销的完整进程真实模型组合；全 feature 清单核销、文档收口与真实微信验收仍未完成。契约组合不等同于跨真实 App Server 版本升级验收。

> Pending（当前已知缺陷）：跨页“发送全部”仍存在模型漏选。实际两页查询完整结束后，模型可能只向 `weixin.send_files` 提交一个引用，渠道对这一个文件接受后仍返回正常发送回执。独立重复运行可能成功，不代表缺陷消失。US-05/边界17仍要求完整集合，不将实现现状改成允许漏发；修复须保留主模型选择所有权，不由宿主擅自补选。

## User Stories

1. As a 微信用户, I want 用自然语言查找并发送任意已授权目录中的普通文件, so that 我不必先把文件转换为 Markdown 或图片。
2. As a 微信用户, I want 主模型根据完整对话决定搜索词、目录、排序和数量, so that 模糊说法与上下文指代不依赖第二个模型重新理解。
3. As a 微信用户, I want 唯一目标直接继续、多个合理目标让我选择, so that 系统既不多问也不猜测。
4. As a 微信用户, I want “最新一个”只返回真实全局最新项, so that 大目录中的有界结果不会选错文件。
5. As a 微信用户, I want 明确要求全部时发送完整匹配集合, so that 截断或不完整扫描不会被误当成全部。
6. As a 微信用户, I want 收到原文件而不是正文, so that 模型上下文不会因附件发送膨胀。
7. As a 微信用户, I want 文件名/路径查找和正文 grep 分开, so that 内容搜索不会偷偷读取完整文件。
8. As a 微信用户, I want 需要理解内容时由模型显式读取有界窗口, so that 我可以继续提问而不会一次加载整个大文件。
9. As a 用户, I want 只在已保存读写授权内修改或创建文件, so that 微信指令不能扩大本地权限。
10. As a 用户, I want 文件永远不能被执行, so that 文档、脚本或二进制只能作为数据处理。
11. As a 用户, I want 多选文件逐项记录发送结果, so that 一项失败或未知不会掩盖其他项。
12. As a 用户, I want 服务重启后待选任务仍能恢复, so that 澄清不会创建第二个 Run 或重复发送。
13. As a 维护者, I want 文件行为集中在一个深 Module, so that 笔记、媒体和后续模块不再各自实现搜索器。
14. As a 维护者, I want 真实模型测试与微信生产入口共用同一链路, so that fixture 通过能够预测真实微信行为。
15. As a 微信用户, I want “agent笔记”与“agent 笔记”都能找到包含 agent 的合理候选, so that 中文系统中的自然输入空格差异不会造成假未找到。
16. As a 维护者, I want 每次模型搜索参数和真实执行结果都可追踪, so that 能区分模型查询错误、搜索器错误、权限错误与扫描不完整。
17. As a 维护者, I want 每条进入主模型路径的微信入站最多启动一个 App Server Turn，Pending 快路径不启动 Turn，同目标并发入站按 Durable Inbox 顺序处理, so that 多次工具调用共享同一模型上下文且不同用户消息不会被错误合并。
18. As a 维护者, I want 工具请求与结果按 JSON-RPC request id 精确关联且只响应一次，同时由各副作用域使用持久幂等键处理跨崩溃恢复, so that 并行工具调用不会串线，连接级 request id 也不会被误当成持久业务身份。
19. As a 微信用户, I want 最终只收到权威 final answer 或工作流回执, so that 流式 commentary、工具旁白和内部接管信息不会泄漏到微信。
20. As a 维护者, I want 终止型工作流正常接管而不把成功 Turn 标记成 interrupted, so that 会话历史、诊断与恢复状态保持一致。

## 失败模式与边界

### 1. 主模型与工具循环

1. 普通聊天没有文件操作意图：模型正常回复，不创建 Run；宿主不得以关键词强制调用工具。
2. 模型未调用本应调用的文件工具：不启用旧 Router、Planner 或 Resolver 兜底；记录本地诊断，通过工具描述和真实对话 eval 修复。
3. 模型调用一个或多个工具：宿主不启动第二个 Turn；每个 `item/tool/call` 使用其连接内 JSON-RPC request id 独立执行并恰好回复一次，App Server 将结果交回同一模型回合。request id 只承担连接内关联、去重和恰好一次响应，不作为跨重启持久幂等键；本地修改使用 File Operation Journal 的稳定 operation key，外部发送使用 Run/Effect 幂等身份。读取类工具仅在原子预留聚合预算后允许并行，结果返回模型后仍由模型决定下一步。
4. 一次文件名或正文查询返回零候选：作为文件搜索观察返回主模型，不创建 Run、不调用 Query Rewriter、不由宿主直接生成“未找到”回复；模型可在剩余预算内改写查询并重试。
5. 模型使用过窄的完整用户短语查询且零结果：工具说明要求它提取可能真实出现在文件名/路径中的区分性词并再次搜索；宿主不得通过枚举删除用户词语来代替模型判断。
6. 查询参数非法：返回带稳定 `code`、`retryable`、`action` 和安全字段问题的结构化错误；模型可在同一工具循环修正，而不是把参数错误表述为文件不存在。工具异常同样必须完成当前 JSON-RPC 请求，不能让 App Server 永久等待。
7. 模型调用 `files.edit/write`：宿主持久记录本地修改，按稳定资源身份串行，返回新 reference 与内容 hash，并保持模型 owner；模型可以继续读取、验证或请求发送。
8. 查询或写入请求越权、引用无效或 schema 非法：不执行文件操作，返回结构化且不含内部路径的错误并允许模型修正；外发预检失败同样不转移 owner。未知或拼错的 scope reference 返回可重试的引用无效错误，不得误报权限不足；模型只能从当前 File Access Context 重新选取并原样使用引用，宿主不纠正引用、不扩大 scope。已识别 scope 的实际授权不足仍返回权限拒绝。
9. 工具目录变化：同一模型可见工具名同一时刻只允许一个活动版本；`toolContractHash` 随名称、版本、description 和 schema 变化。旧主微信 thread 不再 resume，创建带新契约的 thread，并恢复持久记忆与 Pending 投影。
10. 用户收窄或撤销读取 scope：递增账户的访问上下文代际，该账户已启用目标的旧 App Server thread 不再 resume；不得把旧文件正文、grep 片段或其自动摘要复制到新 thread。

主模型路径并发边界：同一账户与目标已有活动 Turn 时，后续独立入站保留为独立 Durable Inbox 项并按 FIFO 等待，不合并进当前 Turn；只有命中可信 Pending response binding 的确定性回答快路径可以在不启动新 Turn 的情况下恢复既有 Run。

终止接管状态机为 `model_owned -> terminal_preflighting -> workflow_owned`。预检或持久接受失败时回到 `model_owned` 并把结构化错误交回模型；进入 `terminal_preflighting` 后拒绝接纳新的修改类和终止型调用，等待已接纳修改完成后再快照和接管，已运行读取可以完成但不能改变 Owner；进入 `workflow_owned` 后不允许回退，所有新工具请求返回 `workflow_turn_already_claimed`，binding 只在 App Server Turn 完成或 watchdog 清理后释放。

本节统一收口规则：`item/agentMessage/delta` 只用于流式进度和诊断，最终文本以 `item/completed` 中的权威 `agentMessage` 为准。按完成顺序收集候选：优先最后一个 `phase=final_answer`；若不存在，再取最后一个未提供 `phase` 的已完成消息；任何 `phase=commentary` 都不能成为最终回复。模型仍持有 Owner 却没有可用候选时，本 Turn 失败，不得回退拼接 delta。权威文本只是候选，正常协议收口还须等待匹配的 `turn/completed`；中间错误、非成功终态及缺少完成事件的规则见 workflow-runs::REQ-067/AC-11、workflow-runs::REQ-067/AC-12。连接失败、显式中断和本地无进展失败沿用各自异常路径；工具预算错误先按原工具协议回灌，不凭工具错误伪造 Turn 完成。工作流成功接管不是中断。

模型拥有的最终回复仍由主模型生成：标点检查仅用于模型自行撰写的文字，避免无来源的括号、占位符与尾部装饰；用户要求只回复指定内容或原样复述时，提示要求逐字保留正文及文件名符号，包括末尾标点，不添加确认语。宿主不通过通用删标点规则清洗权威正文，也不为格式修正重启模型 Turn 或重放已经执行的文件操作。该提示是概率性质量约束，不承诺绝对消除模型笔误；实际回复须进入生产一致回归的原文审查。

### 2. 文件名和路径查找

11. `files.find` 只搜索已授权 scope 中的文件名和相对路径，不读取正文；默认跨当前全部可读 scope，模型可用宿主提供的 opaque scope reference 缩小范围。
12. 查询支持 Unicode NFKC、大小写可配置且默认 smart-case、literal/fuzzy terms、glob include/exclude、文件或目录类型、扩展名、稳定排序、`limit` 和 cursor。find 与 grep 使用同一过滤语义：不含 `/` 的 glob 按任意深度的文件名匹配；含 `/` 时匹配 scope 内相对路径；`**/` 匹配零层或多层目录。
    glob 通配符当前为 `*`、`?`、`**`，不支持花括号扩展；模型需用 `include: ["*.png", "*.jpg"]` 表达多个类型。include/exclude 含花括号时由共享 schema 拒绝并返回参数校验问题，不能静默执行为空结果；宿主不替模型展开或改写参数。query/pattern 中的普通文字不受这一 glob 约束影响。
13. fuzzy term 切分只依据空白、标点与 Unicode 字符体系边界；`agent笔记`、`agent 笔记` 和 `AGENT笔记` 在 insensitive 模式得到等价 term。宿主不维护语言相关的业务停用词。
14. `limit` 只限制返回数量，不等于扫描预算；结果分别返回 `scanComplete`、`resultTruncated` 和 cursor。
15. `sort=modified_at desc, limit=1` 必须在完整扫描或等价可信索引上返回全局最新项；无法证明扫描完整时不得称为最新或发送。
    Recursive traversal and bounded continuation follow workflow-runs::REQ-069.

16. 相同排序值使用稳定相对路径作为 tie-break；目录状态不变时结果必须可重复。名称/路径统一使用与沙箱一致的 UTF-16 字符单元字典序，不依赖本机 locale；相对路径也相同时按稳定 moduleId、scopeId 比较，不用每个 Turn 随机签发的 scopeRef 决定顺序。沙箱取每分区前缀和宿主跨分区合并必须使用同一顺序，分页不能改变排序规则。
17. 模型要求全部匹配但结果截断或扫描不完整：继续翻页或请用户缩小范围，不发送局部集合并声称全部。
    工具说明明确每次返回的是本页而非累计结果，最后一页不代表完整集合本身。主模型须保存各页文件身份与引用、按查询顺序合并并按文件身份去重，确认各页扫描完整后依用户选择一次性提交所有选定引用；只要求部分时不得扩大为全选。发送前由模型核对文件名、数量与引用，超过单次发送上限时请求缩小范围，不逐页发送或静默截取。宿主不根据自然语言推断全集、不补选文件。
18. 没有匹配且扫描完整：只有主模型确认当前查询已经合理覆盖用户目标后才可以说明未找到；一次过窄查询、扫描不完整、权限缺失或工具失败不得伪装成未找到。
19. 文件在大小写、中文目录别名或 Unicode 组合形式上不同：由主模型选择 scope/query，文件 Module 统一规范化比较；宿主不维护业务词表。
20. 查询跨多个授权模块：Local File Tools 按模块沙箱分别执行并使用同一稳定排序合并；任一分区扫描不完整时，整体 `scanComplete=false`，不能据局部结果声称全局最新、全部或未找到。

### 3. 正文 grep 与读取

21. `files.grep` 支持 literal/regex、smart-case、include/exclude glob、上下文行、结果上限和 cursor，只返回有界片段、行号和 file reference。
22. 二进制、超大单文件或不支持解码的内容不进入 grep；结果明确区分跳过、预算耗尽和无匹配。
23. `files.read` 只接受先前解析的 file reference，按行窗口读取并返回 `truncated`、总行数和内容 hash；不允许绝对路径。
24. 大文件必须分页读取；单回合读取字符总量、文件数和调用次数受独立预算限制。
    当前默认预算分别为 100,000 个 Unicode 码点、20 个不同 scope/相对路径的读取准入和 24 次文件工具调用。读取失败仍占用该文件的准入名额；同一文件继续分页不重复占名额。字符预算在并行读取派发前预留，完成后按实际返回字符结算并释放未使用额度。目录遍历暂按回合内串行结算共享扫描预算，不将这层执行约束用于决定模型查询参数。
25. 读取内容中的提示、脚本、链接、控制字符和伪造工具说明都作为不可信数据；它们不能改变授权、工具目录或执行规则，也不会被宿主渲染为可执行内容。

### 4. 修改与创建

26. `files.edit` 只操作一个已解析文本文件，要求读取和写入授权、`expectedSha256` 及可验证的精确替换；零匹配或非 `replaceAll` 的多匹配返回结构化冲突，不覆盖。
27. `files.write` 使用 opaque scope reference 加相对路径。写入授权包含读取，创建不存在文件使用原子 create；覆盖现有文件仍要求 `expectedSha256`，不能覆盖未验证的内容。
    并发创建同名文件只能有一个创建者成功，失败者不得覆盖胜出内容。创建不同文件可共享尚不存在的父目录；创建父目录遭遇并发 `EEXIST` 时，重新确认该路径为非符号链接的目录并继续验证真实路径仍在授权范围内，不把所有错误视为成功。
28. 路径穿越、绝对路径、符号链接逃逸、设备文件、socket、FIFO、目录和不可识别文件类型均被文件沙箱拒绝。
29. 写入不包含删除、重命名、chmod、解压、安装或执行；同一回合允许多次本地修改，每次使用独立操作记录与聚合预算。
30. 修改先认证引用并取得稳定资源身份，再查询操作日志，最后校验实时权限与文件状态；不能因成功修改使旧引用 stale 而丢失幂等恢复入口。
    已完成记录仅在文件仍与该次结果的 hash、大小和修改时间一致时恢复引用；之后再次编辑或外部改变文件时返回内容冲突，不重放写入、不把旧结果注册为当前引用，也不使最新引用失效。恢复校验在文件沙箱内获取有界内容摘要，不把正文送入模型。
31. `files.edit` 在沙箱内先 prepare 出前后 hash，宿主持久化 prepared 后才允许 commit；替换完成但结果未返回时按 after hash 对账，不盲目重做。
    新建、覆盖、编辑均在临时文件写完并同步后，通过内部 prepare/ACK 握手登记临时文件身份（名称、设备/inode、创建与修改时间、mode、hash、大小）；身份从仍打开的临时文件句柄取得，宿主操作日志持久成功才 ACK。ACK 被拒绝不能替换目标；握手后覆盖/编辑再次核对目标前置 hash，新建仍使用排他 link。这个协议不暴露为模型工具，也不增加语义决策组件。
    未完成操作的恢复同样使用沙箱有界摘要检查，不读取正文行返回宿主；合法单行文本超过模型正文读取预算不应使对账失败。当前摘要等于计划结果时重新完成持久化屏障并记录完成，等于原内容时才允许原修改继续；其他内容返回冲突。该规则适用于同一次新建、覆盖和编辑的恢复，不将新入站当作原操作重放。
32. 原子替换必须写完并同步临时文件、rename 后同步父目录；覆盖现有文本时保留既有 mode，无法安全保留的元数据须返回明确结果。
    覆盖结果明确返回 `metadataPreservation: { mode: "preserved", other: "not_guaranteed" }`；当前不承诺保留扩展属性、ACL、创建时间等其他元数据。权限位按原值设置，不受创建临时文件时的 umask 改写；失败时仅清理本次确已创建的临时文件。
    临时文件同步失败时不得替换目标，并清理本次临时文件。目标替换后的宿主文件/父目录同步失败时，不提交完成记录；LocalFileTools 边界将系统异常转换为 `local_file_mutation_failed`，不透传系统路径。此时目标可能已改变，失败不能解释为“原文件未变”；同操作恢复须再次完成同步屏障后才能登记完成，不能只凭摘要相符绕过同步。进程退出测试与文件系统 EIO 注入不等同于物理断电或磁盘介质损坏验证。
    同操作恢复时，在当前写入授权范围内精确检查日志所登记的临时文件；身份、内容和元数据仍匹配才清理，缺失可继续对账，被替换/修改或变为符号链接则返回内容冲突并保留，不按名称通配符扫描删除。旧日志通过可空字段迁移，未登记临时身份的旧记录仍走原目标摘要对账。临时文件创建至登记成功之间若被强杀，可能留下无法证明归属的残留；本版不自动清理这些未知残留，也不设置全盘垃圾回收。普通路径检查与删除之间仍存在操作系统级竞态，不宣称可抵御持续主动改换路径的本机对手。
33. `files.edit/write` 返回新的 file reference、内容 hash、大小与修改时间；旧引用不能用于后续修改或发送。
34. 二进制文件可以被查找和发送，但不能进入文本 `grep/read/edit`；`write` 新建文本统一使用 UTF-8，`edit` 保留已支持的 BOM 与换行形态。

### 5. 微信文件发送

35. `weixin.send_files` 采用严格二选一输入：`selected(fileRefs[])` 表示模型已经根据用户意图选定非空集合；`needs_choice(candidateRefs[], allowMultiple)` 表示需要 Input Gate 展示候选。首次展示和重复请求重显都按冻结输入门的选择模式提示：单选只提示一个序号或候选描述，多选才提示多个序号及多选示例；宿主不得为迎合提示而扩大模型提交的选择范围。
36. 所有 reference 必须来自当前可信回合的 `files.find/files.grep/files.read/edit/write` 结果，或来自正在恢复的同一 Pending artifact；模型不能构造路径或跨账户复用引用。
37. 外发预检失败不取得 owner，不创建 Run，并返回结构化错误让模型重新查找、改用新引用或向用户解释。
38. `selected` 在 owner 转移前为所有选中项生成不可变发送快照与 manifest，再持久接受 Run；`needs_choice` 只持久化候选身份、revision、Input Gate 与 Run，不提前复制候选文件。
39. 用户回答待选请求后，只对重新绑定成功的选中项生成快照；候选范围或选中内容真实变化时展示最新候选并再次确认。
40. 发送任意已授权普通文件不限制为 Markdown 或图片，但仍受通道单文件大小、文件数和支持能力约束；目录、Photos Library 内部资源和特殊文件不可发送。
41. 微信通道只读取私有发送快照，不重新打开用户原始路径；发送已有原文件不运行第二次搜索、第二次模型判断或 `files.read`。
42. 每个文件形成独立 `weixin.submit_file` Effect 并按候选顺序串行提交；明确失败继续后续项，任一 unknown 禁止自动重发。
43. accepted 只表示通道接受；手机实际收到只能由真实微信验收确认。rejected、unknown 和权限不足使用用户可理解的结果，不暴露内部通道细节。
44. 多候选提示只有在微信接受后才能绑定为最近 Pending；用户回复一个、多个、全部或自然语言取消时继续复用 ADR-0004 的可信响应桥。同句放弃旧请求并提出完整新目标时，Router 按整句语义返回 new_goal 而不是 cancel；只放弃当前请求且无新目标、无保留候选时才取消。排除部分候选但选择其他候选仍是 respond。
    `needs_choice` 只创建和展示可恢复待选，不发送附件；用户要求先选、暂时不发仍适用，纯名称/数量查询不创建待选。主模型从查询结果直接取引用；校验失败应修正原参数，不删减未被用户排除的候选，不以普通文字选择题冒充成功待选。无法修正时说明未能建立选择，不捏造文件不存在或工具不可用。
    候选变化后的刷新提示同样适用接受后绑定：展示标签与可信 run/signal/revision/有效期必须取自同一份 Engine 快照，不能发送后重新查询并绑定另一批候选。没有唯一有效请求时不生成绑定；未被接受的刷新、已过期请求或指向后来已被替换请求的延迟回执，不能让裸序号恢复当前新 Run。

### 6. 本地图片与旧协议迁移

45. 引用、当前附件和近期图片继续使用可信媒体 artifact；本地图片由主模型先调用 `files.find`，再把 image reference 交媒体发送工具，不进入 Resolver。
46. 明确 Pictures/相册、Downloads/下载、Documents/文档时只使用对应已授权 scope；未知名称不解析为任意路径，来源为空不跨目录兜底。
47. 已完成旧 Run 只保留历史投影；unknown Effect 永不重放。
48. 旧 Run 已经完成搜索并正在等待选择：保留候选 artifact，并通过兼容的私有 `weixin.send_file@1` 完成该冻结运行；兼容能力不再暴露给模型。历史 version=1 路径引用在用户选择后必须通过当前模块授权和文件沙箱生成私有发送快照，使用既有账户快照配额；通道不能接触原始路径。已过期或撤权的候选失败，撤权提示调整本地权限，unknown Effect 不重发。历史引用未保存搜索时的文件摘要，不能宣称检测出自旧搜索以来的内容变化；兼容快照固定的是选择时通过校验的内容，新请求仍按当前候选版本规则处理。
49. 升级时仍在 Resolver 搜索、尚未形成可信候选的旧 Run：安全终结并提示重新发起，不恢复 Resolver thread，也不推断结果。
    接受后尚无计划的 `notes.send-file-resolved` / `media.send-local-image-resolved` 同样退役；只按这两个不可复用的历史模板 ID 识别无计划数据（此阶段未保存模板版本），有计划时仍按 `files.resolve@1` 的 pending 步骤识别。其他缺失模板不归为退役。终结与通知入队同事务提交；此前已标记该退役原因的任务补建一次通知。通知仅使用原 Run 的持久账户/目标绑定，不借用面板当前目标；绑定缺失则保留待通知。发送前持久标记 sending，重启时未结算的 sending 归 unknown；accepted、unknown 和明确 rejected 不自动重发。账户或目标不可用不发送；明确零接受的会话/凭据不可用保留 pending，至少间隔 60 秒再尝试；异常和可能部分接受均归 unknown。通知不查文件、不恢复任务，用户文案为“之前的文件查找任务已结束。若仍需要这个文件，请重新告诉我。”。
50. 新请求只使用新工具目录；`files.resolve`、Resolver Agent 与旧 fixture 已删除。私有 `weixin.send_file@1` 只允许已冻结旧 Run 恢复，不能出现在模型工具目录；确认持久数据中不再有可恢复旧 Run 后另行删除该兼容能力。

### 7. OTel 链路诊断

采用 ADR-0013。覆盖后端可见边界、受控网络和本地读取，不新增诊断 Tab。

### workflow-runs::REQ-063 本地诊断保留原值

- workflow-runs::REQ-063/AC-01：OTel 写入与读取均不使用字段、事件名或枚举白名单；已提供的技术代码及属性原值不改成 other、unclassified 或 operation，不因字段未知静默丢弃。
- workflow-runs::REQ-063/AC-02：账户、目标、入站及 Effect 诊断关联值不再 HMAC；既有文件查询参数保留原值，不仅保存长度或指纹。嵌套诊断属性以 JSON 字符串适配 OTel 属性类型。
- workflow-runs::REQ-063/AC-03：保留已有受控网络采集范围、无外部 exporter/传播头、私有文件权限、轮转、队列/记录/查询资源上限和诊断故障隔离；不新增 HTTP 请求/响应正文、请求头或文件正文采集，不改变微信回复或工具对外错误契约。
- workflow-runs::REQ-063/AC-04：历史 v1/v2 记录仍可读；已经丢失或归类的原值不伪造恢复。日志可能含查询、路径、原始关联值及 SDK 已采集 URL，属于仅供本机维护者使用的敏感文件。

本增量仅改变后台诊断数据口径，无界面变化，豁免原型。测试经真实 OTel 写盘与正式 reader 读回，覆盖新字段/枚举、嵌套值、长字符串、旧记录、实际网络及业务失败隔离；其他文件权限、Agent Loop 和 results 功能不受本轮影响。

51. 用户发送消息后，维护者能关联接收、排队、App Server 可见边界、工具调用、Owner 转移、Pending 恢复与发送结果；没有工具调用或没有进入模型的快路径也有记录。跨回合恢复使用关联或 Span Link，不让一个 Span 跨天等待用户回答。
52. 多个回合、并行工具和多文件发送交错时，记录不能串线；每次调用与发送尝试分别计量。协议成功但领域 envelope 为 `ok:false` 时仍显示领域拒绝，不能仅凭协议成功推断业务成功。
53. 长任务未结束或进程退出时，已结束 Span 之外还需独立关联的开始和进展记录；把开始事件加入尚未结束 Span 不等于已经导出。缺少结束记录只能说明证据未闭合，须与持久任务状态对照，不能自动认定成功、失败或仍在运行。
54. 磁盘满、目录只读、导出队列满或进程硬杀时，允许诊断证据不完整但不得改变业务结果、权限或触发副作用重放；安全丢弃计数、进程实例与序号帮助识别缺口，诊断失败不能递归写入同一个失败出口。正常退出有限时 flush，硬杀或断电不承诺零丢失。
55. 诊断累积达到保留上限时，只轮转专用诊断文件，不影响聊天、Memory、Run、Effect 或操作日志；单条大小、队列、总文件数和总字节均有有限上限。查询须区分保留窗口内未发现、记录已轮转和采集不完整，不能以未见错误证明成功。
56. 用户消息、文件内容、模型输出与工具错误字符串始终是数据，不能成为执行指令；本地诊断原值保留、采集范围与权限边界见 workflow-runs::REQ-063。
57. 维护者只能判断宿主可见的停点、耗时与实际提供的诊断结果；通道 accepted 不证明手机收到，App Server 可见等待不能拆解内部排队和推理。历史摘要/指纹不能还原原文；缺少证据时如实说明，不据此扩大采集或伪造归因。

58. 网络请求由定向 HTTP/fetch instrumentation 自动观察，业务 Span 与网络子项共用标准活动上下文；按 Run 查询必须包含关联的网络子项，并行回合不能串线。只采集受控渠道/本地诊断测试请求，不自动采集文件正文、SQL、模型正文或向外部发送 telemetry。
59. 渠道协议解析集中区分 network、timeout、cancelled、http、provider、invalid_json、receipt_missing、unexpected。HTTP 200 不代表回执有效；结果未知不变成自动重试授权。错误已被处理成返回值时仍保留已有错误类别与原始技术代码，不将未识别代码替换成 other；这不增加异常正文的采集。
60. 多文件操作记录冻结序号、总数和 accepted/rejected/unknown 数量；所有尝试与持久 Effect 可关联。获取上传地址、上传、提交消息分开观察；没有消息提交证据不得宣称手机收到。
61. 自动采集的数据同样适用 workflow-runs::REQ-063；保留 SDK 已提供属性与 URL，不再清空路径或查询参数。不启用请求/响应头或正文采集，不增加外部传播头或 exporter。旧格式仍可读取，开始证据独立于结束 Span。
62. 用真实原生网络路径的本地故障服务验证连接中断、HTTP 拒绝、解析失败、缺回执、取消与超时；仅 mock fetch 或只统计 Span 数不算通过。诊断启停、初始化失败、写盘失败不得改变请求、返回值、重试次数和权限；启动方式须覆盖生产 ESM/tsx 与构建产物。

### workflow-runs::REQ-065 运行时指标

- workflow-runs::REQ-065/AC-05：主服务与实际文件沙箱均不启用 fs instrumentation，不自动生成逐文件操作的 fs Span；既有业务及网络诊断保持可用，历史 fs 记录仍可读取。范围遵循 ADR-0014。
- workflow-runs::REQ-065/AC-02：官方 runtime-node 指标通过本地 MeterProvider 导出，区分主服务和沙箱进程实例，保留名称、单位、数据点类型、时间、聚合语义及值；作为 metrics 保存并能由正式 reader 读回，不伪装为业务 Span。
- workflow-runs::REQ-065/AC-03：metrics 与 traces/checkpoints 共用既有私有目录、轮转、保留时间及总容量限制；兼容历史记录。诊断自身 I/O 不递归采集，无网络 exporter、正文采集或用户目录权限扩张。
- workflow-runs::REQ-065/AC-04：沙箱诊断使用独立于业务 stdout 的有界通道；初始化、导出或通道故障不改变文件结果、权限与重试语义。正常关闭尝试导出短生命周期指标，硬杀允许缺失；不伪造每请求或父子代际关联。

测试决策：复用 LocalDiagnostics 写盘/reader、真实 NodeFileSandbox 权限边界与生产等价微信入口；用实际文件操作验证无 fs 自动 Span，用官方实际 runtime 数据验证指标，不以预制 telemetry 证明自动采集。采集周期默认 30 秒，正常关闭补一次采集；GC 等事件指标仅在事件发生后存在。无界面变化，豁免原型。

metrics 使用低优先级排队：默认总队列仍为 256 条，其中预留 64 条给业务 Span/checkpoint。拥堵时指标记录先丢弃，丢弃计数可读；这不是业务证据绝不丢失的保证，业务自身超限或磁盘不可写仍遵守既有缺口语义。子进程通道每条最多 64 KiB、待写缓存约 256 KiB，超限丢弃且记录计数，不阻塞文件操作。

失败边界：文件查询成功/失败、沙箱重建/短时关闭、诊断写盘失败/队列满、独立诊断通道关闭、指标轮转与旧格式混读；均保持 REQ-063/AC-03 与 REQ-064 的业务隔离。明确不做 fs 插件与其余 fs 手动埋点；沙箱生命周期的集中观测由 workflow-runs::REQ-066 定义。

### workflow-runs::REQ-066 独立沙箱 instrumentation

- workflow-runs::REQ-066/AC-01：公共启动边界记录一次初始化开始、到就绪的耗时与成功或失败；并发调用共享一次初始化记录，复用已就绪进程不重复记录初始化。
- workflow-runs::REQ-066/AC-02：初始化后每次实际沙箱请求独立记录操作类型、请求 ID、开始/结束、耗时及结果；最终结果校验或 prepared 持久确认失败不得被记录为成功。执行计时不包含初始化，包含请求通信、worker 执行、宿主确认与结果校验，不声称是纯文件算法耗时。
- workflow-runs::REQ-066/AC-03：请求超时、进程失效、关闭请求及实际退出分开观察，记录触发请求、退出码或 signal；同代际其他等待者能关联首个失效原因，不被随后 kill/exit 覆盖。
- workflow-runs::REQ-066/AC-04：调用关联父工具 span、沙箱实例、worker 实例和递增代际；同一 worker 的 runtime metrics 使用相同实例与代际关联。旧进程迟到事件仍可记录，但不结束新进程的请求。
- workflow-runs::REQ-066/AC-05：每个已开始请求只收尾一次；正常关闭、初始化中关闭、执行中关闭、协议损坏与启动失败均保留可观察结果；开始 checkpoint 独立于完成 span，硬杀宿主允许证据未闭合，不推断业务终态。
- workflow-runs::REQ-066/AC-06：集中封装 instrumentation，仅在公共生命周期边界接线，不在各文件算法埋点。不改授权、init/execute 5 秒 deadline、关闭宽限、重建或不重放语义，不新增正文、外部 exporter、fs 插件或 LLM 观测重构；诊断关闭、初始化/写入/导出故障不能影响业务。

测试决策：复用真实 NodeFileSandbox 的公开 execute/close/权限探测接口、可注入 worker 路径、真实 OTel 写盘与正式 reader；真实进程停顿、退出和协议故障验证关联，不用预制 span 证明接线。补生产等价微信入口查询及发送回归。无界面变化，豁免原型。其他 Agent Loop、results、查询策略与权限功能不受本增量影响，只承担共享边界回归。

### 文件沙箱生命周期修复（workflow-runs::REQ-064）

- **AC-01** 初始化失败、请求超时、通信失败或子进程退出使当前沙箱代际失效；终结该代际的所有等待请求。同一回合的下一次显式文件调用可以重新初始化，不复用已失败的启动 Promise 或死亡进程。
- **AC-02** 每个请求、数据帧、超时和写入/退出回调绑定对应子进程身份；旧代际迟到事件不得关闭新进程、污染新帧缓冲或拒绝新请求。并发初始化共享一次启动；失败后允许下一批调用重新启动。
- **AC-03** 重建沿用该实例的冻结授权，调用者仍执行原有实时权限和预算校验。普通文件缺失、冲突、权限或有界结果拒绝不是进程失效，不触发重建。
- **AC-04** 失败调用只返回一次失败，沙箱不自动重试查询、修改或发送；已写入但结果未返回时继续遵守操作日志和 CAS 对账，不因恢复进程重放操作。是否提出后续查询仍由主模型决定。
- **AC-05** close 为有界、幂等且永久关闭：终结等待者及尚未退出的旧/新子进程，同时关闭的调用者等待同一清理过程；close 后不得再次启动。signal 退出不能误判为仍存活。

本修复保持 init/execute 各 5 秒请求 deadline、1 秒关闭宽限；读取类搜索超时的领域反馈按 workflow-runs::REQ-069，修改类失败协议不变；不以该修复宣称已查明历史首次超时的内部阶段。

## App Server 回合封装

### workflow-runs::REQ-067 连接机制与回合生命周期集中封装

适用范围：主微信模型路径的宿主封装，以及共享连接实现的既有调用者兼容性。以下细化既有 Turn Driver 约定；模型决策、文件算法、持久副作用与业务 results 的定义不变。

- workflow-runs::REQ-067/AC-01：连接 Module 独占当前连接的请求关联、响应去重与连接故障分发；Turn Driver 独占活动回合的事件推进、最终消息选择、无进展检测与释放。微信业务调用方不再维护 Tool Host binding、读取 Owner 快照或以空字符串判断工作流接管；只消费模型文本或可信工作流回执的判别结果。
- workflow-runs::REQ-067/AC-02：沿用每条主模型入站最多一次 turn/start、Pending 快路径零次及同目标 Durable Inbox FIFO 的规则。服务端请求按原 JSON-RPC ID 回应，异步完成顺序不改变关联；重复请求不重复执行。同一 ID 的迟到响应不得落入其他连接或回合；无法投递响应不等于撤销已经发生的副作用。
- workflow-runs::REQ-067/AC-03：在提交 Turn 前注册事件接收与资源归属；启动请求在途时保留合法早到事件，响应返回后确认 turnId 一致，不丢失先到的工具或完成事件。完成、中断、失败、退出和迟到回调只结算一次；Turn 已结束后迟到响应不能重开计时器、重新激活 Driver 或重复报告接受。旧连接、旧 Turn 的事件不得污染新调用；启动身份冲突显式失败，不猜测归属。
- workflow-runs::REQ-067/AC-04：工具绑定成功才可启动 Turn；部分绑定失败时逆序释放已取得资源。完成或异常路径统一处理权限收尾、服务端请求结算、异步工具结束与绑定释放，不遗留未观察的清理 Promise；本地调用已结束后才取得的订阅、资源或工具结果仍须被观察并纳入清理。清理失败保留诊断及真实业务结果，不能宣称副作用已回滚或自动重放；旧调用尚未安全结束时不把其权限或资源交给下一回合。本地停止消费、远端中断、在途工具排空和连接关闭是不同操作，释放订阅不证明远端 Turn 或已接纳副作用已停止。
- workflow-runs::REQ-067/AC-05：Owner 的真源仍为 Tool Host 与持久工作流；Driver 只读取其可信回执，不能根据模型文本或业务 results 推断接管。预检失败保持模型 Owner；成功接管后的模型错误、断连或无最终文本不覆盖回执、不撤销 Run、不重发 Effect。回执缺失不得退回模型回答，也不得伪造成功。
- workflow-runs::REQ-067/AC-06：沿用权威完成消息优先级与 results 协议；模型文本仍在微信答复层解析为 message/results，工作流回执不进入该解析器。onAccepted 只在对应微信正文被通道接受后触发，Driver 不自行确认手机收到或提前消费 Pending 展示绑定。
- workflow-runs::REQ-067/AC-07：初始化 20 秒、单次请求 failsafe 600 秒、生产无进展 300 秒及无整个 Turn 总时限的配置保持不变；各专项 profile 的显式覆盖不变。无进展计时只消费当前回合有效进度，诊断轮询或其他回合活动不能续期。idle 沿用本地回合失败与清理，不新增自动远端中断、共享连接隔离或重启；不能据本地收口声称远端已停止。显式中断或连接失效不重放原入站或工具。
- workflow-runs::REQ-067/AC-08：主微信每轮 outputSchema、模型/effort、工具定义、权限快照、输入顺序与上下文保持兼容；不因内部类拆分改变 toolContractHash、访问上下文代际、持久 thread ID 或强制重建历史会话。Curator、Pending Router 与独立探针保持其原有输出协议和 profile。
- workflow-runs::REQ-067/AC-09：现有生命周期与工具观测继续经过公共出口，保持当前 trace、回合、请求与工具关联；真实协议失败与工作流结果分别记录。观测回调或诊断出口失败不改变执行结果，不新增正文采集或散落业务埋点；初始化、执行、最终消息等待及清理计时不得互相冒充。
- workflow-runs::REQ-067/AC-10：封装回归复用生产微信入站与 App Server 协议 seam。预设模型事件也经过生产 Turn Driver、工具绑定与执行器；live 模型用例不注入工具选择。分别验证结构化回复、实际文件身份/数量/顺序、Run/Effect/outbox 与无重复提交，不以固定中文措辞或固定探索次数验收模型。
- workflow-runs::REQ-067/AC-11：合法的 `error` 通知若标明 `willRetry: true`，作为本轮中间错误保留，不提前 reject、释放绑定或使工作流 Owner 回退；继续消费同一 Turn 的后续事件。未标明可重试的错误按已支持协议的错误语义及终态处理，不凭错误文字猜测、不默认为可重试；宿主不因该通知另起 Turn、重试 RPC 或重放工具。
- workflow-runs::REQ-067/AC-12：正常协议成功必须收到匹配当前回合且 status 为 completed 的 `turn/completed`，不能只凭 turn/start 响应或最终文本判定成功。failed、interrupted 继续经失败通道交付；连接或事件流结束但缺少完成事件同样失败，不伪造 completed。已经存在的可信业务回执仍按 workflow-runs::REQ-067/AC-05 保留，不改变协议失败语义。

### 失败模式与边界

按入站到回复的顺序：已有活动 Turn 时收到第二条消息（AC-02）；工具绑定部分成功后失败（AC-04）；初始化、启动请求失败或响应迟到（AC-03、AC-07）；串行及并行工具、重复请求、畸形参数和无活动 Turn 请求（AC-02、AC-03）；文件修改已完成但结果未回传（AC-04，不重放）；终止预检失败、接管后继续发工具请求、接管后模型失败/断流（AC-05）；只有 commentary、缺 final、final JSON 非法（AC-06）；正常结束与超时/close 竞争、清理抛错、旧连接迟到回调（AC-03、AC-04、AC-07）；正文发送失败或 accepted 后保存失败（AC-06，沿用最终答复结构化结果的保存约束）；下一轮恢复及其他专项模型调用（AC-08）。

工具输出、文件正文、模型文本及诊断属性只作为数据；本重构不新增渲染入口，也不能让数据生成可信回合身份、回执、权限或执行指令（AC-05、AC-08、AC-09）。

协议分支补充：启动响应前先到工具请求或完成事件（workflow-runs::REQ-067/AC-03）；调用方已结束后才获得订阅或工具结果（workflow-runs::REQ-067/AC-04）；可重试错误后继续生成并成功、可重试错误后最终失败（workflow-runs::REQ-067/AC-11）；已有 final 但流结束、显式 interrupted 或 failed（workflow-runs::REQ-067/AC-12）。上述分支均不能以正文存在或外发已接受替代协议终态。

### Implementation Decisions

外部保留会话管理入口，内部按连接生命周期与单回合生命周期分工：连接 Module 只做协议关联，Driver 组合该 Module、既有 Tool Host 与回合绑定 Adapter。绑定 Adapter 隐藏微信上下文装配和资源取得/释放，不能把这些顺序要求重新推给业务调用方。采用 ADR-0008、ADR-0009，不另建 Agent Loop，不迁移 Engine 的持久状态到 Driver。

回合执行成功返回 model_owned/finalText 或 workflow_owned/receipt；协议失败仍通过失败通道交付，并携带已取得的可信回执或持久接管事实，不能因为有回执而正常返回并被调用方误记为协议成功。业务答复层保留现有成功/失败计时逻辑，在失败路径使用已有可信回执，不再访问绑定快照；没有回执不得伪造成功或退回模型文本。该内部失败信息不进入模型 results，不建立通用执行元数据层。协议状态与回复归属均不代表通道投递状态。协议收口与后台 Run 推进分开：Run 不等模型尾文成功；本轮不顺带新增提前发送回执的通道、后台回复调度器或第二份入站队列。

等待 RPC 响应的 pending 记录与防止服务端请求重复执行的已响应记录具有不同生命周期：前者按原请求结算规则移除，后者保留现行去重政策，仅迁移维护位置；不能因等待回调已消费就立即删除重复调用防护。不新增 TTL、LRU 或关闭回合后的淘汰规则，也不声称已解决长连接记录累计。绑定与停机的异步释放是既有生命周期义务的补齐，不等于新增远端恢复策略。具体关闭抢占及硬退出政策不在本轮默加。

连接 Client 与每轮 Driver 的机制可参照通用 App Server 客户端的连接路由与 TurnHandle/结果收集器；不复制服务端模型循环或另建框架层。微信可信接管回执、绑定与在途副作用排空仍为本地业务扩展，不以通用 SDK 返回值替代。宿主 Turn 有效进度 idle 与模型 SSE 流相邻事件 idle 不是同一计时对象；本轮保留 workflow-runs::REQ-067/AC-07 的本地预算，不从上游某个客户端默认值推导替换。

### Testing Decisions

复用既有可注入 Transport 的协议 seam，覆盖上述可达竞态，并在最高层生产等价入站验证绑定、Owner、results、发送及持久记录的组合。连接机制断言原 request ID 与唯一响应是协议要求，不断言私有 Map 或偶然方法调用顺序。保留真实模型协议门禁、每轮 30 秒有效进度空闲预算、每例 120 秒总预算与隔离取证。以故障注入/假时钟证明迟到与超时分支，不用短时 live 成功推导长任务安全。

中间重试错误和终态错误分别验证；最终文本已经出现也必须覆盖缺少完成事件及非成功终态。订阅释放与显式 interrupt 分开断言；RPC 等待者清理与已响应服务端请求去重分开验证，不用私有表大小代替行为证据。既有生产等价 seam 不变，不添加测试专用语义路径。

无界面变化，豁免原型；不新增模型、语义评分、权限、重试策略、ServiceWatchdog 或诊断平台。其余产品能力不在本轮重新宣称完成；相关共享规则承担回归。

## 最终答复结构化结果

主模型拥有回复权的微信回合已支持结构化 message/results、可信关联持久化与业务结果断言；严格协议边界、历史兼容及回复后保存失败提示已实现。完整故障组合和本节全部约束的生产一致验证仍须逐项核对，不能将已实现主流程等同于全部验收通过。

### Problem Statement

自由文本的等义回答不应因为不等于某个固定句子而被测试误报。工具返回只描述一次调用，不能代表经过多次查询、修正和执行后的业务结论。需要在最终答复层增加可断言的结果，同时不制造第二份执行状态。

### Solution

主模型在原有 Agent Loop 的最终答复中同时给出用户正文与业务结果数组。宿主只校验结构、关联保存并发送正文。终止型工作流继续遵循 ADR-0008 的独占回复权，搜索判断继续遵循 ADR-0009；这里不改变工具输出、搜索策略或副作用真源。

### User Stories

- 作为用户，我希望收到自然语言回复，而不是 JSON、内部错误码或工具机制。
- 作为维护者，我希望以稳定业务分类和实际执行证据检验结果，不因等义中文表述不同而误报。
- 作为用户，我希望一次答复能说明多个目标的不同结果，但不会因此重复发送或擅自恢复旧任务。
- 作为维护者，我希望格式错误与业务失败能区分，并在升级、重启和多轮交互后仍能找到对应结果。

### 契约与分类

顶层字段为 message 和 results。results 是数组；每项字段为 subject 和 status。subject 仅帮助人读懂该项，不建立任务身份。以下编号同时作为本增量独立的约束锚点。

- **FR-01** 主模型拥有回复权时，最终答复为包含 message 字符串与 results 数组的严格对象；每个结果仅包含 subject 字符串和 status 枚举，不接受缺字段、错误类型或额外字段。
- **FR-02** 普通聊天没有业务操作结论时返回 results 空数组；空数组不同于未产生结构化结果。
- **FR-03** results 按本轮业务目标组织，而非按 tool 调用组织；同一目标经过多次查询仍是一项，独立目标可有多项，不因数组增加多工作流执行能力。
- **FR-04** subject 只是简短业务目标描述，不是稳定 ID，不用于绑定、路由、选择或执行；不得以 subject 的固定措辞作为测试真值。
- **FR-05** status=completed 表示所述业务目标已经完成，不表示手机已收到或所有其他目标均完成。
- **FR-06** status=partial 表示同一业务目标只完成一部分；独立目标分别成功与失败时分别报告，不额外插入汇总 partial。
- **FR-07** status=not_found 表示当前查找目标未找到；分类由主模型结合上下文和实际工具观察完成，不把一次工具零结果直接映射成终局。
- **FR-08** status=needs_input 表示继续处理需要用户补充信息或选择；它本身不创建、绑定或恢复 Pending。
- **FR-09** status=blocked 表示权限、政策或前置条件阻止继续；不另设 declined 类型。
- **FR-10** status=failed 表示已知执行失败，不用它表示无法确认结果。
- **FR-11** status=cancelled 表示目标已取消或放弃，不是取消命令；取消仍由现有交互机制处理。
- **FR-12** status=in_progress 表示本轮结束时所述工作仍在进行，不新增后台任务或监听机制。
- **FR-13** status=unknown 表示实际结果无法确认；它不是任意未知枚举的兜底，也不授权重发。

### Implementation Decisions

复用既有主会话 App Server 协议、权威 final 选择、聊天持久状态与正文发送边界。结果只在模型仍拥有回复权的收口路径生效；工作流路径不新增结果合成器。持久记录中的契约版本与可信关联属于宿主元数据，不要求模型生成。协议输出受已有帧与消息资源预算保护，不扩大文件或模型执行预算。

- **FR-14** 每次主微信会话 turn/start 均显式传入最终答复 outputSchema；同一线程下一轮不能依赖上一轮自动继承。
- **FR-15** 提示词给出字段、类型的简短语义和基于上下文及执行证据的通用要求；不加入业务关键词枚举、固定查询路径、独立分类模型或宿主语义兜底。
- **FR-16** 结构化最终输出与现有 App Server 工具循环同时工作，保留配置的模型与 effort；不复用会禁用工具的 Curator 或 Router profile。
- **FR-17** 只解析既有规则选出的权威最终 agentMessage，并以 Turn 完成状态收口；commentary、delta 和中间 JSON 不能触发用户最终回复。
- **FR-18** 模型拥有回复权时，只将 message 送入现有微信正文发送与展示链路；results、JSON 包装和协议错误细节不发给微信用户。
- **FR-19** message 继续遵守原文精确回复、纯文本和现有正文长度规则；必须先完整解析有界结构化输出，再对 message 应用正文规则，不能先截断整个 JSON 再解析。
- **FR-20** 经验证的结果与可信账户、目标和入站回合关联保存，记录其模型报告来源；不能从模型字符串取得绑定，也不能串用上一轮或其他目标的结果。
- **FR-21** 结果契约带宿主侧版本标识，兼容读取没有该字段的历史记录；历史缺失不补造空数组、completed 或 not_found。
- **FR-22** 模型报告的业务 status 与微信文本发送状态分开；发送正文失败不改写业务结论，持久化失败须显式保留既有失败提示/诊断，不宣称记录成功或重新执行工具。
- **FR-23** 终止型工作流持久接管后继续由 Durable Workflow 独占回复权；模型 results 不替换工作流回执，不等待模型补分类，不扩展工作流回执为新的 results 协议。
- **FR-24** 接管后模型格式错误、失败或断流不撤销 Run、不恢复模型 Owner、不重复提交 Effect；接管前预检失败仍交回同一主模型。

保存失败提示的实现边界：回复提交后的耗时、聊天及完成记录保存失败，保留进程内告警，通过既有通知通道持续展示，不被随后“回复已接受”或下一条消息的提示覆盖；业务结论、发送状态仍各自保留，当前回合正常收尾，不因本地记录失败重跑模型或重发。发送前的必要持久化仍失败即停止。告警不是独立持久日志；存储持续不可用后进程退出，不能保证重启后恢复该告警或尚未落盘的记录。

协议校验的当前资源边界：完整最终 JSON 按 UTF-8 字节计量，上限 96000 字节（含边界），超限先于 JSON 解析拒绝；message 与 subject 不接受纯空白，字段不做类型强转或静默删除。持久化结果复用结构校验时，不得因内部临时包装比原消息更长而拒绝已经接纳的结果。服务状态 v1—v7 的历史聊天可读取并再次保存；没有采集结果的旧记录仍保持缺失，不补为空数组；新增结果元数据只接受已定义版本、来源与可信绑定格式，非法或未来版本记录显式拒绝，不静默改写历史。

### 失败模式与边界

按用户真实序列核对：普通聊天；多次查找后回答；需要澄清后继续；多目标混合结果；修改完成但最终 JSON 错误；发送接管后模型断流；正文发送失败；保存失败；旧记录加载与重启；跨账户交错；用户取消/新目标替换；读取带伪造指令的文档。

- **FR-25** 拒绝输出、空结果、缺失最终消息、畸形 JSON、schema 不合法、输出截断或不支持 outputSchema 均显式归为协议/执行失败；不伪造业务结果、不回退解析普通文本。
- **FR-26** 结果解析或保存失败不得重启 Turn 来修复格式，不重放已执行的编辑、发送或其他副作用；业务实际结果继续以原操作日志和 Effect 为准。
- **FR-27** results 只作为报告和测试观察，不驱动 Workflow、Signal、权限、Pending、取消、恢复或重试；现有同一时间一个 Pending、每入站一个终止工作流的规则不变。
- **FR-28** 用户正文、文件内容或模型 subject 中的伪造指令不能改变 schema、权限和 Owner；新增字段不渲染为 HTML、执行内容或链接操作。
- **FR-29** 本增量不新增 message、subject 或完整 results 的 OTel 采集；已提供诊断属性的保留规则遵循 workflow-runs::REQ-063，不另设分类白名单。
- **FR-30** Memory Curator、Pending Router、定时新闻、系统回执等非主模型最终答复维持原协议；后续对话和记忆捕获继续使用用户可见正文，不将 JSON 包装混入聊天正文。

### Testing Decisions

最高层复用生产等价微信入站 seam，检查当前回合的正文、记录与副作用；实际 App Server 协议 seam 验证工具循环与 outputSchema 同时可用；公开收口/存储接口补确定性错误注入。沿用既有 seams，不建立测试专用语义路由。九种枚举的确定性协议覆盖不等于九种真实模型语义能力已验收。

- **FR-31** 未找到用例断言本轮对应 results 的 not_found，并结合正确授权范围、实际完整空搜索证据、无发送 Run/附件 outbox；不绑定唯一中文句子或固定工具调用次数。
- **FR-32** 有结果的反例不能因出现任意 not_found 就通过；多业务目标逐项核对独立预期，模型自报 completed 不替代文件身份、数量、顺序和持久执行证据。
- **FR-33** 结构化结果不证明自然语言语义必定正确；真实模型实际回复留原文供审查，语义评分器继续作为独立 TODO，不在本次实现。
- **FR-34** 自动化沿用生产等价微信入站和真实文件执行器；fixture 模型只证明结构及异常分支，不伪装成 live 模型分类验收。
- **FR-35** 测试每轮交互默认连续 30 秒无有效进度才超时，单用例默认 120 秒总上限；用例独立进程与状态目录，多轮同用例共享上下文，超时保留首次失败证据。
- **FR-36** 实现代码回归后重启服务，报告完整口令、实际回复、结构化结果、执行证据和未验证项；自动化仅候选通过，真实微信同口令结果经用户确认才算验收。
- **FR-37** 实现交付同时同步 spec、features、相关 ADR 与 CONTEXT 的本次范围；未实现事实保持 Pending，不把本次文档检查当成运行验收。

### Out of Scope

- 语义评分器、Promptfoo 部署、独立语义分类/修复模型。
- 修改 tool 返回 envelope；重建 Resolver 或 Intent Planner。
- 通过 results 驱动执行、权限、Signal、取消、恢复或后台监控。
- 统一改造工作流回执及定时任务为新的 results 协议。
- 新增 UI、诊断 Tab、原文 telemetry 或用户可见状态控件。
- 一轮多个终止型工作流、跨业务任务 ID 和自动副作用重放。

### Further Notes

界面原型门豁免：本增量仅改变后台数据契约，微信继续显示原有纯文本正文；没有新增页面、控件、布局或状态形态，错误沿用现有通知通道。结构化不等于语义正确，用户感知一致性仍须审查实际回复。既有 spec 其他 Pending 的核销不属于本增量，不据此宣称全模块已经完成。

## Implementation Decisions

- 采用 ADR-0008；ADR-0007 已被取代，无 Resolver、主模型唯一语义 owner 与严格 member 原则继续保留。
- 采用 ADR-0009：文件搜索观察回灌主模型并允许多轮查询；新请求不调用模型型 Query Rewriter，未来也不恢复独立文件语义层。
- Codex Agent Runtime 是唯一 Agent Loop；App Server 是宿主使用该循环的双向协议接口。微信宿主只负责建立/恢复 Thread、为进入主模型路径的入站最多启动一次 Turn、消费事件、响应服务端工具/权限请求和读取最终状态；Pending 回答快路径不启动 Turn。同目标已有活动 Turn 时，后续独立入站由 Durable Inbox FIFO 排队，禁止用 `turn/steer` 合并，不实现第二套模型调用循环。
- App Server Turn Driver 是宿主侧单回合协议 Adapter，连接关联由其内部依赖的连接 Module 承担；成功输出为 `model_owned + finalText` 或 `workflow_owned + receipt`，失败及清理语义统一见 workflow-runs::REQ-067。它隐藏单回合事件状态机、最终消息选择、watchdog、Tool Host binding 生命周期和接管后事件排空，不选择工具、不生成查询、不决定模型下一步。
- Dynamic Tool 的标准推进顺序为 `item/started(dynamicToolCall) -> item/tool/call -> client response -> item/completed(dynamicToolCall)`。客户端必须以原请求 id 恰好回复一次；结果返回后由 App Server 在同一 Turn 内继续模型执行，不以新的 `turn/start` 回灌结果。
- JSON-RPC request id 仅用于当前 App Server 连接上的请求关联、重复响应抑制和恰好一次回复，不能作为持久操作身份。本地修改的跨崩溃幂等由 File Operation Journal 与稳定 operation key 保证；外部发送的跨崩溃幂等由 Run/Effect ledger 保证。
- Tool Host 不采用全局 FIFO。`inline_query` 可在原子预留共享预算后并行，`inline_mutation` 按稳定资源身份串行，`terminal_workflow` 每个 Turn 最多一个成功接管；暂时串行某类工具只能作为实现限制，不能成为模型语义规则。
- `item/agentMessage/delta` 只作为非权威流式信号；微信最终模型回复来自 `item/completed` 的权威 `agentMessage` 集合。优先最后一个 `phase=final_answer`，没有时再取最后一个未提供 `phase` 的消息；明确标记为 commentary 的消息永不成为回复。模型仍持有 Owner 且没有候选时按 Turn 失败处理，不回退 delta。
- Tool Host 以 `model_owned -> terminal_preflighting -> workflow_owned` 管理终止型接管。开始预检后停止接纳新 mutation/terminal，等待已接纳 mutation 完成再持久化产物和 Run；成功后返回 `workflow_claimed`，用户可见回复 Owner 交给 Durable Workflow且不可回退。App Server Turn 随后正常完成，binding 保留到 Turn 完成或 watchdog 清理，接管后的新工具请求返回 `workflow_turn_already_claimed`。成功路径不调用 `turn/interrupt`，宿主丢弃该 Turn 的模型侧用户回复候选并使用持久工作流回执。
- Owner 一旦在持久预检后转移，App Server 后续生成失败、断流或收口超时只记为模型侧诊断，不能撤销 Run、重复提交 Effect 或把最终回复 Owner 退回模型；Durable Workflow 的推进与用户回执不依赖后续模型文本成功生成。
- Gateway 在可信 submit 返回后先保留接受身份，再读取运行并投影回执；投影失败时仍向 Tool Host 返回已接管事实及诊断错误码。现有微信入口在排空后读取该事实，有回执只使用回执，没有回执沿用现有失败提示，不解析模型尾文、不伪造发送成功、不重新提交。诊断分别记录接管身份、回执投影失败与协议/清理结果，模型阶段的结束时间取清理开始前，成功或失败状态等协议收口后再填写。
- 工具领域结果统一编码为有界 JSON envelope，并放入 Dynamic Tool 的文本 content：成功为 `{ok:true,data,meta}`，预期内的参数、权限、引用、预算和业务拒绝为 `{ok:false,error:{code,retryable,action,fieldIssues?}}`。这类可修正领域错误在协议层以 `success:true` 完成请求，使 envelope 能稳定回到模型；只有 Tool Host 崩溃、未处理内部异常或协议传输失败使用 `success:false`，并在协议允许时附带不含敏感信息的安全错误 content。
- 除结果条数外，工具结果还受序列化字节预算约束；大量 skipped 项按原因聚合，分页或截断必须显式返回完整性和 cursor，不把无限明细写入模型上下文。
- Agent Loop 的生命周期信号分层：`item/*` 是工作单元权威状态，`turn/completed` 是 Turn 状态，Durable Workflow 是外部副作用与待选状态真源。三个层级不得互相伪造完成或中断。
- 模型可见工具名不带内部版本后缀：`files.find`、`files.grep`、`files.read`、`files.edit`、`files.write`、`weixin.send_files`。Catalog 内部活动版本分别为 find/grep/read v2 与 edit/write/weixin.send_files v1；同一模型可见名称同一时刻只允许一个活动内部版本，版本参与 `toolContractHash`。旧 `files.send` 不再注册。
- 工具 schema 同时面向宿主校验和实际 App Server 的模型可见声明。条件写入使用完整对象的联合结构，不能让必填参数退化成 `args: unknown`。参数纠正反馈指出 schema 已知的缺失字段，不回显未知键名或输入值；`files.write` 始终要求 scopeRef、相对路径、正文与显式 overwrite，覆盖仍必须带 expectedSha256。
- 当前授权 scope 的 opaque reference、显示标签和读写能力作为有界 File Access Context 随可信回合注入；它不改变工具 schema，因此调整目录授权不改变 `toolContractHash`。收窄读取权限改用独立的 access context epoch 轮换关联 thread。
- File Tools 是一个深 Module。它的外部 Interface 只接收结构化操作与可信访问快照；目录遍历、匹配、排序、cursor、预算、path containment、no-follow、reference 生命周期、内容窗口、原子替换和 CAS 均隐藏在实现内。
- `files.find` 的工具说明描述“提取可能真实出现在名称或路径中的区分性词”和“零结果可改写重试”，不枚举要删除的中文词。fuzzy 匹配器只做通用 Unicode term 切分与相关度计算，不进行自然语言意图判断。
- 每次文件工具调用记录 tool/version、执行语义、耗时、返回字节数、协议与领域结果、Owner 和实际错误码。find/grep 诊断保留完整查询参数（含非法字段和值）及既有完整性、数量摘要；其他工具继续只收集既有摘要，不新增文件正文或完整返回内容。
  - 索引选项与长度/数量摘要继续用于检索；find/grep 的 queryInputs 保留模型提交原值，包含 query/pattern/cursor、scopeRefs、glob、sort 等，不再生成 HMAC。嵌套属性使用 JSON 字符串，便于 OTel 与本地 reader 一致保存。
  - 读取或 grep 结果超过预算/协议帧时返回可识别错误，模型可缩小行窗口、结果数量或上下文；不得因可预期的大结果终止沙箱进程。
  - 结果计数区分本页 entries 与 matches；skipped 只聚合本次工具结果已经返回的原因与数量，已返回的字符串原因原样保留。这些计数不表示全部扫描结果，也不承诺涵盖结果预算已省略的 skipped 明细。
- 诊断采用 ADR-0013 和 ADR-0021：复用 OTel API/SDK 的统一业务边界，叠加定向自动 HTTP/Undici instrumentation 和集中渠道协议分类，配合薄本地 JSONL exporter 和带 Trace/Span 关联的开始、进展日志；不依赖独立观测平台即可读取本地证据。文件导出、轮转和只读查询属于本项目适配，不声称是 SDK 自带的持久存储或查询能力。
  - 自动网络记录共享标准活动上下文与允许的关联字段，按 Run 可直接查询子项；采用空外部 propagator，不向渠道注入 traceparent/baggage。完成记录与开始 checkpoint 保留已提供诊断属性，输出 v2 并兼容读取 v1。
  - 协议诊断先覆盖图片和任意文件共同的上传地址、上传和提交消息三个阶段。文本回复独立计时、登录和其他非媒体流程不在这轮集中协议观测范围，不声称所有渠道操作都有相同错误细节。
  - 多项发送在统一 Engine 映射处记录冻结序号与总数，聚合 selected/attempted/accepted/rejected/unknown/notAttempted；汇总是可丢弃观测，不是第二份执行真源。
  - 默认启用，保存在 `~/Library/Logs/codex-weixin/otel/`；fixture 使用独立临时状态目录。目录 0700、文件 0600，分开保存 traces/checkpoints/metrics，文件名含创建时间、进程和随机实例标识，重启不覆盖；禁跟随最终目录及文件符号链接。
  - 每小时或单文件 20 MiB 封口，封口后保留 7 天；总计最多 200 MiB、512 个诊断文件（包含活动文件），容量优先于天数。启动、轮转、I/O 失败后和闲置小时维护重新核对目录；写入时按增量统计执行有界清理；休眠或停止时不能执行，恢复后补清理。仅清理符合本出口命名的普通文件，活动文件不淘汰；确认写入进程已退出的遗留 open 文件以 mtime 作为封口近似时间。
  - 单条最多 64 KiB，写入队列最多 256 条；超限丢弃而非阻塞业务。计数随后续成功记录保存，持续不可写时不能承诺计数也落盘。正常退出最多等待 5 秒；flush 表示已处理文件写入队列，封口执行 fsync，硬杀/断电仍可能丢失最后一部分。
  - JSONL version=2 兼容历史 version=1，不是标准 OTLP JSON；OTel 属性仅做类型适配，不使用字段/值/名称白名单。关联值不再 HMAC。SDK 每 Span 最多 64 个属性与单条记录预算仍有效，超限属于资源缺口，不是隐私脱敏；无 SDK resource 或 exception body 新增出口。
  - 只读查询默认读取近 24 小时、最多 8 MiB/200 条；最多可请求 200 MiB/10000 条。支持时间、Trace ID、Run UUID；对文件并发写入、截断尾行、不可读、未知格式、查询预算和缺失结束记录分别报告证据限制，不把未找到解释成从未发生。
  - 诊断只观察既有 Agent Loop 和 Durable Workflow，不创建新的语义 owner、不重放操作。Trace/Span ID 不代替持久操作幂等键；Run/Effect/操作日志继续作为执行与恢复事实源。
  - 本地诊断不脱敏，也不外发；共享前应人工审查。写入与正式读取器同时验证。诊断不是授权来源，普通控制台输出也不能冒充稳定 JSONL 契约。
  - 首期只覆盖后端链路与本地读取，无新增界面形态，豁免界面原型门；独立诊断 Tab 与新增全文采集不属于本期交付。
- Agent Tool Host 区分 `inline_query`、`inline_mutation` 与 `terminal_workflow`。前两类返回结构化结果并保持模型 owner；终止型工作流只在准备产物和 Run 均持久化后取得 owner。
- Tool Catalog 使用判别联合路由三类 member：内联工具绑定 Local File Tools Interface，不要求工作流模板；终止型工具必须绑定模板与 effect class。Catalog 统一生成模型可见定义和 contract hash，但不假设每个 member 都提交 Run。
- 旧 `WorkflowFilesProvider` 与 Query Rewriter 实现已经删除；文件遍历、匹配和排序只由 `LocalFileTools` 深 Module 执行，不建立第二套文件算法。
- 查询和本地修改都不创建持久 Run；Local File Tools 在宿主侧持久化修改操作日志，沙箱进程状态保持可重建。每个可信回合有聚合文件预算：工具调用次数、扫描文件数、扫描字节、grep 字节、读取字符、写入字节、结果项和墙钟分别计量，不用一个 `limit` 代替全部预算。File execution time counts active work once per turn, excluding query queue waiting and model thinking; query waiting follows workflow-runs::REQ-072. The default execution allowance remains 60 seconds. Recheck before admitting queued work; never reset consumption between batches or retries, and do not interrupt an admitted atomic mutation or treat this as a whole-model-turn timeout.
- 修改幂等键由可信事件、工具版本、解析后的稳定资源身份、前置内容 hash 与规范化修改请求生成；不能使用模型参数中的 operation ID、随机 reference 或 App Server 临时请求 ID。
- File Sandbox 内部修改协议采用 prepare/commit；发送快照写入每个沙箱专属的私有 spool 子目录，该技术写权限不授予修改用户 scope 的能力。发送 manifest 持久绑定账户、目标、资源身份、sha256、大小和安全文件名。
- 不设置主模型 Turn 的绝对时长上限；App Server 初始化上限 20 秒，单次 JSON-RPC failsafe 10 分钟，模型/协议无进展约 5 分钟时本地失败收口，不据此声称已发送远端中断或已停止 App Server Turn。单个本地文件操作另有短 deadline，外部发送沿用独立 Effect timeout。本次封装的兼容范围见 workflow-runs::REQ-067/AC-07。
- 无进展计时器在模型事件、工具请求、工具响应和其他有效协议进度发生时刷新；工具仍在受控执行但持续产生进度时不误判为卡死。工具调用次数、聚合预算或输出字节预算耗尽时返回最终结构化错误，不允许无限工具重试。
- `weixin.send_files` 只接受 reference 和选择 disposition，不接受 query、路径、账户、目标、模板、Provider、DAG、权限或 operation ID。Gateway 从可信回合与 reference store 绑定这些字段，并以 `continue` 或 `claimed` 明确返回是否发生 owner 转移。
- `weixin.submit_file` 是内部单文件通道能力，不对模型公开；旧 `weixin.send_file@1` 只服务可恢复冻结 Run，迁移完成后删除。
- 本地图片的媒体语义暂保留独立 member，但移除其中的查询、排序和 Resolver 职责；它只消费可信媒体/file reference 与可选 caption。
- 文件沙箱设计见 `workflow-module-permissions.md`；该沙箱仅覆盖 `files.*` 本地访问，不包裹微信通道 Effect。
- 本轮不改变运行面板和权限页布局；补充“读取结果会进入当前 Codex 会话”和“账户目录可供该账户下已启用目标使用”的权限说明属于纯文案调整，显式豁免新增视觉原型。

## Testing Decisions

- E2E单个用例默认120秒总上限；单轮交互默认30秒空闲超时，覆盖发送入站POST、读取响应和等待该条消息的最终回复。独占OTel目录中本交互的新模型流式/协议事件、工具事件与启动进度续期；HTTP响应/轮询、重复状态、历史记录、其他trace及周期指标不续期。监测在POST未完成时也持续工作；关闭/重命名的诊断分段不重放，部分行等完整后处理，读取故障显式失败；完成/失败清理全部监测定时器。持续有进度可超过30秒，不能突破整例120秒上限。仅测试预算，不改变生产App Server或Turn超时。清理和失败取证另设有界预算，不把迟到成功改写为测试通过。
- 每个E2E用例使用独立fixture服务进程组、端口、状态目录与诊断目录；同一用例的多轮交互复用该服务。正常结束或超时都保存证据并终结该用例的进程组，不复用未完成的后台任务或旧Pending。固定回复/界面布线用例显式选择fixture模型；live用例继续使用真实模型，不注入预设工具决定。POST失败也必须留存口令、实际状态和日志；F02措辞语义评分仍为独立TODO。
- 预设主模型在 AppServerTransport 边界提供协议事件，与 live 共用生产 CodexConversation、工具绑定及执行器；不直接调用 ToolHost 或伪造业务完成。工具 success:false 或 success:true/ok:false 原样回灌，由显式协议脚本决定后续调用，不自动结束 Turn，也不代表真实模型已经具备纠错能力。最高层装配回归必须能拦住重新绕过生产门面的假件。

- OTel 工具采集验收区分确定性 fixture 与 live 模型：前者可固定预制调用次数；后者必须把生产等价入口实际 ToolHost 完成事件与持久 OTel Span 逐项对账（调用数量、工具、结果、耗时、Owner、父回合与唯一 Span），允许探索性查询和错误恢复，不限定模型唯一调用路径。两种模式都必须独立验证发送的文件身份、顺序、数量、Run/Effect 和终止接管次数；采集一致性不等于模型策略质量或手机收件。诊断适配不能改写实际错误码或隐藏失败领域状态。不得用删除次数校验或空集合对账代替此约束。

- OTel 接入复用生产等价入站 seam，比较启用/停用诊断后的相同业务状态与 outbox，并从实际导出文件重建回合，验证普通聊天、工具纠正、多轮查询、并行调用、Pending/恢复、取消/替换、发送拒绝和 unknown；不得用合成 Trace 代替生产埋点覆盖。真实微信验收仍由相同口令与手机结果确认。
- 诊断出口的故障注入覆盖队列满、只读目录、磁盘写入失败、重启、强杀、轮转和损坏尾行；验证业务不受影响、读取有界、缺口明确且不误报终态。原值回归覆盖实际提供的诊断属性、查询和路径，另用网络请求头/正文与文件正文哨兵确认没有扩大采集；未导出的记录不得计为已持久化。
- 最高层 seam 是生产等价微信入站：从 Durable Inbox 经主微信真实 App Server tool loop、File Tools、Gateway、Engine、Pending、Effect ledger 到脱敏 fixture outbox；禁止注入模型工具决定作为最终模型能力证据。
- 第二个 seam 是 File Tools Interface：使用真实临时目录和生产文件沙箱 Adapter，覆盖授权、路径逃逸、符号链接、Unicode、大小写、glob、regex、分页、稳定排序、扫描完整性、二进制、窗口读取、CAS 和原子写。
- 第三个 seam 是真实 App Server 协议：验证一个回合可连续 `files.find -> files.read -> files.edit -> files.read` 后继续生成，也可用修改返回的新 reference 调用 `weixin.send_files`；只有准备产物和 Run 均持久化的终止型工具转移 owner。
- App Server 协议 seam 必须证明每条进入主模型路径的微信入站最多发送一次 `turn/start`，可信 Pending 回答快路径为零次；同目标活动 Turn 期间到达的第二条独立入站保持为 Durable Inbox FIFO 后继项且不调用 `turn/steer`。每个 `item/tool/call` 按原 request id 恰好回复一次，工具结果后由 App Server 在原 Turn 自动产生下一次工具调用或最终消息，不由测试宿主手工启动下一轮模型调用。
- App Server 协议 seam 覆盖同一 Turn 内零个、一个和多个工具调用：多个只读调用可并行且结果不串线，同一资源修改串行，两个终止型调用最多一个成功接管。
- 回复收口测试同时注入 commentary delta、final delta 与权威 `item/completed(agentMessage)`，覆盖 final 有 phase、commentary 有 phase 而 final 无 phase、所有消息无 phase，以及只有 commentary 四种情况；断言按优先级选择最后一个 final answer 或最后一个无 phase 消息，永不选择 commentary 或回退拼接 delta。工作流接管时断言 Turn 正常完成、状态不为 interrupted、微信只使用工作流回执。
- 终止接管并发测试覆盖预检失败、预检期间已有 mutation、预检期间新 mutation/terminal、运行中 read、接管后新工具请求、Turn 正常完成和 watchdog 清理；断言快照只在已接纳 mutation 完成后建立、Owner 一旦持久接管绝不回退、Durable Workflow 独立推进且 Effect 不重复。
- 工具失败测试覆盖 schema 错误、可修正参数、权限不足、预算耗尽、输出截断、Tool Host 内部异常和传输失败，断言预期领域错误以协议成功加 `ok:false` envelope 回到模型，非预期宿主/传输错误使用协议失败，且每个服务端请求最多被回答一次。
- 真实 App Server 模型回归不得用固定候选替代 `files.find`。它必须把模型生成的实际参数交给生产 `Local File Tools` 与真实临时目录，再把真实零结果或候选回灌模型。活模型 eval 断言最终结果与安全不变量，并记录实际工具序列而不要求唯一固定序列；只有语义必须动作使用严格断言，例如发送已有原文件不得调用 `files.read`、终止接管恰好一次、不得调用越权工具。
- 文件工具 seam 覆盖无空格中英边界、带空格中英边界、大小写、纯中文、纯英文、数字边界、标点、完整命中、全部 term、部分 term、零结果、非法正则、截断和扫描不完整；不能只测 `agent 笔记` 而漏掉真实口令中的 `agent笔记`。
- 生产一致模型回归至少覆盖：最新图片、最新 PDF、模糊文件多候选、明确全部、正文 grep 后回答、读取后总结、创建文件、冲突编辑、无权限、扫描不完整和普通聊天。
- 每次代码回归记录完整微信口令、模型实际工具序列、工具参数摘要、最终回复、Run、步骤、Effect 和脱敏 outbox。自动化只能标记候选通过；重启后由用户发送相同口令并确认手机实际结果才算真实微信验收通过。
- 迁移测试使用包含 completed、unknown、needs_input 和 resolver-running 旧数据的真实临时 SQLite，证明完成历史不变、unknown 不重发、已冻结候选可继续、未形成候选的 Resolver Run 安全终结。

### workflow-runs::REQ-068 Reusable workflow E2E assertions

Applies to the existing workflow E2E scenarios that check file delivery, no file delivery, or a specific Run transition. Shared assertions make these checks consistent without deciding the model's tool strategy.

The three assertion categories are implemented in the shared workflow E2E assertion module and used by the existing file/image scenarios. Their checker regressions cover malformed evidence as well as valid public batch projections.

- **workflow-runs::REQ-068/AC-01**: Each interaction is checked against its own before/after observations. Historical outbox entries cannot satisfy a new delivery expectation. A shortened or changed pre-existing outbox prefix fails the observation check rather than being treated as an empty delta.
- **workflow-runs::REQ-068/AC-02**: A delivery expectation checks the exact file/image identities and multiplicities, rejecting missing, extra, duplicate, wrong-file and wrong-kind deliveries. The scenario supplies independent expected identities. Order-sensitive scenarios check the expected sequence; explicitly order-insensitive scenarios compare multiplicities, not deduplicated sets. An empty delivery expectation cannot vacuously pass as successful delivery.
- **workflow-runs::REQ-068/AC-03**: Successful delivery also checks the expected Run and its outbound steps/Effects, including the expected accepted Effect count and the absence of unresolved or failed outbound Effects. It does not infer success from reply wording. Evidence is limited to the identities and associations actually exposed by the fixture; channel acceptance is not proof of receipt on the user's phone.
- **workflow-runs::REQ-068/AC-04**: A no-delivery expectation rejects new file/image outbox entries and new or newly advanced outbound Effects indicating accepted, in-progress or unknown delivery. It does not prohibit unrelated legitimate local file modifications. Expected cancellation, waiting or rejected outcomes remain independently checked by the scenario.
- **workflow-runs::REQ-068/AC-05**: A Run transition is checked by the original `runRef`, expected state and applicable reason, not by workflow type or array position. Before/after Run identities detect unexpected new Runs; resuming or cancelling a Pending Run must not silently pass through a different Run. A replacement intent may explicitly expect the old Run to end and a new Run to appear.
- **workflow-runs::REQ-068/AC-06**: Missing required observations, ambiguous expected identities, duplicate Run references, or an incomplete Run observation that cannot support the requested comparison fail explicitly. The assertions do not normalize unavailable evidence into empty collections or invent an association between an outbox item and an Effect.
- **workflow-runs::REQ-068/AC-07**: Tests of the shared assertions prove that each supported mismatch is rejected, including historical evidence masking a missed current delivery, wrong-Run success and unexpected extra Runs. Failure output identifies the interaction/check, relevant Run reference and expected-versus-observed difference without loading file bodies or credentials.

#### Failure modes and boundaries

The following sequences apply the acceptance conditions above; they do not add a second set of requirements:

| Sequence | Required check |
| --- | --- |
| A previous turn sent a file; the next turn fails to send it | Current outbox delta, not historical presence (AC-01, AC-02) |
| A user selects one, several or all candidates | Exact expected files, multiplicities, applicable order and accepted Effects (AC-02, AC-03) |
| A user asks to redisplay choices or cancels | No new delivery and the original Run's expected state (AC-04, AC-05) |
| A user starts a replacement intent | Old Run termination plus the explicitly allowed new Run, without inheriting a blanket no-new-Run rule (AC-05) |
| A user edits a local file without requesting delivery | No outbound delivery; separate assertions still verify the legitimate edit (AC-04) |
| A send is rejected or its result is unknown | It cannot satisfy successful delivery; unknown delivery cannot satisfy a proven no-delivery conclusion (AC-03, AC-04) |
| State is missing, truncated, ambiguous or reset during observation | Explicit evidence failure, not a false pass (AC-01, AC-06) |

The observation seam remains the fixture-only inbound endpoint using the production entry chain, with one isolated fixture per case and shared state across that case's turns. The assertion module's public input/output is the narrow seam for negative tests: malformed observations test the checker, not fabricated production state. Existing OTel reconciliation is prior art for comparing independent observations. No UI or interaction changes are introduced, so the visual prototype gate is not applicable.

### workflow-runs::CON-001 Assertion extraction boundaries

Applies to workflow-runs::REQ-068.

- **workflow-runs::CON-001/AC-01**: Extract only the three approved categories: sent-file reconciliation, no file/image delivery, and specific Run transitions. Do not introduce a generic scenario framework or a semantic grader.
- **workflow-runs::CON-001/AC-02**: Preserve existing scenario-specific structured `results`, file-content, permission, tool-safety and OTel checks. Live-model cases continue to choose their own tool calls; extraction must not add a fixed exploration count, a unique tool sequence or an exact Chinese reply requirement.
- **workflow-runs::CON-001/AC-03**: Keep the change within test helpers and their consumers. Do not change production routing, prompts, schemas, Run transitions, authorization or delivery behavior to accommodate the assertions. Keep existing fixture/live mode separation, interaction budgets and evidence reporting.

## Diagnostic isolation and launch scheduling

### workflow-runs::REQ-070 Bounded diagnostic persistence independent of business execution

- **workflow-runs::REQ-070/AC-01**: Accumulated diagnostic shards do not trigger a directory inventory for every record. Preserve existing size/count/age retention, private permissions, safe owned-file cleanup, restart and reader compatibility; use incremental accounting between explicit reconciliation points.
- **workflow-runs::REQ-070/AC-02**: Diagnostic filesystem writes and maintenance run in a separate process behind bounded nonblocking admission. Slow, unavailable or dead writers cannot make a file query wait for diagnostic persistence or alter its outcome. IPC, record and queue memory stay bounded; loss/failure counters remain observable.
- **workflow-runs::REQ-070/AC-03**: Flush/close have bounded completion, normal close drains accepted records when possible, failed writers are not endlessly respawned and pending evidence is not described as persisted. Preserve priority reserve for spans/checkpoints, raw diagnostic values and no external export/body collection. Run/Effect and operation journals are never subject to lossy diagnostics policy.

### workflow-runs::REQ-071 Standard launch scheduling (direct acceptance)

Generated macOS LaunchAgent configuration uses Standard process classification while preserving automatic startup, keepalive, explicit executable paths and existing channel configuration. Validate actual LaunchAgent scans with accumulated diagnostics and overlapping arrivals, not only terminal probes.

### workflow-runs::CON-002 Optimization scope (direct acceptance)

Keep the 60-second file-operation allowance and existing traversal/permission/delivery rules unchanged. Cross-query scheduling follows workflow-runs::REQ-072. Execution and queue waiting have separate bounded accounting; neither continuation nor another turn resets either allowance.

### Failure modes and boundaries

Fresh/existing/expired/full diagnostic directory, unrelated or symlink files, directory replacement, unavailable disk, oversized/unserializable records, queue overflow and metric bursts, writer startup failure/death/stall, repeated flush/close, shutdown during queued writes and restart preserve REQ-070. Diagnostic loss is permitted and observable, never a business retry trigger. Shared physical storage cannot promise zero contention under arbitrary system load; the guarantee is bounded work and no diagnostic persistence dependency on the business path. Standard classification does not remove the finite query budget.

### Testing Decisions

Reuse DiagnosticFiles/readDiagnostics, the real sandbox and fixture inbound seams. Exercise populated-directory filesystem work and writer process failure, existing retention/priority tests, generated configuration, actual isolated LaunchAgent execution and real-model file delivery with simulated outbound. No UI changes; prototype exemption. No automatic phone sends or deployment acceptance claim.

## Cross-turn query resource isolation

### workflow-runs::REQ-072 Fair bounded file-query scheduling

Applies to find/grep queries across all channels and turns sharing the service. Adopt ADR-0022.

- **workflow-runs::REQ-072/AC-01**: Admit at most one active traversal batch across turns. Queue batches FIFO; a continued find returns to the tail so a later small query can progress before an earlier large scan completes. Preserve per-turn traversal serialization and independent workers, references, cursors, permissions and aggregate counters.
- **workflow-runs::REQ-072/AC-02**: Retain the 60-second per-turn active file-operation allowance and all existing count/byte/call limits. Time waiting for query admission does not consume execution allowance. Account queue waiting separately across continuations and queries in that turn; default cumulative queue allowance is 60 seconds and at most 32 batches may wait service-wide. Queue exhaustion/full admission returns a distinct bounded domain error, not a scan-budget error or no-match observation.
- **workflow-runs::REQ-072/AC-03**: Release/cancellation removes only that turn's queued batches and closes only its own workers. A cancelled waiter never starts later. An active cancelled worker must finish closing before the next traversal is admitted. Worker failure or query error releases admission for other turns. Service close rejects pending work and drains active cleanup without starting new workers.
- **workflow-runs::REQ-072/AC-04**: Recheck current authorization and remaining execution allowance after admission, before filesystem dispatch. Preserve complete-tree latest ordering, incomplete-result send rejection, explicit retries and no side-effect replay.
- **workflow-runs::REQ-072/AC-05**: Existing local diagnostics separately expose queue wait, execution duration, operation and outcome, associated with the originating turn/tool. Diagnostic failures cannot hold admission or change the query result; no file bodies, external exporter or per-file spans are added.

### Failure modes and boundaries

Two channels query the same directory together; a small query arrives during a large scan; several calls arrive in one turn; a queued turn is released, permissions change or its allowance is spent; the active worker stalls/exits; queue count or cumulative waiting reaches its limit; a query errors with a continuation outstanding; service closes during active or queued work. Every outcome preserves AC-01–05 and workflow-runs::REQ-069. Queue cancellation does not cancel another turn. A read-only cleanup may close its own continuation without waiting for traversal admission.

Find retains its existing 2,048-entry/approximately-200-ms cooperative batches; grep remains one bounded request subject to the existing five-second worker deadline. This is scheduling of traversal work, not a general lock on ordinary reads, writes, snapshot delivery or unrelated services. Shared physical storage and external load still preclude a guarantee of zero latency interference. Overall elapsed query time can exceed 60 seconds because waiting and actual work are separately bounded; no active-work budget is increased.

### Testing Decisions

Use public LocalFileTools and the real permission-limited worker. Observe/gate external process transport, not private session state. Verify actual batch non-overlap/fairness, independent exhaustion/references, queue bounds/cancellation, permission changes while waiting, failed worker release and separate accounting. Reuse fixture-only Weixin ingress for latest-file delivery with simulated outbound; live-model synthetic data and local-only real-directory performance remain separate evidence. No UI shape or new status presentation; prototype exemption.

## Recursive metadata search

### workflow-runs::REQ-069 Complete recursive latest-file discovery

Applies to the shared file tools used by Weixin and Feishu. The existing latest-file rule in file-search boundary 15 remains the acceptance criterion for global selection.

- **workflow-runs::REQ-069/AC-01**: A requested directory includes its entire authorized subtree by default. Do not silently fall back to the top level or exclude ordinary project/SDK directories to meet execution limits. Existing no-follow, mount and Photos Library boundaries remain in force.
- **workflow-runs::REQ-069/AC-02**: A metadata query can advance through bounded traversal batches without restarting the scanned prefix. Continuation is internal to File Tools; it does not add model turns or change the main model's query and send ownership.
- **workflow-runs::REQ-069/AC-03**: Query identity, scope binding and cumulative budgets remain fixed across continuation. A changed query, consumed token or another worker/turn cannot reuse the continuation. Exhaustion remains incomplete; a continuation must not reset the aggregate allowance.
- **workflow-runs::REQ-069/AC-04**: Read-only search timeout retains a specific domain error and does not recommend an identical retry. It must not become generic internal failure or no-match evidence. Mutation timeout and unknown-send recovery rules are unchanged.
- **workflow-runs::REQ-069/AC-05**: Search diagnostics expose batch consumption, elapsed time, completeness and stop reason through the existing local diagnostic boundary, without per-file spans or file-body collection.
- **workflow-runs::REQ-069/AC-06**: Saved permission revisions are checked before each continuation and before publishing candidates. Completion, exhaustion and cancellation release traversal handles; turn release closes its worker and invalidates unfinished continuations. Worker loss or service restart cannot fabricate completion or trigger an automatic send.
- **workflow-runs::REQ-069/AC-07**: Metadata traversal uses bounded reads and retains only the ordered candidate prefix required by the requested result window. Finding the latest one does not load all matches or read file bodies. Final ordering and cross-scope tie-breaking retain the existing rules.
- **workflow-runs::REQ-069/AC-08**: Candidates from incomplete find/grep observations remain provisional. File and local-image send preflight must reject their references with a specific incomplete-search reason before creating a send manifest or effect, including when the model ignores completeness guidance. A later complete observation can establish send eligibility; explicit successful mutations retain their existing send behavior.

### Failure modes and boundaries

A request may encounter an empty directory, a newest match in a deep late subtree, equal timestamps, a large unrelated archive, excluded links, multiple scopes, count/time exhaustion, unreadable or disappearing entries, permission revocation, worker loss, turn release or invalid continuation. Complete observations may establish latest/no-match; incomplete/error observations cannot. Result pagination and traversal continuation are distinct: result pages retain the existing public cursor contract; traversal batches do not create new result pages or add intermediate candidates to the model conversation.

Directory traversal is an observation interval, not an atomic filesystem snapshot. The unchanged-tree ordering guarantee remains; the existing file-version and immutable-send-snapshot checks guard the chosen file before delivery. A continuously changing tree is not promised to yield the newest file at the later instant of sending. Interrupted queries are not durable background jobs; a new request starts a new authorized observation.

### Implementation Decisions

Stream directory entries, read a bounded metadata window concurrently and keep the best requested prefix. The default metadata concurrency is 16. Internal batches yield at 2,048 entries or approximately 200 ms between filesystem operations; a blocked filesystem operation remains subject to the independent 5-second request deadline. The shared turn allowance is 500,000 entries and 250,000 files; active file-operation time remains 60 seconds, and metadata sizes do not consume content-read bytes. Batch yielding never resets those limits. These finite limits do not promise success for arbitrarily large or inaccessible trees. No persistent index or second semantic owner is introduced.

### Testing Decisions

Reuse public File Tools and the fixture-only production ingress. Verify a known latest file beyond the former count boundary, continuation identity/consumption, stable ordering, incomplete-budget behavior, permission changes and specific timeout errors. Explicit real-directory opt-in uses read-only Downloads, independently captured expected identities and fixture outbound delivery with the actual model; report exact replies and Run/Effect/outbox separately from phone receipt. Compare bounded concurrency levels on the same real tree, recording completeness and identity alongside duration; a partial fast scan is not performance success. No UI controls, layout or status presentation change, so the visual prototype gate is not applicable.

## Out of Scope

- 首期 OTel 诊断不部署 Phoenix、Langfuse、Jaeger 或 Collector，不新建诊断 SQLite、独立诊断 Tab、新增全文采集或自动模型归因；后续需求出现时另行评估。

- 向量索引、embedding 或语义数据库；文件搜索保持本地 lexical/path 搜索。
- shell、终端、任意命令、文件执行、chmod、删除、移动、压缩或解压。
- 运行中申请或升级目录权限。
- 在本纵切新增任意目录选择器或改变权限页视觉布局；只使用已经保存的授权 scope。
- 多文件事务式修改、跨目标发送、对 unknown 自动重发或承诺手机 exactly-once 收到。
- 同一微信入站提交两个彼此独立的终止型工作流；首版一个触发最多产生一个 Run，但允许该 Run 内映射多个文件 Effect。
- 用另一个 Resolver、Planner、subagent 或规则路由器替代主微信 Codex 的文件语义判断。
- 用业务停用词表、固定删词规则或宿主自动 query rewrite 修复自然语言查询。

## Further Notes

- 当前增量实施顺序为：先以 App Server 事件状态机替换 delta 拼接式回复收口 → 补 request-id 精确关联、恰好一次响应与分类型执行调度 → 统一有界工具结果/错误 envelope 和输出字节预算 → 补终止型工作流正常接管及接管后模型失败隔离 → 修订模型可见文件工具契约与 Unicode 字符体系边界切分 → 把真实 App Server 模型协议测试接到生产 Local File Tools → 运行生产等价微信入口回归 → 重启服务 → 使用相同口令做真实微信验收。
- 方案中的“任意文件”指现有已授权 scope 内的普通文件类型，不等于任意本机路径；新增任意目录仍由模块权限功能单独开放。
