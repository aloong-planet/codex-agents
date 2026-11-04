# SQLite hybrid account-memory design review

## Verdict

Approved with the corrections below incorporated into the design. The design keeps `AccountMemorySystem` deep: Weixin callers still capture, recall, and inspect state, while intent, retrieval, target binding, transactional writes, projection repair, and embedding lifecycle remain internal.

## Findings resolved before implementation

### SQLite and Markdown cannot both be authoritative

The initial idea of updating SQLite and `MEMORY.md` as peer stores creates an unavoidable two-resource atomicity gap. SQLite is now authoritative; Markdown is a repairable projection. A commit acknowledged by SQLite is not rolled back merely because projection refresh fails.

### Embedding work cannot extend the write transaction

Running a local model inside `BEGIN IMMEDIATE` would hold a writer lock for an unbounded duration and couple memory correctness to model availability. Embedding is now a lazy outbox consumer. Entry/FTS/receipt/outbox state is committed together; inference occurs afterward on the first semantic search for that account. The orchestration imposes a 15-second timeout so initial model download cannot leave a Curator job permanently active.

### Semantic similarity cannot be an authorization signal

High cosine similarity can still select the wrong preference, particularly for negation and closely related entries. Semantic exact search is retained for recall and ranking, but automatic mutation requires an exact alias or a unique strong lexical anchor. Otherwise the result is clarification.

### Missing update must not degrade to create

Natural-language operation type and target existence are separate facts. `explicit_correction` forbids add. Only an explicit upsert phrase grants create-on-missing. This prevents accidental duplicate memories.

### Retry must invalidate target bindings

A binding built at revision N may be wrong at revision N+1 even when the entry ID still exists. Target resolution therefore lives before every Curator attempt; revision conflicts return the whole job to resolution.

### Model bootstrap must fail safely

First-run model download can be slow or unavailable. Startup must not block Weixin message handling. The embedding adapter initializes lazily in the outbox/search path, reports safe availability status, and leaves FTS fully usable. No network or model error can relax the mutation gate.

### Legacy migration needs a one-way, idempotent rule

Import occurs only when SQLite has no initialized account row and valid legacy metadata+projection exist. The importer validates the legacy content hash and IDs, commits them once, and retains the old files until the new projection has been verified. Reopening does not import again.

## Deferred by design

- Approximate nearest-neighbor indexes and LanceDB.
- Online embedding-model upgrades with dual-version coverage.
- Cross-account memory and target-scoped memory.
- Automatic merge of ambiguous memories.
- Silent creation after a failed update.
- Manual import of an unmanaged `MEMORY.md` without valid structured metadata.
- A hard item-count threshold for ANN migration; this requires measured p95/p99, CPU, RSS, and target-ID recall.
