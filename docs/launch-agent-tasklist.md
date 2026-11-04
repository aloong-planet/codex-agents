# LaunchAgent 实施任务清单

- [x] 核对现有服务、旧 label、启动依赖和日报 ledger
- [x] 对齐常驻、登录启动、异常拉起与今日补跑边界
- [x] 写设计并完成设计审查
- [x] 红：生成安全、稳定的 LaunchAgent plist
- [x] 绿：实现配置生成与 install/uninstall/status 命令
- [x] review 实现与测试
- [x] 跑 lint、typecheck、全量测试、build
- [x] 安装并加载唯一 LaunchAgent
- [x] 验证 4317、launchd PID 与今日补跑结果
  - `com.local.codex-weixin` 已运行，4317 仅有一个监听进程
  - 2026-08-19 日报已完成研究与 Vault 归档；真实发送因缺少同一目标的新入站上下文进入 `pending_inbound`，收到新消息后自动补发
- [x] 回同步设计与任务清单
