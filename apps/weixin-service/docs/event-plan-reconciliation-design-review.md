# Event plan reconciliation design review

## Verdict

Approved for implementation after recording the submitted choices: clarification without writes on an unresolved plan, linked fact plus completed plan, and no automatic cleanup of existing duplicates. The design fixes the identity model rather than adding date-specific deduplication.

## Findings resolved

1. **Date cannot identify a plan.** Date and summary are mutable; the event row ID is the stable identity.
2. **Model-selected IDs would be unsafe.** Curator provides only a semantic match; the trusted host resolves and injects the ID.
3. **Updating every event would rewrite history.** Only `planned` rows may be revised. Observed facts remain append-only.
4. **A missing match must not become another duplicate.** Missing and ambiguous matches are clarifications with no mutation.
5. **Moving dates can leave stale Markdown.** Projection repair removes obsolete date files after rewriting the authoritative set.
6. **IDs derived from mutable content recreate the bug.** New IDs derive from the trusted batch and decision position; old IDs are preserved without migration.
7. **A stale snapshot could overwrite a newer plan.** Existing account revision CAS remains the serialization boundary.
8. **Existing duplicate cleanup is destructive and uncertain.** It is explicitly excluded until exact records are reviewed and separately confirmed.
9. **Converting a plan into a fact would erase intent history.** Completion keeps the plan and adds a separately dated observed fact linked to it.
10. **Partial completion would corrupt lifecycle state.** Fact insertion and plan completion are one revision-checked transaction; unresolved matches write neither.

## Deferred

- plan cancellation and statuses;
- automatic cleanup of historical duplicates;
- vector search for events.

These do not block the requested rescheduling/edit flow.
