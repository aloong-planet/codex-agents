# Team management

> Related decisions: [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md), [ADR-0026](../adr/0026-coordinate-group-work-through-isolated-teams.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md)

## Overview

The owner wants to decide, from the console and without a restart, which Agent Teams work in which dispatch groups, what each team is responsible for, and what its Executors may use. The 团队管理 page lists every team beside an editor for the selected one. A save applies to new requests at once, and Sam announces in the group when a team starts or stops taking work there.

## Capabilities

- 团队管理 appears in the console's navigation. The team list shows Sam and every team, each with its state (固定, 正常接单 or 接入未完成), its groups, its number of Executor profiles and its active Assignments. The list can be searched and filtered by group.
- 新增团队 adds an unnamed team to the list and opens it in the editor; it is created at its first save.
- The editor edits the leader's name, the team name, the App ID and App Secret of the team's existing Feishu application, the responsibility, the Team Leader's instructions, the Executor profiles and the groups.
- The App Secret can only be written or replaced: 填写 or 替换 opens a password field, and once saved the page shows 「已保存 · 不显示」. No page or response ever shows it.
- Onboarding shows two steps, each with 未开始, 等待审核, 需处理 or 已完成:
  - 校验凭证并读取机器人信息;
  - 加入所绑定的群, with one row per group, so a team can take work in one group while another needs action.

  Each step needing action says why: a secret that does not match, an application not yet published or enabled, a group where only the owner and admins add members, a join awaiting approval, or no answer from Feishu. Checks run after a save that changes the application or adds a group, and on 「重新检查」.
- A team takes work in a group only once both steps are done there. Until then Sam does not dispatch to it there, and the group's preview leaves it out.
- Each Executor profile has a name, an executor noun (执行者称呼), its instructions and its host tools grouped as 文件, 发送 and 定时任务:
  - The noun names the profile's Executors in the group, shown as a hint such as 「视觉执行者 51」.
  - A checked tool that module permissions do not grant carries 「未授权」, and 「实际可用：…」 lists what Executors actually get.
  - Profiles can be added and removed.
- Sam is fixed. Its application, steps and groups are shown as done and cannot be changed; only its responsibility and instructions can be saved.
- The groups section has a checkbox for each dispatch group and a preview of whom Sam can dispatch to there.
  - Unchecking a group where the team takes work marks it 「保存后移除」. After the save it shows 「移除中 · 停止接单」, and Sam stops dispatching to the team there.
  - Unchecking a group where the team is still onboarding simply drops it.
- Sam's announcements appear under each group with their delivery state:
  - when a team starts taking work in a group: 「<负责人>（<团队名>）已加入本群，负责：<职责>」;
  - when a team stops: 「<负责人>（<团队名>）已离开本群，不再接新的事务；进行中的事务会做完。」.

  The state is 飞书已接收, 发送失败 · 不会自动重发 or 发送结果未知 · 不会自动重发. A failed announcement is not sent again, and the change it announced still holds.
- The save bar shows 有未保存的修改, the saved state and the clean state.
  - A refused save shows 「无法保存」 with the reasons: a missing leader or team name, no Executor profile, an unnamed profile or two with the same name, a malformed App ID, or an application already used by Sam, another team or Penny.
  - A save made over a newer version of the same team from another page is refused with 「重新载入」.
- The owner chooses the dispatch groups on the page, among the Feishu groups the service already allows; each is listed by name with its chat ID.
  - Without dispatch, the page shows 「尚未配置派单群」 with this form instead of the team list. With dispatch, 「派单群设置」 opens it in a drawer.
  - A save applies after the service restarts, and the page says so. Until then the form shows 运行中的服务 beside 已保存，重启后, and a strip 「派单群设置已保存，重启服务后生效。」 with 「查看派单群设置」 stays above the team list. Saving with no group checked turns dispatch off at the restart; the teams stay for a later re-enable.
  - A save is refused with 「无法保存」 while 飞书配对向导 is using the channel configuration, when the configuration changed after the page loaded it (with 「重新载入」), or when it unchecks a group that still has unfinished dispatch requests, which it lists, each linked to its record on the team overview.
  - After the restart, Sam dispatches in exactly the saved groups. With no team yet, Sam answers alone there.
- Without Feishu paired, the page shows only 「尚未配置派单群」 and says to stop the service and run `pnpm feishu:pair` first.
- 「MCP 管理」 leads to the MCP management page, whose 「返回团队管理」 leads back.
- Every save, including a dispatch-group save with the groups before and after, is recorded in the local audit file with the browser that made it, never with a secret.

## Boundaries and non-goals

- A team uses an existing Feishu application; creating one by QR code, the test message, MCP servers, skills and deleting a team are not available on the page.
- A team removed from a group stays 「移除中 · 停止接单」 there; its active work finishes, but the page offers no further removal steps.
- Group names come from Feishu; a group whose name cannot be read is shown by its chat ID.
- When a team's application cannot post, its requests fail without any message to the requester in the group, because no other bot posts for it. A team stays taking work after a failed credential check.
- Pairing Feishu, the allowed groups and the receive mode stay outside the page.
- A team bound to a group that is no longer a dispatch group after a restart loses that binding, with no announcement in the group.
- Requests admitted in a group after it was unchecked and before the restart are cancelled at the restart.
