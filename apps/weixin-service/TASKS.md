# Direct iLink implementation tasklist

## 当前待办入口（2026-09-22 核对）

### TEST-SEMANTIC-01 — 模型回复语义测试评分器

- [ ] 状态：**待办，暂不实施**。用户明确要求先登记；不是 ready-for-agent 的实现票，不安装依赖、部署评分模型或修改测试断言。恢复实施需用户重新确认。
- 目标：允许语义等价的模型回复，不绑定唯一句子；文件身份/数量/顺序、授权范围、查询完整性、实际发送副作用仍由确定性断言检查，不能交给评分器抵扣。
- 已讨论方向：Promptfoo 接入现有生产等价测试入口；评分阶段本地运行、显式指定本地生成模型、禁止云端回退。真实微信/Codex 被测链路不因此成为离线链路；具体模型、阈值和版本尚未定案。
- 后续需要：人工标注样本校准、负例与来源诱饵、评分失败和模型不可用的独立状态、断网与无外发验证，以及口令/实际回复/硬断言/评分理由报告。禁止失败重跑直到刷绿。
- 调研正本：[语义测试评分器调研](/Users/loong_zhou/research/semantic-test-grading/framework-research.md)。未完成 POC，不宣称评分准确率或资源性能。
- F02 的逐字断言问题已由结构化 results 路径处理，见下项；评分器仍未实施，不能将业务分类断言等同于自然语言语义评分，也不豁免整体回归门禁。

### TEST-F02 — “未找到”回复断言

- [x] 状态：**原逐字断言缺陷已核销**。后续已确认的 results 方案替代固定中文断言；没有引入语义评分器。
- 当前：`e2e/demo.spec.ts` 的 `does not fall back to another source when the selected image source has no match` 检查本轮 `not_found`、完整零结果搜索、无新增 Run/附件 outbox，不固定正文或工具调用次数。
- 证据：[results 报告](../../docs/.workings/structured-business-results/test-report.md)中的不同正文 live 运行；用户随后报告收到“Pictures 中未找到名为 definitely-missing 的图片”。历史首次失败保留，不被后续通过改写。
- 边界：只关闭“逐字比较造成误报”；正确 scope 的进一步反例、多目标结果与副作用组合仍归 results 票 FR-31/32 和 Ticket 06，不据此标记整票完成。

### 当前剩余工作索引

- 旧 Agent Loop Ticket 06 的 [U01–U06](../../docs/.workings/app-server-agent-loop/checklist.md) 仍是剩余核销入口：分页稳定性/大集合、未逐项归并的组合边界及全 feature 双审查。它不是 App Server 封装的同号 Ticket06；不能按票号互相核销。
- TurnDriver 封装差异 ARCH-01 已由 REQ-067 七票完成，01～07已获用户确认，见 [封装票索引](../../docs/.workings/app-server-encapsulation/issues/README.md)、[12项共用核销记录](../../docs/.workings/workflow-runs/checklist.md)和 [Ticket07 回归报告](../../docs/.workings/app-server-encapsulation/ticket-07-test-report.md)。不再列为待实现，也不据此关闭旧 U05-a 的其他子条件。
- 测试模式/隔离修复已完成；当前预算为单轮连续30秒无有效进度超时、整例120秒总上限。results 混合目标已在09-15及09-22 live复测通过，见 [现行缺口清单](../../docs/.workings/structured-business-results/validation-gaps-tasklist.md)；results全票37项仍待完整归并，不能由局部复测代替。
- 09-22统一版本已运行默认门禁、9项live入站、10项协议和7项进程测试；默认E2E的其他live用例未全部运行，旧全feature范围仍须逐项映射，不再使用09-11的跳过数量描述当前版本。详见上述 Ticket07 报告。
- 诊断隐私表示已按 ADR-0013 改为保留已采集原值，U03 不再等待决策；runtime metrics 与独立沙箱 instrumentation 均已实施且获得用户验收。fs 插件不启用，不再列为待做。
- [2026-09-14 核销记录](../../docs/.workings/acceptance-reconciliation/checklist.md) 汇总当时源码核对、已确认验收及明确保留项；当时只改文档，没有重跑运行门禁、重启或发送微信。
- [2026-09-11 清单与证据归并](../../docs/.workings/app-server-agent-loop/ticket06-evidence-reconciliation-2026-09-11.md) 保留为历史：E18–E21分页9次候选通过，OTel instrumentation及live次数对账修正当时已获微信验收；其中默认E2E跳过数量不是当前版本统计，不关闭旧Ticket06。
- [2026-09-10 待办核对记录](../../docs/.workings/app-server-agent-loop/backlog-audit-2026-09-10.md) 保留为历史快照。当时仅文档归并，不是新一轮运行测试通过证明。
- 以下旧日期条目保留历史状态。旧的未勾选微信验收不能直接判为功能未实现；应先与后续测试报告和用户确认对账，不要求重复全部历史操作。
- 本次现行状态修正的逐项证据、保留边界及验证结果见 [2026-09-22 同步报告](../../docs/.workings/app-server-encapsulation/status-reconciliation-2026-09-22.md)。本次只改文档，不新增产品行为或手机验收；本轮默认回归结果另见报告，不冒充重新执行live。

## 微信日报 5 条单消息精简（2026-08-15）

- [x] 核对详细摘要、Vault 归档、格式器和 1,500 code points 分段边界
- [x] 对齐“Vault 保留详细、微信短版单消息”的范围
- [x] 完成设计与设计审查
- [x] 建立 `codex/weixin-single-message-news-digest` 续接分支
- [x] TDD：5 条全部保留且整条不超过 1,500 code points
- [x] TDD：每条不超过 280，保留四类重点并安全处理 emoji
- [x] 代码 review、测试 review 与设计回同步
- [x] lint、typecheck、全量测试、build 与 fixture E2E
- [x] 重载 4317；不手动触发研究或发送

## 日报失败微信通知与立即重试（2026-08-15）

- [x] 核对后台失败、退避 timer、入站广播与 Codex 双回复风险
- [x] 对齐固定中文命令、安全原因和通知拒绝后的单次补发策略
- [x] 完成设计与设计审查
- [x] 建立 `codex/daily-news-failure-alerts` 续接分支
- [x] 纵切 1：通道命令消费 seam，命令不进入普通 Codex listener
- [x] 纵切 2：研究/归档失败立即发送安全分类通知
- [x] 纵切 3：通知明确拒绝后同目标入站只补一次，unknown 不补
- [x] 纵切 4：固定中文命令立即重试，成功取消原 timer
- [x] 纵切 5：即时失败保留原 `nextRetryAt` 并防并发
- [x] 状态持久化、公开状态与重启恢复
- [x] 代码 review、测试 review 与设计回同步
- [x] lint、typecheck、全量测试、build 与 fixture E2E
- [x] 重载 4317；不手动触发研究或发送

## Hacker News 前 10 顺延补足 5 篇（2026-08-15）

- [x] 复现 HN 单篇不可读会阻断整份日报
- [x] 对齐“前 10 顺延、最多 5 篇、不足则少发、缺失剔除”规则
- [x] 完成设计与设计审查
- [x] 创建 `codex/hn-readable-top5-fallback` 续接分支
- [x] 纵切 1：候选元数据单条失败不阻断并保留原排名
- [x] 纵切 2：深读失败顺延至第 6–10 名，成功 5 篇即停止
- [x] 纵切 3：不足 5 篇返回实际数量，HN 整体失败不阻断普通新闻
- [x] 纵切 4：Vault 二次抓取失败剔除 HN，并返回最终 digest
- [x] 纵切 5：scheduler 使用最终 digest 生成预览与微信正文
- [x] 代码 review、测试 review 与设计回同步
- [x] lint、typecheck、全量测试、build 与 fixture E2E
- [x] 重载 4317；不手动触发研究或发送

## 每日 AI 新闻后台失败恢复（2026-08-15）

- [x] 复现 08:30 自动研究失败且同日不再补跑
- [x] 对齐 10/30/60 分钟退避、当天持续恢复与发送防重复边界
- [x] 完成设计与设计审查
- [x] 建立 `codex/daily-news-background-retry` stacked feature 分支
- [x] 纵切 1：研究失败按 10 分钟后台重试并成功
- [x] 纵切 2：30/60 分钟、跨重启和跨日调度
- [x] 纵切 3：归档复用、发送终态防重复与错误分类
- [x] 纵切 4：页面展示失败阶段、尝试次数和下次重试
- [x] 代码 review、测试 review 与设计回同步
- [x] lint、typecheck、全量测试、build 与 E2E
- [x] 重载 4317 并观察后台同日自动恢复；不手动点击或补发

## `/echo`、Typing 与工具运行状态（2026-08-15）

- [x] 核对腾讯插件 2.4.6 `/echo`、typing ticket、5 秒续期与结构化工具进度
- [x] 核对 Codex App Server item lifecycle 官方协议
- [x] 需求对齐：Typing 优先文字兜底、全部安全标签、按目标实时状态与记录
- [x] 完成设计与设计审查
- [x] 建立 `codex/weixin-runtime-status` stacked feature 分支
- [x] 纵切 1：`/echo` 跳过 Codex并返回通道耗时
- [x] 纵切 2：原生 typing lease、缓存、续期、取消与 ACK 降级
- [x] 纵切 3：App Server item 规范化与 iLink 原生工具进度
- [x] 纵切 4：按目标持久化运行状态与网页展示
- [x] 代码 review、测试 review与设计回同步
- [x] lint、typecheck、全量测试、build 与本地 E2E
- [ ] 用户在场的真实 `/echo`、typing 与工具卡片微信验收

## 微信语音入站与 Codex 回答（2026-08-13）

- [x] 核对腾讯 2.4.6 语音字段、转写与媒体链路
- [x] 对齐转写来源、60 秒限制与面板展示
- [x] 完成设计与设计审查
- [x] 建立 `codex/weixin-voice-input` 功能分支
- [x] 纵切 1：协议层发布有效语音转写与拒绝事件
- [x] 纵切 2：Codex 服务回答语音转写，拒绝事件不启动 Codex
- [x] 代码审查、测试审查与设计回同步
- [x] lint、typecheck、全量测试、build 与 fixture E2E
- [ ] 用户发送真实语音并确认微信收到回答

## 扫码后自动绑定与首次问候（2026-08-13）

- [x] 核对登录、入站事件与消息级 context token seam
- [x] 设计与设计审查
- [x] 持久化等待、首条入站原子消费与自动选择目标
- [x] 固定问候最多尝试一次，失败/未知不自动重试
- [x] 移除网页手动确认并增加明确状态反馈
- [x] 代码审查、测试审查、设计同步与 fixture E2E
- [ ] 用户在场的真实扫码、首次入站与问候收信验证

- [x] Source and official-document research with line evidence
- [x] Requirements alignment: no OpenClaw runtime, private persistent credentials
- [x] Direct iLink design document
- [x] Independent design review
- [x] Private state store with 0700/0600 and atomic writes
- [x] QR login, scan, conditional number code, confirmation, and refresh
- [x] Direct getupdates monitor and target/context-token persistence
- [x] Direct text send with explicit target and no retry
- [x] Replace OpenClaw adapter without changing the browser safety gates
- [x] Code review and regression fixes
- [x] Test review and missing-case fixes
- [x] Full lint, typecheck, unit/integration, E2E, and build verification
- [x] Auto-sync persisted targets on connection and new inbound messages
- [x] Real user-assisted rebind, inbound, and send verification (confirmed received in personal WeChat on 2026-08-11)
- [x] Local account and target aliases with raw IDs as advanced details
- [x] Inbound/context/send-accepted timestamps without invented TTL
- [x] Bot credential stale state and classified no-retry recovery guidance
- [x] Backward-compatible private state migration and full regression verification
- [x] App Server current-thread bridge research and design review
- [x] TDD App Server client and fixed no-tool probe
- [x] Real current-thread probe attempted once (blocked honestly by App Server active-writer guard)
- [x] Dedicated Codex App Server WeChat service design and design review
- [x] TDD dedicated thread lifecycle and persistent service state
- [x] TDD USER-text inbound seam with per-message reply context
- [x] Explicit target enable/disable and transcript UI
- [ ] Real user-assisted inbound-to-Codex-to-WeChat verification
- [x] Obsidian demo Vault bridge facts, requirements, design, and design review
- [x] TDD safe Markdown Vault operations and App Server dynamic tools
- [x] Persisted Vault authorization and web controls
- [x] Vault bridge code/test review, full verification, and design sync
- [ ] Real user-assisted WeChat-to-Codex-to-Vault verification

# Codex Plugin 内嵌微信面板（2026-08-12）

- [x] 核实现有 Demo API 与官方 MCP Apps / Plugin 规范
- [x] 完成设计与设计审查
- [x] 建立功能分支
- [x] TDD：脱敏 loopback Demo client
- [x] TDD：MCP tools 与 UI resource
- [x] TDD：内嵌面板交互和发送确认门禁
- [x] fixture MCP/二维码/目标确认/发送端到端验证
- [x] 两项目全量验证与原 Demo E2E 回归
- [x] 代码 review、测试 review、设计回同步
- [x] 本地 Plugin / Skill 验证、marketplace 注册与安装
- [ ] 安装后的新任务内嵌显示验证（当前任务不会热加载新 MCP）

# 微信纯转发 + Codex 原生执行（2026-08-13）

- [x] 真实代码、已安装 App Server schema 与官方权限模型调研
- [x] 两批需求决策、设计文档与独立设计审查
- [x] 建立 `codex/weixin-native-relay` 功能分支
- [x] 纵切 1：单 App Server 多目标 thread、同目标 FIFO、跨目标并行
- [x] 纵切 1 review：事件隔离、进程退出、状态迁移与回归
- [x] 纵切 2：turn 级写权限请求、私有快照、diff 与冲突安全恢复
- [x] 纵切 2 review：权限越界、网络、符号链接、预算与恢复 race
- [x] 纵切 3：微信 ack + final 两阶段投递与独立状态
- [x] 纵切 3 review：四种发送组合、context 捕获、未知结果不重试
- [x] 纵切 4：移除交互动态 Vault 工具、更新页面与 Plugin 面板
- [x] 代码 review、测试 review、design 回同步
- [x] lint、typecheck、全量单测、build、fixture E2E
- [ ] 用户在场的真实 ack + final、Vault 原生读写和双目标验证
# 每日 AI 新闻微信汇总（2026-08-12）

- [x] 核实现有 iLink、Codex 与调度能力
- [x] 对齐时间、范围、来源、补跑与失败策略
- [x] 完成设计与设计审查
- [x] 建立功能分支
- [x] TDD：日报账本与调度状态机
- [x] TDD：Codex live-search researcher 与格式器
- [x] TDD：HTTP 与页面控制
- [x] review 代码与测试
- [x] 全量验证并回同步设计
- [x] 修复自然日空预览：滚动 24 小时、隔离规则/技能/子代理、真实 web-search 事件门禁
- [x] 本地校验新闻发布时间落在请求窗口，并完成真实仅预览验证（2 条，未发送）
- [x] 扩展到 Top 10，技术主题优先，并从微信、页面和公开状态移除具体链接
- [x] 确认拒绝近 7 天补齐：严格 24 小时，内容不足则少发
- [ ] 提交（Git 写操作审批未执行）；仓库无远程，无法 push/PR
