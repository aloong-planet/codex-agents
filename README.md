# codex-weixin

A local personal assistant using Codex App Server, with independently enabled Weixin iLink and Feishu private-chat channels. Use either or both with shared owner memory and separate chat contexts; changing the enabled channels requires a restart.

## 目录

- `apps/weixin-service`：本地微信直连、Codex 转发、媒体、Vault、统一管理的日报、一次性与周期提醒及网页研究服务。
- `plugins/codex-weixin`：Codex Plugin 与 MCP Apps 面板。
- `.agents/plugins/marketplace.json`：本仓库的本地 Codex marketplace。

## 开发

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The local service listens on `http://127.0.0.1:4317`. Startup requires explicit channel and owner configuration. A local Feishu pairing wizard can prepare it while preserving the existing owner; see [service setup](apps/weixin-service/README.md#channel-configuration). Credentials and personal state stay outside the repository. Feishu supports text, image/file messages, authorized local file operations, persistent selections and text notifications. See service setup for media limits and real-channel acceptance requirements.
