# 可靠性第二阶段：持久出站账本设计

## 目标

本阶段让每一次腾讯 iLink 出站调用在发出前留下持久意图，并在得到明确结果后记录为 `accepted`、`rejected` 或 `unknown`。它解决两个问题：

1. 网络超时、连接中断或响应无法解析时，不再自动重发可能已经送达的消息。
2. 进程退出后可以区分“从未调用”“明确拒绝”“已接受”和“调用结果未知”，为后续 DurableInbox 自动恢复与 App Server 对账提供可信证据。

完成标准：

1. 聊天回复、失败提示、日报、计划提醒、context-token 探针、运行进度和媒体发送都经过同一个 `DurableEffectLedger`。
2. 每个实际 iLink 请求都先 `prepare` 并同步落盘，再进行网络调用。
3. 请求得到 `ret=0/errcode=0` 才标记 `accepted`；明确非零响应标记 `rejected`；请求、超时、响应解析失败或进程中断均保持/标记 `unknown`。
4. `unknown` 和未 settle 的 `prepared` 永不自动重发；明确 `rejected` 仍允许当前调用者按既有“一次重试”策略重试。
5. 账本不保存正文、媒体内容、文件路径、context token、bot token、上传 URL 或服务端错误文本。
6. 本阶段不自动恢复 `recovery_blocked` 入站任务，不实现 TurnSupervisor、AppServerHost 或 ServiceWatchdog。

## 范围

### 纳入

- `sendmessage` 文本分段。
- `sendmessage` 工具进度。
- `getuploadurl`、加密媒体上传和媒体 `sendmessage`。
- 媒体 caption 继续走文本分段账本。
- 所有直接调用 `channel.sendText()` 的后台路径，因此日报、计划提醒和 token 探针无需分别接线。

### 暂不纳入

- typing start/stop：它是短生命周期展示状态，不会被恢复任务重放。
- Codex App Server 内部 command、MCP 和 fileChange 的逐副作用账本：当前协议只提供 turn/item 事件，无法在任意外部副作用发生前统一持久化。
- Vault/native write 的精确事务对账：已有授权、CAS 与 turn snapshot，但它们尚未和 DurableInbox event key 建立可信关联。后续阶段只能把未知 App Server turn 保守视为不可重放，不能因“账本里没有微信发送”就断言安全。

这个边界保证本阶段不伪造完整 exactly-once：账本能证明 iLink 出站事实，不能证明任意 Codex 工具没有产生副作用。

## 深模块与 seam

新增 `DurableEffectLedger`，外部只表达副作用意图和终态；SQLite schema、校验、事务、文件权限、幂等与脱敏留在模块内部。

```ts
type EffectKind =
  | "weixin_text"
  | "weixin_progress"
  | "weixin_media_upload_url"
  | "weixin_media_upload"
  | "weixin_media_send";

interface DurableEffectLedger {
  prepare(input: {
    operationId: string;
    attemptId: string;
    causeEventKey?: string;
    accountId: string;
    target: string;
    kind: EffectKind;
    clientId?: string;
    ordinal?: number;
  }): EffectRecord;
  settle(attemptId: string, outcome: "accepted" | "rejected" | "unknown", providerCode?: number): EffectRecord;
  retrySafety(attemptId: string): "safe" | "unsafe" | "unknown";
  listByCause(causeEventKey: string): EffectRecord[];
}
```

- `operationId` 表示一次逻辑发送；分段、caption 与媒体各阶段共享或建立可追踪的 operation。
- `attemptId` 表示一次真实网络调用，必须唯一；同一次 retry 使用新的 attempt，不能覆盖第一次结果。
- `causeEventKey` 仅在由 DurableInbox 消息触发时填写；日报等后台任务为空。
- `clientId` 可保存，因为它是本地生成的幂等/诊断标识，不是凭据；不向公开页面显示完整值。
- `target` 仅存本地机器 ID，用于账户隔离和诊断；公开状态只显示既有缩略 ID/别名。

SQLite 是本地可替代依赖，测试使用临时目录中的真实 `node:sqlite` 数据库，不新增数据库抽象或内存 fake。

## 存储

复用私有状态目录，新增 `effects.sqlite`，避免与 DurableInbox 的 schema/lifecycle 耦合。目录权限 `0700`，数据库 `0600`，启用 WAL、`synchronous=FULL`、busy timeout 和约束校验。

```sql
CREATE TABLE effect_attempt (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  cause_event_key TEXT,
  account_id TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_id TEXT,
  ordinal INTEGER,
  state TEXT NOT NULL CHECK (state IN ('prepared','accepted','rejected','unknown')),
  provider_code INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  updated_at INTEGER NOT NULL
);
```

`prepare` 使用 `INSERT`；相同 `attemptId` 重放时仅在所有不可变字段完全一致时返回原记录，否则报冲突。`settle` 只允许 `prepared -> terminal` 或同终态幂等重放，不允许 terminal 被另一结果覆盖。

## 发送状态机

```text
不存在
  -> prepared       # FULL sync 已完成，随后才允许调用网络
  -> accepted       # 明确 ret=0/errcode=0
  -> rejected       # 明确非零响应
  -> unknown        # timeout / fetch error / body parse error / 本地无法判定

prepared --进程退出--> 下次读取时仍按 unknown safety 处理
```

重试安全性：

- `rejected`：`safe`，服务端明确未接受，可按调用内策略重试一次。
- `accepted`：`unsafe`，禁止重发。
- `unknown`：`unsafe`，禁止自动重发。
- `prepared`：`unknown`，进程可能在网络调用前或后退出，禁止自动重发。

## 用户操作序列与失败模式

1. **普通回复成功**：prepare -> iLink -> accepted；调用者报告“渠道接受”，不声称手机已收到。
2. **prepare 落盘失败**：不调用 iLink，返回本地账本不可用；不会出现“已发送但没有记录”。
3. **网络调用前退出**：记录停在 prepared；恢复时不重发，因为无法证明调用尚未开始。
4. **请求已到腾讯、响应丢失**：标记 unknown；不自动重发，避免重复微信。
5. **响应体无法解析**：请求可能成功，标记 unknown；不自动重发。
6. **明确被腾讯拒绝**：标记 rejected；当前逻辑最多再发起一个全新 attempt，并保留两条记录。
7. **长文本中途失败**：已接受段保持 accepted；unknown 段不重发；后续段不发送，返回 partial/unknown。
8. **日报/提醒后台发送**：因入口在 channel 内，同样记账；unknown 时调度器不得把结果当 accepted，也不得盲重发正文。
9. **媒体 upload URL 失败**：记录 rejected/unknown，不进入后续上传。
10. **媒体二进制上传结果未知**：不自动重传；即使它通常不可见，也保守记录 unknown，后续媒体 send 不执行。
11. **媒体 send 结果未知**：不重发；caption 若已接受，账本能显示部分副作用。
12. **账本 DB 损坏/不可打开**：真实模式启动失败，不降级到无账本发送；fixture 可使用内存显式 fake，但不得用于真实服务。
13. **账户重新绑定**：记录按 account/target 隔离；旧记录不授权新账户发送。
14. **处理中的 App Server 曾写文件但没有 iLink effect**：仍不能恢复该 inbound；本阶段不会把“无出站记录”误判为安全。

## 公开状态与隐私

本阶段先提供服务内部查询与测试 seam，不在页面展示逐条账本。后续恢复面板只允许显示计数、类型、状态和时间；不得返回正文、context token、媒体路径、上传 URL 或完整 client ID。

当发送失败时，调用者继续使用已有 reason 分类：

- `auth_stale`：凭据失效/暂停。
- `context_stale`：上下文失效。
- `rejected`：腾讯明确拒绝。
- `unknown`：结果未知，不会自动重试。
- `unavailable/context_missing`：网络调用前失败，不产生 effect attempt。

## 实施纵切

1. `DurableEffectLedger` prepare/settle/idempotency/retrySafety。
2. 文本单段接入：账本失败不发送；accepted/rejected/unknown 正确 settle。
3. 删除 unknown 自动重试；保留明确 rejected 的一次 retry，并给 retry 新 attemptId、复用同 clientId。
4. 长文本 partial 与现有诊断回归。
5. 运行进度接入。
6. 媒体 upload URL、上传和 send 接入，并补全 15 秒超时与 unknown 分类。
7. 主程序真实模式强制装配 ledger；fixture 使用显式无外部副作用实现。
8. 代码 review、测试 review、全量验证与设计同步。

## 验证

- Store：跨实例持久化、prepare 幂等、冲突、终态不可改写、脱敏字段限制、权限。
- Text integration：prepare 先于 fetch；prepare 失败零网络；unknown 只调用一次；rejected 恰好两次且两条 attempt；accepted 一次。
- Segment integration：partial acceptance、unknown 中止、clientId 复用与 attemptId 唯一。
- Progress/media：每个外部阶段都有 attempt；unknown 不进入下游阶段；超时可控。
- Existing callers：日报、提醒、探针通过 `sendText` 自动覆盖，不分别 mock 内部账本。
- 全量：`pnpm lint`、`pnpm typecheck`、单元/集成测试、fixture E2E。
- 不触发真实微信发送；最终用户在场时再执行一条明确授权的真实消息验收。
