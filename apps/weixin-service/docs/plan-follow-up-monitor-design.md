# Plan follow-up monitor design

## Goal

Treat every plan as one account-scoped entity with a stable ID, mutable content and schedule, and an explicit outcome. When a pending plan passes its due time, the local service proactively asks the confirmed Weixin recipient for the result. Each plan owns its reminder count independently. User replies are understood by the existing Codex conversation and reconciled by Memory Curator through trusted plan IDs.

## Confirmed product decisions

- Plan outcome is `pending | occurred | cancelled | unfulfilled`.
- `overdue` is derived from `pending && dueAt < now`; it is not a persisted outcome.
- Three unanswered reminders do not imply `unfulfilled`. They leave the plan pending, overdue, and reminder-exhausted.
- Imprecise time expires at the end of the expressed period: date at end of day, morning at 12:00, afternoon at 18:00, evening at end of day. Exact time expires at that minute.
- Every due plan is included in the current logical reminder batch. The renderer splits only between complete plan items to stay below the Weixin text limit.
- Each plan displays its own reminder ordinal: `[第 1 次]`, `[第 2 次]`, or `[最后一次]`.
- The first reminder is due immediately after plan expiry. A successfully accepted reminder schedules that plan for the same local wall-clock time on the following calendar day. After the third accepted reminder, the plan becomes exhausted when the next daily deadline passes without a resolving reply.
- Reminder text is deterministic; the model handles the user's natural-language answer.
- Memory remains account-scoped. Proactive delivery uses one explicitly confirmed notification target per account, never whichever arbitrary sender happened to message most recently.
- A confirmed send increments only the plans contained in that accepted message segment. Failed sends do not increment. Unknown delivery is persisted and never automatically resent.

## Deep module interface

`AccountMemorySystem` remains the external seam. Existing callers keep `captureTurn`, `recall`, lifecycle controls, and public state. It gains only:

```ts
confirmNotificationTarget(accountId: string, target: string): void;
```

The implementation hides schedule calculation, timer recovery, batching, delivery attempts, response correlation, SQLite locking, projection updates, and retry suppression. `WeixinCodexService.enable(accountId, target)` and the dedicated panel action “将当前目标设为计划提醒接收人” are explicit confirmation points and forward that pair to the memory module. A later inbound message refreshes Tencent's channel context token but cannot silently replace the confirmed recipient.

The memory module accepts an injected sender adapter:

```ts
send(input: { accountId: string; target: string; message: string }): Promise<SendTextResult>;
```

No account ID, target, plan ID, database path, or reminder counter is model-controlled.
The monitor performs one recovery scan at startup and then polls authoritative SQLite state once per minute. Account-memory disablement removes the account from subsequent scans without deleting plans or reminder history.

## Persisted model

The existing `events` table stays authoritative to avoid duplicating facts. Planned rows gain:

```text
scheduled_at_ms        integer UTC epoch milliseconds
time_precision         date | morning | afternoon | evening | exact
local_time             HH:mm for exact time, otherwise null
plan_status            pending | occurred | cancelled | unfulfilled
follow_up_state        waiting | awaiting_response | exhausted
reminder_count         integer 0..3
last_reminder_at_ms    nullable integer
next_reminder_at_ms    nullable integer
occurred_event_id      nullable stable observed-event ID
```

Observed rows gain `fact_status = valid | retracted`. `fulfills_plan_id` keeps the relationship to its plan.

Existing `active` plans migrate to `pending`; existing `completed` plans migrate to `occurred`. Existing date-only plans receive an end-of-day `scheduled_at_ms` and `time_precision=date`. Existing observed facts migrate to `valid`.

Reminder delivery is journaled in:

```text
notification_binding(target, confirmed_at)
reminder_batches(id, target, status, created_at, updated_at)
reminder_batch_items(batch_id, plan_id, ordinal, attempt_number, segment_index, resolved_at)
reminder_attempts(id, batch_id, segment_index, status, created_at, updated_at, failure_code)
```

`sending` attempts found after restart become `unknown`; they are never resent automatically.

## State machines

### Plan outcome

```text
pending -> occurred      user confirms completion; add and link one valid observed fact
pending -> cancelled     user explicitly cancelled
pending -> unfulfilled   user explicitly says it was not done

cancelled/unfulfilled -> pending   user reschedules; reset reminder state and count
cancelled/unfulfilled -> occurred  user corrects the result; add a linked fact
occurred -> pending/cancelled/unfulfilled
  explicit correction retracts the formerly linked fact in the same transaction
```

Changing plan content or schedule preserves the plan ID. Rescheduling resets follow-up state to `waiting`, reminder count to zero, and next reminder to the new due time.

### Follow-up

```text
waiting -> awaiting_response  one containing segment is accepted
awaiting_response -> awaiting_response  next accepted reminder while count < 3
awaiting_response -> exhausted  count == 3 and the following daily deadline passes
awaiting_response/exhausted -> waiting  user reschedules
any follow-up state -> resolved-by-outcome  plan leaves pending
```

`resolved-by-outcome` is derived from a non-pending plan status and is not stored as another follow-up enum value.

### Delivery attempt

```text
planned -> sending -> accepted
                   -> failed
                   -> unknown
```

Only `accepted` changes plan reminder counters. `failed` schedules the same reminder ordinal for the following local day without incrementing. `unknown` blocks automatic resend and is exposed in sanitized local state.

## Time representation

Curator emits trusted semantic fields for planned decisions:

```text
localDate: YYYY-MM-DD
timePrecision: date | morning | afternoon | evening | exact
localTime: HH:mm only for exact
```

The host validates the evidence date and computes `scheduled_at_ms` in Asia/Shanghai. The model never supplies UTC milliseconds. Display preserves the original precision rather than inventing an exact time.
For backward-compatible Curator output that omits precision, the host uses `date`; `exact` is rejected unless a valid `HH:mm` is also present.

Period ends:

```text
morning   12:00
afternoon 18:00
evening   23:59
date      23:59
exact     supplied HH:mm
```

## Reminder rendering

The fixed opening is:

```text
提醒你一下，下面这些计划已经到时间了。你可以告诉我完成情况，或者重新安排时间。
```

Each item is natural language:

```text
1. [第 1 次] 你计划在 8 月 18 日整理项目资料。
2. [最后一次] 你计划在 8 月 17 日晚上去看电影《牛来》。
3. [第 2 次] 你计划在 8 月 18 日 12:00 和朋友吃饭。
```

The footer is:

```text
直接告诉我结果就可以，比如：
“1 已完成；2 没有完成；3 改到周五晚上”
也可以按你习惯的方式回复。

标记为“最后一次”的计划，如果这次没有回复，我就先不再提醒了，会保留为“结果未确认”。以后想起来再告诉我也可以。
```

The final paragraph appears only when the batch contains at least one final reminder. Internal IDs never appear in Weixin messages. Long content is display-truncated without modifying stored content. Segments repeat a compact `计划确认 x/y` title and never split one item.

## Reply correlation

An accepted batch remains open until all of its plan items are resolved or superseded. `captureTurn` receives the inbound target and loads the newest open accepted batch for that account and confirmed target. Curator receives a bounded trusted reminder context mapping the visible ordinal to candidate plan content. It returns semantic decisions (`record_event`, `revise_event`, or plan outcome); the host resolves the stable ID.

The plan-outcome decision is `set_plan_outcome(cancelled|unfulfilled)`. Its `match` may be a visible reminder ordinal, but the host—not the model—maps that ordinal through the persisted batch to a stable plan ID. A completion reply without a repeated date uses the trusted inbound local date for the linked observed fact.

Ambiguous or missing references write nothing and keep the batch open. Ordinary unrelated messages do not resolve plans. Updating one item does not alter other batch items.

## User-operation and failure paths

1. A new pending plan computes a due time and arms the next timer.
2. Editing content preserves identity. Editing time recomputes due time and resets reminders.
3. Service sleep or restart scans once on recovery. It sends at most the currently due reminder, never historical catch-up reminders in a burst.
4. No confirmed target means plans remain due but no message is attempted.
5. A target not present in the current channel snapshot produces a sanitized failed attempt and does not change counters.
6. Accepted single-segment delivery increments only its contained plans.
7. Multi-segment delivery stops after the first non-accepted segment; already accepted segments keep their counters.
8. Unknown delivery is never retried automatically.
9. User completion creates a fact and marks the plan occurred atomically.
10. User cancellation or explicit non-completion changes only the matched plan atomically.
11. Correcting an occurred plan retracts its linked fact atomically before changing the plan outcome.
12. A revision race rereads and re-resolves from the latest plan snapshot.
13. The third accepted reminder waits one further daily interval; if unresolved, the monitor marks follow-up exhausted without changing plan outcome.

The public account-memory state exposes only sanitized reminder health: whether an owner target is confirmed, the number currently due, and the number blocked by unknown delivery. It never exposes the persisted target or internal plan IDs.

## Verification

- Store migration tests for legacy plans and observed facts.
- Store transaction tests for plan time/status changes, fact retraction, per-plan reminder counters, accepted/failed/unknown attempts, and batch replay.
- Renderer tests for per-item ordinals, natural time text, conditional final footer, item-safe splitting, and 1500-character maximum.
- Monitor tests with an injected clock/timer/sender: first due reminder, mixed ordinals, restart catch-up, three-reminder exhaustion, failed delivery, unknown delivery, partial segments, and no confirmed target.
- Curator contract tests for time precision and numbered reminder context.
- Integration test from enabled Weixin target through accepted reminder and natural-language result reconciliation.
- Full lint, typecheck, unit/integration suite, build, and fixture browser end-to-end. Automated verification never sends a real Weixin message.
