/**
 * Waiting on another process: a child, a worker or a service.
 *
 * vitest's `expect.poll` and `vi.waitFor` give up after 1 s unless given a `timeout`. Another process
 * can take longer than that to start, stop or report on a loaded machine, as in the full suite, so a
 * correct case then fails. A wait whose condition another process makes true is therefore bounded by
 * `processWaitLimitMs`. A case whose own limit is shorter is bounded by that limit instead, because
 * vitest's test timeout fires first.
 *
 * For the same reason, a case must not let a product timer that starts when a child is spawned run
 * while that child is still starting: on a loaded machine the timer fires first and the case tests a
 * child that never got going. Hold the timer with fake timers (fake only `setTimeout`/`clearTimeout`;
 * `expect.poll` keeps vitest's real timers), wait for the child to report it is ready, then advance.
 *
 * Likewise, a case must not let a wall-clock product deadline it sets, such as a reminder's due time,
 * fall due before the step it must precede, such as a restart. The deadline runs in another process,
 * so fake timers in the case cannot hold it, and on a loaded machine the steps before it take longer:
 * the product acts early and the case then waits for something that already happened. Set the deadline
 * with a wide margin, assert just before that step that it is still ahead, so the race fails with its
 * reason rather than a timeout, and bound the wait after the step by the time left plus
 * `processWaitLimitMs`. docs/postmortems/test-waits-on-other-processes.md records the cases behind
 * these rules.
 */
export const processWaitLimitMs = 10_000;
