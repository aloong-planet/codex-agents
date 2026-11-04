# 可靠入站第一阶段任务清单

- [x] 核对 iLink cursor/publish 与 processedKeys/work queue 故障窗口。
- [x] 写设计文档。
- [x] 完成设计审查。
- [x] 纵切 1：DurableInboundStore 原子提交 batch、cursor 和 context checkpoint。
- [x] 纵切 2：重复 batch 去重与跨实例 checkpoint 恢复。
- [x] 纵切 3：lease/CAS、同目标 FIFO 与过期 lease 保守阻塞。
- [x] 纵切 4：DirectIlinkChannel 使用 SQLite checkpoint 并在 commit 后发布。
- [x] 纵切 5：运行时 capability 从持久 envelope 的 context token 重建。
- [x] 纵切 6：用 durable dispatcher 替换新消息 processed-before-work 路径。
- [x] 纵切 7：旧 processedKeys 兼容迁移。
- [x] 代码 review 与回归测试补强。
- [x] 测试 review、fixture E2E 与全量验证。
- [x] 回同步设计文档。

暂缓：SideEffectLedger、OutboundLedger、TurnSupervisor、AppServerHost 自动恢复、ServiceWatchdog。
