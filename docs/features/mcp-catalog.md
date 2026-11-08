# MCP management

> Related decisions: [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md)

## Overview

The owner wants to give agents capabilities beyond module permissions through MCP servers, without ever handing an agent a credential or letting a server change what it offers unnoticed. The console's MCP 管理 page registers local MCP programs once, after the owner confirms exactly what will run; the service holds every connection, and the owner reviews and switches off the tools each server offers.

## Capabilities

- MCP 管理 lists every registered server with its name, the command it runs, its state with any error and the time of the next automatic retry, its tool count with the usable count and the tools waiting for review, and the profiles that attach it. With no server registered, the table says so and points to 添加服务器.
- 添加服务器 opens a form in a drawer. Field labels carry required and optional tags, and explanations sit in info tips:
  - a name of 1–32 letters, digits, `_` or `-`, unique and fixed after creation, which becomes part of every tool name;
  - the command, arguments one per line, a working directory (the home directory when left empty) and environment variables;
  - an optional macOS sandbox with allowed domains, readable directories and writable directories;
  - a per-call timeout of 1–600 seconds (60 when left empty), a trusted switch and an enabled switch.
- Saving a new server, or a change of its command or arguments, first shows a card with the exact command line. Nothing is saved or started until the owner confirms that card; closing the drawer instead leaves no trace.
- The service starts each enabled program and holds its connection. A program receives its own environment variables and the basic ones it needs to run, never a model key.
- A server's drawer shows its connection: state, server name and version, negotiated protocol, sandbox, connected time, error, automatic retry, how tool annotations are treated, and the tail of the program's output. 重新连接 restarts the connection.
- After a failure the service retries on its own, first after 30 seconds and then at doubling intervals of at most 10 minutes. It keeps each server's tool list current, when the server announces a change or every 10 minutes for servers that do not.
- Every tool has a checkbox; unchecking it stops providing the tool from the next call on. Read-only and may-modify-data marks appear only for servers marked trusted.
- A server's first tool list is pinned. A tool added later, or whose definition changes, shows 「待复核」 with the parts that changed and its old description, and is not provided until the owner presses 「确认」; 「全部确认」 appears when several wait. Tools that the server marks as needing a person show 「需人工确认，不提供」 and are never provided.
- Environment values can only be written. Saved values show as `••••••`, and a value left unchanged is kept. Values of 6 characters or more appear as `***` in errors and in program output.
- A confirmed change of the command or arguments applies once the server has reconnected, and tools whose definitions changed then wait for review.
- A server no profile attaches can be deleted after an inline confirmation; its connection stops and its saved environment values are removed.
- Every saved change is recorded in the local audit file with the browser that made it, never with an environment value.

## Boundaries and non-goals

- Only local programs can be registered.
- Registering a server gives no agent its tools: no profile attaches a server.
- The sandbox exists only on macOS; a server set to run in it is not started elsewhere.
- A sandboxed program reads only the directories the owner listed, its working directory, the files named in its command and arguments (each file alone, not its directory) and what it needs to run; the home and the service's own data stay out of reach. Readable directories and named files stay read-only.
- A sandboxed program started with `npx` needs `registry.npmjs.org` among its allowed domains. It gets its own npm cache and never reads the owner's npm settings; caches of other package tools, such as uv or pip, are not provided.
- Environment values shorter than 6 characters are not masked in errors or program output.
- Tool calls are not confirmed one by one.
