# Weixin 运行状态设计审查

日期：2026-08-15

结论：修正下列问题后，设计可以进入实现。

## 已修正问题

1. **排队消息覆盖活动 run**
   - 原设计“每目标只保留最新 run”会让第二条入站在第一条仍执行时把页面状态改成 queued。
   - 修正：每目标保留一个 active/latest 记录；排队只增加 queueDepth，真正出队才切换 run。

2. **步骤记录无法跨 run 解释**
   - 原步骤只有 item hash；新 run 后无法判断步骤属于哪一轮。
   - 修正：增加不可逆 `runIdHash`，保留跨 run 最近 20 条安全步骤。

3. **typing ticket 账户隔离不足**
   - 仅以 target 为缓存键会在账户重绑或多账户扩展时错误复用 ticket。
   - 修正：缓存键固定为 `(accountId,target)`；账户切换/失效清空。

4. **`/echo` 部分失败语义不诚实**
   - 原设计在回显失败后仍发送耗时消息，可能让用户误以为 echo 成功。
   - 修正：回显被渠道接受后才发耗时；失败只尝试一次固定失败提示，不自动重试。

5. **最终正文可能越过工具终态**
   - App Server 通知与 iLink 请求是异步的；若不 drain，正文可能先于工具 completed 卡片。
   - 修正：每 run 独立 promise chain，`finalize()` 后才发送正文。

6. **崩溃恢复假称运行中**
   - 持久化 thinking/tool_running 后进程退出，重新打开页面会显示幽灵任务。
   - 修正：加载时把全部非终态记录转换为 interrupted，不自动补发。

7. **敏感工具内容外泄**
   - App Server item 带 command、arguments、cwd、result 等字段，直接转发不安全。
   - 修正：在 `CodexConversation` observer seam 最早阶段映射为固定枚举；后续模块永远拿不到原始详情。

## 仍需在代码 review 验证的不变量

- 所有 typing lease 在成功、失败、超时、关闭路径都只 stop 一次且清除 keepalive。
- progress start/end 对相同 item phase 幂等；未知 item 不发送。
- 进度发送失败不使最终回复失败；最终回复也不被无限等待。
- 同目标 FIFO 与不同目标并行保持不变。
- v1-v3 状态迁移不丢 task、权限、去重或 transcript。
- 页面只显示别名/短 ID、安全枚举和时间，不显示 runId、itemId、参数、路径或输出。

## 方案选择复核

没有引入第二套普通文本“工具进度”协议；直接使用 iLink 原生结构，与官方腾讯插件一致。Typing、进度和网页状态都通过小接口进入现有入站事件与 Codex observer seam，删除任一模块会把协议、顺序、缓存和状态复杂度重新散落到调用者，因此这些模块具备足够深度。
