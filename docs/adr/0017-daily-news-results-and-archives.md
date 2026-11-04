# ADR-0017: Preserve article results and decouple user-readable archives

- Status: Accepted (2026-10-16)

## Context

A source exception previously disappeared as an empty HN result, and archive-time refetch could discard a successfully summarized article. The user requires successful articles to be reused and explicitly confirmed that archive failure must not block delivery. Mandatory persisted content and optional user-readable notes therefore need separate outcomes.

## Options

1. **Persist immutable article results under the common owner, freeze one report, and retry local archiving independently.** Selected.
2. Regenerate summaries on each new date/ranking. Rejected by the user's explicit article-success reuse requirement.
3. Require user-readable archive success before delivery. Rejected by the user's explicit nonblocking-archive decision.
4. Retry the whole research/delivery pipeline to repair notes. Rejected because it can reprocess successful articles or replay accepted/uncertain submissions.

## Decision

Retain ADR-0016's single scheduled owner and recipient dispatcher. This decision replaces only its coupled research/archive retry behavior. Store validated article body, full/short summary, canonical identity and integrity checksum transactionally in that same database. Ordinary encounters reuse success; unresolved interrupted work and damaged known records do not become cache misses. Bound admission instead of evicting successful identities.

Give HN and general news independent bounded execution envelopes and preserve committed articles if another source fails. Persist source outcomes separately from channel outcomes. Freeze the deliverable once, then allow normal eligible delivery independently of local archive settlement. Archive jobs read saved bodies/summaries only and cannot generate or send content.

Use a generation-specific directory inside each date for new archive snapshots. Otherwise a delayed same-day retry can overwrite a newer summary. Preserve old files; existing snapshot content is checked and repaired from saved bytes rather than treating mere file existence as success. Retries are bounded, ownership/attempt-fenced and observable through inspection.

## Consequences

- Positive: successful research survives source, archive and channel failures without repeated article work or automatic supplemental sends.
- Positive: source completeness, archive success and channel acceptance remain independently inspectable.
- Negative: successful article assets consume retained capacity; exhausted storage needs explicit local maintenance. Unknown/missing historical results may remain unavailable rather than being automatically rewritten.
- Negative: new archives add per-generation directories. Existing old archive paths stay readable.
- Neutral: deployment and phone receipt remain separate evidence; source/summary semantic accuracy still needs human evaluation. Historical failure-notice replay is a separate deferred issue.

## Sources

- [Daily AI news specification](../specs/daily-ai-news.md), REQ-005–007 and its failure sequences.
- User: “如果同一批文章已经有摘要，则不应生成新的摘要” and “归档失败不阻塞推送。更新方案并开始实现”; subsequent “继续” after the message prototype.
- Real temporary-store reuse, source deadlines, interrupted archive repair, capacity and fixture ingress evidence in [the test report](../.workings/daily-ai-news/test-report.md).

## Current-selection clarification (2026-10-17)

The user confirmed “Top 7 是当前榜单的 7 条（允许再次展示旧文章）”. A new HN occurrence may select the same saved article result again; successful processing and previous delivery are distinct. This does not weaken immutable summaries, frozen-message recovery or terminal no-replay. Source counts come from the frozen instruction, validated within the existing total budget, without changing task settings. [REQ-008](../specs/daily-ai-news.md) defines selection and explicit shortfalls.

## Content-admission clarification (2026-10-18)

New article success requires candidate/body correspondence as well as summary format validation. Assess topic support in the same structured summary response; independently check that its supporting excerpt occurs in the supplied body before persistence. This does not turn substring matching into proof of semantic truth. Reject wrong-topic/insufficient content before selection and continue within existing source bounds. A failed content check invalidates reuse of that failed body on a later eligible attempt, not the immutable-success rule. The user approved one-time eligibility validation on the next encounter with a legacy success. Preserve body and summaries unchanged; save a separate verdict, reuse only matches, and exclude mismatched/insufficient results from new selection. Persist the claim before calling the model; failures/interruption remain unavailable without an automatic repeat, and fencing prevents late admission. Historical successful records and frozen messages retain their original audit. [REQ-009](../specs/daily-ai-news.md) owns the admission and recovery boundaries.
