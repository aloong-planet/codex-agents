# Memory Curator top-level tab design review

## Verdict

Approved as a presentation-only change with no service API, persistence, account-isolation, or external-message changes.

## Findings resolved before implementation

1. **“Separate tab” could mean a browser tab.** In this page context it is implemented as an application-level tab so state and polling stay in one local page.
2. **Moving the panel could duplicate account state.** No second account selector or memory state is introduced; the dedicated view follows the existing selected account.
3. **Polling could reset navigation.** Top-level and inner selections live outside `render()` and are reapplied rather than initialized during each response.
4. **Nested tabs could be confusing to assistive technology.** Each tablist has a distinct label and controls only its direct tabpanels.
5. **A UI-only change could regress real channel controls.** The existing complete fixture E2E remains the regression seam; no login or Weixin send is performed by this implementation.
