# Hacker News 可读文章顺延与日报失败隔离设计

日期：2026-08-15

## 1. 目标与验收标准

每日新闻从 Hacker News 官方 `topstories` 的前 10 个排名中，按原排名依次选择最多 5 篇可完整处理的文章：

- 排名 1–5 任一篇正文抓取、摘要生成或摘要校验失败时，直接跳过并继续排名 6–10。
- 成功满 5 篇立即停止；最多检查前 10 名，不继续扩大范围。
- 前 10 名最终不足 5 篇时，有几篇就归档、展示和发送几篇；失败条目不进入摘要、榜单文件或微信正文。
- Hacker News 整体不可用或 10 篇全部失败时，普通 AI 新闻仍继续研究、归档和发送。
- Vault 归档阶段二次抓取某篇 HN 正文失败时，也从最终日报中剔除该篇，不阻断其他条目。
- 不伪造摘要、不用标题代替正文、不把排名 6–10 冒充原始 Top 5；归档保留每篇真实 HN 排名。

## 2. 现有失败链

当前实现只取前 5 名，并在 `CodexHackerNewsResearcher.generate()` 中串行处理。循环内的正文读取或摘要异常没有单篇隔离，任一异常会直接退出整个 HN researcher。`CombinedNewsResearcher` 又先 `await` HN，再运行普通新闻，因此 HN 单篇失败会阻止整份日报。

研究成功后，`NewsArchive` 会再次抓取正文。完整 5 篇模式下，只要一篇未归档，就抛出 `Top 5 原文未全部归档`；scheduler 因此不发送已经成功的其他新闻。

## 3. 深模块与 interface

### 3.1 HN 候选发现

`fetchHackerNewsCandidates(fetcher, limit)` 保持现有 interface，生产默认 `limit=10`：

- `rank` 永远是该 ID 在官方前 10 中的原始位置。
- topstories 主请求失败或无合法 ID 时仍抛出整体错误。
- 单个 item 请求失败、非 story 或元数据不完整时返回空位并过滤，不因一条失败拒绝整批。
- 返回 0–10 个按原排名排序的可用候选。

### 3.2 HN 深读选择

`CodexHackerNewsResearcher.generate(window)` 的外部 interface 不变，复杂性留在模块内部：

1. 最多读取候选前 10 名。
2. 依次执行 `loadArticle -> Codex summary -> parseOutput`。
3. 任一步失败即丢弃当前候选并继续；不保存原始错误到 digest。
4. 成功结果达到 5 篇后停止。
5. `items` 与 `hackerNewsTop` 只包含同一组成功文章，`hackerNewsTop.rank` 保留原排名。
6. 0 篇也是合法 HN digest，不抛错。

### 3.3 组合研究失败隔离

`CombinedNewsResearcher` 仍先尝试 HN，以便普通新闻排除已成功 HN 的 URL；但 HN researcher 的整体异常转换为空 HN digest，然后继续普通新闻。普通新闻自身失败仍使当天研究失败，因为它没有第二条独立可信来源可替代。

### 3.4 归档返回最终可发送 digest

`NewsArchive.archive(digest)` 的返回值增加 `digest`，表示经过实际 Vault 正文落盘后仍可交付的最终结果：

- 输入 HN audit 与 HN 摘要身份不一致仍是程序/数据完整性错误，必须抛出。
- HN 正文二次抓取或写入失败时，该 HN item 和对应 audit 一起从返回 digest 剔除。
- 普通 AI 新闻沿用既有策略：正文不可归档时摘要仍保留并标记“正文未归档”。
- 摘要文件和 HN 榜单文件只根据过滤后的 digest 生成。
- 有结果时统一使用实际数量路径 `Hacker News 热门 N 篇.md`；0 篇时不创建 HN 榜单文件。旧日期的 `Hacker News Top 5.md` 保留，不删除或改写。

`DailyAiNewsScheduler` 在 archive 返回后，用该最终 digest 重新生成微信正文并更新 preview；全局 Vault 错误仍按 archive failure 重试，不发送。

## 4. 用户操作与失败路径

1. Top 1 抓取失败，2–6 成功：最终发送排名 2–6 的 5 篇，保留原排名。
2. Top 1、4 失败，其他前 10 只有 3 篇成功：最终只发送 3 篇，不显示失败的 1、4。
3. item API 某一项 503：跳过该排名，继续其他前 10。
4. topstories 主 API 失败：HN 为空，普通 AI 新闻继续。
5. 正文读取成功但 Codex 摘要失败：跳过该候选并顺延。
6. 研究阶段成功、归档二次抓取失败：从最终 digest 剔除该 HN 条目，其他内容照常发送。
7. 所有 HN 均失败、普通新闻有结果：只发送普通新闻。
8. HN 与普通新闻都为空：发送现有“暂无值得汇总”状态文本。
9. 普通新闻研究失败：保持研究失败与后台退避，不伪造日报。
10. 发送 unknown/partial：保持既有防重复规则，不因本功能自动重发。

## 5. TDD 与验证

- 纵切 1：候选前 10 中单个 item 失败，返回其余候选并保留原排名。
- 纵切 2：前 5 中两篇失败，使用第 6、7 名补足 5 篇；验证最多只处理到第 7 名。
- 纵切 3：前 10 仅 3 篇成功，返回 3 篇；全部失败返回空 HN digest。
- 纵切 4：HN 整体异常时普通新闻仍生成。
- 纵切 5：Vault 二次抓取失败后，scheduler 的 preview/微信正文只包含最终归档成功的 HN 条目。
- 全量网关：lint、typecheck、Vitest、build、fixture Playwright E2E；不触发真实研究或微信发送。
