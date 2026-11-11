# Team organization and private conversations

## Question

This page tests whether the owner can do the following:

- understand a collapsible hierarchy in which leaders divide each request into assignments, and each assignment is performed by one task-created executor;
- follow what each leader and Sam report to the group, including cross-team assignments;
- read the group posts of cross-team work: the lead leader's start line for a part it asked Sam to place, Sam's assignment, the cross-team leader's start and closing, and the lead leader's closing that summarizes the reports Sam relayed;
- tell a request in which no team took a requested part (部分未落实) from one that failed, and follow its retry;
- create a private request through a leader;
- continue an owned group request without exposing the private conversation to the group.

Members, messages, requests, assignments, confirmations and reports are synthetic. No production data is loaded and no real messages or tasks are sent.

## Structure basis

### Organisation tree

- **Console shell.** The console borrows the owner's agent-link web console UI, through the shared `agent-console-shell.js` and `agent-console` visual block:
  - a 212px left sidebar with the identity, the page navigation (团队总览, 团队管理, MCP 管理, Skill 管理, with the current page selected), and the owner's private entries in three sections (私人任务, Penny · 本人私聊, 普通私聊), each section titled with an info tip;
  - on the team overview the private entries switch the tree to private requests or open their drawer; on other pages they lead to the team overview;
  - below 900px, a menu bar opens the sidebar;
  - a page title with an info tip that holds the page description;
  - agent-link's colors and chips;
  - a right drawer over a scrim, `min(720px, 80% of the area beside the sidebar)` wide, closed by its bordered X, the scrim or Escape.
  - Info tips open a single popover attached to the page body, placed from the tip's measured position and closed by scrolling or resizing.
  - At the bottom of the sidebar, a 本机 section, whose tip covers login and the configuration audit, holds the 本机登录 entry with the number of authorized browsers. It opens a drawer above any page drawer:
    - authorized browsers, each with its label, authorization time, last use and a current-browser badge, and with 收回 behind an inline confirmation;
    - 全部收回, also behind an inline confirmation;
    - a 配置审计 section whose tip says that configuration changes, onboarding actions, authorizations and refused MCP calls go to a local audit file read from the command line. There is no audit page.
  - A browser without authorization sees only a full-window gate. It explains how to get a one-time login link (valid 2 minutes, single use) and shows no data. Revoking the current browser, or all browsers, leads to the gate.

The heading's 团队管理 button opens `prototype-team-management.html`. The workspace uses the owner-selected top-down collapsible organization tree. The drawer overlays the page, and the canvas keeps its size and position underneath it. On phones the drawer fills the workspace, and the canvas becomes inert until the drawer closes.

- **Scope entries.** The existing entry chips choose the tree's scope: the group, or the owner's private requests. They filter the same organization view. The owner's private entries — leader conversations, private task storage, Penny and the ordinary assistant — are in the sidebar.
- **Leaders.** Sam coordinates the first-level leaders Alice, Bill and Jack. All four coordinate, delegate and report, and none of them executes. A leader card counts the requests that involve its team as running, waiting or history. Each request counts once per team.
- **Request frames.** Executors are grouped by request; the owner selected this direction for the tree. Each request with active assignments in a team appears under that team's leader as a dashed frame.
  - The frame title shows the request ID and a short title.
  - On the lead team, the caption counts the team's own assignments and any cross-team ones. On another team, it says the assignment is cross-team, requested by the lead leader.
  - The leader's edge ends at the frame, and the executors sit inside it.
  - Selecting the frame title opens that request's record, already expanded.
  - Only running and waiting executors appear. A request with no active assignment in a team has no frame there.
  - Each team can collapse independently.
- **Executors.** Each executor node is named after its team's preset capability profile plus a number. Its role line shows the profile, its caption shows the assignment, and its foot shows the status and the assignment ID. Executors have no bot badge and no chat entry.
  - Ended executors leave the tree. Their identity, assignment, result and execution records remain in the request's records.
  - Team cards distinguish active work from history, and never present ended executors as idle capacity.

### Request records

Each record row is one request. The business-state filter offers 执行中, 待确认, 已完成, 部分失败, 部分未落实 and 已取消. Its two-row summary shows:

- the title and the disclosure action;
- the lead leader with the assignment count, the business state, report delivery and the time.

An expanded record shows these parts, in order:

1. The result.
2. A path line: the route from Sam to the lead leader, each cross-team assignment from Sam on the lead leader's request, each part no team took (「未承接：<part> · 没有团队承接」), and the identities that report.
3. The assignment list. Each entry shows the executor, the responsible leader, the capability profile, a cross-team marker, the status and the result.
4. A collapsible group-report timeline, using the same expandable timeline pattern as `prototype-overview.html`. It lists who posted what, and whether the platform accepted it. A post keeps its line breaks: a post with several items, such as a start message naming several Executors, a closing covering several Assignments or a cancel report, shows each item on its own line, as the group receives it. The cancelled group sample R-2394 shows the cancel report. In a start message, an Assignment that waits for others names them after its title, as 「（等 2 完成后开始）」; it gets no start post of its own when it starts later (sample R-2392).

   Delivery: ticket 07 of agent-teams delivered the one-item-per-line posts, and ticket 31 the dependencies between Assignments: the 「（等 … 完成后开始）」 annotation and the 未开始（前项失败） state of sample R-2392. The service numbers prerequisites by their position among the team's own Assignments, which in this single-team sample is their position in the request. Ticket 08 delivers the cross-team posts below.
   - Leaders post the start message naming who does which assignment, team-internal decisions, progress, and the closing message.
   - Sam posts cross-team assignments.
   - **Cross-team posts.** Every cross-team part is planned before any start message goes out, and the posts follow in this order:
     - **The lead leader's start message.** It gives one line 「<part>需要其他团队支持，已请 Sam 协调。」 for each part that Sam placed with another team, before 「完成后会在本群汇报。」. The message then has several items, so it uses the one-item-per-line form.
     - **Sam's assignment.** For one part it reads 「应 <lead> 请求，<part>交给 <leader> 队；完成后经 Sam 交回 <lead> 汇总。」. When parts go to two teams, one post gives each part on its own line after 「应 <lead> 请求：」 and ends with 「完成后经 Sam 交回 <lead> 汇总。」.
     - **The cross-team leader's start message.** It uses the leaders' start format on that leader's bot, with 「完成后经 Sam 交回 <lead> 汇总。」 as its last line.
     - **The cross-team leader's closing.** It is posted as soon as all of that team's assignments in the request have ended. It is that leader's own closing, one line per assignment with any failure named, followed by 「结果经 Sam 交回 <lead> 汇总。」. When that leader's closing turn fails, the post gives each assignment's own result line, in the form the lead's fallback closing uses, followed by the same last line.
     - **The cross-team leader's other posts.** Its failure, pending-choice and interruption posts keep the leaders' wording on its own bot.
     - **The lead leader's closing.** It summarizes its own assignments and each part's report, which Sam relays, never the other team's executor results.
     - **No team found.** When Sam finds no team for a part, the lead's start omits that part's line and Sam posts nothing. The lead's closing ends with the line 「<part>没有团队承接，本次未处理；有团队可以承接后，可以明确要求重试。」; after a retry in which still no team takes it, the line reads 「<part>仍没有团队承接，…」.
     - **部分未落实.** A request is 部分未落实 when every assignment that was not cancelled completed and at least one requested part had no team. A failed or interrupted assignment, or one that did not start because a prerequisite failed (未开始（前项失败）), keeps 部分失败 or 失败, and the closing still names the parts not taken. A request is never wholly 未落实, because a lead's plan always holds at least one assignment of its own. The badge is an outlined warning badge, apart from the filled 待确认 and the red 部分失败.
     - **Retry.** An explicit retry reruns the failed and interrupted assignments and asks Sam again for every part no team took. When a team takes one now, Sam posts its assignment and that team posts its start and closing; the lead posts no new start, because none of its own assignments reruns. Completed assignments are not redone.
   - The cross-team samples:
     - R-2405 (running): one part, with a cross-team start naming two assignments;
     - R-2395 (completed): parts for two teams, both cross-team closings and the lead closing;
     - R-2393 (部分失败): a cross-team failure post, and a cross-team closing that names the failure;
     - R-2390 (running): a pending choice on the cross-team bot;
     - R-2389 (部分失败): an interruption post on the cross-team bot, and a fallback closing after a failed closing turn;
     - R-2386 (部分未落实): no team found;
     - R-2387 (部分失败): a failure and a part no team took, both named in the closing;
     - R-2385 (completed): no team at first; after a retry Jack's team takes the part;
     - R-2383 (部分未落实): no team at first, and still none after a retry.
   - Private requests have no group-report timeline.
   Assignment states are 执行中, 待确认, 已完成, 失败, 已中断, 已取消 and 未开始（前项失败）, the last for an Assignment whose prerequisite failed; it never started, so no Executor ended. A failed Assignment shows its cause; an interrupted one says it was reported rather than replayed. The sample request R-2391 has one completed, one failed and one interrupted Assignment: it is 部分失败, its closing report names both problems, and its result says a retry redoes only those two.
5. The original message.
6. A chat action for each involved leader.
7. Storage links.

### Relationships and storage

The relationships/storage tab separates:

- the group business memory, which only Sam reads;
- the leader and executor memory: one scope per leader, and one scope per executor capability profile shared by later executors of that profile in the same conversation;
- the execution records and delivered files;
- group scheduled tasks;
- private conversations and private tasks;
- ordinary personal memory;
- Penny's financial stores.

Sam's and each first-level leader's tab links to 负责人私聊记录 beside the group stores, so the private conversations' store is reachable from the agents the owner chats with. A node opened from a link in the drawer keeps the current tab, and 返回 in the drawer header goes back to the node shown before, as on the app's team overview.

Storage for leader memory, executor memory, leader chats and private requests is described as a conceptual scope, not an implemented filesystem path. Penny shows status and storage only, with no financial records and no general chat entry.

### Chat

The round speech-bubble path follows the official [Lucide MessageCircle SVG](https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/message-circle.svg).

- **Entry button.** Sam and each first-level leader have a 28px chat button beside their name. It holds a 16px round bubble with no visible frame or background, and keyboard focus remains visible. Executors have no private-chat entry.
- **Drawer.** Selecting a name, a node or a frame title opens the records-first drawer. Selecting the chat bubble opens an in-page private conversation. The conversation header switches between chat and records.
- **Separate threads.** Leader chats keep separate messages and unsent drafts when the drawer closes or switches.
- **Task selector.**
  - A leader's selector lists the owner's requests that involve the leader's team, including requests where that team holds only a cross-team assignment.
  - Sam can coordinate the owner's requests across teams.
  - Selecting a request record's chat action opens that leader's chat.
- **Retained controls.** The records/storage tabs, compact two-row records, one-row filters, plain-X close button, dismissal by clicking blank space outside the drawer, and Escape all remain available.
- **Private requests.**
  - Sending text without an associated request offers a private-request creation card. The owner can keep discussing, or create the request and delegate it.
  - The leader divides the request into one or more assignments and creates one executor for each from the team's capability profiles. Sam's mock asks the owner to choose the responsible leader before delegating.
  - Creating a private request shows the private-scope tree with the new executor, and the results stay private.
- **Reply formatting.** Sam's and the leaders' replies render as Markdown: headings, lists, emphasis, inline code, code blocks and tables. Only `http` and `https` links are clickable; they open in a new tab without access to the page. Other link targets stay as text with their address in brackets. Images show `［图片：alt］` and are never loaded, and raw HTML shows as text. Tables scroll inside the bubble, both ways. The owner's messages, records, results and group reports stay plain text. Jack's conversation opens with a sample reply that exercises each case.
- **Request controls in a private conversation.** When the selected request is the owner's private request, the request summary in the chat offers:
  - 取消这项事务, while it is running or waiting. Its confirmation card lists the unfinished Assignments that stop together, including cross-team ones, and states that completed parts stay and completed actions are not undone.
  - 重试失败的分工, when it is 部分失败 or 失败. Its confirmation card lists only the failed and interrupted Assignments, and says completed ones are not redone and completed actions are not replayed.

  For a group request the summary instead says that cancelling and retrying happen in the group, with the lead leader; the private conversation discusses, supplements and confirms.
- **A team being deleted.** Its leader card shows a 删除中 badge. Its conversation shows a notice and stays open for discussion, but text without a selected request gets an explanation instead of a private-request creation card. Sam's leader choice for a new private request leaves it out.
- **Supplementing an active request.**
  - The confirmation card shows the exact requirements, the answering leader and that leader's active assignments.
  - For a group request, it also previews the progress summary that the leader will post. After confirmation, that summary appears in the group-report timeline.
  - Only confirmed requirements reach the executors, and the private transcript stays out of group records and reports.
  - Repeated confirmations update once. A proposal made against an older request revision must be checked again.
  - An ended request remains available for discussion, but new work needs a new request.

The shared `agent-console` visual block supplies the console shell, colors, record styling, timeline styling and drawer styling. The diagram keeps a light appearance. Nodes are agent-link style rounded cards with a light shadow, and each border is tinted from the role color (40% role color, 60% line). Role colors follow the agent-link palette: Sam uses the accent green, Alice the peer purple, Bill the document blue, and Jack an added olive. Connectors are 2px and use the color of the dispatching role. Request frames have a faint dashed border and a muted title; the storage row has a muted dashed border.

## Demo scaffolding

- **Simulation marker.** The floating `Demo ·` bar marks all conversations, assignments and reporting as simulated. Its controls are not product controls and must not be implemented.
- **Complete current assignment.** This control is enabled when a running assignment is selected, either through its executor, an expanded request record, or a chat's associated request. It simulates one executor result:
  - the executor leaves the tree;
  - its result stays in the request's records;
  - completing the last of a cross-team leader's assignments adds that leader's closing for its part;
  - the last assignment completes the request and adds the lead leader's closing report, which names each cross-team part's relayed result.

  In the product, actual execution results drive these transitions.
- **Jack 团队.** 正常 / 删除中 switches whether Jack's team is being deleted. In the product the delete action on the team page decides this.
- **本机登录.** 已授权 / 未登录 / 链接已失效 switches the browser's authorization; in the product the browser's authorization decides it.
- **群业务记忆.** 有内容 / 尚无内容 / 读取失败 switches what the group memory node's relationships and storage tab shows under 当前内容. In the product the group memory's current entries, and whether they can be read, decide it.
- **Reset conversations and requests.** This clears mock conversations, ends the Jack deletion and restores the eighteen sample requests. These include five partially failed group requests (R-2391; R-2392, with an Assignment that did not start; the cross-team R-2393 and R-2389; and R-2387, which also has a part no team took), two partially unfulfilled ones (R-2386 and R-2383), one cancelled group request (R-2394), the cross-team samples listed under the request records, and two private requests: one running and one partially failed.
- **Fixed responses.**
  - Chat replies, divisions into assignments, profile choices, completion, retry and cancellation results are fixed demonstrations.
  - Sam's leader selection demonstrates the coordination handoff.
  - Automatic intent recognition and the leader's planning are not modeled.
- **No persistence.** All request and conversation state stays in page memory and is cleared on refresh. Only the demo harness's browsing preferences persist.

## Uncovered dimensions

- Chinese and light appearance only. Per the project capability declaration, i18n and theming are disabled, so their checks are skipped.
- The following are not connected:
  - web chat transport;
  - executor execution and the leader's planning;
  - Sam's briefs to leaders and the cross-team result handoff, which appear only as report text;
  - real private and memory storage paths;
  - durable request mutation and channel delivery.
- Controls are not modeled per assignment: supplement, confirmation and cancellation apply to the request, and retry reruns its failed and interrupted assignments. Cancelling or retrying a group request in the group itself is not modeled.
- The following are not modeled:
  - large organizations, and requests with many assignments, which widen the tree;
  - concurrent file modifications;
  - service recovery;
  - message transport failures.

  Wide trees pan at a minimum readable scale, and the mobile drawer covers the workspace.
- Restart recovery and capacity limits require implementation-level lifecycle decisions and verification. This page shows their visible results only: an interrupted Assignment, partial failure and retry.
- Penny's message bodies, amounts, screenshots and per-transaction counts are excluded from the mock data and from search.

## Invalidated conclusions

- The over-limit confirmation no longer holds, in the private conversation or in the group: a request waits for no confirmation of its Assignments or teams. A plan over ten Assignments is merged by its Team Leader in one correction turn and otherwise fails (agent-dispatch::REQ-011/AC-02). Copies of this page that show a 「超出分工上限」 card or Sam's over-limit question are superseded.
- The cross-team posts of sample R-2405 in earlier copies of this page are superseded. They had:
  - the lead's line 「自动上架脚本需要技术支持，已请 Sam 协调。」;
  - Sam's 「…脚本完成后经 Sam 交回 Alice 汇总。」;
  - Jack's one-sentence start 「脚本执行者 53 编写上架脚本草稿，只交付代码，不运行。」;
  - the one-sentence cross-team closing 「<title>已完成，结果经 Sam 交回 <lead> 汇总。」, which the completion demo added.

  The cross-team posts under the request records, with R-2405 and the other cross-team samples, now define them.
