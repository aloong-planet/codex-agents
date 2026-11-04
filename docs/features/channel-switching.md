# Personal Weixin and Feishu channels

## Overview

The owner can use bound Weixin and Feishu private conversations together or enable just one. Both retain the same personal memory and permissions while keeping each chat's context separate.

## Capabilities

- A local pairing guide accepts hidden application credentials, discovers your Feishu private conversation from a one-time message and asks you to confirm before saving.
- Pairing enables Feishu for the next start and preserves already enabled Weixin access and personal data. Cancellation, timeout or failed saving retains the original configuration.
- Only the explicitly bound owner's private conversations can use the assistant.
- Feishu supports text, images, files, supported rich-text messages, authorized local file operations and text reminders.
- Feishu replies directly without a separate automatic processing acknowledgement. Weixin retains its typing indication and fallback acknowledgement.
- Current, quoted and recent images and authorized local files can be selected and sent. Replies, errors and media return to the conversation that requested them.
- Saved choices resume in their original conversation after restart and still require valid file permissions. Choosing or cancelling in the other chat does not resolve them.
- Curated long-term memory and saved permissions are shared. Chat history, model context and message order remain independent; one chat can accept work while the other is busy.
- New scheduled tasks and plan reminders return to their creation conversation, including after edits from the other chat. Existing tasks and plans without a preference use Feishu for future reminders.
- Task lists default to the current notification conversation. Explicitly asking for all tasks lists both channels; inspecting or editing a known task from the other chat does not move its reminders.
- Due plans are grouped by their own notification conversation. Multi-message reminders and numbered reply context stay with that conversation.
- Local status reports each channel independently. A failed connection does not stop another healthy channel or redirect messages to it.
- The assistant reconnects after an unexpected model disconnection and safely continues the original request in its own chat, without requiring another message. Recovery makes at most three attempts within sixty seconds; a later explicit message can try again after exhaustion.

## Boundaries

- Recovery keeps the original file-query allowance and does not repeat completed changes or accepted or uncertain sends. Changed permissions, missing context, uncertain operations or exhausted recovery limits stop continuation with a failure notice.
- After a completed change, a recovered request can reuse its confirmed result; a new or changed mutation requires a fresh user request. Native operations whose effects cannot be reconciled also stop automatic continuation. Service restarts do not resume interrupted ordinary requests.

- Pairing requires an existing identifiable owner, a stopped service and a configured Feishu bot. Missing or ambiguous identity stops setup.
- Changes to enabled channels take effect after restart; there is no runtime switching or task transfer.
- Feishu does not support video, audio or interactive cards. Outgoing images are limited to 10 MiB and files to 30 MiB.
- Migrating old future reminder preferences requires a valid Feishu binding. A disabled destination remains unavailable rather than redirecting to an enabled one.
- Existing delivery outcomes keep their original destination. Uncertain sends are not automatically repeated.
- Unfinished plan-reminder batches left by interruption remain intact without rebuilding them for another chat. Explicitly revise the plan to schedule a new reminder.
- The existing management panel remains Weixin-specific; Feishu-only mode reuses saved permissions and provides read-only local status.
- Channel acceptance does not prove that the phone received a message.
