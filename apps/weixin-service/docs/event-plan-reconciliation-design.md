# Event plan reconciliation design

## Goal

Represent a plan as one stable account-scoped entity whose scheduled date and summary may change. A user turn such as “我改变计划，今晚去看电影《牛来》” updates the uniquely matching active plan instead of creating a second event. Observed facts remain append-only records keyed by when they happened.

## Scope

- Add trusted `revise_event` support for `planned` events only.
- Keep the existing event ID when date or summary changes.
- Generate new event IDs from trusted creation identity rather than date or summary.
- Pass a bounded set of existing planned events to Curator.
- Resolve a model-provided semantic match inside the trusted host; the model never supplies an event ID.
- Missing or ambiguous matches return `needs_clarification` and write nothing.
- When a user explicitly reports that a plan happened, store a separate observed fact, mark the uniquely matching plan completed, and link the fact to that plan in the same transaction.
- Existing duplicate events are not deleted or merged automatically.
- Cancellation remains out of this slice.

## Deep module contract

The Weixin caller remains unchanged: every completed turn goes through `AccountMemorySystem.captureTurn()`. `MemoryCurationInput` gains `candidateEvents`, containing at most twenty current `planned` events from the account snapshot.

`account_memory_commit` gains:

```ts
{
  kind: "revise_event";
  match: string;
  eventKind: "planned";
  localDate: "YYYY-MM-DD";
  summary: string;
  evidenceEntryIds: string[];
  confidence: number;
}
```

`record_event(eventKind=observed)` may include `planMatch`. When present, the trusted host resolves it against active plans. A unique result emits one observed `event_add` plus one internal `event_complete`; missing or ambiguous results return clarification and write neither mutation.

The host resolves `match` against the frozen candidate plans. A unique match becomes an internal `event_update` mutation carrying the trusted stable event ID. Missing and ambiguous matches are terminal clarifications, not retries.

New events use a stable host-generated ID derived from the bound batch plus decision position. Date and summary are not part of identity. Existing IDs remain valid and require no migration.

## Store transaction

The `events` table gains nullable `plan_status` and `fulfills_plan_id` columns. Existing planned rows migrate to `active`; observed rows keep no plan status. `event_update` is valid only when the stored row is an active plan. In one transaction it:

1. validates evidence, date, summary, and confidence;
2. checks the destination exact-duplicate unique key;
3. updates `local_date`, `summary`, normalized summary, evidence, confidence, and `updated_at` while preserving `id`, `event_kind`, and `created_at`;
4. replaces the corresponding FTS row;
5. increments `events_updated` and the account revision.

`event_complete` changes one active plan to `completed`. The linked observed event stores `fulfills_plan_id`. Both mutations share one revision and receipt; either both commit or neither does.

After commit the projection repair rewrites every current date file and removes stale date projection files that no longer correspond to any event. SQLite remains authoritative.

## Matching

Only stored active `planned` events are candidates. Matching uses deterministic account-local lexical scoring over normalized summaries and strong anchors. It must return one of:

- unique: exactly one sufficiently strong candidate with a clear margin;
- missing: no sufficiently strong candidate;
- ambiguous: multiple plausible candidates without a clear winner.

The current example has one candidate containing the strong anchors “看电影”; the title addition and date change do not alter that identity. If two active movie plans are present, no write occurs.

## User-operation paths

1. New dated plan: `record_event(planned)` inserts one stable entity.
2. Change date only: `revise_event` preserves ID and changes `localDate`.
3. Change details only: `revise_event` preserves ID and changes `summary`.
4. Change both: both fields change atomically.
5. No matching plan: terminal clarification; no fallback add.
6. Multiple matching plans: terminal clarification with opaque candidate IDs for the local panel; no write.
7. Update collides with another exact plan: whole batch fails closed.
8. Revision races: existing revision conflict behavior retries from a fresh snapshot; stale IDs are never applied silently.
9. Projection failure after commit: receipt replay remains idempotent; later read repairs projections and removes stale date files.
10. Unrelated observed fact: `record_event(observed)` remains append-only and does not alter a plan.
11. Observed fact fulfills one active plan: fact is inserted, plan is completed, and both rows cross-reference through the trusted ID.
12. Fact-to-plan match is missing or ambiguous: whole decision requires clarification and writes nothing.

## Verification

- Tool-host vertical test: seed tomorrow movie plan, revise to tonight with title, assert one row, same ID, `eventsUpdated=1`.
- Store tests: atomic event update, duplicate collision rollback, FTS refresh, old-date projection removal, receipt replay.
- Store tests: atomic fact-plus-plan completion, existing-schema migration, and completed-plan rendering.
- System test: candidate plans are passed to Curator.
- Curator contract test: prompt contains bounded candidate plans and instructions require `revise_event` for plan changes.
- Full typecheck, unit suite, and local read-only panel verification. No Weixin message is sent by automated verification.
