# ADR-0026: Coordinate work through isolated domain teams

- Status: Accepted (2026-11-07)

## Context

ADR-0024 gives each group request to one specialist, and all specialists in a group share one curated group memory and one code-defined prompt tail, so one domain's rules and results reach every other domain. The owner now wants:

- each domain handled by a team whose leader divides work among task-created executors;
- to keep recognising the type of work from the speaking identity;
- cross-domain requests to cooperate without merging team contexts;
- to talk privately with the coordinator and the team leaders.

## Options

1. **Three levels: a Coordinator, Team Leaders and task-created Executors. Only the Coordinator and Team Leaders speak, and each agent sees only what it is handed plus its own memory.**
2. Keep one specialist per request and shared group memory (ADR-0024; the withdrawn agent-dispatch::REQ-003 and agent-dispatch::REQ-005). Rejected by the owner because a Team Leader could not divide work, and shared memory contradicts per-agent isolation.
3. One coordinator bot speaks for all work. Rejected by the owner because the speaking identity must reveal the type of work.
4. A permanent, configured roster of team members. Rejected by the owner; Executors are created per Assignment and leave the active organisation when it ends.
5. Executors speak with their own bots or accept private chat. Rejected by the owner: their posts would enter the group memory that the Coordinator reads, and each Executor would need its own Feishu application.
6. Team Leaders or Executors read the group memory. Rejected by the owner because other teams' summaries would then reach a team without passing through the Coordinator.
7. Team Leaders execute small tasks themselves. Rejected by the owner because it mixes coordination with execution and complicates tool isolation.
8. Teams exchange results directly. Rejected by the owner for the first version; cross-team cooperation passes through the Coordinator.
9. The Coordinator reports every mid-work decision. Rejected by the owner because team-internal decisions would then no longer come from the team's own identity.
10. Leave every confirmation to the Coordinator's judgement, or confirm every cross-team cooperation. Rejected by the owner: the first has no host safeguard against a wrong judgement, and the second interrupts routine cooperation.
11. Bring Penny into the team structure. Rejected by the owner; Penny remains separate under ADR-0025.
12. Only the Coordinator knows which teams exist. Rejected by the owner because Team Leaders need the Team Directory to know which cross-team help they can request.

## Decision

We adopt **option 1**.

Roles:

- Agent Teams are defined once and bound to dispatch groups. A group's Coordinator routes only to the teams bound to that group. When a team is bound to a group or removed from it, the Coordinator announces this in the group and every Team Leader's Team Directory is updated (ADR-0028).
- The Coordinator (Sam) remains the only subscriber to human group messages and never executes business work.
  - It routes each Dispatch Request to the responsible Agent Team.
  - When a Team Leader reports a need for another team, it decides how the teams cooperate and assigns that work. The work becomes further Assignments of the same Dispatch Request, under the other team's Team Leader. Requester controls therefore act on one request, which appears in each participating team's records and counts once.
  - It asks the owner for confirmation only in host-defined categories, which the specification lists, and decides everything else itself. A model cannot bypass these categories.
- Alice, Bill and Jack become Team Leaders. A Team Leader:
  - divides a Dispatch Request into Assignments, then coordinates and summarises them;
  - never executes business work and holds no side-effecting tools.
- Exactly one Executor performs each Assignment.
  - The Executor is created for that Assignment from one of the team's preset Agent Profiles (ADR-0027); every team presets at least one.
  - Executors have no bot identity and no private chat, and report only to their Team Leader.
  - An ended Executor leaves the active organisation. Its identity, process and result remain in its Team Leader's records.

Visibility:

- The Coordinator sees every agent's responsibility, the group memory and the group's request list across teams. It never sees Executor content, only what Team Leaders report to it or post.
- A Team Leader sees only three things: the brief it receives, which includes the original message; its own memory; and the group's Team Directory, which lists the names and responsibilities of the teams bound to the group. It sees neither the group memory nor any other team's work content.
- An Executor sees only its Team Leader's brief, its own process and the memory shared by Executors created from the same Agent Profile in the same conversation.
- The owner's console shows the actual Executor, process and result of every Assignment. This is the owner's view; it is never added to any agent's context.

Reporting in a group:

- A Team Leader posts with its own identity:
  - who does which Assignment, when work starts;
  - team-internal decisions, progress and failures, as they occur;
  - a closing message, when work ends.
- Executor results, files and media reach the group only through the Team Leader's identity.
- When a team needs another team, its Team Leader reports to the Coordinator. The Coordinator posts the resulting assignment in the group. Teams never exchange results directly.

Private conversations:

- The owner can chat privately with the Coordinator and with each Team Leader through the local console. Executors and Penny have no such entry.
- A private conversation can create a private Dispatch Request. Its Assignments and results stay in that conversation and never enter group records or group memory.
- In a private conversation, the owner can also view, discuss, supplement and confirm Dispatch Requests that the owner started in a group.
  - Those requests still belong and report to their group.
  - The private transcript is never copied to the group.
  - Only confirmed requirements reach the Executor.
  - Original-requester authority governs every control.

The following parts of ADR-0024 remain in force:

- one canonical group authority, with durable admission before any model work;
- business outcome tracked separately from notification delivery;
- original-requester controls admitted while work is in progress;
- completed or uncertain effects never replayed;
- genuine bot mentions resolved by application ID;
- legacy mention-only mode unchanged.

ADR-0023's private/group, requester, file, task and revocation boundaries continue to apply.

## Consequences

- Positive:
  - The speaking identity still reveals the domain.
  - One domain's instructions, tools and results no longer reach other domains.
  - A Team Leader can divide work, while each Assignment still has one accountable Executor.
  - Executors need no Feishu applications. Team Leaders reuse the existing Alice, Bill and Jack applications.
- Negative:
  - Every request costs at least a Team Leader turn and an Executor turn, and cross-team work adds Coordinator turns.
  - The brief is a team's only view of group context, so an incomplete brief forces a round trip.
  - In the group, the owner sees Executor output only through the Team Leader's summary.
  - Requester controls (supplement, cancel, retry) and completed-effect evidence must span every Assignment of a request.
  - Isolated runtimes multiply with agents, Assignments and groups, while the current executor never releases a runtime before shutdown, so a bounded runtime pool becomes necessary.
  - Private conversations add a channel that needs its own owner authentication and storage, and neither exists yet.
- Neutral:
  - The agent dispatch specification's one-specialist, shared-memory and role-capability requirements must be rewritten before implementation.

## Sources

- Owner decisions in the 2026-11-07 design discussion:
  - per-role bots with a dispatching supervisor;
  - the Coordinator sees responsibilities, group memory and the request list, but not Executor content;
  - per-agent prompts, tools, MCP servers, skills, memory and context;
  - cross-team cooperation through the Coordinator, with confirmation only for important matters;
  - Team Leaders post start, closing and mid-work decisions;
  - Executors are silent in the group;
  - Team Leaders read only their brief and never execute business work;
  - host-defined confirmation categories;
  - Penny stays separate.
- The owner's agent-console requirement summary of the same day: task-created executors, leader-only reporting, private chat with the Coordinator and Team Leaders, private requests, and private handling of owned group requests. Where it conflicted with the decisions above, the owner chose:
  - dividing a request into Assignments;
  - preset Agent Profiles for Executors;
  - memory shared among same-profile Executors;
  - group memory read only by the Coordinator;
  - cross-team work recorded as Assignments of the original request;
  - teams defined once and bound per group, with a Team Directory for leaders and Coordinator announcements when a team is bound or removed.
- The owner's confirmation of the team-structures console prototype on 2026-11-08: Executors grouped per request under each leader, the leader's start message naming who does which Assignment, and the Coordinator's cross-team notice.
- Current behaviour these decisions replace:
  - `apps/weixin-service/src/agent-dispatch-executor.ts` appends one prompt tail for every role and keeps a runtime map without release.
  - `apps/weixin-service/src/main.ts` gives every specialist one tool control and one group memory scope for recall and capture.
- [ADR-0023](0023-isolate-feishu-group-authority.md), [ADR-0024](0024-coordinate-independent-group-agents.md), [ADR-0025](0025-isolate-private-financial-authority.md) and [ADR-0027](0027-bind-host-enforced-agent-profiles.md).
- [Agent dispatch specification](../specs/agent-dispatch.md) as it stood before this decision: agent-dispatch::REQ-003, agent-dispatch::REQ-005 and agent-dispatch::CON-003, since withdrawn or rewritten.
