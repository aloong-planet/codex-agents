# Penny private bookkeeping

> Related decisions: [ADR-0025](../adr/0025-isolate-private-financial-authority.md)

## Overview

The owner can keep personal and business receipts and payments in a private conversation with Penny. Penny records clear text, previews payment screenshots and reports totals from saved entries.

## Capabilities

- Only the configured owner in Penny's private conversation can use the books. Groups and other users receive no financial reply and cannot retrieve or confirm financial records.
- Clear text about completed receipts or payments records the actual events and returns stable record references, book, date, direction, amount and description after saving.
- An unspecified book defaults to personal; business entries must be selected explicitly. The two books are queried separately.
- Payments use their actual dates. Text without a date uses the message date in Shanghai; ambiguous or conflicting details require clarification.
- Screenshots produce an unposted preview. Cropped or unclear facts remain unresolved; the owner can supply missing facts and select the destination book before confirmation.
- Confirmation must name the current preview and version. Changed previews must be shown again; old confirmations cannot commit a newer proposal. Cancelling leaves the books unchanged.
- Similar transactions are flagged for the owner to identify as another purchase or an existing entry. Repeated messages and confirmations do not create another copy of the same saved operation.
- Explicit corrections naming a record retain its history. Withdrawals require a preview and confirmation, remove that entry from totals and retain the history.
- Queries by period, month and category show saved entries and separate income, expenses, refunds and net movement. An empty period is reported as no recorded transactions.
- Received purchase refunds reduce expenses in the receipt month; refunds paid to buyers reduce income in the payment month. Originals and refunds remain separate and their relationship must be clear.
- Confirmed movements between the owner's own accounts remain records without increasing income or expenses.
- Saved results and pending previews survive restart. A missing reply does not repeat completed bookkeeping; an uncertain preview can be requested again explicitly.

## Boundaries and non-goals

- Penny must be configured and published as a separate private bot. Its financial history is separate from general personal memory and group discussion; group specialists cannot access it.
- Penny does not use the owner's personal skills; naming one in a Penny conversation applies nothing.
- Only CNY is supported, with amounts accurate to cents. Invalid amounts, unsupported currencies and future payment dates are refused.
- Planned purchases, quotations, examples and unpaid or failed transactions are not actual income or expenditure. Image interpretation may require clarification; review the visible facts before confirming.
- Statement-file import is unavailable. Uploading a file produces an explanation and does not create an empty successful import.
- Reports describe recorded cash movement, not bank balances, business profit, inventory valuation or tax accounts. Payment-account connections, transfers, purchases and automatic financial reports are not included.
- Penny does not execute instructions, links or scripts embedded in a screenshot and has no general computer-file or browser operations.
- Channel acceptance does not prove the owner received a message. When a receipt is missing, query saved records before submitting a new payment instruction.
