import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const IDENTIFIER = /^[A-Za-z0-9:._@-]{1,512}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9:._@-]{1,512}$/;

type TargetRow = { account_id: string; target: string };

export class WorkflowRunTargetStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_run_target (
        run_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        target TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  bind(runId: string, accountId: string, target: string): void {
    if (!IDENTIFIER.test(runId)) throw new Error("workflow_run_id_invalid");
    if (!ACCOUNT_ID.test(accountId) || !TARGET_ID.test(target)) throw new Error("workflow_run_target_invalid");
    this.database.prepare(`
      INSERT OR IGNORE INTO workflow_run_target(run_id, account_id, target, created_at)
      VALUES (?, ?, ?, ?)
    `).run(runId, accountId, target, Date.now());
    const existing = this.resolveRunTarget(runId);
    if (!existing || existing.accountId !== accountId || existing.target !== target) {
      throw new Error("workflow_run_target_conflict");
    }
  }

  resolveRunTarget(runId: string): { accountId: string; target: string } | null {
    if (!IDENTIFIER.test(runId)) return null;
    const row = this.database.prepare(
      "SELECT account_id, target FROM workflow_run_target WHERE run_id = ?",
    ).get(runId) as TargetRow | undefined;
    return row ? { accountId: row.account_id, target: row.target } : null;
  }

  close(): void {
    this.database.close();
  }
}
