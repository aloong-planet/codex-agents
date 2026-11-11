# 个人微信直连腾讯 iLink 本地 Demo

Startup explicitly enables one or both owner-bound Weixin iLink and Feishu private channels, with optional allowlisted Feishu groups. The service does not use OpenClaw CLI/gateway or read its configuration, accounts, logs or credentials.

实现依据腾讯 `@tencent-weixin/openclaw-weixin@2.4.6` 的公开协议事实，但运行时不加载
该 OpenClaw 插件。重新绑定同一微信可能使旧 OpenClaw 微信连接失效。

## 私有状态

登录凭据默认保存在：

```text
~/Library/Application Support/weixin-ilink-direct-demo/state.json
```

目录权限为 `0700`，状态文件权限为 `0600`。它不在 Git 工作树中，也不会通过网页
返回。可用 `WEIXIN_DEMO_STATE_DIR=/absolute/private/directory` 覆盖状态目录。

## 启动

Use Node.js 26.7.0, matching the pinned CI and deployed permission-worker runtime. Verify permission-worker writes and recovery before upgrading the runtime.

```bash
cd /Users/loong_zhou/git/aloong-planet/codex-plugins/codex-weixin/apps/weixin-service
pnpm install
pnpm start
```

Configure the enabled channels below before starting. When Weixin is enabled, open <http://127.0.0.1:4317> for its existing management panel. Local status at <http://127.0.0.1:4317/api/state> includes independent `channels.weixin` and `channels.feishu` enabled/readiness fields. Feishu-only mode has read-only status and reuses saved permissions; there is no new permission editor. Both require an authorized browser; see [Local login](#local-login).

## Local login

Every page and API of the local service requires a browser that the owner authorized on this computer. Requests whose Host is not `127.0.0.1` or `localhost` with the service's port are refused, and writes must also come from the same origin. A browser without authorization sees only a card explaining how to log in.

With the service running, run from the repository root, using the same `WEIXIN_DEMO_STATE_DIR` as the service:

```bash
pnpm --filter @aloong-planet/codex-weixin-service console login            # print a one-time link and open it in the default browser
pnpm --filter @aloong-planet/codex-weixin-service console login --no-open  # only print it, to paste into another browser
pnpm --filter @aloong-planet/codex-weixin-service console list             # authorized browsers with their IDs
pnpm --filter @aloong-planet/codex-weixin-service console revoke <id>      # or `revoke all`
```

The link is valid for 2 minutes and can be used once. It sets an HttpOnly, SameSite=Strict cookie valid for 400 days and renewed whenever a page opens, so a restart does not require a new login. A revoked browser's open pages disconnect and show the login card. If the service is not running, the command says so.

The command reaches the running service through `console-control.json` and an owner-only Unix socket in the state directory; the token in that file changes on every start. Authorizations are kept in `console-browsers.json`, which stores only a hash of each cookie. The Codex plugin authorizes through the same channel and appears as one entry, 「Codex 插件」: all plugin processes share one credential kept in `console-plugin-credential.json` (`0600`) in the state directory. Revoking that entry ends every plugin process's access; they authorize again as one new entry.

Each authorization and revocation is appended to `console-audit.jsonl` in the state directory (`0600`), one JSON object per line with the time, who acted (`login-link`, `local-command`, `codex-plugin`, or `browser` with the acting browser's ID and label for a revocation from the console's 本机登录 drawer), the event and the revoked or authorized browser's ID and label; it never contains a cookie, link token or hash. Saved MCP changes are appended to the same file with `by: "browser"` and the authorized browser's ID and label (see MCP management below). Read it with standard tools, for example:

```bash
tail -n 20 "$HOME/Library/Application Support/weixin-ilink-direct-demo/console-audit.jsonl"
```

## Team overview

The console's home is `/console` (团队总览); with Feishu, a login link lands there. For each dispatch group it shows the Coordinator, the Team Leaders and the running or waiting Executors grouped per request, read from `agent-dispatch.sqlite`, with each request's records and where each kind of information is kept. Its records and storage views only read: nothing on the page changes a request, a team or a memory. The chat button beside the Coordinator's and each Team Leader's name opens the owner's private conversation with that agent in the drawer, where messages are stored in `private-conversations.sqlite` in the state directory and answered by a tool-free model turn on the agent's own private-chat runtime; a conversation only discusses, creates no request, posts nothing in a group and reads and writes no memory, and Executors and Penny have no conversation. Penny contributes only whether it is configured and ready. The sidebar's 「本机登录」 lists and revokes authorized browsers, like `console list` and `console revoke`.

## MCP management

The console page `/console/mcp` (MCP 管理) registers local MCP programs and Streamable HTTP addresses, by form or by importing an `mcpServers` document. The service starts every enabled program and connects every enabled address when it starts, holds the connections and stops them when it stops; agents receive no MCP tools yet. An address with OAuth gets client_credentials tokens, DPoP-bound when chosen, from the configured issuer only; tokens and DPoP keys stay in memory. Header values are sent only to the address's own origin, never to the issuer, and a redirect to another origin is refused. The configuration, disabled tools and pinned tool definitions are kept in `mcp-catalog.json`, environment values, header values and OAuth client secrets in `mcp-secrets.json`, both `0600` in the state directory; a sandboxed program's rules are written to `mcp-sandbox/<name>.json` there, and it gets its own npm cache under `~/Library/Caches/codex-weixin/mcp/<name>` (`0700`), removed when the server is deleted. Every saved change and import is appended to `console-audit.jsonl` with names of secrets, never their values.

## Skill management

The console page `/console/skills` (Skill 管理) imports skills from local folders as copies, compares each copy with its source folder, re-imports a changed folder as a new version and deletes a skill no profile selects. The page sends only a folder path and the fingerprint of the read the owner confirmed, never skill content, and a folder with symbolic links is refused. Executor profiles select skills on 团队管理; each Executor's runtime home gets its profile's skills in the versions its request was admitted with, and its model reads each SKILL.md, not the skill's other files. The library is kept in `skill-library/` in the state directory, one directory per skill with a manifest per version. Every import, re-import and deletion is appended to `console-audit.jsonl`, never with file content. See the [skill library spec](../../docs/specs/skill-library.md).

## Team management

With Feishu dispatch configured, the console page `/console/teams` (团队管理) edits the Agent Teams. It covers each team's Feishu application, its responsibility, the Team Leader's instructions, its Executor profiles with their executor noun, host tools and skills, its dispatch groups, and its removal from a group or deletion. Saves apply without a restart.
- **Application.** A team's application is created by scanning a QR code in Feishu, shown once the team is saved with 扫码一键创建, or is an existing one whose App ID and write-only App Secret are entered on the page.
- **Onboarding.** For a created application the service enables the bot capability, adds its permissions and submits its release, then waits for the admin's review. For every application it checks the credentials and bot, and Sam adds the bot to each bound group. The page shows each step's outcome, per group where it applies, with 「重新检查」.
- **Test message.** Once a team accepts work in a group, the page can post a test message there as the team's own bot, after a confirmation.
- **Announcements.** Sam announces in the group when a team starts or stops taking work there; a failed announcement is not resent.
- **Removal and deletion.** Unchecking a group, or deleting the team, stops it taking work there at once. The team is unbound there once nothing of it is left in that group: no unfinished request involves it, its posts there have gone out, and no scheduled task of that group is still sent with its identity. The page shows what each removal waits for, and moves such a task to another team taking work there or deletes it. A team that is being deleted leaves the list with its last removal; its history stays. Unbinding asks nothing of Feishu: the bot stays in the group until it is removed there.
- **State files.** Teams, versions, each team's QR creation, onboarding outcomes and test-message results are kept in `team-registry.sqlite`, with App Secrets beside the versions and never inside one; announcements are kept in `team-announcements.sqlite`. Both are `0600` in the state directory.
- **Audit.** Every save, deletion, scheduled-task move or deletion, QR code request, created application and test message, and each unbinding that completes a removal, is appended to `console-audit.jsonl`, never with a secret.
- **Dispatch groups.** Without dispatch the page shows the dispatch-group form, and with dispatch 「派单群设置」 opens it. A save writes only `feishu.dispatch.groupChatIds` into the channel configuration file and applies at the next start. Without Feishu paired, the page names `pnpm feishu:pair`. See [dispatch setup](../../docs/ops/feishu-agent-dispatch.md).

The [ops guide](../../docs/ops/feishu-agent-dispatch.md#team-leader-applications) lists the permissions a created application asks for and what to do when a step needs action.

## Penny private bookkeeping

Penny is an optional separate Feishu private bot configured through `PENNY_CONFIG_PATH`. It records clear text, previews payment images and calculates separate personal/business CNY books; statement-file import is unavailable. Its history is separate from the general assistant memory described below. See [Penny setup and owner acceptance](../../docs/ops/penny-private-bookkeeping.md) for its app-scoped binding, private credentials, callback route and test sequence. Do not use the general pairing command below to replace the existing Feishu binding with Penny.

## Channel configuration

Use `CHANNEL_CONFIG_PATH=/absolute/private/channel.json`, or place `channel.json` beside the existing private `state.json`. Keep its parent private and its file readable only by the owner (`0700` directory, `0600` file). Do not commit it: the Feishu application secret is sensitive.

### Feishu pairing (recommended)

Stop the formal service first and use its existing private state directory. In an interactive local terminal, from the repository root, run:

```bash
pnpm --filter @aloong-planet/codex-weixin-service feishu:pair
```

Keep the same `WEIXIN_DEMO_STATE_DIR` and optional `CHANNEL_CONFIG_PATH` as the service. The directory must already exist with owner-only access. The wizard reads an existing valid channel configuration, or reuses a uniquely recognized legacy Weixin binding; missing or ambiguous identity stops setup instead of creating new memory or task identities.

1. Enter the Feishu application's App ID and App Secret. Secret input is hidden and must not be supplied as a command argument.
2. Keep the pairing connection open. In the Feishu application console, enable the bot, select long-connection events, subscribe to message reception and publish the application with the permissions described below.
3. Privately send the displayed one-time `PAIR …` challenge to that bot within five minutes. Only a matching human private text message is considered. The wizard does not reply or run assistant tasks.
4. Confirm locally that this is your message, inspect the save preview, then confirm saving. Both confirmations default to no; replacing an existing Feishu binding also requires confirmation.
5. The wizard closes its connection and enables Feishu for the next startup while preserving any already enabled Weixin membership. Start the formal service yourself using the same state directory, then verify a reply in Feishu.

The original Weixin binding, memory identity, permissions and task identity are retained. Cancel with Ctrl+C or `/cancel`; a timeout, disconnection, rejected confirmation or failed save leaves the old configuration intact. Another pairing command or a detected configuration edit prevents replacement. Credentials are saved only in the owner-readable private configuration. Re-pairing an already configured service replaces only the App ID, App Secret and your Feishu binding, and keeps the group allowlist, dispatch, receive mode and webhook settings. A kept `receiveMode: "webhook"` listens only for callbacks: after the save, start the service, then switch the event subscription back from long connection to the request URL and complete URL verification. See [dispatch setup](../../docs/ops/feishu-agent-dispatch.md) before pairing a different application. If an interrupted process leaves `channel.json.pairing-lock` (or the equivalent beside your custom configuration), confirm that no pairing command is still running before removing that lock. Restore private-directory permissions first if cleanup failed. The wizard never starts or restarts the service.

### Manual configuration and switching

This migration uses an already-bound Weixin account and its existing private state directory. Record the existing account and target identifiers from the panel's advanced information before stopping. Keep `memoryAccountId` and `taskScope` at their existing storage identities when switching; changing them selects different data, it does not migrate old memory or tasks.

```json
{
  "enabledChannels": ["weixin", "feishu"],
  "owner": {
    "memoryAccountId": "EXISTING_WEIXIN_ACCOUNT",
    "bindings": [
      { "channel": "weixin", "accountId": "EXISTING_WEIXIN_ACCOUNT", "target": "EXISTING_USER@im.wechat", "senderId": "EXISTING_USER@im.wechat" },
      { "channel": "feishu", "accountId": "cli_0123456789abcdef", "target": "oc_REPLACE_WITH_PRIVATE_CHAT_ID", "senderId": "ou_REPLACE_WITH_OWNER_OPEN_ID" }
    ]
  },
  "taskScope": { "accountId": "EXISTING_WEIXIN_ACCOUNT", "target": "EXISTING_USER@im.wechat" },
  "feishu": { "appId": "cli_0123456789abcdef", "appSecret": "REPLACE_WITH_PRIVATE_APP_SECRET" }
}
```

All values above are placeholders. Supply your Feishu bot application's ID/secret and the owner's actual private chat ID/open ID. Configure that application for the SDK long connection and message-receive event, with permission to receive private messages and send as the bot, read referenced messages and message resources, and upload images/files. The application ID must match its binding. The SDK long connection is the default. Authenticated HTTP callbacks are also supported; see [dispatch setup](../../docs/ops/feishu-agent-dispatch.md). Group access requires the additional configuration below. Actual application permissions and real message receipt require platform-side verification.

Stop the service, set `enabledChannels` to `["weixin"]`, `["feishu"]` or `["weixin", "feishu"]`, and restart with the same state directory. The set must be nonempty, unique and contain only supported channels. Old `channel` configurations remain readable as single-channel selections; when using `enabledChannels`, remove the old `channel` field to avoid conflicting selectors. File edits do not change a running process. Each enabled channel requires its own binding and credentials. A disabled binding can retain a future notification preference, but does not activate a transport.

Invalid configuration fails startup. With a healthy shared core, each configured connection starts independently: a failed Feishu connection does not stop Weixin and vice versa. Startup connection errors are reported locally; correct the issue and restart. A later Feishu disconnection marks only its readiness false, and its SDK reconnects within Feishu. Replies and notifications never fall back to the other channel.

The main chat model connection also recovers automatically. After an unexpected process/transport disconnect, it reconnects without a new message and safely continues each interrupted request in its own saved thread. Recovery allows at most three attempts within sixty seconds; the file-query execution allowance is retained across attempts. Completed mutations reuse host-confirmed results; changed permissions, missing context, uncertain/native effects or a further mutation after an already completed change stop continuation. Claimed workflows and accepted/unknown deliveries are never replayed. Authentication, quota, policy and protocol errors keep their failure semantics. Recovery diagnostics use `app_server.connection` and `app_server.recovery`; this mechanism does not replay ordinary messages after a service restart.

Both bindings share curated owner memory, permissions and task management. Raw chat history, model threads, message ordering and pending choices remain separate. New tasks and memory plans capture their creation conversation; later viewing or editing from the other chat does not change the notification destination. Legacy tasks/plans without a preference acquire Feishu for future notifications; upgrading those records requires a valid Feishu binding. Existing occurrences, cached output and accepted/uncertain delivery records retain their original destination and outcome. The first activation of explicit binding renews an older model context without binding identity while preserving its transcript. A successful API receipt means channel acceptance, not confirmed phone receipt.

Feishu accepts text, image, file and supported rich-text messages, including referenced attachments from the same authorized private conversation or group. It exposes the shared authorized local file, media selection/delivery and schedule tools. Fixture mode is a separate local test entry and cannot establish real-channel acceptance.

### Feishu group configuration

Add `groups` to the existing `feishu` object; preserve its credentials, owner bindings, `memoryAccountId` and `taskScope`. The following is a fragment, not a replacement for the complete configuration:

```json
{
  "groups": [
    {
      "chatId": "oc_EXAMPLEGROUP",
      "allowedSenderIds": ["ou_EXAMPLEMEMBER"]
    }
  ]
}
```

Replace these synthetic example IDs with actual group chat IDs and application-scoped member open IDs. Each group must be explicitly listed; an owner who wants to invoke the bot in a group must also appear in that group's member list. Wildcards, duplicate groups/members and the bound private chat as a group are rejected. At most 98 groups and 200 members per group are accepted. An absent/empty group list keeps private-only access; an empty member list permits observation but no invocation. Maintain these lists locally, optionally with Codex assistance, and restart to apply changes. Removing a binding prevents its queued work from being admitted; it does not erase retained history or move task deliveries.

In the Feishu application console, publish bot access and subscribe to `im.message.receive_v1` through the SDK long connection by default, or configure the authenticated callback mode described in [dispatch setup](../../docs/ops/feishu-agent-dispatch.md). In addition to existing private/media permissions, enable `im:message.group_at_msg:readonly`, `im:message.group_msg` and `im:message:send_as_bot` (see [Feishu's supported bot permissions](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group)). All-message permission is needed for ordinary discussion: without it, the service cannot record messages Feishu does not deliver, as also noted in [OpenClaw's group access guidance](https://docs.openclaw.ai/channels/feishu/access-control). Verify approval, publication and bot visibility in the actual tenant. The bot must be present in the group. Bot identity is resolved through `/open-apis/bot/v3/info`; a failed lookup disables group invocation while retaining private access.

In the default mention-only mode, only an allowlisted human's real platform mention of this bot invokes it. Typing its display name, mentioning another bot, quoting its reply or using only @all does not. Text and supported rich text are accepted; other members' ordinary messages and unauthorized mentions are passive context. Context supplied to an admitted turn retains authors and event identities, with up to 100 preceding observations, 1,000 characters per observation and 16,000 characters total. Passive messages do not run tools, create tasks or directly enter memory curation. Explicitly enabled [dispatch groups](../../docs/ops/feishu-agent-dispatch.md) also classify authorized ordinary messages and use separate specialist execution histories with shared curated group facts.

Members share their group's model history and curated memory. Private and other-group memory remain separate. Group runtimes use a clean configuration/home and a named restricted permission profile; the installed Codex must support that profile on thread start, resume, turns and CLI research. This path was exercised with Codex `0.166.0-alpha.6`. Authentication is copied privately into the isolated runtime; personal configuration, skills, plugins and memory are not inherited. Each isolated runtime, including Penny's and research's, has its own HOME inside its runtime root and runs with Codex's bundled skills disabled, so neither the owner's skills nor bundled skills are listed or injected. Each isolated runtime also runs with a direct-mode model catalog in its own home, derived from the installed Codex, with user input and Codex sub-agents switched off. It is therefore offered only its host tools, plus web search where that is live; no Codex code-mode, patch, MCP-resource, user-input or sub-agent tool is offered. The runtime does not start when that catalog cannot be derived ([ADR-0030](../../docs/adr/0030-offer-isolated-runtimes-only-granted-tools.md)). Native host filesystem/network access is restricted; existing business-file operations use trusted service tools and current saved grants. Service state, diagnostic files, personal model configuration and internal memory stay protected even under an ancestor directory grant, in the owner's private chats as well as in groups. A failed group runtime does not fall back to the private runtime or stop healthy conversations.

All authorized members may manage their group's reminders and public-web research tasks. Even an explicit all-channel query stays inside that group; private daily news remains private. Task execution and plan follow-ups return to the source group. Pending file choices, clarification and cancellation belong to their original requester, who must mention the bot again in mention-only mode; dispatch groups accept authorized ordinary continuations. Another member's request does not replace them. Accepted/unknown sends are not replayed after restart or failure.

### Real-group acceptance

After deployment, configure a test group and consenting test members locally, verify the platform permissions above, and record the exact version, requests, replies and received artifacts. The following table covers mention-only mode; use the [dispatch acceptance sequence](../../docs/ops/feishu-agent-dispatch.md#acceptance-sequence) for automatic groups. Automated fixture acceptance does not establish real platform delivery.

| Scenario | Action | Expected observation |
|---|---|---|
| Access and genuine mentions | Test an unlisted group, a guest mention, a typed bot name, @all, then an authorized real mention. | Only the authorized real mention in the listed group invokes a reply. |
| Ordinary shared discussion | A guest posts a harmless temporary code; Alice mentions the bot to ask about it, then Bob continues. | The group can refer to delivered discussion with its author; the guest message alone causes no answer or operation. |
| Independent memory and context | Use distinct temporary codes and explicitly saved preferences in private, Alpha and Beta conversations. | Each group recalls its own context/memory; private and other-group details do not appear. |
| Original requester choices | Alice and Bob each request an ambiguous authorized file list. Bob attempts Alice's short reference; Alice then selects her own and Bob cancels his. | No cross-request takeover; only the selected authorized file returns to the source group. |
| Shared group tasks | Alice creates a one-time group reminder; Bob edits it. Ask for all tasks and a known private task ID. | Group task management works, foreign tasks stay unavailable, and the reminder arrives once in the original group. |
| Restart and revocation | Coordinate a restart with separate pending choices/tasks, then remove a member or group and restart again. | Eligible work retains its identity and destination; removed callers/groups cannot resume it; settled sends are not repeated. |

Use only harmless files in already authorized directories. Record channel acceptance separately from human receipt. Unknown sends require inspection in the original group, not automatic retry.

### Upgrading an existing installation

1. Prepare the new release and its locked dependencies before stopping the installed service. Keep its state-directory path, owner memory identity, bindings and task scope unchanged.
2. Stop the service and verify its listener has closed. Back up the private configuration, startup configuration and the complete state directory while no service is writing to them; keep the backup private.
3. Set `enabledChannels` to `["weixin", "feishu"]`, remove the old `channel` selector, and point the service launcher at the new release. Preserve existing credentials and file permissions.
4. Start once and inspect `/api/state` in an [authorized browser](#local-login): both channels should be enabled and independently ready, and the core should have a prepared thread. If only one connection is ready, that channel can work; inspect the unavailable channel locally without redirecting its messages or rebinding accounts automatically.
5. Confirm that existing task identities, saved permissions and historical delivery destinations remain intact. Missing task/plan preferences migrate to the bound Feishu destination; accepted and uncertain history is not replayed.
6. Have the owner test both chats: separate ordinary messages, a saved choice in each chat, a reminder created in each chat and recall of a curated preference. Record actual receipt separately from startup readiness or an API acceptance result.

Do not restore an old database over newer accepted delivery records: doing so can lose work or permit duplicate delivery. If startup fails, retain the failed release and its current state for diagnosis; a rollback must account for any work already accepted since the backup. Changing enabled channels still requires stop/configure/start.

### Real-channel acceptance

Use both already-bound private chats after deployment. Only the owner initiates these messages; automated fixtures do not prove phone receipt. Record the deployed version, exact request/reply, received attachment or notification, and the owner's confirmation for each scenario. A successful subset does not accept the remaining rows.

| Scenario | Owner action | Expected observation |
|---|---|---|
| Source-bound replies and independent context | Give each chat a different temporary code, explicitly excluding it from long-term memory, then ask each chat to recall its code. | Each answer stays in its originating chat and recalls only its own code. Feishu omits the automatic processing acknowledgement. |
| Concurrent complete-tree file search | Ask both chats to send the latest file from an authorized directory containing subdirectories. | Each receives the correct newest file in its own chat. A query that cannot finish reports its limit without sending a partial selection. Execution allowance remains unchanged; queue waiting is separately bounded. |
| Task-list scope | Ask each chat for current tasks, then explicitly ask for tasks from all channels. | Default results reflect that chat's notification destinations; all-channel results label the reception channels. If a channel has no tasks, its default list is empty. |
| Once reminders and captured destinations | Create a distinctly named one-time reminder in each chat. Inspect or edit its text from the other chat by explicit task reference, then observe delivery and a later interval. | Each arrives once in its creation chat; editing does not transfer it. Completed once tasks have no next execution. Existing migrated tasks retain their agreed future destination. |
| Plan reminders | When using memory plan follow-ups, create a distinct planned event in each chat and let the configured follow-up become due. | Reminders and numbered response context stay with each plan's creation chat; no cross-channel batching. This path is distinct from explicit scheduled reminders. |
| Images and independent choices | Request supported images/files in both chats, keeping one ambiguous candidate list open in each. Select in one and cancel in the other. | Only the selected items return to the selecting chat; cancellation affects only its own list. Check Weixin video separately; Feishu video/audio remain unsupported. |
| Shared curated memory | Explicitly save a stable preference in one chat, allow memory curation to complete, then ask about that preference in the other. | The saved preference is available across chats while the temporary chat codes and raw histories remain separate. A chat acknowledgement alone is not evidence that curation completed. |
| Restart recovery | Coordinate a service restart after establishing separate contexts, saved choices and a future reminder. Resume each chat and observe the next due reminder. | Contexts and choices remain associated with their original chat; permissions, memory and tasks survive. Previously delivered files/reminders are not replayed. Readiness alone does not establish this result. |

Use only supported file sizes and authorized directories. Recheck the latest file identity if the directory changes during testing. Unknown delivery results require inspection in the original chat, not automatic retry. Keep real-platform observations separate from deterministic fixture evidence for permission revocation, invalid identities and transport failures.

### Feishu media limits

- Incoming resources are saved privately before business admission, with a 100 MiB per-resource limit and bounded download time. Webhook acknowledgement occurs earlier, after durable callback storage; resource retrieval runs asynchronously. Rich text supports text, links, mentions, code blocks, images, emotions and separators; unsupported nodes reject the message before resource downloads. Video, audio and interactive cards are not supported.
- Outgoing images are limited to 10 MiB and files to 30 MiB. Only validated inbound attachments or snapshots from authorized local directories can be sent; model arguments cannot choose a different recipient.
- Current, quoted and recent images share the existing selection/revalidation behavior. Incoming files are provided as read-only model context; local-file sending uses the existing authorized-directory tools. Same-channel pending selections survive restart; revoked file access prevents sending even when a choice was already saved. This does not transfer pending work between channels.
- Accepted and uncertain media effects retain their original destination and are not automatically repeated. Channel acceptance does not prove receipt on the phone.
- The Weixin retention policy below applies only to Weixin resources; Feishu resource storage does not yet apply that automatic retention policy.

## Weixin connection and recovery

The selected Weixin account must already have usable stored credentials matching the owner binding. The local panel keeps QR binding and connection information for that account. If credentials or owner identifiers change, stop the service, reconcile the private configuration, and restart; no new identity is admitted automatically. Send a private message from the configured owner to refresh its reply context. Use explicit panel test-send only when ready to inspect the phone result.

页面展示最近入站、上下文更新与渠道接受发送的时间，但腾讯没有公开 context token 的
固定有效期或主动刷新接口。普通发送失败时，先从微信再发一条入站消息刷新上下文，再由
用户主动重试；`-14` 会单独标记为 bot 凭据失效/暂停并禁用发送。Unknown outcomes are never retried automatically. Daily-news credential/context recovery follows the rules below.

## 微信媒体与引用消息

- 接收并解密微信图片、语音、视频和文件；SILK 语音优先转为 WAV，图片、语音作为 Codex 原生多模态输入，文件和视频通过只读本地路径处理。
- 支持回复/引用消息中的文本和媒体；引用附件无法下载时不会假称已读取。
- 入站附件仅保存在 Demo 私有状态目录，权限为 `0700/0600`，按微信目标滚动保留 7 天、每个目标最多 100 个，单个文件最多 100 MiB。
- Codex 只有在当前微信消息明确要求发送或回传媒体时，才能调用一次性媒体发送工具；目标与该入站消息的 context token 固定，turn 结束立即失效。
- 出站只允许本次入站附件或权限向导中实际授权目录内的普通本地文件；不接受远程 URL、目录、符号链接或越界路径。
- 图片、视频和普通文件经腾讯 CDN 加密上传后发送。渠道接受不等于手机实际收到；发送结果未知时不会自动重发。

## 每日 AI 新闻

页面第 5 步和微信定时任务工具共同管理同一份日报：

- 默认每天 `08:30`（`Asia/Shanghai`），可在微信修改执行规则与研究要求；每次使用隔离的 Codex CLI live-search，检索实际运行时向前 24 小时，最多汇总 10 条全球 AI 新闻。LLM、论文/评测、训练推理、Agent、多模态、安全和开源工具等技术进展优先；融资与纯商业合作不主导结果。
- 严格保持 24 小时窗口，不用近 7 天旧闻补齐；合格内容不足时会少于 10 条。
- 微信正文、网页预览和公开状态只显示来源名，不显示具体链接；规范 HTTPS 链接仅保存在私有账本中用于核查与去重。
- News research runs in an empty temporary directory with project rules, personal configuration, skills, plugins and subagents disabled. General-news discovery requires at least one completed web search. Canonical identities reuse saved article results; general-news delivery separately excludes already delivered articles.
- New summaries use natural prose without four mandatory sections. Delivery and preview preserve the same complete brief (up to 80 Unicode characters), with no ellipsis cutting; an invalid brief is rewritten once. Detailed prose stays in the local archive.
- 摘要与可读取的清洗后正文保存到 demo Vault 的 `news/YYYY-MM-DD/<generation-time>-<snapshot-id-hash>/`；旧路径保留。静态 HTML 没有正文时会使用不继承登录态的受限浏览器渲染回退；网页显示摘要路径和正文归档 `N/M`，不公开本地绝对路径。
- The frozen instruction resolves to validated AI/HN source counts within ten total articles; a zero-count source is skipped. Resolution has a 30-second budget and fails explicitly for invalid/unsupported results. Hacker News scans the official top ten in rank order, applies the past-24-hour submission window and selects the requested count. Prior delivery does not exclude current HN articles; saved bodies and summaries are reused. A shortage reports target/actual counts and reason. Each selected source has a six-minute budget; transient public reads have at most three attempts. Source outcomes, tracing and ranking archives retain the actual selection.
- “生成今日预览”只检索和保存预览，不发送微信；“发送当前预览”只有用户点击才调用真实 iLink。
- 自动调度初始为停用。选择已发现的入站目标并点击“为当前目标启用”后才生效。
- 调度只随本 Demo 进程运行；停机恢复只执行最近错过的一次，主动停用的时段不补跑。已缓存内容与未执行时段分开处理，按原计划时间与其他定时结果共同排队。
- 执行摘要不再按次数或天数删除，支持倒序分页及任务编号加执行编号查询。累计执行次数排除合并跳过的时段；旧任务可能已被早期版本删除过历史，只报告已知至少执行次数，不能恢复丢失的记录。已结束执行的正文及详细载荷默认保留 90 天、服务范围内最多 100 MiB，先到者清理，保留结果、原因、来源/归档状态和发送分段结果；清理后不能再读原正文，也不会重新生成或补发。待推送/暂停、执行中、发送中、待归档、待通知和当日可重试日报受保护。成功文章摘要缓存、本地 Markdown 归档和防重复证据不在清理范围。
- 迁移后，任务、执行历史、缓存、日报摘要去重和预览统一保存在私有目录 `scheduled-tasks.sqlite`；`daily-ai-news.json` 变为旧 owner 的禁止启动标记，`daily-ai-news.json.prepared` 保存不可变迁移来源。它们不包含 bot token 或 context token；新执行重新发现候选，已成功文章复用正文及长短摘要；同日旧预览不代替新的研究。
- 无正文的自动研究失败按 10、30、60 分钟在上海当日重试。展示归档失败不阻塞推送，单独使用已保存内容最多补试三次（10、30、60 分钟），不会抓取、生成摘要或再次发消息；任务停用/删除时不启动新归档。待归档与待推送记录受历史清理保护。手动预览发送失败不会自动重发。
- Article results use the same private SQLite owner: a validated result and success flag commit together, with checksums and protected identities. Limits are 2 MiB + 32 KiB per article, 512 MiB overall and 100,000 identities; capacity refuses new work without deleting successful results.
- Generated reports are saved before sending. After original-account/context recovery, eligible cached reports resume oldest first without repeating research. Startup, channel updates and scheduled work reconcile the saved refresh, including one received before service restart. New reports wait behind older recoverable reports. Existing status and local notifications show queue count, earliest date and the current recovery action; an unchanged rejected context is not retried.
- Unknown, partially accepted, accepted, and non-recoverable rejected reports are never automatically resent. A failed submission stops the current drain. Disabling news or changing the account/recipient stops later submissions.
- Newly processed news checks that the fetched body supports its candidate title before accepting a summary. A mismatch or insufficient evidence is excluded, with an explicit reason if the final selection is short. The check shares the existing summary call; historical successful summaries are not automatically rewritten. Legacy successes receive one persisted eligibility check on their next encounter; rejected/unavailable results are excluded without refetching or rewriting their historical summaries.
- News research resolves the bundled Codex path for each new process, including after an application update moves the binary. A custom `CODEX_BIN` remains authoritative. See the [current specification](../../docs/specs/daily-ai-news.md).
- Disabling news stops submissions that have not started, including queued cached reports; an in-flight request cannot be recalled.

首次升级至统一调度必须先保存私有状态备份、记录旧服务 PID、停止旧服务并确认该 PID 已退出。新服务首次启动通过 `CODEX_WEIXIN_LEGACY_NEWS_PID` 接收该 PID，在独占监听成功后保存准备快照、封锁旧文件并事务导入；已提交后的重启核对来源与封锁标记，无须再次依赖旧 PID。缺少证明或来源冲突时显示“迁移待核对”，不自动回退旧调度。不要删除准备快照/封锁文件，也不要在已提交后直接恢复旧 JSON 或启动旧版本。后续版本切换也必须在服务停止后备份 `scheduled-tasks.sqlite`（及仍存在的 WAL/SHM）、`daily-ai-news.json` 和 `daily-ai-news.json.prepared`；仅匹配 `.json` 后缀会漏掉准备快照。受控部署核对流程见 [ADR-0016](../../docs/adr/0016-daily-news-owner-handoff.md)。

新闻设计与审查见 [docs/daily-ai-news-design.md](./docs/daily-ai-news-design.md) 和
[docs/daily-ai-news-design-review.md](./docs/daily-ai-news-design-review.md)。canonical 调研报告位于
`/Users/loong_zhou/research/obsidian-codex-weixin/daily-ai-news-delivery.md`。

## 执行详情保留配置

`SCHEDULED_HISTORY_DETAIL_DAYS` 默认 `90`；`SCHEDULED_HISTORY_DETAIL_BYTES` 默认 `104857600`。部署时通过服务环境变量配置，生效需要服务重新加载配置；本次开发不会自动更新运行服务。时间换算为毫秒、容量按字节，必须为正的安全整数，非法值拒绝启动。

清理从执行及附属工作全部结束后开始计时，旧数据首次观察到已结束时开始计时。超过容量时优先清理最早符合条件的详情。容量统计的是可清理执行记录的序列化字节，不是整个数据库文件：永久摘要、受保护工作、成功文章结果和不可变迁移来源不计入此限额。SQLite 空闲页供以后复用，不承诺文件立即缩小；OTel 日志继续使用下方独立保留配置。

## 验证命令

### 本地 OTel 诊断

服务默认在 `~/Library/Logs/codex-weixin/otel/` 保存仅本机使用的诊断记录；不连接外部平台。已提供的诊断属性、关联值、文件查询参数和 SDK 网络地址原样保留，不再按白名单脱敏；不新增正文或请求头采集。当前写入 version=2，兼容历史 version=1；历史 other/指纹不能恢复原文。具体边界见 [ADR-0013](../../docs/adr/0013-preserve-local-diagnostic-values.md)。

| 环境变量 | 默认值 |
|---|---|
| `WEIXIN_OTEL_ENABLED` | `1`；设为 `0` 关闭 |
| `WEIXIN_OTEL_DIRECTORY` | 上述专用日志目录；fixture 默认为临时状态目录下的 `otel` |
| `WEIXIN_OTEL_RETENTION_DAYS` | `7`，从封口计时 |
| `WEIXIN_OTEL_MAX_FILE_MIB` | `20` |
| `WEIXIN_OTEL_MAX_TOTAL_MIB` | `200` |
| `WEIXIN_OTEL_MAX_FILES` | `512`，含活动文件 |

时间和容量参数必须是正整数，否则使用默认值。修改环境变量后需重启服务。每小时或达到大小上限封口；启动、写入和闲置小时维护会清理。总容量/文件数优先于天数，活动文件不淘汰；停机和休眠期间不执行清理。只清理本出口命名的普通文件，不触碰业务库。

只读查询（在本目录执行）：

```bash
pnpm diagnostics:read
pnpm diagnostics:read --since 2026-09-09T08:00:00+08:00 --limit 500
pnpm diagnostics:read --trace TRACE_ID
pnpm diagnostics:read --run INTERNAL_RUN_UUID
```

默认近 24 小时、8 MiB/200 条。返回 evidence、malformed、unreadable、budgetLimited、dropped、rotated 与 unfinished；查不到不能证明从未发生，未闭合需对照 Run/Effect。读取器保留已存诊断字段与原值，不回显坏行。日志不再脱敏，可能包含查询词、路径、关联标识和网络 URL 参数；分享前须审查。不新增请求头、请求/响应正文或文件正文采集。文件是版本化 JSONL，不是标准 OTLP JSON；`traces` 与 `checkpoints` 分开保存。单条 64 KiB、队列 256 条；独立日志进程通过有界队列批量写入，故障不改变业务结果。积累日志只在启动、轮转、I/O 失败后及小时维护时重新盘点，逐条写入使用增量统计；日志进程停止响应时限时退出诊断等待并记录缺口，不触发业务重试。flush 处理写入队列，封口 fsync，正常退出最多等待 5 秒；硬杀/断电仍可能丢尾部，持续磁盘故障时丢弃计数也可能无法落盘。

文件沙箱由独立 instrumentation 集中记录 `sandbox.init`、`sandbox.execute` 的 Span 与 start/end checkpoint，以及 `sandbox.timeout`、`sandbox.invalidate`、`sandbox.close`、`sandbox.exit` 事件。初始化计至 ready，执行计时不含初始化，包含 IPC、worker 执行、宿主持久确认和结果校验。它不记录每个 fs 调用，也不改变原有 5 秒请求 deadline 或权限。 Metadata search now continues internally across bounded requests. `files.find.batch` records consumption, elapsed time and stop reason; it is not a per-file fs trace. Complete traversal is required for a global latest result. The default turn allowance is 500,000 entries / 250,000 files with the existing 60-second active-operation budget; each request still has its own deadline. Cross-turn find/grep admission is FIFO by traversal batch. `files.query.scheduling` associates each batch with its event and records queue wait, execution duration and outcome; waiting does not consume the execution allowance. Cumulative waiting is separately capped at 60 seconds per turn, with at most 32 queued batches across the service. Queue timeout/full errors remain distinct from scan-budget exhaustion.

排查时先按 trace/run 查询工具，再用 `sandboxInstanceId`、`workerInstanceId`、`generation` 与 `requestId` 区分进程和请求；同 worker 的 metrics 带相同身份。`triggerRequestId` 与 `failureRole` 区分首个触发请求和连带失败；`sandbox.exit` 保留首次失效原因及实际 exitCode/signal。正常关闭不等同于故障，硬杀宿主时无结束证据不代表请求仍在运行。集中边界之外的算法内部耗时仍无法细分。

### 回归命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:e2e:production-parity
pnpm test:e2e:pending-router-parity
pnpm test:e2e:pending-main-parity
pnpm test:process-restart
pnpm test:process-restart:live
pnpm test:process-access:live
pnpm test:app-server-protocol
pnpm test:isolated-runtime
pnpm test:dispatch-real-model
pnpm build
```

`test:e2e` 显式使用 `DEMO_MODE=fixture`，不会连接腾讯、扫码或发送真实消息。
Playwright整例默认120秒；单轮交互采用30秒空闲超时，覆盖POST及最终回复等待。仅本交互的新模型流式/协议事件、工具事件或启动进度会续期，HTTP轮询成功、重复状态、历史记录、无关trace与周期指标不会续期；持续有有效进度可以超过30秒，仍受整例120秒上限约束。进度读取本用例独占OTel目录的新增checkpoint，监测失败作为取证错误报告，不退回固定30秒总截止。每个用例独享测试服务进程组、动态端口、临时状态和OTel目录，同例多轮复用。超时后保留交互/最终状态/服务日志并停止该进程组；不让未完成任务污染下一项。服务启动最多20秒；失败取证与清理独立有界，不计为交互成功。扫码综合用例固定使用fixture模型；live用例保留真实模型决策，非法模式值直接报错。仅影响测试，不修改生产Turn超时。
`test:e2e:production-parity` 使用真实主模型，经相同的 fixture HTTP 入站覆盖查找/读取/修改/验证/发送原文件、最新图片与 PDF、普通聊天由主模型按要求只回复“收到”（可带句号）、模糊文件待选后恢复、分页发送、含子目录的完整小集合发送、正文搜索、读取总结、新建文本与共享新父目录、冲突编辑、扫描不完整，以及不可信正文读取和渲染。用例集合以脚本筛选和 Playwright `--list` 为准。小集合发送与协议中的大集合计数不能替代大集合逐项发送验收。模型决定不会被测试注入；外发仍为 fixture。每条入站以测试附件记录实际口令、回复、变化的 Run/Effect、新增 outbox 和工具诊断；扫描诊断包含完整性与截断标记。超时失败也保留最后观察到的交互。该门禁不替代独立权限撤销回归、清单逐项核销或真实手机收件验收。
`test:e2e:pending-router-parity` 仍使用 fixture 外发，但改用与生产相同的 Pending Response Router，校验候选回复的语义取消、Run 与脱敏 outbox 一致性；该 Router 只解释已有 Pending 的后续消息，不对无 Pending 的新入站做前置意图分类。

`test:e2e:pending-main-parity` 同时启用真实主模型与真实 Router，覆盖全部选择、排除部分候选、明确取消与同句替换新目标；候选建立不注入模型决定。`test:app-server-protocol` 单独验证真实 App Server 工具声明、同一 Turn 的查询迭代与结果回灌。`test:isolated-runtime` 用本机安装的 Codex 启动每类隔离运行时，模型请求发往本地假模型端点：只列出、只注入运行时自己 home 里的 skill，宿主与内置 skill 一概不出现；每类运行时只被提供宿主授予的工具（无授权时一个工具也没有），Codex 自带的 `exec`、`apply_patch`、MCP 资源工具、`request_user_input` 与子 agent 调用一律被拒、无副作用，群研究仍经 `web.run` 完成检索；Executor 运行时释放后 home 只剩线程 rollout，失败分工重试时仍恢复同一线程，模型输入带着第一轮的用户内容、工具输出与答复；被取代的 Team Leader home 压缩后，收尾回合仍恢复同一线程，模型输入带着规划回合的内容；按能力档写入 skill 的 Executor 运行时只列出这些 skill，回合不带 skill 输入项时模型请求里没有 SKILL.md 的正文，带上时才注入；Skill 库接受与拒绝的 SKILL.md 形态与 App Server 是否列出一致；升级 Codex 后需重跑。上述测试均不向真实微信外发。

`test:process-restart` 启动完整隔离服务进程，经公开 fixture 入站建立待选请求，停止并重启进程后验证原 Run 续行、快照/外发不重复和新目标替代旧 Pending。`test:process-restart:live` 将该待选响应切换为真实 App Server Router；这个场景的主模型工具调用仍为测试注入，不把它当作真实主模型选工具的验收。该文件还包含 accepted/running 两种旧 Resolver 退役通知回归，普通聊天使用真实主模型；权限撤销场景需额外启用 `CODEX_WEIXIN_ACCESS_TEST=1`，默认跳过。

`test:process-access:live` 使用真实主模型、真实 Router 和持久测试记忆，经公开 fixture 入站产生文件候选，再通过权限设置接口撤销读取并重启。它验证实际 thread 更换、原 Pending 不丢失但不能发送已撤权文件，以及新会话能够回答测试专用记忆事实。没有注入主模型工具决定；外发仍只进入 fixture，不能视为手机验收。工具契约 description 升级的持久化组合另由 `workflow-file-send-integration.test.ts` 覆盖，该测试的模型/渠道是边界假件。

`test:dispatch-real-model` 经 fixture 飞书入站驱动真实 main，只有 Coordinator、Team Leader 与 Executor，以及控制台私聊的回复回合，运行在各自的真实运行时和真实模型上。脚本设置 `DISPATCH_REAL_MODEL_TEST=1`；不设时十一个场景全部跳过，默认运行与 CI 都不会触达模型。main 以 `WORKFLOW_FIXTURE_DISPATCH_REAL_MODEL=1` 启动，该开关只在 fixture 模式下可用，否则启动即拒绝。飞书与微信平台、主模型、待选 Router 和记忆整理仍是 fixture，不向任何真实渠道外发。十一个场景覆盖 Coordinator 的单轮决定（忽略闲聊、提议、澄清、职责外点名转派）、三个团队的首批交付物、带依赖的分工、能力档的 skill（Team Leader 把该 skill 用途内的工作交给选了它的能力档，Executor 按其 SKILL.md 办事），以及本人在控制台私聊里向 Sam 和主责 Team Leader 询问一项已办结的事务。断言只看结构；模型写出的内容凭每个场景的 run record 审阅。run record 在场景失败时同样写出，位于 `DISPATCH_REAL_MODEL_RECORD_DIR`（默认是系统临时目录下的 `dispatch-real-model-records`），每次运行各占一个目录，含发出的消息、请求、三类角色的每个回合与每次私聊回复、各身份的群内发言与送达状态、交付文件、授权目录、服务日志，以及每个 Executor 的线程 rollout（其完整回合，含联网检索）。运行时 home 里除这些 rollout 外什么都不进 run record：登录凭据只经运行时自己的复制路径进入临时 home；保留的 rollout 里登录账号的标识已替换为固定标记，其余字节不变。含凭据特征的 rollout 或回合记录、以及账号标识无法替换的 rollout 不写入 run record，在其中列名，并使该场景失败。每个场景独用临时状态目录和临时授权目录，结束即删除。只重跑一个场景用 `pnpm test:dispatch-real-model -t "<场景名>"`。每次运行消耗数十次模型请求，结论只对 run record 写明的模型成立；它不替代应用权限、入站和真实群收件的 live 验收。

跨进程测试通过 `WORKFLOW_FIXTURE_STATE_DIRECTORY` 复用测试自己创建的临时目录；只在 `DEMO_MODE=fixture` 时生效，目录必须已存在。笔记与媒体样本放在状态目录旁的 `<状态目录>-business`，与生产一样不在受保护的状态目录内；可用 `WORKFLOW_FIXTURE_BUSINESS_DIRECTORY` 另行指定。首次运行创建样本和初始授权，重启不覆盖已有文件、授权或状态。默认未指定时仍使用全新临时目录。测试保留各进程日志及 `evidence.json`，退出时停止自己的隔离进程组，不停止生产服务，也不执行腾讯外发。

设计与审查见 [docs/design.md](./docs/design.md) 和
[docs/design-review.md](./docs/design-review.md)。源码调研的 canonical 报告位于
`/Users/loong_zhou/research/openclaw-weixin-multichannel/channel-and-authorization.md`。

LaunchAgent uses `ProcessType=Standard` for user-requested work; automatic startup and keepalive remain enabled. Existing installations must be explicitly redeployed/reloaded to adopt the generated policy.
