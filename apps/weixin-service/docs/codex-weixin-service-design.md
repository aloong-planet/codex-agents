# 独立 Codex App Server 微信聊天服务设计

## 目标

在现有直连 iLink Demo 进程内启动唯一的 Codex App Server 子进程，由它创建并持有一个
新的持久 Codex thread。用户在网页对已发现目标明确启用自动回复后，微信文本入站被串行
提交给该 thread，最终文本使用该条入站自己的 context token 原路回复。

不 fork、不恢复当前 Codex 任务、不调用 OpenClaw runtime，也不启动第二个 iLink
`getupdates` 消费者。App Server 继承本机 Codex 配置、项目规则、Skills 与插件；首版拒绝
所有命令、文件、权限、MCP elicitation 和用户输入审批，不使用危险跳过参数。

## seam

1. `DirectIlinkChannel.onInboundText` 只在消息严格为 USER 文本、context token 已成功落盘后
   发布事件。事件携带安全元数据、正文以及捕获了当次 token 的 `replyText` 闭包；token 不离开
   channel 模块。
2. `CodexConversation` 持有一个 stdio App Server，负责 `initialize`、`thread/start|resume`、
   `turn/start`、流式回复和审批拒绝。单个实例一次只允许一个 turn。
   `thread/start` 使用本机协议定义的 `sandbox: "workspace-write"` 与
   `approvalPolicy: "untrusted"`；命令/文件审批返回 `decision: "decline"`，用户输入、MCP
   elicitation、动态工具和其他 server request 按各自协议返回安全拒绝，不用伪造统一响应。
3. `CodexServiceStore` 使用 Demo 私有目录中的独立 `codex-service.json`（0700/0600），保存
   thread ID、明确启用的 `(accountId,target)`、有界已处理键和有界聊天记录，不保存 iLink token。
4. `WeixinCodexService` 串行消费入站：先持久标记已处理，再调用 Codex，再调用捕获 token 的
   reply；任何未知发送结果都不自动重试。
5. `DemoService` 只暴露脱敏服务状态、启停动作和聊天记录；网页不能提交任意 thread ID、
   context token 或 App Server 参数。

## 状态与真实操作序列

```text
disabled -> enabling -> starting_app_server -> creating_thread -> enabled/idle
enabled/idle -> inbound -> thinking -> sending -> enabled/idle
                              |           \-> send_failed
                              \-> agent_failed
enabled/* -> disabled
```

1. 用户扫码并从微信发消息，目标按原流程同步。
2. 用户选择目标、确认入站并点击“启用 Codex 自动回复”。启用状态原子落盘。
3. 首次有效入站到达时，服务启动 App Server 并创建新 thread；thread ID 成功落盘后才处理。
4. 同一目标的新 USER 文本依次进入队列；BOT、媒体、空文本、未授权目标直接忽略。
5. 入站唯一键在调用 Codex 前落盘；崩溃或失败不自动重放，避免重复回复。
6. Codex 回复限制为微信单条可接受的简短文本；过长时安全截断并标记。
7. iLink `ret=0` 只记录“渠道接受”；失败/超时记录未知且不重试。
8. 重启时恢复专用 thread 与启用目标；App Server 重新启动后 `thread/resume`。

## 失败模式

- App Server 缺失、认证失败、thread 创建/恢复失败：保持服务错误，不向微信伪报成功。
- Codex 请求工具审批：客户端返回 decline；若仍能生成文本则正常回复，否则记录 agent_failed。
- 新入站在上一 turn 期间到达：排队并保留各自 reply 闭包，不能读取最新可变 token。
- iLink 游标已保存但进程在事件落盘前崩溃：消息可能丢失；首版明确接受此窗口，不伪称 exactly-once。
- message ID 唯一性未获腾讯保证：使用账户、目标、message_id、seq、client_id、时间组成哈希，
  有界持久去重只提供 at-most-once 防护，不宣称协议级唯一。
- 关闭：先取消入站订阅，再关闭 App Server；不删除 thread、凭据或记录。

## 验证

- TDD：入站 USER 文本过滤、捕获 token 回复、持久授权/去重、thread 创建与恢复、串行顺序、
  审批拒绝、Codex/发送失败不重试、公开状态无 token。
- 全量 lint、typecheck、单测、build、fixture E2E。
- 真实验证阶段只启动服务并等待用户从已授权微信目标发送一条测试消息；不得自行发送未知消息。
