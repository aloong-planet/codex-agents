import fs from "node:fs";
import path from "node:path";

/** Tail only this isolated case's checkpoints; metrics and HTTP polling are not progress. */
export class InteractionProgress {
  private readonly cursors = new Map<number, { offset: number; pending: string }>();
  private readonly startedAt = Date.now();
  private traceId: string | undefined;

  constructor(private readonly directory: string) {
    this.read(true);
  }

  poll(): boolean { return this.read(false); }

  private read(baseline: boolean): boolean {
    let fresh = false;
    for (const name of fs.readdirSync(this.directory).sort()) {
      if (!name.startsWith("checkpoints-") || !name.endsWith(".jsonl")) continue;
      let fd: number;
      try { fd = fs.openSync(path.join(this.directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Segment was sealed/renamed.
        throw error;
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) continue;
        const cursor = this.cursors.get(stat.ino) ?? { offset: baseline ? stat.size : 0, pending: "" };
        this.cursors.set(stat.ino, cursor);
        const unread = stat.size - cursor.offset;
        if (unread < 0 || unread > 4 * 1024 * 1024) throw new Error("interaction progress evidence invalid or too large");
        if (!unread) continue;
        const buffer = Buffer.alloc(unread);
        const bytes = fs.readSync(fd, buffer, 0, unread, cursor.offset);
        cursor.offset += bytes;
        const lines = (cursor.pending + buffer.toString("utf8", 0, bytes)).split("\n");
        cursor.pending = lines.pop()!;
        for (const line of lines) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (!record || record.kind !== "checkpoint" || typeof record.recordedAt !== "number" || record.recordedAt < this.startedAt) continue;
          const attributes = record.attributes ?? {};
          if (!this.traceId && record.name === "weixin.inbound.start" && typeof record.traceId === "string") this.traceId = record.traceId;
          if (this.traceId) {
            if (record.traceId !== this.traceId) continue;
            if (["weixin.inbound.start", "runtime.stage.start", "tool.call.start", "tool.result"].includes(record.name) ||
                (record.name === "runtime.stage" && ["protocol_progress", "agent_message_delta"].includes(attributes.activity))) fresh = true;
          } else if (!record.traceId && record.name === "runtime.stage" &&
              ["app_server_initialize", "thread_start", "thread_resume"].includes(attributes.stage) &&
              ["start", "end"].includes(attributes.status)) fresh = true;
        }
      } finally { fs.closeSync(fd); }
    }
    return fresh;
  }
}
