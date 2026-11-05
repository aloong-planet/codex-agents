# Agent dispatch

> Status: confirmed specification; implementation and production acceptance are pending.
> Related: [channel boundaries](channel-switching.md), [ADR-0024](../adr/0024-coordinate-independent-group-agents.md).
> Pending: authorized ordinary group messages can initiate dispatch to multiple independently identified agents, with a task-specific acceptance message and a completion report in the originating group.

## Problem Statement

The current group experience requires a member to mention Sam. The owner wants authorized members to express work in ordinary group discussion and have a backend decide whether an agent is needed and which specialist should handle it. Group participants need to see who has accepted the work and its result.

## Solution

Receive group messages, recognize requests and proactively discover possible work in discussion, select an appropriate configured agent, and forward the request. Inferred work is proposed to the original author and dispatched only after confirmation. The selected agent announces the business it is preparing to handle in the group and reports the result there after completion. Sam coordinates dispatch; Alice handles commerce-site operations, Bill handles everyday-life planning and arrangements, and Jack handles technical/development work. Each uses a separate Feishu bot identity. A genuine explicit mention gives the named agent priority; out-of-role requests return to Sam for reassignment. Each request is completed by one specialist rather than a team of collaborating agents.

## User Stories

### agent-dispatch::US-001 Request assistance without mentioning a bot

As an authorized group member, I want the service to interpret ordinary messages so that I do not need to select or mention an agent before requesting work.

- agent-dispatch::US-001/AC-01: An authorized member's ordinary group message can enter intent recognition without a bot mention.
- agent-dispatch::US-001/AC-02: When recognition determines that agent handling is unnecessary, the message is not forwarded for agent execution.
- agent-dispatch::US-001/AC-03: When handling is needed and an appropriate configured agent has been identified, the service forwards the request to that agent.
- agent-dispatch::US-001/AC-04: The service can identify possible work implied by authorized members' discussion, even without an explicit request.
- agent-dispatch::US-001/AC-05: When an authorized member genuinely mentions a configured agent, that agent has priority over automatic specialist selection, subject to the out-of-role handling in agent-dispatch::REQ-004.
- agent-dispatch::US-001/AC-06: A task inferred from discussion is proposed to the original message author and is not dispatched or executed until that author confirms it.

### agent-dispatch::US-002 Work with separately identified specialists

As a group member, I want different specialist agents to have their own identities so that I can identify the agent handling a request.

- agent-dispatch::US-002/AC-01: The delivered configuration includes all four agents in agent-dispatch::REQ-002, with the responsibility boundaries defined there.
- agent-dispatch::US-002/AC-02: Each configured agent uses its own Feishu application bot identity for its group messages.

### agent-dispatch::US-003 See acceptance and completion in the group

As a group member, I want the selected agent to acknowledge the work and later report its result in the originating group.

- agent-dispatch::US-003/AC-01: After the selected agent receives a dispatched request, it posts a message in the originating group identifying the business it is preparing to handle.
- agent-dispatch::US-003/AC-02: After processing completes, the selected agent automatically reports its result in the originating group.

## Functional Requirements

### agent-dispatch::REQ-001 Return ambiguous assignments to Sam (direct acceptance)

When a message appears to require handling but its responsible agent cannot be determined, route it to Sam to clarify and select an assignee. This fallback does not permit Sam to execute concrete business work.

### agent-dispatch::REQ-002 Confirmed agent responsibilities

The following role descriptions are the confirmed dispatch responsibilities, not an authorization to enable every tool or execute every action in those domains.

- agent-dispatch::REQ-002/AC-01: Sam manages task dispatch, clarification and reassignment and does not perform concrete business work, including fallback requests.
- agent-dispatch::REQ-002/AC-02: Alice handles operations for commerce websites such as Xianyu and Taobao.
- agent-dispatch::REQ-002/AC-03: Bill handles everyday-life affairs, including food, clothing, housing, travel planning and arrangements.
- agent-dispatch::REQ-002/AC-04: Jack handles technical affairs and development-related requirements.

Sam already has a Feishu application. Alice, Bill and Jack need applications created. This is onboarding context; application creation does not itself demonstrate task capability or delivery acceptance. No further exclusions for the three specialists were supplied.

### agent-dispatch::REQ-003 One specialist per request (direct acceptance)

A request has one specialist responsible for completing it independently. Sam does not split that request into collaborating multi-agent subtasks, including when the subject spans several specialties.

### agent-dispatch::REQ-004 Reassign out-of-role mentions (direct acceptance)

When the explicitly mentioned agent receives a request outside its responsibility, that agent explains the mismatch in the group and asks Sam to reassign the request. The mention does not grant an exception to its responsibility boundary.

### agent-dispatch::REQ-005 Shared business memory and separate execution histories

- agent-dispatch::REQ-005/AC-01: Agents serving the same group can share that group's business facts while retaining the existing separation from personal memory and other groups.
- agent-dispatch::REQ-005/AC-02: Each agent keeps its own execution history; sharing business facts does not merge their execution conversations.

### agent-dispatch::REQ-006 Initial specialist deliverables

The owner delegated selection of the first concrete tasks. These initial tasks use research, controlled file access and artifact delivery; they do not assume that assigning a role enables website sessions or command execution.

- agent-dispatch::REQ-006/AC-01: Given user-supplied product facts, Alice produces an editable listing package for Xianyu/Taobao: platform-appropriate titles, descriptions, condition disclosures and buyer FAQ. Unknown product facts are requested or marked as missing rather than invented; the package is saved and delivered to the originating group.
- agent-dispatch::REQ-006/AC-02: Given city, date, party size, preferences and budget, Bill produces a one-day itinerary with transport, meals, budget estimates and alternatives, and delivers the saved plan to the originating group. Time-sensitive claims identify their sources; estimates are distinguishable from verified facts. Missing essential inputs are clarified.
- agent-dispatch::REQ-006/AC-03: Given an authorized project location and a reproducible TypeScript problem description, Jack inspects relevant source and produces a reviewable patch with regression-test cases and an explanation. The group receives the artifact and an accurate validation status; this initial task does not claim tests were run when command execution is unavailable.

### agent-dispatch::REQ-007 Requester-owned active work

- agent-dispatch::REQ-007/AC-01: Only the original requester can confirm an inferred proposal, supplement or cancel its active dispatch request. Group and requester authorization is rechecked when processing a continuation.
- agent-dispatch::REQ-007/AC-02: Follow-up messages can be received while specialist execution is active. Ambiguous references to multiple active requests require clarification rather than changing an arbitrary request.
- agent-dispatch::REQ-007/AC-03: Cancellation stops further execution where possible and reports already completed actions accurately; it does not claim that completed external effects were undone. Existing group scheduled-task co-management and requester-bound file choices retain their separate authority rules.

### agent-dispatch::REQ-008 Failure, recovery and delivery

- agent-dispatch::REQ-008/AC-01: A failed specialist reports the cause and known completed work, and waits for explicit requester retry. Retry retains completed-effect evidence instead of replaying already completed actions. Existing bounded safe model-disconnection recovery remains available.
- agent-dispatch::REQ-008/AC-02: Persist dispatch admission, original requester, selected agent and source group. Duplicate platform messages cannot create a second business execution. A restart recovers queued requests; interrupted execution without sufficient safe-continuation evidence becomes a reported interruption rather than a blind replay.
- agent-dispatch::REQ-008/AC-03: Track business outcome separately from acceptance/result notification delivery. Retrying a rejected notification never re-executes business work; accepted or uncertain notifications are not automatically resent.
- agent-dispatch::REQ-008/AC-04: If an agent application or original group is unavailable, report the failure without substituting another bot identity or destination. Restart and configuration changes revalidate group/member authority before execution or delivery.
- agent-dispatch::REQ-008/AC-05: Invalid or ambiguous classifier output cannot launch business tools. Sam can ask for clarification; group discussion and retrieved content never override the trusted roster, requester or destination.

### agent-dispatch::REQ-009 Authenticated durable callbacks

- agent-dispatch::REQ-009/AC-01: The public receiver validates Feishu application callbacks before admission, rejects invalid authentication or malformed/oversized input, and answers authenticated URL verification without starting business work.
- agent-dispatch::REQ-009/AC-02: Acknowledge a supported event only after durable local admission; normalization, media retrieval, model classification and execution run outside the callback response path. Deduplicate message events by platform message identity even when delivery event IDs differ.
- agent-dispatch::REQ-009/AC-03: Only Sam subscribes to incoming human group messages. Other configured applications provide outbound specialist identities; bot/system events never start a dispatch loop.

### agent-dispatch::REQ-010 Preserve sender through business tools

- agent-dispatch::REQ-010/AC-01: Text, file/media results, pending continuations and scheduled notifications retain their selected application identity and original group across restart. Canonical group memory/task identity remains independent of the selected application.
- agent-dispatch::REQ-010/AC-02: Existing private channels, legacy mention-only groups, previously persisted tasks and delivery outcomes retain their original behavior when dispatch is not enabled. Existing Sam-owned task destinations remain valid without identity migration.

## Constraints

### agent-dispatch::CON-001 Authorized human sources (direct acceptance)

Applies to automatic dispatch in this delivery: only messages from authorized human members of enabled groups can initiate agent handling. Existing group and member allowlists remain the authority; observing other members' discussion does not authorize those members to initiate work.

### agent-dispatch::CON-002 Local deployment with stable ingress (direct acceptance)

Run the event receiver and agent service on the current computer and configure a stable public ingress for Feishu event callbacks. Offline reception/processing is limited by that computer's availability; no separate cloud queue is part of this deployment choice.

### agent-dispatch::CON-003 Existing isolated Codex runtime (direct acceptance)

Each role uses the existing Codex runtime through a separate group execution session. Existing tool grants remain the maximum authority; role selection does not enable browser accounts, shell execution, purchases or unrestricted local access. Sam's classifier/coordination session receives no concrete business tools.

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Authorized member sends ordinary explicit work | Recognize and dispatch under agent-dispatch::US-001/AC-01 through agent-dispatch::US-001/AC-03 |
| Casual discussion contains an implied opportunity | Propose, wait for original author, then dispatch under agent-dispatch::US-001/AC-04 and agent-dispatch::US-001/AC-06 |
| Another member confirms/cancels; original author later answers | Preserve original ownership under agent-dispatch::REQ-007/AC-01; no guessed continuation under agent-dispatch::REQ-007/AC-02 |
| Several active requests receive an unqualified “cancel” or “yes” | Clarify the intended request under agent-dispatch::REQ-007/AC-02 |
| Original author supplements/cancels while worker is busy | Admit control without waiting for worker completion; accurately report completed effects under agent-dispatch::REQ-007/AC-02 and agent-dispatch::REQ-007/AC-03 |
| Guest, bot or unlisted group sends task-like content | No execution under agent-dispatch::CON-001 and agent-dispatch::REQ-009/AC-03; guest discussion stays inert context |
| Mention by genuine platform identity, name lookalike, @all, quote or several agents | Only genuine configured mentions confer priority under agent-dispatch::US-001/AC-05; ambiguous selection clarifies under agent-dispatch::REQ-001 |
| Mention Bill for development, or request spans commerce and development | Named agent explains, Sam reassigns one specialist under agent-dispatch::REQ-004 and agent-dispatch::REQ-003 |
| No configured specialist can handle it; classifier is malformed, empty or uncertain | Sam clarifies without business execution under agent-dispatch::REQ-001 and agent-dispatch::REQ-008/AC-05 |
| Specialist accepts, executes, then completes | Agent-specific acceptance and result in the originating group under agent-dispatch::US-003 |
| Deliver same message repeatedly, including changed delivery event IDs; restart after admission | One durable request under agent-dispatch::REQ-008/AC-02 and agent-dispatch::REQ-009/AC-02 |
| Stop during execution, after a local write, or after a platform send | Existing safe recovery only; report interruption rather than repeat unknown effects under agent-dispatch::REQ-008/AC-01 through agent-dispatch::REQ-008/AC-03 |
| Final send is rejected or has uncertain outcome; requester requests another report | Separate delivery retry from execution under agent-dispatch::REQ-008/AC-03 |
| Remove member/group or replace application credentials with queued work | Revalidate authority; no sender or destination fallback under agent-dispatch::REQ-008/AC-04 |
| Public request uses wrong token/signature/application, malformed envelope or excessive bytes | Reject before business admission under agent-dispatch::REQ-009/AC-01 |
| Valid URL verification arrives; media download/model work stalls | Verification starts no business work; persist event before asynchronous work under agent-dispatch::REQ-009/AC-01 and agent-dispatch::REQ-009/AC-02 |
| Current computer is offline; Feishu retries later | Local availability limitation under agent-dispatch::CON-002; durable dedupe applies to retries under agent-dispatch::REQ-009/AC-02 |
| Agent saves or sends a file, waits for a choice, schedules a reminder, then restarts | Frozen role and group delivery under agent-dispatch::REQ-010/AC-01; existing file and task authority applies |
| Group content requests private memory or embeds instructions/links/attachments | Group isolation under agent-dispatch::REQ-005 and host authority under agent-dispatch::REQ-008/AC-05; quoted content is data, references use existing controlled retrieval |
| Same-group specialists retain business facts; another group/private chat asks for them | Shared curated facts but separate execution histories under agent-dispatch::REQ-005 |
| First tasks lack product facts, trip constraints or repository access | Clarify missing facts, preserve tool grants and report validation truthfully under agent-dispatch::REQ-006 and agent-dispatch::CON-003 |
| Dispatch disabled; legacy private/group task becomes due | Preserve legacy behavior under agent-dispatch::REQ-010/AC-02 |

## Implementation Decisions

Use Feishu application event callbacks, with a loopback-only receiver exposed through a stable public ingress. The selected hostname and provisioning are deployment inputs, not part of message semantics. Public ingress exposes no local administration routes. The receiver authenticates bounded raw bodies, handles URL verification, and durably spools supported messages before responding; an asynchronous consumer then feeds the existing production admission path. Platform message identity, not delivery event identity, supplies deduplication. Callback secrets and raw private payloads are excluded from diagnostics.

Keep the canonical Sam application/group authority, memory and scheduled-task scope. Attach a separately trusted execution role and immutable outbound application identity to a dispatch request, workflow delivery and scheduled occurrence. Agent identity never replaces the human requester. Role-specific sessions share only the existing curated group memory; Sam's coordinator has no business tool catalog. Genuine cross-application bot mentions are resolved through platform application IDs, not display names or equality assumptions about application-scoped open IDs. See ADR-0024.

Dispatch requests have durable proposed, queued, running, waiting, completed, failed and cancelled outcomes; notification state remains independent. Confirming a proposal queues it; execution accepts a queued request once; completion/failure/cancellation terminates that attempt. Waiting preserves an unresolved clarification or file choice. An interruption becomes failed unless existing safe recovery evidence authorizes continuation. Explicit retries retain the prior attempt and completed-effect context. Original-requester controls are admitted independently of specialist execution. Existing requester-bound file choice handling precedes fresh task recognition. Completion and promotion of a queued supplement are recorded atomically, including completion through a pending file choice; restart preserves both the previous result notice and the next turn.

Deployment and local acceptance use the Node version pinned in the repository's CI configuration, matching the existing service runtime. A runtime upgrade must first verify real permission-worker writes and recovery; a successful model response does not establish filesystem compatibility. Full task briefs use a separate bounded capture from the legacy short file-search input.

The approved interaction presents task-specific acceptance, inferred-work proposal with original-author confirmation, named-agent mismatch followed by Sam reassignment, and separate failure/cancellation/result messages. Application credentials and member lists remain local restart-applied configuration. No management screen is introduced.

Legacy mention-only admission remains the default; enabling this feature changes only its explicitly enabled group request path. [channel-switching::US-005](channel-switching.md), [channel-switching::US-007/AC-03](channel-switching.md) and [channel-switching::REQ-007/AC-01](channel-switching.md) retain their legacy meaning with explicit dispatch-mode exceptions. Their private/group isolation and requester boundaries continue to apply.

## Testing Decisions

Use the existing real-main fixture-only ingress and authenticated transport fakes as the highest behavioral seam. Drive platform-shaped messages through production admission and observe classifier selection, requester control, replies, files, scheduled deliveries and durable outcomes after restart. Do not substitute Provider calls or fabricated Run state for that route. A real local HTTP receiver test covers authentication, URL verification, fast durable admission and retry/restart behavior at the transport boundary. Existing workflow, memory, permission and model-protocol public-boundary tests supplement these composition tests.

Fixtures take envelope and mention shapes from official Feishu examples and the installed SDK; classifier fakes substitute only the external model response. Real model selection, application permissions, stable ingress and group receipt require live acceptance separately from fixtures. The approved logic prototype defines interaction decisions, not production durability or platform delivery evidence.

## Out of Scope

- External-system notifications and bot-originated messages as automatic triggers in this delivery; the owner selected authorized members' ordinary group messages.
- Splitting one request into cooperating multi-agent subtasks, under agent-dispatch::REQ-003.
- Sam performing concrete business tasks, including when no specialist matches.

## Further Notes

Runtime reuse, original-requester controls, explicit retry after failure and the interaction flows are confirmed. Implementation checks do not establish production deployment or real-group receipt. No execution SLA, model replacement, concurrency guarantee, ingress provider or public hostname is implied by these requirements.
