# The plugin panel's poll put back an unconfirmed target choice

Date: 2026-11-11 (ci-flaky ticket 01).

## Root cause

The plugin's MCP Apps panel calls `get_weixin_state` silently every 2 s. Every result went through `applyResult`, which rendered the 「直连账户」 and 「最近入站目标」 selects from the service's confirmed `selectedAccountId` and `selectedTarget`. A user's change of either select therefore lasted only until the next state update. The selects then showed the confirmed session again, while a confirmation ticked for the new target stayed ticked. 「确认会话与目标」 confirmed the old session, and 「发送测试消息」 would then send a real message to it.

The plugin UI journey hit this whenever a poll landed between its switch to `other-user` and its confirm click. Because the case runs about 1.5 s slower on CI than locally, the switch lands at about 3.9 s there, next to the 4 s poll. The journey then failed on the 「在 Codex Desktop 中查看（实验）」 button, which is enabled only for the relayed `other-user`, with "expected false to be true". This happened on the first CI attempt of three PRs in a row.

## Why the existing checks did not catch it

- No case put a state update between a select change and the confirm. The journey's only reads after the switch came before any poll could arrive.
- The failure was random, passed on a rerun, and showed up on a button. It was taken for a slow render, and the ticket cut for it asked for a bounded wait on that read. A sweep of the poll's phase showed that in the failing timing the button stayed disabled for 3 more seconds. The wait would have turned the failure into a timeout and left the bug in place.
- The design doc's rule 「账户或目标一旦改变，立即撤销发送就绪与两项确认」 was implemented only in the selects' change handlers. The panel's own re-renders were outside it.

## Defenses

- The panel keeps the user's unconfirmed choice through state updates until the confirmed session equals it. A choice made while the chosen account has no target takes the first target the account offers, a choice whose option disappears is dropped, and both ticks are cleared whenever an update moves a select by itself (design doc `apps/weixin-service/docs/weixin-codex-plugin-design.md`, 「MCP Apps 面板」).
- The simulated host in `plugins/codex-weixin/tests/ui-e2e.test.ts` can push a state update and wait until the panel renders it. The journey and two further cases push one between the change and the confirm, and assert the account and target of the `confirm_weixin_session` call, not only the select values.
- Every read of the panel's state in that file waits up to `processWaitLimitMs` ([test-waits-on-other-processes.md](test-waits-on-other-processes.md)).

## Boundaries

- The rule is tested only through those browser cases. The panel's script is an inline `String.raw` page that no unit test can import.
- A failed confirm, and a select changed again while a confirm is in flight, are not driven by any case.
- The evidence (the phase sweep and the red-first runs) is in the ticket's local working records under `docs/.workings/ci-flaky/`. They are not committed.
