import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileOperationStore } from "../src/local-file-operation-store.js";

const roots: string[] = [];
const stores: LocalFileOperationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function databasePath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-operation-journal-"));
  roots.push(root);
  return path.join(root, "operations.sqlite");
}
function open(file: string) {
  const store = new LocalFileOperationStore(file);
  stores.push(store);
  return store;
}
const planned = { sha256: "a".repeat(64), sizeBytes: 4, mode: 0o600 };
const prepared = { fileName: ".item.txt.codex-aaaaaaaaaaaaaaaaaaaaaaaa.tmp", sha256: "a".repeat(64), sizeBytes: 4,
  dev: 1, ino: 42, birthtimeMs: 1000, mtimeMs: 1001, mode: 0o600 };

describe("local_file_operation_journal_preparation", () => {
  it("retains prepared identity across close and reopen without marking the operation completed", () => {
    const file = databasePath();
    const store = open(file);
    store.start("operation", "request", planned);
    store.prepare("operation", "request", prepared);
    stores.pop()!.close();
    const recovered = open(file);
    expect(recovered.get("operation")).toMatchObject({ status: "started", prepared: {
      fileName: ".item.txt.codex-aaaaaaaaaaaaaaaaaaaaaaaa.tmp", dev: 1, ino: 42, birthtimeMs: 1000, mtimeMs: 1001,
    } });
    expect(recovered.get("operation")).not.toHaveProperty("result");
    recovered.complete("operation", "request", { sha256: "a".repeat(64), sizeBytes: 4, mode: 0o600, modifiedAt: 2000, created: true });
    stores.pop()!.close();
    expect(open(file).get("operation")).toMatchObject({ status: "completed", result: { created: true, modifiedAt: 2000 } });
  });

  it("rejects a temporary artifact whose content does not match the started plan", () => {
    const store = open(databasePath());
    store.start("operation", "request", planned);
    expect(() => store.prepare("operation", "request", { ...prepared, sha256: "b".repeat(64) }))
      .toThrow("local_file_operation_conflict");
    expect(store.get("operation")).not.toHaveProperty("prepared");
    expect(store.get("operation")).toMatchObject({ status: "started" });
  });

  it("upgrades the legacy database format without losing completed and started records", () => {
    const file = databasePath();
    // Exact persisted table shape from the pre-prepare/ACK implementation; public SQLite fixture import,
    // not an injected private state of LocalFileTools or a hand-made live workflow Run.
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec(`CREATE TABLE local_file_operation (
        operation_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
        planned_json TEXT NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL)`);
      legacy.prepare("INSERT INTO local_file_operation VALUES (?, ?, ?, ?, ?, ?)")
        .run("old-started", "request", "started", JSON.stringify(planned), null, 1000);
      legacy.prepare("INSERT INTO local_file_operation VALUES (?, ?, ?, ?, ?, ?)")
        .run("old-completed", "request", "completed", JSON.stringify(planned),
          JSON.stringify({ sha256: "a".repeat(64), sizeBytes: 4, mode: 0o600, modifiedAt: 2000, created: true }), 2000);
    } finally { legacy.close(); }
    const migrated = open(file);
    expect(migrated.get("old-started")).toMatchObject({ operationKey: "old-started", status: "started", planned: { sizeBytes: 4, mode: 384 } });
    expect(migrated.get("old-started")).not.toHaveProperty("prepared");
    expect(migrated.get("old-completed")).toMatchObject({ operationKey: "old-completed", status: "completed", result: { modifiedAt: 2000, created: true } });
    migrated.prepare("old-started", "request", prepared);
    stores.pop()!.close();
    expect(open(file).get("old-started")).toMatchObject({ status: "started", prepared: { ino: 42 } });
  });
});
