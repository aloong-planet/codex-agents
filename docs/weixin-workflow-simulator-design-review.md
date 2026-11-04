# 微信工作流入站模拟器设计审查

## 结论

设计通过，可以实施。模拟器必须停在 fixture-only seam，不得在生产 HTTP 服务增加调试开关，也不得复用生产 state 目录。

## 审查发现

- **原方案若只调用 `createNotesWorkflowProductionControl` 会漏掉真实入站装配问题。** 修订为从 FixturePort 发出标准 `InboundTextEvent`，由 WeixinCodexService 驱动工作流。
- **确定性 Planner 会掩盖 live Planner 的 ordinary_chat 错判。** 保留两种 adapter：CI 默认确定性，诊断可显式选择 live；两者共享其余完整链路。
- **只看回复无法证明发送了正确文件。** 增加 fixture-only 脱敏 outbox，记录经过 Provider 安全校验后的文件名/显示路径；不暴露绝对路径。
- **模拟选择必须保持同一进程。** 多条请求共享临时 Engine/SignalInbox；不为第二条消息新建 fixture。
- **任意真实 Vault 会扩大写入风险。** v1 只用临时 fixture Vault；真实数据检索另行设计只读 replay，不并入本轮。
- **外发结果不能伪装手机已收到。** fixture 结果明确标注 simulated accepted；只证明工作流到达假外发 seam。
