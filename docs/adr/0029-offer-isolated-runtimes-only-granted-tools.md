# ADR-0029: Offer an isolated runtime only the tools its host grants

- Status: Proposed

## Context

Every isolated runtime of [ADR-0023](0023-isolate-feishu-group-authority.md) was offered tools that the host never granted, in every runtime kind tested on the pinned Codex App Server. That was tested with the binary's own model catalog. The remote catalog that production runtimes fetch with the owner's login was not inspected, and this decision no longer uses it. The bundled catalog sets `tool_mode = "code_mode_only"` for every `gpt-5.6` and `gpt-6` model, which overrides `--disable code_mode`. Under Responses Lite the whole tool list then reaches the model as an `additional_tools` input item. Each runtime was offered:

- `exec`, code-mode JavaScript with `apply_patch` and the MCP resource tools nested inside;
- `wait` and `request_user_input`;
- Codex's sub-agent tools: `multi_agent_v1` on luna, and top-level `collaboration.*` on terra and sol.

Its host tools and web search were reachable only through `exec`. Under the "group" permission profile `apply_patch` wrote nothing and the MCP resource tools read nothing. `spawn_agent`, however, created live sub-agent threads that made their own model requests and wrote their own rollouts, and the service neither starts nor observes such threads. A read-only check of production found that none had ever been created.

## Options

1. **A direct-mode model catalog in each runtime's own home, derived from the binary's bundled catalog, with user input and sub-agents switched off. A runtime that cannot get the catalog does not start.**
2. Keep code mode and switch off only user input and sub-agents, excluding the default namespace from `exec`. Rejected: code mode always registers `exec` and `wait`, so the Coordinator would still be offered tools, contrary to agent-dispatch::CON-003 and agent-dispatch::REQ-016/AC-02.
3. Option 1 for tool-less runtimes and option 2 for host-tool and research runtimes. Rejected: two tool paths to keep correct, and the host-tool runtimes would still carry `exec`.
4. Restrict tools through thread or turn parameters. Not available: `thread/start`, `thread/resume` and `turn/start` take no tool parameter besides `dynamicTools`, and Codex's internal tool allowlist is set only for its own guardian reviewer.

## Decision

We adopt **option 1**.

- Every isolated runtime's `config.toml` and `-c` overrides do three things:
  - name `model_catalog_json` inside its own codex-home;
  - set `[tools.experimental_request_user_input] enabled = false`;
  - set `[agents] enabled = false`.
- The catalog is the binary's own `codex debug models --bundled` output with every model's `tool_mode` set to `"direct"` and `apply_patch_tool_type` set to null.
  - The service derives it in an empty home, from the binary that starts the runtime, before that binary's first isolated App Server or group research process.
  - It derives the catalog again when the binary's path, size or modification time changes.
  - It is not derived at service start: fixture mode must never run Codex (CI sets `CODEX_BIN` to `/usr/bin/false`), and research resolves its binary on every run.
- **Fail closed.** If the dump fails or has an unexpected shape, the runtime does not start:
  - an App Server start reports `isolated_runtime_catalog_unavailable`;
  - group research reports `research_runtime_unavailable`.

  An App Server whose catalog file is missing also exits at start.
- **Result:**
  - A runtime with no grant is offered no tools.
  - A group or dispatch-agent runtime is offered exactly its host tools, plus `web.run` where web search is live.
  - Group research through `codex exec` is offered `web.run` only.
  - The three owner-private App Servers run in the owner's own Codex home and keep the owner's tool surface: the main conversation, the pending responder and the private memory curator.
- **One table.** `ISOLATED_RUNTIME_KINDS` (`apps/weixin-service/src/isolated-runtime-kinds.ts`) holds each kind's root, scope, host tools, media access and conversation options. `main.ts` creates every isolated runtime from it, an architecture test enforces that, and the tests drive the same table.
- **No reset for older threads.** A thread saved before this change keeps the old tool list in its history and sends it again when resumed. Every tool on it is refused as an unsupported call and has no effect. This was decided on the owner's delegation on 2026-11-08, in preference to starting such threads afresh, which would drop group history and touch every thread store.

## Consequences

- Positive:
  - What reaches the model is exactly the host's grant: agent-dispatch::REQ-016/AC-02 and agent-dispatch::CON-003 hold at the model's tool list, not only at the host's tool handlers.
  - No runtime-supplied tool can start a sub-agent, apply a patch, read an MCP resource or ask the user anything.
- Negative:
  - Models whose catalog entry is `code_mode_only` now call host tools and `web.run` directly, which the fake-model tests cannot show a real model doing well.
    - The owner's three real-model checks are acceptance before any deployment: a group host-tool call, a group web search and a scheduled group research run.
    - This ADR stays Proposed until they pass.
  - Group research now searches through standalone `web.run`. [ADR-0015](0015-durable-scheduled-reminders.md)'s research amendment records that standalone search exposed no working research on an earlier Codex.
    - On the pinned binary, a direct `web.run` call reports the same search and page-open events that research requires.
    - Whether a real model searches this way is the owner's research check.
    - If that check fails, the fallback is to keep code mode, using the unmodified catalog, for group research only, with user input and sub-agents still off. Research would then be offered `exec` with `web.run` and an `apply_patch` that the sandbox rejects.
  - Isolated runtimes no longer use the remote model catalog. Model metadata changes reach them only with a binary update.
  - Resumed threads saved before this change still list the old tools, although every call to them is refused.
- Neutral:
  - The catalog fields and configuration keys are Codex internals and may change: `tool_mode`, `apply_patch_tool_type`, `[agents]` and `[tools.experimental_request_user_input]`. `pnpm --filter @aloong-planet/codex-weixin-service test:isolated-runtime` checks the tool surface on the installed binary and must be rerun after every Codex upgrade.
  - Private research, which runs without a group runtime, is unchanged.

## Sources

- **Binary.** Measured on 2026-11-08 with `codex-cli 0.167.0-alpha.3.2`, the executable bundled with the ChatGPT app, which the service selects when `CODEX_BIN` is unset.
- **Upstream source**, `openai/codex` at tag `rust-v0.167.0-alpha.3.2`:
  - the catalog's `tool_mode` overrides the code-mode feature (`core/src/tools/mod.rs`);
  - code mode always registers `exec` and `wait`, and in `code_mode_only` nests every code-mode-capable tool inside `exec` (`core/src/tools/spec_plan.rs`);
  - Responses Lite sends the tool list as an `additional_tools` input item (`core/src/client.rs`, `core/src/session/world_state.rs`);
  - `request_user_input` defaults to on (`config/src/config_toml.rs`);
  - only `[agents] enabled = false` forces sub-agents off (`core/src/config/mod.rs`);
  - `model_catalog_json` replaces the catalog without a remote fetch (`model-provider/src/provider.rs`);
  - the standalone `web.run` emits the same web-search begin and end events however it is called (`ext/web-search/src/tool.rs`).
- **Before the change.** Real App Server with a loopback fake Responses endpoint and the production runtime configuration:
  - `apply_patch`, nested in `exec` or called directly, was rejected by the "group" sandbox in the workspace, the runtime root, codex-home and an outside directory;
  - the MCP resource tools returned empty lists or "unknown MCP server";
  - `request_user_input` was refused as unavailable;
  - `exec` had no file, process or network access;
  - `spawn_agent` created sub-agent threads that kept the read-only sandbox.

  `tests/isolated-runtime-tools.test.ts` keeps this as its before-the-fix positive control.
- **After the change.** Same seam: `tests/isolated-runtime-tools.test.ts`.
  - Every kind in `ISOLATED_RUNTIME_KINDS` on luna, terra and sol, as applicable, is offered exactly its grant.
  - Every hidden tool call is refused with no file, no MCP read and no sub-agent.
  - A resumed pre-fix thread gets no tool back.
  - Group research is offered `web.run` only and still completes.
  - A runtime whose catalog file is missing does not start.

  Derivation and fail-closed start are checked in `tests/isolated-model-runtime.test.ts`; research wiring in `tests/scheduled-research-process.test.ts`.
- **Production check.** Owner-approved and read-only, 2026-11-08, covering every isolated runtime root: 23 rollouts. All 23 are ordinary threads, with no sub-agent rollout and no spawn edge.
- **Decisions.** Owner decisions made through a delegate on 2026-11-08:
  - this option;
  - in scope: the sub-agent tools and the group memory curator;
  - the meaning of "no `additional_tools` item unless granted";
  - the three real-model checks;
  - no reset for older threads;
  - the shared runtime table.
