import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimePool } from "../src/runtime-pool.js";

// The pool is tested at its public interface (agent-dispatch Testing Decisions: concurrency limit, idle release and resume).
// Gaps:
// - main.ts puts the coordinator's classifier runtime into the same pool, but fixture mode replaces the classifier, so that
//   wiring is exercised only by a live coordinator run.
// - main.ts passes the default limits (16 runtimes, 5 idle minutes) to the pool; no fixture case fills 16 slots or lives
//   5 minutes. Re-test condition: a live run or a fixture case that fills the pool. The values themselves are asserted in
//   agent-dispatch-executor.test.ts.
// - Executors pass releaseWhenDone; the release at the end of an Assignment is tested in agent-dispatch-executor.test.ts.
// - Nested waits (a Team Leader holding a slot while it waits for an Executor) are tested in agent-dispatch.test.ts.

type FakeRuntime = { key: string; closed: boolean; close: () => Promise<void> };

function harness(limit: number, idleMs = 60_000) {
  const created: FakeRuntime[] = [];
  let live = 0, maxLive = 0;
  const closeGates = new Map<string, Promise<void>>();
  const pool = new RuntimePool<FakeRuntime>({ limit, idleMs, close: (runtime) => runtime.close() });
  const create = (key: string) => () => {
    live += 1; maxLive = Math.max(maxLive, live);
    const runtime: FakeRuntime = { key, closed: false, close: async () => {
      await closeGates.get(key);
      runtime.closed = true; live -= 1;
    } };
    created.push(runtime);
    return runtime;
  };
  return { pool, create, created, closeGates, live: () => live, maxLive: () => maxLive };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("lets work beyond the limit wait for a slot and runs every piece of work", async () => {
  const { pool, create, created, maxLive } = harness(2);
  const gates = { a: deferred(), b: deferred(), c: deferred() };
  const results = (["a", "b", "c"] as const).map((key) => pool.use(key, create(key), async () => { await gates[key].promise; return `${key}-done`; }));
  await settle();
  expect(created.map(({ key }) => key)).toEqual(["a", "b"]);
  gates.a.resolve();
  await settle();
  expect(created.map(({ key }) => key)).toEqual(["a", "b", "c"]);
  gates.b.resolve(); gates.c.resolve();
  await expect(Promise.all(results)).resolves.toEqual(["a-done", "b-done", "c-done"]);
  expect(maxLive()).toBe(2);
});

it("shares one runtime among concurrent work on the same key, running the work at once and counting the runtime once", async () => {
  const { pool, create, created } = harness(2);
  const first = deferred(), second = deferred();
  const started: string[] = [];
  const shared = [
    pool.use("s", create("s"), async () => { started.push("first"); await first.promise; }),
    pool.use("s", create("s"), async () => { started.push("second"); await second.promise; }),
  ];
  await settle();
  expect(started).toEqual(["first", "second"]);
  const other = pool.use("t", create("t"), async () => "t-done");
  await settle();
  expect(created.map(({ key }) => key)).toEqual(["s", "t"]);
  await expect(other).resolves.toBe("t-done");
  first.resolve(); second.resolve();
  await Promise.all(shared);
});

it("keeps a shared runtime in use until the last of its work ends", async () => {
  const { pool, create, created } = harness(1);
  const first = deferred(), second = deferred();
  const shared = [pool.use("s", create("s"), () => first.promise), pool.use("s", create("s"), () => second.promise)];
  const other = pool.use("t", create("t"), async () => "t-done");
  await settle();
  first.resolve();
  await settle();
  expect(created.map(({ key, closed }) => [key, closed])).toEqual([["s", false]]);
  second.resolve();
  await expect(Promise.all(shared)).resolves.toEqual([undefined, undefined]);
  await expect(other).resolves.toBe("t-done");
  expect(created.map(({ key, closed }) => [key, closed])).toEqual([["s", true], ["t", false]]);
});

it("releases the least recently used idle runtime, not the oldest, for waiting work before the idle limit", async () => {
  const { pool, create, created, closeGates, maxLive } = harness(2);
  await pool.use("a", create("a"), async () => {});
  await pool.use("b", create("b"), async () => {});
  await pool.use("a", create("a"), async () => {});
  const closing = deferred();
  closeGates.set("b", closing.promise);
  const waiting = pool.use("c", create("c"), async () => "c-done");
  await settle();
  expect(created.map(({ key, closed }) => [key, closed])).toEqual([["a", false], ["b", false]]);
  closing.resolve();
  await expect(waiting).resolves.toBe("c-done");
  expect(created.map(({ key, closed }) => [key, closed])).toEqual([["a", false], ["b", true], ["c", false]]);
  expect(maxLive()).toBe(2);
});

it("makes work that arrives while its key's runtime is closing wait for the close and run on a new runtime", async () => {
  const { pool, create, created, closeGates } = harness(2, 1000);
  await pool.use("a", create("a"), async () => {});
  const closing = deferred();
  closeGates.set("a", closing.promise);
  await vi.advanceTimersByTimeAsync(1000);
  const used: FakeRuntime[] = [];
  const again = pool.use("a", create("a"), async (runtime) => { used.push(runtime); return "a-again"; });
  await settle();
  expect(created).toHaveLength(1);
  closeGates.delete("a");
  closing.resolve();
  await expect(again).resolves.toBe("a-again");
  expect(created).toHaveLength(2);
  expect(used).toEqual([created[1]]);
  expect(created[0]!.closed).toBe(true);
});

it("releases an idle runtime after the idle limit, counted from the end of its last work, and creates it again when needed", async () => {
  const { pool, create, created } = harness(2, 1000);
  const busy = deferred();
  const running = pool.use("a", create("a"), () => busy.promise);
  await vi.advanceTimersByTimeAsync(1500);
  expect(created[0]!.closed).toBe(false);
  busy.resolve(); await running;
  await vi.advanceTimersByTimeAsync(999);
  expect(created[0]!.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(created[0]!.closed).toBe(true);
  await pool.use("a", create("a"), async () => {});
  expect(created.map(({ key }) => key)).toEqual(["a", "a"]);
});

it("closes the runtime as soon as work that asks for release at its end finishes", async () => {
  const { pool, create, created } = harness(2);
  await expect(pool.use("executor", create("executor"), async () => "result", { releaseWhenDone: true })).resolves.toBe("result");
  await settle();
  expect(created.map(({ key, closed }) => [key, closed])).toEqual([["executor", true]]);
});

it("ends the wait of cancelled work, which then never gets a runtime", async () => {
  const { pool, create, created } = harness(1);
  const busy = deferred();
  const running = pool.use("a", create("a"), () => busy.promise);
  const abort = new AbortController();
  const cancelled = pool.use("b", create("b"), async () => "b-done", { signal: abort.signal });
  await settle();
  abort.abort(new Error("dispatch_cancelled"));
  await expect(cancelled).rejects.toThrow("dispatch_cancelled");
  busy.resolve(); await running;
  await settle();
  expect(created.map(({ key }) => key)).toEqual(["a"]);
});

it("ends waiting work and closes every runtime when the pool closes", async () => {
  const { pool, create, created } = harness(1);
  const busy = deferred();
  const running = pool.use("a", create("a"), () => busy.promise);
  const waiting = pool.use("b", create("b"), async () => "b-done");
  await settle();
  await pool.close();
  await expect(waiting).rejects.toThrow("runtime_pool_closed");
  expect(created.map(({ key, closed }) => [key, closed])).toEqual([["a", true]]);
  await expect(pool.use("c", create("c"), async () => "c-done")).rejects.toThrow("runtime_pool_closed");
  busy.resolve(); await running;
});

it("keeps no slot for a runtime that failed to be created or to close", async () => {
  const { pool, create, created, closeGates } = harness(1, 1000);
  await expect(pool.use("broken", () => { throw new Error("dispatch_group_unbound"); }, async () => "never")).rejects.toThrow("dispatch_group_unbound");
  await expect(pool.use("a", create("a"), async () => "a-done")).resolves.toBe("a-done");
  const failedClose = Promise.reject(new Error("close_failed"));
  failedClose.catch(() => {});
  closeGates.set("a", failedClose);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pool.use("b", create("b"), async () => "b-done")).resolves.toBe("b-done");
  expect(created.map(({ key }) => key)).toEqual(["a", "b"]);
});
