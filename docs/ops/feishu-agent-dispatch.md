# Feishu agent dispatch setup and acceptance

This procedure enables [automatic group dispatch](../features/agent-dispatch.md) on the existing local service. Keep the current owner bindings, memory identity, task scope, state directory and business-file grants. All examples use synthetic values; never commit real identifiers, credentials or state.

## Applications and event intake

Create and publish separate application bots for Alice, Bill and Jack, and add all four bots to the intended group. Sam remains the canonical account: member open IDs in the allowlist belong to Sam's application. Do not substitute a Team Leader application's member identifiers or create a second owner binding for it.

For this group dispatch setup, only Sam subscribes to `im.message.receive_v1`. Separately configured [Penny private bookkeeping](penny-private-bookkeeping.md) has its own private intake and does not join the group roster. For Sam, enable the private/group message and message-resource permissions required by the existing [group setup](../../apps/weixin-service/README.md#feishu-group-configuration), including delivery of ordinary group discussion. It must also be able to read a message to resolve genuine cross-application bot mentions. Team Leader applications (Alice, Bill and Jack) need `im:message:send_as_bot` (send as an app) and `im:resource` (read and upload images/files); they do not subscribe to inbound events. Confirm each application's approved permissions, publication, visibility and group membership in the tenant before enabling dispatch. A role name does not enable website accounts, publishing, booking or shell execution.

Platform references: [event subscription configuration](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case), [message reception](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive), and [message retrieval](https://open.feishu.cn/document/server-docs/im-v1/message/get). Tenant approval and real delivery must be checked independently of local tests.

## Local configuration

Use the existing private `channel.json` or `CHANNEL_CONFIG_PATH`. Merge this fragment into its `feishu` object, retaining Sam's actual `appId` and `appSecret`. The callback token and encryption key must match Sam's event configuration. Both are required; plaintext callbacks are rejected.

```json
{
  "receiveMode": "webhook",
  "webhook": {
    "port": 4318,
    "path": "/feishu/events",
    "verificationToken": "REPLACE_WITH_PRIVATE_TOKEN",
    "encryptKey": "REPLACE_WITH_PRIVATE_ENCRYPT_KEY"
  },
  "groups": [
    { "chatId": "oc_EXAMPLEGROUP", "allowedSenderIds": ["ou_EXAMPLEOWNER"] }
  ],
  "dispatch": {
    "groupChatIds": ["oc_EXAMPLEGROUP"],
    "agents": [
      { "id": "sam" },
      { "id": "alice", "appId": "cli_aaaaaaaaaaaaaaaa", "appSecret": "REPLACE_WITH_ALICE_SECRET" },
      { "id": "bill", "appId": "cli_bbbbbbbbbbbbbbbb", "appSecret": "REPLACE_WITH_BILL_SECRET" },
      { "id": "jack", "appId": "cli_cccccccccccccccc", "appSecret": "REPLACE_WITH_JACK_SECRET" }
    ]
  }
}
```

The four required role IDs have built-in names and responsibilities. Additional roles may supply an explicit `name` and `responsibility`, plus a unique application; the roster accepts 4–16 entries. Sam inherits the canonical credentials and must not specify them again. Dispatch groups must be a nonempty subset of the existing group allowlist. Preserve unrelated groups when merging configuration. Configuration is read at startup and malformed values stop startup.

At startup the service imports `feishu.dispatch` into its team registry (`team-registry.sqlite` in the state directory), and dispatch reads the roster only from there. Until the agent console saves its first change, each start imports the file again and records a new registry version when it differs, so editing this fragment and restarting still changes the roster. After the console's first save, this fragment no longer changes the roster. The registry stores Alice, Bill and Jack's App Secrets beside its versions with owner-only file permissions, never inside a version; Sam's secret stays in `feishu.appSecret`.

Teams are edited on the console's 团队管理 page, and saves apply without a restart. A team added there uses an existing Feishu application: its App ID and App Secret are entered on the page, and the secret is stored in the registry, never shown. The service then checks the credentials and the bot. Sam adds the bot to each bound group, and the team's application confirms it is in the group. Sam's application must therefore be allowed to add bots to the dispatch groups and to read their group information. Which permission scopes this needs is not yet verified on a real tenant. A group where only the owner and admins add members needs that setting changed in Feishu, or the bot added by hand, before 「重新检查」. Sam announces each team that starts or stops taking work in a group; a failed or uncertain announcement is never resent.

## Public ingress and cutover

1. Prepare the reviewed release and locked dependencies using the repository-pinned Node 26.7.0 runtime. Complete automatic checks before changing production.
2. Prepare a stable HTTPS hostname and a tunnel/reverse proxy whose sole upstream is `127.0.0.1:4318`. The receiver itself binds only loopback. Expose only the configured callback path; never expose administration port 4317 or `/api/state`. The ingress must preserve request bodies and Feishu signature headers and must not insert an interactive login challenge.
3. Stop the existing service and wait for it to finish closing its state stores; a closed HTTP listener alone does not prove shutdown is complete. Confirm no service process still holds the state directory, then make an owner-only backup of the complete private state directory and launcher configuration. Include SQLite WAL/SHM files and retained migration markers. Compare source hashes before and after copying with the backup hashes; if they differ, wait for shutdown and repeat the backup before changing the release or configuration. Do not run two service instances against the same state.
4. Merge the configuration, preserve file permissions (`0700` directory and `0600` secrets), and point the launcher at the prepared release. Start the service and ingress. Verify local channel readiness, then configure Sam to send encrypted events to `https://YOUR_HOST/feishu/events` and complete authenticated URL verification. Publish required platform changes.
5. Check that an unrelated public path and administrative path are unavailable. A callback challenge, healthy process or local readiness alone does not establish message delivery. Follow the acceptance sequence below in the actual group and both existing private chats.

The computer and ingress must stay available. Admission is durable before acknowledgement, but there is no separate cloud queue. Local stores include `feishu-callbacks.sqlite`, `team-registry.sqlite`, `agent-dispatch.sqlite` and `agent-sessions.sqlite`, alongside existing workflow and task state. Keep the entire state directory when changing releases. A credential change may invalidate queued callback or dispatch authority; do not expect it to migrate work to another identity.

### Cloudflare Tunnel routing

Install the official `cloudflared` client and create a tunnel in the domain's Cloudflare account. Map the selected public hostname to the callback receiver using an exact path rule and a catch-all rejection. For a locally managed tunnel, the ingress portion is:

```yaml
ingress:
  - hostname: agents.example.com
    path: ^/feishu/events$
    service: http://127.0.0.1:4318
  - service: http_status:404
```

Replace the example hostname and supply the tunnel's private credentials separately. The path is preserved when forwarding. Validate the configuration with `cloudflared tunnel --config <config-path> ingress validate`, then use `ingress rule <url>` for the callback, `/api/state`, `/`, and a longer callback-like path. Only the exact callback should match the local service; the others must match `http_status:404`. These offline checks do not establish DNS, connector health or live Feishu verification. Follow [Cloudflare's setup](https://developers.cloudflare.com/tunnel/get-started/) and [configuration reference](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/) for the selected tunnel management mode.

## Acceptance sequence

Use one test group, the owner's existing allowlist entry and harmless files in an already authorized directory. Record the deployed commit/release, exact incoming messages, visible bot identity, actual replies, received files, task outcomes and human confirmation. Automated fixture delivery is separate evidence.

| Scenario | Group action | Required observation |
| --- | --- | --- |
| Explicit work | Without @, ask Alice's domain: “帮我根据这些已知事实写闲鱼商品文案：二手桌灯，黑色，正常使用，灯座有划痕，售价 50 元；未知信息标为待补，不要发布。” | Alice posts which Executor handles the listing, then a closing message with the result. No Executor posts. Missing facts are not invented; no website publication occurs. |
| Bill artifact | “请规划南京一人一天行程：从南京站出发，预算 300 元，日期为我接下来指定的日期。交通、开放安排和天气请注明来源，估算单列；保存并发给本群，不要预约。” Supply the actual date when asked. | Bill names the Executor, obtains missing essential inputs, and delivers the saved plan under Bill's bot, then closes. Inspect stations, date/source freshness, budget, estimates and alternatives inside the file. |
| Jack artifact | Supply an authorized test-project path and reproducible problem: “价格减优惠后不能为负数。请读取 discount.ts，交付补丁与测试用例，不要修改原项目，也不要声称运行了测试。” | Jack names the Executor; the reviewable patch/test artifact arrives under Jack's bot with an accurate unexecuted-test status. Check the source remains unchanged. |
| Inferred task | Discuss a possible trip without requesting action. If Sam proposes help, add two conditions, then confirm as the original author. | No Team Leader or Executor work before confirmation; both conditions and the confirmation constraints affect the accepted task. Another member cannot confirm it. |
| Genuine wrong-role mention | Use Feishu's actual @ selector to mention Bill for a code problem. | Bill explains the mismatch, Sam reassigns, and only Jack's team handles it. A typed name alone does not confer mention priority. |
| Several Assignments | Ask Jack for three harmless parts at once, for example “整理 discount.ts 的问题说明，列出三个回归用例，再写一段修复思路；不要修改项目。” Make one part impossible to finish, such as reading a directory that is not authorized. | Jack posts one start message with one line per part, a failure post with the host-known cause while the others still run, then one closing with one line per part naming the failed one. The request is partially failed; an explicit retry by the author reruns only that part. |
| Dependent parts | Ask Jack for parts where one needs another's result, for example “整理 discount.ts 的问题说明，列三个回归用例，再根据用例写修复思路；不要改项目。” Make the regression cases impossible to finish, such as reading a test directory that is not authorized. | Jack's start message ends the dependent part's line with 「（等 2 完成后开始）」 (its prerequisite's position). No post marks a waiting part's start. When the prerequisite fails, the dependent part does not start; the closing names it as not started, says which part it waited for and that a retry redoes that part first. An explicit retry by the author reruns the failed part, then the dependent one, which works from the new result. |
| Many parts | Ask for work Jack would divide into six or more parts. | Jack's start message lists one line per part and all of them start without anyone confirming the size. A request never runs more than ten parts: with more, Jack merges them or reports that nothing could start. |
| Ownership and interruption | During a safe request, send a supplement, then cancel as its author. Repeat another member's attempted control only after explicitly adding that member for testing. | Author controls are received while work is active; other members cannot take over. Completed actions are reported, not described as undone. |
| File choice | Ask for an ambiguous harmless file selection; answer as the original author, including after a coordinated restart. | The selected file arrives through the original Team Leader's bot in the original group, followed by its closing message; another member's short answer cannot select it. |
| Reminder and memory | Ask one team for a short one-time reminder and to note a harmless fact. Restart before it is due; later ask the same team, then another team, about that fact. | Reminder retains its Team Leader's bot and group. The same team's Executors recall the fact; another team's Executors do not, and no Executor sees the group's earlier discussion. Private/other-group facts remain inaccessible. |
| Legacy channels | Use an existing private Weixin command and Feishu private chat, plus an enabled group outside dispatch. | Existing destinations, file grants and mention-only behavior remain intact. Confirm actual receipt separately from channel acceptance. |

Natural-language routing can clarify instead of dispatching when information is missing. Preserve the actual response rather than replacing it with an expected script. Do not force real failures that risk duplicate actions; deterministic restart, revocation, unknown-delivery and rejected-report tests cover those mechanics, while a real unknown send must be inspected in the original group before any further action.

## First start after the visibility upgrade

- Group memory curated before this upgrade may hold facts the curator drew from Executor results. It is kept, and Sam may recall those facts; new captures hold only the request and what Sam and the Team Leaders posted for it.
- To read a group's memory, open `GET /api/state` in an owner-authorized browser. It is served by `apps/weixin-service/src/http-server.ts:168`, or by `apps/weixin-service/src/channel-status-server.ts:19` when only Feishu is enabled. The text is the `memory` field of the entry in `codex.memory.accounts[]` whose `accountId` is the group's `feishu.group.<hash>` memory account. The console page does not show it, and no route deletes it.
- While no console save exists, the first start records a new team-registry version, because Jack's seeded Executor profile changed. Requests planned afterwards use that version.

## First start after the dependencies upgrade

Assignments stored before this change have no dependencies and keep their behavior: a request that was running restarts as the several-Assignments section below describes. Plans made afterwards may mark dependencies. No stored state is migrated.

## First start after the several-Assignments upgrade

A request whose Assignment was running when the previous process stopped is no longer failed at once with a single report. Each Assignment that was running gets an interruption post under its Team Leader's bot, and the Team Leader's closing for the request follows. Inspect `/api/state` for running requests before the deploy if you need to anticipate them. Requests stored before Team Leaders handled them keep the report described below. Assignments stored before this change keep their side-effect keys, so retrying one still reports its completed effects instead of repeating them.

## First start after the team-handling upgrade

Requests stored before Team Leaders handled them keep their stored handling. At the first start after deploying this change, only two kinds of group message can appear without anyone acting: an interruption report for a request that was running when the previous process stopped, and notices that the previous process had queued but not yet sent. Both are what the previous version would have posted at its next start. Inspect `/api/state` for running requests before the deploy if you need to anticipate them.

## Executor runtime homes

Each Executor's runtime home is `group-model-runtimes/dispatch-<64 hex>/` in the state directory. Once the Executor's runtime is released and its App Server process has exited, the home keeps only its thread rollouts: `codex-home/sessions/` and, if present, `codex-home/archived_sessions/`. Everything else in the home is removed:

- the App Server's SQLite databases with their `-wal` and `-shm` files;
- its logs, locks and temporary files;
- the copied login (`auth.json`), `config.toml` and the model catalog;
- the empty `home/` and `workspace/` directories.

A retry resumes the Assignment's thread from its rollout. The App Server rebuilds its databases, and the service writes the configuration, login copy and catalog again.

The first start after deploying this compacts every existing Executor home in the same way, including the homes of the earlier one-specialist dispatch, before any dispatch work runs. Every later start repeats the sweep. The homes of the Coordinator (`dispatch-coordinator`), the Team Leaders (`dispatch-leader-…`) and group conversations are not touched, and no rollout is ever opened, changed or removed. Compacted Executor homes need no restore when rolling back to the previous release: it resumes Executor threads from the same rollouts.

When the service cannot confirm a home's records, it keeps the whole home and writes one line to standard error, for example `dispatch_executor_home_kept:rollout_missing:dispatch-<64 hex>`. The reasons are:

- `rollout_missing`: the thread recorded for the home has no rollout there, or no thread is recorded and the home holds no rollout;
- `removal_failed`: an entry could not be removed; what remains is kept and the next start tries again;
- `home_invalid`: the home or its `codex-home` is not a real directory;
- `compaction_failed`: the session store could not be read.

`dispatch_executor_home_deferred:process_running:dispatch-<64 hex>` means a released runtime's App Server had not exited within 10 seconds; the next start compacts that home. `dispatch_executor_homes_unreadable` means the start could not list `group-model-runtimes/`, so it compacted no home. A kept home is reported again at every start. Inspect it; do not delete its rollouts.

## Rollback and diagnosis

For operational rollback, first stop intake and inspect existing in-flight work. Remove `feishu.dispatch` to restore mention-only handling on the current binary, keeping the same state. If returning Sam to long connection, remove `webhook`, set `receiveMode` to `websocket` (or omit it), restore that mode in Sam's platform console, and restart once. Reminders created under a Team Leader's bot still need their original application route; disabling dispatch does not transfer them to Sam. Reconcile those tasks before removing their configuration.

Retain new state and delivery evidence. Do not restore a pre-cutover database over later accepted or uncertain sends, or downgrade the binary without checking compatibility. Re-enabling a prior identity can make retained eligible work available again; inspect the queue before resuming.

Inspect local `/api/state` in a browser authorized with the [local login command](../../apps/weixin-service/README.md#local-login) for dispatch outcomes and the normal private diagnostics for error codes. Never post raw state, callback bodies or credentials to an issue. A failed acceptance notification prevents that attempt from starting; a rejected final report can be explicitly retried by the author without repeating business work. Unknown delivery cannot be treated as rejected.
