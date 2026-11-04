# codex-weixin 独立仓库迁移设计

## 目标

把当前分别位于 OpenClaw 工作树中的微信后端 Demo 与 Codex 插件，迁移并统一命名到：

```text
/Users/loong_zhou/git/aloong-planet/codex-plugins/codex-weixin
```

迁移后该目录是唯一的开发源，微信登录状态、会话 token、日报账本与媒体缓存继续使用现有应用数据目录，不进入 Git 仓库。

## 已确认事实

- 后端源码当前位于 `~/.openclaw/workspace/weixin-real-channel-demo`。
- 插件 marketplace 当前位于 `~/.openclaw/workspace/weixin-codex-marketplace`。
- 插件 `.mcp.json` 使用旧插件构建产物的绝对路径。
- 插件 fixture E2E 依赖后端与插件之间的相对目录关系。
- Codex 配置中的本地 marketplace `weixin-local` 指向旧 marketplace 根目录。
- 4317 服务由 launchd submitted job `com.local.weixin-real-channel-demo` 保活，启动命令写死旧后端目录。
- 私有运行状态默认位于 `~/Library/Application Support/weixin-ilink-direct-demo`，不随源码目录变化。
- Obsidian Vault 位于仓库之外，只作为用户授权根目录使用。

## 目标布局

```text
codex-weixin/
├── .agents/plugins/marketplace.json
├── apps/
│   └── weixin-service/
├── plugins/
│   └── codex-weixin/
├── docs/
├── package.json
├── pnpm-lock.yaml
└── pnpm-workspace.yaml
```

命名统一为：

- 仓库：`codex-weixin`
- 插件目录与 manifest `name`：`codex-weixin`
- 后端 package：`@aloong-planet/codex-weixin-service`
- marketplace：`codex-weixin-local`
- launchd submitted job：`com.local.codex-weixin`
- 用户界面名称：`微信直连助手`

## 数据边界

以下内容不复制进新仓库：

- `node_modules/`
- `dist/`
- `test-results/`
- 微信凭据、token、账户原始 ID 和私有状态文件
- Codex 任务/session 数据
- Vault 正文与日报归档

以下内容继续从原位置读取：

- `~/Library/Application Support/weixin-ilink-direct-demo`
- 用户已选择的 demo Vault
- Codex 自己管理的插件 cache 与任务存储

## 迁移步骤

1. 在目标目录创建独立 Git 仓库，默认分支为 `master`，然后建立 `codex/migrate-codex-weixin` feature 分支。
2. 只复制受版本控制的源码、文档、测试和锁文件；排除构建产物与运行状态。
3. 建立 pnpm workspace，把后端放入 `apps/weixin-service`，插件放入 `plugins/codex-weixin`。
4. 更新 package、fixture E2E、README、manifest；MCP 入口使用相对插件安装根的 `dist/server.mjs`，不保留用户绝对路径。
5. 先验证新仓库，不触碰正在运行的 4317 服务。
6. 使用 Codex CLI 移除旧本地 marketplace 来源、添加新 marketplace，并安装 `codex-weixin` 插件；不手改 `~/.codex/config.toml`。
7. 停止且仅停止旧 submitted job，使用相同外部状态目录从新仓库启动 `com.local.codex-weixin`。
8. 验证 4317 页面、状态 API、fixture E2E 与插件面板。验证过程中不生成二维码、不发送微信消息。
9. 旧源码目录暂时保留为只读回滚副本；确认新仓库稳定后再单独决定是否移入废纸篓。

## 用户操作序列与失败模式

### 开发与安装

1. 用户从 Codex 打开插件。
2. Codex 从新 marketplace 找到 `codex-weixin`。
3. MCP Server 从新插件 cache 启动并访问 `127.0.0.1:4317`。

可能失败：

- marketplace 仍指旧目录：插件更新继续从旧源码安装。
- `.mcp.json` 仍含旧绝对路径：插件安装成功但 MCP Server 无法启动。
- cachebuster 未更新：Codex 继续使用旧缓存版本。
- 当前任务已加载旧插件：新插件需要新任务才能完整拾取。

### 后端恢复

1. 新服务读取既有外部状态。
2. iLink 监听恢复。
3. 页面显示当前连接、目标、日报状态。

可能失败：

- 两个服务同时监听 4317：新服务报 `EADDRINUSE`。
- 旧 launchd job 仍 keepalive：停止子进程后旧服务自动拉起。
- 新 cwd 改变 Codex 授权根目录：页面应显示新项目路径，既有权限配置中的 root ID 仍需按 ID 兼容。
- 外部状态权限异常：服务不得创建空状态覆盖原状态。
- iLink 重连不代表真实微信收发已验证；真实入站/出站需要用户在场验证。

### 日报

1. scheduler 从既有 ledger 恢复。
2. 当日已接受发送的任务不得因迁移重复发送。
3. 失败任务仍按原重试时间继续。

可能失败：

- 状态目录变化导致 ledger 丢失并重复执行。
- 切换时正有 research/send job：必须先检查运行状态，避免在发送未知时切换。

## 验证标准

- `pnpm install` 在新仓库成功并只生成一个 workspace lockfile。
- 根级 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全绿。
- 插件 fixture E2E 与 UI E2E 全绿。
- `validate_plugin.py` 接受新插件目录。
- `codex plugin list` 显示 `codex-weixin` 来自新 marketplace。
- 4317 只有一个 listener，父 job 为 `com.local.codex-weixin`，启动命令使用新目录。
- `GET /api/state` 返回 200，且不暴露 token、凭据或完整敏感数据。
- 页面可打开；不自动生成二维码、不自动发送微信消息。
- 外部状态目录路径未改变，日报 ledger 未重置。

## 实施结果

- 新仓库已创建在目标目录，并使用 `codex/migrate-codex-weixin` 分支。
- marketplace 与插件已统一为 `codex-weixin-local` / `codex-weixin`，旧 `weixin-local` 注册和旧插件安装已通过 Codex CLI 清除。
- 插件 cachebuster 为 `0.1.0+codex.20260815092100`。
- launchd job 已切换为 `com.local.codex-weixin`，4317 只有一个 listener。
- 切换后公开状态保持 `ready`，账户和目标存在，当日日报状态保持 `accepted`。
- MCP 安装缓存已实际启动并完成只读 `get_weixin_state` 调用。
- 最终验证：lint、typecheck、245 个单元/集成测试、全量 build、2 个插件 E2E、1 个浏览器 E2E 全部通过。

## 回滚

- 在删除旧源码前保留旧目录。
- 若新服务启动失败，停止新 job 后可用原命令恢复旧 job。
- marketplace 切换失败时，用 Codex CLI 重新添加旧 marketplace；不直接编辑配置文件。
- 任何发送结果为未知时都不因迁移自动重发。
