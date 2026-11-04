# Memory Curator top-level tab design

## Goal

Move the complete account-memory surface out of the Codex chat panel into a top-level application tab. The default tab remains **微信助手**; **Memory Curator** becomes a focused read-only/account-control workspace containing enable/disable state and the existing **长期记忆 / Events** views.

## Interaction contract

- One ARIA tablist below the page header switches between `微信助手` and `Memory Curator`.
- `微信助手` owns connection status, QR/session controls, test send, Codex chat, permissions, transcript, and daily news.
- `Memory Curator` owns memory status, account-level enable/disable actions, stable memory, events, and feedback.
- The selected top-level tab and selected inner memory tab are local UI state. Background polling updates both panels without resetting either selection.
- Arrow Left/Right and Home/End switch the top-level tabs and move focus consistently.
- Memory data remains account-scoped and follows the account currently selected by the shared application state. The dedicated view shows that account's local display name, but moving the UI does not introduce a second account selector or any new mutation endpoint.

## Failure paths

1. Memory is unavailable: the dedicated tab remains usable and shows the existing unavailable state.
2. No account is selected: enable/disable controls remain disabled and the empty state is shown.
3. Polling refreshes while Memory Curator or Events is selected: both selections remain unchanged.
4. A memory action fails: the existing shared error and memory feedback regions report it without switching tabs.
5. Narrow screens: tabs remain full-width and panels stay in the existing single-column responsive layout.

## Acceptance

- Contract test proves the two top-level tabs and owned tabpanels exist.
- Browser E2E proves Memory Curator is hidden on the default assistant tab, becomes visible after switching, inner Events still works, and polling preserves both selections.
- Existing QR, binding, Codex, permission, send, and daily-news fixture flow remains green.
