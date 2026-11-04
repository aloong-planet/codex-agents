import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const IDENTIFIER = /^[A-Za-z0-9:._@-]{1,512}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9._-]+@im\.wechat$/;
const EVENT_KEY = /^[a-f0-9]{64}$/;

export type EffectKind =
  | "feishu_media"
  | "feishu_text"
  | "weixin_text"
  | "weixin_progress"
  | "weixin_media_upload_url"
  | "weixin_media_upload"
  | "weixin_media_send";

export type EffectState = "prepared" | "accepted" | "rejected" | "unknown";

export type EffectRecord = {
  attemptId: string;
  operationId: string;
  causeEventKey?: string;
  accountId: string;
  target: string;
  kind: EffectKind;
  clientId?: string;
  ordinal?: number;
  state: EffectState;
  providerCode?: number;
  createdAt: number;
  settledAt?: number;
};

export type EffectIntent = Omit<EffectRecord, "state" | "providerCode" | "createdAt" | "settledAt">;

export interface EffectLedger {
  prepare(intent: EffectIntent): EffectRecord;
  settle(attemptId: string, outcome: Exclude<EffectState, "prepared">, providerCode?: number): EffectRecord;
}

type EffectRow = {
  attempt_id: string;
  operation_id: string;
  cause_event_key: string | null;
  account_id: string;
  target: string;
  kind: string;
  client_id: string | null;
  ordinal: number | null;
  state: string;
  provider_code: number | null;
  created_at: number;
  settled_at: number | null;
};

const EFFECT_KINDS = new Set<EffectKind>([
  "feishu_text",
  "feishu_media",
  "weixin_text",
  "weixin_progress",
  "weixin_media_upload_url",
  "weixin_media_upload",
  "weixin_media_send",
]);

const EFFECT_SCHEMA = `
      CREATE TABLE IF NOT EXISTS effect_attempt (
        attempt_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        cause_event_key TEXT,
        account_id TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('weixin_text','weixin_progress','weixin_media_upload_url','weixin_media_upload','weixin_media_send','feishu_text','feishu_media')),
        client_id TEXT,
        ordinal INTEGER,
        state TEXT NOT NULL CHECK (state IN ('prepared','accepted','rejected','unknown')),
        provider_code INTEGER,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS effect_attempt_cause
        ON effect_attempt(cause_event_key, created_at, attempt_id);
      CREATE INDEX IF NOT EXISTS effect_attempt_operation
        ON effect_attempt(operation_id, created_at, attempt_id);
    `;

export class DurableEffectLedger implements EffectLedger {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.database.exec(EFFECT_SCHEMA);
    const schema = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'effect_attempt'").get()?.sql;
    if (typeof schema === "string" && !schema.includes("'feishu_media'")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec("ALTER TABLE effect_attempt RENAME TO effect_attempt_legacy");
        this.database.exec(EFFECT_SCHEMA);
        this.database.exec("INSERT INTO effect_attempt SELECT * FROM effect_attempt_legacy; DROP TABLE effect_attempt_legacy;");
        this.database.exec(EFFECT_SCHEMA);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
  }

  prepare(intent: EffectIntent): EffectRecord {
    this.validateIntent(intent);
    const at = this.now();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO effect_attempt(
        attempt_id, operation_id, cause_event_key, account_id, target, kind,
        client_id, ordinal, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `).run(
      intent.attemptId,
      intent.operationId,
      intent.causeEventKey ?? null,
      intent.accountId,
      intent.target,
      intent.kind,
      intent.clientId ?? null,
      intent.ordinal ?? null,
      at,
      at,
    );
    const record = this.read(intent.attemptId);
    if (!record) throw new Error("effect_prepare_failed");
    if (Number(result.changes) === 0 && !this.sameIntent(record, intent)) {
      throw new Error("effect_attempt_conflict");
    }
    return record;
  }

  settle(attemptId: string, outcome: Exclude<EffectState, "prepared">, providerCode?: number): EffectRecord {
    this.assertIdentifier(attemptId, "effect_attempt_invalid");
    if (!new Set(["accepted", "rejected", "unknown"]).has(outcome)) {
      throw new Error("effect_outcome_invalid");
    }
    if (providerCode !== undefined && !Number.isSafeInteger(providerCode)) {
      throw new Error("effect_provider_code_invalid");
    }
    const existing = this.read(attemptId);
    if (!existing) throw new Error("effect_attempt_missing");
    if (existing.state !== "prepared") {
      if (existing.state === outcome && existing.providerCode === providerCode) return existing;
      throw new Error("effect_outcome_conflict");
    }
    const at = this.now();
    const result = this.database.prepare(`
      UPDATE effect_attempt
      SET state = ?, provider_code = ?, settled_at = ?, updated_at = ?
      WHERE attempt_id = ? AND state = 'prepared'
    `).run(outcome, providerCode ?? null, at, at, attemptId);
    if (Number(result.changes) !== 1) throw new Error("effect_outcome_conflict");
    return this.read(attemptId)!;
  }

  retrySafety(attemptId: string): "safe" | "unsafe" | "unknown" {
    const record = this.read(attemptId);
    if (!record) throw new Error("effect_attempt_missing");
    if (record.state === "rejected") return "safe";
    if (record.state === "prepared") return "unknown";
    return "unsafe";
  }

  listByCause(causeEventKey: string): EffectRecord[] {
    if (!EVENT_KEY.test(causeEventKey)) throw new Error("effect_cause_invalid");
    const rows = this.database.prepare(`
      SELECT attempt_id, operation_id, cause_event_key, account_id, target, kind,
             client_id, ordinal, state, provider_code, created_at, settled_at
      FROM effect_attempt WHERE cause_event_key = ? ORDER BY created_at, rowid
    `).all(causeEventKey) as unknown as EffectRow[];
    return rows.map((row) => this.decode(row));
  }

  listByOperation(operationId: string): EffectRecord[] {
    this.assertIdentifier(operationId, "effect_operation_invalid");
    const rows = this.database.prepare(`
      SELECT attempt_id, operation_id, cause_event_key, account_id, target, kind,
             client_id, ordinal, state, provider_code, created_at, settled_at
      FROM effect_attempt WHERE operation_id = ? ORDER BY created_at, rowid
    `).all(operationId) as unknown as EffectRow[];
    return rows.map((row) => this.decode(row));
  }

  close(): void {
    this.database.close();
  }

  private read(attemptId: string): EffectRecord | null {
    const row = this.database.prepare(`
      SELECT attempt_id, operation_id, cause_event_key, account_id, target, kind,
             client_id, ordinal, state, provider_code, created_at, settled_at
      FROM effect_attempt WHERE attempt_id = ?
    `).get(attemptId) as EffectRow | undefined;
    return row ? this.decode(row) : null;
  }

  private decode(row: EffectRow): EffectRecord {
    return {
      attemptId: row.attempt_id,
      operationId: row.operation_id,
      ...(row.cause_event_key ? { causeEventKey: row.cause_event_key } : {}),
      accountId: row.account_id,
      target: row.target,
      kind: row.kind as EffectKind,
      ...(row.client_id ? { clientId: row.client_id } : {}),
      ...(row.ordinal !== null ? { ordinal: row.ordinal } : {}),
      state: row.state as EffectState,
      ...(row.provider_code !== null ? { providerCode: row.provider_code } : {}),
      createdAt: row.created_at,
      ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    };
  }

  private sameIntent(record: EffectRecord, intent: EffectIntent): boolean {
    return record.operationId === intent.operationId &&
      record.causeEventKey === intent.causeEventKey &&
      record.accountId === intent.accountId &&
      record.target === intent.target &&
      record.kind === intent.kind &&
      record.clientId === intent.clientId &&
      record.ordinal === intent.ordinal;
  }

  private validateIntent(intent: EffectIntent): void {
    this.assertIdentifier(intent.attemptId, "effect_attempt_invalid");
    this.assertIdentifier(intent.operationId, "effect_operation_invalid");
    if (intent.causeEventKey !== undefined && !EVENT_KEY.test(intent.causeEventKey)) {
      throw new Error("effect_cause_invalid");
    }
    if (!ACCOUNT_ID.test(intent.accountId)) throw new Error("effect_account_invalid");
    if (!((intent.kind === "feishu_text" || intent.kind === "feishu_media") ? /^feishu\.[a-f0-9]{64}$/.test(intent.target) : TARGET_ID.test(intent.target))) throw new Error("effect_target_invalid");
    if (!EFFECT_KINDS.has(intent.kind)) throw new Error("effect_kind_invalid");
    if (intent.clientId !== undefined) this.assertIdentifier(intent.clientId, "effect_client_invalid");
    if (intent.ordinal !== undefined && (!Number.isSafeInteger(intent.ordinal) || intent.ordinal < 0)) {
      throw new Error("effect_ordinal_invalid");
    }
  }

  private assertIdentifier(value: string, error: string): void {
    if (!IDENTIFIER.test(value)) throw new Error(error);
  }
}
