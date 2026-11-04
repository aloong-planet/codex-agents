# 可靠性第二阶段任务清单

- [x] 盘点聊天、日报、提醒、探针、运行进度、媒体与本地写入 seam。
- [x] 写持久出站账本设计。
- [x] 完成设计审查，明确未知不重试和本阶段不自动恢复边界。
- [x] 建立实现分支。
- [x] 纵切 1：DurableEffectLedger prepare/settle/idempotency/retrySafety。
- [x] 纵切 2：文本单段接入与 prepare fail-closed。
- [x] 纵切 3：unknown 不重试；明确 rejected 最多重试一次且 attempt 独立。
- [x] 纵切 4：长文本 partial/diagnostics 回归。
- [x] 纵切 5：运行进度接入。
- [x] 纵切 6：媒体 upload URL、上传、send 接入与超时分类。
- [x] 纵切 7：主程序真实模式装配 ledger，fixture 无真实副作用。
- [x] 代码 review 与回归测试补强。
- [x] 测试 review、fixture E2E 与全量验证。
- [x] 回同步设计文档。

暂缓：App Server command/MCP/fileChange 精确 effect interception、TurnSupervisor、AppServerHost 自动恢复、ServiceWatchdog。
