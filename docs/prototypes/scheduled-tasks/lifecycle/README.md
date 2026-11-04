# Lifecycle prototype validity

Checked 2026-10-14 against [scheduled tasks](../../../specs/scheduled-tasks.md).

This deterministic in-memory prototype remains a design illustration of pause generations, manual grants, deletion, frozen revisions and terminal no-replay. It is not the running management interface and does not verify persistence, timing, model interpretation or channel delivery.

The one-time example is not current for time editing or completion after a manual-only run while the automatic plan is still pending: its time-edit action was deliberately excluded from the earlier completion demo, and its completion projection does not represent that outstanding automatic plan. Treat those portions as stale illustrations, not runtime specifications or acceptance evidence. The current specification and the production scheduling tests cover these paths. No new production page or controls were introduced in the lifecycle implementation.

Recurring reminder support adds no production page or controls. The prototype does not model interval anchors, calendar gap/fold calculations or latest-only skipped ranges; use the specification and recurring scheduler regressions for those behaviors.

The 2026-10-15 reminder-text amendment changes conversational copy and stored content only, under the approved pure-copy exception. This prototype does not model natural/verbatim wording or its previews and is not evidence of semantic conversion. Existing lifecycle illustrations retain the limitations above.

The 2026-10-16 daily-news handoff adds no production controls or visual layout. The model illustrates the accepted lifecycle only; actual source fencing, import, process crashes and cross-task delivery order are verified by isolated runtime tests. Existing panel changes correct wording only. No prototype claim establishes production migration.
