# Fixed dashboard tabs design review

## Verdict

Approved after assigning every existing control to one panel, making scroll ownership explicit, and retaining one shared account/target state.

## Findings resolved before implementation

1. **“聊天记录” could strand Codex controls elsewhere.** Codex enable/disable and live run status move with the transcript because they describe and control the same conversation runtime.
2. **Permission state could become target-specific by accident.** The UI moves only; permission state and handlers keep their existing service scope.
3. **Fixed tabs implemented with `position: fixed` could overlap content and mobile safe areas.** A viewport grid fixes the shell structurally; the content row scrolls independently without overlay offsets.
4. **Five tabs can overflow on mobile.** The tablist uses horizontal overflow and minimum button widths rather than compressing labels unreadably.
5. **Polling could reveal or reset hidden panels.** Selection remains local and `render()` never changes top-level `hidden` attributes.
6. **Moving nodes could duplicate IDs/listeners.** Sections are relocated, not copied; HTML contract and E2E cover the single live controls.
