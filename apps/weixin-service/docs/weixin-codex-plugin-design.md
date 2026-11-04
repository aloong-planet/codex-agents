# 微信 Codex Plugin 内嵌面板设计

## 目标

把现有个人微信直连 Demo 作为权威后台，通过一个本地 Codex Plugin 暴露 MCP 工具和
MCP Apps 内嵌面板。用户在 Codex 对话中打开面板后，可以查看真实连接状态、生成真实
二维码、提交条件数字码、等待手机授权、自动同步入站目标、确认会话，并在单独确认后发送
测试消息。

完成标准：

1. Plugin 有有效 `.codex-plugin/plugin.json`、`skills/` 和 bundled `.mcp.json`。
2. MCP Server 仅连接 `http://127.0.0.1:4317`，不读取 Demo 私有状态文件。
3. `show_weixin_panel` 返回 `text/html;profile=mcp-app` 资源并在 Codex 对话内渲染。
4. 面板动作通过 MCP `tools/call` 进入服务端代理；组件不直接请求 Demo HTTP API。
5. 模型可读结果只包含脱敏状态；二维码图片只进入组件私有的工具结果元数据。
6. fixture 模式完成二维码、目标确认和发送接受的端到端验证；真实测试停在用户扫码或显式发送前。

## 非目标

- 不把 Demo 进程、微信凭据或 Vault 数据复制进 Plugin 缓存。
- 不在本纵切安装 LaunchAgent；继续复用当前运行中的独立 Demo 服务。
- 不修改腾讯插件源码、OpenClaw 配置或现有微信账号状态。
- 不自动扫码，不自动确认目标，不向真实微信发送测试消息。
- 不承诺安装后的当前 Codex 任务动态获得新 MCP 工具；插件重装后以新任务验证。

## 结构

```text
Codex Plugin
  ├─ skills/codex-weixin/SKILL.md
  ├─ .mcp.json
  └─ bundled MCP server
       ├─ MCP tools
       ├─ MCP Apps UI resource
       └─ DemoHttpClient
                    │ same-origin-shaped local HTTP
                    ▼
        http://127.0.0.1:4317
                    │
                    ▼
     DemoService → DirectIlinkChannel → Tencent iLink
```

Plugin 源码位于独立仓库的 `plugins/codex-weixin/`；后端位于
`apps/weixin-service/`。MCP server 使用构建后的单文件 Node 入口，`.mcp.json`
通过 `cwd: "."` 和 `dist/server.mjs` 从插件安装根启动，不依赖源码绝对路径。

## 工具接口

### `get_weixin_state`

只读。读取 Demo `/api/state`，返回模型和组件都可见的脱敏状态：阶段、提示、账户别名、
目标别名与时间。删除 `qrDataUrl`、Codex transcript 和日报草稿等与连接面板无关的内容。

### `show_weixin_panel`

只读渲染工具。返回同一脱敏状态，并关联 `ui://codex-weixin/panel.html`。原始
`qrDataUrl` 仅放在工具结果 `_meta`，不写入 `structuredContent` 或文本 `content`。

### `start_weixin_login`

有副作用。POST `/api/login/start`，准确标注会发起一次真实 iLink 登录；不自动重试。
返回脱敏状态与组件私有二维码元数据。

### `submit_weixin_pair_code`

有副作用。只接受 1–12 位数字并 POST `/api/login/code`。

### `discover_weixin_targets`

刷新状态。POST `/api/session/discover`；不读取入站正文或 channel 日志。

### `confirm_weixin_session`

有副作用。只接受服务已返回的 `accountId` 与 `target`，并要求显式
`inboundConfirmed=true`。模型和 UI 都不能替用户自动确认。

### `send_weixin_test_message`

有外部副作用。只接受非空、最多 450 字符的文本。面板必须先勾选“我确认发送”，按钮
才可用；服务端仍依赖 Demo 的 ready 门禁。失败或未知不自动重发。

## MCP Apps 面板

- 使用内联卡片，不复制完整网页导航。
- 初始状态来自 `show_weixin_panel` 工具结果。
- 按钮通过标准 MCP Apps `tools/call` 调用工具。
- 面板打开期间每 2 秒调用 `get_weixin_state`，用于连接后与收到新入站后的自动同步；成功
  轮询静默，不覆盖“已确认/渠道已接受”等动作反馈，失败会显示可恢复错误。
- 二维码 `img` 只读取工具结果 `_meta.qrDataUrl`，状态刷新不能把旧二维码误保留到新 login generation。
- 账户与目标默认显示别名，原始 ID 放在折叠高级信息中。
- 已连接但没有入站目标时，明确提示用户先从手机微信发一条消息。
- 有一个目标时可以预选，但不能自动确认；多个目标必须由用户选择。
- 账户或目标一旦改变，立即撤销发送就绪与两项确认，防止视觉目标和服务端已确认目标错位。
- 发送结果只显示“渠道接受”或准确失败，不声称手机已收到。
- 组件 host 不支持 MCP Apps 时，工具仍返回可读的脱敏文本状态。

## 真实操作序列与失败模式

1. **插件未加载**：当前任务在安装前已创建，看不到工具；要求新建任务，不修改全局配置规避。
2. **后台离线**：面板显示无法连接 `127.0.0.1:4317`，不启动第二份 Demo，不读取状态文件。
3. **打开面板**：读取状态失败时显示可恢复错误；成功时只渲染权威快照。
4. **点击生成二维码**：若已有登录或真实发送进行中，显示 Demo 返回错误；不终止未知流程。
5. **等待二维码**：只有限次轮询；超时后保留“刷新状态”，不自动再发登录请求。
6. **手机扫码**：二维码只显示在 Codex iframe；扫码、确认和可能的数字码都由用户在手机完成。
7. **数字码**：格式错误在组件和 MCP server 两层拒绝；不记录输入值。
8. **连接成功**：账户出现不代表能发送；必须等待该账户新的入站目标与 context token。
9. **目标同步**：新入站自动出现在快照；旧目标存在不等于 context token 永久有效。
10. **确认目标**：账户/目标不匹配或目标未由入站发现时由 Demo 拒绝。
11. **发送测试**：必须先确认会话、输入消息、勾选显式发送确认；并发发送或未知结果不重试。
12. **组件关闭/重开**：业务状态从 Demo 重取；不依赖 iframe localStorage。

## 安全边界

- MCP server 只允许固定 loopback base URL；环境覆盖也必须通过 loopback 校验。
- POST 带与 Demo 完全相同的 `Origin`，但不向其他域发送。
- 不返回 token、context token、QR 源 URL、账号秘密、日志或入站正文。
- `qrDataUrl` 只能是 `data:image/png`；其他 scheme 拒绝进入 UI 元数据。
- 工具安全注解区分只读、可逆本地状态和外部发送。
- HTML CSP 不开放外部 `connectDomains`；所有网络动作必须走 MCP tools。

## 测试与验证

1. 单测：loopback URL、请求 method/origin/body、脱敏快照、二维码私有元数据、错误映射。
2. MCP 集成：内存 transport 验证 tools/list、resources/read、`show_weixin_panel` 与 action tools。
3. UI 合约：组件含 MCP Apps 初始化与 `tools/call`，无 `fetch`/XHR/WebSocket，且发送有确认门禁。
4. fixture 端到端：在 `4318` 启动现有 fixture Demo，MCP stdio 客户端执行显示面板、生成
   二维码、发现/确认目标、发送，并断言响应不含 QR 源 URL或 token。
5. 全量：两个项目分别 lint、typecheck、unit/integration、build；原 Demo Playwright E2E 保持全绿。
6. Codex 本地安装：plugin validator、Skill validator、`codex-weixin-local` marketplace 注册和
   `codex-weixin@codex-weixin-local` 安装成功；实际内嵌显示需在安装后的新任务确认。
