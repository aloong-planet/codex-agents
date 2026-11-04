# Context token 时效实验与发送失败分类设计

## 目标

在不暴露 context token、bot token、完整错误正文或额外账号秘密的前提下：

1. 将腾讯 iLink 出站失败区分为 context 缺失/失效、bot 凭据失效、明确拒绝和结果未知。
2. Daily-news recovery follows the [current specification](../../../docs/specs/daily-ai-news.md): recover cached context/credential failures only for the original enabled binding, serially by date; exclude unknown, partial, accepted and generic rejected outcomes.
3. 从一条用户确认的真实入站所生成的 context 开始，在 T+23h 到 T+48h 每小时发送一条可见探针，持久记录首次失败时间和已接受探针数。
4. 在本地页面长期显示实验基准、当前状态、下次探针、有效时长下界或首次失效时长。

## 已确认事实与限制

- 腾讯插件 2.4.6 的出站请求必须原样携带该目标最近入站消息的 `context_token`。
- 腾讯没有公开 context token TTL 或主动刷新接口。`getconfig ret=0` 不能证明 `sendmessage` 仍可用。
- 已观察到旧 context 的 `sendmessage ret=-2`，新入站刷新 context 后发送恢复；因此 `-2` 可用于本实验的“出站 context 被拒绝”分类，但不是公开协议保证的永久错误合同。
- `ret=-14` 是 bot 凭据失效/暂停，不能归入 context 过期。
- 每小时真实探针既受时间影响，也可能受主动发送次数配额影响。本轮结果表述为“这条 context 在经过 X 小时、累计 N 次逻辑探针后首次被拒绝”，不声称测得纯时间 TTL。
- 渠道接受只证明 iLink 接口接受请求，不证明手机已实际显示。

## 用户已确认的实验参数

- 基准：最近一条真实入站更新 context 的时间。
- 首次探针：T+23h。
- 间隔：每 1h。
- 最后探针：T+48h（包含）。
- 探针：发送用户可见的简短微信文本。
- 电源：实验期间用 `caffeinate -i` 防止空闲睡眠；合盖、断电、系统重启仍可能降低精度。
- 新入站：同账户同目标出现更新后的 context 时，本轮实验立即标记为失效并停止，不能把新 token 的结果拼入旧实验。

## 模块边界

新增深模块 `ContextTokenExpiryExperiment`。外部只看四个动作：

```ts
interface ContextTokenExperimentControl {
  start(): void;
  activate(input: { accountId: string; target: string; baselineContextUpdatedAt: number }): void;
  getPublicState(): PublicContextTokenExperimentState;
  close(): void;
}
```

模块内部负责持久化、计时、context 一致性检查、真实发送、结果归类和 `caffeinate` 生命周期；调用方不接触探针调度细节。

`DemoService` 仅把公共状态并入 `/api/state`。实验通过一次性本地 CLI 激活，页面不提供重复启动按钮，防止误开启真实发送。

## 发送结果合同

`SendTextResult.reason` 扩充为：

- `context_missing`：本地没有该目标 context；明确未发送。
- `context_stale`：iLink 返回 `ret=-2`；明确未接受。
- `auth_stale`：`ret=-14` 或账户已标记 stale；需要重新扫码绑定。
- `rejected`：其他非零 `ret/errcode`；明确未接受，但原因未归类。
- `unknown`：网络异常或 15 秒超时；是否接受未知，禁止自动重试。
- `unavailable`：账户/目标变化或本地状态不可用；请求未发出。

结果可携带数值 `providerRet` / `providerErrcode`。不得把 token、完整 iLink `errmsg` 或 message ID 暴露到公共页面。

当前文本分段逻辑对明确拒绝会做一次同 client ID 重试。实验以“逻辑探针”计数，并单独记录 `retriedSegments`；结论不把 API 重试次数伪装成逻辑探针次数。

## 实验持久状态

文件：私有状态目录下 `context-token-expiry-experiment.json`，权限 `0600`。

```ts
type ExperimentStatus =
  | "inactive"
  | "scheduled"
  | "probing"
  | "expired"
  | "valid_through_cutoff"
  | "invalidated_by_inbound"
  | "auth_stale"
  | "rejected"
  | "unknown"
  | "unavailable";
```

记录：版本、账户/目标、本轮基准时间、首测/截止/下次时间、逻辑探针次数、最后一次结果、首次失败时间、终态原因、更新时间。探针历史最多保留 32 条；不记录 token 和微信正文。

## 调度状态机

1. `activate` 验证当前 snapshot 中存在唯一匹配账户/目标，且 `contextUpdatedAt` 等于指定基准。
2. 保存 `scheduled`，首测为基准 + 23h，截止为基准 + 48h；启动 `caffeinate` 到截止。
3. 进程启动或唤醒：
   - 未到下次时间则设单个 timer。
   - 已迟到则只执行当前应执行的一次，不补发多个历史探针；记录实际尝试时间。
4. 每次探针前重新读取 snapshot：
   - context 时间变化：`invalidated_by_inbound`，停止。
   - 账户/目标不存在：`unavailable`，停止。
   通道 snapshot 变化时也立即执行同一检查，因此新的同目标入站不会等到下一小时才终止实验。Fixture 通道与真实通道都必须支持多个并存订阅者。
5. 发送一条短消息，格式包含实际 `T+Nh` 和第 N 次探针。
6. `ok=true`：记录 accepted；若已到 T+48h 则 `valid_through_cutoff`，否则下次时间按基准整点加一小时。
7. `context_stale`：`expired`，记录首次失败实际经过毫秒和探针序号，停止。
8. 其他失败进入对应终态并停止；`unknown` 不重试，避免重复。
9. 任何终态都停止 timer 和 `caffeinate`，但保留持久结果供页面查看。

## 日报失败修复

- 自动日报/预览发送成功时构造一个不带旧 `error`、失败分类和补发状态的新 run，解决“已接受但仍显示旧错误”。
- `context_missing` / `context_stale` -> `context_refresh_required`; retain content and wait for fresh same-target inbound. Another context failure stops the drain but remains recoverable on a later inbound.
- `auth_stale` -> `auth_relogin_required`; rebind the original account, then send a fresh message from the original recipient. With usable credentials, cached reports resume oldest first.
- `rejected` / `unavailable` -> `rejected`，展示数值错误码，不自动补发。
- `unknown` -> `unknown`，明确禁止自动重试。
- Legacy `pending_inbound` remains eligible under the same ordered recovery rules; the experimental probe schedule itself is unchanged.

## 本地通知与页面

- 页面“微信连接”增加“Context token 时效实验”卡片，显示：状态、基准、已过时长、下次探针、已接受/已尝试次数、终态错误码和精度提示。
- “每日新闻”Tab 在最近发送需要刷新 context、重新绑定或结果未知时显示醒目标记；全局页头显示简短警告。
- LaunchAgent 模式下，日报发送进入需刷新/重新绑定/明确拒绝/未知，以及实验进入终态时，调用 macOS 本地通知。通知不包含账号 ID、目标 ID、token 或正文。
- 如果“日报研究失败通知”本身因 context 失效或其他发送问题未送出，同样在全局页面与 macOS 通知中提示，避免主 run 的 `failed` 状态掩盖通知发送失败。

## 失败模式

- 服务重启：从持久状态恢复；若 context 未变，继续最近一个应执行探针；不突发补齐遗漏小时。
- 系统睡眠：实际尝试时间可能晚于计划，页面同时显示计划与实际时间，不伪造精度。
- 合盖：`caffeinate -i` 不能保证继续运行；页面明确说明。
- 同目标新入站：实验终止，不能继续测新 context。
- 其他目标入站：不影响本轮实验。
- 同一探针超时：结果 `unknown`，立即终止，不自动重发。
- 服务在发送中被杀：恢复后标记 `unknown`，不自动重发该探针。
- `caffeinate` 启动失败：实验仍运行，但公共状态标记保活不可用，不能声称已防睡眠。

## 验证

- 单测：发送分类、日报状态/补发门禁/旧 error 清理、实验 T+23/T+48 调度、迟到恢复、新入站失效、各终态、崩溃恢复、wake lock 生命周期、无 secret 公共状态。
- typecheck、lint、全量单测。
- fixture 浏览器 E2E：实验卡和日报警告可见、状态文本正确；fixture 不发送真实微信。
- 多订阅回归：新增实验 snapshot 监听不得覆盖页面的 snapshot 监听；别名、目标健康状态仍需实时刷新。
- 真实环境：安装后只确认 LaunchAgent、持久实验状态和 `caffeinate` 运行；第一条真实探针必须等到 T+23h。
