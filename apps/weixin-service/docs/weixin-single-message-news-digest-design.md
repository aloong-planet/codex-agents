# Complete summaries in one Weixin message

Date: 2026-10-12. Current requirements: [daily-ai-news specification](../../../docs/specs/daily-ai-news.md), REQ-004.

## Goals and boundaries

- Preserve the article’s central claim and necessary qualifications as complete natural Chinese prose. Background, development, evidence and impact are not mandatory fields or display sections.
- Each visible article block, including number, title and source, stays within 280 Unicode code points. Up to ten selected articles, headings and separators stay within one 1,500-code-point message.
- Keep detailed prose in the local archive; do not overwrite it with the delivery brief.
- News selection, archive layout, delivery safety and historical frozen messages keep their existing contracts.

## Generation and validation

The researcher produces `summary` (detailed prose, existing 1,000-code-unit storage bound) and `brief` (one or two complete sentences, at most 80 code points including punctuation) from the same article. Both prompts require the central claim, attribution, negation and material limitations without invented facts or title-only paraphrases.

A shared brief validator rejects empty or punctuation-only text, over-budget text, ellipsis markers, line breaks and missing sentence endings. One invalid-brief result gets one rewrite attempt with the original source context. A second failure follows the existing general-news failure or HN candidate replacement behavior. Unrelated process/JSON failures are not content rewrites. These checks enforce form and length; they do not prove semantic fidelity.

## Formatting and persistence

`formatNewsDigest(digest)` reserves heading/separator overhead, divides the remaining space between articles and bounds title/source metadata. A valid brief is inserted intact; it is never cut or replaced with a prefix plus ellipsis. Metadata keeps its existing code-point-safe abbreviation policy. The 80-code-point brief budget leaves room for worst-case metadata even with ten articles and both headings.

`NewsArchive.archive` writes the detailed `summary`. The file store preserves the optional `brief` in both preview and run digests. It is optional only for legacy stored data; new research requires it. On restart, preview formatting uses the retained brief. Cached delivery sends the frozen `run.message` exactly and does not regenerate it.

A legacy preview without a brief keeps the entire whitespace-normalized summary when it fits and contains no ellipsis; otherwise it shows `旧版摘要未提供完整短版，可查看本地详细归档。`. This notice is not a generated viewpoint. Existing frozen outbound text is not rewritten by the upgrade.

## User sequences and failure modes

1. Generate or preview: read sources, validate complete summaries, persist them and archive detailed prose before delivery. Preview and new delivery share the same short text.
2. Model output exceeds the budget or uses an ellipsis: rewrite once; still invalid means no cut summary is sent.
3. Ten articles with long non-BMP metadata: bound metadata, retain each complete brief, produce one segment.
4. Credentials expire after generation: retain both summaries and frozen message; after original-account recovery and fresh inbound, send the cached text in date order.
5. Restart: reload both summaries; startup may reconcile the detailed archive again, while delivery recovery performs no new research.
6. Old persisted data: retain frozen outbound messages and use the explicit legacy-preview fallback when necessary.

## Verification

- Researcher-to-formatter exact prose output without the former four fields.
- Successful bounded rewrite, exhausted rewrite and unrelated failure paths.
- Empty, punctuation-only, unfinished, multiline, ellipsis and 81-code-point rejection; ten intact 80-code-point briefs with non-BMP metadata fit 280/1,500 limits and one segment.
- Real file-store restart and durable fixture inbound preserve the exact brief; the archive contains detailed prose.
- Negative mutations for ellipsis acceptance, off-by-one length and hard cutting fail at their intended assertions.
- Real-model source/summary samples provide limited semantic evidence; live Weixin receipt remains separate user acceptance.
