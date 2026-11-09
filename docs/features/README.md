# 功能目录（Features）

本目录描述**当前版本已具备功能的现行行为**，面向人的产品全景。

- 不变量：出现在本目录 = 当前版本可用；行为变更就地改写；功能移除删除文件。
- 未来计划见 roadmap；历史见 git/Release Notes；实现与决策见 `docs/adr/`。
- 内容规则：只写用户可见行为，零实现细节；术语从 `CONTEXT.md`。

| 功能 | 一句话 |
|---|---|
| [Personal channels and Feishu groups](channel-switching.md) | Use personal chats and authorized groups with independent group memory, requester-owned choices and source-bound reminders. |
| [Automatic group task dispatch](agent-dispatch.md) | Ask in ordinary group discussion; Sam routes the request to a team whose Team Leader divides it among Executors, brings in other teams through Sam, and reports start, failures and close under its own bot, with author-confirmed proposals and limits. |
| [Scheduled tasks](scheduled-tasks.md) | Manage reminders, public-web research and existing daily news with editable schedules, permanent execution summaries and exact ordered cached recovery. |
| [Daily AI news](daily-ai-news.md) | Select supported current news, reject mismatched article bodies, reuse complete summaries, disclose shortages and recover eligible reports in order independently of archiving. |
| [工作流模块权限](workflow-module-permissions.md) | 在本地设置页按模块和目录保存读写权限，文件执行始终禁止。 |
| [微信工作流与运行面板](workflow-runs.md) | 用自然语言查找、读取、修改或发送已授权文件，并查看持久外发与待选结果。 |
| [Agent console](agent-console.md) | Open the local service's pages only in browsers authorized with a one-time login link from this computer; list and revoke them from the command line. |
| [Team management](team-management.md) | Edit Agent Teams, their existing Feishu applications, responsibilities, instructions, Executor profiles and dispatch groups from the console, with each group's onboarding, Sam's join and leave announcements and the effective tools; changes apply without a restart. |
| [MCP management](mcp-catalog.md) | Register local MCP programs and URL servers, by form or by importing an mcpServers configuration, after confirming what will run or connect; the service holds their connections and credentials, and the owner reviews and switches off their tools. |
| [Penny private bookkeeping](finance-assistant.md) | Record personal/business cash events privately, confirm screenshot previews and query exact CNY totals. |
