# Automatic group task dispatch

> Related decisions: [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md)

## Overview

Authorized members of selected Feishu groups can ask for help in ordinary discussion without choosing a bot first. Sam routes each request to the responsible team, whose Team Leader assigns the work to an Executor, says who handles it, and closes the request with its result in the same group.

## Capabilities

- Sam routes requests to Alice's team for commerce operations, Bill's team for everyday-life planning or Jack's team for development work. Sam and each Team Leader speak with their own bot identity; Sam clarifies and reassigns without executing business tasks.
- Explicit requests can start work immediately. Possible tasks inferred from discussion are proposed first and wait for the original author's confirmation.
- A genuine mention gives that Team Leader's team priority. If the request falls outside its team's role, the Team Leader explains the mismatch and Sam assigns a suitable team. Unclear assignments or references receive a clarification question.
- Before work starts, the Team Leader posts which Executor handles the request, as 「我安排执行者 <number>（<capability profile>）处理：…」. When the work ends, it posts a closing message with the summarized result, the failure and what was already done, or the request for more information.
- Executors never post in the group. Their files, choices and reminders arrive under their Team Leader's bot.
- If the Team Leader cannot form a valid division of the work, it says so in the group and nothing starts; the requester can add details and ask for a retry.
- Alice's team can turn supplied product facts into a saved listing package; Bill's team can save a sourced day plan with transport and budget estimates; Jack's team can inspect authorized source and deliver a proposed patch with test cases and an accurate validation status.
- Only the original requester can confirm, supplement, cancel or retry active work. Supplements and confirmation conditions remain part of the task. A supplement sent while work runs is taken up when that work ends, as a new round the Team Leader plans again. A retry reruns the failed work with the same Executor. Cancellation reports completed work without claiming to undo it.
- Each request's Executor works in its own session; same-group Executors share curated business facts. Private and other-group memories remain separate.
- Authorized members retain their existing file access. File choices stay with their requester; all authorized members can manage the group's scheduled tasks. Files and reminders keep their Team Leader's bot and their group after restart.
- Duplicate messages do not start duplicate work. Saved queued work recovers after restart. Work interrupted while an Executor runs is reported under the Team Leader's bot and awaits an explicit retry when safe continuation is unavailable.
- Completion is assessed against the requested work. When you ask for code and test cases without execution, delivering them can complete the request while clearly stating that tests were not run. Requested execution that cannot happen remains incomplete.
- Business completion and report delivery are separate. Retrying a rejected report does not execute the task again; accepted or uncertain sends are not automatically repeated.

## Boundaries and non-goals

- The group and initiating member must be enabled locally. Other members' delivered discussion can provide background but cannot authorize actions. Bot and system messages do not initiate work.
- One request is handled by one team and one Executor. The work is not yet divided among several Executors or teams, and neither Sam nor a Team Leader executes business tasks.
- Roles do not grant new directories, terminal commands, website accounts, publishing, purchases or bookings. Unsupported steps are identified as unexecuted; missing essential facts require clarification.
- Role selection and generated content depend on the model. Time-sensitive sources and estimates need review; a saved or delivered file alone does not prove its facts accurate.
- Every Team Leader's bot must be available in the group. A missing identity or destination cannot be replaced silently by another bot or chat.
- Reception and execution depend on the local computer and its public connection being available. Permissions and local settings take effect after restart. Platform acceptance and human receipt are separate observations.
- Private chats and groups without automatic dispatch retain their existing behavior.
