# 正文发送脱敏耗时明细设计审查

## 审查结论

设计可实施，细分位于 `DirectIlinkChannel` 深模块，聊天主流程只消费一个可选 diagnostics 结果，没有泄漏 iLink 实现细节。

## 审查发现与修正

1. **仅计一次请求会误导多段与重试。** 已改为同类阶段累计，并增加脱敏 `requestCount`。
2. **把 `fetch + response.json()` 放在同一桶无法判断服务端等待还是响应体读取。** 设计要求拆开 authenticated request 准备、fetch 和 `readJson`。
3. **本地保存失败不能把已接受发送改成失败。** `stateSave` 只报告辅助状态保存结果，保持渠道接受事实不变。
4. **只放在内存会导致刷新后消失。** diagnostics 进入 `TargetRuntimeRun`，并由 store 严格 allowlist。
5. **失败步骤后未执行的阶段不能显示 0 ms completed。** 初始状态为 skipped，实际进入阶段后再改为 completed/failed。
6. **不能让模型或网页看到正文、响应或凭据。** 类型和 parser 只允许耗时、固定 outcome 和请求次数。
7. **总桶必须保持原语义。** `outbound` 仍包围完整 `replyText()`，细分之和用于解释而不替代总耗时；少量计时/调度开销允许造成差值。
8. **请求准备异常可能泄漏 Abort 定时器。** 实现审查要求 prepare 失败路径立即 `clearTimeout()`，并保持现有 unknown/至多一次重试语义。
9. **页面断言不能依赖相邻 DOM 节点自动产生空格。** E2E 分别断言“请求”和“1 次”，避免把排版空白当成业务文本造成假红灯。

没有发现需要用户进一步决策的分支。
