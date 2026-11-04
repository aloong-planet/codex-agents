# Memory Curator 专用运行时优化设计审查

审查对象：`memory-curator-runtime-optimization-design.md`

## 结论

设计可以实施。它把变化限制在 App Server conversation 的可选运行档和 Curator prompt 组装，不修改账户记忆安全权威，也不影响普通微信聊天。

## 审查发现与处理

1. **只换快模型不能去掉通用指令**
   - 已要求同时使用专用 `baseInstructions`、动态 JSON 和 Curator 专属 feature 最小化子进程；模型选择只是延迟优化的一部分。

2. **把所有规则放回每轮 prompt 会继续重复计费**
   - 固定规则只存在于 thread 级 base instructions；turn 仅发送变化数据。测试分别锁定两层合同。

3. **复用 thread 可提高 cache，但会跨 job 累积上下文**
   - 拒绝复用。账户隔离、可解释 token 上限和无历史污染优先于潜在 cache 收益。

4. **直接让模型输出 JSON 可省去工具往返**
   - 拒绝。模型自然语言或 JSON 不是提交凭据；tool host 的绑定、CAS、证据验证和 receipt 必须保留。

5. **显式 developer instructions 能否覆盖通用开发层**
   - 实测空字符串会回退，非空文本只追加，均不能替换核心开发说明。正式实现已删除该无效字段，改为关闭 Curator 不需要的稳定 features；剩余固定上下文如实保留在验收结果中。

6. **运行档字段可能误伤主聊天**
   - profile 是 opt-in；测试要求未配置 conversation 的 payload 不含 `model`、`baseInstructions`、`developerInstructions` 或 `effort`。

7. **更快模型可能降低记忆判断质量**
   - 宿主安全不变量不依赖模型。保留现有黄金 case，并覆盖 no-op、事件、修订歧义和工具回执缺失。真实探针只验证运行时开销，不用单次 no-op 宣称语义质量已全面等价。

8. **延迟目标可能受服务端排队与缓存波动影响**
   - 4–7 秒和 5k–10k 是观测目标，不作为功能成功的硬门禁；交付报告实际数值和剩余瓶颈。

9. **关闭过多 feature 可能破坏动态记忆工具**
   - 隔离真实探针已在关闭列表下完成一次 `account_memory_commit` no-op receipt，证明当前版本的动态工具链不依赖被关闭 features；定向测试锁定参数列表和普通子进程不变。

10. **固定 feature 名称可能随 Codex 升级漂移**
    - 当前列表全部来自本机 App Server `features list` 的 stable 项。未来若不再接受，启动应显式失败并由既有诊断/重试暴露，不能自动扩大运行档。

## 实现门禁

- 先写 conversation payload 红测，再实现 runtime profile。
- 再写 Curator 动态 JSON 红测，再移动固定规则。
- 每个纵切运行目标单测和 typecheck。
- 完成后进行代码 review、测试 review、全量验证，再回同步设计。
