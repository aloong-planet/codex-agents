# Episodic events memory design review

## Verdict

Approved for implementation after separating storage authority from human-readable projections, distinguishing plans from observed actions, bounding recall, and preserving the existing account-memory seam.

## Findings resolved before implementation

1. **“行为” was too broad.** Future intent is `planned`; only a user statement that an action happened is `observed`. Passing time never upgrades a plan to observed.
2. **Separate files could create two authorities.** SQLite is authoritative for both layers. `MEMORY.md` and dated event files are replaceable projections and are never parsed as input.
3. **Two public write interfaces would leak classification to Weixin.** The caller still invokes only `captureTurn`; Curator and the host choose stable memory versus event internally.
4. **Always injecting permanent events would recreate unbounded memory.** Recall is time-bounded and adds only query-relevant older FTS matches.
5. **A combined preference/event turn could partially write.** Both decisions enter one revision-checked SQLite transaction and one idempotent receipt.
6. **Date files could imply that a plan happened.** Stored event kind is explicit; elapsed plans render as unconfirmed.
7. **Relative dates could drift with server time.** The reference date comes from the durable inbound entry timestamp in the fixed account timezone, not Curator execution time.
8. **Frequent panel polling could return the entire archive.** Public state returns a bounded timeline plus total count; full history remains locally archived.
9. **One meal could be promoted into a preference.** Event recording and preference creation are independent decisions. Promotion from repeated behaviour is deferred.
10. **Event recording could accidentally become reminders.** The implementation stores and recalls events only; no scheduler or notification side effect is introduced.

## Explicitly deferred

- reminders and proactive notifications;
- event cancellation and broader semantic consolidation;
- automatic promotion of repeated events into durable preferences;
- vector embeddings for event search; SQLite FTS is sufficient for the first slice.

Plan rescheduling and fact-to-plan completion linking were subsequently approved and are specified in [event plan reconciliation design](./event-plan-reconciliation-design.md) and its review. They are no longer deferred.

## Test seam

The high-level seam is `AccountMemorySystem.captureTurn()` followed by `recall()`/`getPublicState()`. Store and tool-host tests cover internal invariants that cannot be observed safely through Weixin. Browser E2E is the acceptance seam for the two read-only tabs.
