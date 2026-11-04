# 每日 AI 新闻后台恢复设计审查

日期：2026-08-15

结论：修正下列风险后可实现。

## 已修正的设计问题

1. **把 `failed` 一概重试会造成重复发送**
   - `failed` 也可能来自目标切换或发送被拒绝。
   - 仅 `failureStage=research|archive` 且存在 `nextRetryAt` 才可定时重试。

2. **只在内存设 timer 无法跨重启恢复**
   - `nextRetryAt` 与 `attempt` 必须写入私有账本；启动时重新计算唤醒时间。

3. **归档失败重复消耗 Codex**
   - 研究成功后先持久化同日 preview；归档 retry 优先复用，不重新摘要同一文章。

4. **固定三次后停止不符合“当天继续恢复”**
   - 10、30、60 分钟后保持 60 分钟间隔，直到当天结束。

5. **跨午夜继续发送昨天日报**
   - retry 只对上海自然日等于 runKey 的记录生效；午夜后等待新一天 08:30。

6. **重启时误重发未知发送**
   - `sending -> unknown` 保持不可重试；只有发送前的研究/归档阶段允许恢复。

7. **原始异常可能泄密**
   - 在 scheduler catch seam 映射为固定 code；网页不展示 stderr、prompt、路径或 URL。

8. **同日已有失败记录仍阻断 retry**
   - `catchUpToday` 从“是否存在 run”改为按状态决策：无 run 首次运行；可重试失败到点运行；其他状态不操作。

## 实现 review 必查

- timer 始终只有一个，重复 `start/enable/scheduleNext` 不泄漏。
- attempt 与 delay 没有 off-by-one：首次失败 10m，第二次 30m，第三次起 60m。
- 手动 preview 不修改自动 run 的 retry 账本。
- retry 成功后清除失败字段，发送终态不会残留 `nextRetryAt`。
- v1 状态迁移只恢复两个可明确识别的固定研究/归档错误，其他历史 `failed` 不自动重试。
- 公开状态不包含私有 `error`，UI 时间使用现有格式化函数。
