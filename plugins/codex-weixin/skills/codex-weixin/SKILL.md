---
name: codex-weixin
description: "Open and operate the local personal-Weixin direct-channel panel. Use when the user asks to connect, inspect, confirm, or explicitly test-send through codex-weixin."
---

# 微信直连助手

用 `show_weixin_panel` 打开内嵌面板，让用户在面板中完成扫码、手机确认、目标确认与显式测试发送。

## 工作流

1. 先调用 `show_weixin_panel`。后台离线或插件无法取得本机授权时准确报告 `127.0.0.1:4317` 不可用，不读取私有状态文件。
2. 只有用户要求重新连接时，才让用户点击“生成真实二维码”。二维码、扫码和手机端授权都不由模型代办。
3. 连接后仍需用户从微信给 bot 发一条入站消息，等待面板自动同步目标与新的 context token。
4. 目标仅显示服务返回的候选项；别名是用户本地标签，不宣称是微信昵称或微信号。
5. 必须由用户确认入站目标。发送测试消息前还要单独勾选真实发送确认。
6. 发送结果只报告服务实际返回的“已接受”或错误；超时、未知和失败都不自动重发。

## 安全边界

- 不输出二维码原始 URL、bot token、context token、账户秘密、日志或入站正文。
- 不修改 OpenClaw 配置、腾讯插件源码或微信凭据。
- 不自动扫码、授权、确认目标或发送消息。
- `get_weixin_state` 只用于面板轮询，不要用模型循环调用。
