# 正文发送与 typing 关闭并行设计审查

## 审查结论

方案可实施，必须满足以下不变量：

1. “并行”指两个外部请求都已启动，不能只是把 `await` 移到另一个顺序位置；
2. outbound 计时必须在正文 Promise 自身完成时关闭，不能等 `Promise.all` 后才关闭；
3. typing 与正文结果相互隔离，任何一边失败都不能覆盖另一边的真实结果；
4. 运行完成和同目标 FIFO 暂时仍等待两边收口，避免上一轮迟到的 `status=2` 关闭下一轮 typing；
5. 所有最终用户提示都使用同一内部方法，不能只优化成功路径；
6. 不自动重试未知的 typing 或正文请求；
7. 不新增 token、ticket、正文或完整目标诊断字段。

## 被否决方案

- fire-and-forget `stopTyping()` 后立即结束运行：会让迟到的 `status=2` 与下一条消息发生跨轮竞态，且丢失可靠计时；
- 先 `await replyText()` 再启动 stop：正文快，但 typing 会无必要地持续显示；
- `Promise.all` 返回后才完成两个 timing：会错误地把 9 秒 typing 等待计入 853 ms 的 outbound；
- 只修改成功回复：模型失败时仍会被同一慢请求阻塞，形成行为分叉。

## 成功标准

- deferred stop 未 resolve 时正文已经被调用；
- 正文阶段耗时不再包含 stop 等待；
- 两项都完成后运行状态、FIFO 和 memory capture 正常收口；
- 全量 lint、typecheck、单测与 fixture E2E 通过。
