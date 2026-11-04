# 微信回复阶段耗时设计

## 目标

在“聊天记录”页为每个已启用目标展示最近一次微信消息处理的可持久化阶段时间线，使用户能区分入站观察、本地排队、正在输入、Codex 生成、关闭输入状态、出站发送和整体耗时。

## 边界

- 只记录本机可观测时间，不把手机点击发送到腾讯平台产出 `getupdates` 消息的时间伪装成本地耗时。
- 不记录消息正文、token、原始工具参数或新的账户秘密。
- 工具执行仍由既有 `recentSteps` 展示；工具步骤嵌套在 Codex 生成阶段，不重复计入总耗时。
- 记忆整理在回复被渠道接受后异步排队，不属于用户等待回复的关键路径，不纳入本时间线。
- 每个账户与目标沿用现有最近一次运行记录，不增加无限历史。

## 用户可见阶段

| 阶段 | 起点 | 终点 | 说明 |
| --- | --- | --- | --- |
| 入站接收 | 本机观察到 iLink `getupdates` 消息 | 运行记录建立 | 不使用可能存在时钟偏差的腾讯 `create_time_ms` 计算耗时 |
| 本地排队 | 运行记录建立 | 当前目标开始处理 | 同一目标串行；无等待时通常接近 0 |
| 启动正在输入 | 调用 typing 启动 | typing 可用或确认不可用 | 可能包含 `getconfig` 和 `sendtyping` |
| 发送处理回执 | typing 不可用后开始发送固定回执 | 渠道返回 | 与“启动正在输入”二选一 |
| Codex 生成 | 调用 App Server `turn/start` 前 | turn 完成或失败 | 包含模型判断和该 turn 的工具执行 |
| 关闭正在输入 | Codex 完成后停止 typing | 停止请求返回 | 仅 typing 成功时存在 |
| 发送最终回复 | 调用 iLink 发送正文 | 渠道接受、拒绝或结果未知 | 渠道接受不等于手机端已经显示 |

页面另外展示从“本机观察到入站”到“运行结束”的总耗时。进行中的阶段显示“进行中”，失败和进程恢复中断保留已完成区间，并把尚未闭合的区间标为“已中断”。

## 深模块与接口

继续使用 `WeixinCodexService` 的运行记录作为唯一外部 seam，不给页面暴露新的控制方法。

`TargetRuntimeRun` 增加有界 `timings`：

```ts
type TargetRunTiming = {
  stage: "inbound" | "queue" | "typing_start" | "acknowledgement" |
    "agent" | "typing_stop" | "outbound";
  startedAt: number;
  completedAt?: number;
  outcome?: "completed" | "failed" | "unknown" | "unavailable" | "interrupted";
};
```

宿主内部通过两个私有操作开始/结束阶段；调用者仍只使用现有微信事件和 `getPublicState()`。页面根据 `startedAt/completedAt` 计算显示值，不在服务端冗余持久化可推导的 duration。

当前状态只保留每个目标最近一次运行。为了不把后一条消息的排队起点覆盖进前一条运行，宿主在进程内按 `runId` 暂存尚未开始处理的 `observedAt/queuedAt`；轮到该消息执行时才用该起点替换目标的最近运行记录。已经开始的运行仍立即持久化。进程退出时尚未开始的内存队列本来就无法继续执行，因此不额外伪造恢复记录。

`InboundTextEvent` 增加本机 `observedAt`。真实 iLink adapter 在解析 `getupdates` 时赋值为 `Date.now()`；旧 adapter 或测试未提供时，聊天模块回退到当前时间。腾讯的 `receivedAt/create_time_ms` 继续只用于消息事件时间展示。

## 持久化与迁移

- `CodexServiceState.version` 从 4 升到 5。
- v1-v4 加载时迁移为 v5；旧运行记录的 `timings` 为空，不反推历史阶段。
- 每条运行最多 12 个时间区间；时间必须为安全正整数，完成时间不得早于开始时间。
- 进程启动时，遗留的活动运行标为 `interrupted`，同时闭合最后一个未完成区间。

## 真实操作序列与失败模式

1. **入站后立即处理**：入站、排队、typing/回执、Codex、出站依次闭合，总耗时正确。
2. **同目标已有任务**：新消息进入排队；开始处理时闭合排队阶段。
3. **typing 不可用**：`typing_start` 记为 `unavailable`，随后记录固定回执发送；不把二者混成同一阶段。
4. **Codex 失败**：`agent` 记为 `failed`，随后记录固定失败提示的出站耗时，运行最终为 `failed`。
5. **出站拒绝或未知**：明确拒绝记为 `failed`，无法判断渠道是否接受时记为 `unknown`；两者都不自动重发，总耗时仍闭合。
6. **停止 typing 失败**：停止区间仍闭合但记为 `unknown`，不把吞掉的渠道异常伪装成完成；最终回复仍继续发送。
7. **进程在任意活动阶段退出**：恢复时最后一个开放阶段标为 `interrupted`，运行也标为 `interrupted`。
8. **旧状态文件**：可正常加载，时间线显示“旧记录无分段耗时”。
9. **平台时钟偏差**：不参与阶段 duration；页面只展示本机单调顺序产生的时间戳。
10. **`/echo` 直通命令**：记录入站、排队和真实出站区间；没有经过的 typing/Codex 阶段不显示。

## 设计 review

- **排队覆盖风险**：拒绝直接复用目标当前 `runtimeRun.startedAt` 作为下一条消息起点；使用 `runId` 暂存可保持当前小接口和最近运行语义。
- **重叠计时风险**：工具步骤属于 Codex turn 内部，不再作为独立 duration 相加；总耗时只使用本机观察点和最终完成点。
- **时钟风险**：阶段顺序全部使用同一个宿主 `now()`；腾讯源时间只保留为聊天事件时间。解析时拒绝 `completedAt < startedAt`。
- **失败遗漏风险**：每个被计时的外部边界在 await 前开始阶段，在成功、显式失败和 catch 三条路径都闭合；启动恢复只负责闭合已经持久化的开放阶段。typing 停止失败保留为 `unknown`，Codex 阶段在工具进度转发排空后才闭合。
- **展示误导风险**：页面用“渠道接受”而非“微信已收到”，并对旧记录显示无分段数据。

## 验证

- 高层测试 seam：`WeixinCodexService.getPublicState().runs`。
- 纵切测试用可控时钟驱动一次真实服务内的入站流程，断言各阶段顺序、耗时和成功/失败状态。
- 存储测试覆盖 v4 迁移、v5 round-trip、非法逆序时间拒绝和启动恢复闭合。
- 页面 E2E 覆盖阶段标签、持续时间、总耗时、旧记录空状态和固定 Tab 交互。
- 完整验证顺序：lint、typecheck、单元/集成测试、Playwright 本地 E2E。
