# Tests that raced other processes

Date: 2026-11-08 (agent-teams ticket 25).

## Root causes

Several tests failed intermittently, or only in some environments. The same failures were re-proved as "pre-existing" on ticket after ticket.

- **Wall-clock bounds shorter than another process.** vitest's `expect.poll` and `vi.waitFor` give up after 1 s by default. Three waits used that default, or a product deadline, against a child that can take longer than a second to start on a loaded machine:
  - the research revocation case's ready marker;
  - the retirement notice, which the service sends after it reports idle;
  - the research timeout case, whose product deadline sometimes sent SIGTERM before the child had installed its handler, so `pid.json` never appeared.
- **A build step only one entry point ran.** The diagnostics writer and the sandbox telemetry preload are built into `dist/`, and only the pnpm `pretest` hook built them for tests. A direct `vitest run` in a fresh checkout had no writer, so diagnostics dropped every record and the OTel-span cases found no span.
- **Platform errno.** On Darwin, `killpg` on a group whose members are all unreaped zombies fails with EPERM, not ESRCH. A teardown that tolerated only ESRCH failed a case whose assertions had all passed.
- **Waiting on the wrong signal.** One crash case killed the service as soon as a written file's content appeared. The file operation journal records completion 13–44 ms later, and the restart report reads the journal.
- **Exact text from a live model.** Two process-restart cases and one e2e case required exactly 「收到」. The live model often repeats the prompt's full stop.

## Why the existing checks did not catch them

- CI runs `pnpm test`, so the `pretest` hook always built `dist/` there.
- The waits passed whenever the machine was idle. They failed under full-suite load, and a rerun passed, so each failure was filed as pre-existing rather than diagnosed.
- Nothing stated a rule for how long a test may wait for another process, or how to signal a process group.

## Defenses

- A vitest global setup (`apps/weixin-service/tests/support/build-test-artifacts.ts`) builds the artifacts however vitest is invoked. CI, which has no `dist/` at test time, now guards it.
- `apps/weixin-service/tests/support/process-wait.ts` explains the mechanism once and exports the shared bound. Every process wait found by a full enumeration of `expect.poll` and `vi.waitFor` now uses it.
- `apps/weixin-service/tests/support/process-group.ts` is the only place tests signal process groups.
- Two AGENTS.md invariants state both rules.
- The crash case waits for the journal's completion record. The live-model cases accept only 「收到」 or 「收到。」, and also require the main model's own answer with no workflow result.

## Boundaries

- The invariants are kept by people, not by a gate. The rule that a product timer must not race a child's startup cannot be found by a search.
- A deterministic test for the unconfirmed-file-work branch of the interruption report needs a product seam, which agent-teams ticket 26 owns.
- Node 26.13.0's denial of `FileHandle.sync()` is a product incompatibility recorded in the agent-dispatch spec's "Node runtime" decision, not a test defect.
- Evidence is in agent-teams ticket 25's local working records (`docs/.workings/agent-teams/ticket-25-test-report.md`), which are not committed.
