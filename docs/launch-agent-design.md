# codex-weixin LaunchAgent 设计

## 目标

把本地微信直连服务作为当前 macOS 用户的 LaunchAgent 常驻运行，确保 08:30 日报调度不依赖某个终端或 Codex 任务持续打开。首次安装并加载时，复用既有私有状态和日报 ledger；若当天 08:30 已过且今日尚未运行，由现有 `catchUpToday()` 补跑一次。

## 已确认事实

- 当前 4317 没有监听进程，`com.local.codex-weixin` 与旧 `com.local.weixin-real-channel-demo` 均未加载。
- 日报配置仍启用，2026-08-19 尚无 run，启动服务会进入真实补跑路径。
- 服务默认状态目录位于 `~/Library/Application Support/weixin-ilink-direct-demo`，不依赖源码 cwd。
- `DailyAiNewsScheduler` 以 date run key 去重；同日一旦有 run，不会因 LaunchAgent 重启重新创建正常 run。
- 服务运行需要 Node、pnpm、仓库依赖和 ChatGPT App 内置 Codex 可执行文件。

## 方案

新增仓库内的 LaunchAgent 配置生成模块和安装命令：

- label：`com.local.codex-weixin`
- plist：`~/Library/LaunchAgents/com.local.codex-weixin.plist`
- cwd：`apps/weixin-service`
- 命令：绝对路径 `pnpm start`
- `RunAtLoad=true`
- `KeepAlive=true`
- `ThrottleInterval=10`
- 日志：`~/Library/Logs/codex-weixin/stdout.log` 与 `stderr.log`
- Keep a minimal PATH and resolve Codex with the same rule as service startup: honor a working explicit path; recover a missing known bundled path through the installed legacy or nested app layout. Missing custom paths fail. News research resolves again before each new subprocess. No shell profile or Weixin secrets enter the plist.

安装流程：

1. 校验 cwd、pnpm 和 Codex 可执行文件存在。
2. 检查旧 label 未加载；若存在则拒绝，避免两个 4317 服务。
3. 对同 label 执行精确 `bootout`，以便幂等更新。
4. 原子写 plist 并设为 0644；日志目录设为 0700。
5. `launchctl bootstrap gui/$UID <plist>`；`RunAtLoad` 负责唯一一次启动。
6. 轮询只读公开状态与去敏日报 ledger，确认服务就绪以及今日 run 状态。

## 用户操作序列与失败模式

### 首次安装并补跑

1. 用户明确要求安装并补发。
2. LaunchAgent 启动服务。
3. scheduler 发现今日无 run，进入 research → archive → send。
4. `accepted` 只表示微信渠道接受；仍由用户确认手机实际收到。

失败模式：

- 4317 已被未知进程占用：服务反复退出。安装后必须检查 listener 与 launchd job PID 一致。
- Codex 路径或依赖缺失：进程退出，launchd 节流重试；日志只记录去敏 stderr。
- research/archive 失败：沿用现有退避 ledger，不盲目重发。
- send 结果 unknown：ledger 禁止自动重发，避免重复消息。
- 安装期间已有今日 accepted：`catchUpToday()` 不发送第二次。
- plist 写入成功但 bootstrap 失败：报告未启动，不宣称补发。

### 后续登录与退出

- 用户登录后自动启动；服务异常退出后自动拉起。
- 有意停用必须执行仓库提供的 uninstall/bootout 命令；单独 kill 子进程会被拉起。
- 卸载只移除 LaunchAgent，不删除私有状态、日报 ledger、Vault 或微信凭据。

## 验证

- 单测生成的 plist：无 shell、无 watch、无敏感字段，含唯一 label、绝对路径、RunAtLoad、KeepAlive 和日志。
- lint、typecheck、全量测试、build。
- 安装后 `launchctl print gui/$UID/com.local.codex-weixin` 为 running。
- 4317 只有一个 listener，公开状态 200。
- 今日 ledger 从 absent 进入 researching/archiving/sending，最终按真实结果报告 accepted/failed/unknown。

## 设计审查

- 选择 `pnpm start` 而非 `pnpm dev`，避免 watch 常驻带来的额外 CPU。
- 不使用 `/bin/zsh -lc`，避免隐式加载用户 shell 配置和秘密。
- 不把状态目录搬进仓库，保证安装不会丢失 context token、绑定或日报去重记录。
- `RunAtLoad` 与 `bootstrap` 只触发一个启动，不额外 kickstart，减少补跑竞态。
- 保持发送幂等边界：LaunchAgent 只保证进程存活，不绕过 scheduler ledger。

## User-requested work scheduling

Use `ProcessType=Standard` for the service and its file workers. It remains a persistent LaunchAgent; this classification avoids the explicit Background resource policy for user-requested scans. Startup and keepalive are unchanged. Apply to installed configuration on authorized deployment and verify the loaded job; editing the generator alone does not change a running installation.
