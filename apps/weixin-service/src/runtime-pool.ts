/**
 * A bounded set of isolated model runtimes (agent-dispatch::QR-001). A runtime counts toward the limit from its
 * creation until its close settles, whether it is idle or busy. Work that needs a new runtime at the limit waits;
 * the least recently used idle runtime is released for it, so waiting work never waits for an idle timer.
 */
type Entry<R> = { runtime: R; users: number; lastUsed: number; releaseWhenIdle: boolean; idleTimer?: ReturnType<typeof setTimeout>; closing?: Promise<void> };
type Waiter<R> = { key: string; create(): R; grant(entry: Entry<R>): void; reject(error: unknown): void };

export class RuntimePool<R> {
  private readonly entries = new Map<string, Entry<R>>();
  private readonly waiters: Array<Waiter<R>> = [];
  private sequence = 0;
  private closed: Promise<void> | undefined;

  constructor(private readonly options: { limit: number; idleMs: number; close(runtime: R): Promise<void> | void }) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("runtime_pool_limit_invalid");
  }

  /**
   * Runs work on the runtime for key, creating it when absent. Concurrent work on one key shares its runtime.
   * An idle runtime is released after the idle limit; releaseWhenDone releases it as soon as its work ends.
   * Aborting the signal ends a wait for a slot; it does not interrupt work that already holds a runtime.
   */
  async use<T>(key: string, create: () => R, work: (runtime: R) => Promise<T>,
    options: { releaseWhenDone?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const { signal } = options;
    const entry = await new Promise<Entry<R>>((resolve, reject) => {
      if (this.closed) { reject(new Error("runtime_pool_closed")); return; }
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(signal!.reason);
        this.pump();
      };
      const waiter: Waiter<R> = { key, create,
        grant: (granted) => { signal?.removeEventListener("abort", abort); resolve(granted); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); } };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
    if (options.releaseWhenDone) entry.releaseWhenIdle = true;
    try { return await work(entry.runtime); }
    finally { this.release(key, entry); }
  }

  /** Ends every wait and closes every runtime, busy or idle; later work is refused. */
  close(): Promise<void> {
    this.closed ??= (async () => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("runtime_pool_closed"));
      await Promise.allSettled([...this.entries].map(([key, entry]) => this.retire(key, entry)));
    })();
    return this.closed;
  }

  private release(key: string, entry: Entry<R>): void {
    entry.users -= 1;
    entry.lastUsed = ++this.sequence;
    if (entry.users === 0 && !entry.closing) {
      if (entry.releaseWhenIdle) void this.retire(key, entry);
      else {
        entry.idleTimer = setTimeout(() => { if (entry.users === 0) void this.retire(key, entry); }, this.options.idleMs);
        entry.idleTimer.unref?.();
      }
    }
    this.pump();
  }

  private pump(): void {
    let blocked = 0;
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      const existing = this.entries.get(waiter.key);
      if (existing && !existing.closing) {
        this.waiters.splice(index, 1);
        existing.users += 1;
        clearTimeout(existing.idleTimer);
        waiter.grant(existing);
        continue;
      }
      // Waiters needing a new slot are served in arrival order; later ones may still share an existing runtime.
      if (existing || blocked > 0 || this.entries.size >= this.options.limit) {
        if (!existing) blocked += 1;
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      let entry: Entry<R>;
      try { entry = { runtime: waiter.create(), users: 1, lastUsed: 0, releaseWhenIdle: false }; }
      catch (error) { waiter.reject(error); continue; }
      this.entries.set(waiter.key, entry);
      waiter.grant(entry);
    }
    const closing = [...this.entries.values()].filter((entry) => entry.closing).length;
    for (let needed = blocked - closing; needed > 0; needed -= 1) {
      const idle = [...this.entries.entries()].filter(([, entry]) => !entry.closing && entry.users === 0)
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
      if (!idle) break;
      void this.retire(idle[0], idle[1]);
    }
  }

  private retire(key: string, entry: Entry<R>): Promise<void> {
    clearTimeout(entry.idleTimer);
    entry.closing ??= Promise.resolve().then(() => this.options.close(entry.runtime)).catch(() => {}).finally(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.pump();
    });
    return entry.closing;
  }
}
