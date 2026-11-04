# Typing ticket 预取设计

## 目标

把 `getconfig` 从 `startTyping()` 的串行冷路径移到合法微信入站持久化之后，并保证：

- 同一 `(accountId,target)` 同时最多一个 `getconfig` 请求；
- `startTyping()` 命中 ticket 缓存，或等待已存在的 in-flight 请求；
- 旧 `context_token` 请求失败而期间已有更新上下文时，用最新上下文受控重试；
- 不在扫码完成但尚无入站上下文时请求；
- 不持久化、不展示 ticket 或 `context_token`。

官方插件 2.4.6 的对应生命周期和边界见 [`typing-ticket-prefetch.md`](/Users/loong_zhou/research/codex-weixin-typing-latency/typing-ticket-prefetch.md)。

## 状态机

每个 `(accountId,target)` 独立维护：

```text
empty
  ├─ prefetch/start ─> fetching(context generation N)
  │                       ├─ success ─> positive cache
  │                       └─ failure ─> negative cache/backoff
  ├─ positive cache ─> start 直接发送 typing
  └─ negative cache
       ├─ 相同 context ─> 沿用失败结果，不重复请求
       └─ 更新 context ─> 立即进入 fetching(N+1)

fetching(N) 期间同目标新调用：
  └─ 等待同一个 Promise；若 N 失败且已有更新 context，合并为一次 N+1 重试
```

不同账户或目标永不合并。

## 深模块接口

`IlinkTypingManager` 继续隐藏缓存、退避、并发合并和上下文代际，只新增一个窄接口：

```ts
prefetch(context: IlinkTypingContext): void;
start(context: IlinkTypingContext): Promise<IlinkTypingLease>;
```

`prefetch` 是 fire-and-forget：内部捕获失败，不产生未处理 rejection。调用者无需管理 Promise，也不能读取 ticket。`start` 是唯一需要等待并取得 lease/脱敏诊断的接口。

内部数据：

- `cache[key]`：ticket、下次刷新时间、退避、该结果使用的 context；
- `inFlight[key]`：请求使用的 context 与共享 Promise；
- `latestContext[key]`：仅内存保存最新上下文，用于失败后的单次新代际重试。

`close()` 清空上述状态；已发出的 fetch 仍由现有 15 秒 AbortController 上限终止，结果不得在 close 后重新填充缓存。为此 manager 使用 generation，close 后旧 generation 的结果只能返回给原等待者，不能写缓存。

## 调用时机

### 实时入站

1. `getupdates` 解析消息；
2. SQLite `ingestBatch` 成功，cursor/context/envelope 已原子持久化；
3. 对 `kind=message` 的上下文调用 `prefetch`，不等待；
4. 调度 durable drain；
5. 业务层进入目标 FIFO，随后 `startTyping` 复用预取。

非 durable 回退路径在私有状态保存成功后执行同样预取。

### 重启恢复

`notifystart` 后，从持久化 context 中按 `contextUpdatedAt` 倒序选择最近 3 个目标做非阻塞 warm-up。durable queued message 在绑定为事件时也调用 `prefetch`，确保未进入最近 3 个目标的积压任务仍能预取。

fresh login 的 `contextTokens` 为空，因此不会预取。

## 脱敏诊断语义

- 预取已完成：`ticketCache=hit`、`getConfig=skipped`；
- `start` 加入仍在运行的预取：`ticketCache=miss`，展示该共享 `getconfig` 的耗时/结果；
- 负缓存命中：`ticketCache=miss`，沿用最近一次 `getConfig=failed`，`sendStart=skipped`；
- 新 context 绕过旧负缓存并成功：`ticketCache=miss`、`getConfig=completed`。

不得新增 token、ticket、账户或目标字段。

## 失败模式与不变量

- 多条消息并发：只发一个请求；每条消息仍独立进入 FIFO，不合并任务或回复。
- 旧上下文失败、新上下文已到：只由共享状态发起一次新代际请求；其他等待者加入它。
- 同上下文失败：遵守原退避，禁止请求风暴。
- 预取成功、首次 sendtyping 失败：按现有行为失效 ticket；下条消息可用新上下文重新获取。
- 服务 close/restart：旧请求不得污染新 generation。
- getconfig 失败不阻断入站、回执、Codex 或最终回复；最多退化为 typing unavailable。
- warm-up 限 3 个最近目标，不扫描或请求无限目标。

## 验证

- manager：预取成功后 start 不再 getConfig；并发预取只调用一次；旧 context 失败后最新 context 只重试一次；相同 context 失败遵守负缓存；close 后旧请求不写缓存。
- channel：持久化完成后、listener 开始前已调用预取；重启仅 warm 最近 3 个；fresh login 不预取。
- 回归：typing 诊断、keepalive、stop、跨账户隔离保持。
- 全量 lint、typecheck、单测与 fixture e2e；真实微信只由用户发送新入站验证。
