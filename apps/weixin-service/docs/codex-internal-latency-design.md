# Codex 内部分段耗时设计

## 目标

在既有微信回复时间线中，把“Codex 总计”展开为可验证的 App Server 与 turn 内部阶段，使用户能定位长耗时来自任务接受、首次模型活动、某个工具、工具结果交回模型后的等待，还是最终文本生成。

## 已确认的协议事实

- 官方 App Server 文档将 `turn/start` 作为 turn 起点，随后流式发送 `turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta` 与 `turn/completed`。
- 本机当前 Codex 生成的 v2 schema包含上述通知；`ThreadItem` 具有 reasoning、agentMessage、commandExecution、fileChange、mcpToolCall、dynamicToolCall、collabToolCall、webSearch、imageView、contextCompaction 等类型。
- App Server 不暴露“模型在内部做出决定”的时刻。实现只能把首次可见 reasoning、工具或 agent message 事件称为“首次模型事件”，不能称为精确决策耗时。
- 工具参数、命令、路径、输出、推理文本和回复 delta 都不进入耗时存储；只保留已有安全工具标签、状态和时间。

## 用户可见结构

外层时间线保持不变，“Codex 总计”继续代表从调用 Codex 到 turn 完成以及工具进度转发排空的总耗时。其下嵌套以下子阶段：

| 子阶段 | 起点 | 终点 | 语义 |
| --- | --- | --- | --- |
| App Server 接受任务 | 发送 `turn/start` 前 | 收到 `turn/started`、`turn/start` 响应或更早的首个 turn 事件 | 每 turn 的接受耗时，不伪装成常驻进程冷启动 |
| 首次模型事件等待 | App Server 接受任务 | 首个 reasoning、工具或 agent message 活动 | 只表示第一个可观测模型事件 |
| 模型推理 | reasoning `item/started` | 同一 reasoning item 的 `item/completed` | 每段可见 reasoning 生命周期分别记录，不保存推理正文 |
| 工具：安全标签 | 工具 `item/started` | 同一 item 的 `item/completed` | 每个工具分别记录；支持并行与相同类型的多个工具 |
| 工具结果处理等待 | 最后一项并行工具完成 | 下一次 reasoning、工具选择、agent message 或 turn 完成 | 表示结果已回到 App Server 后等待模型继续，不声称是纯网络回传 |
| 最终回复生成 | 首个 `item/agentMessage/delta` | `turn/completed` | 包含文本流式生成与 turn 收尾 |

子阶段与“Codex 总计”是父子关系，页面不把两者相加。没有经过的子阶段不显示。

## 深模块与接口

外部 seam 仍是 `WeixinCodexService.getPublicState().runs`；页面不新增控制方法。

`CodexConversation` 的既有 observer 扩展为无正文的 turn 事件联合类型：

```ts
type CodexTurnEvent =
  | { kind: "turn_submitted" }
  | { kind: "turn_accepted" }
  | { kind: "model_activity"; activity: "reasoning" | "tool" | "agent_message" }
  | { kind: "reasoning"; itemId: string; phase: "start" | "end" }
  | { kind: "tool"; itemId: string; label: SafeToolLabel; phase: "start" | "end"; status?: ToolStatus }
  | { kind: "agent_message_delta" }
  | { kind: "turn_completed"; status: "completed" | "failed" | "interrupted" | "unknown" };
```

observer 是 best-effort telemetry；异常不得打断 turn。`WeixinCodexService` 隐藏事件配对、并行工具计数、哈希关联、开放区间闭合和持久化细节。微信进度消息仍只消费 `kind: "tool"`。

状态版本从 v5 升到 v6。`TargetRuntimeRun` 增加独立、最多 50 条的 `agentTimings`，避免扩大外层固定阶段的 12 条上限：

```ts
type AgentRunTiming = {
  stage: "app_server_prepare" | "first_model_wait" | "model_reasoning" | "tool_execution" |
    "tool_result_wait" | "final_generation";
  startedAt: number;
  completedAt?: number;
  outcome?: "completed" | "failed" | "unknown" | "interrupted";
  label?: SafeToolLabel;
  correlationHash?: string; // 仅宿主匹配 item；不进入 public state
};
```

达到上限时不再新增子阶段，并将 `agentTimingsTruncated` 设为 true；外层核心时间线不受影响。v1-v5 加载时迁移为空数组，不反推历史数据。

## 状态进入与退出

1. `agent.reply` 开始后收到 `turn_submitted`：开启 App Server 接受任务。
2. `turn_accepted`：闭合接受任务，开启首次模型事件等待。若协议先发 item 再返回 `turn/start`，首个 turn 事件也会闭合接受任务，避免逆序时间。
3. 首个 model activity：闭合首次模型事件等待，只执行一次。
4. reasoning start/end：以 item ID 的 SHA-256 关联一段模型推理；start 同时闭合首次事件等待或工具结果等待。
5. tool start：以 item ID 的 SHA-256 作为内部关联键开启工具区间；若此前工具结果等待开放，先闭合等待。
6. tool end：只闭合同一关联键的工具；全部并行工具都结束后开启工具结果处理等待。
7. reasoning 或 agent message 活动：闭合工具结果处理等待。首个 agent message delta 开启最终回复生成。
8. turn completed：闭合所有仍开放的子阶段；成功、失败、中断分别落相应 outcome。若自定义 agent adapter 已返回 reply 却漏发终态事件，宿主在关闭外层 agent 总计前兜底闭合为 completed。
9. 请求异常、超时或进程退出但没有 `turn/completed`：外层 catch/恢复逻辑把开放子阶段闭合为 failed/interrupted。

## 真实操作序列与失败模式

1. **无工具直接回答**：接受任务 → 首次模型事件等待 → 最终回复生成。
2. **单工具**：接受任务 → 首次模型事件等待 → 模型推理 → 工具执行 → 工具结果处理等待 → 模型推理 → 最终回复生成。
3. **多轮工具**：每个工具独立记录，工具结果等待可出现多次。
4. **并行工具**：每个 item 独立配对；只有活动工具数降到零才开始结果等待。
5. **工具完成通知缺失**：turn 结束或失败时闭合为 unknown/failed，不留下永久“进行中”。
6. **通知乱序或重复**：同一阶段/关联键幂等；结束找不到开始时忽略，不伪造负耗时。
7. **turn/start 先后顺序变化**：以实际收到的第一个接受/turn 事件闭合准备区间，所有时间用同一宿主时钟并取非负值。
8. **turn 失败或超时**：已完成工具保留真实结果，所有开放子阶段按终态闭合。
9. **进程恢复**：v6 活动运行中的外层与子阶段统一标 interrupted。
10. **子阶段超过 50 条**：页面明确显示“部分内部阶段已省略”，不删除外层总耗时。
11. **旧记录**：仍显示外层历史时间；Codex 内部显示“旧记录暂无内部耗时”。

## 设计 review

- **避免伪精确**：不使用“模型决策完成”“工具网络回传”等协议无法证明的标签。
- **避免重复相加**：外层 agent 是总计，`agentTimings` 是嵌套明细，采用独立数组和缩进展示。
- **避免并行串错**：工具结束必须按 item hash 关联，不能使用“最后一个同类型开放区间”。
- **避免泄密**：observer 与持久化都没有参数、输出、正文或路径；public state省略 correlation hash。
- **保持深度**：调用者仍只传一个 observer、页面仍只读 runs；所有状态机留在 `CodexConversation` 与 `WeixinCodexService` 实现内部。

## 验证

- `CodexConversation` 测试：turn 提交/接受、首个模型事件、工具生命周期、首个 agent delta、turn 终态事件顺序与脱敏。
- `WeixinCodexService` 高层纵切：可控时钟驱动单工具、并行工具、漏终态兜底、恢复与截断；既有失败路径继续覆盖外层失败处理。
- store 测试：v5→v6 迁移、v6 round-trip、非法时间与非法 correlation hash 拒绝。
- 页面 Playwright E2E：父级 Codex 总计、嵌套子阶段、模型推理、工具耗时、工具结果等待和最终回复生成。
- 完整网关：lint → typecheck → 全量单元/集成测试 → 插件 E2E → 本地网页 Playwright E2E。
