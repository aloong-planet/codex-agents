# 每日 AI 新闻微信汇总设计

> Historical design/review: scheduling and storage ownership below describe the former dedicated scheduler. Current behaviour is defined by the [daily-news specification](../../../docs/specs/daily-ai-news.md), [scheduled-task specification](../../../docs/specs/scheduled-tasks.md) and [ADR-0016](../../../docs/adr/0016-daily-news-owner-handoff.md). Earlier summary-format proposals in this record are superseded by the complete-prose contract.

Current summaries, cache recovery and executable resolution: [daily-ai-news specification](../../../docs/specs/daily-ai-news.md).

## 1. 目标与已确认需求

在现有独立腾讯 iLink Demo 中，为用户明确启用的单个微信目标增加每日 AI 新闻汇总：

- 每天 `08:30`，时区固定为 `Asia/Shanghai`。
- 全球综合 AI 新闻，优先 LLM、模型/论文、训练推理、评测、安全、Agent、多模态与开源工具等技术进展，同时覆盖芯片、政策、产品与重要产业事件。
- 每次最多 10 条，压缩为一条微信纯文本消息；素材充足时至少 6 条为技术更新，融资与纯商业合作最多 2 条；不为凑数降低质量，无重大更新也发送状态说明。
- Summaries express the article’s main argument in natural Chinese prose, retaining material qualifications and evidence. No four-part structure or labels are required. Only actually read and verifiable articles are included; a title paraphrase is insufficient.
- 输出固定包含独立的“Hacker News 热门技术”部分：每次按官方 `topstories` 前 10 名的原始顺序尝试深读，成功 5 篇即停止；单篇失败直接剔除并顺延，最终不足 5 篇时按实际成功数量输出，0 篇也不阻断普通新闻。
- 微信正文、网页预览和公开状态只展示来源名，不展示具体链接；规范 URL 仅在私有账本中用于核查与去重。
- 新闻时间窗固定为实际运行时向前滚动 24 小时；08:30 正常运行时覆盖前一日 08:30 至当日 08:30，当日补跑则以补跑时刻为终点。
- 不使用 7 天或其他更长时间窗补齐数量；24 小时内合格技术新闻不足时，允许少于 10 条，避免用旧闻凑数。
- Scheduling runs inside the service process. An optional [LaunchAgent](../../../docs/launch-agent-design.md) keeps it running. A missed schedule catches up on the same day; missing historical research is not regenerated, but saved historical reports can resume.
- Keep generated content when context or credentials fail. Reconcile original-account recovery and persisted fresh conversation state on startup, channel updates and scheduled work, as well as inbound. Drain cached reports in ascending date order and stop at the first failed submission. An unchanged rejected context cannot trigger another attempt. Existing notices show count, oldest date and the actual required action.
- 发送超时或结果未知时绝不自动重试，避免重复消息。
- 第一版先通过页面手动预览、手动测试发送验证；真实发送由用户亲自触发。

## 2. 已核实事实与边界

- 现有 `WeixinCodexService` 只由文本入站驱动，没有定时调度。
- 腾讯 iLink 出站必须携带最近入站消息签发的 `context_token`；公开实现没有固定 TTL 或主动刷新接口。
- `sendmessage` 明确返回非零 `ret` 可判为拒绝；请求异常或 15 秒超时只能判为结果未知。
- 当前交互聊天使用 Codex App Server。官方定位更偏富客户端会话；定时任务应使用隔离的非交互 Codex 运行。
- 本机 Codex CLI 支持 `--search`、`exec`、`--ephemeral` 和结构化输出。本功能用独立 CLI live-search 运行，不读取或污染微信聊天任务。
- 进程内调度意味着：电脑关机、Demo 停止或终端退出期间不会运行；页面必须诚实显示这一点。

## 3. 模块与 seam

### 3.1 `AiNewsResearcher`

接口只有一个方法：按本地日期与精确起止时间生成结构化候选新闻。生产 adapter 启动隔离的 Codex CLI：

- `--search` 启用最新网络检索；
- 在权限为 `0700` 的临时空目录运行，不继承项目工作目录；
- `--ignore-user-config --ignore-rules`，并关闭 `skill_search`、`plugins`、`multi_agent`，避免个人技能、项目规则或子代理接管新闻流程；
- `exec --ephemeral --sandbox read-only --ask-for-approval never --json`；
- prompt 写入 UTC ISO 起止边界，要求只纳入发布时间落在该 24 小时闭区间的新闻；
- 最终结果再次在本地解析 `publishedAt`，任何不可解析或越界条目都使整次研究失败，不把提示词遵循当作校验；
- 普通新闻先运行“发现”任务：解析 JSONL 事件并要求至少 1 个已完成的 `web_search`，以证明任务确实使用了实时网页搜索；不再设置独立搜索次数门槛。完全未搜索时，即使结果为合法空数组也判为失败；发现阶段 Schema 最多接受 20 个只含标题、来源、规范 URL 和发布时间的候选；
- 本地按规范 URL 计算文章身份，删除普通新闻批内与持久历史中的重复项；只把最多 5 个未摘要普通候选交给第二个隔离任务深读和生成摘要，且摘要输出的 URL 必须属于候选白名单；
- 每条摘要带 `section=general|hackernews`；HN 结果必须来自官方前 10 名、保留原排名且不得重复，最多 5 条；缺失条目不进入摘要或榜单。
- Demo 从 HN 官方 API 取得前 10 个当前候选，按排名串行深读；正文、摘要或候选元数据单条失败时继续下一名，成功 5 篇即停止。HN 不做跨日历史过滤。为避免跨栏目重复摘要，先完成 HN，再把成功条目的身份加入普通新闻排除集，最后与最多 5 条普通新闻合并。各 Codex 子任务相互隔离，单次超时为 240 秒。
- prompt 要求分主题检索并以 LLM/研究/训练推理/评测/开源工具等技术内容为主；素材充足时至少 6 条技术更新，融资与纯商业合作最多 2 条；
- prompt 明确要求查证发布日期与原始链接，优先官方发布，权威媒体只作补充；URL 仅用于内部核验与去重，不进入面向用户的输出；
- Codex returns a detailed `summary` plus an independently readable `brief` of at most 80 Unicode code points including punctuation. Both use natural prose grounded in the source. The brief must end as a sentence and contain no ellipsis or newline. Invalid briefs receive one rewrite with the original source context; persistent failure follows the existing general-research failure or HN candidate replacement policy. Process and malformed-output failures do not receive this content rewrite.
- 禁止调用 Vault、微信或其他写工具。

测试使用内存 adapter，不启动网络或 Codex。

### 3.2 `DailyAiNewsScheduler`

这是对调用方暴露的小接口：`start()`、`enable(target)`、`disable()`、`preview()`、`sendPreview()`、`getPublicState()`、`onInbound(event)`、`close()`。实现内部统一处理：

新闻研究后的 Obsidian 正文归档与微信自然追问由配套设计 `docs/news-archive-design.md` 定义。调度器在研究成功后、任何发送之前调用该归档 seam；归档整体失败时不发送，单篇正文不可取得时由归档模块按已确认策略跳过。

- 上海时区日期与下次 08:30；
- 启动时的当日补跑；
- 每日 `runKey` 幂等；
- 新闻条目去重与消息格式化；
- 发送前持久化、发送结果分类、崩溃恢复；
- Serial chronological recovery on startup, channel updates, scheduled work and same-account/target inbound, rechecking enabled binding and credential usability before each submission.

`DemoService` 只做 HTTP/UI 协调，不复制调度状态机。

### 3.3 持久化账本

使用 Demo 私有状态目录中的 `daily-ai-news.json`，不写 OpenClaw 配置或凭据：

```text
config: disabled | { accountId, target, enabledAt }
runs[runKey]: researching | ready | sending | accepted | partial | pending_inbound | context_refresh_required | auth_relogin_required | rejected | unknown | failed
preview: 最近一次结构化结果和格式化消息
seenItemKeys: 最多 500 个规范 URL 哈希，用于兼容既有投递去重
summarizedArticleKeys: 最多 100,000 个规范 URL 哈希，用于在摘要前排除历史文章
```

规则：

- `runKey` 为上海时区 `YYYY-MM-DD`，同日只自动研究一次。
- 同日手动预览和自动任务复用已缓存的 preview；新摘要与 `summarizedArticleKeys` 在归档前写入，归档失败只重试归档，不再次研究。
- 写入 `sending` 后才调用 iLink。进程启动发现遗留 `sending` 时转为 `unknown`，不自动重发。
- On restart, discard unfinished `researching` records and legacy `ready` records without content; preserve `ready` records with content. Research and sends share one serial queue.
- `accepted` 永不自动重发。
- `ready`, legacy `pending_inbound`, `context_refresh_required`, and `auth_relogin_required` with saved content are eligible for recovery using a newer persisted conversation context. Each send persists its context refresh time before submission; old records compare against their failure time. Generic rejection, partial acceptance, unknown, and accepted states are excluded. Rebinding another bot never transfers cached content.
- 网络异常、超时、响应格式未知属于 `unknown`，等待人工处理。
- 账本不保存 bot token、context token 或完整响应体。

## 4. 用户真实操作序列与失败模式

1. 用户选择已发现目标并启用日报。
   - 目标未发现、账户失效或没有入站上下文：拒绝启用并提示先发消息。
   - 别名仅用于页面展示；持久化仍绑定机器 ID。
2. 进程在 08:30 正常运行。
   - 研究成功：保存预览，再尝试发送。
   - 无重大更新：发送固定状态消息。
   - 研究失败：记为 `failed`，当日不静默伪造内容，也不发送空消息。
3. 进程在 08:30 未运行，当天稍后启动。
   - If today has no run, generate today only. Previously saved content is distinct from missed research and can still be delivered after recovery.
4. Context or credentials become unavailable.
   - Save the report and wait for a fresh message from the original account/recipient after recovery. Send oldest first; stop on failure and retain any still-recoverable content. Generic rejection is terminal.
5. iLink 超时或网络异常。
   - 状态为 `unknown`；不自动重发，页面要求人工核查微信端。
6. 发送期间进程退出。
   - 重启后把 `sending` 视为 `unknown`；不重复发送。
7. 用户禁用日报。
   - 取消未来 timer；保留审计账本和预览。若正在研究，研究结果可留作预览但发送前再次核对启用目标并停止发送；已提交的发送不能撤回。
8. 用户手动预览或测试发送。
   - 预览只研究不发微信；测试发送需要已有预览和用户点击。
   - 手动测试使用独立的 `manual-*` run，不占用当天自动 runKey。
9. 候选标题重要但正文受付费墙或抓取限制。
   - 不根据标题补写摘要，也不使用空泛措辞占位；跳过该候选并继续检索其他可核验来源。
10. 综合新闻在过去 24 小时内为空。
   - 仍读取 Hacker News 当前热榜；只要存在可读的相关技术文章，预览保留 HN 部分，而不是返回整个日报为空。

## 5. HTTP 与页面

`GET /api/state` 增加脱敏的 `dailyNews`：启用状态、目标、下次运行、最近 run 状态、notice、预览正文及不含 URL 的来源列表。新增同源 POST：

- `/api/news/preview`
- `/api/news/send-preview`
- `/api/news/enable`
- `/api/news/disable`

页面新增“每日 AI 新闻”面板，展示 08:30、进程内限制、当日补跑规则、目标别名、最近结果和明确反馈。自动启用与手动发送均只允许已发现的当前目标。

## 6. 验证策略

- 单元 seam：虚拟时钟、内存 store、假 researcher、假 channel，覆盖 08:30、当日补跑、no regeneration of missed historical research, chronological recovery of saved reports, 同日幂等、状态恢复和入站补发。
- researcher 单测：假进程输出，覆盖 schema 校验、空结果、超时、非零退出与格式化长度。
- HTTP 单测：同源保护、四个 endpoint、错误反馈。
- 页面 E2E（fixture）：选择目标、生成预览、启用/停用和测试发送反馈；fixture 不联网、不连接腾讯。
- 整体网关：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e`。
- 实网验证分两步：先运行一次 live-search 预览且不发送；真实微信测试发送最后由用户亲自点击并在手机确认。

## 7. 设计审查补充

13. **上海自然日会漏全球新闻**：凌晨或 08:30 运行时，只查“当天”会遗漏欧美前一工作时段；改为以实际运行时为终点的滚动 24 小时窗口。
14. **项目上下文会劫持检索流程**：生产 CLI 若在项目目录运行，可能加载工作区规则、个人技能或尝试子代理；改为空临时目录，并显式忽略规则、用户配置和关闭相关 feature。
15. **结构化空结果不能证明查过网页**：合法 `items: []` 可能来自未执行搜索的模型输出；普通新闻发现任务必须在 JSONL 事件中看到至少 1 次完成的 `web_search`，否则不保存预览。搜索次数不再作为覆盖度硬门槛。
16. **只扩大数量会让融资与供应商公告继续挤占结果**：检索按技术主题分槽，素材充足时至少 6 条技术更新，纯商业/融资最多 2 条；不足时宁缺毋滥。
17. **直接删 URL 会破坏核验和跨日报去重**：URL 仍保存在权限受限的私有账本，但格式器与公开状态映射必须删除 URL，用户只看到来源名。
18. **Ten articles must fit one message**: bounded complete briefs plus bounded title/source metadata retain all selected articles within 1,500 code points. Each visible article remains within 280.
19. **把搜索次数当作覆盖度会造成假失败**：一次搜索可以打开和核验多个来源，多次搜索也不必然覆盖更多主题。生产门禁只验证至少发生一次真实搜索；主题覆盖继续由 prompt、候选 Schema、时间窗和来源核验约束，不再用固定次数阻断日报。
20. **扩大到近 7 天可增加数量，但会削弱“每日”新鲜度并混入旧闻**：用户明确拒绝该 fallback；严格保留过去 24 小时，搜索充分后仍不足就少发。
21. **A short summary can degenerate into a title paraphrase**: the prompt requires the central claim and its material qualifications. Syntax validation is not a semantic guarantee; source/summary samples require separate review.
22. **Detailed prose exceeds delivery space**: preserve it in the archive and persist a separate complete short summary for preview and sending. Do not slice the argument or drop a selected article to make it fit.
23. **通用实时搜索不能保证命中 Hacker News**：提示词必须显式读取 HN 官方 `topstories` 和 item API；结构化结果至少包含一条 `hackernews`，格式器用独立标题展示。
24. **HN 热榜时间与原文发布时间不是同一概念**：普通新闻继续校验原文发布时间在过去 24 小时；HN 使用官方 item 的提交时间作为 `publishedAt`，栏目名明确表示“当前热门”，不称为今日发布。
25. **把综合搜索与 HN 候选放在一个任务会连续撞上 180/240 秒超时**：HN 官方前 10 名按排名交给独立单篇深读任务，成功 5 篇即停；普通新闻拆成发现与摘要两个隔离任务。HN 先完成，再把成功条目的身份排除出普通新闻，以少量延迟换取跨栏目确定性去重。
29. **单篇 HN 不可读不应阻断日报**：候选元数据、正文读取或结构化摘要失败都只淘汰该篇并顺延，最多尝试官方前 10 名；Vault 二次抓取失败也从最终摘要剔除。HN 整体不可用时仍继续普通新闻，最终有多少发多少。
28. **只在发送后记住文章会反复支付摘要成本**：使用规范 URL 的持久 `summarizedArticleKeys`；发现后、本地摘要前过滤，摘要生成后先缓存 preview 与 key，再尝试归档和发送。
26. **成功预览后顶层状态仍显示历史自动任务失败**：保留 `lastRun` 历史状态，同时让当前进程内成功预览显示 `ready`，避免把历史投递失败误报为当前预览失败。
27. **Completeness does not require four fields**: `summary` and `brief` replace mandatory context/development/evidence/impact output. Include background only when needed to understand the claim. Frozen cached messages are preserved; legacy previews without a fitting complete summary show an explicit archive notice.
