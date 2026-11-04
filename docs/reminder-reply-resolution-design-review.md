# Reminder reply resolution design review

## Review result

Approved for implementation after the following corrections to the initial idea:

1. Do not expand the action-verb whitelist. It is intrinsically incomplete.
2. Do not let Curator choose a plan ID or trust a model-generated ordinal. Plan binding is derived from trusted reminder context and user evidence.
3. Use a dedicated `resolve_reminder` decision instead of overloading `record_event + planMatch`; this makes the semantic result explicit and prevents invalid state combinations.
4. Keep deterministic guards as contradiction checks, not as the primary natural-language classifier.
5. Treat missing/ambiguous targets and outcomes as clarification, not operational failure, so the scheduler does not retry permanent semantic errors.
6. Keep fact creation, plan transition, and reminder resolution in the existing Store transaction.

## Remaining known boundary

Natural language can remain genuinely ambiguous. The design guarantees safe non-writing clarification, not automatic resolution of every reply.

Implementation review additionally corrected two issues:

- reminder rescheduling remains `revise_event`; only terminal reminder outcomes use `resolve_reminder`;
- observed fact dates are derived from trusted entry dates plus explicit relative-date evidence rather than copied from model output.
- recovery uses a narrow same-origin endpoint rather than editing persisted JSON or restarting the live service; original batch identity is retained so Store replay stays idempotent.

## Multi-plan reply amendment

A production reply contained the result of one reminded plan and a reschedule for another. Review found that the original interface was too shallow: `resolve_reminder` carried an outcome but no descriptive plan match, so the host had to interpret the whole combined message and could bind the wrong plan.

The amendment keeps internal IDs host-controlled while adding a descriptive `match` to each reminder decision. This is not a model-authorized target: the host still resolves it strictly against the frozen reminder context. A batch-level conflict guard rejects two mutations aimed at the same plan, so an incorrect model response cannot complete and then revise one plan in a single transaction. Review also caught cross-clause date contamination; multi-plan completion dates now use the decision-specific fact summary, checked against trusted user evidence, rather than parsing unrelated date phrases from the entire reply.

Follow-up review found that date-cue detection and date parsing had separate vocabularies: the parser understood `明天`, while neither layer understood `明晚`. The reviewed correction makes the parser the single source of truth and adds common day-part shorthands. This retains strict mismatch rejection when the model date genuinely conflicts with user evidence.

## Short-reply admission amendment

A live failure showed that the generic at-most-three-grapheme optimization ran after reminder context discovery but ignored its result. The reply `看过了` therefore became a zero-duration `noop` without invoking the Curator, leaving the plan pending for the next reminder.

The reviewed correction keeps the optimization local to `AccountMemorySystem.captureTurn` and changes only its admission predicate: short text is skipped when, and only when, there is no active reminder context. The Store remains the single source of truth for context and defensively requires the referenced event to be a pending plan. This is deeper than adding a phrase whitelist: all short reminder answers reuse the existing semantic classifier and trusted mutation transaction without exposing new caller knowledge.

Review rejected a time-only response window because a user may answer after a day or after the final reminder. Closure remains state-based. It also rejected model-based context detection because model inference must not decide whether the model is invoked.
