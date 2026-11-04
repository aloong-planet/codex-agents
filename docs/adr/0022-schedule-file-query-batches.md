# ADR-0022: Schedule file-query batches without consuming execution time while waiting

- Status: Accepted (2026-11-01)

## Context and problem

Per-turn workers and budgets already isolate state, but concurrent traversals contend for the same disk. Standard launch policy and independent diagnostics remove two amplifiers; cross-turn scan admission remains unbounded.

## Alternatives

1. Bounded FIFO batch admission with separately bounded waiting and unchanged execution allowance: selected.
2. Include admission waiting in the existing 60 seconds: user chose execution-only accounting so another query does not spend the caller's execution allowance.
3. Raise execution limits or add a persistent shared index: outside the authorized scope; no implementation comparison claimed.

## Decision

Serialize traversal batches across the shared File Tools service, while preserving each turn's worker and aggregate counters. A continuation joins the queue tail. Retain 60 seconds of actual execution, bound cumulative queue waiting separately and reject excess admission explicitly. Closing one turn removes its waiters; active cleanup must finish before admission is released, and other turns retain separate identities. Ordinary reads, mutations and external delivery do not enter this traversal queue. This implements the query scheduling previously deferred by ADR-0021; its diagnostic persistence and launch decisions remain in force.

## Consequences

- Positive: service-generated scan concurrency is bounded and later requests can progress between find batches. Waiting does not exhaust another turn's work allowance.
- Negative: end-to-end latency includes queue waiting; the physical disk remains shared and grep may hold a slot until its existing request deadline.
- Neutral: no persistent job, shared results/index, new semantic owner, budget increase or routing change.

## Sources

- User on 2026-11-01 authorized optimization 03 and selected “实际执行仍限 60 秒，排队时间另设上限”.
- [Workflow specification](../specs/workflow-runs.md), workflow-runs::REQ-072 and workflow-runs::CON-002.
- Current public File Tools baseline: separate turn exhaustion/reference/release checks pass; overlapping real-worker batches lack cross-turn admission control.
