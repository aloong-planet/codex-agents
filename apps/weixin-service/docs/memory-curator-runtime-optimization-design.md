# Memory Curator 专用运行时优化设计

> 状态说明（2026-08-17）：本文记录上一阶段的动态工具实现与实测基线。当前主路径已由 [`memory-curator-single-pass-design.md`](./memory-curator-single-pass-design.md) 取代：不再发送完整 `MEMORY.md`，也不再执行第二次动态工具回合；模型通过 `outputSchema` 返回一次结构化决策，宿主复用同一可信提交实现落盘。下文涉及 tool-only turn、完整 `memoryMarkdown` 和仅认动态 tool receipt 的描述只作为历史基线。

## 目标

把账户记忆判断从通用 Codex 开发任务收窄为专用、低延迟的后台任务，减少与记忆无关的开发指令、skills 和 workspace 上下文，同时保持现有可信工具写入、安全校验和账户隔离不变。

基线实测的一次 no-op 整理耗时 14,108 ms，累计输入 45,773 tokens；其中 App Server / 模型阶段约占 97%，两次模型调用分别携带约 22.8k 输入。Curator 自己的动态任务提示约 1.9k 字符，主要冗余来自通用 Codex 运行指令和环境上下文。

## 已确认边界

- 只优化 Memory Curator；普通微信聊天继续使用现有模型、工作区、skills、plugins 和权限。
- Curator 仍由独立 App Server conversation 执行，每个 job 新建 thread，不跨账户复用历史。
- Curator 只返回结构化决策；模型不能选择 accountId、target、路径或真实记忆 ID，宿主随后调用可信提交模块。
- `AccountMemoryToolHost`、revision/CAS、证据白名单、敏感信息过滤、原子写和重试状态机保持安全权威。
- 不以模型文本本身表示成功；只有宿主可信提交模块返回的 receipt 能表示提交成功。
- App Server 的平台安全消息可能仍会存在；本设计只替换可配置的 base instructions，并把动态输入收窄，不能承诺“零系统上下文”。

## 方案

### 1. 专用运行档

在 `CodexConversationOptions` 增加一个不可变的 `runtimeProfile`：

```ts
type CodexRuntimeProfile = {
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  baseInstructions: string;
  developerInstructions?: string;
};
```

`thread/start` 负责发送 `model` 和 `baseInstructions`；`turn/start` 负责发送 `model` 与 `effort`。普通 conversation 未提供 profile 时不增加这些字段，保持当前行为。

实测确认 `developerInstructions` 无论传空字符串还是非空最小文本都不会替换 App Server 自带的核心开发说明：空字符串按未设置处理，非空文本只会追加。因此正式实现不发送该字段，不把“追加一条不要遵循开发流程”误当成已经删除开发上下文。

Curator 使用：

- model: `gpt-5.6-terra`
- reasoning effort: `low`
- web search: `disabled`
- workspace roots: `[]`
- permission profile: `:read-only`
- dynamic tools: 不注册；当前 turn 使用 `outputSchema`

Curator 子进程还会通过 App Server 稳定 feature flags 关闭与该任务无关的能力：plugins、skill search、apps、浏览器、computer use、图片生成、宿主 memory、多 agent、goals、hooks、workspace dependencies、tool suggestion、shell tool 和 unified exec。普通微信聊天继续使用默认 App Server 子进程，不受这些 flags 影响。

选择 Terra/low 是因为任务是严格 schema 下的分类、归纳和一次工具决策，不需要 Sol 的高强度编码推理。模型配置若被 App Server 拒绝，任务按现有失败/重试路径处理，不静默回退到主聊天运行档。

### 2. 静态规则与动态数据分离

把以下稳定规则从每个 user prompt 移入专用 `baseInstructions`：

- Curator 身份、允许和禁止保存的类别；
- 不可信对话边界；
- remember / revise / record_event 选择规则；
- evidence 和日期约束；
- 必须只返回一次结构化 envelope、no-op 使用空 decisions。

每个 turn 的 user input 只保留版本化 JSON：

```json
{
  "schemaVersion": 1,
  "mutationPolicy": {},
  "batchId": "...",
  "basedOnRevision": 0,
  "entryLocalDates": {},
  "candidateEntries": [],
  "turns": []
}
```

JSON 中的记忆和对话继续视为不可信数据。固定规则不再随每个 job 重复进入 user message，也避免通用开发任务语言干扰判断。

### 3. 兼容性与失败模式

- **普通会话回归**：没有 runtimeProfile 时，`thread/start` / `turn/start` payload 与现状一致。
- **无文本回复或非法 JSON**：Curator 拒绝提交并进入现有有限重试；可信 receipt 仍是唯一完成依据。
- **模型或 effort 不支持**：App Server 返回错误，job 进入现有脱敏失败与有限重试；不改 MEMORY.md。
- **被关闭的 feature 在后续 Codex 版本改名或移除**：子进程启动失败并进入同一可见重试路径；不静默启动一个权限更宽、上下文更大的 Curator。
- **base instructions 未完全覆盖宿主上下文**：通过真实无写入探针读取 rollout 的角色/字符/token 统计验证；不把本地单测当作 token 优化已生效的证据。
- **prompt injection**：对话数据仅出现在 JSON payload，base instructions 明确其不可信；最终写入仍由宿主确定性校验。
- **跨账户污染**：继续每 job 新 thread，完成后 release；不为 cache 命中改成长生命周期共享 thread。

## 验收

1. 单测证明专用 profile 只进入配置过的 conversation，普通 conversation 不新增模型/指令字段。
2. 单测证明 Curator 的动态 prompt 不再重复固定规则，而是 schema v1 JSON，并仍包含策略、revision、日期、MEMORY.md 和 turns。
3. Curator 现有 add/update/event/noop/clarification 测试全绿。
4. typecheck、lint、全量单测通过。
5. 运行一个隔离、无真实账户写入、无微信发送的真实 App Server no-op 探针；记录模型、effort、总耗时和输入 token。目标是显著低于 45,773 输入 tokens / 14,108 ms 基线；若仍有固定上下文，必须报告来源，不能宣称已完全移除。

## 实测结果

正式代码路径的隔离 no-op 探针：

- `gpt-5.6-terra`，reasoning effort `low`；
- 结果 `noop`，未写真实账户记忆，未发送微信；
- 7,228 ms；
- 20,637 input tokens，其中第二次工具回合命中 9,984 cached input tokens；
- 动态 Curator user payload 343 字符；
- 剩余固定内容约为 12.8k 字符核心 developer、2.2k 字符权限/项目规则、304 字符附加规则，以及约 3.9k 字符宿主 user 环境上下文。

相对原基线，耗时下降约 48.8%，输入 token 下降约 54.9%。App Server 固定注入仍存在，因此本次交付是“显著削减”，不是“彻底删除”。

## 分支基线说明

仓库 `master` 仅含初始化提交，当前服务功能位于其上的 16 个线性提交，且仓库未配置远端。为避免从 `master` 丢失现有微信、日报、媒体与记忆功能，本改动从当前最新可运行提交 `bc027b6` 建立独立分支。无远端时无法完成 push/PR/squash merge，交付以本地分支和 commit 为准。
