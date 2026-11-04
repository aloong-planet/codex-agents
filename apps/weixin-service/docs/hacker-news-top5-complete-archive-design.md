# Hacker News Top 5 全量摘要与原文归档设计

> 已由 `hn-readable-fallback-design.md` 取代。本文件仅保留历史决策；当前流程是官方前 10 名顺延选取最多 5 篇，单篇失败剔除且不阻断日报。

## 目标

每日固定读取 Hacker News 官方 `topstories` 前 5 条。5 条必须全部生成可核验摘要，并把清洗后的原文正文写入当天 Vault；不再出现“未进入深读名额”。

输出文件：

- `news/YYYY-MM-DD/Hacker News Top 5.md`：每条的摘要、本地正文链接、排名、分数、评论数、提交时间及处理状态；
- `news/YYYY-MM-DD/摘要.md`：包含 5 条 HN 摘要及最多 5 条普通 AI 新闻；
- `news/YYYY-MM-DD/<文章>.md`：每条 HN 的清洗后原文正文。

## 模块与 interface

保持 `AiNewsResearcher.generate(window): NewsDigest` 和 `NewsArchive.archive(digest)` 两个既有 interface，不新增调用方法。

`CodexHackerNewsResearcher` 固定取得官方前 5 条，先由本地安全正文读取器抓取和清洗每篇真实原文，再把正文按排名串行交给 5 个独立 Codex 摘要任务。这样既避免模型自行访问 URL 时静默省略，也避免多个本地 Codex 进程争用 rollout/state DB。输出必须满足：

- 正好 5 条；
- 每条 URL 都来自当次官方 Top 5；
- 5 个候选 URL 全部各出现一次；
- 每条通过既有结构化摘要质量校验。

任一条缺失、重复、候选外注入或无法核验，整次 HN 研究失败，不产生“成功但无摘要”的预览。HN Top 5 不再应用跨日历史摘要排除；这是为了保证当天榜单 5 条都有摘要与正文。普通新闻仍继续使用历史去重，且最多 5 条，使整份日报仍不超过 10 条。

`NewsArchive` 对 `section=hackernews` 采用强完整性：5 条正文全部已存在或本次成功写入后，才写 Top 5 榜单和摘要。普通新闻正文仍保留单篇失败可跳过的现有语义。

## 失败模式

1. 官方 API 不足 5 条：研究失败，不把残缺榜单称为 Top 5。
2. Codex 少返回一条、返回重复 URL 或候选外 URL：研究失败。
3. 任一 HN 原文无法读取、过短或超过 Vault 大小限制：归档失败，不报告完成，也不自动发送微信。
   - 正文抓取优先 IPv4，规避部分站点 IPv6 路径超时；仍执行每次 URL/DNS 公网地址校验。
4. 前几篇正文已写入后后续失败：保留已写文件供幂等重试；不写新的 Top 5 文件或摘要。
5. 普通新闻正文失败：仍可跳过，不影响 5 条 HN 的强完整性。
6. 当日旧预览仍是 Top 10/仅 1–3 条摘要：不会冒充完成；需重新运行当日研究生成 Top 5 完整预览。
7. 旧 `Hacker News Top 10.md` 作为历史文件保留，不删除用户 Vault 内容；新流程只写 Top 5 文件。

## 验证

- 研究模块：只给 Top 5、要求恰好 5 条摘要、普通新闻最多 5 条。
- 归档模块：5 条 HN 原文全部存在；任一缺失时整体失败且不写摘要/榜单。
- 状态与页面：显示 `Hacker News Top 5.md`，不公开原始 URL。
- 全量执行 lint、typecheck、Vitest、build 和 Playwright E2E。
- 真实验证不发送微信；重新生成今日预览属于真实外部研究，完成后核对 5 条摘要和 5 篇原文。
