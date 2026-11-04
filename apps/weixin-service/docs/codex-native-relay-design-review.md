# 微信纯转发 + Codex 原生执行设计审查

日期：2026-08-13

审查对象：`docs/codex-native-relay-design.md`

## 结论

方案可以进入实现，但必须保留下列门禁。核心 seam 是 `CodexTaskRouter`：微信层只提交目标与
正文，不再知道 Vault 操作名称；App Server host 隐藏多 thread、多 turn 和权限协议。该设计
实现“正常操作由 Codex 原生执行”，同时保留转发层必须承担的鉴权、投递、审计和恢复职责。

## 审查发现与修正

1. **不能宣称硬性禁止删除。** 官方 filesystem `write` 包含 delete/rename。设计已改称提示规则
   加可恢复快照，并将这一限制写入 UI、失败模式和验收边界。
2. **不能每条消息都复制两棵目录。** turn 默认只读；只有 App Server 发出写权限请求后才建立
   快照。快照失败则拒绝写权限。
3. **不能通过中文正则决定写权限。** Codex 自己理解消息并请求权限；relay 只验证机器可判定的
   roots、network 和 scope，避免再次出现“查看列表没有匹配关键词”的问题。
4. **不能修改全局 Codex 配置。** 专用权限 profile 通过 App Server 子进程的 config overlay
   提供，thread/turn 选择 profile；不写 `~/.codex/config.toml` 或 OpenClaw 配置。
5. **工作树扩权不能继承旧 Vault 开关。** 新 `localExecutionEnabled` 在迁移时默认 false，用户必须
   看到两个根目录的脱敏名称并重新启用。
6. **多目标并行不能启动多个 iLink 监听者。** 仅 App Server 内 thread/turn 并行；
   `DirectIlinkChannel` 仍是唯一 getupdates 消费者。
7. **多目标并行不能继续使用单个 `activeTurn`。** host 必须按 threadId/turnId 路由所有 delta、
   completion、approval 和 error；任何缺失 ID 的事件 fail closed。
8. **每目标独立 thread 仍需同目标 FIFO。** 否则同一个微信会话可能乱序回复并错用上下文。
9. **ack + final 不是已证实渠道能力。** 源码允许闭包调用两次不代表腾讯保证 token 可复用；真实
   双发送是发布门禁，失败后需用户重新决策，不能自动改成 final-only 后称完成。
10. **ack 不能先于 durable enqueue。** 否则用户看到“正在处理”但崩溃后没有任何本地 job 记录。
11. **ack 和 final 不能共享一个 transcript 状态。** 两次发送分别记录 accepted/unknown，避免
    ack 成功掩盖 final 失败。
12. **恢复不能覆盖后续用户编辑。** 恢复前必须比较写后 hash；冲突时只报告，不自动覆盖。
13. **快照不能落在 Codex roots 内。** 否则 Codex 可修改恢复证据；私有目录需 0700/0600，网页
    只见元数据。
14. **网页搜索与 shell 网络必须分离验证。** 配置 `web_search=live` 的同时，sandbox/profile
    network 保持 false；测试要同时断言两者，不能只看模型是否返回搜索结果。
15. **旧动态工具不能在 resume 时复活。** 使用新的 thread profile 和干净 thread；
    `thread/start` 明确不注册 dynamic tools。
16. **不能误删 `DirectMarkdownVault`。** 它仍被 `NewsArchive` 和每日调度使用；只移除交互 wiring
    及其 orphan。
17. **完全并行有资源风险。** 用户已明确选择目标间完全并行。实现不得偷偷限流，但必须复用一个
    App Server 进程、显示 active 数量，并在交付报告中说明真实 CPU/内存观察结果。
18. **App Server crash 后不能自动重放。** Codex 可能已经完成部分文件副作用；自动重跑会重复
    修改。保留快照和 job 状态，等待新的用户动作。

## 测试审查要求

- 并行测试必须使用可控 barrier，证明两个 target 同时进入 active；不能只断言两个 promise
  最终完成。
- FIFO 测试必须证明同 target 的第二个 turn 在第一个完成前没有调用 `turn/start`。
- 权限测试必须让 fake App Server 真实发出 `item/permissions/requestApproval`，并断言响应只包含
  两个固定 roots、turn scope、无 network。
- 删除恢复测试不能只看 snapshot 文件存在；必须修改 fixture、生成 diff、执行恢复并验证 hash。
- 冲突测试必须在写后再模拟外部编辑，断言恢复拒绝且外部内容不变。
- ack/final 测试必须覆盖四种组合：两者成功、ack 失败 final 成功、ack 成功 final 失败、两者失败。
- 泄密测试搜索公开状态、日志、MCP tool result 和 HTML，不得出现绝对 Vault 路径、thread 原始历史、
  token、二维码 URL或快照正文。
- E2E fixture 必须使用临时 workspace/Vault；不得触碰真实目录。
- 真实验证必须由用户发送消息并确认手机端结果；`ret=0` 只记为渠道接受。

## 开工前门禁

1. 当前仓库存在大量与本功能无关的用户改动；实现前必须先确认安全基线与 feature branch，不能
   reset、stash 或覆盖这些改动。
2. 生成并锁定本机 App Server schema fixture，只摘取本功能使用的字段，避免测试 fake 与真实协议
   漂移。
3. 先实现 fixture roots 和 snapshot fake，再触碰真实路径 wiring。
4. 当前 4317 服务不手动重启；开发 watch 自动重载。需要真实切换时先向用户报告。
5. 未通过 ack + final 真实验证前，页面必须标记该模式为待验证，不能展示“稳定可用”。

## 审查后的实施顺序

1. 多 target store migration + `CodexTaskRouter` 只读纵切。
2. 单 App Server 多 thread 并行与事件隔离。
3. turn 权限请求 + snapshot/diff/恢复。
4. ack + final 两阶段投递。
5. Plugin 面板状态与恢复入口。
6. 全量自动验证、代码 review、测试 review、design 回同步。
7. 用户在场的真实微信/Vault 验证。

## 实现后复核（2026-08-13）

- 旧 v1 授权不会扩大为新写权限，新 thread profile 阻断旧动态工具会话复用。
- 写权限失败为 fail closed，快照目录不在 runtime roots 内；恢复采用 post-image hash 冲突检查，
  不覆盖用户后续编辑。
- 跨目标 active turn、回复文本与 thread ID 均按 thread 路由；同目标队列不影响其他目标。
- ack/final 的结果分别持久化且未知结果不重试；真实 iLink 双发仍保留为用户在场门禁。
- 现场真实双发已确认；首个长任务暴露 120 秒 turn 超时假失败。实现已拆分协议请求与完整 turn
  预算，按用户要求将 turn 上限设为 24 小时，并保留“超过请求预算但在 turn 预算内完成”的回归测试。
