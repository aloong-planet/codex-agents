# Agent dispatch

> Status: one-specialist dispatch is implemented locally and independently reviewed. Team coordination (Team Leaders, Executors and Assignments) is specified here and not yet implemented.
> Related: [channel boundaries](channel-switching.md), [team management](team-management.md), [MCP catalog](mcp-catalog.md), [skill library](skill-library.md), [agent console](agent-console.md), [ADR-0023](../adr/0023-isolate-feishu-group-authority.md), [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md).
> Pending: configure stable public ingress, deploy, and verify actual group receipt. Local fixture and model checks do not establish these outcomes.
> Pending: the service still dispatches each Dispatch Request to one specialist that executes it, shares one group memory scope among specialists, and gives every specialist the same tools and prompt tail.

## Problem Statement

Authorized members express work in ordinary group discussion, and a backend decides whether an agent is needed. Today one specialist completes each request alone, and every specialist shares the same group memory, tools and code-defined instructions. As a result:

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

- agent-dispatch::REQ-007/AC-01: Only the original requester can confirm an inferred proposal, confirm an over-limit plan, supplement, cancel or retry its active Dispatch Request. Group and requester authorization is rechecked when processing a continuation.
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
- agent-dispatch::REQ-011/AC-02: A request is limited to 5 Assignments and 2 Agent Teams in total. A plan or cross-team assignment that would exceed either limit is not executed until the original requester confirms it. The confirmation offers three choices:
  - run the plan as proposed;
  - trim it to the limits, keeping the lead team, the first cross-team team and at most 5 Assignments in plan order;
  - cancel the request.
- agent-dispatch::REQ-011/AC-03: The host validates every plan before creating Executors. Each Assignment must name a preset profile of the planning team, and no plan may exceed the limits without confirmation.
- agent-dispatch::REQ-011/AC-04: An Executor exists for one Assignment only. When the Assignment ends, the Executor leaves the active organization. Its identity, process and result remain in the request's records.

### agent-dispatch::REQ-012 Visibility and memory scopes

- agent-dispatch::REQ-012/AC-01: Only the Coordinator recalls and captures the group memory. The group memory holds the group's discussion and what the Coordinator and Team Leaders post in the group; private conversations never contribute to it.
- agent-dispatch::REQ-012/AC-02: A Team Leader receives only three things: its Brief from the Coordinator, which includes the original message; its own memory, kept per conversation and leader; and the group's Team Directory. It never receives the group memory, another team's content or Executor memory.
- agent-dispatch::REQ-012/AC-03: An Executor receives only its Team Leader's Brief, its own process, and the memory shared by Executors created from the same Agent Profile in the same conversation.
- agent-dispatch::REQ-012/AC-04: The Coordinator never receives Executor content, only what Team Leaders report to it or post in the group.

### agent-dispatch::REQ-013 Cross-team cooperation through the Coordinator

- agent-dispatch::REQ-013/AC-01: Only the lead Team Leader can ask the Coordinator for another team's help. A cross-team Assignment cannot request further cross-team help; its Executor reports needs to its Team Leader, which tells the Coordinator, which forwards them to the lead Team Leader.
- agent-dispatch::REQ-013/AC-02: The Coordinator decides how the teams cooperate, without asking the owner unless agent-dispatch::REQ-014 requires it. The work becomes further Assignments of the same Dispatch Request, under the other team's Team Leader.
- agent-dispatch::REQ-013/AC-03: Teams never exchange content directly. The cross-team Team Leader reports its result to the Coordinator, which passes it to the lead Team Leader in a Brief.
- agent-dispatch::REQ-013/AC-04: The cross-team Team Leader posts the start and closing of its own Assignments in the group (agent-dispatch::US-003/AC-01 and agent-dispatch::US-003/AC-02).

### agent-dispatch::REQ-014 Host-enforced confirmations (direct acceptance)

The host requires the original requester's confirmation before acting in exactly two cases: work inferred from discussion (agent-dispatch::US-001/AC-06), and a request exceeding the Assignment limits (agent-dispatch::REQ-011/AC-02). No model output can skip these confirmations. Outside them, the Coordinator decides itself and may still ask a clarifying question.

### agent-dispatch::REQ-015 Group roster, Team Directory and announcements

- agent-dispatch::REQ-015/AC-01: In a group, the Coordinator routes and assigns only to Agent Teams that accept work in that group ([team-management::REQ-003](team-management.md)). Teams whose onboarding there is incomplete, and teams draining there, receive no new Assignments in that group, including cross-team ones in requests already running. Private requests follow [agent-console::REQ-006](agent-console.md).
- agent-dispatch::REQ-015/AC-02: Every Team Leader in a group receives that group's Team Directory: the names and responsibilities of the bound teams, and nothing else.
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
| Plan needs a sixth Assignment, or a third team | Wait for original-requester confirmation: run as proposed, trim to the limits or cancel, under agent-dispatch::REQ-011/AC-02 |
| Team Leader or Coordinator output is malformed, names an unknown profile or exceeds limits without confirmation | No Executor or Assignment is created under agent-dispatch::REQ-011/AC-03 and agent-dispatch::REQ-008/AC-05 |
| No team can handle it; Coordinator output is malformed, empty or uncertain | Clarify without business execution under agent-dispatch::REQ-001 and agent-dispatch::REQ-008/AC-05 |
| Team Leader plans, Executors run, all complete | Start, progress and closing messages under agent-dispatch::US-003 |
| One of three Assignments fails | Others continue; closing names the failure; request partially failed under agent-dispatch::REQ-008/AC-01 |
| Requester retries a partially failed request | Only failed Assignments rerun; completed effects not replayed under agent-dispatch::REQ-008/AC-01 |
| Deliver same message repeatedly, including changed delivery event IDs; restart after admission | One durable request under agent-dispatch::REQ-008/AC-02 and agent-dispatch::REQ-009/AC-02 |
| Stop during an Assignment, after a local write, or after a platform send | Existing safe recovery only; report the interrupted Assignment rather than repeat unknown effects under agent-dispatch::REQ-008/AC-01 through agent-dispatch::REQ-008/AC-03 |
| Start, cross-team, closing or result notification is rejected or uncertain; requester asks for another report | Delivery retry separate from execution under agent-dispatch::REQ-008/AC-03 |
| Remove member/group or replace a Team Leader's application credentials with queued work | Revalidate authority; no sender or destination fallback under agent-dispatch::REQ-008/AC-04 |
| A Team Leader's bot is not in the group when it must post | Report the delivery failure without another identity under agent-dispatch::REQ-008/AC-04 |
| Team is bound to the group, or removed, while requests run | Announcement under agent-dispatch::REQ-015/AC-03; removed team gets no new Assignments, running ones continue under agent-dispatch::REQ-015/AC-01 |
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

**Profile resolution.** One resolution point gives the following for an agent and version:

- the instructions;
- the host-tool view (the profile allowlist intersected with module permissions);
- the MCP proxy tools;
- the skills;
- the memory scope.

Turns obtain these only through it. Domain-specific text is removed from shared prompt assembly and moved into the owning team's profiles. Before team behavior is enabled, the initial profiles reproduce today's behavior, so the resolution point can be introduced without user-visible change.

**Coordinator.** The Coordinator remains a tool-free structured-output turn. Its input is:

- the event;
- every agent's responsibility;
- the group memory;
- the group's request list;
- reports from Team Leaders.

Its decisions are:

- ignore, clarify, propose, route to a team;
- control an existing request;
- assign a cross-team part;
- ask for over-limit confirmation.

The host validates them against the registry before acting.

**Team Leader.** A Team Leader turn is also tool-free. It returns a structured plan: Assignments with profile and Brief, decisions to post, a cross-team request, a summary, or a closing. The host validates the plan under agent-dispatch::REQ-011/AC-03, creates Executors, and sends the Team Leader's group messages with its application.

**Executor.** An Executor turn runs in its own isolated runtime with the profile's host tools, MCP proxy tools and skills. Its result returns to the Team Leader, never to the group directly.

**Runtime-supplied tools.** A turn's tool list is exactly its host tools, plus web search where the turn allows it. Codex's own tools are never offered ([ADR-0029](../adr/0029-offer-isolated-runtimes-only-granted-tools.md)): code-mode `exec` and `wait`, `apply_patch`, the MCP resource tools, `request_user_input` and sub-agents. This is how agent-dispatch::REQ-016/AC-02 and agent-dispatch::CON-003 apply to the model's tool list. They hold for threads started after that change. A thread saved before it keeps the old tool list in its history and sends it again when resumed; every tool on it is refused with no effect.

**Durable records.** Dispatch Requests keep their states: proposed, queued, running, waiting, completed, partially failed, failed and cancelled. Assignments add their own states: queued, running, waiting, completed, failed, cancelled and interrupted. Notification state stays independent for each message. Completed-effect evidence is keyed by Assignment and aggregated per request. Cross-team Assignments belong to the original request.

The existing transition rules carry over to Assignments:

- Confirming a proposal queues the request. Its accumulated supplements and any new confirmation conditions become the active authorized source; background discussion alone cannot authorize a tool operation.
- Execution accepts a queued Assignment once. Completion, failure or cancellation ends that attempt.
- Waiting preserves an unresolved clarification or file choice.
- An interruption becomes failed unless existing safe recovery evidence authorizes continuation.
- An explicit retry keeps the prior attempt and its completed-effect context.
- Original-requester controls are admitted independently of execution. Existing requester-bound file-choice handling precedes fresh task recognition.
- Completion and the promotion of a queued supplement are recorded atomically, including completion through a pending file choice. A restart preserves both the previous result notice and the next turn.

**Memory scopes.** Scopes are keyed as follows (ADR-0027):

- the Coordinator by group;
- a Team Leader by conversation and leader;
- Executors by conversation and Agent Profile.

Recall and capture use only the caller's scope.

**MCP and skills.**

- MCP servers are connected and held by the host service; Executors receive proxy tools ([mcp-catalog](mcp-catalog.md)).
- Skills are copied from the Skill Library into the Executor's runtime home at creation ([skill-library](skill-library.md)).

**Runtime pool.** Runtimes are held in a bounded pool keyed by agent, conversation, access revision and definitions version, with idle release. The Coordinator's, Team Leaders' and Executors' runtimes share one pool. When work needs a new runtime at the limit, the least recently used idle runtime is released for it at once, instead of at its idle limit. Persisted thread identities let Coordinator and Team Leader sessions resume after release.

**Node runtime.** Deployment and local acceptance use the Node version pinned in the repository's CI configuration, matching the existing service runtime. A runtime upgrade must first verify real permission-worker writes and recovery; a successful model response does not establish filesystem compatibility.

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

**Profile boundary.** Profile enforcement is tested at the host tool boundary and the memory boundary:

- a turn's offered tools, and a call outside its view being refused;
- recall returning only the caller's scope.

These tests do not inspect prompt text.

**Runtime pool.** The pool is tested at its public interface: concurrency limit, idle release and resume.

**Live acceptance.** A real local HTTP receiver test keeps covering authentication, URL verification and fast durable admission. Real model behavior, application permissions, ingress and group receipt still require live acceptance separately from fixtures. The approved prototypes define interaction decisions, not production durability or platform delivery evidence.

## Out of Scope

- External-system notifications and bot-originated messages as automatic triggers; the owner selected authorized members' ordinary group messages.
- The Coordinator or a Team Leader performing concrete business tasks, including when no team matches.
- Teams exchanging content directly, and cross-team requests from cross-team Assignments.
- Cancelling or retrying a single Assignment on its own; cancellation is per request, and retry reruns failed Assignments.
- A Team Leader automatically reassigning a failed Assignment.
- Per-profile MCP credentials; all profiles attaching a server share its credentials.
- Executors with bot identities or private chats.
- Penny joining the team structure (ADR-0025).
- Binding teams to Weixin conversations.

## Further Notes

Implementation checks do not establish production deployment or real-group receipt. No execution SLA, model replacement, ingress provider or public hostname is implied by these requirements. Concurrency is bounded only as agent-dispatch::QR-001 states.
