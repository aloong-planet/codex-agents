# ADR-0015: Separate scheduled occurrences from chat reply ownership

- Status: Accepted (2026-10-14)

## Context

Conversational scheduling must return a stored management result immediately while executing later independently. Delivery can remain blocked after successful generation; repeating generation or treating a later credential refresh as a historical success would lose content or duplicate messages. The existing memory follow-up subsystem can recognise the same reminder intent.

## Options

1. **Persist task settings, occurrence ownership, exact cached output and delivery attempts separately; return management results inline to the main turn.**
2. Keep the creating chat turn alive until the due instant — excluded by the accepted independent-lifetime requirement.
3. Regenerate on every delivery retry — excluded by the user's requirement to reuse generated content and avoid duplicate sends.
4. Represent every management change as a terminal Workflow Run — not recorded as a separate prototype comparison; this architectural alternative would transfer chat reply ownership before the future execution, contrary to the accepted separation.

## Decision

Implement option 1. The main model interprets management intent; strict tools bind the original account and conversation. A private SQLite store durably claims each occurrence and reserves output capacity before generation. A service timer drives reminders; a task is not itself a Workflow Run.

One dispatcher per trusted recipient chooses eligible cached occurrences by planned instant and stable identity. Persist the body before submission, record every part, and recheck task/target/current channel prerequisites before each new effect. A fenced or interrupted submission becomes unknown rather than a replay candidate. Binding generations and deterministic inbound-context generations prevent old callbacks or duplicate inbound deliveries from pretending to refresh current prerequisites.

Scheduled and memory reminders share a durable intent-level ownership decision. The memory store holds its transaction while reserving ownership before activation. On confirmed rollback, ownership cleanup holds its writer lock until that memory transaction has rolled back; projection failure after a successful commit retains ownership. A crash between reservation and activation conservatively retains ownership for replay/reconciliation of the same memory batch. Other plans in the same message remain independent.

The current implementation covers one-time, fixed-interval and daily/weekly calendar reminders, scoped queries, delivery and lifecycle management. Management uses durable request identity and optimistic settings revisions. Each explicit disable advances a pause generation; manual execution captures that generation, and every new submission checks it. Deletion is retained history and an intent-ownership tombstone, never permission to revive a memory reminder. Full settled history is bounded independently of pending bodies, automatic claims and management deduplication. Fixed intervals retain their first instant; calendar rules resolve local wall time, skipping gaps and choosing the earlier fold. Durable cadence revisions and cursors advance atomically with claims and compact skipped ranges, so downtime considers only the latest candidate and pruning never reopens an old slot. Intentional pause resumes strictly in the future. Manual and automatic admission share time ordering and capacity. Rescheduling clears obsolete admission blockers while preserving cached output. Researched text and daily-news cutover remain required by the full specification and are not implied by reminder support. Isolated storage/process tests and synthetic model-enabled acceptance support these decisions; they do not establish phone receipt.

## Consequences

- Positive: delivery recovery reuses exact content, and current readiness can change without rewriting historical attempts.
- Positive: durable claims and intent ownership prevent duplicate activation across restarts and competing workers.
- Negative: separate persistence domains require conservative reconciliation after an interrupted memory activation; uncertainty cannot be resolved by silently freeing ownership.
- Negative: user-facing queries need explicit pagination so complete content and history fit the model's bounded tool result.
- Neutral: channel acceptance remains distinct from phone receipt. No arbitrary program execution, new client or live deployment is introduced by this decision.

## Sources

- [Scheduled tasks specification](../specs/scheduled-tasks.md), especially REQ-005, REQ-006, REQ-007, REQ-010 and QR-001.
- [ADR-0008](0008-separate-inline-file-operations-from-terminal-workflows.md).
- User-approved revised design and six-slice implementation breakdown, 2026-10-13.
- Current scheduler, channel and memory transaction implementations and their isolated SQLite/process/fixture regressions.

## Reminder text amendment — Accepted (2026-10-15)

The user approved creation-time normalization after receiving the raw scheduling request as a reminder. Persist complete Reminder Text separately from the semantic instruction; the existing main model produces it only at creation or explicit content edit. The host validates required fields, exact-source membership for verbatim payloads and the existing byte limit. It does not perform linguistic substitutions. Static execution copies saved text; old tasks and already claimed/cached content retain their semantics.

Alternatives considered in the approved wording proposal: mechanical pronoun replacement loses actors and nested quotations; per-occurrence model rewriting changes an already previewed message and introduces avoidable execution failures. Neither is adopted. No automatic bulk migration is performed because existing text and paused state are user-owned.

Consequences: preview and delivery agree, exact payloads survive whitespace and punctuation, and delivery recovery remains independent of generation. The trade-off is that static reminders cannot recalculate changing countdowns; uncertain semantics require clarification. Long previews use paged reads. Existing operation hashes without the new fields remain readable; fresh writes cannot use that compatibility path to omit their body. Source: scheduled-tasks::REQ-012 and the user's “ok，按照当前方案实施”; synthetic model ingress and legacy-store regression support the implementation, not phone acceptance.

## Bounded research amendment — Accepted (2026-10-15)

This amendment extends the reminder-only implementation boundary recorded above. Generic researched text now uses the same task, occurrence, capacity and delivery model. Existing daily-news cutover remains separate. A research instruction chooses a fixed reviewed task kind; this is not permission to select arbitrary Workflow Templates or supply a recipient.

The installed research CLI needs its Code Mode host for native web search. Keeping that host disabled, including an experiment with standalone search, produced no search events despite successful process exit. The user approved the scoped enablement with “好的，继续研究” after the explicit question about enabling only the isolated research host while retaining Shell/file/plugin restrictions. Enable code_mode_host for this subprocess only; retain read-only sandbox, private temporary workspace, ignored user rules/config, disabled shell/local-resource/plugin/app/multi-agent/outbound tools, and no application dynamic tools. Do not alter the running service as part of this decision.

The selected process returns validated complete text plus numbered HTTP(S) sources. Require completed search and source-page-open events; knowledge-only output is not an acceptable substitute. The public-document real process test confirms the installed runtime path. Its trace is finite evidence, not proof against every adversarial webpage. No actual local-path adversarial payload was run after automatic approval review rejected it.

Alternatives actually tried: keeping the host disabled and enabling standalone search both failed to expose working web research. Relaxing shell/plugin/file restrictions was not selected or needed. Reusing the main conversational turn was already excluded by the independent-lifetime requirement.

Long research renews its worker lease while unrelated caches and reminders progress. Cancellation keeps the reservation until the worker stops or is fenced; late completion cannot save output. Research failure codes preserve timeout/runtime/quota/search/source-read causes. Existing LocalDiagnostics correlates the occurrence with its child process and records output persistence only after commit; history notifications expose historical codes separately from current recovery advice.

Consequences: independent research can complete while channel prerequisites are unavailable, with exact cached recovery. Costs include CLI feature-contract dependence and a bounded subprocess per research execution. Process exit/search/read evidence does not by itself guarantee editorial accuracy; body/source validation and truthful failure reporting remain necessary. This does not migrate daily news or repair its deferred historical-notice queue.

Sources: scheduled-tasks::REQ-006, REQ-008, QR-001 and CON-001; the user's scoped execution-host approval on 2026-10-15; real public TypeScript research, subprocess cancellation, host policy, cache-recovery and OTel correlation tests in the current implementation.

2026-11-08 follow-up: group research, which runs in a group's isolated runtime, now searches in direct tool mode through the standalone `web.run` under [ADR-0030](0030-offer-isolated-runtimes-only-granted-tools.md) (proposed); Code Mode no longer applies to it. On `codex-cli 0.167.0-alpha.3.2`, a direct `web.run` call reports the search and page-open events this amendment requires. Whether a real model searches that way is the owner's research check under ADR-0030. Private research is unchanged.

## Daily-news ownership amendment — Accepted (2026-10-16)

[ADR-0016](0016-daily-news-owner-handoff.md) implements the previously separate daily-news cutover. Its specialised content/retry rules now use this common occurrence, capacity, pause and dispatcher model. Legacy ownership is fenced before import; cached content and known outcomes are preserved. This implementation decision is verified in isolated processes and fixtures, not a production deployment or phone-receipt confirmation.

## Task configuration authority amendment — Accepted (2026-10-17)

The observed run-only incident contained both a current unrestricted task and obsolete restrictive memory/history. The main model nevertheless issued edit followed by run. Separating tools and checking source/revision did not prove the edit was requested. The user rejected fixed phrases/keyword routing and approved the OpenClaw-derived repair with “ok , 按这个方案修复”.

Keep the main conversational model as the intent owner. Its tool and memory-context instructions make current stored task configuration authoritative and require present-request authorization for each changed field. Explicit edit-and-run remains supported. Existing isolated research execution retains no task-management authority.

Use the existing memory curator, not a second task-intent classifier, to identify task-owned configuration. The host supplies only scoped task identities and bounds retirement to exact visible memory candidates. Retire the task-only content, preserve independent personal preferences, and atomically retain original entry/evidence plus task identity/revision. Normalized retired values cannot be added back by later extraction. Single-target correction remains bound to that target; replay returns its durable receipt even after the original entry has left active memory. This amendment concerns active entry memory, not an account-wide deletion of conversation/event history.

Alternatives actually considered: keyword denial was explicitly rejected because wording, negation and combined operations vary; a separate semantic intent classifier would duplicate the main model's role; tool separation alone already existed and did not prevent an additional edit. Prompt-only treatment would leave a conflicting active settings copy. Broad history deletion would also lose unrelated user context. None is selected.

Consequences: current configuration and personal preferences have distinct ownership, mixed memories retain their independent part, and retirement is inspectable and restart-safe. Costs are asynchronous semantic cleanup, additional private audit storage and bounded curation context. Existing unclassified memory may remain until a later source-bound curation job; prompt priority reduces but cannot mathematically eliminate semantic mistakes. Exact tombstones do not recognize arbitrary paraphrases. No new model capability, live task mutation, deployment or phone acceptance follows from this implementation decision.

Sources: scheduled-tasks::REQ-013; confirmed 2026-10-16 incident and fixed upstream research in `/Users/loong_zhou/research/openclaw-task-control/openclaw-scheduled-task-authority.md`; user approval on 2026-10-17; current memory transactions and synthetic actual-model regressions. Background isolation is a retained capability boundary, not a claim that OpenClaw prevents every conversational extra edit.

## Execution retention amendment — Accepted (2026-10-18)

The user requested “取消保存次数限制。其他按推荐优化”, accepting permanent counts/summaries with age/capacity control of detailed output. This supersedes the earlier count-bounded full-history policy. Retain every surviving occurrence identity and outcome; only settled payload can expire, atomically within its existing record. Pending work, article results, archives and deduplication evidence are outside this cleanup domain. Existing/imported history is conservatively incomplete; deleted historical records cannot be reconstructed.

Alternatives considered: continuing count deletion contradicts the explicit request; retaining all detailed bodies indefinitely allows large repeated output to dominate storage. Permanent summaries plus configurable detail retention preserves audit and replay guards while bounding eligible payload. Defaults 90 days / 100 MiB are implementation choices announced in this turn, not separately user-selected numbers. Logical payload cleanup reuses SQLite space; it does not promise a shrinking database file. History paging/counts use database queries. Trade-offs: summary metadata still grows, expired original reports cannot be reread, and protected work may exceed the eligible-detail budget. No article reprocessing, archive deletion or notification replay is authorized. Sources: scheduled-tasks::REQ-014 and the user's 2026-10-18 instruction.
