# Daily AI news

> Related decisions: [ADR-0016](../adr/0016-daily-news-owner-handoff.md), [ADR-0017](../adr/0017-daily-news-results-and-archives.md)

## Overview

Daily AI news helps an enabled Weixin recipient keep up with verified AI developments. Generated reports stay saved when the account or conversation needs recovery.

## Capabilities

- Manage the existing daily news from Weixin: view its settings/history, edit its name, research focus and future time, enable/disable, execute once, or delete while retaining history. It defaults to 08:30 Shanghai time; downtime considers only the latest missed slot, and intentionally paused time is not backfilled.
- Read concise, complete summaries of each article’s main argument without mandatory background/development/evidence/impact sections.
- Skip newly processed articles when the fetched body is unrelated to the candidate title or lacks supporting content. Continue with other eligible articles and explain any final shortage; an advertisement is not substituted for the requested article.
- Keep the detailed summary and original article for local archiving while preview and delivery use the same complete short version.
- Select the saved number of articles from AI news, the current HN hot list, or both, up to ten in total. HN selection follows current hot-list order and the past-24-hour submission window. A new execution may show previously delivered articles again while reusing their saved summaries without rereading or regenerating them.
- Receive completed content with an explicit missing-source explanation if a source remains unavailable. When there are too few eligible verified articles, see the target count, actual count and reason; a failed or incomplete source is not reported as complete.
- Receive saved reports even when local archiving fails. Inspect source, archive and delivery results separately; archive recovery reuses saved content and does not resend the report.
- Rewrite an overlong or incomplete short summary once instead of cutting it off with an ellipsis.
- Keep generated reports when credentials expire or the conversation context becomes unavailable.
- After rebinding the original account, send a fresh Weixin message from the original recipient to resume eligible saved reports automatically.
- Send saved reports and other scheduled results in oldest eligible planned-time order for the same recipient. Paused results do not block other eligible tasks.
- Retain saved reports across service restarts without researching them again for delivery. A conversation already refreshed before restart resumes automatically without another message.
- See how many reports are waiting, their earliest date, and whether to rebind the original account or send a fresh message. Recovered conversations stop showing an outdated refresh instruction.
- Stop the current batch when a submission fails; later fresh messages can resume reports that remain eligible.
- Stop further submissions when news is disabled or the account or recipient changes.

## Boundaries and non-goals

- Rebinding alone is insufficient: the original recipient must send a fresh message to restore the conversation.
- Reports already accepted, partially accepted, explicitly rejected for other reasons, or with an unknown result are never automatically resent. An interrupted submission is treated as unknown.
- Only retained content can be recovered. Execution summaries have no count-based retention limit; pending/paused reports and today's retryable automatic failures stay protected from settled-detail cleanup. Previously missing research is not regenerated as history; a full cache blocks new generation until space is available.
- A request already in progress cannot be recalled. Channel acceptance is not confirmation that the phone received the message.
- Manual preview and manual send remain separate explicit operations. Generating a preview does not send it; an unsuccessful explicit preview send is not automatically repeated. Preview generation blocks sending an older preview.
- No-output automatic research failures retry after 10, 30, then 60 minutes within the same Shanghai day. Explicit retry preserves an existing future retry time. Archive failures have their own three retries using saved content and may cross midnight; exhaustion remains visible. Pausing/deleting prevents new automatic attempts.
- Older successful articles are checked once when encountered again. Passing articles reuse the unchanged saved summary; rejected or unverifiable articles stay out of new reports. Failed or interrupted checks are not automatically repeated. Historical articles and already saved reports keep their original wording.
- Successful article results do not expire automatically. Missing, damaged or uncertain results are not silently regenerated; reaching storage capacity blocks new processing while preserving saved content.
- While ownership transfer needs reconciliation, news execution and mutation stay blocked with an explanation.
- HN examines the first ten current hot-list candidates. Unsupported or over-limit source/count requirements fail explicitly; unavailable articles are not fabricated to fill the report.
- A new short summary has up to 80 Unicode characters including punctuation; each article block stays within 280 and the full report within 1,500.
- If the rewrite still fails, the article follows the existing research failure or candidate replacement behavior; sentence and length checks alone cannot establish factual accuracy.
- Previously saved outbound messages retain their exact wording. Older previews without a fitting complete summary display a notice directing the reader to the detailed archive.
