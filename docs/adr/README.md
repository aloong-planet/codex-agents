# Architecture Decision Records

本目录使用五段式 MADR minimal：背景与问题、备选项、决策、后果、来源均为必填。状态仅允许“提议”“已接受（日期）”或“已被 ADR-XXXX 取代”。已接受 ADR 只追加；推翻时新增 ADR 并同步更新旧条状态。这里只收录难逆转、离开上下文会费解、且来自真实取舍的项目架构决策，不收录跨项目流程约定。

| # | 决策 | 状态 |
|---|---|---|
| ADR-0001 | 使用持久化、有界的工作流引擎承载副作用 | 已被 ADR-0005 取代 |
| ADR-0002 | 模块权限在安装和设置阶段配置 | 已被 ADR-0010 取代 |
| ADR-0003 | 通用文件查询按 find、grep、read 拆分 | 已被 ADR-0007 取代 |
| ADR-0004 | 使用受控待处理响应恢复工作流 | 已接受（2026-08-26） |
| ADR-0005 | 由主微信 Codex 回合选择工作流工具 | 已被 ADR-0007 取代 |
| ADR-0006 | 使用领域工作流工具而非万能入口 | 已被 ADR-0007 取代 |
| ADR-0007 | 主微信 Codex 直接使用受限文件工具 | 已被 ADR-0008 取代 |
| ADR-0008 | 分离内联文件操作与终止型工作流 | 已接受（2026-09-03） |
| ADR-0009 | 由主模型迭代文件查询，宿主不作语义改写 | 已接受（2026-09-04） |
| ADR-0010 | 写入授权包含读取 | 已接受（2026-09-07） |
| ADR-0011 | 使用本地有界 OTel 证据，不另建诊断平台 | 已被 ADR-0012 取代 |
| ADR-0012 | 定向自动网络观测与集中渠道协议诊断 | 已被 ADR-0013 取代 |
| ADR-0013 | 本地诊断保留已采集原值 | 已接受（2026-09-13） |
| ADR-0014 | 保留运行时指标，不启用 fs 自动追踪（取代 ADR-0013 的 fs 扩展部分） | 已接受（2026-09-14） |
| ADR-0015 | [Separate scheduled occurrences from chat reply ownership](0015-durable-scheduled-reminders.md) | Accepted (2026-10-14) |
| ADR-0016 | [Transfer daily news to one durable scheduled-task owner](0016-daily-news-owner-handoff.md) | Accepted (2026-10-16) |
| ADR-0017 | [Preserve article results and decouple user-readable archives](0017-daily-news-results-and-archives.md) | Accepted (2026-10-16) |
| ADR-0018 | [Separate channel messages from trusted delivery](0018-separate-channel-messages-from-delivery.md) | Proposed |
| ADR-0019 | [Preserve owner state across explicit channel bindings](0019-preserve-owner-state-across-channel-bindings.md) | Proposed |
| ADR-0020 | [Freeze notification destinations per occurrence](0020-freeze-notification-destinations-per-occurrence.md) | Proposed |
| ADR-0021 | [Isolate diagnostic persistence from user-requested work](0021-isolate-diagnostic-persistence.md) | Accepted (2026-11-01) |
| ADR-0022 | [Schedule file-query batches without consuming execution time while waiting](0022-schedule-file-query-batches.md) | Accepted (2026-11-01) |
| ADR-0023 | [Separate group authority from shared discussion](0023-isolate-feishu-group-authority.md) | Accepted (2026-11-05) |
| ADR-0024 | [Coordinate independent group agents without changing group authority](0024-coordinate-independent-group-agents.md) | Superseded by ADR-0026 |
| ADR-0025 | [Isolate private financial authority from assistant memory](0025-isolate-private-financial-authority.md) | Accepted (2026-11-07) |
| ADR-0026 | [Coordinate work through isolated domain teams](0026-coordinate-group-work-through-isolated-teams.md) | Accepted (2026-11-07) |
| ADR-0027 | [Bind a host-enforced profile to each agent](0027-bind-host-enforced-agent-profiles.md) | Accepted (2026-11-08) |
| ADR-0028 | [Manage agent teams, MCP servers and skills from the local console](0028-manage-agent-teams-from-the-local-console.md) | Accepted (2026-11-07) |
| ADR-0029 | [Offer an isolated runtime only the tools its host grants](0029-offer-isolated-runtimes-only-granted-tools.md) | Proposed |
