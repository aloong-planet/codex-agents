# Typing 脱敏诊断设计审查

## 审查结论

设计可实施，且不需要改变真实微信协议行为。实现前补齐以下约束：

1. `skipped` 必须显式存在，不能用 `0ms completed` 混淆缓存命中与真实请求。
2. inactive lease 也必须带诊断，否则最需要解释的失败路径反而不可见。
3. 诊断必须在 `typing_start` 完成后与同一 run 一起保存，不能写“最近全局诊断”，避免并发目标串线。
4. store loader 必须逐字段白名单验证，不能用对象 spread 将未来或恶意字段带到网页。
5. 现有 `typing_start`、acknowledgement、keepalive、stop 与缓存失效行为不得改变。
6. 不在本次实现 ticket 预取。官方方案的可复制部分已确认，但先通过诊断数据判断 `getconfig` 是否真的占主要耗时。

## 被否决方案

- 在 HTTP adapter 打印调试日志：日志难以关联 run，且更容易意外记录请求元数据。
- 给 `start()` 传进多个阶段 callback：实时性略好，但把内部协议步骤暴露给业务调用者，interface 变浅。
- 将三个子阶段塞入顶层 `timings` 数组：会挤占当前仅保留 12 条的总阶段历史，并把父子时间重复计入整体耗时。
- 扫码完成即预取：缺少具体 target/context token，不满足 iLink `getconfig` 请求前置条件。

## 成功标准

- 同一个 run 能回答 cache hit/miss、getconfig 耗时、sendtyping 耗时。
- 任意公共状态和页面内容都不包含 ticket、token、完整 ID、请求正文或 URL。
- 老状态、typing 不可用、并发目标、重启恢复均不会报错或伪造诊断。
