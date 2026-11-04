# ADR-0012: 定向自动网络观测与集中渠道协议诊断

- 状态: 已被 ADR-0013 取代

## 背景与问题

六项图片发送中，第一项上传结果未知、后五项接受。旧证据没有保留上传失败的具体类别；只观察外层工作流无法恢复已被内部捕获的错误。全局自动网络库还需要与既有业务上下文、脱敏出口及生命周期接线。

## 备选项

1. **定向网络 instrumentation + 集中渠道协议 Adapter + 既有 Engine/ToolHost seam**：采用，网络时序自动获取，协议失败在捕获前集中分类。
2. 仅安装自动 instrumentation：不采用，HTTP 成功不能证明业务回执有效，且不会自动补齐 Run 与逐项 Effect 关联。
3. 每个业务函数手动埋点或全对象 Proxy：不采用，重复、噪声多、难守隐私边界。
4. Collector/独立诊断平台：仍暂缓；出现多机集中检索需求时再评估。

## 决策

采用方案 1，取代 ADR-0011 的“不注册全局自动采集”选择，其本地有界存储、安全投影与业务真源约束全部保留。

- 一个进程的 Telemetry Runtime 注册 NodeTracerProvider 与标准异步上下文，显式本地 SpanProcessor，无外部 exporter、resource detectors 或传播头。业务活动上下文内、受控渠道主机的 native fetch/Undici 和 node:http/https 请求自动观察；不自动采集 SQL、文件、模型正文。
- 使用官方 Undici/HTTP instrumentation，锁定兼容版本。Node 内建 HTTP 的 CJS/ESM 引用在启停时同步；HTTP instrumentation 重用其模块 hook，避免重复初始化丢失已缓存模块的补丁。源码 tsx 与构建 ESM 均通过真实本地请求验收。
- 首个渠道纵切覆盖图片和普通文件共用的获取上传地址、CDN 上传、消息提交；集中 ChannelTransport 消费响应一次，并保留安全 HTTP 状态、提供方数字代码、网络代码和错误类别。文本回复独立阶段计时与登录流程不在本次协议 Adapter 收拢范围，不能据此声称这些路径也具有同等协议细节。
- Engine 统一补冻结序号/总数、Effect 关联及批量计数；HTTP 子项继承允许的关联字段。accepted 计数来自实际 Effect 结果，不代表手机收到。任一 unknown 继续执行既有后续项但不自动重发该项。
- 安全投影扩展为 v2，读取器兼容 v1/v2。HTTP URL、headers、body、原始异常和 stack 不导出，未知技术代码落入有限类别。开始 checkpoint 不等待 Span 完成。自动采集初始化失败留下安全可用性证据；写盘失败不影响业务。
- 保持用户日志目录、本地 7 天/20 MiB 分片/200 MiB 总量/512 文件上限、队列与记录预算；进程关闭仍由宿主的 5 秒等待预算约束。Trace/Span 不替代持久 Run/Effect，不跨进程传播隐式内存上下文。

## 后果

- 正面：可通过正式本地 reader 定位哪一项在哪个请求阶段失败，并区分断流、超时、主动取消、HTTP 拒绝、解析错误、提供方拒绝和缺回执。
- 成本：维护定向 instrumentation 生命周期和安全字段契约；额外 Span/checkpoint 增加文件量，仍受现有容量与丢弃机制约束。
- 限制：无法恢复旧事故未采集的异常；诊断不证明手机收件，也不能把未闭合记录认作仍在执行。SDK 自动错误事件不直接输出原文，网络细节以集中协议记录为准；未知原因不强行归因。

## 来源

- 用户于 2026-09-10 确认按低侵入方案实施。
- [低侵入调研方案](/Users/loong_zhou/research/agent-diagnostics-frameworks/otel-low-intrusion-plan-2026-09-10.md)
- [官方实现证据](/Users/loong_zhou/research/agent-diagnostics-frameworks/otel-auto-instrumentation-evidence-2026-09-10.md)
- [workflow-runs spec](../specs/workflow-runs.md)，边界 51–62。
