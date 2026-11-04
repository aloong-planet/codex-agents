# SQLite hybrid account-memory design

## Goal

Make natural-language memory corrections deterministic at account scope while preserving the existing `AccountMemorySystem` caller interface. A request such as “改成只在 Node.js 项目使用 pnpm” must update the uniquely matched existing entry, keep its stable ID, and never silently create a second entry when the target is missing or ambiguous.

Every completed Weixin/Codex turn must also be durably offered to the Curator without requiring a trigger phrase. A completed turn means that the inbound user entry is durable and normal Codex processing has reached a terminal result (`accepted`, `partial`, `send_failed`, or `agent_failed`). Channel acceptance is not required for curation. Diagnostic commands that bypass Codex and rejected media without usable text are not memory turns.

## Confirmed baseline

- `AccountMemoryStore` currently keeps authoritative structured entries in `metadata.json` and renders `MEMORY.md` as a projection.
- `AccountMemorySystem.captureTurn()` decides when to enqueue curation and `recall()` supplies account memory to the main Codex conversation.
- The Curator currently receives Markdown and lets the model choose operation and entry ID.
- Node 26 in the supported runtime exposes `node:sqlite`; the local runtime probe confirms FTS5 is enabled.
- The repository has no existing embedding runtime.

## Decisions

### Authority and projection

One account-scoped SQLite database is authoritative for entries, revisions, receipts, aliases, embeddings, and an embedding outbox. `MEMORY.md` remains a human-readable projection written after a successful transaction. The old `metadata.json` is imported once when the database is empty; existing IDs and evidence are preserved.

The store keeps its existing small interface:

```ts
read(accountId): AccountMemorySnapshot
apply(accountId, mutationBatch): MemoryCommitReceipt
```

Search and target resolution are internal behaviour behind `read`/curation orchestration, not new responsibilities for Weixin callers.

### Capture, scheduling, and intent

`WeixinCodexService` calls the existing account-scoped `captureTurn()` interface exactly once for every normal Codex turn after it reaches a terminal result, including Codex failure and outbound failure. A reply failure must not discard a durable user decision. The call still excludes the Weixin target so a reconnect or target change cannot fork account memory.

`AccountMemorySystem` persists one job for every captured turn and drains jobs in account order. Trigger phrases do not gate curation:

- ordinary turns use `automatic` and are still reviewed for durable preferences, projects, decisions, or constraints;
- explicit remember/correction/forget/upsert language narrows the allowed mutation policy and may bypass future batching, but never changes account FIFO order;
- jobs drain in capture order for each account, so an older automatic turn can never run after a newer explicit correction;
- an older same-account retry wait blocks newer pending jobs without causing a microtask polling loop; the retry timer is the only wakeup until that job is due;
- the 200-job history limit removes only oldest terminal records; unfinished jobs are never evicted by later automatic turns;
- the Curator may return no decisions, making ordinary ephemeral turns cheap no-ops at the storage seam.

The former ten-turn accumulator is removed from the live interface. Version-2 collected turns are migrated into automatic jobs on startup so already durable input is not lost.

### Intent and mutation policy

Every queued job persists a trigger:

- `automatic`
- `explicit_remember`
- `explicit_correction`
- `explicit_forget`
- `explicit_upsert`

The classifier recognizes durable-memory language only to specialize policy and priority, not to decide whether a job exists. “改成/改为/更正/纠正” enters correction mode; “有则更新，无则新增” enters upsert mode; everything else enters automatic review.

Before the Curator runs, the host resolves every explicit correction/forget against the same-revision structured snapshot and binds a mutation policy:

- unique target: `single-update` or `single-remove`, with the trusted stable ID;
- ambiguous target: terminal `needs_clarification/target_ambiguous`;
- missing target: terminal `needs_clarification/target_missing`, except explicit upsert;
- explicit remember: `free-add` only;
- automatic review: `reconcile`, where the model may propose `remember` for a new durable fact or `revise` with an old-fact match phrase plus replacement. The model still cannot name an entry ID.

The model never supplies a target ID for update/remove. Under `reconcile`, `remember` creates a host-ID entry (or becomes an exact-duplicate no-op); it never overwrites an entry merely because one technical anchor overlaps. `revise` supplies a replacement plus a semantic match phrase for the old fact. The host resolves that phrase against the latest snapshot: a unique strong match updates the stable ID, while missing or ambiguous matches commit nothing and record terminal clarification. Add IDs are generated by the host from category, normalized anchors, and a collision-safe short hash.

### Hybrid retrieval

Retrieval is account-local and has two parallel candidate paths:

1. SQLite FTS5/BM25 plus exact aliases and strong anchors returns up to 50 lexical candidates.
2. A local multilingual embedding adapter produces a normalized 384-dimensional query vector. The account’s current model/version vectors are loaded into one contiguous `Float32Array`; exact cosine over every active vector returns up to 50 semantic candidates.

The production adapter uses Transformers.js feature extraction with the q4f16 ONNX weights of `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, mean pooling and normalization. Model artifacts remain local after first download. Tests inject a deterministic embedding adapter.

Candidates are merged with reciprocal-rank fusion. Resolution is deliberately asymmetric:

- an exact stable ID/alias or unique strong lexical anchor may auto-bind;
- a semantic-only result is never enough to authorize a write;
- lexical+semantic agreement may rank candidates for clarification but still requires a unique strong lexical basis for automatic update/remove.

If the model cannot load or an entry has no current embedding, retrieval degrades to FTS/anchors. This reduces recall but cannot weaken the write gate.

### Strong anchors

Normalize with NFKC and locale-independent lowercase. Preserve quoted phrases, technical identifiers (`pnpm`, `node.js`, versions, package-like tokens), numbers, Latin words, and CJK bigrams. Remove correction verbs and broad scope words. FTS rarity is used for ranking; an anchor is “strong” only when it occurs in exactly one active entry for the account or is an exact alias. Generic scope terms cannot authorize a write.

### SQLite schema

Each hashed account directory contains `memory.sqlite` and `MEMORY.md`.

```sql
account_state(revision, projection_hash, embedding_generation)
entries(id, category, value, normalized_value, evidence_json, confidence, updated_at)
aliases(entry_id, alias, normalized_alias)
entry_embeddings(entry_id, model, version, dimensions, normalized, vector_blob, value_hash)
receipts(batch_id, revision, added, updated, removed)
embedding_outbox(entry_id, requested_revision, value_hash, state, attempts, last_error)
entries_fts(entry_id UNINDEXED, value, aliases)
```

All tables are implicitly account-local because every account has a separate database directory. SQLite runs in WAL mode with `busy_timeout`; `apply` uses `BEGIN IMMEDIATE`, checks batch receipt before revision, validates the whole mutation batch, commits entries/FTS/outbox/receipt atomically, then refreshes `MEMORY.md` by atomic rename. A projection write failure is surfaced and repaired from SQLite on the next read/start; SQLite remains authoritative.

### Embedding lifecycle

Entry commits never wait for model inference. Add/update writes an outbox row in the same transaction. The first search that actually needs semantic recall lazily drains stale rows for that account outside the write transaction, then upserts each BLOB only if the entry value hash still matches. Unchanged entries retain their vectors; delete cascades vectors and removes outbox rows. The complete search has a 15-second orchestration timeout, after which target resolution safely continues with FTS/strong anchors. The underlying model load may finish later, but it cannot hold a Curator job indefinitely.

Model/version/dimensions must match before cosine scoring. The first implementation fixes one production model/version; an online model upgrade with dual-version coverage is deferred rather than mixing versions or pretending partial coverage is complete.

### Job states and user-visible errors

Jobs add terminal `needs_clarification`; target resolution runs inside the existing `curating` state. Clarification is not a retryable failure and has no `nextAttemptAt`. Public state exposes a safe reason and candidate stable IDs but never embeddings, transcripts, or credentials.

Revision conflicts, SQLite busy/lock errors, and temporary Curator/model failures remain retryable. Every retry rereads the latest snapshot and reruns target resolution. A stale binding is never reused.

## Automatic reconciliation sequence

1. Persist the inbound transcript entry before starting Codex.
2. Run Codex and attempt the final Weixin reply.
3. Persist the assistant terminal entry, including fixed failure replies.
4. Call `captureTurn({ accountId, userEntry, assistantEntry })` once; never pass target.
5. Persist an automatic or explicit job before returning from `captureTurn`.
6. Curator reviews the frozen turn and returns one output-schema-constrained decision envelope with zero or more semantic candidates.
7. The trusted host commit path rereads the current SQLite snapshot, creates `remember` candidates, and resolves `revise` match phrases to stable IDs. The whole batch is atomic: any missing or ambiguous revision target yields clarification and no mutations.
8. SQLite commit refreshes `MEMORY.md`; delivery status does not change the memory decision.

## User-operation failure paths

1. User corrects a uniquely anchored memory: host binds old ID; Curator can only revise it; commit preserves ID/category.
2. User corrects a topic shared by multiple entries: no write; panel asks for a more specific phrase or selection.
3. User says “更新 X” but X does not exist: no write; panel asks whether to create. Only explicit upsert may add.
4. User states a new preference: host permits add; exact duplicate becomes no-op.
5. Local model is unavailable or first download exceeds 15 seconds: FTS still resolves strong lexical matches; semantic-only requests clarify.
6. Process exits after SQLite commit but before projection: receipt remains committed; next load regenerates `MEMORY.md`.
7. Process exits during embedding: outbox remains pending; retry is idempotent.
8. Concurrent process changes an entry: revision check fails; the job rereads and re-resolves before retry.
9. Codex processing or Weixin reply fails after inbound persistence: the terminal failure entry and user input are still queued for automatic review.
10. An ordinary sentence revises a uniquely anchored decision without saying “改成”: Curator emits the durable replacement; host reconciliation updates the old stable ID.
11. An ordinary turn contains no durable information: Curator submits an empty decision list; job becomes `noop` without changing revision.
12. Process restarts with version-2 collected turns: startup converts them to automatic jobs before draining; no captured body is silently discarded.

## Verification

- Golden correction: seed `js-package-manager-pnpm`, capture “改成只在 Node.js 项目使用 pnpm”, assert one entry, same ID, updated value.
- Missing and ambiguous correction produce clarification and no revision change.
- Explicit upsert creates only when missing.
- Model-submitted add/wrong ID is rejected under a correction binding.
- FTS exact alias/strong anchor, semantic Top-k, deterministic RRF, stable tie ordering.
- Embedding failure degrades safely; semantic-only matches do not auto-write.
- Legacy metadata import keeps IDs and renders identical Markdown.
- Transaction replay, revision conflict, outbox stale-result rejection, unchanged-vector reuse, search timeout, projection repair, account isolation.
- Exact-search benchmark for 10k/25k/50k synthetic 384-d vectors records p50/p95/p99 and RSS without establishing a fabricated latency guarantee.
- Triggerless correction: seed the pnpm entry, capture “只在 Node.js 项目使用 pnpm”, let Curator submit a durable candidate, and assert the same ID is updated with no duplicate.
- Ordinary ephemeral turn is queued and completes as `noop`; trigger words are not required to reach Curator.
- Explicit jobs are prioritized ahead of pending automatic jobs without interrupting an active job.
- Codex failure and final reply failure each capture exactly one terminal turn; `/echo` and rejected voice remain excluded.
- Version-2 collected turns migrate to automatic jobs exactly once.
