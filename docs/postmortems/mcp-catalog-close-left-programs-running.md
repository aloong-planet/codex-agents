# Closing the MCP catalog left server programs running

Date: 2026-11-11 (agent-teams ticket 33).

## Root cause

`McpCatalog.close()` stopped only the client each connection held at that moment, so it returned before every program it had started was gone. Two kinds of program were never reached:

- **A program a reconnection or change replaced.** `connect()` closed the old client in the background (`void old?.close()`), and nothing waited for that stop.
- **A program still connecting.** Its client was not yet on the connection, so `close()` had nothing to stop; the connection attempt closed it later, again in the background.

The client SDK's close ends the program's input, waits 2 s on an unref'd timer, then sends SIGTERM and, 2 s later, SIGKILL. A process that exits soon after `close()` resolves leaves a program that keeps running after its input ends behind, with parent PID 1. The service at shutdown and a vitest worker at the end of a file are both such processes.

`tests/mcp-catalog-api.test.ts` left one test server per run this way. Its case "no console response contains a secret" reconnects and then ends in under 400 ms. The test server keeps running after its input ends, because it watches its tools file. By 2026-11-10, 17 such orphans from removed worktrees had accumulated.

## Why the existing checks did not catch it

- No test checked for programs left running after `close()` or after a case. The catalog's existing checks each wait for one named program to stop, after a disable, a delete or a change of transport (`tests/mcp-catalog.test.ts` at d6cebaa, lines 257, 309 and 673), and no test at d6cebaa listed processes.
- `tests/mcp-catalog.test.ts` ran the same paths without leaving anything behind: its later cases kept the worker alive past the SDK's 2 s SIGTERM, so every background stop finished in time.
- A program still connecting at close was not seen running after a whole run of the API file. The new check found it still running right after `close()` resolved, on "audit entries name the browser that made the change"; what ended it later was not established.

## Defenses

- The catalog keeps every client it started, with its stop once begun, and `close()` stops and awaits all of them (mcp-catalog spec, Implementation Decisions, "Connection manager").
- Every case of `tests/mcp-catalog-api.test.ts` ends by checking that no program naming the case's temporary directory is still running. The check runs after the catalog closed, and it kills what it finds so that a red run leaves nothing behind (`stopRunningPrograms` in `tests/fixtures/mcp-test-server-control.ts`).
- Two catalog cases close right after the event, with nothing else for `close()` to wait for: one after a reconnection whose new program fails at once, one while a program is still connecting.

## Boundaries

- The API file's check sees only the paths that file drives. In its reconnect case, other stops outlast the replaced program's, so the replaced path is guarded by the catalog case, not by the check.
- Programs that do not name a case's temporary directory, such as the imported `npx x` server, are not seen by the check. That one was running during its case and gone after it in one observed run.
- Evidence is in agent-teams ticket 33's local working records (`docs/.workings/agent-teams/ticket-33-test-report.md` and `ticket-33-evidence/`). They are not committed.
