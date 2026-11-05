import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileSandboxPreparedMutation } from "./file-sandbox.js";

export type LocalFileOperationRecord = {
  operationKey: string;
  requestHash: string;
  status: "started" | "completed";
  prepared?: FileSandboxPreparedMutation;
  planned: {
    sha256: string;
    sizeBytes: number;
    mode: number;
  };
  result?: {
    sha256: string;
    sizeBytes: number;
    modifiedAt: number;
    mode: number;
    created?: boolean;
    changed?: boolean;
  };
};

export class LocalFileOperationStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_file_operation (
        operation_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
        planned_json TEXT NOT NULL,
        result_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.database.prepare("PRAGMA table_info(local_file_operation)").all();
    if (!columns.some((column) => column.name === "prepared_json")) {
      this.database.exec("ALTER TABLE local_file_operation ADD COLUMN prepared_json TEXT");
    }
    this.database.exec(`CREATE TABLE IF NOT EXISTS dispatch_file_operation (
      request_id TEXT NOT NULL, event_key TEXT NOT NULL, resource_key TEXT NOT NULL, logical_key TEXT NOT NULL,
      operation_key TEXT NOT NULL, PRIMARY KEY(request_id, event_key, operation_key)
    )`);
  }

  dispatchReplay(requestId: string, eventKey: string, resourceKey: string, logicalKey: string): LocalFileOperationRecord | undefined {
    const unknown = this.database.prepare(`SELECT 1 FROM dispatch_file_operation AS binding
      JOIN local_file_operation AS operation ON operation.operation_key = binding.operation_key
      WHERE binding.request_id = ? AND binding.event_key = ? AND operation.status = 'started' LIMIT 1`).get(requestId, eventKey);
    if (unknown) throw new Error("local_file_content_conflict");
    const row = this.database.prepare(`SELECT operation_key FROM dispatch_file_operation
      WHERE request_id = ? AND event_key = ? AND logical_key = ? ORDER BY rowid DESC LIMIT 1`).get(requestId, eventKey, logicalKey);
    if (row) return this.get(String(row.operation_key));
    if (this.database.prepare("SELECT 1 FROM dispatch_file_operation WHERE request_id = ? AND event_key = ? AND resource_key = ? LIMIT 1")
      .get(requestId, eventKey, resourceKey)) throw new Error("local_file_content_conflict");
    return undefined;
  }

  bindDispatch(requestId: string, eventKey: string, resourceKey: string, logicalKey: string, operationKey: string): void {
    this.database.prepare("INSERT OR IGNORE INTO dispatch_file_operation VALUES (?, ?, ?, ?, ?)")
      .run(requestId, eventKey, resourceKey, logicalKey, operationKey);
  }

  dispatchEvidence(requestId: string): { completed: number; unknown: number } {
    const counts = { completed: 0, unknown: 0 };
    for (const row of this.database.prepare(`SELECT operation.status, COUNT(DISTINCT operation.operation_key) AS count
      FROM dispatch_file_operation AS binding JOIN local_file_operation AS operation ON operation.operation_key = binding.operation_key
      WHERE binding.request_id = ? GROUP BY operation.status`).all(requestId)) {
      counts[row.status === "completed" ? "completed" : "unknown"] = Number(row.count);
    }
    return counts;
  }

  get(operationKey: string): LocalFileOperationRecord | undefined {
    const row = this.database.prepare(`
      SELECT operation_key, request_hash, status, planned_json, result_json, prepared_json
      FROM local_file_operation WHERE operation_key = ?
    `).get(operationKey) as {
      operation_key: string;
      request_hash: string;
      status: "started" | "completed";
      planned_json: string;
      result_json: string | null;
      prepared_json: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      operationKey: row.operation_key,
      requestHash: row.request_hash,
      status: row.status,
      planned: parsePlan(row.planned_json),
      ...(row.prepared_json ? { prepared: JSON.parse(row.prepared_json) as FileSandboxPreparedMutation } : {}),
      ...(row.result_json ? { result: parseResult(row.result_json) } : {}),
    };
  }

  start(operationKey: string, requestHash: string, planned: LocalFileOperationRecord["planned"]): LocalFileOperationRecord {
    this.database.prepare(`
      INSERT INTO local_file_operation(operation_key, request_hash, status, planned_json, result_json, updated_at)
      VALUES (?, ?, 'started', ?, NULL, ?)
      ON CONFLICT(operation_key) DO NOTHING
    `).run(operationKey, requestHash, JSON.stringify(planned), Date.now());
    const record = this.get(operationKey);
    if (!record || record.requestHash !== requestHash || JSON.stringify(record.planned) !== JSON.stringify(planned)) {
      throw new Error("local_file_operation_conflict");
    }
    return record;
  }

  complete(operationKey: string, requestHash: string, result: NonNullable<LocalFileOperationRecord["result"]>): void {
    const changed = this.database.prepare(`
      UPDATE local_file_operation
      SET status = 'completed', result_json = ?, updated_at = ?
      WHERE operation_key = ? AND request_hash = ?
    `).run(JSON.stringify(result), Date.now(), operationKey, requestHash);
    if (changed.changes !== 1) throw new Error("local_file_operation_conflict");
  }

  prepare(operationKey: string, requestHash: string, prepared: FileSandboxPreparedMutation): void {
    const record = this.get(operationKey);
    if (!record || record.status !== "started" || record.requestHash !== requestHash ||
        prepared.sha256 !== record.planned.sha256 || prepared.sizeBytes !== record.planned.sizeBytes ||
        prepared.mode !== record.planned.mode) throw new Error("local_file_operation_conflict");
    const changed = this.database.prepare(`UPDATE local_file_operation SET prepared_json = ?, updated_at = ?
      WHERE operation_key = ? AND request_hash = ? AND status = 'started'`)
      .run(JSON.stringify(prepared), Date.now(), operationKey, requestHash);
    if (changed.changes !== 1) throw new Error("local_file_operation_conflict");
  }

  close(): void {
    this.database.close();
  }
}

function parsePlan(value: string): LocalFileOperationRecord["planned"] {
  const plan = JSON.parse(value) as Partial<LocalFileOperationRecord["planned"]>;
  if (!plan || typeof plan.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(plan.sha256) ||
      !Number.isSafeInteger(plan.sizeBytes) || plan.sizeBytes! < 0 ||
      !Number.isSafeInteger(plan.mode) || plan.mode! < 0 || plan.mode! > 0o777) {
    throw new Error("local_file_operation_corrupt");
  }
  return plan as LocalFileOperationRecord["planned"];
}

function parseResult(value: string): NonNullable<LocalFileOperationRecord["result"]> {
  const result = JSON.parse(value) as Partial<NonNullable<LocalFileOperationRecord["result"]>>;
  if (!result || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.sha256) ||
      !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes! < 0 || !Number.isFinite(result.modifiedAt) ||
      !Number.isSafeInteger(result.mode) || result.mode! < 0 || result.mode! > 0o777 ||
      (result.created !== undefined && typeof result.created !== "boolean") ||
      (result.changed !== undefined && typeof result.changed !== "boolean")) {
    throw new Error("local_file_operation_corrupt");
  }
  return result as NonNullable<LocalFileOperationRecord["result"]>;
}
