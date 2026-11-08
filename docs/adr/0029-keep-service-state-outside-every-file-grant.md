# ADR-0029: Keep service state outside every file grant

- Status: Accepted (2026-11-08)

## Context

[ADR-0023](0023-isolate-feishu-group-authority.md) excluded service and personal model state from the business file grants that group members use, and left the owner's private chats with their existing data semantics. Only group targets received the protected set, so a private file turn under a grant that covers the state directory could write anywhere in it. That includes the skill directories of every isolated runtime (`workspace/.agents/skills`, `codex-home/skills`, `home/.agents/skills`), which every later group request loads. A private turn could do this at the owner's request or on instructions injected into content it was processing, such as a document or web page. Ticket 22 found the gap by reading the code. The fixture route and the installed App Server have since confirmed it: a planted skill was listed by the runtime.

## Options

1. **One protected set, refused to every target.** The state directory, channel and Penny configuration, the private Codex home, diagnostics, `~/.agents`, `~/.openclaw` and the LaunchAgent files are outside every grant, for reads as well as writes.
2. Treat a private write as owner authority — rejected: injected content in a private chat would then reach every group runtime, and the owner could not tell an injected write from one they asked for.
3. Refuse writes only and keep private reads — rejected: group targets already refuse reads, and a read of the Codex home exposes the login every isolated runtime copies. No existing private flow reads these paths through file tools.
4. A separate, smaller set for private targets — rejected: no grant reaches the additional members today, and a second list would be one more place to forget a new member.
5. Keep the fixture business files inside the state directory and exempt them inside the sandbox — rejected: it adds an allow path to security-critical code. The fixture instead keeps its business files beside the state directory, as production does.

## Decision

We adopt **option 1**, specified as [workflow-runs::CON-003](../specs/workflow-runs.md). `LocalFileTools` requires the protected set at construction and applies it to every target. `main.ts` builds the set from the environment. Find and grep omit its members, and writes, reads and send snapshots that resolve into it are refused with `local_file_permission_denied`. Only the service's own code writes beneath the state directory.

## Consequences

- Positive: nothing outside the service's own code can change what an isolated runtime loads, so the skill library and agent profiles ([ADR-0027](0027-bind-host-enforced-agent-profiles.md)) can rely on runtime contents being service-placed.
- Positive: one set and one error code for every target; a missing set fails closed instead of meaning "nothing protected".
- Negative: the owner cannot read or edit the Codex home, `~/.agents` or the service's state and configuration from a chat, even under a grant that covers them. Those changes are made locally.
- Neutral: no production grant definition reaches the set today (the vault, `~/Downloads`, `~/Pictures`, `~/Documents`), so current behavior does not change. The boundary guards against environment overrides and future grant types.
- Neutral: the private main agent's native workspace write guard is a separate, owner-enabled path and is not covered by this decision.

## Sources

- [Workflow runs specification](../specs/workflow-runs.md), workflow-runs::CON-003.
- [Channel specification](../specs/channel-switching.md), channel-switching::US-006/AC-02; [agent dispatch specification](../specs/agent-dispatch.md), agent-dispatch::REQ-016/AC-04.
- Dispatcher decisions on the owner's delegation, 2026-11-08: one shared set including the Codex home, reads refused, fixture business files moved out of the state directory.
- Reproduction on 4ec653b before the fix: a private fixture turn's `files.write` of `SKILL.md` into a group runtime's three skill roots succeeded, and the installed Codex App Server (codex-cli 0.167.0-alpha.3.2) then listed the planted skill from each root.
