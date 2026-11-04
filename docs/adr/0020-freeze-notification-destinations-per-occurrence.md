# ADR-0020: Freeze notification destinations per occurrence

- Status: Proposed

## Context and problem

The owner wants simultaneous private channels while retaining existing tasks, plan reminders and delivery evidence. Enabled-channel changes still take effect only after a restart. Replacing the destination used for task lookup would split task identity; rewriting historical attempts would make old results eligible for a different recipient.

## Alternatives

1. **Retain task/memory storage scope, capture creation-channel preference for tasks/plans, then freeze it for each occurrence or destination-specific reminder batch.**
2. Rewrite all stored recipients on restart — excluded by the approved requirement that historical records retain their meaning.
3. Coordinate live handover and transfer pending work — explicitly excluded by the owner's stop/configure/start decision.

## Decision

Use host-supplied owner notification routing. Both bound conversations map to the retained task scope; each new task or plan separately captures its creation-channel destination. Viewing or editing from the other chat does not change that preference. Existing tasks/plans without preferences receive Feishu for future notifications through an idempotent migration; require the bound Feishu destination rather than inventing one. Already-created occurrences and delivery records are excluded from preference migration. The scheduler implements this through an optional bound-destination set on OwnerNotificationRoute and a separate task notificationDestination; omitted sets retain the legacy single-selected port contract; production startup always supplies all explicitly bound destinations. Disabled bindings retain preferences but have no active delivery port. Research cancellation and news retry eligibility use the frozen occurrence address, not the current task preference. The memory account remains independent. Scheduled and memory reminder-intent reservations use the same retained scope so one source intent cannot activate two reminders.

Keep task IDs, schedules, quotas and management operation identities in their existing scope. New occurrences and related failure notices freeze a separate delivery destination. Legacy records without that field mean their original Weixin address. Eligibility, submission guards, transport serialization and delivery blockers use the frozen address. A different active channel cannot drain historical cached results or replay accepted/uncertain outcomes. Ordinary same-channel recovery remains unchanged. The local daily-news compatibility API continues taking retained task addresses.

Plan follow-ups retain their memory database and plan IDs. New batches group only plans with the same captured destination and expose numbered reply context only under the conversation that received that batch. Unknown/interrupted attempts retain existing no-resend behavior. Neither task nor plan history is bulk rewritten. The memory tool host resolves the destination from trusted evidence origins and stores it with the new plan in one transaction; later edits and duplicate/replayed additions do not replace it. Legacy curation jobs without source metadata use the same explicit Feishu default. The monitor migrates missing plan preferences, excludes unbound memory accounts and groups only matching destinations; batch creation rejects mixed preferences. An unresolved planned or sending batch also prevents a new claim: an interrupted unsent batch is retained, never automatically regenerated on another channel; explicit plan revision/outcome resolves its items under existing rules. A multi-segment batch becomes accepted only when every persisted segment is accepted; an incomplete batch cannot release its remaining plans for a new destination. Production startup supplies the same owner route to task scheduling, plan curation and reminder delivery.

The neutral notification port exposes readiness, change subscription and guarded text submission. The Weixin adapter owns native transport conversion and local failure reporting, preserving operation identity and uncertain outcomes without another-channel fallback. Production startup starts configured Weixin and Feishu adapters with one scheduler and one plan monitor; delivery selects the adapter from the frozen destination. A connection failure affects only its own route. No runtime switch operation, drain coordinator or in-flight transfer is added.

## Consequences

- Positive: task and memory continuity does not depend on a transport address remaining active; historical receipts preserve their original meaning.
- Negative: task scope and actual delivery destination must both be retained; old pending work can remain paused while its original channel is inactive.
- Neutral: automated port/SQLite tests validate this seam, not platform authentication or phone receipt. The simultaneous amendment remains proposed pending real-channel acceptance; future notifications follow captured preferences independently of the enabled adapter set.

## Sources

- [Channel switching specification](../specs/channel-switching.md), REQ-004 and CON-003.
- [ADR-0015](0015-durable-scheduled-reminders.md), [ADR-0019](0019-preserve-owner-state-across-channel-bindings.md).
- User-approved ticket 04 and stop/configure/start scope; scheduler and plan monitor public-boundary restart regressions.

- User selected creation-channel notifications and approved Feishu as the legacy future-task default, then confirmed conversation isolation on 2026-11-01.
