# Episodic events memory design

## Goal

Keep stable account memory and dated personal events in separate lifecycles while preserving the existing Weixin caller seam. A completed turn such as “我喜欢吃肉蟹煲” becomes a durable preference; “明天准备去吃肉蟹煲” becomes a planned event dated from the inbound entry timestamp in `Asia/Shanghai`. A plan is never presented as an observed action unless the user later confirms it.

The local page presents two accessible tabs: **长期记忆** and **Events**. Both are read-only projections of one account-scoped authoritative SQLite database.

## Scope and defaults

- Account isolation remains keyed only by the direct Weixin account, never by target.
- SQLite retains events indefinitely.
- `MEMORY.md` projects stable preferences, projects, decisions, and constraints.
- `events/YYYY-MM-DD.md` projects events for one local calendar date.
- Default conversational and panel event window is the previous 30 days through the next 7 days. Query-relevant older events may be added by SQLite FTS search.
- Recording an event does not create a reminder or scheduler job.
- The first slice records new `planned` and `observed` events and exact-duplicate no-ops. Plan rescheduling and completion linking are implemented by the follow-up [event plan reconciliation design](./event-plan-reconciliation-design.md). Cancellation and broader semantic consolidation remain deferred.

## Deep module seam

Weixin keeps one write call and one recall call:

```ts
captureTurn(completedTurn): Promise<CaptureReceipt>
recall(accountId, currentUserText): string
```

`captureTurn` does not expose classification, table selection, event paths, IDs, timezone conversion, duplicate handling, or projection repair. `recall` receives the current text only so the module can add query-relevant older events; the caller does not invoke a separate event search module.

`AccountMemoryStore.read(accountId, eventQuery?)` returns stable entries plus the bounded event view and total event count. `apply(accountId, batch)` atomically commits both stable-memory and event mutations. These remain the store interface used by orchestration and tests.

## Curator contract

The existing `account_memory_commit` tool accepts five semantic decisions:

- `remember`: create a stable preference/project/decision/constraint;
- `revise`: revise a uniquely resolved stable entry;
- `record_event`: record a `planned` or `observed` event with normalized `localDate`;
- `revise_event`: revise the date and/or summary of one uniquely matched active plan while preserving its ID;
- an empty decision list: no-op.

An observed `record_event` may include `planMatch`; a unique match links the fact and completes the plan atomically. Missing or ambiguous plan matches require clarification and write nothing.

The Curator never supplies an account, path, stable ID, timezone, or stored status. The trusted host binds account and evidence, generates IDs, validates dates and evidence, supplies `Asia/Shanghai`, removes exact duplicates, and submits one mutation batch. One turn may atomically contain both `remember` and `record_event`.

The Curator prompt distinguishes:

- stable preference: “我喜欢吃肉蟹煲”;
- future intent: “明天准备去吃肉蟹煲” (`planned`);
- past/current action explicitly stated by the user: “我今天吃了肉蟹煲” (`observed`);
- ephemeral request with no personal fact: no-op.

Single events never imply a preference. Assistant text may provide context but cannot be the sole evidence for an event or preference.

## SQLite schema

The existing account database adds:

```sql
events(
  id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  summary TEXT NOT NULL,
  normalized_summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  plan_status TEXT,
  fulfills_plan_id TEXT,
  UNIQUE(event_kind, local_date, normalized_summary)
)

events_fts(event_id UNINDEXED, summary, aliases)
```

Receipt rows add event-added/updated/removed counters with zero defaults so old databases migrate in place. The account revision covers both stable entries and events; one batch has one receipt and one revision increment when any mutation changes state.

Exact duplicate `record_event` decisions become a committed no-op. Events have a larger count budget than prompt memory, but individual summaries keep the same sensitive-data and maximum-length validation. FTS is candidate retrieval only; it never authorizes a write.

## Date semantics

- The authoritative event date is ISO `YYYY-MM-DD` in `Asia/Shanghai`.
- The Curator receives the trusted local date derived from each user entry timestamp and proposes normalized dates for expressions such as 今天、明天、后天、昨天 and 前天.
- The host independently derives these relative dates (and explicit ISO or Chinese month/day dates) from trusted evidence metadata, rejects mismatches, rejects invalid calendar dates, and requires a temporal cue or explicit calendar date.
- A `planned` event whose date is before today is rendered as `计划（已过日期，未确认发生）`; its stored kind remains `planned`.
- An `observed` event is rendered as `已发生` because the user explicitly stated the action.

## Projection and repair

SQLite commits before filesystem projections. After commit, the store atomically refreshes `MEMORY.md` and every affected `events/YYYY-MM-DD.md`. Projection failure surfaces to the current job, but the SQLite receipt makes retry idempotent. The next `read` repairs missing or stale projection files from SQLite.

Date files contain stable event IDs as HTML comments, but they are never parsed back into SQLite:

```md
# Events · 2026-08-17

<!-- event:id=event-planned-... -->
- [计划] 准备去吃肉蟹煲。
```

## Recall

Every Codex turn receives:

1. the bounded stable `MEMORY.md` projection;
2. upcoming events through seven days;
3. recent events from the previous 30 days;
4. older FTS matches for the current user text, deduplicated by event ID.

Recall labels plans and observations explicitly and never tells Codex that an elapsed plan happened. The panel uses the same bounded timeline, shows displayed/total counts, and leaves the complete archive in SQLite/date projections.

## Web interface

The current Memory Curator section keeps enable/disable controls and summary. Below it, an ARIA tablist controls two panels:

- `长期记忆`: existing `MEMORY.md` projection;
- `Events`: bounded event timeline, window description, displayed/total counts,
  expressed plan time, outcome, reminder progress, and an empty state. This
  user-facing projection omits stable `event:id` comments; SQLite and dated
  Markdown projections retain them for identity and repair.

Tabs do not call mutation endpoints. Keyboard Left/Right/Home/End changes tabs, selected state is visible, and status polling updates both panels without resetting the selected tab.

## User-operation failure paths

1. User states only a durable preference: stable entry commits; no event is created.
2. User states only a dated plan/action: event commits; `MEMORY.md` is unchanged.
3. One turn contains both: both mutations commit atomically or neither does.
4. The same event is repeated: exact unique key becomes a no-op, not a duplicate or retry loop.
5. Curator emits an invalid/impossible date: the tool rejects the batch; no partial preference write occurs.
6. Date projection write fails after SQLite commit: retry replays the receipt; later read repairs the file.
7. A plan date passes without confirmation: an active plan is labelled elapsed/unconfirmed, never observed. A user-confirmed fact may separately complete and link the plan.
8. Event lies outside the default window: it remains in SQLite/date archive and may return through query-relevant FTS recall.
9. Memory is disabled: neither stable facts nor events are captured or recalled.
10. A message contains blocked sensitive data: the whole batch fails closed with no projection leakage.

## Acceptance

- Store tests prove atomic stable+event commit, duplicate no-op, schema migration, projection repair, date validation, and bounded recall.
- Tool-host/Curator tests prove classification and that model-supplied account/path/ID/timezone are impossible.
- Weixin tests prove current user text reaches recall and every terminal turn still captures once.
- Page E2E proves accessible tab switching, persistent selection during polling, both projections, and empty states.
- Real Weixin acceptance remains user-led: send one dated plan and one stable preference, then verify the two tabs and date file. Automated tests do not send external messages.
