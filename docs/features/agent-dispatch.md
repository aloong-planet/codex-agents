# Automatic group task dispatch

> Related decisions: [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md)

## Overview

Authorized members of selected Feishu groups can ask for help in ordinary discussion without choosing a bot first. Sam routes each request to the responsible team, whose Team Leader divides the work among one or more Executors, says who handles each part, and closes the request with its result in the same group.

## Capabilities

- Sam routes requests to Alice's team for commerce operations, Bill's team for everyday-life planning or Jack's team for development work. Sam and each Team Leader speak with their own bot identity; Sam clarifies and reassigns without executing business tasks.
- In each group, only the teams currently taking work there receive requests. A team bound to the group whose setup there is not complete gets no work and posts nothing, even when mentioned.
- Explicit requests can start work immediately. Possible tasks inferred from discussion are proposed first and wait for the original author's confirmation.
- A genuine mention gives that Team Leader's team priority. If the request falls outside its team's role, the Team Leader explains the mismatch and Sam assigns a suitable team. Unclear assignments or references receive a clarification question.
- Before work starts, the Team Leader posts one message naming the Executor for each part, as 「我安排<executor noun> <number>（<capability profile>）处理：…」, where the noun is set per capability profile on the team management page and is 执行者 by default; with several parts it opens 「我安排：」 and gives each part its own line. Parts that need no other part's result then run at the same time. A part that needs the result of earlier parts ends its line with 「（等 1 完成后开始）」, naming them by position; it starts once they are all done, with no new message, and works from their final results. Decisions the Team Leader made for its team follow as separate messages.
- If one part fails while others still run, the Team Leader posts which part could not be finished and why, such as a timeout or a refused tool, and the other parts continue. Parts that wait for a part that failed or was interrupted do not start. When every part has ended, it posts one closing message with the summarized result, each part on its own line with its outcome, the cause of each failure and what was already done, each part that did not start and the part it waited for, or the request for more information. A request with some parts completed and some failed or not started ends partially failed.
- A request has at most 10 parts, across any number of teams, and needs no confirmation for its size. When the Team Leader's plan needs more, it merges parts; if it still cannot, it says so in the group and nothing starts.
- Executors never post in the group. Their files, choices and reminders arrive under their Team Leader's bot.
- If the Team Leader cannot form a valid division of the work, it says so in the group and nothing starts; the requester can add details and ask for a retry.
- Alice's team can turn supplied product facts into a saved listing package; Bill's team can save a sourced day plan with transport and budget estimates; Jack's team can inspect authorized source and deliver a proposed patch with test cases and an accurate validation status.
- Only the original requester can confirm, supplement, cancel or retry active work. Supplements and confirmation conditions remain part of the task. A supplement sent while work runs is taken up when that work ends: the Team Leader decides which parts it affects, only those parts' Executors receive it and redo their part, followed by the parts that depend on them, which work from the new results, and the Team Leader may add parts within the limits. A retry reruns only the failed or interrupted parts, each with its own Executor, and then the parts they left not started; completed parts are not redone. Cancellation stops every unfinished part and lists each part on its own line as completed, stopped, not finished or not started, reporting completed work without claiming to undo it.
- Each Executor works in its own session. It sees the request, its Team Leader's instructions for it, the final results of the parts it waits for, and what Executors of the same capability profile learned in this group; it does not see the group's earlier discussion or what Sam remembers.
- Sam remembers each finished request of the group from what was posted for it: the request, Sam's own posts about it and the Team Leader's messages, never an Executor's raw result. A cancelled request, an unconfirmed proposal or an ignored message is not remembered, so none of them can later produce a plan reminder from memory.
- Each Team Leader keeps its own memory of the requests it handled in that group, and knows which teams take work in the group and what each is responsible for. Private and other-group memories remain separate.
- Authorized members retain their existing file access. File choices stay with their requester; all authorized members can manage the group's scheduled tasks. Files and reminders keep their Team Leader's bot and their group after restart.
- Duplicate messages do not start duplicate work. Saved queued work recovers after restart. Each part interrupted while its Executor runs is reported under the Team Leader's bot, the Team Leader then closes the request, and the interrupted parts await an explicit retry when safe continuation is unavailable.
- Completion is assessed against the requested work. When you ask Jack's team for code and test cases without execution, delivering them can complete the request while clearly stating that tests were not run. Requested execution that cannot happen remains incomplete.
- Business completion and report delivery are separate. Retrying a rejected report does not execute the task again; accepted or uncertain sends are not automatically repeated.

## Boundaries and non-goals

- The group and initiating member must be enabled locally. Other members' delivered discussion can provide background but cannot authorize actions. Bot and system messages do not initiate work.
- One request is handled by one team, whose Executors share its parts. Work is not yet divided across teams, and neither Sam nor a Team Leader executes business tasks.
- Roles do not grant new directories, terminal commands, website accounts, publishing, purchases or bookings. Unsupported steps are identified as unexecuted; missing essential facts require clarification.
- Role selection and generated content depend on the model. Time-sensitive sources and estimates need review; a saved or delivered file alone does not prove its facts accurate.
- Every Team Leader's bot must be available in the group. A missing identity or destination cannot be replaced silently by another bot or chat.
- Reception and execution depend on the local computer and its public connection being available. Permissions and local settings take effect after restart. Platform acceptance and human receipt are separate observations.
- Private chats and groups without automatic dispatch retain their existing behavior.
