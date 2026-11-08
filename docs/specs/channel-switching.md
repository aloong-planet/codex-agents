# Personal channels and Feishu groups

> Status: startup supports one or both bound personal channels and allowlisted Feishu groups. General-assistant private owner memory is shared; each group has separate shared context, memory and tasks.
> Deployed: on 2026-11-05, the owner confirmed real-group bot mentions and replies, recall of ordinary group discussion, and a one-time reminder returning to the original group, using release `20261105-feishu-groups-626d865`.
> Pending: remaining real-group observations include multiple members, cross-group/private memory boundaries, file choices, restart and revocation; follow the [group acceptance procedure](../../apps/weixin-service/README.md#real-group-acceptance).
> Pending: real-channel observations remain for task lists, reminders, other media/pending choices, shared curated memory and restart recovery. Follow the [acceptance procedure](../../apps/weixin-service/README.md#real-channel-acceptance); fixture evidence and accepted subsets do not establish the remaining phone observations.
> Related: [workflow behavior](workflow-runs.md), [module permissions](workflow-module-permissions.md), ADR-0004, ADR-0008, ADR-0009, ADR-0010.

This specification covers the general assistant channels and group use. [Penny private bookkeeping](finance-assistant.md) has a separate application, financial history and owner binding; it does not participate in shared personal memory or the pairing flow below.

## Problem Statement

The owner wants to use Weixin and Feishu private conversations without stopping the service to change entry points. Both private conversations belong to the same person, but replies and pending choices must remain associated with their original conversation. The owner also wants designated people to use the assistant in designated Feishu groups without exposing personal memory or tasks.

## Solution

Activate the configured private channels together behind one independent business core. Keep owner memory, permissions and tasks shared, conversation histories separate, and replies bound to their source. New tasks and plan reminders retain the channel where they were created. Existing tasks without an explicit delivery preference use Feishu for future notifications; already-created delivery records retain their original destinations and outcomes. Configuration changes still require a restart. Feishu groups use explicit local chat and member allowlists, shared context within each group, and independent memory and tasks. In legacy group mode, ordinary discussion is context and only an authorized bot mention initiates a request. Explicitly enabled [agent dispatch](agent-dispatch.md) admits authorized ordinary messages under its separate recognition and confirmation rules.

## User Stories

### channel-switching::US-001 Use the personal assistant through either channel

As the same owner, I can use Weixin and Feishu without replacing the assistant's business capabilities.

- channel-switching::US-001/AC-01: After configuring both owner-bound channels and starting successfully, both Weixin and Feishu admit private messages without restarting between conversations. A configuration that enables only one channel remains supported.
- channel-switching::US-001/AC-02: Each enabled channel supports its retained personal assistant paths: text conversations, authorized local file operations, image/file delivery, persistent selections, memory and scheduled notifications. Channel-specific transport presentation may differ without changing authorization or delivery meaning.

### channel-switching::US-002 Preserve personal continuity

As the owner, I retain my personal data without accidentally merging unrelated conversations.

- channel-switching::US-002/AC-01: Explicitly bound Weixin and Feishu identities share the same owner's curated long-term memory, including saved facts and preferences. Memory recall may use evidence from either bound channel; this does not merge their raw conversation histories.
- channel-switching::US-002/AC-02: Switching preserves the owner's saved file permissions without granting additional access.
- channel-switching::US-002/AC-03: Weixin and Feishu keep separate raw conversation histories, model threads and conversation queues. A turn does not load the other channel's raw history or pending choices; returning resumes only its own eligible context. Shared curated memory remains available under channel-switching::US-002/AC-01.
- channel-switching::US-002/AC-04: Permission revocation invalidates recoverable model contexts across both channel histories where required by the existing permission semantics; switching back cannot restore revoked file content.

### channel-switching::US-003 Pair Feishu from a local terminal

As the existing owner, I can supply application credentials and confirm my private message locally instead of manually finding platform identity IDs.

- channel-switching::US-003/AC-01: A standalone command prompts for application ID and concealed secret, establishes a pairing-only connection, and displays a fresh one-time challenge with a five-minute lifetime.
- channel-switching::US-003/AC-02: Only an authenticated human private text message matching the current challenge can supply the candidate sender and chat. Malformed, unrelated, group, bot and expired messages cannot bind an owner.
- channel-switching::US-003/AC-03: Local confirmation of the candidate is required before a save preview; saving requires a second explicit confirmation. Default answers decline. Replacing an existing Feishu binding additionally requires explicit consent.
- channel-switching::US-003/AC-04: Saved configuration enables Feishu for the next startup while preserving any already configured Weixin membership, the existing owner memory key, Weixin binding and task scope. Missing or ambiguous legacy identities fail locally rather than inventing new storage identities.
- channel-switching::US-003/AC-05: Save produces a startup-valid private configuration with owner-only access using atomic replacement. Concurrent wizard execution or configuration changes during pairing cannot silently overwrite another result.
- channel-switching::US-003/AC-06: Cancellation, interruption, timeout, connection failure or unsuccessful saving closes the pairing connection without changing the original configuration. Failure messages and terminal output never expose application secrets.
- channel-switching::US-003/AC-07: Pairing never invokes the model, tools, scheduler, media downloads or outbound messages. Successful save closes the pairing connection and explains the next manual service start; it does not start, restart or switch the running service.

### channel-switching::US-004 Keep simultaneous conversations separate

As the owner, I can submit work in either chat without contaminating the other conversation.

- channel-switching::US-004/AC-01: Ordinary replies, error notices and media/file results return only to the initiating conversation and retain that channel's presentation rules.
- channel-switching::US-004/AC-02: Each conversation processes its messages in order. Both channels can accept messages while the other has unfinished work; ordering of shared side effects follows the existing permission and workflow contracts, without promising unrestricted parallel file mutation.
- channel-switching::US-004/AC-03: A choice or cancellation in one conversation cannot resolve the other conversation's Pending Request. The original Run, snapshot and destination remain authoritative.
- channel-switching::US-004/AC-04: Shared memory and permission updates cannot be lost through independent channel state snapshots. Narrowing permissions invalidates eligible contexts on both channels; existing in-flight permission checks remain in force.

### channel-switching::US-005 Discuss work with authorized group members

As the owner, I can enable selected Feishu groups and members so those members can use the assistant together.

- channel-switching::US-005/AC-01: Only a locally allowlisted group and a sender in that group's member list can initiate a request. Legacy mode requires an authenticated mention of this bot; enabled dispatch mode uses [agent-dispatch::US-001](agent-dispatch.md).
- channel-switching::US-005/AC-02: Members in the same group share conversation history and eligible model context; different groups and private conversations remain separate.
- channel-switching::US-005/AC-03: In legacy mode, ordinary messages from all human members of an enabled group supply context without invoking the model, tools, memory curation or task creation. In dispatch mode, authorized ordinary messages additionally enter recognition under [agent-dispatch::US-001](agent-dispatch.md); guest messages remain observation only. Sender identity remains attached to each observation; an unauthorized mention is also observation only.
- channel-switching::US-005/AC-04: Replies, errors, authorized file results and reminders return only to the source group. Joining a new group does not enable it automatically.
- channel-switching::US-005/AC-05: The owner maintains group and member lists in local configuration. Changes take effect on restart; malformed or duplicate entries fail validation without silently broadening access.

### channel-switching::US-006 Keep group memory independent

As the owner, I can collaborate without making personal memory available to a group.

- channel-switching::US-006/AC-01: Each group recalls and captures only its own curated memory, including plan evidence; private memory and other groups' memory are neither read nor written.
- channel-switching::US-006/AC-02: Group model configuration, recoverable threads, native tools, delegated tools and file tools cannot bypass this boundary to access service-private state or personal Codex memory.
- channel-switching::US-006/AC-03: Authorized members inherit the owner's granted business file operations and current revocations. This grants no additional directories and does not override protected internal-memory boundaries.

### channel-switching::US-007 Manage group work together

As an authorized member, I can manage the group's tasks while keeping another member's pending file operation under that member's control.

- channel-switching::US-007/AC-01: All authorized members of a group can create, inspect, edit, pause, resume and cancel its scheduled tasks and reminders. Lists, counts, pagination, history, direct references and explicit all-channel requests stay within that group.
- channel-switching::US-007/AC-02: Group task execution, plan follow-ups and retries retain the group's trusted destination; neither private nor other-group tasks can be read, edited or delivered through it.
- channel-switching::US-007/AC-03: A pending file choice, clarification or cancellation belongs to its original requester. Another member cannot select, cancel, supersede or recover that request; legacy mode requires the original requester to mention the bot again; enabled dispatch mode permits the requester's ordinary continuation under [agent-dispatch::REQ-007](agent-dispatch.md).
- channel-switching::US-007/AC-04: A new request by another member can coexist with the first member's Pending Request while sharing ordinary group conversation context.

## Functional Requirements

### channel-switching::REQ-004 Preserve personal tasks and bind future notifications

- channel-switching::REQ-004/AC-01: Scheduled tasks and plan reminders survive switching.
- channel-switching::REQ-004/AC-02: New scheduled tasks and plan reminders capture their creation channel and bound private destination; future notifications use that destination. Viewing or editing a task from the other channel does not silently change it.
- channel-switching::REQ-004/AC-03: Existing delivery records retain their original destination; selecting another channel does not reinterpret those records as new notifications to resend.

- channel-switching::REQ-004/AC-04: Default task lists include only tasks whose future notification destination is the current bound conversation. An explicit all-channel request lists the same owner's tasks across channels and identifies each reception channel. Filtering precedes view counts and pagination; inspection/edit by an explicit task reference remains owner-shared without moving its destination.

### channel-switching::REQ-005 Report channel failure (direct acceptance)

An invalid startup configuration, startup connection failure or active channel failure is reported locally. The application does not automatically select or send through the other channel.

### channel-switching::REQ-006 Select enabled channels at startup

- channel-switching::REQ-006/AC-01: Startup validates a nonempty, duplicate-free enabled-channel set drawn from Weixin and Feishu and each enabled channel's owner binding. Existing single-channel configuration remains readable. Each channel admits work only after its own connection is ready.
- channel-switching::REQ-006/AC-02: Missing or unsupported channel selection, malformed bindings or missing enabled-channel credentials fail configuration validation without admitting work. A channel connection failure never activates an unconfigured channel or redirects work.
- channel-switching::REQ-006/AC-03: The running process keeps its startup-configured channel set. A changed configuration takes effect only on the next start; there is no hot reload or runtime channel toggle.
- channel-switching::REQ-006/AC-04: Stopping and reconfiguring the service preserves stored owner memory, saved permissions, scheduled tasks and channel-specific conversation histories.

### channel-switching::REQ-007 Direct Feishu replies

- channel-switching::REQ-007/AC-01: Legacy Feishu business messages do not send a separate automatic processing acknowledgement. Enabled dispatch uses the task-specific selected-agent acceptance in [agent-dispatch::US-003/AC-01](agent-dispatch.md); ordinary replies, workflow results and failure notices are still delivered.
- channel-switching::REQ-007/AC-02: Weixin retains its existing native typing and text-acknowledgement fallback behavior.

### channel-switching::REQ-008 Migrate future notification preferences

- channel-switching::REQ-008/AC-01: On upgrading, existing tasks and plan reminders without explicit channel preferences acquire Feishu for future notifications. Migration is idempotent and preserves task IDs, schedules and owner scope; if the required Feishu binding is missing, report the migration prerequisite and do not silently choose Weixin.
- channel-switching::REQ-008/AC-02: Existing occurrences, cached results and accepted or unknown delivery records keep their original destination and outcome. Migration does not regenerate, redirect or resend them.
- channel-switching::REQ-008/AC-03: Reminder batching and response context respect each plan's captured destination. Plans originating in different channels cannot be combined into one channel's notification batch.

### channel-switching::REQ-009 Isolate channel failures

- channel-switching::REQ-009/AC-01: With valid configuration and a healthy shared core, a connection failure or disconnection on one channel does not stop the other healthy channel from admitting and replying to messages. Local status identifies each channel's readiness independently.
- channel-switching::REQ-009/AC-02: Notifications whose destination is unavailable retain their destination and use existing same-channel recovery rules. Unknown results remain non-retryable; a healthy alternative channel is not a fallback.
- channel-switching::REQ-009/AC-03: Shared infrastructure starts and stops once per process. Enabling two channels does not duplicate scheduled execution, memory workers or workflow effects.
- channel-switching::REQ-009/AC-04: Loss of the shared model connection invalidates live conversation readiness. Recovery preserves separate compatible saved threads and source destinations. Local diagnostics retain connection-exit, recovery-attempt and turn-failure details without affecting recovery. Automatic recovery follows channel-switching::REQ-010.

### channel-switching::REQ-010 Automatically recover model disconnections

- channel-switching::REQ-010/AC-01: An unexpected model-process/transport disconnection initiates reconnection without waiting for a new user message. Conversations using the same model runtime share one reconnection operation; intentional shutdown does not restart it.
- channel-switching::REQ-010/AC-02: An interrupted, still-authorized request automatically continues in its original compatible thread when recovery is safe. It retains its inbound identity, frozen model, queue position, source destination and final-reply ownership; the user need not resend it. No old completed request is replayed.
- channel-switching::REQ-010/AC-03: A request has at most three automatic recovery attempts within sixty seconds from its first disconnection. Exhaustion terminates that request with one truthful failure notice. A subsequent explicit user message remains eligible for ordinary recovery. Existing tool execution budgets, including the sixty-second file-query budget, accumulate across attempts and are not reset.
- channel-switching::REQ-010/AC-04: Recovery waits for previously admitted local operations to settle and uses retained host results. Completed mutations and claimed terminal workflows are not executed again. Uncertain side effects, untracked native tool effects, failed cleanup, missing context or changed authorization stop automatic continuation rather than guessing or silently starting a new context.
- channel-switching::REQ-010/AC-05: Retryable connection failures are distinguished from authentication, permission, quota, policy, protocol and ordinary business failures. Native model-stream retries already in progress are not duplicated by the host; late old-connection messages cannot affect the resumed attempt.
- channel-switching::REQ-010/AC-06: Recovery preserves the existing single final delivery path and channel acknowledgements. Accepted or unknown outbound delivery is not regenerated or resent. Closing the service cancels retry waits and drains admitted work before releasing request resources.

### channel-switching::REQ-011 Interpret group addressing

- channel-switching::REQ-011/AC-01: Compare platform mention identities with the authenticated bot identity, not display names, message substrings or a nonempty mention list. Mentioning another bot, typing its name, quoting it or using only @all does not invoke it; a genuine bot mention together with @all does.
- channel-switching::REQ-011/AC-02: Text and supported rich text preserve readable references to other people while removing the bot-addressing token without corrupting overlapping mention keys. Empty addressed text can receive an ordinary clarification without creating a task or file effect.
- channel-switching::REQ-011/AC-03: Ignore bot/system events and unlisted chats. Invalid metadata, failed bot-identity lookup or unavailable required platform permissions fail closed and produce local diagnostics; they never grant fallback access.

### channel-switching::REQ-012 Preserve group admission across interruption

- channel-switching::REQ-012/AC-01: Deduplicate group events through the durable ingress boundary. Each group's observations and requests retain arrival order; unfinished work in another conversation does not prevent admission or independent dispatch.
- channel-switching::REQ-012/AC-02: On restart, queued work, pending choices and model contexts remain subject to current group and member authorization. Revoked or changed bindings cannot replay previously admitted work or send cached work into a different conversation.
- channel-switching::REQ-012/AC-03: Group conversation recovery preserves requester, original destination, memory/task scope and existing effect ownership. Accepted or unknown effects are never automatically repeated.
- channel-switching::REQ-012/AC-04: Ordinary context is bounded and retains real authors and event identities. It is treated as quoted discussion rather than instructions from the authorized requester; truncation cannot turn an observation into an executable request.

## Constraints

### channel-switching::CON-001 Keep the business core independent

- channel-switching::CON-001/AC-01: Conversation, memory, file permission and workflow modules do not import Weixin/Feishu adapter implementations, platform SDKs or login UI modules.
- channel-switching::CON-001/AC-02: Core-owned messages and delivery references do not require Weixin context tokens, polling cursors or platform-specific target formats. Adapters own those protocol facts.
- channel-switching::CON-001/AC-03: Choosing a different configured adapter requires no changes to core business algorithms; the same behavioral contract applies to both adapters.

### channel-switching::CON-002 Explicit conversation authority

- channel-switching::CON-002/AC-01: Private conversations admit only the explicitly bound owner. Feishu groups admit business requests only under channel-switching::US-005/AC-01; passive observations grant no business authority.
- channel-switching::CON-002/AC-02: Only configured channels and explicitly authorized conversations admit work. A message or notification is delivered to its bound channel, not broadcast or automatically mirrored to another channel.

### channel-switching::CON-003 Preserve existing safety semantics

- channel-switching::CON-003/AC-01: The trusted host remains responsible for identity, destination, permission and operation binding; model parameters cannot choose arbitrary recipients or platform credentials.
- channel-switching::CON-003/AC-02: Existing terminal workflow ownership, immutable send snapshots, candidate revalidation and unknown-no-resend behavior remain in force.
- channel-switching::CON-003/AC-03: Existing persisted Weixin histories, frozen Runs and effect identities remain readable with their original meaning; migration does not mechanically relabel past Weixin operations as Feishu operations.

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
|---|---|
| Start with both channels, then alternate messages | channel-switching::US-001/AC-01; channel-switching::US-004/AC-01 |
| Submit messages in both chats while one is still processing | channel-switching::US-004/AC-02; independent histories under channel-switching::US-002/AC-03 |
| Ask for current tasks after legacy migration, then explicitly ask for all channels | channel-switching::REQ-004/AC-04; use notification preference, not retained storage identity; counts and pages remain scoped |
| Search a latest local video with large unrelated files in the directory | channel-switching::US-001/AC-02; metadata discovery must not exhaust content-read byte budgets; retain entry/time bounds and report genuinely incomplete scans |
| Create a reminder in Weixin, then edit it from Feishu | channel-switching::REQ-004/AC-02; destination remains Weixin |
| Create one plan in each channel and let both become due | channel-switching::REQ-008/AC-03; separate destination-bound batches |
| Upgrade existing tasks and repeat startup | channel-switching::REQ-008/AC-01; one idempotent preference migration |
| Upgrade with accepted/unknown/pending historical delivery | channel-switching::REQ-008/AC-02; original outcomes/destinations retained |
| Upgrade legacy tasks without a valid Feishu binding | channel-switching::REQ-008/AC-01; report prerequisite, never invent a destination |
| Start with empty/duplicate/unknown channel choices or malformed credentials | channel-switching::REQ-006/AC-01 and channel-switching::REQ-006/AC-02 |
| One configured channel cannot connect, then recovers | channel-switching::REQ-009/AC-01; other healthy channel continues |
| Lose the model connection while idle without sending another message | channel-switching::REQ-010/AC-01; reconnect without a new message |
| Disconnect before turn acceptance, during reasoning or after a read, with both chats active | channel-switching::REQ-010/AC-02; preserve inbound identity, threads, resources and destinations |
| Disconnect after a mutation or workflow claim, or while its result is being returned | channel-switching::REQ-010/AC-04; settle and reconcile host effects before any continuation |
| Lose connection again during recovery, or initialization never completes | channel-switching::REQ-010/AC-03; bounded attempts and deadline, one final failure |
| Encounter authentication/quota/policy errors or an upstream willRetry event | channel-switching::REQ-010/AC-05; no duplicate retry policy or failure reinterpretation |
| Receive stale old-connection events, revoke permission, lose saved context or stop during recovery | channel-switching::REQ-010/AC-04, channel-switching::REQ-010/AC-05 and channel-switching::REQ-010/AC-06 |
| Finish model work, then lose final delivery acknowledgement | channel-switching::REQ-010/AC-06; preserve accepted/unknown-no-resend |
| Destination disconnects before send, or outcome becomes unknown during send | channel-switching::REQ-009/AC-02; no cross-channel resend |
| Change configuration while running | channel-switching::REQ-006/AC-03; restart required |
| Restart both channels | channel-switching::REQ-006/AC-04; channel histories and shared personal data retained |
| Narrow permissions while both chats hold contexts or pending selections | channel-switching::US-002/AC-04; channel-switching::US-004/AC-04; existing revalidation rejects revoked access |
| Change trusted owner binding or receive an unauthorized foreign message | channel-switching::CON-002/AC-01; channel-switching::CON-003/AC-01 |
| Choose or cancel in the other chat | channel-switching::US-004/AC-03; no access to the original Pending Request |
| Send current/quoted/recent images or authorized local files through either channel | channel-switching::US-001/AC-02; channel-switching::US-004/AC-01; original bytes and bound destination retained |
| Receive unsupported audio/video/rich nodes, inaccessible or oversized media | channel-switching::US-001/AC-02; preserve channel-specific support and explicit failure boundaries |
| Receive a reply in Feishu versus Weixin | channel-switching::REQ-007/AC-01 and channel-switching::REQ-007/AC-02 |
| Stop or partially initialize the shared service | channel-switching::REQ-009/AC-03; no duplicate worker or second scheduler |

### Pairing boundaries

| User sequence | Required outcome / defining coverage unit |
|---|---|
| Launch with existing configuration or recognized legacy private state | Preserve stable identities; reject missing, malformed or ambiguous input rather than initialize new identities (channel-switching::US-003/AC-04) |
| Supply malformed credentials or a noninteractive terminal | Explain locally and do not establish a business session (channel-switching::US-003/AC-01, channel-switching::US-003/AC-06) |
| Receive wrong code, group/bot/media events, duplicate or late messages | Only one current private candidate can be confirmed (channel-switching::US-003/AC-02) |
| Decline identity, replacement or saving; interrupt at any prompt | Keep original configuration and close connection (channel-switching::US-003/AC-03, channel-switching::US-003/AC-06) |
| Lose connection or let the challenge expire, including during confirmation | End pairing without committing stale identity (channel-switching::US-003/AC-06) |
| Run a second wizard, edit configuration, encounter unsafe file permissions or a failed write | Refuse unsafe or conflicting replacement; preserve original bytes (channel-switching::US-003/AC-05, channel-switching::US-003/AC-06) |
| Save successfully, then start normally | Existing startup validation admits only explicitly bound owners; pairing messages are not replayed as business work (channel-switching::US-003/AC-07, channel-switching::REQ-006/AC-01) |
| External strings contain control characters or excessive text | Validate bounded scalar values and render only validated IDs; never interpret external content as terminal commands (channel-switching::US-003/AC-02, channel-switching::US-003/AC-06) |

### Group boundaries

| User sequence | Required outcome / defining coverage unit |
|---|---|
| Invite bot to an unlisted group, then mention it | Ignore under channel-switching::US-005/AC-01 and channel-switching::US-005/AC-04 |
| Guest discusses a task or mentions the bot; authorized member later asks about discussion | Observe with original author, never execute the guest request, under channel-switching::US-005/AC-03 and channel-switching::REQ-012/AC-04 |
| Mention another bot, @all, a name lookalike, quote/reply, or genuine bot plus @all | channel-switching::REQ-011/AC-01 |
| Send text/rich-text mentions with overlapping keys, empty request or malformed metadata | channel-switching::REQ-011/AC-02 and channel-switching::REQ-011/AC-03 |
| Alice waits on a file choice; Bob selects/cancels or starts another request; Alice returns | channel-switching::US-007/AC-03 and channel-switching::US-007/AC-04 |
| One group runtime fails on first startup or after persisted restart | Healthy private/other-group conversations continue; channel-switching::US-005/AC-02 and channel-switching::REQ-009/AC-01 |
| Two groups interleave discussion and mentions; one model turn stalls | channel-switching::US-005/AC-02 and channel-switching::REQ-012/AC-01 |
| Group asks for private/other-group memories or files containing internal state, including symlinks | channel-switching::US-006/AC-01 through channel-switching::US-006/AC-03 |
| Member names one of the owner's or Codex's bundled skills with `$<skill>`, or a request carries a skill input item for one | Nothing from it is listed or injected, in group, dispatch, pending-router and research runtimes alike, under channel-switching::US-006/AC-02 |
| Grant or revoke business files, then resume a saved group thread | channel-switching::US-006/AC-03 and channel-switching::REQ-012/AC-02 |
| Create a group reminder; another authorized member edits it; ask for all tasks or an outside task ID | channel-switching::US-007/AC-01 and channel-switching::US-007/AC-02 |
| Group/private plans become due together; original group becomes unavailable | channel-switching::US-007/AC-02; preserve destination and existing no-resend semantics |
| Deliver duplicate events, restart with queued work, revoke a member or group, then retry | channel-switching::REQ-012/AC-01 through channel-switching::REQ-012/AC-03 |
| Discussion includes instructions, links, attachment references or excessive text | Context is inert quoted data under channel-switching::REQ-012/AC-04; attachments enter existing authorized media paths only for admitted requests |
| Bot identity cannot be verified or all-message permission is absent | channel-switching::REQ-011/AC-03; no text-name fallback and no claim that unseen ordinary messages were recorded |

## Implementation Decisions

One process owns one mutable conversation-state authority, one memory system, one workflow engine and one scheduler. Startup validates an immutable enabled-channel set and admits each channel after its own connection starts. Old single-channel configuration remains readable. Channel connections and readiness are independent; replies retain source-specific presentation and delivery bindings.

ADR-0023 defines the group authorization, context and protected-memory boundary. The existing private owner binding is not reused as a group member identity. Group observations have no executable authority. Group and member configuration limits are 98 groups and 200 members per group. Passive context is limited to the preceding 100 observations, 1,000 characters each and 16,000 characters total. A group runtime failure is contained to that group; it never falls back to personal configuration. Private daily-news reconciliation metadata is not part of group task results.

ADR-0018 defines the shared-core channel boundary, ADR-0019 defines owner-shared memory with isolated conversations, and ADR-0020 defines captured notification preferences and frozen occurrence destinations. Their real-channel acceptance remains distinct from automated fixture validation.

Task storage identity is separate from delivery preference. New tasks and plans capture trusted source destinations; editing does not transfer them. Missing legacy preferences acquire the explicitly bound Feishu destination without rewriting frozen occurrences or reminder batches. Disabled bindings may retain preferences but have no active delivery port. The pairing CLI remains offline provisioning and preserves existing enabled-channel membership, owner identity and task scope.
Model recovery retains one request binding across protocol attempts. It prepares input once, preserves query references and budgets, drains admitted local operations before continuation, and releases resources once at the end. The same saved thread is resumed without a new-thread fallback. A strict host result cache prevents repeating a completed mutation; after any completed mutation, additional or changed mutation arguments stop automatic continuation because the host cannot distinguish a regenerated duplicate from a new intended step. Untracked native tools stop continuation conservatively. Retained recovery evidence is bounded to 64 KiB; exceeding it fails rather than truncating effect evidence. This recovery state lives in the service process and does not replay ordinary requests after service restart.

The recovery deadline bounds reconnection and admission of continuation attempts, not the duration of successfully resumed model reasoning. Previously admitted local operations must still drain before resources are released. The underlying connection and each interrupted request have bounded recovery state; concurrent requests share connection initialization while retaining separate request budgets and authorization checks. Authentication/protocol failures are not classified as connectivity failures. Scheduled research and memory-worker hosts retain their existing retry policies.

No new management screen is included in this design. Local machine-readable status reports channels separately; the existing Weixin panel remains Weixin-specific. Any later visible panel changes require their own confirmed UI prototype.

## Testing Decisions

Reuse the existing fixture-only inbound interface and production orchestration path as the highest behavioral test seam. Adapter-specific event framing uses transport fakes, not direct Provider calls or fabricated Run completion. Observe actual replies, original Run identity, effects and outbox deltas. Existing file permission and App Server protocol tests remain regression seams; this composition does not establish a second workflow engine.

Reuse the real main fixture ingress with both authenticated transport fakes enabled together. Interleave messages and observe exact replies, effects and destinations. Cover per-channel failure/recovery, separate queues and choices, simultaneous permission narrowing, a single scheduler, creation-channel reminders and repeatable migration with preserved frozen history. Existing memory and permission public-boundary tests supplement these scenarios; neither fixtures nor the logic prototype establish real device receipt or live-model semantics.

Pairing tests cross the public command orchestration seam with a controlled authenticated transport, scripted terminal responses and real private temporary configuration files. Reload saved output with the production startup parser. Separately exercise the terminal reader with controlled streams; live authentication and human confirmation remain real-platform acceptance. No business services are created by pairing.

Group verification reuses authenticated transport-shaped events and the real main fixture ingress. Test passive discussion separately from executable requests, requester-owned pending choices, group/private memory and task sentinels, and group-only delivery. Exercise actual model-runtime filesystem isolation with synthetic protected data; a prompt instruction or isolated memory store is insufficient evidence. Real-device observations must not be inferred from automation. Process requirements follow the current repository workflow and are not product acceptance IDs.

Recovery verification additionally injects process exit during a live turn and between a local operation and its tool response. Assert final replies, effect counts, retained budget and same-thread routing through the existing fixture seam. Protocol history alone is insufficient evidence of whether a host operation executed.

## Out of Scope

- Hot configuration reload, runtime channel toggles, live task handover, cross-channel task transfer and switching barriers.
- Unlisted groups, unlisted callers, automatic group enrollment and member management from chat.
- Implicit reply-to-bot activation without a real mention in legacy mode, and native group management screens. Enabled dispatch admission is defined separately in [agent dispatch](agent-dispatch.md).
- Automatic fallback or cross-channel resend on failure.
- Copying Pending Requests or merging conversation histories across channels.
- Native Feishu interactive cards, Feishu voice recognition and changes to existing Weixin voice support.
- Automatic chat mirroring, notification broadcast and changing task notification channels from chat in this increment.
- Changes to the meaning of local file permissions or repairs to memory curation quality unrelated to channel switching.

## Further Notes

This specification describes simultaneous personal channels and explicitly authorized Feishu groups. Deployment and real-channel acceptance must be recorded separately from implementation and automated fixture validation. The prototype does not operate a real service or edit real configuration. Neither document creation nor prototype inspection means production implementation, real-channel acceptance or merge authorization.
