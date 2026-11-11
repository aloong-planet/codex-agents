# MCP catalog

> Status: implemented: local programs, URL servers, JSON import, attachment to profiles and proxy tools.
> Related: [team management](team-management.md), [agent dispatch](agent-dispatch.md), [agent console](agent-console.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md), [ADR-0029](../adr/0029-keep-service-state-outside-every-file-grant.md).

## Problem Statement

Some work, such as operating marketplace sites, needs capabilities beyond module permissions. The owner wants to give these capabilities to particular Executor profiles through MCP servers, maintained once in the console as in the owner's agent-link project. The console then starts local programs and holds credentials, so every grant must be explicit, visible and confirmed, and no agent may hold a server's credentials or reach a server its profile does not attach.

## Solution

An MCP management page lists the registered servers in a table and opens each in a drawer over the page. The owner registers servers there, by form or by importing an `mcpServers` JSON document, and confirms the exact command or address. The host service holds every connection. Agents receive only proxy tools for the servers their profile attaches, and the host re-checks each call. The owner reviews new or changed tools before agents get them, disables tools one by one, and can delete a server only after unbinding it from every profile.

## User Stories

### mcp-catalog::US-001 Register a server

As the owner, I want to register an MCP server once, so that profiles on the team page can attach it.

- mcp-catalog::US-001/AC-01: "添加服务器" opens the configuration form in the drawer. Field labels carry required and optional tags, and longer explanations sit in info tips.
- mcp-catalog::US-001/AC-02: The name has 1–32 letters, digits, `_` or `-`, is unique, and is fixed after creation; it is part of every tool name.
- mcp-catalog::US-001/AC-03: A local program (stdio) takes a command, arguments one per line, a working directory (default: the home directory) and environment variables. An optional macOS sandbox adds allowed domains and readable and writable directories.
- mcp-catalog::US-001/AC-04: A URL server (Streamable HTTP) takes a URL, headers, and optionally OAuth client_credentials (issuer, client ID, secret, scope), presenting the token with DPoP when chosen. Headers may sit beside OAuth except `Authorization` and `DPoP`, which carry the OAuth token; DPoP needs OAuth. The URL and the issuer use https, or http on a loopback host (localhost, 127.0.0.0/8, ::1).
- mcp-catalog::US-001/AC-05: Every server has a per-call timeout of 1–600 seconds (default 60), a trusted switch that decides whether its tool annotations are believed, and an enabled switch.
- mcp-catalog::US-001/AC-06: Saving a new server shows a confirmation card with the exact command and arguments under 本机将运行, or the exact address under 将连接. Nothing is stored or started until the owner confirms it; closing the drawer instead leaves no trace.

### mcp-catalog::US-002 Import servers from JSON

As the owner, I want to paste an existing `{"mcpServers": {…}}` document, so that I can bring in servers I already use elsewhere.

- mcp-catalog::US-002/AC-01: "导入 JSON" opens in the same drawer. "检查" lists each server as 将导入, saying whether it is a local program or an address, or as 跳过, with the reason for skipping: a server with the same name exists, or the transport is SSE. Other reasons are an unsupported transport, an invalid name, no command or URL, both a command and a URL, or the message of a field that fails its check. A server to be imported names the values it brings without content: a value that is only a placeholder such as `${NAME}` or `${input:…}` is imported empty, for the owner to fill in. A text that is not JSON or has no `mcpServers` is refused on one line under it.
- mcp-catalog::US-002/AC-02: A confirmation card shows the commands of the servers to be imported under 本机将运行 and their addresses under 将连接. Only "确认并导入" imports them, after which the first imported server opens.
- mcp-catalog::US-002/AC-03: Imported servers are untrusted and attached to no profile.

### mcp-catalog::US-003 See each server's state and tools

As the owner, I want to see whether each server works and what it offers, so that I can tell what profiles gain by attaching it.

- mcp-catalog::US-003/AC-01: The table shows, per server: the name; the transport, 本机程序 with its command or 网址 with its URL; the state, with any error and the next automatic retry; the tool count with the usable count and pending reviews; and the attached profiles. With no server registered, the table says so and points to "添加服务器".
- mcp-catalog::US-003/AC-02: The drawer's connection section shows the state, the server's name and version, the negotiated protocol, authentication (OAuth client_credentials with the client ID, and · DPoP when used, or the names of the headers), sandbox, connected time, error, automatic retry, how tool annotations are treated, and the tail of the program output. "重新连接" restarts the connection.
- mcp-catalog::US-003/AC-03: The drawer lists the profiles that attach the server, each linking to the team page to unbind it.

### mcp-catalog::US-004 Decide which tools agents get

As the owner, I want to approve and switch off individual tools, so that a server cannot hand agents a new or changed tool without my review.

- mcp-catalog::US-004/AC-01: Every tool has a checkbox; unchecking it disables the tool. Disabling is a revocation under [agent-dispatch::REQ-017/AC-02](agent-dispatch.md).
- mcp-catalog::US-004/AC-02: Read-only and may-modify-data marks appear only for trusted servers.
- mcp-catalog::US-004/AC-03: Tool definitions are pinned. A tool that is new, or whose definition changed, shows "待复核" and is not provided until confirmed. A changed tool shows which parts changed and its old description. Each such tool has "确认", and "全部确认" appears when several wait.
- mcp-catalog::US-004/AC-04: Tools that the server marks as requiring human interaction show "需人工确认，不提供" and are never provided.

### mcp-catalog::US-005 Delete a server

As the owner, I want to delete servers I no longer use, without silently taking capabilities away from a profile.

- mcp-catalog::US-005/AC-01: While any profile attaches the server, delete is disabled and the drawer says why.
- mcp-catalog::US-005/AC-02: An unattached server asks for inline confirmation; deleting it stops its connection and removes its stored secrets.

## Functional Requirements

### mcp-catalog::REQ-001 Write-only secrets (direct acceptance)

Environment values, header values and OAuth secrets can only be written. Saved values show as `••••••`, whatever their length, and an unchanged field keeps its value; a value imported empty shows empty. A saved OAuth client secret is kept only while the issuer stays the same. Secrets of 6 characters or more appear as `***` in errors and in program output; shorter values are not masked there, because they cannot be told apart from ordinary text. A secret is masked as it is and also as JSON text writes it, with its quotes, backslashes and line breaks escaped. The same rule masks a server's saved secrets in everything a proxy call returns to an agent: the result's text, every string of its structured content, keys included, and the message of a call that failed. No console API returns a secret.

A URL server's secrets go only where the owner pointed them. Header values are sent only to the configured URL's origin, never to the authorization server. The client secret goes only to the configured issuer. The access token goes only to the configured URL's origin. DPoP proofs go only to that origin and to the issuer's token endpoint. This holds when a redirect, the protected-resource metadata or a 401 challenge names another origin.

### mcp-catalog::REQ-002 Confirm what a server runs (direct acceptance)

Changing a server's command, arguments, URL or transport shows a confirmation card with the new exact command or address before anything is saved. Because the host holds one connection per server, a confirmed change applies to every call after the server reconnects, including calls in running requests; for an attached server the card says so. Tools whose definitions change then wait for review under mcp-catalog::US-004/AC-03.

### mcp-catalog::REQ-003 Host-held connections and proxy tools

- mcp-catalog::REQ-003/AC-01: The host service connects every enabled server and holds its credentials. Agents never see them, and MCP programs never receive model keys.
- mcp-catalog::REQ-003/AC-02: An agent receives tools named `mcp__<server>__<tool>` only for servers its profile attaches, and only tools that are enabled, reviewed and not marked for human interaction.
- mcp-catalog::REQ-003/AC-03: Each call is re-checked under [agent-dispatch::REQ-016/AC-03](agent-dispatch.md) and bounded by the server's timeout. Refused calls are audited under [agent-console::REQ-004](agent-console.md).
- mcp-catalog::REQ-003/AC-04: After a failure the host retries the connection automatically and refreshes tool lists periodically. Results of both appear only as state lines and review marks.
- mcp-catalog::REQ-003/AC-05: MCP tool calls are not confirmed one by one; pinning, the human-interaction rule, per-profile attachment and the audit replace per-call confirmation.

## Constraints

### mcp-catalog::CON-001 Capability beyond module permissions only through owner grants (direct acceptance)

Applies to: every agent. Capability beyond module permissions reaches an agent only through a server that the owner registered with confirmation (mcp-catalog::US-001/AC-06) and attached to that agent's profile with a second confirmation ([team-management::US-003/AC-03](team-management.md)).

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Owner fills in a server and closes the card without confirming | Nothing stored or started under mcp-catalog::US-001/AC-06 |
| Name has a space, 33 characters, or duplicates another server | Refused under mcp-catalog::US-001/AC-02 |
| Owner tries to rename a server | Name is fixed under mcp-catalog::US-001/AC-02 |
| Timeout set to 0 or 601 | Refused under mcp-catalog::US-001/AC-05 |
| Owner edits a server and leaves secret fields untouched | Secrets kept under mcp-catalog::REQ-001 |
| Program prints its token, or an error contains a header value | Masked as `***` under mcp-catalog::REQ-001 |
| A sandboxed `npx` server without `registry.npmjs.org` among its allowed domains | Fails to start; its error and output tail show npm's network error under mcp-catalog::US-003/AC-01 |
| A sandboxed server needs a cache of another package tool (uv, pip and others) | Not provided; the program cannot use the home directory's caches and must work without them or get a writable directory from the owner |
| Owner names a file as an argument of a sandboxed server | Only that file is readable, not its directory or siblings, under the sandbox decision |
| Owner sets a sandboxed server's working directory to the home or the state directory | Refused like a readable directory, under mcp-catalog::US-001/AC-03 |
| A secret shorter than 6 characters appears in program output or an error | Shown unmasked there; still shown as `••••••` in the configuration, under mcp-catalog::REQ-001 |
| Owner changes the command of an attached server | Confirmation card states it affects running requests under mcp-catalog::REQ-002 |
| Server fails to start or its URL is unreachable | State shows the error and the next retry under mcp-catalog::US-003/AC-01 and mcp-catalog::REQ-003/AC-04 |
| Server adds a tool or changes a definition while running | Tool waits for review and is not provided under mcp-catalog::US-004/AC-03 |
| Server marks a tool as requiring human interaction | Never provided under mcp-catalog::US-004/AC-04 |
| Untrusted server claims a tool is read-only | Mark not shown under mcp-catalog::US-004/AC-02 |
| Owner disables a tool or the server while an Executor uses it | The next call is refused under mcp-catalog::US-004/AC-01 and [agent-dispatch::REQ-017/AC-02](agent-dispatch.md) |
| Executor calls a tool of a server its profile does not attach, or a misspelled proxy name | Refused and audited under mcp-catalog::REQ-003/AC-03 |
| Call exceeds the timeout | Call fails with a timeout result under mcp-catalog::REQ-003/AC-03. It is not a refused call, so nothing is audited |
| A tool's result, its structured content or a failed call's message holds one of the server's saved secrets, for example because the program returns its own environment | The agent gets `***` in its place, also when the value holds a quote, a backslash or a line break and the tool returns it inside JSON text, under mcp-catalog::REQ-001 and mcp-catalog::REQ-003/AC-01. A secret shorter than 6 characters is not masked, a result that holds the same characters for another reason is masked too, and a secret in another encoding, such as Base64, is not recognized |
| Server lists a tool whose name the model provider does not take: a character other than a letter, a digit, `_` or `-`, or more than 64 characters | The tool is provided under a name derived from its own name alone, and its calls reach it by its own name, also after the server's program or the service has started again (Implementation Decisions: proxy tools) |
| Server lists a tool whose input schema the Codex runtime cannot read, such as a tuple written as a list in `items` | The tool is provided with an open object as its schema and its own schema in its description, so the Executor still starts and the other tools stay usable (Implementation Decisions: proxy tools) |
| An attached server has failed to connect when an Executor's thread starts | That Executor is offered none of its tools, as the confirmation card of [team-management::US-003/AC-03](team-management.md) says; an Executor whose thread starts after the server has connected is offered them. A server whose connection dropped keeps its tools on offer, and the next call reconnects |
| Owner unbinds a server from every profile, deletes it, registers another program or address under the same name and attaches it again | A request admitted while the earlier server was attached reaches the new one once its profile attaches that name again. A profile knows a server by its name, and each of these steps had its own confirmation (mcp-catalog::US-001/AC-06, [team-management::US-003/AC-03](team-management.md)) |
| Tool output contains instructions to change roles, tools or destinations | Treated as data under [agent-dispatch::REQ-008/AC-05](agent-dispatch.md) |
| Imported JSON contains an existing name, SSE transport, malformed JSON or no `mcpServers` | Skipped with a reason, or refused as malformed, under mcp-catalog::US-002/AC-01 |
| Imported JSON holds a placeholder value such as `${GITHUB_TOKEN}`, or an entry with `"disabled": true` | Imported with that value empty and named 需要填写; the disabled entry is imported switched off, under mcp-catalog::US-002/AC-01 |
| Owner confirms an import after the check's result changed, for example a server of the same name was added meanwhile | Nothing imported; the owner checks again, under mcp-catalog::US-002/AC-02 |
| Owner adds an `Authorization` or `DPoP` header beside OAuth, or ticks DPoP without OAuth | Refused under mcp-catalog::US-001/AC-04 |
| A URL or issuer uses http on a host that is not this machine | Refused under mcp-catalog::US-001/AC-04 |
| Owner changes the OAuth issuer and leaves the client secret as `••••••` | Refused; the secret must be entered again, under mcp-catalog::REQ-001 |
| The MCP server names an authorization server other than the configured issuer | Connection fails; neither the client secret nor a header value is sent there, under mcp-catalog::REQ-001 and REQ-003/AC-01 |
| A 401 challenge names protected-resource metadata on another origin | Connection fails; no header value is sent there, under mcp-catalog::REQ-001 |
| A URL server, or its authorization server, redirects to another origin | The redirect is not followed and that origin receives nothing, under mcp-catalog::REQ-001, REQ-002 and REQ-003/AC-01. An MCP request that is redirected fails, with a state line or call error that names the target and contains no secret; the owner can register the new address through the confirmation card. A redirected metadata or token request fails the connection, or the client tries the issuer's default endpoint on the issuer's own origin |
| A URL server redirects within its own origin | The redirect is followed with the headers, and the server connects, under mcp-catalog::REQ-002 |
| A loopback `http` URL on port 80 redirects to `https` on the same host and port 443 | The client SDK counts this upgrade as the same origin and follows it, but the headers are not added there, because it is another origin; a server that needs them fails to connect, under mcp-catalog::REQ-001 |
| The owner sets headers on a URL server with OAuth whose issuer sits on another origin | The headers go only to the URL's origin; an authorization server that needs a header of its own cannot get it, under mcp-catalog::REQ-001 |
| An authorization server's metadata lacks `authorization_endpoint` | Connection fails with the metadata error: the client SDK requires the field even for client_credentials, under mcp-catalog::US-003/AC-01 |
| A connected URL server stops answering | The next failed call or periodic listing reconnects at once; then the state shows the error and the next retry, under mcp-catalog::REQ-003/AC-04 |
| Owner deletes a server still attached to a profile | Delete disabled under mcp-catalog::US-005/AC-01 |
| Owner deletes, from a drawer opened earlier, a server that a profile has attached since | The service refuses with 「被 <n> 个能力档绑定。先在团队管理解绑，才能删除。」, and the drawer then shows the attaching profiles, under mcp-catalog::US-005/AC-01 |
| Service restarts | Enabled servers reconnect; pinned definitions and reviews persist under mcp-catalog::REQ-003/AC-01 and mcp-catalog::US-004/AC-03 |
| Service stops while a server is still connecting, or while a reconnection or change is replacing a server's program | Every program the catalog started is stopped before the shutdown finishes, under mcp-catalog::REQ-003/AC-01 and the connection-manager decision |

## Implementation Decisions

**Configuration shape.** The catalog follows the owner's agent-link configuration: name, transport (stdio command, arguments, working directory and environment; or Streamable HTTP URL with headers and optional OAuth client_credentials with DPoP), optional macOS sandbox, timeout, trusted and enabled, plus per-tool disable flags and pinned tool definitions. Secrets (environment values, header values, OAuth client secrets) are stored apart from the readable configuration: two owner-only files in the service's state directory, each replaced atomically, so that after a deletion, or after a change of transport drops the other transport's secrets, no state file holds them. Servers saved before URL servers existed carry no transport and load as local programs.

**Confirmation is enforced by the host.** A new server, and a change of its command, arguments, URL or transport, carry the exact launch line or address the confirmation card showed; the host recomputes it and refuses a mismatch, so a skipped or stale card stores and starts nothing. The card's line comes from the host: a command quoted as a POSIX shell reads it, an address as the normalized URL it connects to.

**URL servers.** A URL server connects over Streamable HTTP with its headers on every request to the configured URL's origin. The client SDK also runs OAuth discovery through the transport's fetch, at addresses the server names, so the headers are added by a fetch that checks each request's origin instead of being set for all requests; a header the SDK sets itself (`Authorization`, the session and protocol headers, `Accept`) keeps the SDK's value. Redirects follow the SDK's same-origin policy, set explicitly: a redirect is followed only within the origin of the request and with the same method, and any other redirect fails the request. With OAuth, the host is a client_credentials client authenticating with `client_secret_basic`, and the configured issuer is the SDK's `expectedIssuer`, so the secret goes only to that authorization server even when the MCP server names another. With DPoP the token is bound to a proof key. Access tokens and DPoP keys live in memory, one set per connection: a reconnection or a restart requests a new token, and no token is written to disk. A scope challenge is an error, because a client_credentials client cannot widen its scope by asking again. A URL server has no process whose exit announces a lost connection, so a failed call or listing that the server did not answer reconnects at once; a JSON-RPC error or a timed-out call keeps the connection. URL servers are listed again every 10 minutes even when they announce tool changes, because those notifications travel on an optional stream.

**Import.** The import reads `mcpServers` and ignores other top-level keys (Claude Desktop keeps its settings beside it):
- An entry with `command` (and `type` absent or `stdio`) is a local program: `command`, `args`, `cwd` and `env`.
- An entry with `url` (and `type` absent, `http`, `streamable-http` or `streamableHttp`) is a URL server: `url` and `headers`. `type: "sse"` is skipped as SSE; another type is skipped as unsupported.
- `"disabled": true` imports the server switched off. Unknown keys are ignored, and no sandbox, OAuth or timeout is imported.
- Values are taken literally, except a value that is only a placeholder another client would expand, which is imported empty.
- The confirmation carries the names and lines of the servers the check offered; the host checks the same document again and refuses a mismatch. All of them are stored in one change with one audit entry.

**Connection manager.** One host-side manager owns all connections. It connects enabled servers, retries after failures, refreshes tool lists, compares them with pinned definitions, and executes proxy calls. A proxy call is checked against the caller's request snapshot and the current configuration before it is forwarded. Following agent-link: a connection attempt times out after 30 seconds; retries start after 30 seconds and double up to 10 minutes; servers that do not announce tool-list changes are listed again every 10 minutes; a server's first tool listing is pinned as a whole, and pins survive a change of command; the requires-human-interaction mark is `_meta["anthropic/requiresUserInteraction"] = true`; a program's environment is its own variables plus the basic ones (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TERM`, `SHELL`, `TMPDIR`, `XDG_*`, `NODE_EXTRA_CA_CERTS`); the output tail keeps the last 4,000 characters. Closing the manager, as the service does at shutdown, stops every program it started and finishes only once they have all stopped. This includes a program still connecting and one that a reconnection or change replaced. Stopping a program closes its input; a program still running 2 seconds later gets SIGTERM, then SIGKILL after 2 more seconds (the client SDK's close).

**Proxy tools.** A proxy tool is named `mcp__<server>__<tool>`; the console, the audit and these specs write it so. The Codex App Server keeps the name `mcp` and every name that begins with `mcp__` for its own MCP client, and refuses a thread that is offered a host tool or namespace so named. An Executor's runtime is therefore offered each server's tools as one namespace named `mcp-<server>`, and the host maps a call back to the server and the tool.
- **Which tools.** When an Executor's thread starts, it is offered the usable tools (enabled, reviewed, not marked for human interaction) of each server that its profile attached in its request's definitions version and attaches in the current definitions. A server with no usable tool then adds no namespace. The service sends a thread its tools only when the thread starts: a thread that a retry or a supplement resumes keeps the list it started with, and each of its calls is checked when it is made.
- **Names.** The model provider takes a tool name of letters, digits, `_` and `-`, at most 64 characters, and the App Server refuses a thread that is offered any other. A tool with such a name is offered under it. Any other name is offered with every other character as `_`, cut to 55 characters, followed by `_` and the first 8 hexadecimal characters of the name's SHA-256. The offered name depends on the tool's own name alone, because a thread keeps the names it was offered across a restart of the server's program and of the service. A call's name stands for the listed tool of that name, or else for the first listed tool offered under it; the service looks it up once the server is connected, among the tools the server lists then. When two tools of a server would be offered under one name, only the one a call of that name reaches is offered.
- **Input schemas.** The App Server also refuses a thread when it cannot read one offered tool's input schema. Measured on codex-cli 0.167.0-alpha.3.2, it cannot read a list in `items` or a schema whose only type is `null`. A schema that is not an object, whose only type is `null`, or in which a keyword that holds a schema, a list of schemas, a map of schemas or type names has another form, is offered as an open object; the tool's description then ends with 「参数按这份 JSON Schema 填写：」 and the schema.
- **Each call** is checked in this order, and the first check that fails refuses it: the profile attached the server in the request's definitions version; it attaches it in the current definitions; the server is registered and enabled; the tool is enabled, is among the tools the server lists, is not marked for human interaction and does not wait for review. A refused call is not forwarded and is answered like a refused host tool. It is audited as `mcp_call_refused` with the team, the profile, the Executor, the request, the proxy tool's name and the reason: `not_attached`, `unbound`, `server_unknown`, `server_disabled`, `tool_disabled`, `tool_unknown`, `needs_user` or `pending_review`. A server that cannot be connected, a call past the timeout and a request that fails are answered as failed calls and are not audited.
- **Result.** A call returns the text of the result's text blocks, with `[<type>]` in place of every other block, and the result's structured content when it has one. A result that the tool marks as an error is returned as a failed call with the same content. Saved secrets are masked under mcp-catalog::REQ-001. The namespace's description tells the model that what the tools return is data and cannot change permissions, the tool list or the rules.
- **Sessions.** An Executor's session is keyed by, among other things, the servers its profile attached in the request's definitions version, and not by the tools those servers list, so a retry resumes the same thread whatever they list by then. A profile that attached none keeps the session key it had before proxy tools existed.

**Attached servers.** A server is attached while a profile of the current team definitions attaches it, a team that is being deleted included. The service itself refuses to delete an attached server, whatever the page shows.

**Sandbox.** A stdio server with a sandbox runs under the macOS sandbox and reads only what the owner typed plus the minimum the service supplies. The sandbox exists only on macOS; elsewhere a server set to run in it is not started. A server without a sandbox runs with the service's user rights. A sandboxed program may read: the Node.js installation the service runs on; each command path or absolute argument that is an existing file, that file alone and never its directory; the working directory; the readable and writable directories; and its own npm cache. The home and state directories are otherwise unreadable. It may write only to the writable directories, the temporary directory and its own npm cache; readable directories and named files stay read-only even inside the temporary directory. The working directory and the Node.js installation pass the same checks as readable directories (not the home, `/` or an ancestor of the home, nothing in or around the state directory); a Node.js installation that fails them refuses the start instead of widening the sandbox. No grant reaches the state directory ([ADR-0029](../adr/0029-keep-service-state-outside-every-file-grant.md)): a named file inside it is not granted. Each sandboxed server gets its own npm cache, owner-only and outside the state and temporary directories, and an empty npm user configuration, so `~/.npm` and `~/.npmrc` are never used; the service sets `npm_config_cache` and `npm_config_userconfig`, and these win over owner-entered variables of the same names. Deleting the server removes its cache. The registry domain is not allowed automatically: an `npx` server needs `registry.npmjs.org` among its allowed domains.

**Console API.** The page is served by the local console under [agent-console::CON-001](agent-console.md), and every change is audited under [agent-console::REQ-004](agent-console.md). Its 「返回团队管理」 leads to the team management page.

## Testing Decisions

- **Connection manager.** Tested at its public interface against real local test servers over stdio and Streamable HTTP: connection, retry, timeout, pinning and review, human-interaction filtering, secret masking, proxy-call checks, and that closing stops every program, including one still connecting and one a reconnection replaced. Where URL-server secrets go is checked with a second loopback origin that records the header names reaching it, while the test servers redirect requests there or name it in their metadata.
- **Proxy boundary.** Tested at the host tool boundary: the tools a turn is offered, refusal of calls outside the snapshot or after a revocation, and the audit entry.
- **Console.** HTTP-boundary tests of the catalog API with an authorized browser, including that no response contains a secret. Playwright end-to-end tests drive register, confirm, import, review, disable and delete.

## Out of Scope

- Per-profile credentials or separate connections per profile.
- SSE transport.
- Tools that require human interaction.
- Per-call confirmation of MCP tool calls.
- Letting an agent runtime start MCP servers itself (ADR-0027).
