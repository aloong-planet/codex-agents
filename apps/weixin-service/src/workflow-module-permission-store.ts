import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkflowModulePermissionAccess = "read" | "write";

export type WorkflowModulePermissionScope = {
  scopeId: string;
  label: string;
  directory: string;
  read: boolean;
  write: boolean;
};

export type WorkflowModulePermissionState = {
  moduleId: string;
  revision: number;
  saved: boolean;
  scopes: WorkflowModulePermissionScope[];
};

export type WorkflowModulePermissionSnapshot = {
  moduleId: string;
  revision: number;
  scopes: Array<{ scopeId: string; read: boolean; write: boolean }>;
};

type ScopeDraft = { scopeId: string; label: string; directory: string };

export class WorkflowModulePermissionStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_module_permission (
        module_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_module_scope (
        module_id TEXT NOT NULL REFERENCES workflow_module_permission(module_id) ON DELETE CASCADE,
        scope_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        label TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
        can_write INTEGER NOT NULL CHECK (can_write IN (0, 1)),
        PRIMARY KEY (module_id, scope_id),
        UNIQUE (module_id, canonical_path)
      );
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE workflow_module_permission SET revision = revision + 1, updated_at = ?
        WHERE module_id IN (
          SELECT module_id FROM workflow_module_scope WHERE can_write = 1 AND can_read = 0
        )
      `).run(Date.now());
      this.database.exec("UPDATE workflow_module_scope SET can_read = 1 WHERE can_write = 1 AND can_read = 0");
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createDraft(input: { moduleId: string; scopes: ScopeDraft[] }): WorkflowModulePermissionState {
    validateIdentifier(input.moduleId, "workflow_module_permission_invalid");
    const scopes = normalizeDraftScopes(input.scopes).map((scope) => ({ ...scope, read: true, write: false }));
    const current = this.get(input.moduleId);
    return current ?? { moduleId: input.moduleId, revision: 0, saved: false, scopes };
  }

  save(input: {
    moduleId: string;
    expectedRevision: number;
    confirmed: boolean;
    scopes: WorkflowModulePermissionScope[];
  }): WorkflowModulePermissionState {
    validateIdentifier(input.moduleId, "workflow_module_permission_invalid");
    if (!input.confirmed) throw new Error("workflow_module_permission_confirmation_required");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("workflow_module_permission_revision_invalid");
    }
    const scopes = normalizeSavedScopes(input.scopes);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(`
        SELECT revision FROM workflow_module_permission WHERE module_id = ?
      `).get(input.moduleId) as { revision: number } | undefined;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) throw new Error("workflow_module_permission_revision_conflict");
      const nextRevision = currentRevision + 1;
      this.database.prepare(`
        INSERT INTO workflow_module_permission(module_id, revision, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(module_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
      `).run(input.moduleId, nextRevision, Date.now());
      this.database.prepare("DELETE FROM workflow_module_scope WHERE module_id = ?").run(input.moduleId);
      const insert = this.database.prepare(`
        INSERT INTO workflow_module_scope(
          module_id, scope_id, ordinal, label, canonical_path, can_read, can_write
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      scopes.forEach((scope, ordinal) => {
        insert.run(input.moduleId, scope.scopeId, ordinal, scope.label, scope.directory, scope.read ? 1 : 0, scope.write ? 1 : 0);
      });
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(input.moduleId)!;
  }

  get(moduleId: string): WorkflowModulePermissionState | undefined {
    validateIdentifier(moduleId, "workflow_module_permission_invalid");
    const module = this.database.prepare(`
      SELECT revision FROM workflow_module_permission WHERE module_id = ?
    `).get(moduleId) as { revision: number } | undefined;
    if (!module) return undefined;
    const rows = this.database.prepare(`
      SELECT scope_id, label, canonical_path, can_read, can_write
      FROM workflow_module_scope WHERE module_id = ? ORDER BY ordinal
    `).all(moduleId) as unknown as Array<{
      scope_id: string;
      label: string;
      canonical_path: string;
      can_read: number;
      can_write: number;
    }>;
    return {
      moduleId,
      revision: module.revision,
      saved: true,
      scopes: rows.map((row) => ({
        scopeId: row.scope_id,
        label: row.label,
        directory: row.canonical_path,
        read: row.can_read === 1,
        write: row.can_write === 1,
      })),
    };
  }

  snapshot(moduleId: string): WorkflowModulePermissionSnapshot | undefined {
    const state = this.get(moduleId);
    return state ? {
      moduleId,
      revision: state.revision,
      scopes: state.scopes.map(({ scopeId, read, write }) => ({ scopeId, read, write })),
    } : undefined;
  }

  assertAllowed(input: {
    moduleId: string;
    access: WorkflowModulePermissionAccess;
    scopeId: string;
    absolutePath?: string;
  }): void {
    if (input.access !== "read" && input.access !== "write") {
      throw new Error("workflow_module_execute_forbidden");
    }
    const state = this.get(input.moduleId);
    let scope = state?.scopes.find((candidate) => candidate.scopeId === input.scopeId);
    if (input.absolutePath !== undefined && state) {
      const resolved = resolveAuthorizedPath(input.absolutePath);
      const mostSpecific = state.scopes
        .filter((candidate) => isInside(resolved, candidate.directory))
        .sort((left, right) => right.directory.length - left.directory.length)[0];
      if (!mostSpecific || mostSpecific.scopeId !== input.scopeId) {
        throw new Error("workflow_module_permission_denied");
      }
      scope = mostSpecific;
    }
    if (!scope || !scope[input.access]) throw new Error("workflow_module_permission_denied");
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

function normalizeDraftScopes(scopes: ScopeDraft[]): ScopeDraft[] {
  if (!Array.isArray(scopes) || scopes.length > 64) throw new Error("workflow_module_permission_invalid");
  const seenIds = new Set<string>();
  return scopes.map((scope) => {
    const normalized = normalizeScopeIdentity(scope);
    if (seenIds.has(normalized.scopeId)) throw new Error("workflow_module_permission_invalid");
    seenIds.add(normalized.scopeId);
    return normalized;
  });
}

function normalizeSavedScopes(scopes: WorkflowModulePermissionScope[]): WorkflowModulePermissionScope[] {
  const normalized = normalizeDraftScopes(scopes).map((scope, index) => {
    const source = scopes[index]!;
    if (typeof source.read !== "boolean" || typeof source.write !== "boolean") {
      throw new Error("workflow_module_permission_invalid");
    }
    return { ...scope, directory: canonicalDirectory(scope.directory), read: source.read || source.write, write: source.write };
  });
  const byPath = new Map<string, WorkflowModulePermissionScope>();
  for (const scope of normalized.sort((left, right) => left.scopeId.localeCompare(right.scopeId))) {
    const duplicate = byPath.get(scope.directory);
    if (duplicate && (duplicate.read !== scope.read || duplicate.write !== scope.write)) {
      throw new Error("workflow_module_permission_duplicate_conflict");
    }
    if (!duplicate) byPath.set(scope.directory, scope);
  }
  return [...byPath.values()];
}

function normalizeScopeIdentity(scope: ScopeDraft): ScopeDraft {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("workflow_module_permission_invalid");
  validateIdentifier(scope.scopeId, "workflow_module_permission_invalid");
  if (typeof scope.label !== "string" || scope.label.length < 1 || scope.label.length > 120 || hasControl(scope.label) ||
      typeof scope.directory !== "string" || !path.isAbsolute(scope.directory) || scope.directory.length > 4096 ||
      hasControl(scope.directory)) throw new Error("workflow_module_permission_invalid");
  return { scopeId: scope.scopeId, label: scope.label, directory: path.normalize(scope.directory) };
}

function canonicalDirectory(directory: string): string {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("workflow_module_scope_unsafe");
  return fs.realpathSync(directory);
}

function resolveAuthorizedPath(absolutePath: string): string {
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath) || hasControl(absolutePath)) {
    throw new Error("workflow_module_permission_denied");
  }
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    const missing: string[] = [];
    let existing = absolutePath;
    while (true) {
      try {
        const canonical = fs.realpathSync(existing);
        return path.join(canonical, ...missing.reverse());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        missing.push(path.basename(existing));
        existing = parent;
      }
    }
  }
}

function isInside(candidate: string, canonicalScope: string): boolean {
  return candidate === canonicalScope || candidate.startsWith(`${canonicalScope}${path.sep}`);
}

function validateIdentifier(value: string, errorCode: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || hasControl(value)) throw new Error(errorCode);
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
