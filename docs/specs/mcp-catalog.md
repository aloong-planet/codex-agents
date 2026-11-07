# MCP catalog

> Status: specified; not implemented.
> Related: [team management](team-management.md), [agent dispatch](agent-dispatch.md), [agent console](agent-console.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md).
> Pending: no agent can use an MCP server; group runtimes disable every inherited integration, and no MCP Catalog exists.

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
- mcp-catalog::US-001/AC-04: A URL server (Streamable HTTP) takes a URL and either headers or OAuth client_credentials (issuer, client ID, secret, scope), optionally presenting the token with DPoP.
- mcp-catalog::US-001/AC-05: Every server has a per-call timeout of 1–600 seconds (default 60), a trusted switch that decides whether its tool annotations are believed, and an enabled switch.
- mcp-catalog::US-001/AC-06: Saving a new server shows a confirmation card with the exact command and arguments, or the exact address. Nothing is stored or started until the owner confirms it.

### mcp-catalog::US-002 Import servers from JSON

As the owner, I want to paste an existing `{"mcpServers": {…}}` document, so that I can bring in servers I already use elsewhere.

- mcp-catalog::US-002/AC-01: "导入 JSON" opens in the same drawer. Checking the document lists each server as to be imported or skipped, with the reason for skipping: a server with the same name exists, or the transport is SSE.
- mcp-catalog::US-002/AC-02: A confirmation card shows the commands and addresses of the servers to be imported. Only confirming it imports them.
- mcp-catalog::US-002/AC-03: Imported servers are untrusted and attached to no profile.

### mcp-catalog::US-003 See each server's state and tools

As the owner, I want to see whether each server works and what it offers, so that I can tell what profiles gain by attaching it.

- mcp-catalog::US-003/AC-01: The table shows, per server: the name; the transport with its command or URL; the state, with any error and the next automatic retry; the tool count with the usable count and pending reviews; and the attached profiles.
- mcp-catalog::US-003/AC-02: The drawer's connection section shows the state, the server's name and version, the negotiated protocol, authentication, sandbox, connected time, error, automatic retry, how tool annotations are treated, and the tail of the program output. It offers reconnect.
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

Environment values, header values and OAuth secrets can only be written. Saved values show as `••••••`, and an unchanged field keeps its value. Secrets appear as `***` in errors and in program output, and no console API returns them.

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
| Owner changes the command of an attached server | Confirmation card states it affects running requests under mcp-catalog::REQ-002 |
| Server fails to start or its URL is unreachable | State shows the error and the next retry under mcp-catalog::US-003/AC-01 and mcp-catalog::REQ-003/AC-04 |
| Server adds a tool or changes a definition while running | Tool waits for review and is not provided under mcp-catalog::US-004/AC-03 |
| Server marks a tool as requiring human interaction | Never provided under mcp-catalog::US-004/AC-04 |
| Untrusted server claims a tool is read-only | Mark not shown under mcp-catalog::US-004/AC-02 |
| Owner disables a tool or the server while an Executor uses it | The next call is refused under mcp-catalog::US-004/AC-01 and [agent-dispatch::REQ-017/AC-02](agent-dispatch.md) |
| Executor calls a tool of a server its profile does not attach, or a misspelled proxy name | Refused and audited under mcp-catalog::REQ-003/AC-03 |
| Call exceeds the timeout | Call fails with a timeout result under mcp-catalog::REQ-003/AC-03 |
| Tool output contains instructions to change roles, tools or destinations | Treated as data under [agent-dispatch::REQ-008/AC-05](agent-dispatch.md) |
| Imported JSON contains an existing name, SSE transport, malformed JSON or no `mcpServers` | Skipped with a reason, or refused as malformed, under mcp-catalog::US-002/AC-01 |
| Owner deletes a server still attached to a profile | Delete disabled under mcp-catalog::US-005/AC-01 |
| Service restarts | Enabled servers reconnect; pinned definitions and reviews persist under mcp-catalog::REQ-003/AC-01 and mcp-catalog::US-004/AC-03 |

## Implementation Decisions

**Configuration shape.** The catalog follows the owner's agent-link configuration: name, transport (stdio command, arguments, working directory and environment; or Streamable HTTP URL with headers or OAuth client_credentials and optional DPoP), optional macOS sandbox, timeout, trusted and enabled, plus per-tool disable flags and pinned tool definitions. Secrets are stored apart from the readable configuration.

**Connection manager.** One host-side manager owns all connections. It connects enabled servers, retries after failures, refreshes tool lists, compares them with pinned definitions, and executes proxy calls. A proxy call is checked against the caller's request snapshot and the current configuration before it is forwarded.

**Sandbox.** A stdio server with a sandbox runs under the macOS sandbox with only its allowed domains and directories. A server without a sandbox runs with the service's user rights.

**Console API.** The page is served by the local console under [agent-console::CON-001](agent-console.md), and every change is audited under [agent-console::REQ-004](agent-console.md).

## Testing Decisions

- **Connection manager.** Tested at its public interface against real local test servers over stdio and Streamable HTTP: connection, retry, timeout, pinning and review, human-interaction filtering, secret masking and proxy-call checks.
- **Proxy boundary.** Tested at the host tool boundary: the tools a turn is offered, refusal of calls outside the snapshot or after a revocation, and the audit entry.
- **Console.** HTTP-boundary tests of the catalog API with an authorized browser, including that no response contains a secret. Playwright end-to-end tests drive register, confirm, import, review, disable and delete.

## Out of Scope

- Per-profile credentials or separate connections per profile.
- SSE transport.
- Tools that require human interaction.
- Per-call confirmation of MCP tool calls.
- Letting an agent runtime start MCP servers itself (ADR-0027).
