# Penny private bookkeeping

> Implemented: text bookkeeping, private Feishu intake and screenshot previews. Live application provisioning and owner-observed acceptance remain pending. Statement import profiles remain unavailable until their final source-sample validation.
> Related: [personal and group boundaries](channel-switching.md), [existing agent dispatch](agent-dispatch.md), [ADR-0023](../adr/0023-isolate-feishu-group-authority.md), [ADR-0025](../adr/0025-isolate-private-financial-authority.md).

## Problem Statement

The owner wants an assistant that records personal and business receipts and payments and calculates income, expenditure and the resulting surplus or deficit. Ordinary chat history is not an accounting source: remembered prose cannot reliably deduplicate payments, preserve corrections or reproduce totals. Financial details must remain in the owner's private conversation rather than entering a group's shared business context.

## Solution

Penny is an independently identified Feishu bot for the owner alone. It maintains separate personal and business books in CNY, understands explicit text instructions, previews payment screenshots, and commits those previews only after confirmation. WeChat Pay/Alipay statement profiles remain the later, source-validated part of the confirmed scope and are currently unavailable. It answers bookkeeping questions from persisted records and exact calculations. Financial state and private execution context are separate from Sam's group coordination and the other specialists.

## User Stories

### finance-assistant::US-001 Use Penny privately

As the owner, I want to speak privately with Penny so that my financial records do not appear in group conversations.

- finance-assistant::US-001/AC-01: An authenticated private message from the configured owner reaches Penny and receives a reply from Penny's own Feishu application in that private conversation.
- finance-assistant::US-001/AC-02: Group messages, bot/system messages and other users cannot read or mutate the ledger, confirm a proposal, retrieve its attachments or receive financial replies.
- finance-assistant::US-001/AC-03: The binding uses the owner's identity in Penny's application. A matching name, Sam's application-scoped user ID or the first unsolicited message cannot establish ownership.
- finance-assistant::US-001/AC-04: Penny's financial records, source materials and execution history are not inserted into group/shared business memory or general personal-memory curation. A prompt or imported document cannot override this boundary.

### finance-assistant::US-002 Record clear text without an extra confirmation

As the owner, I want to describe completed receipts and payments naturally and obtain a record reference that I can correct later.

- finance-assistant::US-002/AC-01: An explicit, unambiguous text instruction records its actual financial events and replies with stable record references, ledger, date, direction, amount and description only after the write succeeds. A failed write is not reported as saved.
- finance-assistant::US-002/AC-02: An unspecified ledger defaults to personal. Business entries require an explicit business selection. The two books remain separately queryable and are never silently combined.
- finance-assistant::US-002/AC-03: Each record carries CNY amount, effective local date, financial-event kind, description and category, plus provenance and a stable reference. Amount and date ambiguity produces a clarification rather than a guessed financial event. Omitted text dates use the admitted message's date in Asia/Shanghai.
- finance-assistant::US-002/AC-04: Planned purchases, unpaid/failed transactions, quotations, examples and vague discussion are not silently recorded as actual income or expenditure. Missing or contradictory facts are clarified before a write.

### finance-assistant::US-003 Review statements and payment screenshots

As the owner, I want to review extracted financial events before a file or image changes my books.

- finance-assistant::US-003/AC-01: Verified WeChat Pay and Alipay statement profiles produce a preview from the original uploaded structure, preserving source identifiers as strings. Support is claimed only for profiles backed by representative source-format fixtures and successful parsing validation.
- finance-assistant::US-003/AC-02: Payment screenshots produce a preview of visible actual payment/receipt/refund facts. A cropped, ambiguous or illegible amount, date, status or direction is marked unresolved and clarified; an order total cannot silently replace the amount actually paid.
- finance-assistant::US-003/AC-03: The preview identifies the destination book, candidate records, excluded non-success rows, proven duplicates and unresolved items. Nothing in the preview contributes to totals before confirmation. The owner can select personal or business before committing.
- finance-assistant::US-003/AC-04: Only the owner can confirm the exact current preview. A changed ledger, row, amount or source requires the updated preview to be shown before confirmation; a stale or ambiguous confirmation cannot commit a different proposal.
- finance-assistant::US-003/AC-05: Confirmation commits the reviewed eligible records atomically and returns actual committed references and skipped counts. Repeated confirmation or source-event delivery cannot create a second set of records.
- finance-assistant::US-003/AC-06: Cancelling a pending import leaves the financial records unchanged. Unknown/corrupt/encrypted/unsupported or oversized files yield an actionable response, not an empty successful import. Unresolved rows cannot disappear into a silently partial success.

### finance-assistant::US-004 Correct mistakes without losing the explanation

As the owner, I want to correct or withdraw a record and see totals reflect the current valid entries.

- finance-assistant::US-004/AC-01: An explicit correction naming one record and a clear replacement value updates that record, reports the actual change and preserves its preceding revision. An ambiguous reference requires selection before modification.
- finance-assistant::US-004/AC-02: A withdrawal first previews the selected record and requires confirmation. The withdrawn record is excluded from totals while its history remains available. Replaying the confirmation cannot withdraw another record.
- finance-assistant::US-004/AC-03: Financial records and their source identities survive corrections. Correcting, withdrawing or retrying delivery does not permit a later overlapping statement to silently reinstate or duplicate the original event.

### finance-assistant::US-005 Understand recorded income and expenditure

As the owner, I want to query a selected book and period so that I can understand actual receipts, expenditure and net movement.

- finance-assistant::US-005/AC-01: Queries by date period, month and category return totals and relevant records calculated from committed, non-withdrawn ledger data. The response identifies its ledger and date range. An unspecified book remains personal.
- finance-assistant::US-005/AC-02: Reports distinguish gross income/expenses, their corresponding refunds and the resulting net totals where refunds are present. Net movement is net income minus net expenditure; it is not an assertion of bank balance or business profit.
- finance-assistant::US-005/AC-03: Empty results are reported as no recorded transactions or zero totals within the requested range. The model does not manufacture missing records or treat an unavailable query as zero.

## Functional Requirements

### finance-assistant::REQ-001 Apply the confirmed cash timing

- finance-assistant::REQ-001/AC-01: Actual receipts and payments use their effective local dates.
- finance-assistant::REQ-001/AC-02: Received purchase refunds reduce expenditure in their actual receipt month.
- finance-assistant::REQ-001/AC-03: Paid sales refunds reduce income in their actual payment month.
- finance-assistant::REQ-001/AC-04: The original event and refund remain separate; a later refund does not rewrite an earlier month's original payment. An ambiguous or unlinked source relationship is clarified before automatic reconciliation. Duplicate protection follows finance-assistant::REQ-004.

### finance-assistant::REQ-002 Separate own-account movements (direct acceptance)

Confirmed movements between the owner's own accounts, including own-account top-ups and withdrawals, remain financial records but do not contribute to income or expenditure. A transfer label alone does not prove self-ownership; ambiguous external versus internal movements require clarification.

### finance-assistant::REQ-003 Calculate exact amounts

- finance-assistant::REQ-003/AC-01: Decimal CNY values are represented and calculated in exact integer minor units; arithmetic is produced by the ledger, not language-model estimation.
- finance-assistant::REQ-003/AC-02: Non-CNY, malformed, excessive-precision and out-of-range amounts are rejected rather than silently converted, rounded or allowed to overflow.

### finance-assistant::REQ-004 Deduplicate financial events

- finance-assistant::REQ-004/AC-01: Transport retries cannot create a second financial mutation for the same admitted instruction.
- finance-assistant::REQ-004/AC-02: Source/profile and stable transaction/refund identities are retained when available; overlapping files cannot repeat a proven existing event.
- finance-assistant::REQ-004/AC-03: Distinct refunds on one order remain distinct events, and a changed financial status cannot erase history or create a second original payment.
- finance-assistant::REQ-004/AC-04: Text/screenshot similarities without conclusive identity are duplicate candidates requiring clarification, not proof that one of two real purchases should be discarded.

### finance-assistant::REQ-005 Recover without replaying writes

- finance-assistant::REQ-005/AC-01: Record mutations, pending preview revisions and operation outcomes survive restart; a crash after commit, model reconnect or explicit retry cannot repeat completed financial mutations.
- finance-assistant::REQ-005/AC-02: Delivery outcomes are separate from financial outcomes. A failed receipt cannot restart financial work; accepted or uncertain messages are not blindly resent.
- finance-assistant::REQ-005/AC-03: A failed transaction rolls back its candidate writes and is reported accurately.

## Constraints

### finance-assistant::CON-001 Retain the agreed group boundary (direct acceptance)

Penny does not join the existing shared group or become a group-dispatch execution role. Its owner-only private entry is defined by finance-assistant::US-001.

### finance-assistant::CON-002 Restrict runtime authority (direct acceptance)

Use the existing Codex runtime with an isolated financial session and host-controlled financial operations. Imported content is data, not authority. The model cannot select another owner, application, conversation, database, arbitrary path or destination, and cannot obtain payment-account, terminal, browser, purchasing or transfer authority from this feature.

### finance-assistant::CON-003 Preserve existing channels

- finance-assistant::CON-003/AC-01: Penny's optional configuration and lifecycle preserve existing Sam/Alice/Bill/Jack group dispatch, private Weixin/Feishu behavior, permissions, memory and scheduled tasks under [ADR-0023](../adr/0023-isolate-feishu-group-authority.md).
- finance-assistant::CON-003/AC-02: An unavailable Penny connection cannot redirect financial content to another agent or prevent unaffected channels from working.

### finance-assistant::CON-004 Keep private evidence private

- finance-assistant::CON-004/AC-01: Financial state and downloaded sources use private local storage under the service's protected state boundary.
- finance-assistant::CON-004/AC-02: Ordinary diagnostics and public operational state do not expose source contents, amounts, transaction identifiers or ledger records.
- finance-assistant::CON-004/AC-03: Parsing/rendering does not execute formulas, macros, scripts, external links or instructions embedded in source documents.

## Failure modes and boundaries

| Owner operation or external event | Required outcome |
| --- | --- |
| First private contact, another user with the same display name, Sam's user ID copied to Penny | Verify the app-scoped binding before any financial access under finance-assistant::US-001/AC-01 through finance-assistant::US-001/AC-03. |
| Group mention, forwarded bot message, spoofed application/tenant or resource key | Reject at the authenticated private boundary under finance-assistant::US-001/AC-02 and finance-assistant::CON-002. |
| Clear personal expense, explicit business income, several events in one instruction | Return only committed records under finance-assistant::US-002/AC-01 through finance-assistant::US-002/AC-03. |
| “Want to buy”, unpaid order, quoted past statement, missing amount or unclear date | Clarify or decline recording under finance-assistant::US-002/AC-04. |
| Decimal edge cases, zero/negative malformed source amount, non-CNY, oversized amount or aggregate | Apply exact validation under finance-assistant::REQ-003; no partial/rounded financial claim. |
| Statement header/preamble/footer, encoding, quoted delimiter, leading-zero identifier or unsupported source profile | Verify source structure and preview under finance-assistant::US-003/AC-01 and finance-assistant::US-003/AC-06. |
| Image is cropped, multiple amounts are visible, status is pending, screenshot and existing bill overlap | Clarify ambiguity and duplicate candidates under finance-assistant::US-003/AC-02 and finance-assistant::REQ-004. |
| Import shown, book changed, rows edited, old “yes” arrives, two previews exist | Bind confirmation to the exact reviewed preview under finance-assistant::US-003/AC-03 through finance-assistant::US-003/AC-05. |
| Import cancelled, parse fails, storage fails or reply send fails | Preserve the distinction between unchanged ledger, committed financial data and failed receipt under finance-assistant::US-003/AC-06 and finance-assistant::REQ-005. |
| Full/partial/multiple refunds, original transaction absent, refund status later changes | Use actual settlement date and distinct identities under finance-assistant::REQ-001 and finance-assistant::REQ-004; clarify an unknown relationship. |
| Own-account transfer, external transfer with ambiguous ownership, recharge or withdrawal | Apply finance-assistant::REQ-002 without inferring ownership from a direction label. |
| Correction/withdrawal followed by reimport, stale record revision or duplicate confirmation | Preserve revisions and deduplication under finance-assistant::US-004 and finance-assistant::REQ-004. |
| Query empty period, personal versus business, refund in a later month, negative net expenditure | Return the mathematically correct ledger-specific totals under finance-assistant::US-005 and finance-assistant::REQ-001. |
| Duplicate webhook, crash before/after commit, restart with pending preview, model reconnect | Recover durable outcomes under finance-assistant::REQ-005 without a second write. |
| App unavailable, owner binding changed, finance session tries another agent's state | Fail closed for finance and preserve unrelated channels under finance-assistant::CON-002 and finance-assistant::CON-003. |
| Imported cell/formula, hyperlink, image metadata, HTML or prompt injection | Treat content as inert source material under finance-assistant::CON-004; no network/file action follows from its contents. |

## Implementation Decisions

The owner explicitly sequenced implementation on 2026-11-06: finish text bookkeeping, private Feishu conversation and screenshot previews first, and perform statement-source sample validation last. Missing statement samples do not block those independent capabilities. Statement compatibility remains unverified until the source-profile acceptance conditions are met; it must not be advertised as available in the meantime.

The private financial authority and memory boundary are defined by [ADR-0025](../adr/0025-isolate-private-financial-authority.md). Financial records are a dedicated durable domain store, not curated chat memory. Store exact amounts, event dates, source identities, revisions and durable operation outcomes. Queries and confirmations operate on trusted owner-bound references. Model interpretation proposes typed financial actions; deterministic host validation, authorization, calculation and persistence decide the actual effect.

The ledger represents cents as decimal strings at storage/model boundaries and uses integer arithmetic internally. A single positive amount supports at most 16 integer digits and two fractional digits; aggregate totals retain exact cents beyond that per-record bound. Missing categories remain unclassified. A refund may reference an existing corresponding record or retain the owner's clarification that the original transaction was not recorded; the latter does not fabricate an original payment.

The private financial entry has its own application binding, authenticated intake, restricted execution context and original reply destination. Reuse the existing authenticated Feishu transport, durable inbox and isolated runtime patterns where they preserve this contract; do not add Penny to the group's outbound-only roster as a substitute for a private intake.

Penny uses a separately configured encrypted callback and the existing durable webhook receiver. Its tool-free model produces a validated financial command; the host executes that command and renders the saved result. Persist the command before a mutation and the reply before submission, so recovery reuses the same operation rather than interpreting a delivered message again. Callback tenant identity, application identity, configured private chat and app-scoped owner are checked before media extraction or model access. The optional Penny lifecycle does not gate unrelated channels.

Preview confirmations name the current preview and revision explicitly, such as `确认 Q00000001/1`. Changed previews need a newly accepted complete delivery before confirmation. An uncertain delivery is not automatically resent; the owner can explicitly request `查看预览 Q00000001`. Similar transactions require an explicit duplicate/distinct decision followed by confirmation of the updated preview. Screenshot clarification retains every preview row; cancelling the whole preview remains available.

The service uses `PENNY_CONFIG_PATH` for its separate private configuration, excluding that file from all file access, private and group, even when it is outside the state directory ([workflow-runs::CON-003](workflow-runs.md)). Financial storage, media and model histories stay under the protected private state root. Operational state contains only configuration/readiness/error status; synthetic outboxes exist only in explicit fixture mode. The model receives bounded recent financial context plus any records/previews explicitly named by the owner.

Future statement adapters must normalize only observed source profiles. Until those profiles are validated, every statement-file upload receives an explicit unavailable response without downloading or parsing it. Screenshots are interpreted as evidence with explicit uncertainty and confirmation. Neither parser success nor a confident model phrase is proof that money moved. Source-format fixtures and live application verification remain distinct from synthetic service tests.

The confirmed prototype establishes clear-text posting, preview/confirmation, correction, withdrawal, summary and private-boundary flows. Refund and transfer answers further define the accounting rules; they do not create a new management interface.

## Testing Decisions

Reuse the production-equivalent fixture inlet, real service startup and isolated model/transport controls for intake-to-private-reply wiring. Financial operation tests use the public ledger/tool boundary, with temporary private storage and injected clock; amount/date normalization and aggregation rules use pure-function unit tests. Do not repeat every calculation branch through a new full-process test.

Source adapters require representative redacted files that preserve the original platform structure. Synthetic rows then cover arithmetic and boundary variants. An invented generic spreadsheet is not evidence of actual platform compatibility. Actual Codex interpretation and actual private Feishu file/image receipt require separate live evidence; fixture delivery is not recipient receipt.

Regression covers unchanged Weixin input and media delivery, existing Sam group routing, no finance tools in other agents, and no finance records in shared memory/public operational state. Crash/restart and concurrent confirmation tests observe persisted results through public operations, not private database mutation.

## Out of Scope

- Inventory valuation, accrual accounting, receivables/payables, statutory accounts, tax filing, investing and bank-balance reconciliation.
- Bank statement profiles, unspecified merchant-console/API profiles, foreign currencies and currency conversion.
- Login or synchronization with payment/bank accounts, payment credentials, money transfers, purchases or account management.
- Group bookkeeping, other members' financial access and financial records in group memory.
- Automatic periodic financial reports, budgets and account-connection features not requested in this delivery.

## Further Notes

The current consumer-export schema of each payment platform requires representative redacted evidence before claiming import support. The initial prototype uses synthetic data and demonstrates interaction/state rules only. Published bot permissions, app-scoped owner binding, encrypted callback verification and real private text/image/file receipt are deployment acceptance prerequisites.
