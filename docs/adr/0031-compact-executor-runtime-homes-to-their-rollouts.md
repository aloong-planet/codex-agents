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
