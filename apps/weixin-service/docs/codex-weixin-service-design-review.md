# 独立 Codex 微信服务设计审查

审查结论：可以进入实现，前提是保持单一 iLink monitor 与单一 App Server writer。

## 审查补强

1. 不能另起独立 `getupdates` 进程；新服务必须订阅现有 `DirectIlinkChannel`。
2. 不能在 Codex 完成后再取“最新 context token”；回复能力必须随入站事件捕获。
3. 游标先落盘带来崩溃丢消息窗口；首版采取 at-most-once，不以自动重试制造重复发送。
4. USER 类型过滤之外保留近期出站 client ID 防回声；BOT 消息绝不进入 Codex。
5. 启用目标必须持久化且由网页明确操作；连接成功、目标确认都不等于自动回复授权。
6. App Server thread ID 不是微信凭据，但聊天记录含私人正文，必须与 token 状态同等级保护。
7. 继承能力不等于无人值守批准工具；首版所有 server request 一律 decline。
8. App Server 回复成功、iLink 发送失败时不得重跑 Codex 或自动补发。
9. App Server 子进程异常退出后可在下一条消息重建 transport 并 resume thread，但同一消息不重试。
10. 网页只能显示必要的状态与记录，不能暴露原始 JSON-RPC、插件日志或环境变量。
11. 本机生成的 App Server TypeScript schema 是实现枚举与审批响应结构的验证依据；测试 fake
    必须断言 `workspace-write` 及各类安全拒绝，防止 fake 接受线上协议不支持的值。
