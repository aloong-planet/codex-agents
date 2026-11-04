# Automatic memory curation design review

## Verdict

Approved after tightening the design around terminal-turn capture, account ordering, automatic reconciliation, migration, and ambiguous batches. The external seam remains `AccountMemorySystem.captureTurn()`; callers do not learn create/update/search rules.

## Findings resolved before implementation

1. **“Every turn” was ambiguous.** It now means a durable inbound entry plus a terminal normal Codex outcome. Channel acceptance is not required. `/echo` and rejected media without usable text are excluded because they bypass the normal Codex turn.
2. **The existing success-only capture loses decisions.** Both agent failure and outbound failure must call the same capture helper exactly once after the assistant terminal entry is durable.
3. **Removing trigger gating could allow the model to overwrite arbitrary entries.** Automatic review uses a trusted `reconcile` policy. The model supplies semantic candidates but never account, path, operation ID, or target ID.
4. **Automatic add-only policy would duplicate revised decisions.** Reconcile lets the Curator distinguish `remember` from `revise`; the host resolves only `revise` match phrases to stable IDs. Missing or ambiguous revision targets are terminal no-write clarification.
5. **One ambiguous candidate could leave a partially committed batch.** Reconciliation resolves and validates the entire candidate set before one atomic store apply. Any ambiguity rejects the whole batch.
6. **Priority reordering can violate causality across targets.** Jobs are persisted and drained in strict account capture order. Explicit language may specialize policy or bypass future batching, but never passes an older job.
7. **Deleting the ten-turn accumulator could lose already persisted bodies.** State migration converts every non-empty version-2 account collection into one automatic job and clears the collection atomically.
8. **Semantic model latency must not block every reply.** `captureTurn` only persists and schedules. Curator and retrieval remain background work after the reply terminal state.
9. **A no-op must not look like failure.** Empty Curator decisions produce a committed no-op receipt/job state without revision change or retry.
10. **Anchor overlap alone is not identity.** An automatic `remember` never becomes update solely because it shares `pnpm`, `Node.js`, or another anchor. Only an explicit Curator `revise` proposal enters trusted target resolution.
11. **Retry waits must preserve FIFO without spinning.** A same-account `retry_wait` job blocks newer pending jobs. The scheduler only queues another drain when a job is actually runnable; otherwise it arms the retry timer.
12. **Higher job frequency must not evict unfinished work.** The 200-job history cap trims only oldest terminal jobs. Pending, curating, and retry-wait jobs are retained even when total unfinished work exceeds the cap.

## Rejected alternatives

- **Expand the trigger regex.** This still misses paraphrases and keeps correctness coupled to wording.
- **Let the Curator choose create/update and IDs.** This makes identity nondeterministic and lets untrusted conversation content steer persistence.
- **Write every raw turn directly to `MEMORY.md`.** This creates unbounded, contradictory prompt context. Raw turn evidence stays in the persisted job/transcript; `MEMORY.md` remains curated.
- **Wait for Curator before sending the reply.** This adds model/download latency to the user-facing path and makes memory availability affect chat delivery.

## Implementation seam and acceptance

The public test seam is `captureTurn()` plus `getPublicState()`/store snapshot. Weixin tests verify each terminal path invokes the seam exactly once. Tool-host tests verify reconcile outcomes and the prohibition on model-supplied IDs. The real-Weixin acceptance step remains user-led; automated tests must not send external messages.
