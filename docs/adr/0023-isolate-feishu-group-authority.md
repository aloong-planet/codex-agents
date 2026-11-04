# ADR-0023: Separate group authority from shared discussion

- Status: Proposed

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
- Neutral: local configuration is trusted and restart-applied. Platform permission approval and real-device receipt remain separate from automatic fixture validation. This technical path remains Proposed until implementation and runtime isolation evidence close it.

## Sources

- [Channel specification](../specs/channel-switching.md), channel-switching::US-005 through channel-switching::US-007 and channel-switching::REQ-011/012.
- User-confirmed group, member, context, file, memory, task and pending-request decisions (2026-11-05).
- [OpenClaw Feishu implementation](https://github.com/openclaw/openclaw/tree/7c2ff8f775acca3e5c93c9c22b6247e37df29bae/extensions/feishu).
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
