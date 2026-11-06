# ADR-0025: Isolate private financial authority from assistant memory

- Status: Accepted (2026-11-07)

## Context

The owner requested personal and business bookkeeping but explicitly restricted all financial information to their own private conversation. Existing group specialists share business facts and file grants, while the ordinary private channels share curated owner memory. Treating another named bot as another group role would conflict with the confirmed financial boundary.

## Options

1. **Use an independent private Penny application and financial store, separate from the group roster and general personal memory.**
2. Share financial facts in the existing group business context — rejected by the owner's private-only decision.
3. Use a separately designated shared group book — discussed as an alternative and not selected; the owner chose all financial access through their own private chat.

## Decision

Keep Penny outside group dispatch. Authenticate its application, tenant, app-scoped owner identity and configured private chat before media or model access. Give the financial model only private financial context and supplied images; the host alone chooses storage, authority and reply destination. Do not place financial facts in ordinary memory curation or give other agents financial operations.

Maintain personal and business books separately. Use exact stored cash events, corrections and outcomes for calculation instead of treating conversation prose as a ledger. Explicit clear text may post directly; source images and files require the owner's review of the exact current preview. Preserve original events and separate actual-date refunds. Own-account movements do not count as income or expenditure. Financial commits and delivery outcomes have separate durable identities so a missing receipt cannot repeat a completed mutation.

## Consequences

- Positive: adding financial capability does not widen group or shared-memory authority; saved events provide reproducible totals and corrections.
- Negative: Penny requires a separate application binding, callback and live acceptance instead of reusing the group specialist setup. The owner cannot query financial history through the other assistants.
- Neutral: these are scope and authority decisions, not a claim of deployed platform permissions, perfect image recognition or verified statement compatibility. Statement-source validation follows the owner's prioritized text/private-chat/screenshot delivery.

## Sources

- Owner-confirmed private-only use, separate personal/business books, CNY, direct clear text, confirmed images/files, actual-date refunds and own-account transfer choices, retained in the [financial specification](../specs/finance-assistant.md).
- [ADR-0023](0023-isolate-feishu-group-authority.md) for group and protected-state boundaries.
- [ADR-0024](0024-coordinate-independent-group-agents.md) for the group dispatch scope that Penny does not join.
