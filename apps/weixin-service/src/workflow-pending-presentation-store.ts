import type {
  PendingPresentation,
  PendingPresentationStore,
} from "./workflow-pending-response-coordinator.js";

export class WorkflowPendingPresentationStore implements PendingPresentationStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_pending_presentation (
        account_ref TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        run_id TEXT NOT NULL,
        signal_ref TEXT NOT NULL,
        candidate_revision INTEGER NOT NULL,
        request_text_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (account_ref, target_ref)
      )
    `);
    const columns = this.database.prepare("PRAGMA table_info(workflow_pending_presentation)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "requester_ref")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE workflow_pending_presentation RENAME TO workflow_pending_presentation_legacy;
          CREATE TABLE workflow_pending_presentation (
            account_ref TEXT NOT NULL, target_ref TEXT NOT NULL, requester_ref TEXT NOT NULL,
            run_id TEXT NOT NULL, signal_ref TEXT NOT NULL, candidate_revision INTEGER NOT NULL,
            request_text_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER NOT NULL,
            PRIMARY KEY (account_ref, target_ref, requester_ref)
          );
          INSERT INTO workflow_pending_presentation
          SELECT account_ref, target_ref, '', run_id, signal_ref, candidate_revision,
            request_text_hash, expires_at, accepted_at FROM workflow_pending_presentation_legacy;
          DROP TABLE workflow_pending_presentation_legacy;
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  get(accountRef: string, targetRef: string, requesterRef?: string): PendingPresentation | undefined {
    validateBounded(accountRef, "workflow_presentation_account_invalid");
    validateBounded(targetRef, "workflow_presentation_target_invalid");
    const row = this.database.prepare(`
      SELECT account_ref, target_ref, requester_ref, run_id, signal_ref, candidate_revision,
             request_text_hash, expires_at, accepted_at
      FROM workflow_pending_presentation
      WHERE account_ref = ? AND target_ref = ? AND requester_ref = ?
    `).get(accountRef, targetRef, requesterRef ?? "") as PresentationRow | undefined;
    return row ? {
      accountRef: row.account_ref,
      targetRef: row.target_ref,
      ...(row.requester_ref ? { requesterRef: row.requester_ref } : {}),
      runId: row.run_id,
      signalRef: row.signal_ref,
      revision: row.candidate_revision,
      requestTextHash: row.request_text_hash,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
    } : undefined;
  }

  put(presentation: PendingPresentation): void {
    validatePresentation(presentation);
    this.database.prepare(`
      INSERT INTO workflow_pending_presentation(
        account_ref, target_ref, requester_ref, run_id, signal_ref, candidate_revision,
        request_text_hash, expires_at, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_ref, target_ref, requester_ref) DO UPDATE SET
        run_id = excluded.run_id,
        signal_ref = excluded.signal_ref,
        candidate_revision = excluded.candidate_revision,
        request_text_hash = excluded.request_text_hash,
        expires_at = excluded.expires_at,
        accepted_at = excluded.accepted_at
      WHERE excluded.accepted_at >= workflow_pending_presentation.accepted_at
    `).run(
      presentation.accountRef,
      presentation.targetRef,
      presentation.requesterRef ?? "",
      presentation.runId,
      presentation.signalRef,
      presentation.revision,
      presentation.requestTextHash,
      presentation.expiresAt,
      presentation.acceptedAt,
    );
  }

  close(): void {
    this.database.close();
  }
}

type PresentationRow = {
  account_ref: string;
  target_ref: string;
  requester_ref: string;
  run_id: string;
  signal_ref: string;
  candidate_revision: number;
  request_text_hash: string;
  expires_at: number;
  accepted_at: number;
};

function validatePresentation(presentation: PendingPresentation): void {
  validateBounded(presentation.accountRef, "workflow_presentation_account_invalid");
  validateBounded(presentation.targetRef, "workflow_presentation_target_invalid");
  if (presentation.requesterRef !== undefined) validateBounded(presentation.requesterRef, "workflow_presentation_requester_invalid");
  validateBounded(presentation.runId, "workflow_presentation_run_invalid");
  validateBounded(presentation.signalRef, "workflow_presentation_signal_invalid");
  if (!Number.isSafeInteger(presentation.revision) || presentation.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(presentation.requestTextHash) ||
      !Number.isSafeInteger(presentation.expiresAt) || !Number.isSafeInteger(presentation.acceptedAt) ||
      presentation.expiresAt <= presentation.acceptedAt) {
    throw new Error("workflow_presentation_invalid");
  }
}

function validateBounded(value: string, errorCode: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || containsControlCharacter(value)) {
    throw new Error(errorCode);
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
