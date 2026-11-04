import crypto from "node:crypto";
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

type Signal = "traces" | "checkpoints" | "metrics";
type Segment = { name: string; handle: FileHandle; bytes: number; hour: number };
export type DiagnosticFileOptions = { now?: () => number; maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number; retentionMs?: number; maxQueuedRecords?: number; maxRecordBytes?: number };

/** Private, serialized file sink. Its own I/O must not generate telemetry recursively. */
export class DiagnosticFileStore {
  private readonly instance = crypto.randomUUID();
  private readonly active = new Map<Signal, Segment>();
  private sequence = 0;
  private inventoryDirty = false;
  private inventory: Awaited<ReturnType<typeof diagnosticFileList>> = [];
  private tail: Promise<void>;
  private closed = false;
  private failures = 0;
  private canonicalDirectory: string | undefined;
  private dropped = 0;
  private removed = 0;
  private queued = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly directory: string, private readonly options: DiagnosticFileOptions = {}) {
    this.tail = context.with(suppressTracing(context.active()), () => this.prepare().then(() => this.reconcile()).catch(() => { this.inventoryDirty = true; this.failures += 1; }));
    this.timer = setInterval(() => { void this.maintain(); }, 3_600_000);
    this.timer.unref();
  }

  append(signal: Signal, record: unknown, priority: "normal" | "background" = "normal"): void {
    if (this.closed) { this.dropped += 1; return; }
    let line: string;
    try {
      const json = JSON.stringify(record);
      if (json === undefined) { this.dropped += 1; return; }
      line = `${json}\n`;
    } catch { this.dropped += 1; return; }
    this.appendLines(signal, line, 1, priority);
  }

  /** Trusted encoded JSONL from the bounded transport; records retain their individual lines. */
  appendLines(signal: Signal, line: string, count: number, priority: "normal" | "background" = "normal"): void {
    if (this.closed) { this.dropped += count; return; }
    const bytes = Buffer.byteLength(line);
    if (bytes > this.limit("maxRecordBytes", 65_536) || bytes > this.limit("maxFileBytes", 20 * 1024 ** 2)) { this.dropped += count; return; }
    this.enqueue(async () => {
      await this.prepare();
      if (this.inventoryDirty) await this.reconcile();
      await this.sealIdle();
      let segment = this.active.get(signal);
      if (segment && segment.bytes + bytes > this.limit("maxFileBytes", 20 * 1024 ** 2)) {
        await this.seal(signal, segment);
        segment = undefined;
        await this.reconcile();
      }
      await this.cleanup(bytes, segment ? 0 : 1);
      if (!segment) {
        const now = this.now();
        const name = `${signal}-${now}-${process.pid}-${this.instance}-${++this.sequence}-open.jsonl`;
        const handle = await fs.open(path.join(this.directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        segment = { name, handle, bytes: 0, hour: Math.floor(now / 3_600_000) };
        this.active.set(signal, segment);
        this.inventory.push({ name, bytes: 0, sealedAt: 0 });
      }
      await segment.handle.writeFile(line, "utf8");
      segment.bytes += bytes;
      this.inventory.find((file) => file.name === segment.name)!.bytes = segment.bytes;
    }, priority, count);
  }

  async flush(): Promise<void> { await this.tail; }
  async maintain(): Promise<void> {
    if (this.closed) return;
    this.enqueue(async () => { await this.prepare(); await this.sealIdle(); await this.reconcile(); });
    await this.tail;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.tail;
    for (const [signal, segment] of this.active) {
      try { await this.seal(signal, segment); } catch { this.failures += 1; }
    }
    try { await this.cleanup(); } catch { this.failures += 1; }
  }

  stats() { return { failures: this.failures, dropped: this.dropped, removed: this.removed, queued: this.queued }; }

  private now() { return this.options.now?.() ?? Date.now(); }
  private limit(key: keyof Omit<DiagnosticFileOptions, "now">, fallback: number): number {
    const value = this.options[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private enqueue(action: () => Promise<void>, priority: "normal" | "background" = "normal", count = 1) {
    const capacity = this.limit("maxQueuedRecords", 256);
    const reserved = Math.min(64, Math.max(1, Math.floor(capacity / 4)));
    if (this.queued + count > (priority === "background" ? capacity - reserved : capacity)) { this.dropped += count; return; }
    this.queued += count;
    this.tail = this.tail.then(() => context.with(suppressTracing(context.active()), action)).catch(() => { this.inventoryDirty = true; this.failures += 1; this.dropped += count; }).finally(() => { this.queued -= count; });
  }

  private async seal(signal: Signal, segment: Segment) {
    this.active.delete(signal);
    try { await segment.handle.sync(); } finally { await segment.handle.close(); }
    const sealedAt = this.now();
    const name = segment.name.replace("open.jsonl", `${sealedAt}.jsonl`);
    await fs.rename(path.join(this.directory, segment.name), path.join(this.directory, name));
    const file = this.inventory.find((file) => file.name === segment.name);
    if (file) { file.name = name; file.sealedAt = sealedAt; }
  }

  private async sealIdle() {
    for (const [signal, segment] of this.active) {
      if (segment.hour !== Math.floor(this.now() / 3_600_000)) await this.seal(signal, segment);
    }
  }

  private async reconcile() {
    this.inventory = await diagnosticFileList(this.directory);
    for (const segment of this.active.values()) {
      const info = await segment.handle.stat();
      segment.bytes = info.size;
      const file = this.inventory.find((entry) => entry.name === segment.name);
      if (file) file.bytes = info.size;
    }
    await this.cleanup();
    this.inventoryDirty = false;
  }

  private async cleanup(extraBytes = 0, extraFiles = 0) {
    const files = this.inventory;
    let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    let count = files.length;
    const now = this.now();
    for (const file of files.sort((a, b) => a.sealedAt - b.sealedAt)) {
      if (!file.sealedAt) continue;
      if (file.sealedAt + this.limit("retentionMs", 7 * 86_400_000) >= now &&
          bytes + extraBytes <= this.limit("maxTotalBytes", 200 * 1024 ** 2) &&
          count + extraFiles <= this.limit("maxFiles", 512)) continue;
      await fs.unlink(path.join(this.directory, file.name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      this.inventory = this.inventory.filter((item) => item.name !== file.name);
      bytes -= file.bytes;
      count -= 1;
      this.removed += 1;
    }
    if (bytes + extraBytes > this.limit("maxTotalBytes", 200 * 1024 ** 2) || count + extraFiles > this.limit("maxFiles", 512)) throw new Error("diagnostic_capacity_exceeded");
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    const canonical = await fs.realpath(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (this.canonicalDirectory && this.canonicalDirectory !== canonical)) throw new Error("diagnostic_directory_invalid");
    this.canonicalDirectory = canonical;
    await fs.chmod(this.directory, 0o700);
  }
}

const OWN_FILE = /^(traces|checkpoints|metrics)-(\d{13})-(\d+)-([a-f0-9-]{36})-(\d+)-(open|\d{13})\.jsonl$/u;

export async function diagnosticFileList(directory: string) {
  const files: Array<{ name: string; bytes: number; sealedAt: number }> = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const match = OWN_FILE.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const info = await fs.lstat(path.join(directory, entry.name));
    if (!info.isFile() || info.isSymbolicLink()) continue;
    let sealedAt = match[6] === "open" ? 0 : Number(match[6]);
    // An orphan is eligible only when its writer process is known to have exited.
    if (!sealedAt && Number(match[3]) !== process.pid) {
      try { process.kill(Number(match[3]), 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") sealedAt = info.mtimeMs;
      }
    }
    files.push({ name: entry.name, bytes: info.size, sealedAt });
  }
  return files;
}
