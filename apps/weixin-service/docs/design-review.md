# 直连 iLink 设计审查

审查对象：`docs/design.md`

## 审查结论

方案可以进入实现。它满足“完全脱离 OpenClaw”的定义：运行路径、状态目录、凭据、
入站长轮询和发送均不依赖 OpenClaw。固定的腾讯 iLink 协议复杂度被收敛在
`DirectIlinkChannel` 深模块内，业务层和网页不接触 token。

## 审查中发现并补入设计的问题

1. **隔离 state 仍可能被腾讯判定已绑定。** `binded_redirect` 在没有本地直连凭据时
   不能当成功，否则会重现“看似连接、实际仍复用旧 OpenClaw”的问题。设计已明确空状态时报错。
2. **确认先于落盘会产生假连接。** `confirmed` 后必须先验证 token/account/base URL 并
   成功原子保存，再发布 connected 状态和启动入站轮询。
3. **仅保存 context token、不保存同步游标会重复消费。** 游标和 token 必须在同一状态
   快照中原子更新，服务重启后从同一快照恢复。
4. **直接复制插件默认 BotAgent 会混淆归因。** 直连实现保留腾讯要求的 app ID/版本头，
   但 `base_info.bot_agent` 使用合规的 `WeixinDirectDemo/0.1.0`，明确不是 OpenClaw。
5. **redirect 可能扩大 SSRF 面。** 只接受登录状态响应中的 HTTPS host，禁止用户名、密码、
   非标准协议和本地/IP host；二维码仍限制微信域名。
6. **持久化本身会新增秘密处理责任。** 目录/文件权限是启动门禁；任何原始网络响应和
   credential JSON 都不得进入 HTTP 响应、控制台或测试快照。
7. **退出时在途长轮询可能拖住服务。** 模块必须持有 AbortController；close 先 abort，
   再 best-effort notify stop，且设置短超时。
8. **让网页定时 POST discover 会把同步责任放错层。** 入站目标何时有效取决于 context
   token 已成功持久化，应由 `DirectIlinkChannel` 在该事实成立后发布事件。设计采用单一
   `onSnapshotChanged` 订阅 seam，网页仍只轮询公开状态。
9. **先发布、后保存会制造可见但不可发送的目标。** 自动通知必须严格发生在私有状态
   原子保存与内存状态替换之后；保存失败时不发布。
10. **观察者异常不能杀死入站监听。** listener 调用由深模块隔离，订阅取消后不得再收到事件。
11. **继续扩展 targets-only 事件会形成浅层 interface。** 别名、账户健康和时间会迫使调用者
   再组合多份状态。设计改为单一 `ChannelSnapshot`，旧的账户/目标读取与事件方法被替换，
   `DemoService` 只消费一个一致快照。
12. **机器 ID 与人类名称不能混为一谈。** iLink 没有昵称查询；所有可读名称必须标注为
   本地别名，原始 accountId/target 仍是唯一发送键并保留在高级信息中。
13. **自行规定 token TTL 会制造假协议。** 不按任意天数删除或宣布过期，只展示最近入站/
   上下文更新时间；普通失败建议新入站刷新，`-14` 才进入 bot 凭据 stale 状态。
14. **发送成功后附属元数据写盘失败不能反转真实结果。** `ret=0` 已意味着渠道接受；
   `lastSendAcceptedAt` 是 best-effort 辅助记录，失败不得向用户报告发送失败或自动补发。
15. **stale 事件与发送完成存在竞态。** `sendText` 必须返回分类 reason，`DemoService` 最终
   以 `auth_stale` 覆盖通用 send_error；快照事件也要立即禁用按钮。
16. **附属时间写盘可能覆盖同期入站。** 发送请求开始时捕获的状态已可能过期；`ret=0`
   后必须把 `lastSendAcceptedAt` 合并到最新同账户状态，否则会回滚同步游标和 context token。
17. **异步完成态可能覆盖 stale。** monitor 启动和发送响应期间都可能发布 `stale`；最终
   UI 状态必须重新检查账户健康，不能简单写回 `connected` 或 `sent`。
18. **重复输入机器 ID 是冗余且易错的门禁。** 发送目标已只能来自带 context token 的
   已同步快照；再手输一遍长 ID 不增加渠道认证强度，反而容易复制缩略值或产生输入错误。
   删除该字段，保留已同步目标校验、入站复选框和独立发送点击。
19. **显示值不能被误用为路由值。** 发送目标应与最近入站目标一致优先展示本地别名，
   但确认请求必须继续携带完整机器 ID；前端需明确分离只读显示值和内部目标 ID。
20. **只更新页面顶部会让操作看起来无响应。** 用户点击第二、三步按钮时通常停留在卡片下部；
   成功和失败反馈必须紧邻对应按钮，并从服务状态重建，避免轮询刷新后消失。

## 被拒绝的方案

- 继续调用 `openclaw channels login/message send`：仍复用 OpenClaw runtime，不满足需求。
- 只给登录命令增加 `--account demo`：最终账户 ID 由 iLink 分配，且仍归主 gateway 托管。
- 导入插件内部 TypeScript 文件：这些不是稳定公开 interface，仍会把 OpenClaw SDK 依赖带入 Demo。
- 把凭据放进浏览器 localStorage：会扩大 XSS/浏览器扩展泄漏面，也无法安全驱动服务端长轮询。
- 网页增加本地“授权成功”按钮：无法替代 iLink `confirmed`，会制造假成功。
- 自动清理旧 OpenClaw 凭据：破坏性强且不需要；用户只接受腾讯侧重绑可能使旧连接失效。

## 实现门禁

- 先以失败测试证明当前 OpenClaw 进程 adapter 不满足直连需求。
- 每个协议纵切按红 → 绿推进；不在实现循环顺手重构。
- 全量通过 lint、typecheck、单元/集成、fixture E2E 和 build 后，才替换正在运行的服务。
- 真实二维码出现后停止自动操作，等待用户扫码；不读取或输出二维码 URL。
- 自动同步不得自动选择、确认或发送；它只更新安全的账户/目标 ID 快照。
- 别名与时间不得暴露 token、原始响应或消息正文；任何发送失败都不自动重试。
