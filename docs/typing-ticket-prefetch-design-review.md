# Typing ticket 预取设计审查

## 审查结论

方案可实施，但必须避免“只把 await 前移”和上下文竞态。实现约束如下：

1. 预取必须在 durable ingest 或私有状态保存成功之后启动，不能在消息可能丢失时先产生外部副作用。
2. `prefetch` 不返回 ticket，也不要求调用者处理 Promise；并发复杂度留在 typing 深模块内。
3. in-flight key 必须包含 account 和 target；只按 target 会跨账户复用。
4. 负缓存必须关联请求使用的 context。新 context 可以绕过旧失败，相同 context 必须退避。
5. 失败后的新 context 重试仍通过同一个 in-flight map，防止多个等待者同时重试。
6. close generation 必须阻止旧请求完成后重新写缓存。
7. startup warm-up 只使用已持久化 context，最多 3 个目标；fresh login 不做猜测性请求。
8. 现有诊断校验需允许“负缓存命中”的一致组合，不能因新增路径导致整个服务状态加载失败。

## 被否决方案

- 在登录/扫码完成时调用 `getConfig`：缺少可靠 target/context，官方生产路径也未验证。
- 在业务 FIFO 中先 `await prefetch`：会把延迟从 typing 阶段搬到 inbound/queue，不能并行。
- 每条消息独立请求：浪费请求并增加腾讯限流与尾延迟风险。
- 持久化 ticket：扩大敏感凭据落盘面，且服务器有效期不明确。
- 让 DirectIlinkChannel 自己维护 Promise map：缓存和并发规则会分散在渠道与 typing 两处，降低 locality。

## 成功标准

- 同目标并发只观察到一次 `getconfig`。
- 预取完成后 `startTyping` 不再调用 `getconfig`。
- 新 context 能从旧 context 的失败中恢复，且不形成重复请求。
- 所有失败均只影响“正在输入”，不阻断回复主链路。
