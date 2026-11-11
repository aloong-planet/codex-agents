# ADR-0031: Compact Executor runtime homes to their rollouts

- Status: Accepted (2026-11-08)

## Context

Each Executor runs in its own isolated runtime home ([ADR-0027](0027-bind-host-enforced-agent-profiles.md)), one per Assignment, and nothing removed a home when its runtime was released. After one Executor turn with one host-tool call, a home held 3,876 KiB in 18 files. Most of it was the App Server's uncheckpointed `state_5.sqlite-wal`; the thread rollout was 157 KiB. ADR-0027 keeps each Executor's own process and result as records of its Assignment, and the rollout is that process. A retry reruns a failed Assignment on its own thread, so whatever stays in the home must be enough to resume that thread. A failed request also waits for its requester's retry without any time limit, so the retry path of a failed Assignment never closes.

## Options

1. **Keep only the thread rollouts and remove everything else, as an allowlist. Compact a home whenever its runtime is released and its App Server process has exited, and sweep every Executor home at each start, before dispatch work runs.**
2. Delete homes by age. Rejected by the owner: it would delete records.
3. Leave homes as they are. Rejected by the owner.
4. Compact a home only after the last path that can rerun its Assignment has closed. Not adopted: a failed Assignment's retry path never closes, so the homes that matter most would keep their full size forever. The rollout is all any rerun path needs (Sources), so waiting protects nothing.
5. Checkpoint the App Server's write-ahead logs and delete nothing. Not adopted: it left 1,448 KiB of the 3,876 KiB home, against 160 KiB under option 1, and it keeps credentials and bookkeeping that nothing reads after the Assignment ends.
6. Remove a named list of known files and keep everything else (not recorded): implied by option 1's allowlist rather than compared. It would keep any file that a later Codex version adds.

## Decision

We adopt **option 1**.

- An Executor's runtime home keeps only `codex-home/sessions/` and `codex-home/archived_sessions/`, which hold the thread rollouts. Everything else goes: the App Server's databases, logs, locks and temporary files; the copied login, configuration and model catalog, which the host writes again whenever it creates a runtime; and the runtime's empty HOME and working directory. Files a later Codex version adds are removed as well.
- Compaction runs inside the runtime pool's close, after the App Server process has exited, so a new runtime on the same home, such as a retry's, waits for it. A process that does not exit within a bounded wait leaves its home to the next start.
- Each start sweeps every Executor home before dispatch work runs. This covers homes written before this decision, the homes of the earlier one-specialist dispatch, and homes whose compaction a crash cut off. Coordinator, Team Leader and group conversation homes are not covered by this decision.
- Nothing is removed unless the records are confirmed by file name: the rollout of the thread the Executor's session records, or, when no thread is recorded, at least one rollout. Rollouts are never opened, changed or removed. A home that fails the check, or whose removal fails, is kept and reported.
- Extending compaction to other runtime homes that can no longer be resumed is recorded by appending to this ADR.

## Consequences

- Positive:
  - An ended Assignment's home costs only its rollout on disk, and no copy of the model login stays behind in ended homes.
  - A retry resumes its own thread with its earlier process; the records ADR-0027 keeps are untouched.
- Negative:
  - Whether the rollout alone suffices is the App Server's behavior, not the service's. A Codex version that kept a thread only in its databases would let a retry silently start a fresh thread. The opt-in check on the installed App Server must be rerun after every Codex upgrade.
  - Anything else a runtime needs, such as a profile's skills, must be written again whenever its runtime is created, retries included.
  - The App Server's own logs of an ended Assignment are lost; diagnosis relies on the rollout and the service's diagnostics.
- Neutral: a kept home is reported again at every start until someone inspects it.

## Sources

- Measured on 2026-11-08 with `codex-cli 0.167.0-alpha.3.2`, the executable bundled with the ChatGPT app. The runtime was created and spawned as main.ts creates an Executor's, and model requests went to the loopback fake Responses endpoint of `apps/weixin-service/tests/fixtures/isolated-runtime-probe.ts`.
  - One turn with one host-tool call left 3,876 KiB in 18 files, including `state_5.sqlite-wal` at 2,515 KiB and the rollout at 157 KiB.
  - Six keep sets were each followed by a retry built as production builds it: a new runtime on the same home, `thread/resume` of the saved thread, and one more turn.
    - The full home, the checkpointed home and every set that kept `codex-home/sessions/` resumed the same thread, and the retry's model input carried the first turn's user text, tool output and answer.
    - With nothing kept, the App Server started a fresh thread and reported no error.
  - Checkpointing every write-ahead log without deleting anything left 1,448 KiB.
- `apps/weixin-service/tests/isolated-runtime-compaction.test.ts` (`pnpm --filter @aloong-planet/codex-weixin-service test:isolated-runtime`) repeats the resume check after compaction.
- Owner decision on 2026-11-08: keep the records and compact the rest, with no age-based deletion and ADR-0027 unchanged. Options 1, 4, 5 and the guard were decided by a delegate for the owner on the same day.
- [agent-dispatch spec](../specs/agent-dispatch.md): agent-dispatch::QR-002 and the Implementation Decision "Executor home compaction".

## Extension: superseded Team Leader homes (2026-11-11)

Recorded by appending, as the Decision provides. From this date the Decision's statement that Team Leader homes are not covered no longer holds. The homes of the Coordinator and of group conversations stay uncovered.

### Context

A Team Leader's session is keyed by leader, conversation, binding, access revision and definitions version. Each new revision or version therefore left another whole home for every team, each with the uncheckpointed write-ahead log measured above, and editing teams from the console creates a version at every save. Unlike an Executor's home, a Team Leader's is shared by every request its team takes in a conversation, and it is resumed for as long as such a request can run.

### Options

Which homes to compact:

1. **Compact a home once it is superseded: its definitions version is not the current one, and no stored request of that version is queued, running or waiting. Keep the homes of the current version whole.**
2. Also keep a home whole while a failed, partially failed or partially unassigned request could be retried on it. Not adopted, for the reason option 4 above was not: a retry never expires, so those homes would stay whole for ever, while a retry needs only the rollout.
3. Compact every Team Leader home at each release, like an Executor's (not recorded): implied by the choice of option 1 rather than compared. A Team Leader's runtime is released after every idle period and resumed by the next request, so its home would be rebuilt again and again.

When to sweep:

4. **At each start, when a Team Leader turn starts a session with none recorded, and at the release of a superseded home's runtime.**
5. At every save of the team definitions and of the permissions. Not adopted: it adds a hook to two stores that know nothing of runtime homes, and nothing accumulates between a save and the first turn under it, because only that turn creates new homes.

### Decision

We adopt **options 1 and 4**.

- A stored request keeps, for every team of its definitions version, the home of that team's session in its conversation and binding under the current access revision. It keeps them while it is queued, running or waiting, and for as long as its version is the current one. Every other Team Leader home is superseded and is compacted to the records above, after the same check.
- Sweeps run at each start, before dispatch work, and when a turn starts a session with none recorded. A superseded home whose runtime exists is compacted when that runtime has been released and its process has exited.
- No home is compacted while a runtime exists for it. A runtime is registered for its home before it is created, and finding a home superseded and removing its files is one uninterrupted step.

### Consequences

- Positive:
  - After a definitions or permission change, each team's earlier home costs only its rollouts, and no copy of the model login stays in it.
  - A request in flight across a definitions change keeps resuming a whole home.
- Negative:
  - A retry of a failed request, and any other request that returns to a compacted home, depends on the App Server resuming a thread from its rollout alone, as an Executor's retry does. The opt-in check on the installed App Server covers a Team Leader session too and is rerun after every Codex upgrade.
  - A home whose request ends with no further Team Leader turn stays whole until the next sweep.
- Neutral: the homes of the current version stay whole for every team and conversation that has used them. Their number is bounded by the teams times the conversations.

### Sources

- Decided by a delegate for the owner on 2026-11-11, on an enumeration of every path by which a Team Leader session resumes: one resume call, reached from the plan, supplement and closing turns, all of which run only for a request stored as queued.
- `apps/weixin-service/tests/isolated-runtime-compaction.test.ts` repeats the resume check for a compacted Team Leader session: the closing turn resumes the same thread, and its model input carries the plan turn.
- [agent-dispatch spec](../specs/agent-dispatch.md): agent-dispatch::QR-003 and the Implementation Decision "Team Leader home compaction".
