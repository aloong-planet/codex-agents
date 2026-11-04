import { expect, it, vi } from "vitest";
import { FileQueryScheduler } from "../src/file-query-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
it("bounds queued batches, removes cancelled waiters and reuses capacity", async () => {
  const queue = new FileQueryScheduler(1);
  const active = deferred();
  const first = queue.run(new AbortController().signal, 1000, () => active.promise);
  const cancelled = new AbortController();
  const neverStart = vi.fn(async () => {});
  const second = queue.run(cancelled.signal, 1000, neverStart);
  const rejected = expect(second).rejects.toThrow("local_file_turn_unavailable");
  await expect(queue.run(new AbortController().signal, 1000, neverStart)).rejects.toThrow("local_file_query_queue_full");
  cancelled.abort(); await rejected;
  const thirdStart = vi.fn(async () => "third");
  const third = queue.run(new AbortController().signal, 1000, thirdStart);
  active.resolve(); await first;
  await expect(third).resolves.toBe("third");
  expect(neverStart).not.toHaveBeenCalled(); expect(thirdStart).toHaveBeenCalledOnce();
});
it("expires waiting independently and releases admission on failed work", async () => {
  vi.useFakeTimers();
  try {
    const queue = new FileQueryScheduler(); const active = deferred();
    const first = queue.run(new AbortController().signal, 1000, () => active.promise);
    const callback = vi.fn(async () => "expired");
    const waiting = queue.run(new AbortController().signal, 30, callback);
    const rejected = expect(waiting).rejects.toThrow("local_file_query_queue_timeout");
    await vi.advanceTimersByTimeAsync(30); await rejected;
    active.resolve(); await first;
    expect(callback).not.toHaveBeenCalled();
    await expect(queue.run(new AbortController().signal, 1000, async () => { throw new Error("worker-failed"); })).rejects.toThrow("worker-failed");
    await expect(queue.run(new AbortController().signal, 1000, async () => "recovered")).resolves.toBe("recovered");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("rejects expired admission at dispatch even if its timer has not run", async () => {
  let clock = 0; const queue = new FileQueryScheduler(2, () => clock); const active = deferred();
  const first = queue.run(new AbortController().signal, 1000, () => active.promise);
  const callback = vi.fn(async () => "expired");
  const second = queue.run(new AbortController().signal, 20, callback);
  const rejected = expect(second).rejects.toThrow("local_file_query_queue_timeout");
  clock = 20; active.resolve(); await first; await rejected;
  expect(callback).not.toHaveBeenCalled();
  await expect(queue.run(new AbortController().signal, 1000, async () => "next")).resolves.toBe("next");
});
