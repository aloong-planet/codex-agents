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
 */
export const processWaitLimitMs = 10_000;
