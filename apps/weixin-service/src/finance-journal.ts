import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FinanceCommand } from "./finance-interpreter.js";
import type { FinanceDraft } from "./finance-ledger.js";

export type FinancePlan = FinanceCommand
  | { kind: "confirm" | "cancel"; id: string; revision: number }
  | { kind: "show"; id: string }
  | { kind: "duplicate"; id: string; revision: number; rowIndex: number; existingRef?: string }
  | { kind: "textPreview"; drafts: FinanceDraft[] };
export type FinanceReply = { text: string; preview?: { id: string; revision: number } };
export type FinanceJournalEntry = { key: string; inputHash: string; text: string; hasAttachments?: boolean; plan?: FinancePlan; reply?: FinanceReply; completed?: boolean };

/** Private execution history. Identity is admitted by the service before any access. */
export class FinanceJournal {
  private readonly database: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error("finance_storage_invalid");
    const descriptor = fs.openSync(file, "a", 0o600); fs.closeSync(descriptor); fs.chmodSync(file, 0o600);
    this.database = new DatabaseSync(file);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS penny_turn (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  }
  get(key: string): FinanceJournalEntry | undefined {
    const row = this.database.prepare("SELECT value FROM penny_turn WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) as FinanceJournalEntry : undefined;
  }
  save(entry: FinanceJournalEntry): void {
    this.database.prepare("INSERT INTO penny_turn VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(entry.key, JSON.stringify(entry));
  }
  recent(): { text: string; reply: string }[] {
    return this.database.prepare("SELECT value FROM penny_turn ORDER BY rowid DESC LIMIT 8").all().reverse()
      .map((row) => JSON.parse(String(row.value)) as FinanceJournalEntry)
      .filter((entry) => entry.reply).map((entry) => ({ text: entry.text, reply: entry.reply!.text }));
  }
  close(): void { this.database.close(); }
}
