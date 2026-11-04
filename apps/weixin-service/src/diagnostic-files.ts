import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DiagnosticFileOptions } from "./diagnostic-file-store.js";
export { diagnosticFileList } from "./diagnostic-file-store.js";
export type { DiagnosticFileOptions } from "./diagnostic-file-store.js";

type Signal = "traces" | "checkpoints" | "metrics";
type Entry = { signal: Signal; line: string };
type Health = { failures: number; dropped: number; removed: number; queued: number };

/** Lossy diagnostics only. Business journals must never use this transport. */
export class DiagnosticFiles {
  private child?: ChildProcess;
  private queue: Entry[] = [];
  private inFlight = 0;
  private busy = false;
  private failed = false;
  private closed = false;
  private dropped = 0;
  private failures = 0;
  private health: Health = { failures: 0, dropped: 0, removed: 0, queued: 0 };
  private drain: (() => void) | undefined;
  private draining: Promise<void> | undefined;
  private closing?: Promise<void>;
  private pending: (() => void) | undefined;
  private deadline?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly directory: string, private readonly options: DiagnosticFileOptions = {}) {
    try {
      this.child = fork(fileURLToPath(new URL("../dist/diagnostic-writer.cjs", import.meta.url)), [], {
        execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], env: {},
      });
      this.child.on("error", () => this.fail());
      this.child.on("exit", () => { if (!this.closed || this.busy) this.fail(); });
      this.child.on("message", (message: { health: Health }) => {
        if (!this.busy || this.failed) return;
        this.health = message.health;
        this.busy = false;
        this.inFlight = 0;
        clearTimeout(this.deadline);
        const resolve = this.pending;
        this.pending = undefined;
        resolve?.();
        this.schedule();
      });
      const limits = { ...options };
      delete limits.now;
      void this.request({ type: "init", directory, options: limits, now: options.now?.() });
    } catch { this.fail(); }
    this.timer = setInterval(() => { void this.maintain(); }, 3_600_000);
    this.timer.unref();
  }

  append(signal: Signal, record: unknown, priority: "normal" | "background" = "normal"): void {
    const capacity = this.limit("maxQueuedRecords", 256);
    const reserved = Math.min(64, Math.max(1, Math.floor(capacity / 4)));
    if (this.closed || this.failed || this.queue.length + this.inFlight >= (priority === "background" ? capacity - reserved : capacity)) {
      this.dropped++; return;
    }
    try {
      const json = JSON.stringify(record);
      if (json === undefined) { this.dropped++; return; }
      const line = json + "\n";
      if (Buffer.byteLength(line) > Math.min(this.limit("maxRecordBytes", 65_536), this.limit("maxFileBytes", 20 * 1024 ** 2))) {
        this.dropped++; return;
      }
      this.queue.push({ signal, line });
      this.schedule();
    } catch { this.dropped++; }
  }

  stats() { return { ...this.health, failures: this.health.failures + this.failures,
    dropped: this.health.dropped + this.dropped, queued: this.queue.length + this.inFlight, writerPid: this.child?.pid }; }

  async flush(): Promise<void> {
    if (this.failed) return;
    if (!this.draining) {
      this.draining = new Promise<void>((resolve) => { this.drain = resolve; });
      this.schedule();
    }
    const timeout = setTimeout(() => this.fail(), 5000);
    try { await this.draining; } finally { clearTimeout(timeout); }
  }

  async maintain(): Promise<void> {
    if (this.closed || this.failed) return;
    await this.flush();
    if (!this.busy && !this.closed) await this.request({ type: "maintain", now: this.options.now?.() });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      clearInterval(this.timer);
      const timeout = setTimeout(() => this.fail(), 5000);
      try {
        await this.flush();
        await this.request({ type: "close", now: this.options.now?.() });
      } finally { clearTimeout(timeout); this.child?.kill("SIGKILL"); }
    })();
  }

  private limit(key: keyof Omit<DiagnosticFileOptions, "now">, fallback: number): number {
    const value = this.options[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.pump(); });
  }

  private pump(): void {
    if (this.busy || this.failed) return;
    if (this.queue.length) {
      const entries = this.queue.splice(0, 32);
      this.inFlight = entries.length;
      void this.request({ type: "append", entries, now: this.options.now?.() });
    } else {
      const resolve = this.drain;
      this.drain = undefined; this.draining = undefined;
      resolve?.();
    }
  }

  private request(message: object): Promise<void> {
    if (this.failed) return Promise.resolve();
    this.busy = true;
    return new Promise<void>((resolve) => {
      this.pending = resolve;
      this.deadline = setTimeout(() => this.fail(), 5000);
      try {
        this.child!.send(message, (error) => { if (error) this.fail(); });
      } catch { this.fail(); }
    });
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true; this.failures++;
    this.dropped += this.queue.length + this.inFlight;
    this.queue = []; this.inFlight = 0; this.busy = false;
    clearTimeout(this.deadline);
    this.child?.kill("SIGKILL");
    this.pending?.(); this.pending = undefined;
    this.drain?.(); this.drain = undefined; this.draining = undefined;
  }
}
