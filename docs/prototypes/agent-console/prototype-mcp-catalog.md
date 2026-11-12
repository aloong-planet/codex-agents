# MCP management

## Question

Can the owner register and maintain MCP servers in the console in the same way as the MCP settings of the owner's agent-link project? Executor profiles on the team page then attach these servers.

The page has to make four things clear:

- that the console's service holds every connection, and executors only receive `mcp__<server>__<tool>` proxy tools and never the credentials;
- each server's state, tools and pending tool reviews;
- which profiles attach each server;
- that registering, or changing what a server runs, needs the owner's confirmation.

Servers, commands, URLs, credentials, states, tools and program output are synthetic. Nothing runs, connects or saves.

## Structure basis

- **Console shell.** The console borrows the owner's agent-link web console UI, through the shared `agent-console-shell.js` and `agent-console` visual block:
  - a 212px left sidebar with the identity, the page navigation (团队总览, 团队管理, MCP 管理, Skill 管理, with the current page selected), and one 私人 section whose info tip reads 「只有你能看到。Penny 的账务与个人助手、私人任务分开保存。」. It holds three fixed rows:
    - 私人任务, with the meta 「<n> 进行中 · <m> 待处理」: n counts running or waiting private requests, m those 部分失败 or 失败 and not retried. A zero part is left out; with neither, the meta reads 「暂无进行中」.
    - Penny, with a status dot and 「个人账 / 经营账 · 就绪」.
    - 个人助手, with 「普通问答 · 文件 · 提醒」.
  - on the team overview each private row opens its drawer in place; on other pages it leads to the team overview. Below 900px, choosing a row also closes the sidebar;
  - below 900px, a menu bar opens the sidebar;
  - a page title with an info tip that holds the page description;
  - agent-link's colors and chips;
  - a right drawer over a scrim, `min(720px, 80% of the area beside the sidebar)` wide, closed by its bordered X, the scrim or Escape.
  - Info tips open a single popover attached to the page body, placed from the tip's measured position and closed by scrolling or resizing.
  - At the bottom of the sidebar, a 本机 section, whose tip covers login and the configuration audit, holds the 本机登录 entry with the number of authorized browsers. It opens a drawer above any page drawer:
    - authorized browsers, each with its label, authorization time, last use and a current-browser badge, and with 收回 behind an inline confirmation;
    - 全部收回, also behind an inline confirmation;
    - a 配置审计 section whose tip says that configuration changes, onboarding actions, authorizations and refused MCP calls go to a local audit file read from the command line. There is no audit page.
  - A browser without authorization sees only a full-window gate. It explains how to get a one-time login link (valid 2 minutes, single use) and shows no data. Revoking the current browser, or all browsers, leads to the gate.
- **Tips.** Section explanations sit in info tips beside the section titles. Status and warning lines stay inline.

### Reference

The page follows the MCP settings page of agent-link (`/Users/loong_zhou/playground/multi-agent/agent-link/web.html`):

- a table of servers, with a right-hand drawer per server;
- "添加服务器" and "导入 JSON" open in the same drawer.

The owner chose a table with an overlay drawer, which matches agent-link.

### Table

The table has these columns:

- name;
- transport (local program or URL) with the command or URL;
- state, with the error and the next automatic retry;
- tool count, with the usable count and pending reviews;
- attached profiles.

With no server registered, the table shows a single row: 「还没有 MCP 服务器。」 and 「点「添加服务器」登记本机程序。」.

"返回团队管理" leads to `prototype-team-management.html`. The team page links here from its heading and from each profile's MCP list.

### Drawer for a server

The subtitle shows the transport, the state and the tool counts. The drawer contains:

1. **Connection state.** State, server name and version, negotiated protocol, authentication, sandbox, connected time, error, automatic retry, how tool annotations are treated, and the tail of the program output. The reconnect action is here.
   - Authentication reads 「OAuth client_credentials · 客户端 <id>」, followed by 「 · DPoP」 when the token is presented with DPoP; a server with headers only reads 「请求头 <names>」, names without values; a server with neither has no authentication line.
2. **Tools.**
   - Every tool has a checkbox; unchecking it disables the tool.
   - Read-only and may-modify-data marks appear only for trusted servers.
   - Tools that are new, or whose definition changed, show "待复核". A changed tool also shows which parts changed and its old description. Each such tool has "确认", and "全部确认" appears when several wait.
   - Tools that the server marks for human interaction show "需人工确认，不提供".
3. **Attached profiles.** Each attached profile, with a link to unbind it on the team page.
4. **Configuration.**
   - **Name.** Fixed after creation, and part of every tool name.
   - **Transport.**
     - Local program (stdio): command, arguments one per line, working directory, environment variables. An optional macOS sandbox adds allowed domains, readable directories and writable directories.
     - URL (Streamable HTTP): headers, a DPoP option, and OAuth client_credentials fields.
   - **Other settings.** Timeout, trusted and enabled.
   - **Field tags.** As in agent-link, field labels carry required and optional tags, and their explanations are info tips.
   - **Secrets.** Saved environment and header values and secrets show as `••••••`, and unchanged values are kept.
   - **Confirmation.** A new server, or a change of command, arguments, URL or transport, shows a confirmation card with the exact command or URL. For an attached server, the card also says how many profiles attach it. It adds that the server reconnects after confirmation and every later call uses the new command or address, including in requests already in progress, and that tools whose definitions changed are withheld until reviewed.
   - **Disabling.** The enabled switch and the tools tip say that disabling a server or unchecking a tool applies from the next call, including in requests already in progress.
5. **Delete.** It is disabled while any profile attaches the server; otherwise it asks for inline confirmation.

### Import drawer

The owner pastes an `{"mcpServers": {…}}` document.

- The check lists each server as to be imported or skipped:
  - a server to be imported shows its transport, that it is untrusted and unattached, and the names of values still to fill in (a value that was only a placeholder such as `${NAME}`);
  - a skipped server shows the reason: same name exists, SSE transport, invalid name, no command or URL, or the field that failed its check.
- A document that is not JSON, or has no `mcpServers` object, is refused with one inline line in the warning colour under the text; no list appears and 检查 stays.
- A confirmation card shows the commands of the local programs under 本机将运行 and the addresses of the URL servers under 将连接, each group only when it has entries.
- Confirming imports them and opens the first imported server; its save bar says 已导入，正在连接。, or 已导入 N 个，正在连接。 for more than one.
- Imported servers are untrusted and unattached.

### Shared visual block

The console shell, buttons, inputs, badges, form sections, confirmation cards, catalog table and drawer come from the shared `agent-console` visual block.

## Demo scaffolding

- **Simulation marker.** The floating `Demo ·` bar only marks the simulation.
- **本机登录.** 已授权 / 未登录 / 链接已失效; in the product, the browser's authorization decides it.
- **服务器列表.** 示例数据 / 空; in the product, whether any server is registered decides it.
- **检查结果** (shown only in the import drawer). 多个服务器 / 单个服务器 / 不是 JSON / 没有 mcpServers; in the product, the pasted document decides it.
- **Fake actions.** Add, import, check, save, reconnect, tool confirmation, tool switches and delete give visual feedback only. The import check returns the result chosen under 检查结果, whatever is pasted. A refresh restores the mock data.
- **No side effects.** The page runs no command and connects to no address.

## Uncovered dimensions

- Chinese and light appearance only. Per the project capability declaration, i18n and theming are disabled, so their checks are skipped.
- **Not modeled:**
  - per-profile credentials;
  - DPoP key generation and its key fingerprint;
  - live state updates;
  - tracing.
- **Audit.** Changes and refused calls are audited to a local file, read from the command line (see the 本机 tip); the page shows no audit log.
- **Behaviour not shown.** Automatic retry, periodic tool-list refresh and pinning happen in the service. Only their results appear as state lines and review marks.
