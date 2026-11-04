# ADR-0016: Transfer daily news to one durable scheduled-task owner

- Status: Accepted (2026-10-16)

## Context

Legacy daily news owns a JSON state file, independent timers, retries and sends. Common scheduled tasks already own transactional claims, quotas and chronological delivery. Merely adding news to the task list would leave two independently active senders, and a new lock is invisible to already deployed legacy code.

## Options

1. **Verified offline legacy stop, durable file fence, then transactional import and common ownership.** Retain a specialised news generator but use the existing task/occurrence/dispatcher boundary.
2. Keep the legacy scheduler behind a management facade. Rejected: its independent drain and generation reservations violate shared order/capacity and cannot atomically honor task mutations.
3. Run both owners and deduplicate at submission. Rejected: old code does not honor the new claim; uncertain submissions cannot safely be replayed or reconciled by equality of text.

## Decision

Use option 1, implementing the already accepted migration protocol. The first handoff requires verified legacy process termination and exclusive service activation. Preserve the exact source in a durable prepared snapshot and make the old writable file an incompatible ownership fence so an old release cannot restart and silently regain ownership. No in-memory boolean, elapsed delay or model response proves the old process stopped.

The common SQLite transaction imports stable account/recipient/news-run identities, surviving complete bodies, known outcomes and specialised generation metadata together with the committed ownership marker. Prepared-but-uncommitted state has no active news owner and exposes reconciliation pending. Retrying the same prepared source is idempotent; a conflicting source cannot overwrite an imported result. After commit there is no automatic legacy fallback.

SQLite owner initialization installs its bounded lock wait before WAL/schema operations; otherwise independent startup can fail before the retry policy exists. The actual two-process handoff test reproduced that ordering error and passes after correction. This requirement applies when extending concurrent openings of the shared owner.

The common scheduler handles news admission, pause generations, revisions, history and delivery. A bounded specialised executor retains the existing source selection, complete short-summary validation, deduplication, archive and same-day research/archive retry rules. A retry without deliverable is distinct from a delivery attempt; cached delivery never regenerates. Generic research policies are unchanged. Existing controls project and mutate this same owner rather than invoking legacy timers or drains.

## Consequences

- Positive: imported and future news shares exact-cache recovery, ordering, capacity and task authorization with other schedules.
- Positive: crash phases fail closed; surviving pending content is protected even above quota.
- Negative: the first production upgrade requires an explicit verified stop/activation procedure; an unattended binary replacement is insufficient.
- Negative: legacy records contain only their surviving evidence; missing/pruned attempts cannot be reconstructed or called migrated.
- Neutral: the legacy file remains a frozen source/fence; separate historical-notice repair stays a deferred concern, and channel acceptance still does not establish phone receipt.

## Sources

- [Scheduled tasks specification](../specs/scheduled-tasks.md), REQ-007, REQ-009 and QR-001/AC-04.
- [Daily AI news specification](../specs/daily-ai-news.md).
- [ADR-0015](0015-durable-scheduled-reminders.md).
- User-approved six-slice plan and “继续下一项开发任务” on 2026-10-16. Temporary-store public lifecycle tests, real old/new process crash phases, competing imports and accepted/interrupted submissions validate the implementation. Separate scripted/actual-model fixture ingress covers seven management commands. The separately requested production cutover on 2026-10-16 deployed `20261016-news-1001325` after verified old-process exit and backup; exact surviving records and a single committed owner were checked. Phone receipt remains separate acceptance.

## Archive policy amendment

[ADR-0017](0017-daily-news-results-and-archives.md) replaces the coupled research/archive retry portion above. Exclusive handoff, the common owner and exact cached delivery remain unchanged.
