# MCP management

> Related decisions: [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md)

## Overview

The owner wants to give agents capabilities beyond module permissions through MCP servers, without ever handing an agent a credential or letting a server change what it offers unnoticed. The console's MCP 管理 page registers local MCP programs and URL servers once, by form or by importing an existing `mcpServers` configuration, after the owner confirms exactly what will run or where it will connect; the service holds every connection and credential, and the owner reviews and switches off the tools each server offers.

## Capabilities

- MCP 管理 lists every registered server with its name, 本机程序 with the command it runs or 网址 with its address, its state with any error and the time of the next automatic retry, its tool count with the usable count and the tools waiting for review, and the profiles that attach it. With no server registered, the table says so and points to 添加服务器.
- 添加服务器 opens a form in a drawer. Field labels carry required and optional tags, and explanations sit in info tips:
  - a name of 1–32 letters, digits, `_` or `-`, unique and fixed after creation, which becomes part of every tool name;
  - the connection type, 本机程序（stdio） or 网址（Streamable HTTP）;
  - for a local program: the command, arguments one per line, a working directory (the home directory when left empty), environment variables, and an optional macOS sandbox with allowed domains, readable directories and writable directories;
  - for a URL server (网址): the URL, headers one per line, and optionally an OAuth authorization server, client ID, client secret and scope for unattended client_credentials, with the token presented by DPoP when ticked;
  - a per-call timeout of 1–600 seconds (60 when left empty), a trusted switch and an enabled switch.
- Saving a new server, or a change of its command, arguments, address or connection type, first shows a card with the exact command line (本机将运行) or address (将连接). Nothing is saved, started or connected until the owner confirms that card; closing the drawer instead leaves no trace.
- 导入 JSON opens in the same drawer for a pasted `{"mcpServers": {…}}` configuration such as Claude Desktop's or Cursor's. 检查 lists each server as 将导入, saying whether it is a local program or an address and naming any value still to fill in, or as 跳过 with the reason: a server of the same name exists, SSE, an unsupported connection type, an invalid name, no command or address, or a field that fails its check. A text that is not JSON or has no `mcpServers` is refused on one line under it. A card shows the commands under 本机将运行 and the addresses under 将连接; only 确认并导入 imports them, after which the first imported server opens.
- Imported servers are untrusted and attached to no profile. A value that the configuration held only as a placeholder, such as `${GITHUB_TOKEN}`, is imported empty for the owner to fill in, and a server marked disabled there is imported switched off.
- The service starts each enabled program, connects each enabled URL server and holds the connections. A program receives its own environment variables and the basic ones it needs to run, never a model key.
- A server's drawer shows its connection: state, server name and version, negotiated protocol, authentication (OAuth client_credentials with the client ID, and · DPoP when used, or the names of its headers), sandbox, connected time, error, automatic retry, how tool annotations are treated, and the tail of the program's output. 重新连接 restarts the connection.
- After a failure the service retries on its own, first after 30 seconds and then at doubling intervals of at most 10 minutes. A URL server that stops answering is noticed at the next call or listing and connected again at once. The service keeps each server's tool list current, when the server announces a change or every 10 minutes for servers that do not and for every URL server.
- Every tool has a checkbox; unchecking it stops providing the tool from the next call on. Read-only and may-modify-data marks appear only for servers marked trusted.
- A server's first tool list is pinned. A tool added later, or whose definition changes, shows 「待复核」 with the parts that changed and its old description, and is not provided until the owner presses 「确认」; 「全部确认」 appears when several wait. Tools that the server marks as needing a person show 「需人工确认，不提供」 and are never provided.
- Environment values, header values and the client secret can only be written. Saved values show as `••••••`, and a value left unchanged is kept; a client secret is kept only while the authorization server stays the same. Values of 6 characters or more appear as `***` in errors and in program output.
- A confirmed change of the command, arguments, address or connection type applies once the server has reconnected, and tools whose definitions changed then wait for review. Changing the connection type removes the saved values of the old one.
- A server no profile attaches can be deleted after an inline confirmation; its connection stops and its saved environment values, header values and client secret are removed.
- Every saved change and every import is recorded in the local audit file with the browser that made it, never with a secret value.

## Boundaries and non-goals

- A URL server's address must use https, or http on this machine. Servers that use the older SSE transport cannot be added.
- Beside OAuth, headers cannot set Authorization or DPoP, and DPoP needs OAuth. The client secret is sent only to the authorization server entered with it; a server that names another one does not connect. An authorization server that does not publish an authorization endpoint cannot be used.
- Headers go only to the server's own address (its scheme, host and port), never to the authorization server or to any other address the server names. An authorization server that needs a header of its own therefore cannot be used.
- A URL server that redirects to another address is not followed there: the connection, or the call, fails with an error naming that address, and the owner can register it in its place. A redirect within the same address is followed.
- Access tokens are kept only while connected: after a reconnection or a restart a new one is requested.
- Importing brings in no sandbox, OAuth, timeout or trust; those are set on the form afterwards.
- Registering a server gives no agent its tools: no profile attaches a server.
- The sandbox exists only on macOS; a server set to run in it is not started elsewhere.
- A sandboxed program reads only the directories the owner listed, its working directory, the files named in its command and arguments (each file alone, not its directory) and what it needs to run; the home and the service's own data stay out of reach. Readable directories and named files stay read-only.
- A sandboxed program started with `npx` needs `registry.npmjs.org` among its allowed domains. It gets its own npm cache and never reads the owner's npm settings; caches of other package tools, such as uv or pip, are not provided.
- Environment values, header values and client secrets shorter than 6 characters are not masked in errors or program output.
- Tool calls are not confirmed one by one.
