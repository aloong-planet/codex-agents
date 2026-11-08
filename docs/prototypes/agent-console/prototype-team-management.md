# Team management

## Question

Can the owner manage agent teams clearly from a team list and an editor? Managing a team covers:

- defining it once and binding it to one or more groups;
- onboarding its leader's Feishu identity by scanning a QR code, or by entering an existing application;
- editing its responsibility and executor profiles: tools, MCP servers and skills;
- removing it.

Teams, groups, credentials, MCP servers, skills and onboarding progress are synthetic. Nothing is created, saved, verified, sent or authorised.

## Structure basis

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
- **Tips.** Section explanations sit in info tips beside the section titles. Status and warning lines stay inline.

### Page layout

The owner chose this layout: the team list on the left, and the selected team's editor on the right.

- **List.** The list is searchable and can be filtered by group. Each entry shows the team, its state badge, its bound groups, its number of profiles and its active assignments.
- **New team.** "新增团队" adds an unnamed team to the list and opens it in the editor.
- **Navigation.**
  - "Skill 管理" and "MCP 管理" lead to `prototype-skill-library.html` and `prototype-mcp-catalog.html`.
  - "返回团队总览" leads to `prototype-team-structures.html`, whose "团队管理" button leads here.
- **Shared visual block.** The console shell, colors, buttons, inputs, badges, form sections and confirmation cards come from the shared `agent-console` visual block.

### Editor sections

#### 1. Basic information and Feishu onboarding

- **Fields.** Leader name and team name.
- **Onboarding method.** A segmented control switches between QR one-click creation and an existing application.
- **QR creation.**
  - A QR placeholder asks the owner to scan in Feishu and confirm. The scan creates a new agent application without selecting an existing one, and its credentials fill in automatically.
  - Once the scan has completed, the section shows the created App ID; the credentials are saved and never displayed.
- **Existing application.**
  - The owner enters the App ID.
  - The App Secret can only be written or replaced.
- **Progress list.** One line per onboarding step, each with a status badge: not started, in progress, awaiting review, needs action, or done.
  - The QR path has six steps:
    1. Scan to create the application.
    2. Configure permissions and the bot capability.
    3. Publish a version. The badge waits for admin review, and the step notes that review exemption (免审) skips it.
    4. Check the credentials and read the bot information.
    5. Sam adds the bot to each bound group.
    6. Send a test message, which needs confirmation.
  - Step 6 is optional: the team takes work once steps 1–5 are done, whether or not a test message was sent.
  - The existing-application path starts at step 4.
  - An expired QR code, or a scan that did not finish, marks step 1 as "需处理". The QR placeholder says it has expired, and "刷新二维码" becomes the primary action.
  - When a group lets only its owner or admins add members, the group-joining step shows "需处理" with that reason.
- **Fixed coordinator.** Sam shows its existing application, with every step complete and no actions.

#### 2. Responsibility and instructions

The responsibility appears in Sam's dispatch list and in every leader's Team Directory. The instructions go only to that agent.

#### 3. Executor profiles

Each profile has its own instructions, host tools, MCP servers and skills.

- **Tools.** The effective tools are the checked tools intersected with module permissions.
- **MCP servers.**
  - "绑定 MCP" lists the enabled servers registered on the MCP management page that the profile does not yet use, with their transport, state and usable tool count.
  - Choosing one shows a confirmation card naming the team and profile, the `mcp__<server>__…` tools they gain and the exact command or address. The card notes that the service holds the connection and executors never see the credentials. Confirming attaches the server.
  - Each attached server can be unbound. The section note says unbinding takes effect at once, and the profile tip says new tools and servers apply to new requests only, while unchecking or unbinding applies at the next call.
  - "去 MCP 管理登记" leads to the MCP management page.
- **Skills.** Skills are checked from the Skill Library. "去 Skill 管理导入" leads to the skill management page.

#### 4. Groups

There is a checkbox for each group, with a preview of whom Sam can dispatch to in each group. A team appears in that preview only after its onboarding is complete and it is taking work in that group.

- **Removing a team from one group.** Unchecking a bound group marks it "保存后移除". Saving starts the removal there. The group shows "移除中 · 停止接单", leaves the preview, and a removal panel appears below the checkboxes. This uses the same panel as deletion (section 5).
- **Announcements.** The tip says Sam announces a team when it can take work in the group, and announces its departure when removal starts.
- **Sample.** Alice's 产品讨论组 has one scheduled task and no active work. Moving the task to Bill, the only other team taking work there, completes the removal, and a status line says so.

#### 5. Delete team

After confirmation, the team stops taking work in all its groups. The section then shows a removal panel for each group:

1. 停止接单: done; Sam has announced the departure, and the Team Directories are updated.
2. Active assignments: waiting until they finish; the leader closes them.
3. Scheduled tasks that send with the team's identity. They block the removal. Each offers:
   - "转给…": a choice among the teams taking work in that group. Moving a task changes only its sending identity.
   - 删除, behind an inline confirmation.
4. Requests waiting for their requester. Each links to the records. Only the requester can confirm or cancel; others wait for their own requester.

The removal completes when all four are clear. A deleted team then leaves the team list; its editor stays open with a line saying it left every group and that history is kept, until another team is selected. The sample Eve has one active assignment, two scheduled tasks and two waiting requests, one of them from another member.

#### 6. Save bar

The bar shows the unsaved, saved and clean states. A refused save shows "无法保存" with the reasons, in error color:

- a missing leader or team name;
- no executor profile;
- two profiles with the same name;
- an App ID already used by Sam or another team.

A save based on an outdated version is refused with "重新载入", which reloads the team and says so.

### Roles and sample teams

- **Sam.** Sam is the fixed coordinator. Only its responsibility and instructions are editable; it has no executor profiles and cannot be deleted or unbound.
- **Sample teams.**
  - Normal: Alice, Bill and Jack. Alice and Bill are bound to both groups.
  - Onboarding needs action: Daisy, whose bot cannot be added to a group that only its owner and admins may change.
  - Draining: Eve, which is being deleted with one active assignment, two scheduled tasks and two waiting requests.
  - The fixed Sam.
- **Colors.** Team names use their team colors. Daisy and Eve use page tokens, which would move into the shared tokens once those teams exist in other prototypes.

## Demo scaffolding

- **Onboarding progress switch.** When the new unnamed team is selected, the floating `Demo ·` bar switches its onboarding progress between four states: waiting for the scan, waiting for review, blocked when joining a group, and complete. In the product, the results Feishu returns decide this progress, and there is no such control. The bar is not part of the design and must not be implemented.
- **Onboarding states.** The onboarding switch includes "二维码过期".
- **移除中的分工与待确认.** 未结束 / 已结束 appears while the selected team has a removal in progress. 已结束 simulates the active assignments finishing and the waiting requests being answered. In the product, the assignments and the requesters decide this.
- **保存结果.** 按实际校验 / 校验不通过 / 版本已过期. 按实际校验 checks the edited team: try saving the new team with empty names, or entering Sam's App ID. The other two show those refusals for any team. In the product, validation and the version check decide this.
- **本机登录.** 已授权 / 未登录 / 链接已失效; in the product, the browser's authorization decides it.
- **Visual-only actions.** Save, re-check, test message, QR refresh, MCP binding and unbinding, group binding, moving or deleting a scheduled task, and delete give visual feedback only. A refresh restores the mock data.

## Uncovered dimensions

- Chinese and light appearance only. Per the project capability declaration, i18n and theming are disabled, so their checks are skipped.
- **Unverified onboarding facts.** The onboarding steps follow official Feishu documentation and have not been verified on a real tenant. Two points remain open:
  - whether the preset permissions are enough to change the application's configuration;
  - which permission the group-membership check needs.
- **Not modeled:**
  - the content of Sam's announcement;
  - color choice for new teams;
  - renaming or removing a profile, so a duplicate profile name or no profile appears only through the 保存结果 switch;
  - a native QR code; the placeholder is not scannable.
- **Audit.** Configuration changes are audited to a local file, read from the command line (see the 本机 tip); the page shows no audit trail.
- **Icons.** No new icons are used. The QR code is a labelled placeholder, not a scannable image.
