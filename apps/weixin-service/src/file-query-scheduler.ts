type Waiter = { start(): void; cancel(): void };

/** One disk traversal batch at a time; continuations rejoin behind existing waiters. */
export class FileQueryScheduler {
  private active = false;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly maxQueued = 32, private readonly now = Date.now) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new Error("local_file_tools_config_invalid");
  }

  run<T>(signal: AbortSignal, maxWaitMs: number, operation: (waitMs: number) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("local_file_turn_unavailable"));
    if (maxWaitMs <= 0) return Promise.reject(new Error("local_file_query_queue_timeout"));
    if (this.active && this.waiting.length >= this.maxQueued) return Promise.reject(new Error("local_file_query_queue_full"));
    const enqueuedAt = this.now();
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined = undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", waiter.cancel);
      };
      const remove = (code: string) => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        cleanup();
        reject(new Error(code));
      };
      const waiter: Waiter = {
        cancel: () => remove("local_file_turn_unavailable"),
        start: () => {
          cleanup();
          if (signal.aborted) { reject(new Error("local_file_turn_unavailable")); this.advance(); return; }
          const waited = Math.max(0, this.now() - enqueuedAt);
          if (waited >= maxWaitMs) { reject(new Error("local_file_query_queue_timeout")); this.advance(); return; }
          this.active = true;
          let result: Promise<T>;
          try { result = operation(waited); }
          catch (error) { this.advance(); reject(error); return; }
          void result.then(
            (value) => { this.advance(); resolve(value); },
            (error: unknown) => { this.advance(); reject(error); },
          );
        },
      };
      if (!this.active) { waiter.start(); return; }
      this.waiting.push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
      timer = setTimeout(() => remove("local_file_query_queue_timeout"), maxWaitMs);
      timer.unref();
    });
  }

  private advance(): void {
    this.active = false;
    this.waiting.shift()?.start();
  }
}
