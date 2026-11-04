# 可靠入站第一阶段设计

## 目标

本阶段确保腾讯 iLink 返回的入站消息不会因为进程在 cursor 前移、事件发布或任务排队之间崩溃而静默丢失。

完成标准：

1. 入站事件、下一 cursor 与最新目标 context checkpoint 在同一个 SQLite transaction 中提交。
2. 相同 iLink batch 被重放时按稳定 event key 去重。
3. 同一目标只允许最早的非终态任务被 lease；不同目标可以分别领取。
4. 主服务重启后，尚未开始处理的任务仍可领取。
5. 已经开始、但尚无副作用账本可以证明安全性的任务，在 lease 失效后进入 `recovery_blocked`，本阶段不盲目重放。
6. 旧 `state.json` 中的凭据、base URL 和本地标签保持兼容；不读取、打印或向页面暴露 context token。
7. 不修改发送重试策略、不实现 TurnSupervisor、AppServerHost 自动重启或 ServiceWatchdog。

## 当前故障窗口

### iLink cursor 与事件发布

当前 `DirectIlinkChannel.monitor()` 先保存包含新 `getUpdatesBuf` 的 JSON 状态，再调用 `publishInbound()`。如果进程在两者之间退出，腾讯下次从新 cursor 拉取，消息不会再次返回，但应用从未收到事件。

### 收到与完成混为一体

当前 `WeixinCodexService.onInbound()` 在进入内存 Promise FIFO 前就把 event key 写入 `processedKeys`。如果进程随后退出，重启后该消息被当成已经处理，但原任务没有完成。

### 运行时闭包不可持久化

`InboundTextEvent` 含 `replyText`、`startTyping`、`replyMedia` 等闭包。直接 JSON 序列化会丢失发送能力，也无法保证它仍绑定原消息的 context token。

## 深模块与 seam

新增 `DurableInboundStore` 模块。它的外部 interface 只暴露批次提交、lease、完成/阻塞和 checkpoint 读取；SQLite schema、transaction、CAS、payload 校验和文件权限都留在 implementation 内。

```ts
interface DurableInboundStore {
  ingestBatch(batch: DurableInboundBatch): IngestReceipt;
  checkpoint(accountId: string): InboundCheckpoint | null;
  leaseNext(targetKey: string, owner: string, ttlMs: number): DurableInboundLease | null;
  complete(jobId: string, owner: string, revision: number): void;
  blockExpiredLeases(): number;
}
```

SQLite 是本地可替代依赖，测试通过临时目录中的真实 `node:sqlite` 数据库跨同一 seam 验证，不增加数据库 port 或 in-memory fake。

`DurableInboundEnvelope` 只保存数据：event key、账户、目标、message ID、source/rejection、正文、已物化媒体路径、引用元数据、received/observed time 和当次 context token。lease 后由 `DirectIlinkChannel` 重新绑定 typing/reply capability，context token 永不进入公开状态。

## 权威状态与兼容投影

- `state.json`：继续权威保存 bot token、base URL、账户 ID、用户 ID和本地标签。
- `inbound.sqlite`：权威保存 getupdates cursor、目标 context checkpoint 和 DurableInbox。
- 首次启用数据库时，以旧 `state.json.getUpdatesBuf/contextTokens/targetMetadata` 初始化 checkpoint。
- 之后启动时先加载 JSON，再用 SQLite checkpoint 覆盖内存中的 cursor/context/timestamps。
- 每次成功 ingest 后尽力把 checkpoint 投影回 `state.json`；投影失败不能回滚已经提交的 inbox/cursor，下一次启动仍从 SQLite 恢复。

这避免把登录凭据迁入新数据库，同时使 inbox 与 cursor 具备真正的原子性。

## SQLite schema

```sql
CREATE TABLE channel_checkpoint (
  account_id TEXT PRIMARY KEY,
  get_updates_buf TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE target_context (
  account_id TEXT NOT NULL,
  target TEXT NOT NULL,
  context_token TEXT NOT NULL,
  last_inbound_at INTEGER NOT NULL,
  context_updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, target)
);

CREATE TABLE inbox (
  event_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  target TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  context_token TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

数据库目录权限为 `0700`，数据库文件为 `0600`；启用 WAL、`synchronous=FULL`、foreign keys 和 busy timeout。任何解析错误 fail closed，不返回原始 payload/token。

## 状态机

```text
queued
  -> leased
  -> completed

leased --进程退出/lease 过期--> recovery_blocked
```

本阶段不把过期 lease 自动恢复为 `queued`。原因是尚未有 effect/outbound ledger，无法证明 Codex、文件、MCP 或微信发送是否已发生。下一阶段完成副作用账本后，再把可证明安全的 job 转入自动恢复。

## 用户真实操作序列与失败模式

1. **普通文字到达**：事件和 cursor 同事务提交；commit 后才允许 worker 领取。
2. **同 batch 重放**：`INSERT OR IGNORE` 不产生第二个 job，checkpoint 可前移到相同 cursor。
3. **commit 前退出**：SQLite 回滚，旧 cursor 使腾讯重放。
4. **commit 后、JSON 投影前退出**：SQLite 已有消息和 cursor；重启从 checkpoint 恢复，不重复丢失。
5. **commit 后、worker 前退出**：job 保持 queued，重启后可领取。
6. **lease 后、处理前退出**：没有可靠的阶段证据，本阶段保守标记 recovery_blocked，不重跑。
7. **磁盘满/权限异常/数据库损坏**：不推进 cursor，不发布消息；monitor 退避后用旧 cursor 重试。
8. **媒体已下载但 transaction 失败**：可能留下私有孤儿媒体文件；本阶段不删除，避免误删其他任务引用，后续按 inbox 引用做 GC。
9. **账户重新绑定**：checkpoint 按 account ID 隔离；新账户从自身 JSON cursor 初始化，不复用旧账户 inbox。
10. **context token 更新但 JSON 投影失败**：pending envelope 与 target checkpoint 仍保存原 token；运行时回复绑定 envelope token。
11. **没有 Codex 自动回复的目标**：消息仍可进入 channel journal，但 worker 只处理当前启用目标；未启用目标不创建 Codex attempt。
12. **日报命令消费消息**：命令 handler 必须在 lease 内完成或进入 recovery_blocked，不能只 fire-and-forget 后提前 complete。

## 迁移

1. 数据库不存在时创建 schema。
2. 当前账户没有 checkpoint 时，从 `state.json` 导入 cursor 和已有 context metadata。
3. `processedKeys` 暂时保留作历史兼容：Codex consumer 仍用旧 key 跳过历史消息；durable dispatcher 随后正常完成该 journal job。新消息不再写入该数组。
4. 待 DurableInbox 全量接管并验证后，在后续 schema 版本删除 `processedKeys`；本阶段不做破坏性 JSON migration。

## 验证

- store seam：原子提交、重复 batch、checkpoint 覆盖、lease/CAS、FIFO、跨实例恢复、权限和损坏输入。
- channel integration：commit 失败不发布且不推进；commit 成功后发布；JSON 投影失败仍可从 DB 恢复；全部消费者注册并显式激活前不派发。
- Codex integration：新消息不再在排队前写 `processedKeys`；queued job 重启可见；过期 lease 不盲目处理。
- 全量：`pnpm lint`、`pnpm typecheck`、单元/集成测试、fixture E2E。
- 不调用真实腾讯登录、扫码或发送。
