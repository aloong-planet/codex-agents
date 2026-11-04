# 微信账户级长期记忆设计审查

审查对象：`account-memory-curator-design.md`

## 结论

方案可以进入需求确认，但在用户确认默认写入类别、触发阈值和容量前不应实现。账户级隔离符合当前“一账户一自然人、target 可变化”的产品假设；如果这个假设改变，必须先升级 scope，不能靠提示词避免跨用户泄露。

## 已发现并修正的问题

1. **Curator 自身历史可能污染新批次**
   - 原方案只写“独立 thread”，没有明确 thread 是否长期复用。
   - 已改为每个 job 新建隔离 thread，记忆与对话由宿主显式提供；专用 transport 不复用主聊天工具 host。

2. **一个 job 多次 mutate 会产生跨调用部分提交**
   - 单次 batch 原子并不能阻止模型连续调用两次工具。
   - 已规定每个 job 最多一次成功 mutate/noop receipt，首次成功后关闭写能力。

3. **“低风险”缺少可执行边界**
   - 模糊分类会让不同 Curator 运行产生不一致结果。
   - 已收紧为稳定偏好、长期项目、明确决策、持续约束四类，且必须有当前 job 的用户直接证据；身份、关系、健康、财务、精确位置和账号标识第一版拒绝。

4. **remove 和 consolidation 可能错误删除事实**
   - 已要求 remove 必须匹配当前 job 的明确 forget/correction 证据；consolidation 只能无损合并，不能凭模型判断删除身份或偏好。

5. **持久化 job 会长期保存聊天正文**
   - 已增加最小保留策略：成功后立即删正文，dead-letter 正文 7 天后清除，仅保留脱敏记录。

6. **App Server 只读权限协议已迁移**
   - 实机请求确认 `readOnly.access` 会被当前 App Server 拒绝，并要求使用 `permissionProfile`。
   - Curator 改用受支持的 `:read-only` profile，turn 请求不再携带旧 `sandboxPolicy`；混用两套机制必须由单元测试阻止。

## 保留风险与实现门禁

- `MEMORY.md` 与 `metadata.json` 是两个文件，不能真正事务提交；必须实现 hash/revision 修复路径并覆盖崩溃测试。
- 主聊天按 target 串行，而记忆按 account 串行；必须建立独立账户队列，否则两个 target 会并发改同一文件。
- Curator 的模型判断不能成为安全边界；scope 绑定、证据白名单、敏感类别、路径、预算、CAS 和幂等都必须由宿主工具确定性验证。
- accountId 变化必须得到全新空 scope；不得按账户别名、最近 target 或“看起来是同一用户”自动迁移。
- memory capture/curation 失败不得阻塞正常微信回复，也不得对用户声称“已经记住”。
- fixture 和模型 mock 只能证明本地路径；跨 target 的真实 recall 仍需用户在场验证，测试不得自动发送微信消息。

## 进入实现前的验收条件

- 用户确认账户级共享假设。
- 用户确认默认自动提交类别及高风险信息拒绝策略。
- 用户确认 10 turn 触发阈值与明确意图立即触发。
- 用户确认 12,000 Unicode 字符、200 条的账户预算。
- 用户确认第一版面板只读，修正和删除通过明确指令完成。
