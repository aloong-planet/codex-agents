# Agent console

> Status: specified; login and local-only access are implemented, the console pages are not.
> Related: [agent dispatch](agent-dispatch.md), [team management](team-management.md), [MCP catalog](mcp-catalog.md), [skill library](skill-library.md), [channel boundaries](channel-switching.md), [ADR-0023](../adr/0023-isolate-feishu-group-authority.md), [ADR-0025](../adr/0025-isolate-private-financial-authority.md), [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md).
> Pending: no read projection combines requests, Assignments, reports and delivery outcomes, and no storage exists for Team Leader chats or private requests.

## Problem Statement

The owner cannot see how the agents are organized, who handled which part of a request, what was reported to the group, or where each kind of information is kept. Talking to the Coordinator or a Team Leader is possible only in a Feishu group, where every message becomes group context. The local service also exposes its pages and APIs to any web page that can reach the computer's loopback address.

## Solution

A local agent console, styled after the owner's agent-link web console, shows each group's organization as a collapsible tree: the Coordinator, Team Leaders, and the Executors of active Assignments grouped per request. Every node opens a drawer with the related records and with relationships and storage. The owner chats privately with the Coordinator and each Team Leader, creates private requests, and works on the owner's own group requests without exposing the private conversation to the group. The console's other pages manage teams, MCP servers and skills. Every page and API of the local service requires a browser that the owner authorized with a one-time login link.

## User Stories

### agent-console::US-001 Sign in from this computer

As the owner, I want only browsers that I authorized on this computer to use the console, so that other web pages cannot read or change it.

- agent-console::US-001/AC-01: A local command prints a one-time login link and opens it in the default browser; an option only prints it. The link is valid for 2 minutes and can be used once. Opening it exchanges it for an HttpOnly, SameSite=Strict cookie.
- agent-console::US-001/AC-02: An authorized browser stays authorized across service restarts. The service stores only a hash of each cookie, and the cookie is valid for 400 days, renewed whenever a page opens.
- agent-console::US-001/AC-03: The local command lists authorized browsers and revokes one or all. In the console, a 「本机」 section at the bottom of the sidebar holds the 「本机登录」 entry with the number of authorized browsers. It opens a drawer listing each browser's label, authorization time, last use and a current-browser marker. Each browser has 收回, and the list has 全部收回; both ask for inline confirmation. The same drawer explains that the audit is written to a local file and read from the command line. A revoked browser's open pages disconnect immediately and need a new login link.
- agent-console::US-001/AC-04: A browser without authorization, including one whose login link has expired or been used, sees only a card explaining how to obtain a login link. No data is shown and the console underneath cannot be used.
- agent-console::US-001/AC-05: The codex-weixin Codex plugin, which uses the local service without a browser, is the one exception. It authorizes through the same local control channel as the login command and holds its credential in memory only. It appears as one authorized entry, 「Codex 插件」, replaced each time it authorizes; it is audited and revocable like a browser, and authorizes again on its next start or when the service refuses its credential.

### agent-console::US-002 Move around the console

As the owner, I want one consistent shell for every console page, so that I always know where I am and how to get to my private conversations.

- agent-console::US-002/AC-01: A 212px left sidebar shows the identity, the page navigation (团队总览, 团队管理, MCP 管理, Skill 管理, with the current page selected) and the owner's private entries in three titled sections: 私人任务, Penny · 本人私聊 and 普通私聊.
- agent-console::US-002/AC-02: On the team overview, the private entries switch the tree to private requests or open their drawer. On other pages, they lead to the team overview.
- agent-console::US-002/AC-03: Below 900px, a menu bar opens the sidebar.
- agent-console::US-002/AC-04: Page and section explanations sit in info tips beside their titles; status and warning lines stay inline.
- agent-console::US-002/AC-05: Details open in a drawer from the right over a scrim, at every width, `min(720px, 80% of the area beside the sidebar)` wide. The content underneath keeps its size. The bordered close button, a click on the scrim and Escape close it. On phones the drawer fills the workspace and the content underneath is inert.

### agent-console::US-003 See how work is organized

As the owner, I want a tree of the organization and its active work, so that I can see at a glance who is working on what.

- agent-console::US-003/AC-01: The team overview shows a top-down tree: the Coordinator, then the Team Leaders of the selected scope, then their active work. Teams collapse independently; zoom and fit-to-window keep small nodes readable. Scope entries switch the tree between a group and the owner's private requests.
- agent-console::US-003/AC-02: A Team Leader's card counts the requests that involve its team as running, waiting or history; each request counts once per team. A team being deleted shows a 「删除中」 marker at the top of its card.
- agent-console::US-003/AC-03: Each request with active Assignments in a team appears under that team's leader as a dashed frame. The title shows the request ID and a short title. On the lead team, the caption counts the team's own and cross-team Assignments; on another team, it says the Assignment is cross-team, requested by the lead leader. Selecting the title opens the request's record, already expanded.
- agent-console::US-003/AC-04: Only running and waiting Executors appear, inside their request's frame. Each is named after its Agent Profile plus a number, shows its profile, its Assignment, its status and its Assignment ID, and has no bot badge and no chat entry. Ended Executors leave the tree and are never shown as idle capacity.

### agent-console::US-004 Follow a request in its records

As the owner, I want each request's full record, so that I can see what was asked, who did each part, what was reported and whether reports arrived.

- agent-console::US-004/AC-01: Selecting a node or a name opens the drawer on its related records; a records button opens it without a selected node. The tab defaults to related records, beside relationships and storage. Switching tabs keeps the current search and expanded record.
- agent-console::US-004/AC-02: Search, the business-state filter and the delivery-state filter share one row, with content-sized selectors.
- agent-console::US-004/AC-03: Each record's summary has two rows: the title and the disclosure action; then the lead leader with the Assignment count, the business state, report delivery and the time. Long titles truncate in the summary and appear in full when expanded.
- agent-console::US-004/AC-04: An expanded record shows, in order: the result; the path from the Coordinator to the lead leader, each cross-team Assignment and the reporting identities; the Assignment list with Executor, responsible leader, Agent Profile, cross-team marker, status and result; a collapsible group-report timeline of who posted what and whether the platform accepted it; the original message and its source; a chat action for each involved leader; and storage links. Private requests have no group-report timeline.
- agent-console::US-004/AC-05: Business outcome and report delivery appear separately. Platform acceptance is shown as acceptance, not as proof that the message was read.

### agent-console::US-005 See where information is kept

As the owner, I want to see what each agent and identity is connected to and where its information is kept, so that I can trust the isolation boundaries.

- agent-console::US-005/AC-01: The relationships and storage tab describes the selected node, its storage locations and links to related nodes, which open in the same drawer with a return action.
- agent-console::US-005/AC-02: Storage is shown separately for: the group memory, which only the Coordinator reads; Team Leader memory, one scope per leader and conversation; Executor memory, one scope per Agent Profile and conversation; execution records and delivered files; group scheduled tasks; private conversations and private requests; ordinary personal memory; and Penny's financial stores.
- agent-console::US-005/AC-03: The diagram and details distinguish a bot identity from the agent that performs the work, and show each agent's responsibility, organization, conversation scope and storage.

### agent-console::US-006 Chat privately with the Coordinator or a Team Leader

As the owner, I want a private conversation with the Coordinator and each Team Leader, so that I can discuss work without posting in a group.

- agent-console::US-006/AC-01: The Coordinator and each Team Leader have a chat button beside their name, a frameless round speech bubble. It opens a private conversation in the drawer, whose header switches between chat and records. Executors and Penny have no chat entry, and the service refuses chat with them.
- agent-console::US-006/AC-02: Each conversation keeps its own messages and unsent draft when the drawer closes, switches to records or switches to another leader.
- agent-console::US-006/AC-03: A Team Leader's request selector lists the owner's requests that involve its team, including those where the team holds only cross-team Assignments. The Coordinator's selector lists all of the owner's requests. A record's chat action opens that leader's conversation with the request selected.
- agent-console::US-006/AC-04: A Team Leader's conversation is available once the team is defined, before its Feishu onboarding completes, and stays available while the team is being deleted.

### agent-console::US-007 Create a private request

As the owner, I want to turn a private conversation into a request for a team, so that work can be done for me without involving a group.

- agent-console::US-007/AC-01: Sending text without a selected request offers a private-request creation card. The owner can keep discussing, or create the request and delegate it.
- agent-console::US-007/AC-02: In a Team Leader's conversation, the request goes to that team, which divides it into Assignments under [agent-dispatch::REQ-011](agent-dispatch.md). Work outside the team's responsibility is explained, and the owner can ask the Coordinator instead.
- agent-console::US-007/AC-03: In the Coordinator's conversation, the Coordinator routes the request to the responsible team, and asks the owner to choose when the team is unclear ([agent-dispatch::REQ-001](agent-dispatch.md)).
- agent-console::US-007/AC-04: A team that is being deleted takes no new private request; its conversation says so and keeps discussion available.
- agent-console::US-007/AC-05: A private request's Assignments, results and files stay in that private conversation and its records. They never enter a group's records, reports or memory. The tree's private scope shows its active Executors.

### agent-console::US-008 Work on my group requests privately

As the owner, I want to discuss, supplement and confirm the requests I started in a group from a private conversation, while the group still receives progress and results.

- agent-console::US-008/AC-01: A request started in a group still belongs and reports to that group; its Team Leader posts progress and results there.
- agent-console::US-008/AC-02: A supplement or confirmation shows a card with the exact requirements, the answering leader and that leader's active Assignments. For a group request it also previews the progress summary that the leader will post; after confirmation, the summary appears in the group-report timeline.
- agent-console::US-008/AC-03: Only confirmed requirements reach the Executors. The private transcript never enters group records, reports or group memory.
- agent-console::US-008/AC-04: Repeating a confirmation applies it once. A proposal made against an older revision of the request must be checked again.
- agent-console::US-008/AC-05: An ended request remains available for discussion; new work needs a new request.

## Functional Requirements

### agent-console::REQ-001 Executor content is the owner's view only (direct acceptance)

The console shows the actual Executor, process and result of every Assignment. This view is the owner's; it is never added to any agent's context.

### agent-console::REQ-002 Requester controls in private conversations

- agent-console::REQ-002/AC-01: Every control in a private conversation keeps original-requester authority: the owner controls only the owner's own requests ([agent-dispatch::REQ-007/AC-01](agent-dispatch.md)).
- agent-console::REQ-002/AC-02: A private request is cancelled, retried and confirmed beyond the Assignment limits in the private conversation where it was created, under [agent-dispatch::REQ-007/AC-03](agent-dispatch.md), [agent-dispatch::REQ-008/AC-01](agent-dispatch.md) and [agent-dispatch::REQ-011/AC-02](agent-dispatch.md). When the owner's private request is selected, its summary offers 「取消这项事务」 while it runs or waits, and 「重试失败的分工」 when it has partially failed or failed. Each opens a confirmation card in the conversation. The cancel card lists the Assignments that will stop; the retry card lists only the failed and interrupted Assignments.
- agent-console::REQ-002/AC-03: In the Coordinator's private conversation, the Coordinator sees the state, team and reports of the owner's requests, never Executor content.
- agent-console::REQ-002/AC-04: For a group request selected in a private conversation, the conversation offers no cancel or retry. It notes that both are asked of the lead Team Leader in the originating group.

### agent-console::REQ-003 Penny shows status and storage only (direct acceptance)

Penny appears with its status, responsibility and storage locations only. Amounts, bookkeeping text, payment screenshots, per-transaction records and transaction counts never enter the console's overview, records or search (ADR-0025).

### agent-console::REQ-004 Configuration audit (direct acceptance)

The service appends an entry to a local audit file for each of these events:

- a saved change to a team, a group binding, an Agent Profile, an MCP server or tool, or a skill;
- an onboarding action;
- a browser authorization or revocation;
- a refused MCP call.

Each entry records the time, the authorized browser or agent, and what changed, and never a secret value. The owner reads the audit from the local command line; the console has no audit page.

### agent-console::REQ-005 How displayed content renders

- agent-console::REQ-005/AC-01: Replies from the Coordinator and Team Leaders in private conversations render as Markdown.
- agent-console::REQ-005/AC-02: Only `http` and `https` links in a Markdown reply are clickable. They open in a new browser tab without access to the console page. Other link targets show as text.
- agent-console::REQ-005/AC-03: Markdown replies never load images; an image shows its alternative text. Raw HTML shows as text.
- agent-console::REQ-005/AC-04: All other displayed content renders as plain text, with no clickable links and no loaded images. This covers group messages, file names, Briefs, Executor results and MCP output.
- agent-console::REQ-005/AC-05: Long or malformed content wraps or scrolls inside its message or record and never widens the page.
- agent-console::REQ-005/AC-06: Delivered files open only through the existing controlled file access.

### agent-console::REQ-006 Teams available to private requests (direct acceptance)

In private conversations, the Coordinator's routing, cross-team Assignments and every Team Leader's Team Directory cover all defined teams that are not being deleted, whether or not their Feishu onboarding is complete or they are bound to any group. Group bindings do not apply, because private requests never post in a group.

## Constraints

### agent-console::CON-001 Local, authorized access (direct acceptance)

Applies to: every page and API of the local service, including the existing settings pages.

- Requests whose Host is not `127.0.0.1` or `localhost` with the service's port are refused.
- Every page and API requires an authorized browser, except the login-link exchange and the page explaining how to obtain a link. The Codex plugin's authorization under agent-console::US-001/AC-05 counts as an authorized browser.
- State-changing requests must also come from the same origin.
- Fixture routes exist only in fixture mode; they keep their current access, subject to the Host rule.
- The public event ingress never routes to the local service.

### agent-console::CON-002 Private conversations stay private (direct acceptance)

Applies to: Coordinator and Team Leader private conversations and private requests. Their content never enters a group's records, reports or memory, or ordinary personal memory; group isolation and requester boundaries follow [ADR-0023](../adr/0023-isolate-feishu-group-authority.md).

### agent-console::CON-003 agent-link visual design (direct acceptance)

Applies to: every console page. The console follows the owner's agent-link web console:

- agent-link colors for the canvas, sidebar, panel, line, ink, green accent and warning and error chips;
- muted text darkened to `#5f6963`, keeping 4.5 contrast on selected backgrounds;
- catalog tables in a bordered rounded panel, and required and optional tags on form fields;
- tree nodes as rounded cards with a light shadow and a border tinted from their role color, with 2px connectors in the dispatching role's color;
- role colors from the agent-link palette: the Coordinator in the accent green, Alice in the peer purple, Bill in the document blue, Jack in an added olive (`#5e6b1c`), and storage in muted grey;
- a spark icon for Skill 管理.

The interface is Chinese and light only; the project's capability declaration disables i18n and theming.

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Owner opens the console in a browser that was never authorized | Only login instructions, no data under agent-console::US-001/AC-04 |
| Login link opened after 2 minutes, or a second time | Refused; a new link is needed under agent-console::US-001/AC-01 |
| Service restarts; owner reopens the console | Still authorized under agent-console::US-001/AC-02 |
| Owner revokes a browser with the console open | Its pages disconnect immediately under agent-console::US-001/AC-03 |
| Another web page posts to the service, or reaches it through a rebound domain name | Refused by the Host, authorization and origin rules under agent-console::CON-001 |
| Existing settings page opened after this change | Requires the same login under agent-console::CON-001 |
| Owner selects a node, a frame title or a record | Drawer opens on records; frame titles open the record expanded under agent-console::US-004/AC-01 and agent-console::US-003/AC-03 |
| Click outside the drawer on blank space, another node or a map control | Blank space closes it; another node selects that node; a control performs its own action under agent-console::US-002/AC-05 |
| Assignment ends | Executor leaves the tree; its record stays under agent-console::US-003/AC-04 |
| Request partially fails | Record shows the failed Assignments and the partially failed state under agent-console::US-004/AC-04 and [agent-dispatch::REQ-008/AC-01](agent-dispatch.md) |
| Result accepted by the platform but delivery uncertain | Shown separately from business outcome under agent-console::US-004/AC-05 |
| Owner writes a draft to Bill, switches to Jack, then back | Bill's draft is intact under agent-console::US-006/AC-02 |
| Owner tries to chat with an Executor or Penny through the API | Refused under agent-console::US-006/AC-01 |
| Owner asks Jack's leader for travel planning in private | Explained; the owner can ask the Coordinator under agent-console::US-007/AC-02 |
| Owner asks a team that is being deleted for new private work | Refused with discussion still open under agent-console::US-007/AC-04 |
| Owner asks a team that has not finished onboarding, or is bound to no group, for private work | Accepted under agent-console::REQ-006 |
| Owner confirms a supplement twice, or after the request changed | Applied once; stale proposal is checked again under agent-console::US-008/AC-04 |
| Owner supplements a group request privately | The group sees only the leader's confirmed summary under agent-console::US-008/AC-02 and agent-console::US-008/AC-03 |
| Owner tries to control another member's group request privately | Refused under agent-console::REQ-002/AC-01 |
| Private request needs a sixth Assignment | Confirmation in the private conversation under agent-console::REQ-002/AC-02 and [agent-dispatch::REQ-011/AC-02](agent-dispatch.md) |
| Owner selects a group request in a private conversation and wants to cancel it | No cancel action; the note points to the group under agent-console::REQ-002/AC-04 |
| Owner revokes the current browser | The page turns into the login card under agent-console::US-001/AC-03 and agent-console::US-001/AC-04 |
| Owner runs the login command while the service is not running | The command says the service is not running and prints no link under agent-console::US-001/AC-01 |
| Codex plugin starts, or its authorization is revoked or replaced | It authorizes again through the control channel, replacing its previous entry, under agent-console::US-001/AC-05 |
| Search for an amount or a Penny transaction | No financial content is found under agent-console::REQ-003 |
| A private result is requested from a group | Not available under agent-console::CON-002 |
| Owner changes a team or MCP server | Audit entry without secrets under agent-console::REQ-004 |
| A leader's reply contains a link, a `javascript:` or `file:` link, an image, raw HTML or a 2,000-row table | `http(s)` links open in a new tab; other targets, images and HTML stay text; the table scrolls inside the message under agent-console::REQ-005/AC-02, agent-console::REQ-005/AC-03 and agent-console::REQ-005/AC-05 |
| Records contain message text, links, markup, image references or file names from members, Executors or MCP tools | Plain text; nothing navigates, loads or submits under agent-console::REQ-005/AC-04 |

## Implementation Decisions

**Local service.** The console is served by the existing local service on the loopback address, next to the existing settings pages, and never through the public ingress. One authorization layer guards every route; fixture routes remain gated by fixture mode.

**Login.** Login follows the owner's agent-link design: a control command obtains a single-use link from the running service, the browser exchanges it for a cookie, and the service stores hashed authorizations in its state directory with owner-only file permissions. Revocation closes the browser's live connections, and an open page that is then refused reloads into the login card with the revoked notice.

**Control channel.** The running service listens on an owner-only Unix socket and writes a connection file holding the socket path and a token rotated on every start, both in its state directory. The login command and the Codex plugin are its only clients. The cookie's name carries the service's port, because loopback cookies are shared across ports.

**Audit file.** The audit is a JSON Lines file in the state directory with owner-only permissions, appended to and read with standard command-line tools. An authorization that cannot be stored or audited is refused; a revocation always applies and reports an audit entry that could not be written.

**Read projections.** The overview and records read from a projection over Dispatch Requests, Assignments, Executors, group reports and their delivery outcomes, keyed by conversation. Penny contributes only its readiness and storage locations.

**Private conversations.** Each private conversation with the Coordinator or a Team Leader is its own conversation scope for memory and requests (ADR-0027). Its transcript, drafts and private requests are stored apart from group state and ordinary personal memory. A message sent from the console enters the same admission path as other requests, with the owner as requester and the private conversation as destination.

## Testing Decisions

- **Authorization.** Tested at the HTTP boundary of the real local service: Host refusal, unauthorized access to every route, link expiry and single use, persistence across restart, revocation closing connections, and the fixture-mode exception. The control channel and the Codex plugin's authorization are tested over a real Unix socket, and the plugin's renewal at its HTTP client boundary.
- **Projections.** Tested at their public interface from durable dispatch records, including partial failure, cross-team Assignments, delivery states and Penny's exclusion.
- **Private conversations.** The real-main path drives console messages through admission and verifies destinations, requester checks, private isolation and confirmation once-only behavior.
- **Pages.** Playwright end-to-end tests drive the console as the owner: login, tree and records, drawer behavior, chat drafts, private request creation and a private supplement to a group request.

## Out of Scope

- Chat entries for Executors or Penny.
- An audit page in the console.
- Remote access to the console from another computer.
- Dark appearance and other interface languages.
