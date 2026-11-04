import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DailyAiNewsFileStore, parseDailyAiNewsState } from "./daily-ai-news-store.js";
import type { DailyNewsImport } from "./daily-news-import.js";

type PreparedNews = { version: 1; legacyPid: number | null; sourceHash: string; originalText: string };
const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** The caller must hold exclusive service activation; this also verifies the captured old PID is gone. */
export class DailyNewsHandoff {
  constructor(readonly statePath: string) {}

  prepare(legacyPid?: number): DailyNewsImport {
    let prepared = this.prepared();
    if (!prepared) {
      const exists = fs.existsSync(this.statePath);
      if (exists && legacyPid === undefined) throw new Error("daily_news_reconciliation_pending");
      if (legacyPid !== undefined) assertStopped(legacyPid);
      const state = new DailyAiNewsFileStore(this.statePath).load();
      const originalText = exists ? fs.readFileSync(this.statePath, "utf8") : JSON.stringify(state);
      prepared = { version: 1, legacyPid: legacyPid ?? null, sourceHash: digest(originalText), originalText };
      publishNew(`${this.statePath}.prepared`, JSON.stringify(prepared));
      prepared = this.prepared()!;
    }
    if (prepared.legacyPid !== null) assertStopped(prepared.legacyPid);
    if (!this.fenced(prepared.sourceHash)) {
      if (fs.existsSync(this.statePath) && digest(fs.readFileSync(this.statePath, "utf8")) !== prepared.sourceHash) throw new Error("daily_news_source_changed");
      const temporary = `${this.statePath}.${crypto.randomUUID()}.tmp`;
      try {
        writeDurable(temporary, JSON.stringify({ version: 3, owner: "scheduled-tasks", sourceHash: prepared.sourceHash }));
        fs.renameSync(temporary, this.statePath); syncDirectory(path.dirname(this.statePath));
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    return this.readPrepared()!;
  }

  verifyCommitted(sourceHash: string): boolean {
    return this.prepared()?.sourceHash === sourceHash && this.fenced(sourceHash);
  }

  readPrepared(): DailyNewsImport | undefined {
    const prepared = this.prepared();
    if (!prepared || !this.fenced(prepared.sourceHash)) return undefined;
    if (prepared.legacyPid !== null) assertStopped(prepared.legacyPid);
    return { state: parseDailyAiNewsState(JSON.parse(prepared.originalText)), sourceHash: prepared.sourceHash };
  }

  private prepared(): PreparedNews | undefined {
    const file = `${this.statePath}.prepared`;
    if (!fs.existsSync(file)) return undefined;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("daily_news_handoff_unsafe");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as PreparedNews;
    if (value.version !== 1 || (value.legacyPid !== null && (!Number.isSafeInteger(value.legacyPid) || value.legacyPid <= 0)) ||
      typeof value.originalText !== "string" || value.sourceHash !== digest(value.originalText)) throw new Error("daily_news_handoff_invalid");
    parseDailyAiNewsState(JSON.parse(value.originalText));
    return value;
  }

  private fenced(sourceHash: string): boolean {
    if (!fs.existsSync(this.statePath)) return false;
    const stat = fs.lstatSync(this.statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("daily_news_handoff_unsafe");
    const value = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Record<string, unknown>;
    return value.version === 3 && value.owner === "scheduled-tasks" && value.sourceHash === sourceHash;
  }
}

function assertStopped(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("daily_news_legacy_pid_invalid");
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("daily_news_legacy_stop_unverified");
  }
  throw new Error("daily_news_legacy_still_running");
}
function writeDurable(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function publishNew(file: string, text: string): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeDurable(temporary, text);
    try { fs.linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
