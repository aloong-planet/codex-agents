# Personal channels and Feishu groups

> Related decisions: [ADR-0023](../adr/0023-isolate-feishu-group-authority.md)

## Overview

The owner can use personal Weixin and Feishu chats and enable selected people in selected Feishu groups. General-assistant private chats retain personal continuity; each group shares its own discussion, memory and tasks.

## Capabilities

- A local pairing guide accepts hidden application credentials, discovers the owner's Feishu private conversation from a one-time message and asks for confirmation before saving. Pairing enables Feishu while preserving already enabled Weixin access; cancellation, timeout or failed saving retains the original configuration and personal data.
- Only the bound owner uses private chats. In explicitly enabled groups, only listed members can invoke the assistant; joining a group never enables it automatically. The default mode requires a genuine bot mention; selected groups can use [automatic task dispatch](agent-dispatch.md).
- Feishu supports text, images, files, supported rich text and text reminders. Private chats and mention-only groups reply directly without an automatic processing acknowledgement; dispatch specialists announce the accepted task. Weixin retains its typing indication and fallback acknowledgement.
- Current, quoted and recent images and authorized local files can be selected and sent. Replies, errors and media return to the conversation that requested them.
- Saved choices resume in their original conversation after restart subject to current permissions. In a group, only the original requester can choose, clarify or cancel; mention-only groups require another bot mention. Another member's request can coexist.
- General-assistant private chats share curated personal memory; [Penny bookkeeping](finance-assistant.md) has separate private financial history. Each group recalls and saves only its own memory, including plans, independently of private chats and other groups.
- Members share their group's discussion history; private chats and different groups have separate contexts and message order. Other conversations can accept work while one is busy.
- Ordinary messages from all human members in an enabled group can inform a later answer, with their authors retained. In mention-only groups they do not themselves trigger replies or operations. Unlisted members cannot initiate work in either mode.
- Authorized group members use the owner's existing business-file grants. They gain no additional directories and cannot read service-private state or personal model memory through those grants.
- New tasks and plan reminders return to their creation conversation. Private tasks can be edited from either private chat; group tasks are managed by authorized members of that group. Editing does not move delivery.
- Private task lists default to the current notification conversation and can include both private channels on explicit request. Group lists, history and direct task references stay within that group, even when asking for all tasks.
- Due plans are grouped by their own notification conversation, with numbered reply context kept there. Existing personal tasks and plans without a preference use Feishu for future reminders.
- Local status reports channels independently. An unavailable channel or group runtime does not redirect its messages or stop healthy conversations.
- After an unexpected model disconnection, the assistant safely continues the original request in its own chat when possible. Recovery allows at most three attempts within sixty seconds; a later explicit message can try again after exhaustion.

## Boundaries and non-goals

- Group and member lists are maintained locally and apply on restart. Groups require Feishu permission to deliver mentions and ordinary group discussion; unseen messages cannot be used as context.
- In mention-only groups, a typed bot name, another bot's mention, a quoted reply or @all alone does not invoke the assistant. Ordinary context is limited to recent discussion; it is not a complete group archive.
- Group invocation does not inherit personal model integrations, skills or personal memory; naming one of the owner's skills in a group applies nothing. Business-file access remains subject to current grants and protected internal-state exclusions.
- Recovery retains file-query allowances and does not repeat completed changes or accepted/uncertain sends. Changed permissions, missing context, uncertain operations or exhausted limits produce a failure notice. Service restarts do not resume interrupted ordinary requests.
- After a completed change, recovery can reuse the confirmed result; a new or changed mutation needs a fresh request. Native operations whose effects cannot be reconciled stop continuation.
- Pairing requires an identifiable existing owner, a stopped service and a configured bot. There is no chat-based member administration, runtime channel switching or task transfer.
- Feishu video, audio and interactive cards are unsupported. Outgoing images are limited to 10 MiB and files to 30 MiB.
- Migrating old personal reminder preferences requires a valid private Feishu binding. Disabled destinations retain their own work without fallback. Unfinished plan-reminder batches are not rebuilt for another conversation.
- The existing management panel remains Weixin-specific; Feishu reuses saved permissions and local status. Both open only in a browser authorized through the [local login](agent-console.md). Channel acceptance does not prove phone receipt.
