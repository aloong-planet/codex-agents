# 主微信会话模型配置设计

更新时间：2026-08-21

## 目标

让主微信会话按微信账户选择模型与 reasoning effort，默认使用低延迟配置，同时不修改 Codex Desktop 全局配置，不影响 Memory Curator 和每日新闻研究。新模型应能通过 App Server 目录自动出现在固定模型列表中；未经验证的新模型不得静默接管自动档位。

## 已确认事实

- 当前主会话没有传 `model` 或 `effort`，因此继承 `~/.codex/config.toml`。
- `turn/start` 支持逐回合传入 `model` 与 `effort`；切换模型不要求删除或重建 thread。
- 本机 Codex `0.148.0-alpha.15` 的 `model/list` 为分页接口，返回：模型 ID、展示名、描述、隐藏状态、支持和默认 effort、输入模态、升级提示、service tier 与默认标志。
- `model/list` 没有稳定可靠的“快速/均衡/最强”分类字段；当前 `modelSpecialty` 为空，因此不能靠描述文本或名称猜测未来模型档位。
- 当前 Memory Curator 已独立固定为 `gpt-5.6-terra + low`，本功能不得改变它。

## 产品行为

### 配置作用域

- 按 `accountId` 保存，不按微信目标保存。
- 同一账户更换目标后沿用相同模型策略。
- 配置只作用于主微信聊天；Curator、日报研究和 Codex Desktop 均保持原配置。

### 选择模式

1. **自动快速（默认）**：使用宿主已验证的快速档位映射；第一版解析为 `gpt-5.6-luna + low`。
2. **自动均衡**：第一版解析为 `gpt-5.6-terra`，effort 由用户选择，默认 `medium`。
3. **自动最强**：第一版解析为 `gpt-5.6-sol`，effort 由用户选择，默认 `medium`。
4. **固定模型**：从实时目录选择具体模型与其支持的 effort。

自动档位使用版本化、受审查的宿主映射。目录中新出现的模型会立即出现在“固定模型”列表，但只有后续版本明确更新映射后，才可能成为自动档位的新解析结果。

### 生效规则

- 保存成功后，从下一条**新入站消息**生效。
- 入站进入队列时冻结 `{model, effort, configRevision}`；排队期间修改配置不会改变已排队回合。
- 每次 `turn/start` 都显式传冻结后的模型与 effort，避免依赖全局配置漂移。
- 模型切换不清空 thread；切换后的第一回合可能因跨模型缓存未命中而暂时更慢。

## 深模块与接口

新增深模块 `AccountChatModelSettings`，把目录刷新、配置校验、档位解析、迁移和公开状态集中在一个接口后面：

```ts
type ChatModelSelection =
  | { mode: "track"; track: "fast" | "balanced" | "quality"; effort: ReasoningEffort }
  | { mode: "pinned"; model: string; effort: ReasoningEffort };

type ResolvedChatModel = {
  model: string;
  effort: ReasoningEffort;
  configRevision: number;
  source: "track" | "pinned";
};

interface AccountChatModelSettings {
  configure(accountId: string, selection: ChatModelSelection): ConfigureResult;
  resolve(accountId: string): ResolvedChatModel | UnavailableModel;
  publicState(accountId?: string): PublicChatModelState;
  refreshCatalog(): Promise<CatalogRefreshResult>;
}
```

调用者只知道账户、用户选择和最终解析结果；分页、缓存、兼容性、升级提示与持久化版本隐藏在模块内部。

`CodexConversation` 增加一个只读目录方法，并让 `reply` 接受冻结的逐回合选择；不复用 `runtimeProfile`，因为 `runtimeProfile` 同时覆盖 `baseInstructions`，会意外改变主会话能力：

```ts
listModels(): Promise<CodexModelPage[]>;
reply(threadId, input, policy, observer, { model, effort }): Promise<string>;
```

## 模型目录

- App Server 初始化后调用 `model/list({limit, cursor, includeHidden:false})`，迭代到 `nextCursor = null`。
- 只公开 `hidden=false`、支持文本输入且至少支持一个 effort 的模型。
- 不把描述文本当作档位分类依据。
- 持久化一份脱敏目录快照和 `fetchedAt`，用于 App Server 暂时不可用时展示上次结果。
- 提供面板“刷新模型列表”操作；后台启动时刷新，之后最多每 6 小时刷新一次，避免轮询 App Server。
- 新模型默认仅可被固定选择；带 `upgradeInfo` 的旧模型显示升级提示，不再作为自动档位候选。

## 持久化与迁移

`codex-service.json` 从 v6 升到 v7：

```json
{
  "modelSettings": [
    {
      "accountId": "<private>",
      "selection": {"mode":"track","track":"fast","effort":"low"},
      "revision": 1,
      "updatedAt": 0
    }
  ],
  "modelCatalog": {
    "fetchedAt": 0,
    "models": []
  }
}
```

- v6 加载时不批量写账户记录；缺失配置按 `fast + low` 计算默认值，首次用户保存时才落盘。
- 目录只保存公开模型元数据，不保存凭据、账户配额或服务端响应原文。
- 保存继续使用现有原子临时文件替换和 0600 权限。

## 页面

在“聊天记录”Tab 顶部新增“回复模型”卡片：

- 当前账户。
- 选择模式：自动快速 / 自动均衡 / 自动最强 / 固定模型。
- 选择模式与推理强度在同一行各占一列；固定模型出现时单独占下一整行，避免挤压两个常用选项。
- 固定模式下显示实时模型下拉框。
- Effort 下拉框只显示当前模型支持的值。
- 当前实际生效：模型 ID、effort、配置来源、目录更新时间。
- 保存反馈：“已保存，将从下一条新微信消息开始生效。”
- 失败反馈区分：目录不可用、模型已下线、effort 不兼容、配置版本冲突。

页面不展示 token、线程 ID、模型目录原始响应或账户秘密。

## 失败模式

### 用户真实操作序列

1. **保存时模型已经从目录消失**：拒绝保存，保留旧配置并刷新目录。
2. **固定模型保存后下线**：下一条消息不启动模型回合；用固定、安全的渠道话术说明模型不可用，并在面板要求重新选择。不得静默换模型。
3. **自动档位首选模型下线**：只在同一档位的已验证映射中选择后备项；记录降级状态并在面板提示实际模型。没有后备项则阻止回合。
4. **effort 不再受支持**：不猜测升级为更高 effort；自动档位可降到该模型的默认 effort并明确标记，固定模式要求用户确认。
5. **目录刷新失败但旧目录存在**：显示“目录可能过期”，允许继续使用当前已解析配置；实际 `turn/start` 若明确返回模型不可用则按 2/3 处理。
6. **保存与消息并发**：入站时冻结 revision，当前排队消息使用旧配置，下一条使用新配置。
7. **模型请求超时或结果未知**：不能当作模型下线，不能切换模型后自动重试，避免重复执行工具或发送回复。
8. **明确的模型不可用且回合未创建**：不自动重放用户消息；通知用户选择模型后重新发送，保证副作用边界简单。

## 可观测性

每个运行记录增加公开且非敏感字段：

- `model`
- `reasoningEffort`
- `modelSelectionSource`
- `modelConfigRevision`

实现补充：运行记录在入站入队时写入以上冻结字段；自动档位若所选 effort 被目录移除，会明确使用该模型的目录默认 effort，并在面板标记为降级。带升级提示的旧模型不再进入自动档位，但仍可在固定模型列表中供用户显式选择。

目录刷新仅记录时间、数量、结果类别和耗时，不记录原始响应。这样可以按模型比较首次模型事件等待，而不暴露对话内容。

## 测试策略

高层 seam 使用 `AccountChatModelSettings` 和 HTTP 状态：

1. v6→v7 迁移得到 `fast + low`，旧状态其余字段不变。
2. `model/list` 多页合并、隐藏模型过滤、文本模态过滤、目录失败使用旧快照。
3. 默认快速解析为 Luna；均衡为 Terra；最强为 Sol。
4. 新未知模型自动出现在固定列表，但不接管自动档位。
5. 固定模型/effort 校验；模型下线和 effort 漂移分支。
6. 两账户配置隔离、同账户跨目标复用。
7. 排队后改配置，已排队回合仍使用冻结旧 revision。
8. `thread/start` 与每次 `turn/start` 使用正确模型；切换模型不创建新 thread。
9. 超时/未知不自动重试；明确模型不可用也不重放原消息。
10. 面板保存反馈、支持值联动、实际解析状态与降级提示。
11. fixture E2E：保存配置→下一条入站→运行记录显示新模型；不访问真实模型、不发送真实微信。

## 实施顺序

1. 生成并固定当前 App Server `model/list` 类型证据，补协议解析测试。
2. 新增 `AccountChatModelSettings` 与 v7 持久化迁移。
3. 在 `CodexConversation` 增加目录读取和逐回合模型选择，不改变 `runtimeProfile`。
4. 在 `WeixinCodexService` 入站排队处冻结选择，并写入运行记录。
5. 增加 HTTP 配置/刷新入口和公开状态。
6. 完成聊天 Tab 模型卡片与反馈。
7. 补齐错误路径、并发测试、全量 lint/typecheck/test/build 和 fixture E2E。
8. 只重启 `com.local.codex-weixin`，验证 4317 HTTP 状态；真实微信切换与回复由用户最后测试。

## 成功标准

- 未配置账户默认实际使用 `gpt-5.6-luna + low`。
- 用户可以按账户选择自动档位或目录中的固定模型。
- 新模型无需插件升级即可出现在固定模型列表。
- 新模型不会未经审核静默改变自动档位。
- 每条运行记录能证明实际使用的模型与 effort。
- 模型不可用、超时和未知结果都不会触发不安全的自动重试。
