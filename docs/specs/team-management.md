# Team management

> Status: the team registry and the team management page are implemented locally. Teams are edited, bound to groups, onboarded by QR creation or with an existing application, and announced from the console, and changes apply without a restart.
> Related: [agent dispatch](agent-dispatch.md), [MCP catalog](mcp-catalog.md), [skill library](skill-library.md), [agent console](agent-console.md), [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md).
> Pending: parts of the page are not built.
> - Not built yet: MCP binding (US-003/AC-03, AC-04); skills (US-003/AC-05); deleting a team, the removal panel and the completion of a drain (US-004/AC-01 for deletion, AC-02 to AC-05); and the link to skill management (US-001/AC-04).
> - Unchecking a group stops the team taking work there and announces its departure; the team then stays draining in that group.
> Pending: the Feishu onboarding steps follow official documentation and have not been verified on a real tenant. These points are open:
> - whether Feishu's application-management APIs accept an application created by QR code, and whether the permissions asked for at creation let it change its own configuration; team-management::US-002/AC-08 says what the owner sees and does when they do not;
> - whether a created application is already released when the scan ends, or only by step 3;
> - which permission the group-membership check needs.

## Problem Statement

Adding, changing or removing an Agent Team meant editing local files and restarting the service, and every dispatch group got the same four roles. The owner wants to build a group's roster from the console, onboard a new Team Leader's Feishu identity without the developer console, and give each team its own instructions, tools, MCP servers and skills. The Coordinator and the other Team Leaders must follow those changes without interrupting work in progress.

## Solution

A team-management page in the local console lists every Agent Team beside an editor for the selected team. A team is defined once and bound to dispatch groups. The editor covers the team's basic information and Feishu onboarding, its responsibility and instructions, its Executor Agent Profiles, its groups and its deletion. A QR scan creates the Team Leader's Feishu application. Saving applies to new requests. Binding a team to a group or removing it makes the Coordinator announce the change in that group and updates the Team Directory there. A removed team drains: it takes no new work, finishes what is active and is then unbound.

## User Stories

### team-management::US-001 Define a team once and bind it to groups

As the owner, I want to define a team once and choose the groups where it works, so that one team serves several groups without separate configurations or Feishu applications.

- team-management::US-001/AC-01: The page shows the team list beside the selected team's editor. The list is searchable and filterable by group; each entry shows the team, its state, its bound groups, its number of Executor profiles and its active Assignments.
- team-management::US-001/AC-02: "新增团队" adds an unnamed team to the list and opens it in the editor.
- team-management::US-001/AC-03: The groups section has a checkbox for each dispatch group. Each group shows a preview of the teams the Coordinator can dispatch to there. A team appears in the preview only when it accepts work in that group under team-management::REQ-003.
- team-management::US-001/AC-04: Links lead from the page to the team overview, the MCP management page and the skill management page.

### team-management::US-002 Onboard a Team Leader's Feishu identity

As the owner, I want to create the Team Leader's Feishu application by scanning a QR code, so that a new team can speak in groups without manual developer-console work.

- team-management::US-002/AC-01: QR creation shows a QR code with 「用飞书扫码，在手机上确认创建。创建完成后，App ID 与 App Secret 自动回填，你不需要复制任何凭证。」 and 「刷新二维码」. Scanning it in Feishu and confirming creates a new agent application; it never selects an existing one. The credentials fill in automatically: the application becomes the team's without another save. Afterwards the section shows 「已创建应用 <App ID>」 with 「凭证已自动保存，不显示」, and the secret is saved and never displayed.
- team-management::US-002/AC-02: The owner can instead enter an existing application: an App ID and an App Secret that can only be written or replaced. Progress then starts at the credential check.
- team-management::US-002/AC-03: A progress list shows one line per step, each with one of the statuses not started, in progress, awaiting review, needs action and done. QR creation has six steps, and an existing application the last three:
  1. Create the application by scan.
  2. Configure its permissions and bot capability.
  3. Publish a version; this awaits admin review unless review exemption is enabled.
  4. Check the credentials and read the bot information.
  5. The Coordinator adds the bot to each bound group.
  6. Send a test message, after the owner confirms it.

  Until the scan has created the application, steps 2 to 6 are not started, and neither 「重新检查」 nor the test message is offered.
- team-management::US-002/AC-04: When a group lets only its owner or admins add members, that group's joining step shows needs action with this reason. An expired QR code or a failed scan shows the creation step as needs action and offers a new QR code: the QR area shows 「二维码已过期」 and 「这个二维码已过期，或扫码没有完成。刷新后重新扫码即可，不会创建重复的应用。」 with 「刷新二维码」 as its main action, and the step's reason is 「二维码已过期，或扫码没有完成。请刷新二维码后重新扫码。」
- team-management::US-002/AC-05: The Coordinator's entry shows its existing application with every step done and no actions.
- team-management::US-002/AC-06: 接入方式 is a choice between 「扫码一键创建」 and 「已有应用，手动填写」, saved with the team. A new team starts with 「扫码一键创建」. The save that chooses 「扫码一键创建」 requests the team's QR code; afterwards only 「刷新二维码」 requests one, and the new code replaces a code that still waits. Until that save, nothing is asked of Feishu: the QR area shows 「保存后显示」 and 「保存团队后，这里显示二维码；用飞书扫码即可创建应用。」, and the creation step is not started. While the code is being fetched the area shows 「正在生成」 and 「正在向飞书取二维码。」, and the creation step is in progress, as it is while the code waits for its scan. When Feishu gives no code, the area shows 「未取得二维码」 and 「暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」再试。」 with 「刷新二维码」 as its main action, and the creation step needs action with 「暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」。」
- team-management::US-002/AC-07: A team that already has an application can be saved as 「扫码一键创建」. Before that save the QR area adds 「扫码创建的新应用会替换现在的应用 <App ID>，替换后团队在各群重新接入。」 The team keeps posting and taking work with its application until the scan. The created application then replaces it, and the team onboards again in every group it is not draining from. Saving the team as 「已有应用，手动填写」 ends the QR creation; a team whose application was created by scan then shows that App ID with its stored secret.
- team-management::US-002/AC-08: Step 2 or step 3 shows needs action when Feishu does not accept the automatic call. Refused, step 2 says 「飞书没有接受自动配置。请在飞书开发者后台为这个应用开启机器人能力，并开通发送消息、读取群信息等权限，完成后点「重新检查」。」 and step 3 says 「飞书没有接受自动提交发布。请在飞书开发者后台为这个应用创建版本并提交发布，完成后点「重新检查」。」; unanswered, either says 「暂时连不上飞书，稍后点「重新检查」。」 Step 3 awaiting review says 「已提交发布，等待企业管理员审核。审核通过后点「重新检查」。」 A 「重新检查」 that finds the bot enabled completes steps 2 and 3, whoever configured and released the application.
- team-management::US-002/AC-09: 「发送测试消息…」 is offered once the team accepts work in a group. It opens an inline confirmation below the actions: 「将以 <负责人>（<团队名>）的机器人向<群>发一条测试消息，群里的成员都会看到：「<正文>」」, with 各 before 发 when there are several groups, and with 「确认发送」 and 「取消」. Only 「确认发送」 sends. The team's own application then posts 「这是 <负责人>（<团队名>）的测试消息，用来确认可以在本群发言。」 once to each group the team accepts work in. Step 6 has one row per group a message went to, with 「飞书已接收」, 「发送失败 · 不会自动重发」 or 「发送结果未知 · 不会自动重发」; a failed or unknown send makes that row and the step need action, and is never repeated by itself. The owner can send again, and each group then shows its latest result.

### team-management::US-003 Edit a team's responsibility, instructions and Executor profiles

As the owner, I want to set each team's responsibility, its Team Leader's instructions and its Executor profiles, so that each domain gets exactly the instructions and capabilities it needs.

- team-management::US-003/AC-01: The responsibility text becomes the team's entry in the Coordinator's dispatch list and in every Team Directory of its groups. The Team Leader's instructions go only to that Team Leader.
- team-management::US-003/AC-02: Each Executor profile has its own instructions, host-tool allowlist, MCP servers and skills. The page shows the effective tools: the checked tools intersected with module permissions.
- team-management::US-003/AC-03: "绑定 MCP" lists the enabled servers of the [MCP Catalog](mcp-catalog.md) that the profile does not yet attach, with their transport, state and usable tool count. Choosing one shows a confirmation card that names the team and profile, the `mcp__<server>__…` tools they gain and the exact command or address. The card states that the service holds the connection and Executors never see the credentials. Only confirming the card attaches the server.
- team-management::US-003/AC-04: Each attached server can be unbound. Unbinding is a revocation under [agent-dispatch::REQ-017/AC-02](agent-dispatch.md).
- team-management::US-003/AC-05: Skills are checked from the [Skill Library](skill-library.md). Links lead to MCP management for registering a server and to skill management for importing a skill.
- team-management::US-003/AC-06: A save bar shows unsaved, saved and clean states. A saved change applies under [agent-dispatch::REQ-017](agent-dispatch.md).

### team-management::US-004 Remove a team from a group, or delete it

As the owner, I want to take a team out of a group, or delete it, without cancelling work in progress or losing its history.

- team-management::US-004/AC-01: Unchecking a group and saving removes the team from that group. Deleting the team asks for confirmation and then removes it from all its groups. In either case the team stops accepting work in the affected groups immediately and shows as draining there.
- team-management::US-004/AC-02: Active Assignments of the team in the affected groups finish, and its Team Leader closes them. The removal then completes: the team is unbound from those groups and, when deleted, leaves the team list, with a note in the editor that the deletion is complete. History keeps the team's identity and records.
- team-management::US-004/AC-03: Scheduled tasks that send with the team's identity in an affected group are listed with the removal. Each must be moved to another team that accepts work in that group, or deleted, before the removal completes.
- team-management::US-004/AC-04: Requests with Assignments of the team that wait for their requester keep waiting, and the removal stays pending. The page lists those requests with links to their records. The owner can confirm or cancel the ones the owner requested; the others wait for their own requester ([agent-dispatch::REQ-007/AC-01](agent-dispatch.md)).
- team-management::US-004/AC-05: An unchecked group is marked as removed after saving; once saved, it shows as draining and no longer taking work. A removal progress panel, shared by group removal and deletion, shows four steps: work stops, active Assignments finish, scheduled tasks are moved or deleted, and waiting requests are resolved.

## Functional Requirements

### team-management::REQ-001 Fixed Coordinator, editable teams

- team-management::REQ-001/AC-01: Sam is the Coordinator of every dispatch group. Only its responsibility text and instructions are editable. It has no Executor profiles and cannot be deleted or unbound.
- team-management::REQ-001/AC-02: Alice, Bill and Jack are ordinary teams that can be edited, unbound and deleted.
- team-management::REQ-001/AC-03: The first start of console management imports the existing local configuration: the Coordinator, the three teams with their applications and responsibilities, and their bindings to the current dispatch groups. Each imported team gets one Executor profile whose instructions and tools reproduce its current behavior.

### team-management::REQ-002 Valid team definitions (direct acceptance)

A save is refused, and the save bar shows 「无法保存」 with the reasons, when a team:
- lacks a leader name or a team name;
- has no Executor profile, a profile without a name, or two profiles with the same name;
- has an App ID that is not `cli_` followed by 16 hexadecimal characters;
- uses a Feishu application that the Coordinator or another team already uses;
- uses Penny's application (「该飞书应用已用于 Penny，不能用于团队」, [ADR-0025](../adr/0025-isolate-private-financial-authority.md)). A save based on an outdated version of the team is also refused; the save action becomes 「重新载入」, and the owner reloads before editing again.

### team-management::REQ-003 When a team accepts work in a group (direct acceptance)

A bound team accepts work in a group once all of these hold: its credentials have been verified, its version is published, its bot has joined that group, and it is not draining there. The test message is offered but does not gate acceptance. Until then the team receives no Assignments there ([agent-dispatch::REQ-015/AC-01](agent-dispatch.md)).

### team-management::REQ-004 Announcements and Team Directory updates

- team-management::REQ-004/AC-01: When a team starts accepting work in a group, the Coordinator announces that it has joined. When a removal starts, the Coordinator announces that the team has left. Both follow [agent-dispatch::REQ-015/AC-03](agent-dispatch.md).
- team-management::REQ-004/AC-02: The Team Directory of a group lists exactly the teams accepting work there, with their names and responsibilities.

### team-management::REQ-005 Moving a scheduled task to another team (direct acceptance)

Moving a scheduled task changes only its sending identity to the chosen team's Team Leader. Its schedule, content, group and history are unchanged, and it keeps the group's existing scheduled-task authority ([channel-switching](channel-switching.md)). Only teams that accept work in the task's group can be chosen.

## Constraints

### team-management::CON-001 Write-only application secrets (direct acceptance)

Applies to: App Secrets entered by hand or filled in by QR creation. They are stored locally, never displayed, never returned by any console API and never written to logs, diagnostics or the audit ([agent-console::REQ-004](agent-console.md)).

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Owner adds a team, fills it in and saves before onboarding | Saved; the group preview omits it under team-management::US-001/AC-03 and team-management::REQ-003 |
| Owner scans, but the QR code has expired or the scan fails | Creation step needs action; a new QR code is offered under team-management::US-002/AC-04 |
| Feishu cannot be reached when a QR code is requested | No code; the creation step needs action as unreachable, never as an expired code, under team-management::US-002/AC-06 |
| Owner presses 「刷新二维码」 while a code waits for its scan | The service stops waiting on the old code; only the new one gives the team an application (team-management::US-002/AC-06) |
| Owner confirms on the phone in the moment the code is replaced or QR creation is ended | Feishu has created an application that the service does not use: it is not attached and its secret is not kept. The audit names its App ID so that the owner can remove it in Feishu |
| Owner edits other fields while the code waits, and saves after the scan | The save keeps the created application (Implementation Decisions: console saves) |
| Owner saves a team that has an application as 「扫码一键创建」 and never scans | The team keeps its application and keeps taking work under team-management::US-002/AC-07 |
| Feishu refuses the automatic configuration or release of a created application | The step needs action; after the owner configures and releases it in the Feishu developer console, 「重新检查」 completes both steps under team-management::US-002/AC-08 |
| Version awaits admin review | Step shows awaiting review; the team accepts no work under team-management::REQ-003 |
| A bound group allows only owners or admins to add members | That group's joining step needs action; other groups continue under team-management::US-002/AC-04 |
| Owner enters an existing application whose secret is wrong | Credential check fails; the team accepts no work under team-management::US-002/AC-02 and team-management::REQ-003 |
| Owner enters the Coordinator's or another team's application | Save refused under team-management::REQ-002 |
| Owner removes the last Executor profile, or gives two profiles one name | Save refused under team-management::REQ-002 |
| Two browser tabs edit the same team; the second saves later | Second save refused; owner reloads under team-management::REQ-002 |
| Owner edits responsibility or instructions while a request runs | The running request keeps its definitions under [agent-dispatch::REQ-017/AC-01](agent-dispatch.md) |
| Owner attaches an MCP server, closes the card without confirming | Nothing is attached under team-management::US-003/AC-03 |
| Owner unbinds an MCP server while an Executor uses it | The next call is refused under team-management::US-003/AC-04 |
| Owner unchecks a group where the team has running Assignments | Team drains in that group only under team-management::US-004/AC-01 and team-management::US-004/AC-02 |
| Owner deletes a team that owns scheduled tasks | Removal waits until each task is moved or deleted under team-management::US-004/AC-03 |
| Owner tries to move a task to a team that is not accepting work in that group | Not offered under team-management::REQ-005 |
| A draining team has an Assignment waiting for another member's confirmation | Removal stays pending; the request is listed under team-management::US-004/AC-04 |
| Coordinator's announcement fails to send | Binding change still holds; the announcement keeps its own delivery state under [agent-dispatch::REQ-015/AC-03](agent-dispatch.md) |
| Owner tries to delete or unbind Sam | No such action under team-management::REQ-001/AC-01 |
| Service restarts during a drain or onboarding | Drain and onboarding states resume from the stored registry; no step reruns without its recorded outcome |
| Service restarts while a QR code waits for its scan | The code no longer leads anywhere: the creation step needs action, and 「刷新二维码」 requests a new code |
| Service restarts after a created application's release was submitted | Startup checks whether the bot is enabled; the application is not configured or released again |
| Service restarts while a test message is being sent | That group's result is unknown; nothing is resent (team-management::US-002/AC-09) |
| Response or log could reveal an App Secret | Never returned or logged under team-management::CON-001 |
| Owner enters Penny's application for a team | Save refused under team-management::REQ-002 |
| Owner unchecks a group where the team is still onboarding | The binding is dropped at the save, with no announcement (Implementation Decisions: console saves) |
| Owner replaces a team's secret | The credential check runs again; joined groups keep their outcomes (Implementation Decisions: onboarding) |
| Owner replaces an accepting team's secret with one that fails the check, or any Team Leader's application stops being able to post | The team keeps accepting work there: a check outcome never changes routing by itself. The owner sees the credential-check step 需处理 「凭证校验没有通过」. The team's requests fail at their receipt, and the failure report goes through the same application, so the requester sees nothing in the group: no other identity may post ([agent-dispatch::REQ-008/AC-04](agent-dispatch.md)) |
| Owner moves a team to another application, and later back | Each change starts onboarding again in the team's groups; the save succeeds and the team posts with the application it has |
| A save's onboarding run and 「重新检查」 overlap | They run one after the other; no step is done twice (Implementation Decisions: onboarding) |
| The platform's reply cannot be read, such as a gateway's error page | The step needs action as unreachable, never as wrong credentials or a refused join |
| A group's name cannot be read | The page shows the chat ID; the name is asked for again after 10 minutes, or at once on 「重新检查」 or a save of a team in that group |
| Feishu dispatch is not configured | The 团队管理 entry stays; the page shows the dispatch-group form, or without Feishu the pairing instruction, with no list, editor or 新增团队 ([agent-console::US-009](agent-console.md)) |

## Implementation Decisions

**Team registry.** The team registry (agent-dispatch Implementation Decisions) is the single store of teams, profiles and group bindings. Each save creates a new definitions version and carries the version it was based on, so stale saves can be refused. The registry is seeded from the existing local configuration. Until the console saves its first change, each start imports that configuration again and records a new definitions version only when the import differs; after the first console save, the console is the only editor of the teams. The dispatch groups follow the local configuration at every start, as the agent dispatch spec's Implementation Decisions (local configuration) state. Application secrets are stored beside the versions, never inside one. The seed reproduces today's roster:
- The teams are named 运营团队, 生活团队 and 技术团队. An extra configured role's team is named "<name> 团队", and the Coordinator's entry is labelled 总协调.
- Each team's single Executor profile, 能力档 1, allows every production workflow tool. Only Bill's carries domain instructions: the weather, route, walking, opening-hours and budget-and-schedule rules. The source-verification rules stay in shared prompt assembly.
- Leader and Coordinator profiles start with empty instructions, and the Coordinator has no host tools.

**Binding states.** Each team-group binding moves through these states:

- onboarding, until team-management::REQ-003 holds;
- accepting;
- draining, from the start of a removal until active Assignments, waiting requests and scheduled tasks are cleared;
- removed.

The Team Directory and the Coordinator's roster are derived from bindings in the accepting state. Announcements are durable outbound messages with their own delivery state.

**Console saves.** The console saves one team at a time. A save carries the team's editable fields, its checked groups and the definitions version the page was based on. It is refused as stale only when that team's own editable fields changed since then, so another team's save or an onboarding step never refuses it. The registry derives binding states from the checked groups:
- a kept group keeps its state;
- a newly checked group starts onboarding;
- an unchecked accepting group drains, and the Coordinator announces the departure;
- an unchecked onboarding group is dropped;
- a replaced App ID starts onboarding again in every group the team is not draining from.

A new team's ID is generated at its first save. Sam's save changes only its responsibility and instructions. An App Secret is written beside the versions and never returned.

A save also carries the team's 接入方式. In QR creation the save does not set the application: the team keeps the one it has, whatever App ID or secret the save carries, and an application that QR creation attached since the page loaded does not make the save stale. A save that changes only 接入方式 still counts as a console save.

**Onboarding.** QR creation uses the pinned Feishu SDK's application registration in create-only mode. Configuration, publishing, credential checks, bot information, group joining and the test message use platform APIs. Each step records its outcome so that a restart resumes without repeating completed steps.

**QR creation.** A team's 接入方式 and the state of its QR creation are stored in the registry beside the definitions versions; a team without such a record uses an existing application, as every imported team does.
- **The code.** The service asks Feishu for a registration link and serves it to the page as a QR image; the link and the secret never reach the page. A request that gets no link within 15 seconds counts as no code. The link is valid for the time Feishu states with it, and for one scan.
- **What the scan page is given.** It can only create a new application. The application's name is prefilled with the leader's name and its description with the team's name; the owner can change both there. The application asks for Feishu's minimal template, which has the bot capability and no other permission, plus these permissions:
  - `im:message:send_as_bot`, to post in groups as the bot;
  - `im:resource`, to upload the images and files it sends;
  - `im:chat:readonly`, for the group-membership check;
  - `application:application:patch`, to configure and release itself in steps 2 and 3;
  - `application:bot.basic_info:read`, to read its bot information in step 4.
- **The wait for the scan** lives in the running service only. The creation step records why a creation ended without an application: `unreachable` (no code), `expired`, `denied` (the owner declined on the phone), `failed` (Feishu refused the scan), `connection_lost` (the connection dropped after the code was shown), `interrupted` (the service restarted) or `unusable`. The page shows `unreachable` as no code and every other reason as an expired code.
- **The created application** replaces the team's application in a definitions version of its own, as a replaced App ID does in a console save, and its secret is stored beside the versions. An application that team-management::REQ-002 allows no team to use is not attached: the creation step then needs action as `unusable`.
- **Step 2** enables the bot capability, lets other applications invite the bot into groups, and adds the permissions above again, because the scan page may ignore what the link asked for. **Step 3** submits a release with the bot as its default capability, with the reason 「团队负责人机器人：在派单群里以自己的身份发言。」 and the description 「开启机器人能力，申请发送消息、上传文件和读取群信息的权限。」, which the tenant's admin reads when reviewing it. The created application makes both calls on itself.
- **Review.** After a submitted release, step 3 awaits review until a check finds the bot enabled; the release is not submitted again. Feishu's answer that the application is under review counts as a submitted release, at step 2 as well.
- **A refused or unanswered call** makes its step need action. A later check that finds the bot enabled completes steps 2 and 3, because an enabled bot has a configured and released application, whoever did it.

**Existing applications, and steps 4 and 5 of every application:**
- **Credential check.** It gets a tenant token with the App ID and secret, then reads the bot information. An enabled bot (activate_status 2) completes the step. An application not yet published or enabled (20069), or a bot not yet enabled, awaits review. A refused secret, or no stored secret, needs action. A reply that cannot be read counts as unreachable and needs action.
- **Group joining**, per group. The Coordinator adds the bot by its App ID, then the team's own application confirms it is in the group. A group where only the owner and admins add members (232017), a join awaiting approval, or a bot not in the group afterwards needs action with that reason.
- **Outcomes** are stored per application, and per group for joining. A done step never runs again, except the credential check after a new secret.
- **When checks run:** after a save that changes the credentials or adds a group, after a scan has created the application, on 「重新检查」, and at startup for teams still onboarding. Runs take place one at a time.
- **Acceptance.** A binding starts accepting once the credential check and its group's joining are done. A later failed check never moves an accepting binding out of accepting.

**Test message.** The team's own application posts it through the group channel, so it has the delivery record of the team's other posts. Each group's latest result is stored per application: being sent, accepted, failed or unknown. A send cut off by a restart is unknown.

**Announcements.** The Coordinator posts once per binding change, under its own application:
- joining: 「<负责人>（<团队名>）已加入本群，负责：<职责>」;
- leaving: 「<负责人>（<团队名>）已离开本群，不再接新的事务；进行中的事务会做完。」.

Each announcement keeps its delivery state: accepted, failed or unknown. A send cut off by a restart is unknown, and nothing is resent automatically.

**Executor profiles and effective tools.** A profile's 执行者称呼 names its Executors `<noun> <n>`; the default is 执行者. The page shows the effective tools: the checked tools that module permissions grant. Each host tool's gate decides this:
- `files.find`, `files.grep`, `files.read` and `weixin.send_files` need read on a saved scope;
- `files.write` needs write;
- `files.edit` needs read and write on one scope;
- `media.send` and the schedule tools need none.

A checked tool whose gate is not granted carries 「未授权」. Removing a tool applies at the next call of a running request ([agent-dispatch::REQ-017/AC-02](agent-dispatch.md)), and every refused call is audited.

**Group names** come from the Coordinator's application, with the chat ID as the fallback. A lookup that gives no name is not repeated for 10 minutes, unless a team in that group is saved or rechecked. Concurrent page views share one lookup.

**Audit.** These events are recorded with the authorized browser or the service, never with a secret:
- `team_changed`, naming the fields, and the 接入方式 when the save set or changed it;
- `team_secret_written`;
- `team_binding_changed`, with the before and after states;
- `team_profile_saved` and `team_profile_removed`;
- `team_application_qr_requested`, for each QR code asked for;
- `team_application_created`, with the created App ID and the App ID it replaced;
- `team_application_qr_failed`, with the reason, and with the App ID of an application the scan created but no team uses;
- `team_onboarding_checked`, with each step's outcome;
- `team_binding_accepting`;
- `team_test_message_sent`, with each group's result;
- `host_tool_refused`.

**Scheduled tasks.** Moving a task rewrites only its trusted sending identity. The canonical group scope keeps owning the task.

**Console API.** Team management is served by the local console under [agent-console::CON-001](agent-console.md), and every saved change is audited under [agent-console::REQ-004](agent-console.md).

## Testing Decisions

- **Registry.** Tested at its public interface: versioned saves, stale-save refusal, validation, derived rosters and Team Directories, binding states and drain completion.
- **Onboarding.** Tested against a fake of the SDK registration and platform APIs: success, expiry, review waiting, group-membership refusal and restart resumption. The fake does not establish real-tenant behavior; that remains live acceptance.
- **Console.** HTTP-boundary tests of the management API with an authorized browser. Playwright end-to-end tests drive the page: create, onboard (with the fake), bind, attach an MCP server with confirmation, save, drain and delete.
- **Announcements.** The real-main fixture route verifies that binding and removal produce the Coordinator's announcement and an updated Team Directory in the next Team Leader turn.

## Out of Scope

- Defining a team separately in each group.
- Editing the Coordinator's application, or adding a second Coordinator.
- Feishu hosted agents (aily), which cannot receive group events for this service.
- Per-profile MCP credentials.
- Restoring a deleted team; history keeps its records only.

## Further Notes

The onboarding steps come from official Feishu documentation read on 2026-11-07; the research notes are kept in `~/research/codex-weixin-agent-team/feishu-onboarding.md`. The request and response shapes of the application-management, release and message APIs were read on 2026-11-11 and are kept in `~/research/codex-weixin-agent-team/feishu-onboarding-api-shapes.md`. Admin review and group membership settings can still require manual action in Feishu.

Feishu's pages for the application-management and release APIs say that they support only applications created in the developer console. No page read says whether an application created by QR code counts as one.
