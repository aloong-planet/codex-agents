# ADR-0018: Separate channel messages from trusted delivery

- Status: Proposed

## Context and problem

The same personal assistant must support Weixin and Feishu without duplicating business decisions. Existing inbound events combine message data with closures that hold the platform reply context, and the conversation implementation imports the Weixin management interface.

## Alternatives

1. **Extract a conversation Module with plain message data and a trusted delivery Interface, retaining a Weixin compatibility Adapter during migration.**
2. Replace Weixin wholesale with Feishu — rejected by the explicit requirement to retain both channels.
3. Coordinate runtime handover, drain barriers and switching generations — excluded; configured channel membership still changes only after restart.
4. Start two full service instances against the same state directory — rejected for independent state snapshots, shared-worker duplication and shutdown ownership conflicts.

## Decision

Use separate serializable inbound messages and a delivery Interface. For simultaneous channels, one process owns one mutable conversation-state authority and shared worker lifecycles; a trusted router resolves bound channel identities and live reply references. Channel-specific reply limits, acknowledgements, typing and turn preparation are selected per conversation, not as a global property. Do not run two independent conversation-state snapshots against the same persistence file. The host adapter issues an opaque live delivery reference, bound to the original message key, account and destination. The conversation can round-trip that reference through JSON; it cannot change the binding. The adapter releases live delivery bindings when the admitted handler finishes, including failures. These references are not persistent delivery records and do not replace the durable inbox or effect ledger.

The neutral ConversationChannelRouter and PersonalOwnerDirectory compose all enabled bindings in the production startup path. MediaDeliveryRouter resolves image/file submission and reconciliation from the immutable Run destination. The Engine supplies persisted Run/operation identity during reconciliation; the media provider resolves the original destination before querying one adapter. No secondary route ledger or inference from the currently active channel is introduced; an unavailable original route cannot select another channel.

Move conversation orchestration behind the neutral Interface. The existing Weixin composition facade retains public construction compatibility, platform prompting, typing protocol, media/workflow binding and the current reply limit. The core receives a turn factory instead of importing that adapter. Type re-exports preserve existing consumers without renaming persisted identities.

The incremental migration now composes conversation orchestration, owner identity, shared permissions, media delivery and scheduled notifications behind the same core. The Weixin construction facade remains for existing callers. Existing account/target storage interpretation, frozen workflow identifiers, pending choices and unknown-no-resend behavior remain intact. ADR-0004 and ADR-0008 continue to define trusted response binding and terminal ownership; channel independence does not relax them.

## Consequences

- Positive: the same conversation algorithm can receive plain messages and use a different injected channel without importing login or SDK implementations.
- Negative: the compatibility facade and old protocol-facing event types coexist until the remaining consumers migrate.
- Neutral: startup enables either or both bound adapters with independent readiness and no hot channel toggles. Media normalization and durable delivery remain adapter-owned. Automated fixture validation and real-channel acceptance are distinct; this amendment remains Proposed until the latter is recorded.

## Sources

- [Channel switching specification](../specs/channel-switching.md)
- ADR-0004 and ADR-0008
- User-confirmed independent core, single-active stop/configure/start scope and incremental implementation breakdown (2026-10-30).

- User confirmed simultaneous access, shared long-term memory and independent chat contexts on 2026-11-01.
