# ADR-0024: Coordinate independent group agents without changing group authority

- Status: Superseded by ADR-0026

## Context

The owner requires automatic interpretation of authorized ordinary group messages and separately identified specialists, while preserving group memory isolation and requester-owned controls. Sam coordinates but cannot execute business work. Changing the transport account to impersonate a specialist would also change memory, task and pending-operation authority.

## Options

1. **Keep canonical group authority, and bind a separate execution role and outbound application to each request.** Sam alone subscribes to human events; specialist applications send results.
2. Give every application an independent inbound business pipeline — rejected for this implementation because the same message can be admitted repeatedly and human open IDs are application-scoped.
3. Give Sam all business tools and add role labels to its messages — rejected by the owner's separate bot identity and coordination-only decisions.
4. Execute inferred tasks immediately — rejected by the owner's original-author confirmation requirement.

## Decision

Use one canonical group authority and durable dispatch admission. Keep authorization, business memory/task scope, original requester, execution session and outgoing application as separate concepts. Resolve genuine cross-application bot mentions using platform application IDs. Specialists share curated group facts and retain separate execution histories. Sam receives only coordination capability. One request has one specialist.

Durably admit authenticated webhook events before normalization or model work. Persist business status separately from notification status; a failed report cannot restart business execution. Receive original-requester controls while execution is busy. Keep previously completed effects and uncertain sends non-replayable.

This extends ADR-0023 only for explicitly enabled dispatch: authorized ordinary messages may be classified and inferred work requires confirmation. ADR-0023's private/group, requester, file, task and revocation boundaries remain in force. Legacy mention-only mode remains available.

## Consequences

- Positive: distinct bot identities do not widen human or group authority; single intake limits duplicate execution.
- Negative: sender identity must remain frozen through workflow media, pending responses and scheduled delivery, not only text replies.
- Neutral: application membership, public ingress and real-group receipt require live verification; fixtures establish neither platform permission approval nor deployment.

## Sources

- [Agent dispatch specification](../specs/agent-dispatch.md), including the owner's confirmed role, confirmation, runtime, ownership and failure choices.
- [Feishu message retrieval](https://open.feishu.cn/document/server-docs/im-v1/message/get): explicit user ID type resolves mentioned bots to application IDs.
- [Feishu receive-message event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive).
- [ADR-0023](0023-isolate-feishu-group-authority.md).
