# ADR-0021: Isolate diagnostic persistence from user-requested work

- Status: Accepted (2026-11-01)

## Context and problem

Per-record directory maintenance made accumulated local diagnostics compete with recursive scans. macOS Background classification amplified filesystem cost; isolated populated-directory overlapping scans exhausted the existing budget, while Standard completed.

## Alternatives

1. Independent bounded diagnostic writer with incremental retention and Standard launch policy: selected.
2. Delete old logs or raise the query budget: rejected; hides repeated maintenance and resource contention, and budget increases are explicitly forbidden.
3. Keep an in-process asynchronous sink only: rejected; asynchronous filesystem maintenance still shares main-process scheduling and resources.

## Decision

Move diagnostic persistence into one child per sink with bounded admission, single acknowledged batch in flight, failure counters and bounded shutdown. Reconcile storage at startup, segment rotation, after I/O failure and periodic maintenance; account for owned-file changes incrementally between these points. Preserve raw values, existing limits, no-follow checks and reader compatibility from ADR-0013/0014. Use Standard launch classification for user-requested work. Query scheduling is separately deferred.

## Consequences

- Positive: diagnostic storage faults and maintenance do not become awaited business dependencies; directory inventory cost no longer multiplies with every record.
- Negative: process lifecycle and bounded IPC need explicit tests; overloaded or failed sinks may lose diagnostic evidence.
- Limits: shared physical storage still permits contention; observations cannot replace durable Run/Effect/operation state. Running installations change only after deployment.

## Sources

Follow-up (2026-11-01): the separately deferred query scheduling is addressed by [ADR-0022](0022-schedule-file-query-batches.md). This ADR's diagnostic persistence and launch decisions remain unchanged.

- User decision on 2026-11-01: optimize logs first, launch policy second, defer query resource isolation and notify after the first two.
- [Workflow requirements](../specs/workflow-runs.md), REQ-070/071 and CON-002.
- [Apple launchd process classifications](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).
