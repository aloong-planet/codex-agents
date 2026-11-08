# Penny private bookkeeping setup and acceptance

Penny is a separate owner-only financial bot. Keep Sam, Alice, Bill and Jack's applications, group allowlists, personal memory identity, file grants and scheduled tasks unchanged. Do not add Penny to a group or to the dispatch roster. Text recording and payment-image previews are available in this code; statement import is not enabled.

## Private application and binding

Create a separate Feishu application with Bot capability and owner-only availability. Publish only the messaging permissions required for private intake and receipts: `im:message.p2p_msg:readonly`, `im:message:readonly` for incoming message resources, and `im:message:send_as_bot`. No group-message or payment-account access is required. Verify the permission picker and publication in the actual tenant before acceptance. See Feishu's [message event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) and [message resource API](https://open.feishu.cn/document/server-docs/im-v1/message/get-2).

Explicitly select the known owner in Penny's own application context and verify that application's tenant key, owner open ID and private conversation ID. Do not copy Sam's open ID, infer ownership from a display name, or bind the first unsolicited sender. The general Feishu pairing command edits the existing personal-channel binding and is not a Penny setup command.

Set `PENNY_CONFIG_PATH` to an absolute, private configuration file. Its permissions must exclude group/other access (`0600`), with an owner-only parent (`0700`). The following values are synthetic placeholders:

```json
{
  "appId": "cli_eeeeeeeeeeeeeeee",
  "appSecret": "REPLACE_WITH_PENNY_APP_SECRET",
  "tenantKey": "REPLACE_WITH_PENNY_TENANT",
  "ownerOpenId": "ou_REPLACEOWNER",
  "privateChatId": "oc_REPLACEPRIVATECHAT",
  "webhook": {
    "port": 4319,
    "path": "/feishu/penny/events",
    "verificationToken": "REPLACE_WITH_PENNY_TOKEN",
    "encryptKey": "REPLACE_WITH_PENNY_ENCRYPT_KEY"
  }
}
```

Use an application distinct from the existing roster and a port distinct from administration and Sam's receiver. The optional configuration is read on startup. An invalid Penny configuration leaves Penny unavailable without disabling healthy existing channels. A changed application/tenant/owner cannot open a ledger bound to the previous identity. Correct a mistaken binding instead of deleting the ledger to bypass that check.

Penny uses the existing owner's selected available Codex model through its own restricted runtime. The installed Codex must support structured output, local images and named permissions. Financial interpretation has no file-operation, shell, browser, shared memory or payment tools. Operational status at local `/api/state`, open only to an [authorized browser](../../apps/weixin-service/README.md#local-login), exposes `penny.configured`, `penny.ready` and value-free error codes; it does not expose financial records.

## Callback and deployment

Use the repository-pinned Node and pnpm versions. Prepare the reviewed release and dependencies, then follow the existing [controlled cutover and backup procedure](feishu-agent-dispatch.md#public-ingress-and-cutover) before changing the service launcher. Preserve the entire private state directory, including SQLite WAL/SHM files. Never run two production services against it.

Penny's receiver binds loopback only. Add a separate exact public route, for example `https://YOUR_HOST/feishu/penny/events`, forwarding to `http://127.0.0.1:4319`. Keep Sam's existing route and the catch-all rejection. Do not expose administration port 4317. A path example is not a claim that a route has already been created.

Configure encrypted event delivery for Penny, using its own token/key and `im.message.receive_v1`. Verify the callback challenge, then actual signed private messages. Penny validates the application and authenticated header tenant, then the configured owner and private chat before extracting media or invoking the model. Plaintext financial callbacks are not accepted.

Financial records, pending previews, private turn history, callback state, delivery outcomes and downloaded images live beneath `penny/` in the existing protected private state directory. Group file tools also exclude `PENNY_CONFIG_PATH` when it is outside that directory. Keep private backups; do not attach raw state or source images to public issue/PR reports.

## Owner acceptance

Use harmless test entries and note the returned record and preview identifiers; replace example identifiers with those actually received. Record the deployed version, exact requests, actual replies and what the owner saw. Fixture acceptance and platform acceptance do not establish device receipt.

| Action in Penny's private chat | Expected observation |
| --- | --- |
| `记一笔：今天午饭已支付 35 元。` | A personal expense receipt with a stable F reference and actual saved amount. |
| `经营账记一笔：今天销售款已到账 120 元。` | A business income receipt; the personal book remains separate. |
| Ask `这个月个人账收入、开销和结余是多少？`, then ask for the business book. | Each report names its own period/book and matches recorded entries. |
| `我打算明天买电脑，大概 8000 元。` | Clarification, no invented actual payment. |
| Send a clear payment screenshot containing an actual paid amount and date. | A Q preview of visible facts, no posting yet; an order total must not replace actual payment. |
| Send a cropped or unclear screenshot, then supply the requested missing amount/date. | Unresolved facts are identified; clarification produces a revised preview retaining its rows. |
| Change a pending preview to business, then send the old confirmation. | The old version is refused. Confirm only the new full preview using its exact `确认 Q00000001/2` token. |
| Send the same current confirmation twice. | The same saved references are returned, with no second financial entry. |
| `把 F00000001 的金额改为 32 元。` using the actual reference | A corrected saved amount and retained history. Ask to view that reference to inspect revisions. |
| `撤销 F00000001` using the actual reference | A withdrawal preview; only its exact confirmation removes the entry from totals. |
| Send a statement file. | A clear unavailable-import response; no claim of a successful empty import. |
| Repeat an existing ordinary Weixin request and a harmless Alice group task. | Original channels and bot identities still work; Penny's amounts never appear there. |

A successful clear-text request changes the ledger immediately. Test records can be withdrawn with confirmation afterwards; history remains. Refunds require the corresponding original reference, or an explicit explanation that the original was not recorded. Confirmed own-account movements do not count as income/expense. Reports describe recorded cash movement, not bank balances or business profit.

If a preview reply is uncertain, do not repeatedly resend the original payment. Ask `查看预览 Q00000001` using its actual identifier; only a completely accepted current preview can be confirmed. If a receipt is missing after a text write, query the relevant period/reference first. The service does not repeat completed financial work or blindly resend uncertain output.

## Deferred source validation

WeChat Pay/Alipay statement profiles need representative redacted original-format samples. The owner explicitly sequenced this after text, private conversation and image previews. Preserve column names, encoding, quoted fields, status/refund shapes and identifiers as strings when preparing examples; replace personal values. Original exports are required only to verify platform-file compatibility, not to use text bookkeeping or screenshot previews.

Synthetic vision fixtures establish model plumbing only. Real wallet screenshot recognition and real private image receipt must be observed during owner acceptance. No payment/bank account login, account synchronization, money transfer, tax reporting or group-finance access is included.
