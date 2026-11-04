# Memory schema and Events panel fix design

## Goal

Fix the deterministic `invalid_json_schema` failure that leaves an inbound
memory job waiting for retries, and give the local Events panel a user-facing
projection of plans and facts instead of exposing storage annotations.

## Confirmed failure

The current `record_event` and `revise_event` output-schema branches declare
optional properties that are absent from `required`. OpenAI strict structured
outputs require every declared object property to appear in `required`.
Consequently App Server rejects the turn before model generation, the
conversation reports a non-completed turn, and the memory system classifies it
as `codex_turn_incomplete` and retries a request that cannot succeed.

## Schema repair

- Keep the existing semantic decision union and host-side authorization.
- Every object branch in the output schema must list every property in its
  `required` array.
- Fields that are semantically optional are required-but-nullable in model
  output:
  - `record_event.localTime`
  - `record_event.planMatch`
  - `revise_event.localTime`
- `timePrecision` is required for model-generated event decisions. The trusted
  host continues accepting omitted precision from older direct callers and
  defaults it to `date`; this compatibility does not weaken the model schema.
- A recursive regression assertion checks every object node, including all
  `anyOf` branches, so adding another optional-looking property cannot recreate
  this protocol failure.

## Events panel projection

SQLite and `events/YYYY-MM-DD.md` remain authoritative/projection storage and
retain stable `event:id` comments. The webpage uses a distinct display
projection and never receives those comments as visible text.

The panel groups by local date and displays:

- observed facts: fact status and summary;
- plans: plan outcome, expressed time (`未指定具体时间` / `上午` / `下午` /
  `晚上` / exact `HH:mm`), summary, and reminder progress;
- pending overdue plans: `已到期，结果未确认` rather than implying occurrence;
- exhausted plans: explicitly state that automatic reminders stopped;
- completed, cancelled, or unfulfilled plans: outcome only, without stale
  reminder progress.

The bounded window/count and account-level notification-target health remain in
the existing summary above the list. No mutation control is added to this
read-only panel.

## User-operation failure paths

1. A completed Weixin turn creates an event decision: strict schema is accepted,
   the model returns JSON, and the trusted host commits it.
2. A future schema edit adds a property but omits it from `required`: the
   recursive schema test fails before deployment.
3. A nullable field is returned as `null`: the host treats it as absent and
   applies its existing semantic validation/default.
4. A plan has no exact time: the panel says it is unspecified rather than
   inventing a clock time.
5. A plan is overdue but unresolved: the panel says the result is unknown and
   never promotes it to an observed fact.
6. A plan has been resolved: the panel does not show stale reminder counters.
7. An event has a stable internal ID: storage keeps it, while the webpage omits
   it.
8. The current failed job has not exhausted retries when the corrected service
   loads: it resumes through the existing retry scheduler. A dead-letter job is
   not silently replayed; the user must explicitly produce a new turn or a
   dedicated recovery action must be added separately.

## Verification

- Unit: recursive strict-schema compatibility assertion is red before the fix.
- Unit: event-panel projection covers exact and imprecise times, pending,
  overdue, exhausted, completed, cancelled, unfulfilled, and observed facts;
  it contains no `event:id`.
- Integration: public memory state uses the panel projection while conversational
  recall and dated files preserve their established behavior.
- Browser: Events tab renders the sanitized projection and remains accessible.
- Full gate: lint, typecheck, all tests, build, service E2E.
