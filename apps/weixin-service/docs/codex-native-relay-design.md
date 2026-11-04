# 微信纯转发 + Codex 原生执行改造设计

日期：2026-08-13

## 目标

将微信互动链路从“Codex 决策、Demo 动态工具执行 Vault 操作”改为“Demo 只转发，独立
Codex App Server task 使用原生文件、命令、Skills、MCP 和网页搜索能力执行操作”。

用户已确认的范围：

- Codex 可操作 `/Users/loong_zhou/git/aloong-planet/codex-plugins/codex-weixin/apps/weixin-service` 与
  `/Users/loong_zhou/Documents/demo/demo` 两个根目录。
- 每个 `(accountId, target)` 使用独立持久 Codex thread；同目标串行，不同目标完全并行。
- 用户明确要求创建或修改时直接执行，不再重复确认。
- 删除、批量移动等破坏性操作第一版在行为规则中拒绝；权限模型不能硬拆分删除，因此以
  写前快照、操作 diff 和可恢复机制兜底，不宣称系统层禁止删除。
- 4317 独立后台继续持有唯一 iLink 监听和 App Server；Codex Plugin 只提供内嵌面板和控制入口。
- 每日新闻抓取、归档、幂等调度和发送保持现状；微信中的查询由 Codex 直接读取归档。
- 创建干净的新 thread，不恢复带旧动态工具契约的 thread。
- 允许 Codex 内置网页搜索；shell 网络保持关闭。
- 微信先发送一次“已收到，正在处理”，完成后再发送最终结果。

## 已确认事实

1. 当前 `WeixinCodexService` 已将入站正文提交给独立 App Server thread，但所有目标共享一个
   `threadId`，所有 turn 通过一个全局 promise 队列串行。
2. 当前 `CodexConversation` 只允许一个 active turn，并将命令、文件、权限请求统一拒绝；只有
   `VaultDynamicToolHost` 的动态调用会执行。
3. 当前交互 Vault 写入由 `DirectMarkdownVault` 完成；`DirectMarkdownVault` 同时也是
   `NewsArchive` 的归档底座，因此不能随交互工具一起删除。
4. 已安装 App Server 的 2026-08-13 experimental schema 支持：
   - `thread/start.runtimeWorkspaceRoots`；
   - `turn/start.sandboxPolicy.workspaceWrite.writableRoots` 与 `networkAccess`；
   - named `permissions` profile 和 `item/permissions/requestApproval`；
   - thread config 的 `web_search = disabled|cached|indexed|live`。
5. 官方权限文档明确：filesystem `write` 同时允许创建、修改、重命名和删除。提示词不能充当
   删除硬门禁。
6. iLink 每条入站携带的 `context_token` 已封装在 `replyText` 闭包中；源码允许多次调用该闭包，
   但腾讯未公开保证同一 token 连续发送两条消息，因此 ack + final 必须经过用户在场的真实验证。

## 非目标

- 不恢复或接管当前桌面 Codex task。
- 不把 iLink token、二维码 URL、完整账号 ID、绝对 Vault 路径或 App Server 原始协议暴露给网页。
- 不修改 OpenClaw 配置、凭据或腾讯插件源码。
- 不把新闻调度迁移到交互 thread。
- 不在本改造中安装 LaunchAgent 或改变 Plugin 的发布方式。
- 不承诺 exactly-once、手机必达或删除硬隔离。

## 架构与 seam

```text
Tencent iLink
    |
    v
DirectIlinkChannel       唯一监听、token 捕获、发送
    |
    v
WeixinCodexRelay         鉴权、去重、任务状态、ack/final
    |
    v
CodexTaskRouter          target -> thread；同目标串行、跨目标并行
    |
    v
CodexAppServerHost       单一进程/连接，多 thread、多 active turn
    |
    +--> Codex 原生文件与命令能力 --> workspace + demo Vault
    +--> Codex 内置 web search

TurnSnapshotStore        写权限前快照、diff、受控恢复
DailyAiNewsScheduler     保持原链路，不进入 CodexTaskRouter
Plugin MCP/Panel         只调用 4317 的脱敏状态与控制接口
```

### `CodexTaskRouter` 深模块

外部 interface 保持小：

```ts
interface CodexTaskRouter {
  start(): Promise<void>;
  enqueue(input: TargetTurn): Promise<TurnOutcome>;
  close(): void;
}
```

caller 只提供目标键、微信正文和安全回复句柄。模块 implementation 隐藏：App Server 生命周期、
thread 创建/恢复、每目标队列、跨目标并行、权限请求、流式聚合、超时和异常退出。

### `CodexAppServerHost` 内部 seam

- 一个 stdio App Server 子进程与一个 JSON-RPC connection。
- pending request 仍按 request ID 路由；active turn 从单值升级为
  `Map<threadId, ActiveTurn>`，所有事件必须同时匹配 thread ID 与 turn ID。
- 每目标只允许一个 active turn；不同 thread 不经过全局队列。
- App Server 退出时一次性失败所有 active turn，不自动重跑 Codex。
- 新目标第一次执行时创建干净 thread；已有新 profile thread 才允许 resume。

## 本地执行权限

### 默认读阶段

- thread cwd 为 `/Users/loong_zhou/git/aloong-planet/codex-plugins/codex-weixin/apps/weixin-service`。
- runtime workspace roots 固定为 workspace 与 demo Vault，网页和微信不能覆盖。
- 每个 turn 默认采用只读权限；shell network 为 false。
- App Server 启用 `request_permissions`，但 relay 只处理 filesystem write 请求。
- thread config 将 Codex 内置 `web_search` 设为 `live`；这不向 shell 开放任意网络。

### 写权限升级

当 Codex 因当前用户指令请求写权限时：

1. 校验请求只包含两个固定根目录，不包含 network 或其他路径。
2. `TurnSnapshotStore` 成功建立写前快照；失败则拒绝权限，本 turn 继续只读或诚实失败。
3. 仅对当前 turn 授予两个根目录写权限，不授予 session 级权限。
4. turn 完成后计算 changed-path diff，并撤销 turn 权限。
5. 用户回复只描述真实结果和相对路径；不能把权限请求包装成已完成。

用户明确写指令本身就是产品层授权，因此 relay 不再做中文动词正则，也不发第二次写确认。

### 敏感与生成目录

实现使用进程级临时 config overlay 定义专用权限 profile，不写入全局 Codex config。profile 必须：

- 两个固定根目录之外不授予写权限；
- 拒绝 `.git`、`.obsidian`、`.env*`、凭据文件和 Demo 私有状态目录；
- 对 `node_modules`、构建产物和测试产物保持只读或拒绝，避免快照规模失控；
- 不开放 shell network、localhost 或 Unix socket。

## 删除约束与可恢复快照

用户选择保留 Codex 原生执行，因此以下是恢复机制，不是删除硬门禁：

- developer instruction 明确禁止删除、批量移动、覆盖冲突和修改隐藏/敏感路径。
- 写权限授予前，对所有可写路径建立私有 copy-on-write 快照；不跟随符号链接。
- 快照目录位于 Demo 私有状态目录，0700/0600，且不属于 Codex 可读写 roots。
- 每个快照保存 target hash、turn ID、创建时间、写前 manifest、写后 manifest 和相对路径 diff；
  网页只显示数量、时间和路径摘要，不显示文件正文。
- 默认保留每目标最近 20 个或 7 天，以先到者为准；清理由安全模块按明确私有目录执行。
- “恢复”只能从本地面板显式发起；恢复前要求当前文件仍匹配该 turn 的写后 hash，否则拒绝，
  防止覆盖用户在 Obsidian 或编辑器中的后续修改。
- 快照、manifest 或 diff 失败时不允许写；不能降级为无保护写入。

## 状态与持久化

`codex-service.json` 升级为新版本，核心状态变为：

```ts
type TargetSession = {
  accountId: string;
  target: string;
  threadId?: string;
  threadProfile: "native-relay-v1";
  queue: PersistedJob[];
};
```

- 旧 `threadId` 不迁移；旧 transcript 保留只读展示。
- `vaultWriteEnabled` 不自动升级为更广的本地执行授权。首次升级将新的
  `localExecutionEnabled` 设为 false，要求用户在网页明确重新启用“workspace + demo Vault”。
- job 在发送 ack 前原子落盘，状态为：

```text
received -> queued -> ack_sending -> ack_accepted|ack_unknown
                     -> running -> final_sending -> completed|final_unknown|agent_failed
```

- processed key 仍在执行前落盘，维持 at-most-once；崩溃后不自动重跑 Codex 或重新发送。

## 用户真实操作序列

### 重新启用

1. 页面显示新执行范围与“未启用”。
2. 用户选择已发现微信目标并启用自动回复。
3. 用户单独启用本地 Codex 执行；系统创建该目标的干净 thread。
4. 创建失败时页面显示错误，不向微信假称可用。

### 只读查询

1. 用户从已启用目标发送“列出 Vault 文档”等自然语言。
2. relay 原子保存 job，使用该入站 token 发送 ack。
3. Codex 在只读 turn 中自行列目录、检索或读取。
4. 最终回复使用同一入站捕获的 reply closure 发送；两次发送都分别记录 accepted/unknown。

### 创建或修改

1. 用户明确要求创建或修改文件。
2. Codex 请求当前 turn 的写权限。
3. relay 建立快照后授予固定 roots 写权限。
4. Codex 原生完成操作并验证结果；relay 记录 diff。
5. 最终微信回复说明真实相对路径和验证结果。

### 删除或移动请求

1. developer instruction 要求 Codex拒绝并解释第一版限制。
2. 若 Codex 仍实施删除，快照保留恢复能力并在 diff 中标红；系统不得声称“硬拦截”。
3. 用户可在本地面板查看并显式恢复；存在写后冲突时拒绝恢复并要求人工处理。

## 失败模式

- **ack 失败/未知**：继续处理一次，最终回复仍尝试一次；不重发 ack。
- **ack 成功、final 失败/未知**：结果保存在本地 transcript，不能自动补发；下一条入站可让
  Codex解释上次状态，但不得冒充已送达。
- **同一 token 第二次发送被腾讯拒绝**：真实验证门禁失败，功能不能交付为 ack + final；报告
  事实并由用户重新选择 final-only 或其他渠道，不静默降级。
- **同目标连续消息**：严格 FIFO，每条保留自己的 context token；后一条不能替换前一条。
- **不同目标并发**：各自 thread 并行；事件按 threadId + turnId 隔离。CPU 可能升高，页面显示
  active turn 数量，不偷偷加入全局限流。
- **App Server 退出**：所有运行 job 标 agent_failed；未运行队列保留但不自动执行，等待用户新动作。
- **权限越界或请求 shell network**：拒绝该请求，turn 可继续解释限制。
- **快照超预算/失败**：拒绝写权限，不执行无保护写入。
- **用户同时编辑文件**：diff 只报告事实；恢复前 hash 冲突则拒绝覆盖。
- **旧 thread 恢复**：profile 不匹配时创建新 thread，不向旧 thread 注入消息。
- **新闻调度同时写 Vault**：新闻归档保持现有串行逻辑；交互写与新闻写发生路径冲突时以
  revision/hash 冲突失败，不盲覆盖。

## 实施纵切与验证门禁

### 纵切 1：多目标原生只读聊天

- 新建 `CodexTaskRouter`/多 thread host；状态迁移到 target-thread map。
- 移除交互 thread 的 dynamic Vault tools 和旧 Vault prompt。
- 证明同目标串行、不同目标真正并行，事件不串线。
- fixture E2E 验证“列出 Vault 文档”由 Codex 原生能力完成。

### 纵切 2：写权限与快照

- 实现 turn-scoped permission request handler 和 `TurnSnapshotStore`。
- 创建/修改走 Codex 原生操作；越界、network、快照失败均 fail closed。
- 实现 diff 展示与冲突安全恢复。

### 纵切 3：ack + final

- job/ transcript 支持两阶段发送状态。
- 单测所有 ack/final 成败组合，不自动重试。
- fixture 验证两次调用使用同一入站捕获 closure，而不是读取最新 token。

### 纵切 4：Plugin 面板与兼容收口

- 面板显示每目标 thread 状态、队列、active turns、执行范围、快照和恢复结果。
- 保持二维码、扫码、目标同步、新闻调度和测试发送路径不回归。
- 删除仅由本次迁移造成的旧动态工具 orphan；保留新闻归档所需的 Vault 模块。

### 自动验证

每个纵切 test-first，完成后跑 typecheck 与相关测试；整体运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

新增覆盖：多 thread 并行、同目标 FIFO、权限请求范围、快照失败、恢复冲突、旧状态迁移、
ack/final 组合、App Server crash、动态工具确实未注册、shell network false、web search 配置。

### 用户在场的真实验证

自动测试不得连接真实微信、写真实 Vault 或发送消息。最终只在用户在场时依次验证：

1. 微信发送只读列目录指令，确认 ack 和最终回复均收到。
2. 微信明确创建一个约定测试 Markdown，确认真实文件、diff、快照和最终回复。
3. 本地修改该文件后验证旧快照恢复因 hash 冲突而拒绝。
4. 两个已授权目标同时发消息，确认真正并行且回复不串线；若只有一个真实目标，则该项只做
   fixture 并明确标注未完成真实双目标验证。

## 分支与交付

- 实现开始前先处理当前已有 feature branch 与脏工作树，不 reset、覆盖或提交用户改动。
- 以包含现有 Plugin 成果的最新可合并基线创建新的 `codex/` feature branch。
- 七步流程完成后 push、PR、默认 squash merge；真实微信验证未完成前不声称完整交付。

## 实现回同步（2026-08-13）

- 持久化状态升级为 v2，使用 `(accountId,target) -> native-relay-v2 threadId`；v1 单 thread
  不复用，且旧 `vaultWriteEnabled` 不升级为新的两目录写权限。
- 现场发现开发期旧进程已创建过 `native-relay-v1` task；最终迁移会丢弃该中间 profile，强制
  创建干净的 v2 task，避免恢复旧动态工具上下文。
- 一个 `CodexConversation` 复用一个 App Server transport，并按 thread 独立聚合 active turn；relay
  按目标维护 promise queue，因此同目标 FIFO、不同目标并行。
- `NativeWriteGuard` 仅响应 `item/permissions/requestApproval`，拒绝网络、glob/special path 和固定
  roots 外写入；成功快照后只返回 turn scope 权限。
- `TurnSnapshotStore` 位于私有状态目录，排除依赖/构建目录，拒绝符号链接和超预算快照；记录
  before/after manifest 与 created/modified/deleted diff，恢复时要求当前内容仍等于操作后 hash。
- 交互路径不再向 App Server 注册 Vault dynamic tools；日报仍复用 `DirectMarkdownVault` 与
  `NewsArchive` 归档实现。
- ack 与 final 分别持久化为 `ack_accepted|ack_unknown` 和 `accepted|send_failed`，均只尝试一次。
- App Server 单次协议请求仍使用 120 秒超时；包含搜索、工具或多步检查的完整 turn 使用独立
  24 小时预算。现场曾出现 Codex 在 132 秒完成、relay 在 120 秒提前失败的假失败，因此两种
  超时不能再共用一个常量。超时后仍不自动重放，以免重复外部副作用。
