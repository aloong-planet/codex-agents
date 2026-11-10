# Documentation layout

This repository uses one `docs/CONTEXT.md` across its workspace packages.

## Authoritative documents

| Location | Purpose |
| --- | --- |
| `docs/CONTEXT.md` | Domain terminology and invariants |
| `docs/adr/` | Architectural decisions and their rationale |
| `docs/specs/<slug>.md` | Agreed requirements, current user-visible behavior, boundaries, and exclusions |
| `docs/prototypes/` | Approved interface and interaction references |
| `docs/postmortems/` | Incident analysis and lessons |
| `docs/ops/` | Project-specific operational procedures |
| `docs/agents/` | Agent workflow conventions |
| `docs/testing/` | Test requirements, procedures, and report templates |

Each feature is described once, by its specification.
Cross-check current claims against implementation and current verification
evidence; report discrepancies rather than silently choosing one account.

## Working records

`docs/.workings/<slug>/` contains tickets, tasklists, review records,
documentation-sync checklists, and test reports.

Retain these records, but do not treat historical working records as
independent authority for current behavior. Keep current status summaries
and checklists up to date as implementation and acceptance change.
Preserve original test evidence; do not rewrite historical failures as passes.

Follow the active skills for ticket-prefixed artifact names.
Use `docs/testing/test-report-template.md` for each iteration's test report.

## Research

Store persistent research in `~/research/<purpose>/`.
Link to the canonical research document when needed; do not create a
duplicate research copy in this repository unless explicitly requested.

## Before making changes

Read `docs/CONTEXT.md` and the relevant specifications and ADRs. Use the established domain vocabulary. Explicitly identify
conflicts with existing decisions instead of silently overriding them.
