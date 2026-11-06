# Automatic group task dispatch

> Related decisions: [ADR-0024](../adr/0024-coordinate-independent-group-agents.md)

## Overview

Authorized members of selected Feishu groups can ask for help in ordinary discussion without choosing a bot first. Sam coordinates one specialist for each request, and that specialist announces its task and reports the outcome in the same group.

## Capabilities

- Sam selects Alice for commerce operations, Bill for everyday-life planning or Jack for development work. Each speaks using its own bot identity; Sam clarifies and reassigns without executing business tasks.
- Explicit requests can start work immediately. Possible tasks inferred from discussion are proposed first and wait for the original author's confirmation.
- A genuine mention gives that specialist priority. If the request falls outside its role, it explains the mismatch and Sam assigns one suitable specialist. Unclear assignments or references receive a clarification question.
- Specialists announce what they are preparing to handle before starting and report their result, failure or request for more information afterward.
- Alice can turn supplied product facts into a saved listing package; Bill can save a sourced day plan with transport and budget estimates; Jack can inspect authorized source and deliver a proposed patch with test cases and an accurate validation status.
- Only the original requester can confirm, supplement, cancel or retry active work. Supplements and confirmation conditions remain part of the task. Cancellation reports completed work without claiming to undo it.
- Same-group specialists share curated business facts while keeping separate execution histories. Private and other-group memories remain separate.
- Authorized members retain their existing file access. File choices stay with their requester; all authorized members can manage the group's scheduled tasks. Files and reminders retain their originating specialist and group after restart.
- Duplicate messages do not start duplicate work. Saved queued work can recover after restart; interrupted work reports failure and awaits an explicit retry when safe continuation is unavailable.
- Completion is assessed against the requested work. When you ask for code and test cases without execution, delivering them can complete the request while clearly stating that tests were not run. Requested execution that cannot happen remains incomplete.
- Business completion and report delivery are separate. Retrying a rejected report does not execute the task again; accepted or uncertain sends are not automatically repeated.

## Boundaries and non-goals

- The group and initiating member must be enabled locally. Other members' delivered discussion can provide background but cannot authorize actions. Bot and system messages do not initiate work.
- One request has one specialist. The assistant does not split it among collaborating agents, and Sam does not become a general business executor.
- Roles do not grant new directories, terminal commands, website accounts, publishing, purchases or bookings. Unsupported steps are identified as unexecuted; missing essential facts require clarification.
- Role selection and generated content depend on the model. Time-sensitive sources and estimates need review; a saved or delivered file alone does not prove its facts accurate.
- Every specialist must be available in the group. A missing identity or destination cannot be replaced silently by another bot or chat.
- Reception and execution depend on the local computer and its public connection being available. Permissions and local settings take effect after restart. Platform acceptance and human receipt are separate observations.
- Private chats and groups without automatic dispatch retain their existing behavior.
