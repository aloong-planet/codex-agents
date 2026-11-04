# Fixed dashboard tabs design

## Goal

Turn the local page into a fixed-shell dashboard with five top-level workspaces while leaving channel, Codex, permission, memory, and daily-news service behavior unchanged.

The tabs are:

1. `微信连接` — connection status, QR/session binding, aliases, target and test send;
2. `聊天记录` — Codex target enable/disable, run progress, transcript and chat feedback;
3. `本地权限` — permission capability, mode/root selection and confirmation;
4. `Memory Curator` — account status plus the existing long-term-memory/Events tabs;
5. `每日新闻` — preview, send, schedule controls and current digest.

The introductory sentence “不是模拟，也不经过 OpenClaw。扫码、入站会话与测试消息由本地 Demo 直接连接腾讯 iLink。” is removed.

## Layout and state

- `main` is a viewport-height grid: compact header, fixed top-level tablist, independently scrollable active-panel area, error region.
- `body` does not scroll; `#app-tab-content` owns vertical scrolling. Switching tabs resets only the newly selected panel's scroll position to its previous browser-managed position; it does not reset service state.
- Top-level selection is local UI state outside `render()`, so 1.5-second polling cannot change it.
- Every top-level button controls exactly one ARIA tabpanel. Left/Right moves to adjacent tabs with wraparound; Home/End selects first/last.
- The nested Memory/Events tablist remains independent and labelled separately.

## Ownership and invariants

- Existing element IDs and API handlers are moved, not duplicated. Each control still has one DOM owner and one event listener.
- The existing selected account and target remain shared application state. Separate tabs do not create separate channel or permission contexts.
- Moving external-send controls does not invoke them, change confirmation semantics, or add retry behavior.
- The Codex transcript stays continuously rendered while its panel is hidden.

## Failure paths

1. Polling while any non-default tab is active: selection and visibility remain unchanged.
2. Narrow viewport: tablist scrolls horizontally; content remains independently vertical-scrollable.
3. Content exceeds viewport: only the panel area scrolls and the tablist position remains fixed.
4. Service/action failure: the existing local feedback remains inside its owning tab; the shared error region remains visible below the scroll area.
5. Memory unavailable or permissions unsupported: the dedicated panel shows the existing fail-closed state.

## Acceptance

- HTML contract asserts five unique tabs/panels and absence of the removed sentence.
- E2E proves each major section is visible only in its owning panel, background polling preserves selection, keyboard navigation works, and panel scrolling does not move the tablist.
- Existing fixture QR, binding, test send, Codex, permission, memory, and news actions remain green.
