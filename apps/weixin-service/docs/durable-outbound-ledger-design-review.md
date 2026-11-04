# 可靠性第二阶段设计审查

审查对象：`durable-outbound-ledger-design.md`

## 结论

方案可以进入 TDD。第二阶段只承诺“iLink 出站事实可持久对账、未知结果不盲重发”，不承诺整个 Codex turn exactly-once，也不自动恢复 `recovery_blocked` 入站。

## 发现与修正

1. **只在 WeixinCodexService 记账会漏后台发送。** 账本必须注入 `DirectIlinkChannel`，才能覆盖日报、提醒、探针、拒绝语音提示和自动问候。
2. **一个逻辑 messageId 不能代表两次网络调用。** retry 必须生成独立 attemptId；可复用 clientId，但两次结果分别保留。
3. **prepared 不能视为“尚未发送”。** 进程可能在 fetch 前后退出；恢复时必须按 unknown safety 禁止重放。
4. **unknown retry 即使复用 clientId 也没有公开幂等保证。** 删除网络/解析未知后的自动重试；只有腾讯明确拒绝才允许一次重试。
5. **把正文或路径存入账本会扩大敏感面。** 只保存类型、关联 ID、机器账户/目标、时间、序号、结果和数值 provider code。
6. **媒体不是单一副作用。** getuploadurl、CDN upload、caption 和 media send 分开记账；任一 unknown 都不继续下游。
7. **typing 不应混入可恢复副作用。** 它是展示状态且不被重放；保留现有 timing telemetry 即可。
8. **没有 iLink effect 不代表 turn 无副作用。** command/MCP/native write 仍可能发生；本阶段禁止据此自动 requeue DurableInbox。
9. **账本不可用时不能静默降级。** 真实服务必须 fail closed；否则可靠性机制本身会制造无记录发送。
10. **provider errmsg 不能持久化。** 仅保存受控整数 code；公开查询仍需缩略机器 ID。

## 实现门禁

- 一次一纵切：先写高层失败测试，再写最小实现。
- 不修改现有 context token、凭据、登录或账户配置。
- 不改变成功语义：`ret=0/errcode=0` 仍只是 iLink accepted，不等于手机收件。
- 不自动恢复已有 `recovery_blocked`；恢复决策等 App Server 对账阶段。
- 不重启正在运行的服务；本地 fixture 与单测完成后，再给用户真实验收步骤。
