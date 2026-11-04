# Reminder reply resolution design

## Goal

Convert natural replies to plan reminders into one fixed semantic decision while keeping plan identity, state transitions, dates, and persistence host-controlled.

The concrete regression is a single-plan reminder followed by `已经买了`: Curator correctly identified completion, but the host rejected it because completion validation enumerated a small set of verbs.

## Interface

Curator may return this decision only when `reminderContext` is present:

```ts
type ResolveReminderDecision = {
  kind: "resolve_reminder";
  match: string | null;
  outcome: "occurred" | "cancelled" | "unfulfilled";
  summary: string | null;
  evidenceEntryIds: string[];
  confidence: number;
};
```

`summary` is required for `occurred` and must be `null` for other outcomes. `match` is a descriptive copy or paraphrase of the old plan, never an internal ID. It may be `null` only when the frozen reminder context contains exactly one unresolved plan. The decision cannot contain `accountId`, `target`, `batchId`, plan ID, ordinal, date, path, or mutation operation.

General facts and plans continue using `record_event`; reminder outcomes use `resolve_reminder`. A reminder reply that changes time or content continues using `revise_event` because it keeps the plan pending rather than resolving it.

The Curator prompt payload is schema version 2.

## Trusted host resolution

The host resolves the plan from the frozen `reminderContext` and current user evidence:

1. When `match` is present, resolve it only against the reminder batch's unresolved plans using existing deterministic event matching.
2. A `null` match is accepted only if exactly one unresolved plan exists.
3. For backwards-compatible output without a match, use an explicit leading ordinal from user evidence when present; otherwise a multi-plan reply must uniquely identify one plan.
4. Missing or ambiguous matches return `needs_clarification`; they never write or retry automatically.

### Short-reply admission

The host's at-most-three-grapheme fast no-op applies only when no active reminder context exists. An active reminder context is discovered deterministically for the same account and target and contains at least one reminder item whose send attempt was accepted, whose item is unresolved, and whose referenced event is still a pending plan.

When such context exists, every non-empty reply reaches the Curator regardless of length. This lets short natural answers such as `看过了`, `买了`, `没去`, and `取消` enter the same trusted resolution path as longer replies. The Curator may still return `noop` for an unrelated acknowledgement. There is no time-only TTL: context closes through an atomic plan transition and reminder-item resolution, so a delayed answer remains usable.

The store returns no reminder context when the inbound target is absent, the account/target scope differs, no accepted attempt exists, every item is resolved, or the referenced plan is no longer pending. Model inference is not involved in this admission decision.

Model output cannot select an internal plan ID or override this binding.

A single user reply may resolve one plan and revise another. Each decision is resolved independently. Before persistence the host rejects a batch if two terminal/update mutations target the same plan; this prevents a mistaken `complete -> revise` sequence from retracting the newly created fact.

## Outcome guard

The model performs broad natural-language classification. The host applies a narrow contradiction guard rather than a verb whitelist:

- negated/non-completion cues override `occurred`;
- cancellation cues override `occurred` and `unfulfilled`;
- future/change cues cannot resolve a plan;
- an `occurred` decision requires a non-negated completion/result cue such as a perfective construction (`已经…了`, `…完了`, `买了`), not a particular action verb;
- conflicting or unsupported cues return `needs_clarification`.

The observed event date is host-derived from the trusted entry date. For a single-plan reply, an explicit relative/absolute date in evidence may refine it. For a multi-plan reply, only a date cue preserved in that decision's fact summary may refine it, and the host verifies that the same date is supported by user evidence. A date attached to another plan in the same message cannot move this fact.

All event creation and revision paths share one relative-date parser. Day-part shorthand is equivalent to its full day form: `今早/今晚` map to today, `明早/明晚` to tomorrow, `昨早/昨晚` to yesterday, and `前晚` to the day before yesterday. Date-cue detection must call this parser rather than maintain a second regular-expression vocabulary; otherwise a valid shorthand can be misclassified as “no date supplied” and compared against the old plan date.

## State transitions and persistence

Allowed transitions from a reminder reply:

- `pending -> occurred`: atomically add one observed fact, link it with `fulfillsPlanId`, complete the plan, and resolve reminder items.
- `pending -> cancelled`: update the plan and resolve reminder items.
- `pending -> unfulfilled`: update the plan and resolve reminder items.

Resolved plans are not silently changed by a stale reminder reply. Existing Store transactions and batch receipts provide atomicity and replay idempotency.

## Failure modes

- no live reminder context: `needs_clarification/target_missing`;
- several possible plans: `needs_clarification/target_ambiguous`;
- two decisions target the same plan in one batch: contract failure with no write;
- contradictory/unsupported language: `needs_clarification/outcome_ambiguous`;
- schema or policy violation: contract failure, at most one Curator repair attempt;
- SQLite lock/App Server transport failure: retryable operational failure;
- semantic clarification is never treated as a retryable failure.

An operator-only same-origin local endpoint may manually requeue the latest `dead_letter` job for one enabled account. It preserves the original batch and evidence for idempotency, performs no Weixin send, and runs only one additional attempt because the prior attempt count is retained.

Internal error codes must not be sent to Weixin users.

## Verification

- single plan: `已经买了` -> one fact + `occurred`;
- single plan: `还没买` -> `unfulfilled`, no fact;
- single plan: `不买了` -> `cancelled`, no fact;
- multiple plans: `2 已经买了` resolves only item 2;
- multiple plans: `已经完成了` requests clarification;
- `不买了` is never interpreted as `occurred` merely because it ends with `了`;
- failed atomic commit leaves both fact and plan unchanged;
- clarification does not retry;
- replay does not duplicate the observed fact.
- one combined reply can complete the movie plan and reschedule the meal plan without changing either stable plan ID;
- the meal plan's `周四` date cannot change the movie fact's reply-day date;
- a descriptive match cannot select a plan outside the frozen reminder batch;
- `明晚` on an August 18 entry revises the matched plan to August 19 evening instead of raising `memory_event_date_mismatch`;
- legacy multi-plan output without a per-decision match cannot complete one plan and revise the same plan in one atomic batch;
- manual recovery selects only the latest dead-letter job and leaves older failures untouched.
- a three-grapheme reply with no reminder context remains an immediate no-op;
- `看过了` with one accepted unresolved pending reminder reaches the Curator and can resolve that plan;
- an unresolved item pointing at an already terminal plan is excluded from reminder context.
