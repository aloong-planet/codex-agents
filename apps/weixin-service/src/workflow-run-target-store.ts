import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const IDENTIFIER = /^[A-Za-z0-9:._@-]{1,512}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9:._@-]{1,512}$/;

type TargetRow = { account_id: string; target: string; sender_account_id: string | null };

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
    if (!this.database.prepare("PRAGMA table_info(workflow_run_target)").all().some((column) => column.name === "sender_account_id")) {
      this.database.exec("ALTER TABLE workflow_run_target ADD COLUMN sender_account_id TEXT");
    }
  }

  bind(runId: string, accountId: string, target: string, senderAccountId?: string): void {
    if (!IDENTIFIER.test(runId)) throw new Error("workflow_run_id_invalid");
    if (!ACCOUNT_ID.test(accountId) || !TARGET_ID.test(target)) throw new Error("workflow_run_target_invalid");
    if (senderAccountId !== undefined && (!ACCOUNT_ID.test(senderAccountId) || !target.startsWith("feishu.group."))) throw new Error("workflow_run_sender_invalid");
    this.database.prepare(`
      INSERT OR IGNORE INTO workflow_run_target(run_id, account_id, target, created_at, sender_account_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, accountId, target, Date.now(), senderAccountId ?? null);
    const existing = this.resolveRunTarget(runId);
    if (!existing || existing.accountId !== accountId || existing.target !== target || existing.senderAccountId !== senderAccountId) {
      throw new Error("workflow_run_target_conflict");
    }
  }

  resolveRunTarget(runId: string): { accountId: string; target: string; senderAccountId?: string } | null {
    if (!IDENTIFIER.test(runId)) return null;
    const row = this.database.prepare(
      "SELECT account_id, target, sender_account_id FROM workflow_run_target WHERE run_id = ?",
    ).get(runId) as TargetRow | undefined;
    return row ? { accountId: row.account_id, target: row.target, ...(row.sender_account_id ? { senderAccountId: row.sender_account_id } : {}) } : null;
  }

  close(): void {
    this.database.close();
  }
}
