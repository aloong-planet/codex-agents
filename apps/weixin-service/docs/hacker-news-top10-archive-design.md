# Hacker News Top 10 每日归档设计

> 此设计已被 `hacker-news-top5-complete-archive-design.md` 取代；保留本文仅用于记录旧版行为。

## 目标

每天研究时，把 Hacker News 官方 `topstories` 前 10 条保存到 demo Vault：

`news/YYYY-MM-DD/Hacker News Top 10.md`

这份文件是候选审计记录，不等同于微信日报。微信日报继续最多包含 3 条 HN 深读摘要，整份日报仍最多 10 条。

## 数据流与 interface

保留既有 `AiNewsResearcher.generate(window): NewsDigest` interface；`NewsDigest` 增加可选 `hackerNewsTop` 和独立的 `hackerNewsTopCapturedAt` 抓取时间。每条包含：

- `rank`：官方 topstories 当次顺序 1–10；
- `title`、`url`、`submittedAt`、`score`、`comments`；
- `source`：由原文 URL 主机名生成的展示来源；
- `status`：`summarized | historical_duplicate | unreadable_or_unverified | not_selected`。

`CodexHackerNewsResearcher` 一次读取官方前 10 条并形成快照：历史文章先标记 `historical_duplicate`；最多 3 条未见候选进入深读；成功返回摘要的标记 `summarized`；进入深读但模型无法读取/核验的标记 `unreadable_or_unverified`；其余未进入深读的标记 `not_selected`。

`CombinedNewsResearcher` 原样把快照放入最终 digest。调度器缓存 digest；`DailyAiNewsFileStore` 校验并持久化快照；`NewsArchive.archive(digest)` 在写摘要前幂等创建或更新 Top 10 文件。微信格式化器与公开 preview 不读取或展示候选 URL。

## 文件内容

Top 10 文件包含抓取时间和 10 条编号记录，每条展示标题、来源、HN 分数、评论数、提交时间和处理状态；原始链接只保存在 Vault 文件中，不进入微信或网页预览。状态使用诚实措辞：

- 已进入日报深读摘要
- 历史已摘要，本次去重
- 已尝试深读，但正文不可读取或无法核验
- 本次未进入最多 3 条深读名额

## 用户操作序列与失败模式

1. HN API 成功、摘要成功：保存完整 Top 10，并给进入日报的条目标记“已进入日报深读摘要”。
2. Top 10 中有历史文章：仍保存在榜单文件，标记历史去重，不重新摘要。
3. 可深读候选超过 3 条：前三条进入深读，其余保留并标记未入选。
4. 模型省略已选候选：即使全部省略也保留榜单条目，标记正文不可读取或无法核验，不让摘要缺失阻断审计快照。
5. HN API 不可用：整次研究失败，不创建伪造榜单。
6. Vault 正文部分失败：Top 10 文件和摘要仍按已有单篇失败语义写入。
7. 同日重启或重复预览：复用账本中的快照，幂等更新同一路径，不重新抓取 HN。
8. 升级前已有当日 preview：实现完成后只获取一次官方 Top 10 元数据，以独立抓取时间补齐该 preview 和 Vault，不重新生成摘要、不发送微信。

## 验证

- 研究 seam：官方前 10 条全部保留，四类状态准确，日报仍最多 3 条 HN。
- 状态 seam：快照可 round-trip，超长、坏 URL、非法状态被拒绝。
- 归档 seam：生成独立 Top 10 文件；同日重跑更新而非冲突；摘要正文行为不回归。
- 全量：lint、typecheck、Vitest、build、fixture E2E。
- 真实验证：补齐今天的 Top 10 文件并确认共有 10 条；不重新研究、不发送微信。
