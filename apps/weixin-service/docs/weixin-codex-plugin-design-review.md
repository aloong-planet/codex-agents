# 微信 Codex Plugin 内嵌面板设计审查

审查对象：`docs/weixin-codex-plugin-design.md`

## 结论

方案可进入实现。核心边界是把现有 Demo 保持为业务状态和秘密的唯一所有者，Plugin 只做
loopback MCP 代理与 MCP Apps 展示。这样不复制凭据、不产生第二个微信监听者，也不会让
iframe 直接绕过 Demo 的写请求门禁。

## 审查发现与修正

1. **整页 iframe 方案会被现有 `frame-ancestors 'none'` 阻断。** 改为 MCP resource 返回独立
   组件，不嵌现有 `/` 页面。
2. **组件直接 fetch 会引入 CORS、Origin 与 CSP 扩权。** 所有动作改走 MCP `tools/call`，
   UI resource 不声明 localhost `connectDomains`。
3. **把 `qrDataUrl` 放进 `structuredContent` 会让模型看到二维码。** 脱敏函数必须删除该字段，
   二维码只进入组件私有 `_meta`；测试搜索所有模型可读内容。
4. **已连接不等于可发送。** UI 状态必须分别表达账户连接、入站目标、会话确认与 ready。
5. **轮询动作可能重复登录。** 只有用户点击才调用 `start_weixin_login`；轮询只能调用只读
   `get_weixin_state`，并有时间上限。
6. **一个目标自动选择容易被误解为自动授权。** 允许预选以减少输入，但确认 checkbox 和
   confirm tool 仍是独立步骤。
7. **发送按钮是外部副作用。** 组件增加单独确认 checkbox；MCP 注解标记非只读，服务端
   继续执行 ready、长度、并发与 no-retry 门禁。
8. **plugin cache 中的相对 executable 路径在当前 Codex 版本存在兼容风险。** 第一版本地
   `.mcp.json` 使用当前工作树的绝对构建入口，并在设计中明确这是开发边界；发布前另做
   可移植打包，不伪装成已完成。
9. **当前任务不会热加载新 Plugin。** 安装验证与 MCP/fixture E2E 可在本轮完成；真实 Codex
   iframe 必须在安装后的新任务打开，交付时明确这一步。
10. **后台离线时自动启动可能造成双实例与端口竞争。** 第一版只诊断并报告，不自动启动或
    重启当前 Demo。
11. **自动状态同步会覆盖用户动作反馈。** 轮询成功改为静默；确认和渠道接受反馈持续可见，
    仅真实轮询失败才覆盖提示。
12. **切换视觉目标后沿用旧会话确认会误导发送对象。** UI 的 send-ready 现在要求当前选择
    与服务端 `selectedAccountId/selectedTarget` 完全一致，任何选择变化都会撤销确认。
13. **公共状态仍可能含 Codex transcript 与日报草稿。** Plugin 按自己的最小 allowlist
    重新构造 model state，不转发这两类与扫码面板无关的正文。

## 实现门禁

- 使用官方 `@modelcontextprotocol/sdk` 与 MCP Apps resource MIME type。
- 先写一个失败测试，再实现一个用户可见纵切；不得横向一次写完全部测试。
- fixture 验证不得连接腾讯、不读取真实私有状态、不发送真实微信消息。
- 不修改现有 HTTP 安全头、微信凭据、OpenClaw 配置或腾讯插件源码。
- 本地 Plugin 安装需经过 validator；不得把“stdio MCP 可调用”当作“Codex 已渲染 iframe”。
