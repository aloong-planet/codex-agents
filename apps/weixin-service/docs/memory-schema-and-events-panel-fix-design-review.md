# Memory schema and Events panel fix design review

## Verdict

Approved as a narrow repair. It fixes the protocol contract at its source and
separates a user-facing view from storage metadata without changing the event
state machine.

## Findings resolved before implementation

1. **Adding only `timePrecision` to `required` is incomplete.** Strict mode will
   reject the next omitted property (`localTime` or `planMatch`). The regression
   assertion must recurse and compare every object branch's `properties` and
   `required` sets.
2. **Making optional values ordinary required strings changes semantics.** They
   must be nullable, and the trusted host must continue treating `null` as
   absent.
3. **Removing IDs from the existing date-file renderer would weaken repair and
   audit projections.** Add a separate panel renderer; do not change persisted
   Markdown.
4. **Reusing the conversational timeline for the panel couples two audiences.**
   The page needs reminder detail while model recall does not. Keep the existing
   recall renderer and use the new renderer only in public state.
5. **Reminder counters can mislead after a plan is resolved.** Show them only
   for pending plans.
6. **An elapsed date does not prove completion.** Keep overdue as a derived
   pending-plan label and never rewrite the stored outcome.
7. **Automatic replay of a dead-letter turn could create an unexpected memory
   mutation.** Do not broaden recovery semantics in this repair.

## Test seam

The strict-schema test exercises the exact object supplied as App Server
`outputSchema`. The panel renderer test exercises the public text projection,
and `AccountMemorySystem.getPublicState()` locks the integration boundary.
