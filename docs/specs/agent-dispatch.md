# Agent dispatch

> Status: implemented locally:
> - A Team Leader divides each group request into one to ten Assignments, one Executor each, all starting at once, with partial failure, retry, cancellation and supplements across them (tickets 05 and 07 of agent-teams).
> - Each agent sees only its own scope and, for Team Leaders, the group's Team Directory (ticket 06).
> - Cross-team work goes through the Coordinator (ticket 08).
>
> The console is specified here and not yet implemented.
> Related: [channel boundaries](channel-switching.md), [team management](team-management.md), [MCP catalog](mcp-catalog.md), [skill library](skill-library.md), [agent console](agent-console.md), [ADR-0023](../adr/0023-isolate-feishu-group-authority.md), [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md), [ADR-0031](../adr/0031-compact-executor-runtime-homes-to-their-rollouts.md).
> Pending: configure stable public ingress, deploy, and verify actual group receipt. Local fixture and model checks do not establish these outcomes.
> Pending: the console shows a group's memory read-only, with no delete action.
> Pending: a Team Leader can mark dependencies between Assignments; dependents start after their prerequisites complete.
> Pending: an Executor is named `执行者 <n>（<profile name>）` in the Team Leader's start message, an interim form. The confirmed form, `<profile noun> <n>` (such as 文案执行者 51), needs an Executor-noun field on Executor profiles, which the team-management page adds.

## Problem Statement

Authorized members express work in ordinary group discussion, and a backend decides whether an agent is needed. Under one-specialist dispatch, one specialist completed each request alone, and every specialist shared the same group memory, tools and code-defined instructions. As a result:

- one domain's rules and results reach every other domain;
- work cannot be divided;
- cooperation between domains has no defined path.

Members must still see who accepted the work, how it was divided, and its result.

## Solution

The Coordinator (Sam) receives group messages, recognizes requests and proposes inferred work to its original author. It then routes each Dispatch Request to the responsible Agent Team.

The team's Team Leader (Alice, Bill or Jack) handles the request:

- It divides the request into Assignments.
- It creates one Executor for each Assignment from the team's preset Agent Profiles.
- It reports in the group with its own bot identity: who does which part, team-internal decisions, progress, and a closing message.

Executors work silently and report only to their Team Leader.

When a team needs another team, its Team Leader asks the Coordinator. The Coordinator assigns the work as further Assignments of the same request and announces that assignment in the group.

Each agent sees only its Brief, its own memory and, for Team Leaders, the group's Team Directory. Only the Coordinator reads the group memory. Every agent's instructions, tools, MCP servers, skills and memory come from its own Agent Profile, which the host enforces.

## User Stories

### agent-dispatch::US-001 Request assistance without mentioning a bot

As an authorized group member, I want the service to interpret ordinary messages so that I do not need to select or mention an agent before requesting work.

- agent-dispatch::US-001/AC-01: An authorized member's ordinary group message can enter intent recognition without a bot mention.
- agent-dispatch::US-001/AC-02: When recognition determines that agent handling is unnecessary, the message is not forwarded for agent execution.
- agent-dispatch::US-001/AC-03: When handling is needed and the responsible Agent Team has been identified among the teams bound to the group, the Coordinator routes the request to that team's Team Leader.
- agent-dispatch::US-001/AC-04: The service can identify possible work implied by authorized members' discussion, even without an explicit request.
- agent-dispatch::US-001/AC-05: When an authorized member genuinely mentions a configured Team Leader, that team has priority over automatic team selection, subject to the out-of-role handling in agent-dispatch::REQ-004.
- agent-dispatch::US-001/AC-06: A task inferred from discussion is proposed to the original message author and is not dispatched or executed until that author confirms it.

### agent-dispatch::US-002 Recognize the type of work from the speaker

As a group member, I want each Team Leader and the Coordinator to speak with its own identity, so that I can see what type of work a message concerns without one coordinator relaying everything.

- agent-dispatch::US-002/AC-01: The initial roster contains the Coordinator and the three Team Leaders in agent-dispatch::REQ-002, with the responsibility boundaries defined there.
- agent-dispatch::US-002/AC-02: The Coordinator and every Team Leader bound to a group post with their own Feishu application bot identity.
- agent-dispatch::US-002/AC-03: Executors have no bot identity and never post in the group. Their results, files and media reach the group only under their Team Leader's identity.

### agent-dispatch::US-003 Follow a request from start to close

As a group member, I want to see how a request is divided, what is decided along the way, and how it ends, in the originating group.

- agent-dispatch::US-003/AC-01: When a Team Leader starts a request, it posts which Executor handles each of its team's Assignments.
- agent-dispatch::US-003/AC-02: When all of a team's Assignments in the request have ended, that team's Team Leader posts a closing message. When the whole request has ended, the lead Team Leader posts the request's closing message with the summarized result.
- agent-dispatch::US-003/AC-03: While work runs, the Team Leader posts team-internal decisions, progress and failures.
- agent-dispatch::US-003/AC-04: When the Coordinator assigns cross-team work, it posts the assignment in the group: which team takes which part, at whose request.

## Functional Requirements

### agent-dispatch::REQ-001 Return ambiguous assignments to Sam (direct acceptance)

When a message appears to require handling but its responsible team cannot be determined, the Coordinator clarifies and selects a team. This fallback does not permit the Coordinator to execute concrete business work.

### agent-dispatch::REQ-002 Confirmed roles

The following descriptions are the confirmed responsibilities of the default roster. They do not authorize every tool or action in those domains. The roster itself is maintained in [team management](team-management.md).

- agent-dispatch::REQ-002/AC-01: Sam is the Coordinator of every dispatch group. It routes, clarifies, reassigns and mediates cross-team cooperation, and never performs concrete business work, including for fallback requests.
- agent-dispatch::REQ-002/AC-02: Alice leads the commerce operations team (Xianyu, Taobao and similar sites).
- agent-dispatch::REQ-002/AC-03: Bill leads the everyday-life team (food, clothing, housing, travel planning and arrangements).
- agent-dispatch::REQ-002/AC-04: Jack leads the technical team (technical affairs and development).
- agent-dispatch::REQ-002/AC-05: A Team Leader plans, divides, coordinates and summarizes, never executes business work, and holds no side-effecting tools. Every team presets at least one Executor Agent Profile.

### agent-dispatch::REQ-004 Reassign out-of-role mentions (direct acceptance)

When an explicitly mentioned Team Leader receives a request outside its team's responsibility, it explains the mismatch in the group and the Coordinator reassigns the request. The mention does not grant an exception to the responsibility boundary.

### agent-dispatch::REQ-006 Initial team deliverables

The first concrete deliverables remain as follows. Each is produced by the team's Executors and delivered by its Team Leader. They use research, controlled file access, artifact delivery and only the capabilities that the team's Agent Profiles grant.

- agent-dispatch::REQ-006/AC-01: Given user-supplied product facts, Alice's team produces an editable listing package for Xianyu/Taobao: platform-appropriate titles, descriptions, condition disclosures and buyer FAQ. Unknown product facts are requested or marked as missing rather than invented; the package is saved and delivered to the originating group.
- agent-dispatch::REQ-006/AC-02: Given city, date, party size, preferences and budget, Bill's team produces a one-day itinerary with transport, meals, budget estimates and alternatives, and delivers the saved plan to the originating group. Time-sensitive claims identify their sources; estimates are distinguishable from verified facts. Missing essential inputs are clarified.
- agent-dispatch::REQ-006/AC-03: Given an authorized project location and a reproducible TypeScript problem description, Jack's team inspects relevant source and produces a reviewable patch with regression-test cases and an explanation. The group receives the artifact and an accurate validation status; no claim is made that tests ran when command execution is unavailable.

### agent-dispatch::REQ-007 Requester-owned active work

- agent-dispatch::REQ-007/AC-01: Only the original requester can confirm an inferred proposal, supplement, cancel or retry its active Dispatch Request. Group and requester authorization is rechecked when processing a continuation.
- agent-dispatch::REQ-007/AC-02: Follow-up messages can be received while Assignments are running. Ambiguous references to multiple active requests require clarification rather than changing an arbitrary request.
- agent-dispatch::REQ-007/AC-03: Cancellation applies to the whole request. Every unfinished Assignment, including cross-team ones, stops where possible, and completed actions are reported accurately without claiming that completed external effects were undone. Existing group scheduled-task co-management and requester-bound file choices retain their separate authority rules.
- agent-dispatch::REQ-007/AC-04: A supplement goes to the lead Team Leader. That Team Leader decides which Assignments it affects; it asks the Coordinator when another team's part is affected. Only the confirmed supplement reaches the affected Executors.

### agent-dispatch::REQ-008 Failure, recovery and delivery

- agent-dispatch::REQ-008/AC-01: A failed Assignment does not stop the request's other Assignments. When the request ends, the lead Team Leader's closing message names each failed Assignment, its cause and the known completed work, and the request becomes partially failed (or failed when no Assignment completed). The request then waits for an explicit requester retry. A retry redoes only the failed Assignments and retains completed-effect evidence instead of replaying completed actions. Existing bounded safe model-disconnection recovery remains available.
- agent-dispatch::REQ-008/AC-02: The service persists the following: admission, original requester, source group, lead team, every Assignment with its team, Executor and Agent Profile, and the request's definition snapshot. Duplicate platform messages cannot create a second business execution. A restart recovers queued requests and Assignments. Interrupted execution without sufficient safe-continuation evidence becomes a reported interruption of that Assignment, not a blind replay.
- agent-dispatch::REQ-008/AC-03: The service tracks business outcome separately from notification delivery. Notifications include start, decision, cross-team, closing and result messages. Retrying a rejected notification never re-executes business work, and accepted or uncertain notifications are not automatically resent.
- agent-dispatch::REQ-008/AC-04: If a Team Leader's application or the original group is unavailable, the failure is reported without substituting another bot identity or destination. Restart and configuration changes revalidate group and member authority before execution or delivery.
- agent-dispatch::REQ-008/AC-05: Invalid or ambiguous output cannot launch business tools or create Assignments. This covers Coordinator decisions, Team Leader plans and cross-team requests. The Coordinator can ask for clarification. Group discussion, Briefs and retrieved content never override the trusted roster, Agent Profiles, requester or destination.

### agent-dispatch::REQ-009 Authenticated durable callbacks

- agent-dispatch::REQ-009/AC-01: The public receiver validates Feishu application callbacks before admission, rejects invalid authentication or malformed/oversized input, and answers authenticated URL verification without starting business work.
- agent-dispatch::REQ-009/AC-02: Acknowledge a supported event only after durable local admission; normalization, media retrieval, model classification and execution run outside the callback response path. Deduplicate message events by platform message identity even when delivery event IDs differ.
- agent-dispatch::REQ-009/AC-03: Only the Coordinator subscribes to incoming human group messages. Team Leader applications provide outbound identities; bot and system events never start a dispatch loop.

### agent-dispatch::REQ-010 Preserve sender through business tools

- agent-dispatch::REQ-010/AC-01: Text, file and media results, pending continuations and scheduled notifications produced by an Assignment keep the responsible Team Leader's application identity and the original group across restart. Canonical group memory and task identity remain independent of the sending application.
- agent-dispatch::REQ-010/AC-02: Existing private channels, legacy mention-only groups, previously persisted tasks and delivery outcomes keep their original behavior when dispatch is not enabled. Existing Sam-owned task destinations remain valid without identity migration.

### agent-dispatch::REQ-011 Divide a request into Assignments

- agent-dispatch::REQ-011/AC-01: A Team Leader divides its team's part of a request into one or more Assignments. Each Assignment is performed by exactly one Executor, created for it from one of the team's preset Agent Profiles. The Team Leader chooses the profile and cannot add capability to it.
- agent-dispatch::REQ-011/AC-02: A request holds at most 10 Assignments in total, across any number of Agent Teams; cross-team Assignments count too. A plan or supplement that would take the request past 10 Assignments gets one tool-free correction turn in which its Team Leader merges Assignments. A plan still over the ceiling fails the request with the plan-failure report, and no Executor is created. No requester confirmation is involved.
- agent-dispatch::REQ-011/AC-03: The host validates every plan before creating Executors. Each Assignment must name a preset profile of the planning team, and no plan may take the request past its ceiling of Assignments.
- agent-dispatch::REQ-011/AC-04: An Executor exists for one Assignment only. When the Assignment ends, the Executor leaves the active organization. Its identity, process and result remain in the request's records.

### agent-dispatch::REQ-012 Visibility and memory scopes

- agent-dispatch::REQ-012/AC-01: Only the Coordinator recalls and captures the group memory. Each finished attempt of a group request is captured once, when its closing or result message is accepted in the group: the request's message with any confirmation or supplement, and everything the Coordinator and Team Leaders posted in the group for that request, in posting order. An attempt that ended cancelled is not captured, and neither are ignored discussion, a proposal its author never confirmed, a clarification that never became a request, or an announcement. Private conversations never contribute to it.
- agent-dispatch::REQ-012/AC-02: A Team Leader receives only three things: its Brief from the Coordinator, which includes the original message; its own memory, kept per conversation and leader; and the group's Team Directory. It never receives the group memory, another team's content or Executor memory.
- agent-dispatch::REQ-012/AC-03: An Executor receives only its Team Leader's Brief, which carries the original message down the Brief chain of agent-dispatch::REQ-012/AC-02; its own process; and the memory shared by Executors created from the same Agent Profile in the same conversation.
- agent-dispatch::REQ-012/AC-04: The Coordinator never receives Executor content, only what Team Leaders report to it or post in the group.

### agent-dispatch::REQ-013 Cross-team cooperation through the Coordinator

- agent-dispatch::REQ-013/AC-01: Only the lead Team Leader can ask the Coordinator for another team's help. A cross-team Assignment cannot request further cross-team help; its Executor reports needs to its Team Leader, which tells the Coordinator, which forwards them to the lead Team Leader.
- agent-dispatch::REQ-013/AC-02: The Coordinator decides how the teams cooperate, without asking the owner unless agent-dispatch::REQ-014 requires it. The work becomes further Assignments of the same Dispatch Request, under the other team's Team Leader.
- agent-dispatch::REQ-013/AC-03: Teams never exchange content directly. The cross-team Team Leader reports its result to the Coordinator, which passes it to the lead Team Leader in a Brief.
- agent-dispatch::REQ-013/AC-04: The cross-team Team Leader posts the start and closing of its own Assignments in the group (agent-dispatch::US-003/AC-01 and agent-dispatch::US-003/AC-02).
- agent-dispatch::REQ-013/AC-05: When no team takes a requested part, the lead Team Leader's closing names it as not handled and says the requester can ask for a retry once a team can take it. If every Assignment that was not cancelled completed, the request becomes partially unassigned (部分未落实); a failed or interrupted Assignment keeps the request partially failed or failed. An explicit retry asks the Coordinator again for every part no team took, and completed Assignments are not redone.

### agent-dispatch::REQ-014 Host-enforced confirmations (direct acceptance)

The host requires the original requester's confirmation before acting in exactly one case: work inferred from discussion (agent-dispatch::US-001/AC-06). No model output can skip this confirmation. Outside it, the Coordinator decides itself and may still ask a clarifying question.

### agent-dispatch::REQ-015 Group roster, Team Directory and announcements

- agent-dispatch::REQ-015/AC-01: In a group, the Coordinator routes and assigns only to Agent Teams that accept work in that group ([team-management::REQ-003](team-management.md)). Teams whose onboarding there is incomplete, and teams draining there, receive no new Assignments in that group, including cross-team ones in requests already running. Private requests follow [agent-console::REQ-006](agent-console.md).
- agent-dispatch::REQ-015/AC-02: Every Team Leader in a group receives that group's Team Directory: the names and responsibilities of the teams accepting work there ([team-management::REQ-004/AC-02](team-management.md)), and nothing else.
- agent-dispatch::REQ-015/AC-03: When a team is bound to a group or removed from it, the Coordinator posts an announcement in that group, and every Team Leader's next turn there uses the updated Team Directory. The announcement has its own delivery state; a failed announcement does not undo the binding change.

### agent-dispatch::REQ-016 Host-enforced Agent Profiles

- agent-dispatch::REQ-016/AC-01: Each agent's instructions come only from its Agent Profile. Shared code adds only domain-neutral safety rules; domain rules, such as travel and weather verification, appear only in the owning team's profiles.
- agent-dispatch::REQ-016/AC-02: An agent's host tools are the intersection of its profile's allowlist and the current module permissions. The Coordinator and Team Leaders receive no side-effecting tools.
- agent-dispatch::REQ-016/AC-03: An Executor receives `mcp__<server>__<tool>` proxy tools only for MCP servers that its profile attaches. The host re-checks every call against the caller's request snapshot and the current configuration (agent-dispatch::REQ-017). Calls outside them are refused and audited ([agent-console::REQ-004](agent-console.md)).
- agent-dispatch::REQ-016/AC-04: An Executor's runtime loads only the skills that its profile selects from the [Skill Library](skill-library.md). Host plugins and host skill discovery stay disabled.

### agent-dispatch::REQ-017 Definitions frozen per request, revocations immediate

- agent-dispatch::REQ-017/AC-01: A request uses the team, Agent Profile, MCP and skill definitions that were current when it was admitted. Changes saved later, including newly attached servers, newly allowed tools and changed instructions or skills, apply only to requests admitted afterwards, even for the request's later Assignments. A server's connection settings are not part of the snapshot ([mcp-catalog::REQ-002](mcp-catalog.md)).
- agent-dispatch::REQ-017/AC-02: A revocation takes effect at the next call in every request, including running ones. Revocations include unbinding an MCP server from a profile, disabling a server or tool, removing a host tool from a profile's allowlist and narrowing module permissions. The refused call is audited ([agent-console::REQ-004](agent-console.md)).
- agent-dispatch::REQ-017/AC-03: Availability for new Assignments always follows the current roster under agent-dispatch::REQ-015/AC-01.

## Quality Requirements

### agent-dispatch::QR-001 Bounded model runtimes

Applies to: every isolated model runtime used by the Coordinator, Team Leaders and Executors.

- agent-dispatch::QR-001/AC-01: A runtime that is idle beyond the configured idle limit is released. A released Coordinator or Team Leader session resumes from its persisted thread when next needed. An Executor's runtime is released when its Assignment ends.
- agent-dispatch::QR-001/AC-02: The number of concurrently running runtimes never exceeds the configured limit. Work beyond the limit waits and is not dropped.

The configured idle limit defaults to 5 minutes. The configured concurrency limit defaults to 16 running runtimes, idle or busy. Both defaults are derived from the measured per-runtime memory and start-up cost in the Sources of [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md).

### agent-dispatch::QR-002 Disk kept per Executor home

Applies to: the isolated runtime home of every Executor, including the homes left by the earlier one-specialist dispatch. The homes of the Coordinator, the Team Leaders and group conversations are excluded.

- agent-dispatch::QR-002/AC-01: Once an Executor's runtime has been released and its App Server process has exited, its home holds only its records: the thread rollouts. Everything else in the home is removed, and every rollout stays byte for byte unchanged.
- agent-dispatch::QR-002/AC-02: Each start compacts every Executor home before any dispatch work runs, under agent-dispatch::QR-002/AC-01 and agent-dispatch::QR-002/AC-03. This covers the homes written before compaction existed and the homes whose compaction a stop or crash cut off.
- agent-dispatch::QR-002/AC-03: Compaction removes nothing from a home whose records it cannot confirm: the thread recorded for the home has no rollout there, or no thread is recorded and the home holds no rollout. When a removal fails, the home keeps what remains. In both cases a diagnostic names the home and the reason, and the next start checks the home again. Rollouts are never opened, changed or removed.

## Constraints

### agent-dispatch::CON-001 Authorized human sources (direct acceptance)

Applies to: automatic dispatch. Only messages from authorized human members of enabled groups can initiate agent handling. Existing group and member allowlists remain the authority; observing other members' discussion does not authorize those members to initiate work.

### agent-dispatch::CON-002 Local deployment with stable ingress (direct acceptance)

Applies to: the dispatch deployment. Run the event receiver and agent service on the current computer and configure a stable public ingress for Feishu event callbacks. Offline reception and processing are limited by that computer's availability; no separate cloud queue is part of this deployment choice.

### agent-dispatch::CON-003 Isolated runtimes and owner-granted capability (direct acceptance)

Applies to: every Coordinator, Team Leader and Executor runtime. Each agent runs in its own isolated Codex runtime. Selecting a role, creating an Executor or dividing a request never widens authority. Capability beyond module permissions, such as website or browser operations, comes only from an MCP server that the owner registered ([mcp-catalog::US-001/AC-06](mcp-catalog.md)) and attached to that Agent Profile ([team-management::US-003/AC-03](team-management.md)), as [mcp-catalog::CON-001](mcp-catalog.md) states. The Coordinator's session receives no business tools.

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Authorized member sends ordinary explicit work | Recognize and route to the responsible team under agent-dispatch::US-001/AC-01 through agent-dispatch::US-001/AC-03 |
| Casual discussion contains an implied opportunity | Propose, wait for the original author, then route under agent-dispatch::US-001/AC-04, agent-dispatch::US-001/AC-06 and agent-dispatch::REQ-014 |
| Another member confirms/cancels; original author later answers | Preserve original ownership under agent-dispatch::REQ-007/AC-01; no guessed continuation under agent-dispatch::REQ-007/AC-02 |
| Several active requests receive an unqualified “cancel”, “retry” or “yes” | Clarify the intended request under agent-dispatch::REQ-007/AC-02 |
| Original author supplements while Assignments run | Lead Team Leader decides the affected Assignments; cross-team parts go through the Coordinator under agent-dispatch::REQ-007/AC-04 and agent-dispatch::REQ-013/AC-03 |
| Original author cancels while Assignments, including a cross-team one, run | Whole request stops where possible; completed effects reported, not undone, under agent-dispatch::REQ-007/AC-03 |
| Guest, bot or unlisted group sends task-like content | No execution under agent-dispatch::CON-001 and agent-dispatch::REQ-009/AC-03; guest discussion stays inert context |
| Mention by genuine platform identity, name lookalike, @all, quote or several Team Leaders | Only genuine configured mentions confer priority under agent-dispatch::US-001/AC-05; ambiguous selection clarifies under agent-dispatch::REQ-001 |
| Mention Bill for development work | Bill explains; the Coordinator reassigns under agent-dispatch::REQ-004 |
| Request spans commerce and development | Lead team handles its part and asks the Coordinator for the other team under agent-dispatch::REQ-013/AC-01 and agent-dispatch::REQ-013/AC-02; the Coordinator announces it under agent-dispatch::US-003/AC-04 |
| A cross-team Executor needs a third team | No nested cross-team request; the need returns to the lead Team Leader under agent-dispatch::REQ-013/AC-01 |
| No team accepting work in the group can take a requested part, or the Coordinator's decision for it is invalid | No Assignment and no post for that part; the lead's closing names it, and the request is partially unassigned unless an Assignment failed, under agent-dispatch::REQ-013/AC-05 and agent-dispatch::REQ-008/AC-05 |
| Requester retries a partially unassigned request | The Coordinator is asked again for every part no team took; a part now taken is announced and run, and completed Assignments are not redone, under agent-dispatch::REQ-013/AC-05 |
| A cross-team Team Leader's closing turn fails | Its post gives each of its Assignments' own results, then where they go; the lead still closes with that report under agent-dispatch::US-003/AC-02 and agent-dispatch::REQ-013/AC-03 |
| A cross-team plan, after its correction turn, still exceeds the ceiling or is invalid | The whole request fails with the plan-failure report and no Executor, as every turn of the division ends before anything is stored, under agent-dispatch::REQ-011/AC-02 |
| Plan, or a supplement, needs an eleventh Assignment | One correction turn merges Assignments; still over ten, the request fails with the plan-failure report and no Executor, under agent-dispatch::REQ-011/AC-02 |
| Plan needs several teams or many Assignments within the ceiling | It runs without any requester confirmation under agent-dispatch::REQ-014 |
| One of several Assignments raises a pending choice while the others run | The choice is posted at once and the others continue; the request waits once nothing else runs, and closes after the requester resolves it under agent-dispatch::REQ-010/AC-01 and agent-dispatch::US-003/AC-02 |
| Team Leader or Coordinator output is malformed, names an unknown profile or exceeds the ceiling of Assignments | No Executor or Assignment is created under agent-dispatch::REQ-011/AC-03 and agent-dispatch::REQ-008/AC-05 |
| No team can handle it; Coordinator output is malformed, empty or uncertain | Clarify without business execution under agent-dispatch::REQ-001 and agent-dispatch::REQ-008/AC-05 |
| Team Leader plans, Executors run, all complete | Start, progress and closing messages under agent-dispatch::US-003 |
| One of three Assignments fails | Others continue; closing names the failure; request partially failed under agent-dispatch::REQ-008/AC-01 |
| Requester retries a partially failed request | Only failed Assignments rerun; completed effects not replayed under agent-dispatch::REQ-008/AC-01 |
| Requester retries a failed request after its Executor's home was compacted | The Assignment resumes its own thread with its earlier process, because the rollouts are kept, under agent-dispatch::QR-002/AC-01, agent-dispatch::REQ-008/AC-01 and agent-dispatch::REQ-012/AC-03 |
| Requester retries while the failed attempt's runtime is still closing | The retry's runtime starts only after the old one's process has exited and its home was compacted, so compaction never removes a running runtime's files, under agent-dispatch::QR-002/AC-01 |
| A released Executor's App Server process does not exit | Its home is left as it is until the next start's sweep under agent-dispatch::QR-002/AC-02; the pool slot is freed after a bounded wait |
| Service stops or crashes while it compacts an Executor home | Rollouts intact; the next start finishes the compaction under agent-dispatch::QR-002/AC-02 |
| Compaction cannot remove an entry, or finds no rollout for the home's thread | The home keeps what remains and its records stay unchanged; a diagnostic names the home and the reason under agent-dispatch::QR-002/AC-03 |
| A retried Assignment's rollout is missing, for example removed by hand | Existing behavior, unchanged: the retry runs on a fresh thread without its earlier process. Compaction never causes this, because it keeps every rollout (agent-dispatch::QR-002/AC-01) |
| Deliver same message repeatedly, including changed delivery event IDs; restart after admission | One durable request under agent-dispatch::REQ-008/AC-02 and agent-dispatch::REQ-009/AC-02 |
| Stop during an Assignment, after a local write, or after a platform send | Existing safe recovery only; report the interrupted Assignment rather than repeat unknown effects under agent-dispatch::REQ-008/AC-01 through agent-dispatch::REQ-008/AC-03 |
| Start, cross-team, closing or result notification is rejected or uncertain; requester asks for another report | Delivery retry separate from execution under agent-dispatch::REQ-008/AC-03 |
| Remove member/group or replace a Team Leader's application credentials with queued work | Revalidate authority; no sender or destination fallback under agent-dispatch::REQ-008/AC-04 |
| A Team Leader's bot is not in the group when it must post | Report the delivery failure without another identity under agent-dispatch::REQ-008/AC-04 |
| Team is bound to the group, or removed, while requests run | Announcement under agent-dispatch::REQ-015/AC-03; removed team gets no new Assignments, running ones continue under agent-dispatch::REQ-015/AC-01 |
| Member asks for, or genuinely mentions, a team bound to the group whose onboarding there is incomplete | No Assignment for that team and no post by its bot; the Coordinator clarifies or routes to an accepting team under agent-dispatch::REQ-015/AC-01 |
| Requester cancels a request after its start message | Nothing of it enters the group memory, so no memory-derived reminder follows under agent-dispatch::REQ-012/AC-01 |
| The service starts on group memory curated while Executors still captured their results into it | That memory may hold facts the curator drew from Executor results. It is kept, the Coordinator may recall those facts, and nothing deletes them; new captures follow agent-dispatch::REQ-012/AC-04 |
| Owner edits a profile's instructions or skills, or attaches an MCP server, while a request runs | Running request keeps its snapshot under agent-dispatch::REQ-017/AC-01 |
| Owner unbinds an MCP server, disables a tool or narrows module permissions while a request runs | The next call is refused and audited under agent-dispatch::REQ-017/AC-02 |
| Brief, discussion, file or MCP result contains instructions to change roles, tools or destination | Treated as data under agent-dispatch::REQ-008/AC-05 and agent-dispatch::REQ-016 |
| Team Leader asks for a tool it lacks, or an Executor calls an MCP tool its profile does not attach | Refused by the host under agent-dispatch::REQ-016/AC-02 and agent-dispatch::REQ-016/AC-03 |
| Executor needs context its Brief lacks | It reports to its Team Leader; the Team Leader asks the Coordinator under agent-dispatch::REQ-012 |
| Group content requests private memory or another team's results | Group isolation and visibility scopes under agent-dispatch::REQ-012 and [ADR-0023](../adr/0023-isolate-feishu-group-authority.md) |
| Many requests start at once | Runtimes beyond the limit wait under agent-dispatch::QR-001/AC-02 |
| Every pool slot is held by a Team Leader that waits for an Executor's slot | Work that waits for a pool slot while holding one cannot block all progress, so work beyond the limit still runs under agent-dispatch::QR-001/AC-02 |
| First tasks lack product facts, trip constraints or repository access | Clarify missing facts and report validation truthfully under agent-dispatch::REQ-006 and agent-dispatch::CON-003 |
| Executor saves or sends a file, waits for a choice, schedules a reminder, then restarts | Team Leader identity and group frozen under agent-dispatch::REQ-010/AC-01 |
| Dispatch disabled; legacy private/group task becomes due | Preserve legacy behavior under agent-dispatch::REQ-010/AC-02 |

## Implementation Decisions

**Ingress (unchanged).** Feishu application event callbacks reach a loopback-only receiver exposed through a stable public ingress.

- The selected hostname and provisioning are deployment inputs, not part of message semantics.
- The receiver authenticates bounded raw bodies, handles URL verification, and durably spools supported messages before responding. An asynchronous consumer then feeds the existing production admission path.
- Platform message identity, not delivery event identity, supplies deduplication.
- Callback secrets and raw private payloads are excluded from diagnostics.
- Public ingress exposes no local administration routes. The agent console is served separately and only locally.

**Group authority and sending identity.** The canonical Sam application keeps the group authority, the group memory and the group scheduled-task scope. A Dispatch Request, each Assignment, each workflow delivery and each scheduled occurrence carry a separately trusted execution role and an immutable outbound application identity. An agent identity never replaces the human requester. Genuine cross-application bot mentions are resolved through platform application IDs, not display names or equality assumptions about application-scoped open IDs (ADR-0024, ADR-0026).

**Team registry.** A single team registry replaces the fixed four-role configuration and every hard-coded coordinator identity. The registry holds:

- the Coordinator, the teams and their Team Leader applications, and each team's group bindings and state (onboarding, accepting, draining);
- each agent's Agent Profile.

It starts from the existing local configuration with the same four roles and is later edited from the console ([team-management](team-management.md)). Every saved change produces a new definitions version. A request records the version it was admitted under (ADR-0028).

In each group, routing, mention priority, new Assignments and the Team Directory use only the teams whose binding to that group is accepting under the current definitions; a team may be bound to some dispatch groups only, and in any binding state. A request planned after its team stopped accepting work in the group gets no new Assignment there and fails with the team-unavailable report. Whether a retry may rerun an existing Assignment of such a team is decided with removal and draining (team-management::US-004).

**Profile resolution.** One resolution point gives the following for an agent and version:

- the instructions;
- the host-tool view (the profile allowlist intersected with module permissions);
- the MCP proxy tools;
- the skills;
- the memory scope.

Turns obtain these only through it. The host-tool view offers the catalog tools the profile allows. The host refuses any other call before it runs, and module permissions keep gating every call. The Coordinator never resolves to host tools. Domain-specific text is removed from shared prompt assembly and moved into the owning team's profiles. Before team behavior is enabled, the initial profiles reproduce today's behavior with two exceptions: the weather, route, walking, opening-hours and budget-and-schedule rules now reach only Bill's team, while the source-verification rules stay shared; and the code-and-tests example of the goal-scope reply rule now reaches only Jack's team's Executors. Changing a seeded profile makes the next start append a definitions version while no console save exists.

**Coordinator.** The Coordinator remains a tool-free structured-output turn. Its input is:

- the event, which also carries the group's recent discussion: up to the 100 latest human messages of the group before it, 16,000 characters in all;
- the Coordinator's own responsibility and those of the teams accepting work in that group;
- the group memory;
- the group's request list;
- reports from Team Leaders.

A decision naming a team that does not accept work in the group is refused like an unknown agent, and the Coordinator's clarification goes out instead. A mention of such a team confers no priority, and that team's bot posts nothing for it.

Its decisions are:

- ignore, clarify, propose, route to a team;
- control an existing request;
- assign a cross-team part.

The host validates them against the registry before acting.

**Cross-team turn.** A lead Team Leader's request for help gives the Coordinator a separate tool-free turn. Its input is:

- the request's message and summary;
- the lead team;
- each requested part's title and Brief;
- the teams that may take a part: those accepting work in the group that the request's definitions version knows, never the lead.

It places each part with one of those teams or with none, and writes a summary for the Team Leader that takes it. A decision that names a team not offered, leaves out or repeats a part, or is malformed places nothing. With no team offered, no turn runs and no part is taken.

**Team Leader.** A Team Leader turn is also tool-free. It returns a structured plan: Assignments with profile and Brief, decisions to post, a cross-team request, a summary, or a closing. The host validates the plan under agent-dispatch::REQ-011/AC-03, creates Executors, and sends the Team Leader's group messages with its application.

- Input: its Brief, holding the original message, the latest confirmation or supplement when it differs, and the Coordinator's summary; its team's responsibility; the IDs and names of its Executor profiles; its own memory, recalled with the Brief's latest text, else its message; and the group's Team Directory. Its profile resolves to its own instructions, its own memory scope and never to host tools.
- The Team Directory lists every team accepting work in the request's group, its own team included, by team name and responsibility only. Each plan and closing turn takes it from the current definitions, not from the request's definitions version.
- A plan holds Assignments and 0 to 5 decisions. A refused plan gets one tool-free correction turn in the same session, told why it was refused. A plan still invalid fails the request with the Team Leader's report 「我暂时无法形成有效分工，本次尚未开始处理。请补充需求后明确重试。」 and no Executor.
- **Ceiling.** The host counts the request's Assignments, every team's included. A plan, or a supplement's new Assignments, that would take the request past 10 is refused, and its correction turn is told to merge similar Assignments (agent-dispatch::REQ-011/AC-02). No team limit applies and no requester confirmation is asked (agent-dispatch::REQ-014).
- **Help.** A plan or supplement answer may name up to three parts for other teams, each with a title and a Brief.
  - Only the lead's parts are placed. A cross-team Team Leader's are kept as needs, which the Coordinator relays to the lead's closing (agent-dispatch::REQ-013/AC-01).
  - Each team that takes parts in an attempt gets one plan turn for all of them. Its Brief from the Coordinator is the request's Brief, who asked, and each part with the Coordinator's summary.
  - The lead's plan, the cross-team turn and every such plan end before anything is stored. A cross-team plan still invalid or over the ceiling after its correction turn therefore fails the whole request with the plan-failure report, and no Executor is created.
- Once the attempt's Assignments have their Executors, the Team Leader posts one start message. With one Assignment it reads 「我安排<Executor>（<profile name>）处理：<Assignment title>。完成后会在本群汇报。」; with several, 「我安排：」 is followed by one line 「<Executor>（<profile name>）处理：<title>」 per Assignment and a last line 「完成后会在本群汇报。」, as every group post with several items gives one item per line. A retry or supplement attempt lists only the Assignments that start in it. Executors start only after that message is accepted; a start message not confirmed as sent fails the request as before.
- **Cross-team posts.** With parts placed in an attempt, the attempt's posts come in this order:
  1. The lead's start message. It adds one line 「<part>需要其他团队支持，已请 <Coordinator> 协调。」 per part, before its last line, and so takes the several-item form.
  2. The Coordinator's announcement. With one part it reads 「应 <lead> 请求，<part>交给 <leader> 队；完成后经 <Coordinator> 交回 <lead> 汇总。」. With several, 「应 <lead> 请求：」 is followed by one line 「<part>交给 <leader> 队」 per part and 「完成后经 <Coordinator> 交回 <lead> 汇总。」.
  3. Each cross-team Team Leader's start message, in the start format, with the last line 「完成后经 <Coordinator> 交回 <lead> 汇总。」.

  Every start message must be accepted before any Executor starts. The announcement has its own delivery state and holds nothing up. An attempt that reruns only cross-team Assignments posts only their Team Leaders' start messages. Every post about an Assignment (its start, failure, pending choice or interruption) goes out under the Team Leader of the Assignment's own team. Every Assignment of a plan is independent: the attempt's Assignments run at once, each Executor in its own runtime and pool slot, waiting for a slot beyond the pool limit.
- The plan's decisions follow the start message, one post each under the Team Leader's identity. Each has its own delivery state, and a rejected or uncertain decision post stops no work.
- When an Assignment fails while another Assignment of the request is still unfinished, the host posts 「<Executor>（<profile name>）的分工「<title>」未能完成：<cause>。其余分工继续处理。」 under the Team Leader's identity. The cause is what the host knows, never the Executor's own text: 执行者报告无法完成, 有工具调用被拒绝, 执行超时, 运行环境不可用, 权限或可用上下文发生变化, 执行者未返回有效的结果报告, 服务中断, or else 执行连接中断或处理出错. The Assignment that ends last gets no separate post; the closing names it. No post marks an Assignment's completion: progress is carried by the start, decision, pending-choice and failure posts. Each post that reports a state change (a pending choice, a failure post) is stored in one step with that change.
- When none of the request's Assignments is queued, running or waiting, a second tool-free turn writes the closing message from every Assignment's title, Executor, status and result, so it names each failed Assignment, its cause and the known completed work, one line per Assignment. In a single-team request it is both the team's and the request's closing. If that turn fails, the host posts each Assignment's own result under the Team Leader's identity instead, so no outcome goes unreported. The request becomes completed when every Assignment that was not cancelled completed, partially failed when some of them completed, and failed when none did. When every one completed but a requested part had no team, it becomes partially unassigned. A request that is not completed adds its completed-effect evidence to the closing.
- **Cross-team closing.** When all of a cross-team Team Leader's Assignments of the attempt have ended, it closes its part in its own tool-free closing turn.
  - The post is that message, under its identity, with the last line 「结果经 <Coordinator> 交回 <lead> 汇总。」. If the turn fails, each of its Assignments' own results takes the message's place.
  - The message is its report. The Coordinator relays it to the lead's closing turn, which gets its own Assignments, each part with its team and report, and the needs reported, never another team's Executor results.
  - The lead's fallback closing lists its own Assignments' results and each relayed report.
  - A part no team took ends the lead's closing with the host's line 「<parts>没有团队承接，本次未处理；有团队可以承接后，可以明确要求重试。」. Once a retry has asked again, the line reads 「仍没有」.
- A cancelled request's report, under the Team Leader's identity, keeps 「已停止继续处理。<completed-effect evidence>已经完成的操作不会自动撤销。」 with one Assignment. With several, it opens 「已停止继续处理：」, gives one line 「<Executor>「<title>」已完成|已停止|未能完成」 per Assignment, and ends with the evidence and 「已经完成的操作不会自动撤销。」.
- **Supplements.** A promoted supplement gets one tool-free supplement turn in the same session. Its input is the Brief, the supplement, the lead's own Assignments (with their positions, Executors, profile names, titles and statuses) and the parts the lead asked for, each with its team.
  - The answer gives the positions of the Assignments the supplement affects, the positions of the affected parts, any new Assignments (validated like a plan and counted against the ceiling), new parts for other teams, and decisions.
  - The Coordinator relays the supplement, with no post, to the Team Leader of each affected part. That Team Leader's supplement turn sees only its own Assignments and answers the same way.
  - Positions number what each Team Leader is shown.
  - Its correction turn and failure report are the plan's.
- Once the closing is decided, the Team Leader's Brief, its division (each Assignment's Executor, profile name and title) and the closing are captured into its own memory. A request cancelled before then leaves nothing there. A memory failure never changes the request's outcome.
- Each turn holds its pool slot only for itself, so a Team Leader never holds a slot while its Executor waits for one. Its session is keyed by leader, conversation, binding, access revision and definitions version, and resumes from its persisted thread.

**Executor.** An Executor turn runs in its own isolated runtime with the profile's host tools, MCP proxy tools and skills. Its result returns to the Team Leader, never to the group directly.

- Its session is keyed by its Assignment, and its runtime is released as soon as its turn ends. An explicit retry, or a supplement that affects it, reruns the same Assignment, with the same Executor, on that session.
- Its turn's side effects (workflow runs, file-query and media evidence, file operations) are keyed by `<message key>#executor-<n>`: the message its latest run received (the request's message, or the supplement that reran it) and the Executor's durable sequence. Every Executor turn therefore has its own key, also when one message reruns several Assignments; a retry keeps it, so completed effects are reported instead of replayed. Assignments stored before several ran per request keep the message key.
- It receives the triggering message and its Team Leader's Assignment title and Brief: the Brief chain of agent-dispatch::REQ-012/AC-02, with the message's quote and attachments. It never receives the group discussion or the group memory. Files, media, pending choices and reminders it produces go out under the application of its own team's Team Leader, a cross-team Assignment's included.
- It recalls the memory of its Agent Profile in that conversation, with the title and Brief as the query. After its turn, the title and Brief and its result are captured there, unless the request was cancelled during the turn.
- Its reply rules carry only domain-neutral text. The code-and-tests example of the goal-scope rule that private chat and legacy group turns keep is in the technical team's seeded Executor profile instead.
- A pending choice it raises goes out verbatim under the Team Leader's identity as soon as it is raised, while the request's other Assignments run on. The request waits once nothing else runs. The requester's resolution ends the Assignment, and the Team Leader's closing turn follows once nothing else is unfinished.

**Runtime-supplied tools.** A turn's tool list is exactly its host tools, plus web search where the turn allows it. Codex's own tools are never offered ([ADR-0030](../adr/0030-offer-isolated-runtimes-only-granted-tools.md)): code-mode `exec` and `wait`, `apply_patch`, the MCP resource tools, `request_user_input` and sub-agents. This is how agent-dispatch::REQ-016/AC-02 and agent-dispatch::CON-003 apply to the model's tool list. They hold for threads started after that change. A thread saved before it keeps the old tool list in its history and sends it again when resumed; every tool on it is refused with no effect.

**Durable records.** Dispatch Requests keep their states: proposed, queued, running, waiting, completed, partially failed, partially unassigned, failed and cancelled. Assignments add their own states: queued, running, waiting, completed, failed, cancelled and interrupted. Notification state stays independent for each message. Completed-effect evidence is keyed by Assignment and aggregated per request. Cross-team Assignments belong to the original request. A request also keeps:

- the parts the lead asked other teams to take, each with the team that took it or none, and how often the Coordinator was asked;
- each cross-team Team Leader's latest report;
- the needs that cross-team Team Leaders reported.

The existing transition rules carry over to Assignments:

- Confirming a proposal queues the request. Its accumulated supplements and any new confirmation conditions become the active authorized source; background discussion alone cannot authorize a tool operation.
- Execution accepts a queued Assignment once. Completion, failure or cancellation ends that attempt.
- Waiting preserves an unresolved clarification or file choice.
- An interruption becomes failed unless existing safe recovery evidence authorizes continuation.
- An explicit retry keeps the prior attempt and its completed-effect context.
- Original-requester controls are admitted independently of execution. Existing requester-bound file-choice handling precedes fresh task recognition.
- Completion and the promotion of a queued supplement are recorded atomically, including completion through a pending file choice. A restart preserves both the previous result notice and the next turn.
- A supplement sent while Assignments run is promoted when the attempt ends, as before. The attempt's closing then reports the work the Assignments did without it, and no Executor turn has to take new input while it runs. The promoted supplement starts a new attempt: the lead Team Leader's supplement turn decides which of its team's Assignments it affects (another team's part goes through the Coordinator under agent-dispatch::REQ-013). Each affected Assignment reruns with its own Executor on its own session and receives the supplement as its triggering message; unaffected Executors receive nothing. A supplement sent while a choice waits supersedes the waiting Assignments, and the same turn decides.
- An explicit retry of a failed, partially failed or partially unassigned request reruns every failed and interrupted Assignment with its Executor and asks the Coordinator again for every part no team took; completed ones stay. A request that failed before its Team Leader divided it, or before it answered a supplement, is planned or answered again.
- After a restart, a request cut off in a Team Leader turn repeats that turn, which is tool-free. Each running Assignment becomes interrupted and gets its own post under the Team Leader's identity: 「服务中断，<Executor>（<profile name>）的分工「<title>」已中断，无法确认已完成的内容，不会自动重放。」. The request then runs any Assignment still queued and ends with the Team Leader's closing turn, which reports the known completed work. A stop of the service leaves the Assignments it cuts off to that report at the next start.

Each request records the definitions version it is first planned under. Assignments are stored apart from requests, and an autoincrement sequence numbers their Executors.

Requests running when several Assignments per request were introduced follow the restart rule above: each running Assignment gets an interruption post, then the Team Leader's closing turn reports the request.

Requests stored before Assignments existed carry no definitions version and keep the handling they were stored under. A proposed or queued one enters planning when it next runs. A running one fails with the interruption report. A waiting one resolves its pending choice through the earlier direct reply. A failed one is planned again on retry. Completed and cancelled ones stay readable. At the first start after the change, the only messages this can post are the interruption report of a request that was running, and notices that the earlier process had queued but not sent.

**Memory scopes.** Scopes are keyed as follows (ADR-0027):

- the Coordinator by group;
- a Team Leader by conversation and leader;
- Executors by conversation and Agent Profile (team and profile ID).

Recall and capture use only the caller's scope. The Team Leader and Executor scopes are separate memory accounts derived from the group's memory account, stable across access revisions and definitions versions. They are curated in the isolated group-memory curator's runtime with no notification route and no reminder ownership, so a planned event there creates no reminder; reminders come only from the group memory. Neither the personal memory curator nor the console's memory panel ever sees them.

The group memory is captured from the group's posts, never from an Executor. A post belongs to a request when it carries the request's own work forward:

- the mentioned team's scope explanation, the Coordinator's reassignment notice, its proposal and its acknowledgement of a supplement to that proposal;
- the Team Leader's start message, pending choice, and closing or result message, and a re-sent copy of that message.

Replies that refuse a control message, and clarifications without a request, belong to none. Each capture takes the request's accepted posts that no earlier capture took, so an attempt started by a supplement or a retry adds only its own posts. A re-sent report is captured once, when it is accepted.

**MCP and skills.**

- MCP servers are connected and held by the host service; Executors receive proxy tools ([mcp-catalog](mcp-catalog.md)).
- Skills are copied from the Skill Library into the Executor's runtime home whenever its runtime is created, a retry's included, because a released home keeps only its rollouts ([skill-library](skill-library.md), [ADR-0031](../adr/0031-compact-executor-runtime-homes-to-their-rollouts.md)).

**Runtime pool.** Runtimes are held in a bounded pool keyed by agent, conversation, access revision and definitions version, with idle release. The Coordinator's, Team Leaders' and Executors' runtimes share one pool. When work needs a new runtime at the limit, the least recently used idle runtime is released for it at once, instead of at its idle limit. A released runtime keeps its slot until its App Server process has exited, or until a bounded wait ends. Persisted thread identities let Coordinator and Team Leader sessions resume after release.

**Executor home compaction.** An Executor's runtime home keeps only its records: the thread rollouts in its Codex home's session and archived-session directories (agent-dispatch::QR-002, [ADR-0031](../adr/0031-compact-executor-runtime-homes-to-their-rollouts.md)). Everything else in the home is bookkeeping. The App Server's databases are rebuilt from the rollouts when it next starts. The configuration, the login copy and the model catalog are written again whenever the host creates a runtime. The rest are the App Server's logs, locks and temporary files. What is kept is an allowlist, so files that a later Codex version adds are removed as well.

- A runtime release compacts the home inside the pool's close, once the App Server process has exited. A new runtime for the same home, such as a retry's, starts only after that close settles. A process that has not exited within a bounded wait leaves its home to the next start's sweep.
- Each start sweeps every Executor home before dispatch work runs. Executor homes are recognized by their scope form, which the homes of the Coordinator, the Team Leaders and group conversations do not share; those homes are not compacted.
- Before removing anything, compaction checks the records by file name only: the rollout of the thread that the Executor's session records, or, for a home with no recorded thread, at least one rollout. A retry needs nothing else: the App Server resumes the recorded thread from its rollout alone, with the earlier process in the model input, and without the rollout it starts a fresh thread without reporting an error (ADR-0031 Sources).
- Compaction is idempotent and removes one entry at a time, so a stop at any point leaves the rollouts and some removable entries, which the next start removes.
- Executor memory (agent-dispatch::REQ-012/AC-03) is kept in the host's memory store, outside every runtime home, so compaction never touches it.

**Node runtime.** Deployment and local acceptance use the Node version pinned in the repository's CI configuration, matching the existing service runtime. A runtime upgrade must first verify real permission-worker writes and recovery; a successful model response does not establish filesystem compatibility. Node 26.13.0 fails that check. Its Permission Model also denies `FileHandle.sync()` and `FileHandle.datasync()`, where 26.7.0 denied `fs.fsync()`, `fs.fsyncSync()` and `fs.fdatasyncSync()` but allowed the `FileHandle` methods. The file-sandbox worker syncs each edited or written file before it replaces the target, so under 26.13.0 every file edit and write by the permission worker fails. The pin cannot move past 26.7.x until the worker's write durability is redesigned. Production's Homebrew Node is held at 26.7.0 with `brew pin`, and it is unpinned only after the permission-worker write and recovery validation.

**Brief capture.** Full task Briefs use a separate 64-KiB capture, distinct from the legacy short file-search input. Oversized captures fail rather than silently dropping author conditions.

**Legacy behavior.** Legacy mention-only admission remains the default; enabling dispatch changes only the explicitly enabled group request path. [channel-switching::US-005](channel-switching.md), [channel-switching::US-007/AC-03](channel-switching.md) and [channel-switching::REQ-007/AC-01](channel-switching.md) keep their legacy meaning, with explicit dispatch-mode exceptions. Their private/group isolation and requester boundaries continue to apply. Private channels and Penny (ADR-0025) are unchanged.

## Testing Decisions

**Behavioral seam.** Keep the existing real-main, fixture-only ingress and authenticated transport fakes as the highest behavioral seam. Drive platform-shaped messages through production admission, and observe:

- routing;
- plans, Assignments and Executors;
- group messages with their sending identity;
- requester controls, files and scheduled deliveries;
- durable outcomes after restart.

Do not substitute Provider calls or fabricated Run state for that route.

**Fixture decisions.** Fixtures take envelope and mention shapes from official Feishu examples and the installed SDK. Real-main dispatch cases inject already-decoded Coordinator decisions and Team Leader plans, exercising production parsing, validation and effects. Separate public tests for the Coordinator and Team Leader wrappers keep the production wrapper and substitute only the external runtime response. They cover tool-free invocation, JSON decoding, ownership and size rejection, and thread release. Neither fixture establishes live semantic accuracy.

- A Team Leader plan is injected per message as one value or a list, one per turn, so a case can drive the correction turn; the production correction loop and parsers still run. A supplement answer is injected with the supplement's message. Without an injected plan, the fixture plans one Assignment on the team's first preset; without an injected supplement answer, every Assignment is affected; without an injected closing, the closing repeats every Executor's result.
- A message can also inject the Coordinator's cross-team decision (`crossTeamDecision`) and each team's own Team Leader outputs (`teamTurns`, by team); a team without its own takes the message's. Without an injected cross-team decision the cross-team turn fails, so no part is taken.
- An Executor turn takes the model reply, hold and tool calls injected with its message. A message can instead give each Assignment, by title, its own turn (`executorTurns`), released by title, so a case holds, fails or scripts each Executor of one request apart.
- The fixture-only `WORKFLOW_FIXTURE_COORDINATION_RUNTIME=1` seam makes real main build the Coordinator's and Team Leaders' real runtimes in the shared pool, over the fixture App Server, which answers their turns with the injected outputs and records the tools each thread is offered. It drives the host-tool boundary of agent-dispatch::REQ-016/AC-02 through main's construction. Outside fixture mode, startup refuses the switch.
- In fixture mode the group and dispatch memory curators record each curation they receive, by curator and memory account, so real-main cases see which scope each turn reached (agent-dispatch::REQ-012). Recall is checked by seeding curated memory through the production memory tool host. The production dispatch curator's tool host, which keeps reminders out of Team Leader and Executor memories, never runs under fixtures; review and a live run cover it.
- The upgrade case builds pre-Assignment state by running this package at base commit 71ff31d with the current install, then starts the current code on it. It fails, never skips, when that commit cannot be archived, built or booted. The current seeded profiles differ from that commit's, so requests planned after the upgrade record definitions version 2. The owner may retire it once a deployment has migrated production's requests stored before Assignments.

**Profile boundary.** Profile enforcement is tested at the host tool boundary and the memory boundary:

- a turn's offered tools, and a call outside its view being refused;
- recall returning only the caller's scope.

These tests do not inspect prompt text.

**Runtime pool.** The pool is tested at its public interface: concurrency limit, idle release and resume.

**Home compaction.**

- The compaction rule is tested on seeded homes with the file set the App Server leaves after a turn: the listing that remains, the rollouts' bytes, the guard and a failed removal.
- In fixture mode the fixture App Server writes a rollout named after each thread it starts into an Executor runtime's Codex home, so real-main cases compact as production does. It does not model resuming from the rollout.
- The fixture-only `WORKFLOW_FIXTURE_COMPACTION_HOLD=1` seam stops compaction after its first removal, so a case can kill the service mid-compaction. Outside fixture mode, startup refuses it.
- Resume after compaction is tested on the installed App Server with the loopback fake model, opt-in like the other isolated runtime checks and rerun after every Codex upgrade. A failed Assignment with a host-tool call is compacted and retried; the retry resumes the same thread, with the first attempt's user text, tool output and answer in its model input.

**Live acceptance.** A real local HTTP receiver test keeps covering authentication, URL verification and fast durable admission. Real model behavior, application permissions, ingress and group receipt still require live acceptance separately from fixtures. The approved prototypes define interaction decisions, not production durability or platform delivery evidence.

## Out of Scope

- External-system notifications and bot-originated messages as automatic triggers; the owner selected authorized members' ordinary group messages.
- The Coordinator or a Team Leader performing concrete business tasks, including when no team matches.
- Teams exchanging content directly, and cross-team requests from cross-team Assignments.
- Dependencies across teams: a lead-team Assignment never waits for a cross-team result, which reaches only the lead's closing through the Coordinator's Brief.
- Cancelling or retrying a single Assignment on its own; cancellation is per request, and retry reruns failed Assignments.
- A Team Leader automatically reassigning a failed Assignment.
- Per-profile MCP credentials; all profiles attaching a server share its credentials.
- Executors with bot identities or private chats.
- Penny joining the team structure (ADR-0025).
- Binding teams to Weixin conversations.

## Further Notes

Implementation checks do not establish production deployment or real-group receipt. No execution SLA, model replacement, ingress provider or public hostname is implied by these requirements. Concurrency is bounded only as agent-dispatch::QR-001 states.
