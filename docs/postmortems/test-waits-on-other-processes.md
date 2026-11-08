# Tests that raced other processes

Date: 2026-11-08 (agent-teams ticket 25; the reminder case from agent-teams ticket 06).

## Root causes

Several tests failed intermittently, or only in some environments. The same failures were re-proved as "pre-existing" on ticket after ticket.

- **Wall-clock bounds shorter than another process.** vitest's `expect.poll` and `vi.waitFor` give up after 1 s by default. Three waits used that default, or a product deadline, against a child that can take longer than a second to start on a loaded machine:
  - the research revocation case's ready marker;
  - the retirement notice, which the service sends after it reports idle;
  - the research timeout case, whose product deadline sometimes sent SIGTERM before the child had installed its handler, so `pid.json` never appeared.
- **A product deadline that could fall due before the step it had to follow.** The channel-startup case "keeps each specialist identity for files and scheduled reminders across restart" created reminders due 10 s into the case, meant to be delivered by the process started after a restart. The due time is wall-clock time in the service process. Under load, the requests before the restart took longer than 10 s, so the first process delivered the reminders, and the wait after the restart never ended. With the due time set to 3 s, the case failed the same way.
- **A build step only one entry point ran.** The diagnostics writer and the sandbox telemetry preload are built into `dist/`, and only the pnpm `pretest` hook built them for tests. A direct `vitest run` in a fresh checkout had no writer, so diagnostics dropped every record and the OTel-span cases found no span.
- **Platform errno.** On Darwin, `killpg` on a group whose members are all unreaped zombies fails with EPERM, not ESRCH. A teardown that tolerated only ESRCH failed a case whose assertions had all passed.
- **Waiting on the wrong signal.** One crash case killed the service as soon as a written file's content appeared. The file operation journal records completion 13–44 ms later, and the restart report reads the journal.
- **Exact text from a live model.** Two process-restart cases and one e2e case required exactly 「收到」. The live model often repeats the prompt's full stop.

## Why the existing checks did not catch them

- CI runs `pnpm test`, so the `pretest` hook always built `dist/` there.
- The waits passed whenever the machine was idle. They failed under full-suite load, and a rerun passed, so each failure was filed as pre-existing rather than diagnosed.
- The reminder case passed alone, in 11.4–12.2 s on both the ticket 06 branch and untouched master. It timed out once under the related-test load, then passed in one run of the same files on master and in the branch's next run, so it could not be reproduced on demand. Its waits already followed the process-wait rule; nothing stated a rule for a deadline that the case itself sets in product time.
- Nothing stated a rule for how long a test may wait for another process, or how to signal a process group.

## Defenses

- A vitest global setup (`apps/weixin-service/tests/support/build-test-artifacts.ts`) builds the artifacts however vitest is invoked. CI, which has no `dist/` at test time, now guards it.
- `apps/weixin-service/tests/support/process-wait.ts` explains the mechanism once and exports the shared bound. Every process wait found by a full enumeration of `expect.poll` and `vi.waitFor` now uses it.
- `apps/weixin-service/tests/support/process-group.ts` is the only place tests signal process groups.
- Two AGENTS.md invariants state both rules. The process-wait invariant also states that a wall-clock product deadline a case sets must not fall due before the step it must precede, and `process-wait.ts` explains why and how.
- The reminder case (fixed in f4ba537, merged in 7afcc8d) sets the due time 20 s ahead. Just before the restart it asserts that the due time is at least 2 s away, so the race fails with its reason rather than a timeout. With the due time set to 3 s, it failed at that assertion after 3.9 s. The wait after the restart is bounded by the time left plus `processWaitLimitMs`, and the case limit is 60 s.
- The crash case waits for the journal's completion record. The live-model cases accept only 「收到」 or 「收到。」, and also require the main model's own answer with no workflow result.

## Boundaries

- The invariants are kept by people, not by a gate. The rules that a product timer must not race a child's startup, and that a case's product deadline must not fall due before the step it must precede, cannot be found by a search.
- A deterministic test for the unconfirmed-file-work branch of the interruption report needs a product seam, which agent-teams ticket 26 owns.
- Node 26.13.0's denial of `FileHandle.sync()` is a product incompatibility recorded in the agent-dispatch spec's "Node runtime" decision, not a test defect.
- Evidence is in agent-teams ticket 25's local working records (`docs/.workings/agent-teams/ticket-25-test-report.md`) and, for the reminder case, ticket 06's (`docs/.workings/agent-teams/ticket-06-test-report.md`). They are not committed.
