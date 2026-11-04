# Memory Curator 单轮结构化决策设计审查

## 结论

设计可以实施。它减少模型输入和一次模型往返，但没有把模型输出升级为写入授权；安全权威仍在宿主。

## 审查发现

1. **仅按长度 no-op 会漏掉短偏好和事件**
   - 2026-08-17 用户后续明确改为字素数 `<= 3` 无条件 no-op；白名单条件已删除，短语义信息也会跳过。
2. **outputSchema 不是工具回执**
   - 模型只返回候选决策；宿主等待 turn 完成后主动提交，并以真实 receipt 判断结果。
3. **直接提交可能绕过旧动态工具校验**
   - 把校验和 apply 提取为同一可信实现，动态 adapter 与直接调用共用，禁止复制两套逻辑。
4. **候选集可能漏召回**
   - 候选不决定授权；明确 target 强制加入，提交仍读取完整权威 entries。搜索失败不回退完整 Markdown。
5. **候选查询本身可能增加延迟**
   - 复用已有本地 index 和 15 秒上限；记录 search duration。后续以实际 p95 决定是否缓存，不先增加新缓存层。
6. **崩溃窗口会不会重复写**
   - 保留 batchId 和 Store receipt 幂等；同 batch 重放返回原回执。
7. **保留普通 thread 会继续产生 rollout**
   - 这是用户明确取舍；不改变持久化/诊断行为。
8. **collaboration mode 是否顺带上线**
   - 不上线。它是独立实验优化，无法替代 Skills/AGENTS 层，避免与主纵切混合。
9. **普通 conversation 是否误带 schema**
   - output schema 作为 opt-in runtime profile 字段，只在 Curator conversation 使用，并由回归测试锁定。
10. **删掉 dynamic tool 会不会影响媒体/Vault 工具**
    - 只移除 Curator conversation 构造时的 `accountMemoryTools`；通用 `CodexConversation` 动态工具机制和其他 host 不改。

## 实现门禁

- 纵切一：短消息 gate 红 -> 绿 -> typecheck。
- 纵切二：候选输入红 -> 绿 -> typecheck。
- 纵切三：conversation outputSchema + Curator 直接提交红 -> 绿 -> typecheck。
- 完成后分别审代码与测试，再跑 lint、全量测试和不写真实记忆的 App Server probe。
