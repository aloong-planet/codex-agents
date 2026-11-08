# ADR-0023: Separate group authority from shared discussion

- Status: Accepted (2026-11-05)

## Context

The owner authorizes selected members in selected Feishu groups to use existing file permissions while keeping personal memory and tasks private. Group members share discussion, but only the original requester may resolve a pending file operation.

## Options

1. **Resolve conversation scope and requester authority independently; isolate group model configuration and internal data.**
2. Reuse the private owner identity for every group member — rejected because personal memory, task scope and pending choices would become shared.
3. Split conversation history per sender — rejected because the owner explicitly chose shared group context.
4. Change only the memory key and rely on prompting — rejected because native tools, inherited plugins or broad file permissions could still read private state.

## Decision

Keep transport account, conversation, member authority, memory scope and task scope separate. The host admits only genuine bot mentions from allowlisted callers in allowlisted groups. Human discussion from all group members is inert, bounded context with its original author. Private owner bindings retain their existing identity and data semantics.

Each group has its own shared history, curated memory, task authority and trusted delivery destination. Pending file responses additionally bind the original sender without splitting shared discussion. Task management is available to all currently authorized members of that group; task IDs and all-channel queries do not broaden scope.

Group model sessions use isolated configuration, disable inherited host memory and uncontrolled tool integrations, and enforce protected internal-state boundaries beneath prompts. Existing business file grants remain usable through trusted tools, excluding service and personal model state. Revocation invalidates eligible saved context and queued work; accepted or uncertain sends are not replayed. One mutable business-state authority and scheduler remain in the service.

## Consequences

- Positive: shared discussion does not grant invocation, private-memory or pending-operation authority.
- Negative: identity resolution must be applied consistently to model sessions, memory curation, file tools, tasks, recovery and delivery; memory-key changes alone are insufficient.
- Neutral: local configuration is trusted and restart-applied. Platform permission approval and real-device receipt remain separate from automatic fixture validation. The isolated App Server start/turn/resume and CLI research paths were exercised with synthetic protected files and public research on Codex 0.166.0-alpha.6. This validates the runtime boundary, not tenant permissions or phone receipt.

## Sources

- [Channel specification](../specs/channel-switching.md), channel-switching::US-005 through channel-switching::US-007 and channel-switching::REQ-011/012.
- User-confirmed group, member, context, file, memory, task and pending-request decisions (2026-11-05).
- [OpenClaw Feishu implementation](https://github.com/openclaw/openclaw/tree/7c2ff8f775acca3e5c93c9c22b6247e37df29bae/extensions/feishu).
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Dispatch-mode extension

[ADR-0024](0024-coordinate-independent-group-agents.md) adds recognition of authorized ordinary messages in explicitly enabled dispatch groups, with original-author confirmation for inferred work. The private/group, requester, file and task boundaries above continue to apply; mention-only groups retain the original admission rule.

## Team-mode extension

[ADR-0026](0026-coordinate-group-work-through-isolated-teams.md) divides a dispatch group's agents into a Coordinator, Team Leaders and task-created Executors. Within such a group, the curated group memory above is visible only to the Coordinator. Every other agent sees only the brief it is handed plus its own memory scope, and the owner's private conversations with the Coordinator or Team Leaders never write to group memory. [ADR-0027](0027-bind-host-enforced-agent-profiles.md) (proposed) lets owner-configured, per-agent MCP servers and skills enter that agent's isolated runtime, while inherited host plugins and skill discovery stay disabled. The conversation, requester, file, task and revocation boundaries above are unchanged.

2026-11-08 follow-up: skipping host skill discovery did not keep the owner's skills out of group runtimes. The App Server still listed the real HOME's `.agents/skills` and Codex's bundled skills, and injected one when a member named it with `$<skill>`. Every isolated runtime now also gets its own HOME inside its runtime root and runs with bundled skills disabled. Threads saved before this change keep the earlier skill catalog, and the body of any skill named in them, in their history and send it again when resumed; it stays with the audience that already saw it, and the file paths it lists are no longer readable. Threads started after the change carry none of it. [ADR-0027](0027-bind-host-enforced-agent-profiles.md), called proposed above, was accepted on 2026-11-08; its Sources hold the evidence.

2026-11-08 follow-up, tool surface: disabling Codex features did not keep runtime-supplied tools out of isolated runtimes. On the pinned App Server, the binary's model catalog puts an isolated runtime in code mode. In tests with that catalog, each runtime kind was offered:
- `exec`, with `apply_patch` and the MCP resource tools nested inside;
- `wait` and `request_user_input`;
- Codex's sub-agent tools.

None of these could write a file or read an MCP resource under the "group" profile, but `spawn_agent` created live sub-agent threads with their own model requests. A read-only production check found none had ever been created.

Under [ADR-0029](0029-offer-isolated-runtimes-only-granted-tools.md) (proposed), each isolated runtime runs with a direct-mode model catalog and with user input and sub-agents switched off, and it does not start without that catalog. It is offered only its host tools, plus web search where that is live.

Threads saved before this change keep the old tool list in their history and send it again when resumed. Every tool on it is refused with no effect.

This closing of the tool surface applies to isolated runtimes. The private App Servers that run in the owner's own Codex home keep the owner's Codex tool surface by design: the main conversation, the pending responder and the private memory curator.
