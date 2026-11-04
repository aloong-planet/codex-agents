# ADR-0019: Preserve owner state across explicit channel bindings

- Status: Proposed

## Context and problem

Existing memory is stored under a Weixin account key. Conversation histories also use account and target identity, while module permissions and the access-context epoch already share one service store. Reusing a transport account as the person identity would either split memory or mix conversations after adding Feishu.

## Alternatives

1. **Keep an explicit legacy memory key, validate a private identity binding per channel, and retain distinct conversation addresses in shared service storage.**
2. Copy or rename old memory and workflow records on each switch — introduces multiple mutable copies and changes historical identity.
3. Share one model thread across channels — loses separate channel history and can restore context under a changed identity.

## Decision

The startup composition supplies an immutable personal-owner configuration and selects the configured bound channel set. The simultaneous target retains one shared owner state authority; each admitted message is checked against its own channel binding. Each binding names the connection account, private conversation and sender. Admission requires all three to match and an explicit private-conversation classification. The model does not choose these bindings.

Keep Weixin conversation account/target values unchanged. New Feishu conversation account and target keys are prefixed SHA-256 identifiers, isolated from the legacy Weixin target grammar. Platform adapters retain raw delivery destinations. Both channel identities refer to the explicit memory account key; memory content is not copied or relabeled. Memory evidence retains its source conversation.

Reuse the same conversation and module-permission stores across service restarts. Only the history bound to the incoming conversation is resumed. Curated owner memory is shared, but raw transcripts, model threads, message ordering and Pending Requests remain conversation-specific. A choice in one channel cannot resolve a Run owned by the other. The shared access-context epoch invalidates all older histories after read access narrows. Save a separate owner-binding hash with each model thread and require it on restoration, independently of tool-contract hash and permission epoch. Opting an old history into explicit binding starts a fresh model context when no binding hash exists; its transcript and historical workflow records remain intact.

The binding/core seam is wired into all startup-enabled Weixin and Feishu text/media adapters behind one core. Real-platform authentication and receipt remain separate acceptance checks. Owner-bound notification registration now uses the retained memory account; [ADR-0020](0020-freeze-notification-destinations-per-occurrence.md) separates future delivery from historical task scope. Startup supplies that route together with every enabled adapter. No historical effect, Run or notification is rewritten or resent.

## Consequences

- Positive: existing memory storage and saved permissions survive channel selection without copying content or widening access.
- Negative: an unbound legacy model context is renewed once when explicit owner binding is first activated; local transcript remains readable.
- Neutral: this is one personal service, not a multi-owner permissions model. Configuration is a trusted local input; transport adapters must authenticate and classify platform events before projection.

## Sources

- [Channel switching specification](../specs/channel-switching.md), US-002 and CON-002/003.
- PersonalOwnerIdentity, ConversationService and CodexServiceStore.
- owner-continuity.test.ts exercises persisted memory, shared permissions, history restoration and binding/permission invalidation.

- User explicitly confirmed shared long-term memory and independent chat contexts on 2026-11-01; simultaneous behavior is exercised through production fixture ingress; real-channel acceptance remains separate.
