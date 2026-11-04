# 可靠入站第一阶段设计审查

审查对象：`reliable-inbound-design.md`

## 结论

方案可以进入 TDD，但自动处理恢复必须保持关闭，直到副作用与出站账本完成。第一阶段承诺的是“消息和 cursor 不会静默丢失、未开始任务可恢复、已开始任务保守保留”，不是 exactly-once 执行。

## 发现与修正

1. **只在 Codex service 增加 SQLite 不足以关闭 cursor 窗口。** transaction 必须位于 iLink batch ingest seam，同时保存 cursor 与 envelope。
2. **把完整私有状态迁入 SQLite 会扩大本阶段。** 凭据和标签继续留在 JSON，SQLite 只权威维护入站 checkpoint；启动时合并，避免双写 cursor 重新成为事实来源。
3. **运行时 event 不能直接序列化。** payload 必须是严格校验的纯数据；reply/typing/media capability 在 lease 后以该 envelope 的 context token 重建。
4. **lease 过期不等于安全重试。** 在没有 effect ledger 前统一进入 `recovery_blocked`，否则可能重复写文件、调用 MCP 或发送微信。
5. **多个监听者会模糊完成语义。** journal job 只能由一个权威 dispatcher lease；启动阶段必须等 Codex 与日报消费者完成注册后显式激活。普通消息依次等待全部已注册消费者；日报 command 一旦消费则不进入普通监听器。任一消费者失败都不 complete，避免把部分处理伪装成全部完成。
6. **`processedKeys` 不能立即硬删除。** 它仍包含旧版本已经处理的历史 key；需要 legacy completed 兼容，防止升级时重放旧消息。
7. **JSON checkpoint 投影失败不能让 monitor 重拉已提交 batch。** ingest receipt 是提交证据；之后 JSON save 只是可修复投影，不影响 SQLite cursor。
8. **数据库损坏不能回退到 JSON 新 cursor继续拉取。** 一旦数据库已初始化，打开/校验失败必须停止 monitor 并显示私有状态不可用，避免绕过 journal。
9. **账号切换必须隔离。** 所有 checkpoint、target context、job 查询都绑定 account ID；禁止以当前单账户假设省略 account key。
10. **SQLite transaction 无法包含媒体文件写入。** 下载完成但 DB 回滚会产生孤儿文件；这是空间泄漏而非消息一致性破坏，先记录并以后按引用 GC。

## 实现门禁

- 每个纵切先写一个高层失败测试，再写刚好通过的 implementation。
- 测试从 `DurableInboundStore` interface 和 channel 可观察行为验证，不断言私有 SQL 语句。
- 在副作用账本前，不允许任何过期 leased job 自动重新执行。
- 不修改现有发送 retry、App Server 生命周期或 LaunchAgent。
- 不重启当前开发服务；本分支在独立 worktree 验证。

## 实现审查补充

- 派发默认关闭；只有 Codex service 成功启动后，主程序才调用 `activateInboundDispatch()`。Codex 不可用时 iLink monitor 仍可将消息写入 journal，但不会把它们标为完成。
- durable command handler 的异常不再被吞掉或转交给普通聊天处理；job 保持 leased，过期后进入 `recovery_blocked`。
- `queuedTargets()` 只返回目标中最早非终态 job 本身为 queued 的目标，避免 recovery-blocked/leased 头部后存在 queued job 时形成忙循环。
- 当前 dispatcher 仍把一次消息可能触发的多个内部消费者作为一个完成单元；拆分副作用账本属于下一阶段。
