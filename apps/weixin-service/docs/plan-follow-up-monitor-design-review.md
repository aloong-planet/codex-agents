# Plan follow-up monitor design review

## Verdict

Approved for implementation after the corrections captured in the design. The external seam remains small and account-scoped, while delivery and reconciliation complexity stays inside `AccountMemorySystem` and `AccountMemoryStore`.

## Findings resolved before implementation

1. **Account scope did not imply a safe recipient.** Arbitrary latest inbound target could disclose private plans. The design now requires an explicitly confirmed per-account notification target.
2. **Plan, follow-up, and delivery states were mixed.** They are now separate state machines. Send failure and unknown delivery cannot mutate plan outcomes.
3. **The original message-level reminder count was false.** Each plan owns its count; one batch may contain mixed first, second, and final reminders.
4. **Channel segmentation could create false reminder counts.** Batches persist plan-to-segment membership and increment only accepted segments.
5. **Silence was incorrectly proposed as unfulfilled.** Three unanswered reminders now yield pending + overdue + exhausted, never an inferred failure.
6. **Correcting completed plans could leave false facts.** Linked observed facts gain a retractable status and corrections are atomic.
7. **Date-only plans had no deterministic expiry.** Time precision and host-computed period ends make expiry stable without inventing display precision.
8. **Numbered natural-language replies lacked stable correlation.** The latest accepted batch supplies a trusted ordinal-to-plan context to Curator; model arguments still cannot choose raw IDs.

## Regression and race review

- Existing memory entry reconciliation remains unchanged.
- Existing event IDs and Markdown projections remain valid through schema migration.
- The monitor must not hold a SQLite transaction across network sending.
- A prepared batch is persisted before sending. A crash after send begins becomes unknown on restart, preventing automatic duplicate delivery.
- Plan updates and batch-item resolution share the account database transaction.
- Timer callbacks re-query authoritative SQLite state and never trust stale in-memory plan objects.
- Disabling account memory stops new reminder attempts but preserves plans, bindings, and ledgers.
- Existing Tencent context-token constraints still apply; channel acceptance is reported separately from user receipt.

## Deliberate first-version exclusions

- No pause/snooze state.
- No arbitrary recurring plans.
- No notification to unconfirmed targets.
- No automatic resend after unknown delivery.
- No deletion or silent merging of existing duplicate plans.
