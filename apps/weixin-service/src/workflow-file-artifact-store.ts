import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { WorkflowModulePermissionAuthorizer } from "./workflow-engine.js";
import { MAX_MEDIA_ARTIFACT_BYTES } from "./media-delivery.js";
import {
  parseWorkflowFileSearchPlan,
  type WorkflowFileSearchPlan,
} from "./workflow-file-search-plan.js";

const HANDLE = /^file_[a-f0-9]{32}$/;
const QUERY_HANDLE = /^filequery_[a-f0-9]{32}$/;
const CONTENT_HANDLE = /^file_content_[a-f0-9]{32}$/;
type StoredFile = { version: 1; absolutePath: string; moduleId: string; scopeId: string; expiresAt: number };
type StoredSnapshot = {
  version: 2;
  absolutePath: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  expiresAt: number;
};
type StoredQuery = { version: 1; query: string; expiresAt: number };
type StoredSearchPlan = { version: 2; plan: WorkflowFileSearchPlan; expiresAt: number };
type LegacySelectionPolicy = "best_match" | "latest" | "all_matches";
type LegacyScopePolicy = "downloads" | "pictures" | "documents" | "any_authorized";
type StoredLegacyQueryV3 = {
  version: 3;
  query: string;
  selectionPolicy: LegacySelectionPolicy;
  expiresAt: number;
};
type StoredLegacyQueryV4 = {
  version: 4;
  query: string;
  selectionPolicy: LegacySelectionPolicy;
  scopePolicy: LegacyScopePolicy;
  expiresAt: number;
};
type StoredContent = { version: 1; fileHandle: string; content: string; expiresAt: number };

export interface LegacyFileSnapshotter {
  snapshotLegacyFile(accountId: string, input: { moduleId: string; scopeId: string; absolutePath: string }): Promise<{
    snapshotPath: string; fileName: string; sha256: string; sizeBytes: number;
  }>;
}

export class WorkflowFileArtifactStore {
  constructor(
    private readonly root: string,
    private readonly permissions: WorkflowModulePermissionAuthorizer,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    this.cleanupSnapshots();
  }

  capture(input: { absolutePath: string; moduleId: string; scopeId: string }): {
    handle: string; fileName: string; sizeBytes: number; expiresAt: number;
  } {
    const absolutePath = this.validate(input.absolutePath, input.moduleId, input.scopeId);
    const stat = fs.statSync(absolutePath);
    const handle = `file_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.write(handle, { version: 1, absolutePath, moduleId: input.moduleId, scopeId: input.scopeId, expiresAt });
    return { handle, fileName: path.basename(absolutePath), sizeBytes: stat.size, expiresAt };
  }

  captureSnapshot(input: { absolutePath: string; fileName: string; sha256: string; sizeBytes: number }): {
    handle: string; fileName: string; sizeBytes: number; expiresAt: number;
  } {
    const absolutePath = this.validateSnapshot(input);
    const handle = `file_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.write(handle, {
      version: 2,
      absolutePath,
      fileName: input.fileName,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      expiresAt,
    });
    return { handle, fileName: input.fileName, sizeBytes: input.sizeBytes, expiresAt };
  }

  captureQuery(triggerKey: string, query: string, options: { allowEmpty?: boolean } = {}): { handle: string; expiresAt: number } {
    const normalized = query.trim();
    if (!triggerKey || triggerKey.length > 512 || (!normalized && !options.allowEmpty) || Buffer.byteLength(normalized, "utf8") > 500) {
      throw new Error("workflow_file_query_invalid");
    }
    const handle = `filequery_${crypto.createHash("sha256").update(triggerKey).digest("hex").slice(0, 32)}`;
    const existing = this.readQuery(handle);
    if (existing) {
      if (existing.query !== normalized) throw new Error("workflow_file_query_conflict");
      return { handle, expiresAt: existing.expiresAt };
    }
    const expiresAt = this.now() + this.ttlMs;
    this.writeJson(handle, { version: 1, query: normalized, expiresAt });
    return { handle, expiresAt };
  }

  queryHandle(triggerKey: string): string | null {
    if (!triggerKey || triggerKey.length > 512) return null;
    const handle = `filequery_${crypto.createHash("sha256").update(triggerKey).digest("hex").slice(0, 32)}`;
    return this.readQuery(handle) ? handle : null;
  }

  deleteQuery(handle: string): void {
    if (!QUERY_HANDLE.test(handle)) return;
    try {
      const file = path.join(this.root, `${handle}.json`);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return;
      fs.unlinkSync(file);
    } catch {
      // Expired or already-released private artifacts are already absent for callers.
    }
  }

  captureSearchPlan(triggerKey: string, input: WorkflowFileSearchPlan): { handle: string; expiresAt: number } {
    const plan = parseWorkflowFileSearchPlan(input);
    if (!triggerKey || triggerKey.length > 512) throw new Error("workflow_file_query_invalid");
    const handle = `filequery_${crypto.createHash("sha256").update(triggerKey).digest("hex").slice(0, 32)}`;
    const existing = this.readSearchRequest(handle);
    if (existing) {
      if (existing.version !== 2 || JSON.stringify(existing.plan) !== JSON.stringify(plan)) {
        throw new Error("workflow_file_query_conflict");
      }
      return { handle, expiresAt: existing.expiresAt };
    }
    const expiresAt = this.now() + this.ttlMs;
    this.writeJson(handle, { version: 2, plan, expiresAt });
    return { handle, expiresAt };
  }

  resolveQuery(handle: string): string | null {
    const stored = QUERY_HANDLE.test(handle) ? this.readSearchRequest(handle) : null;
    return stored?.version === 1 || stored?.version === 3 || stored?.version === 4 ? stored.query : null;
  }

  resolveSearchPlan(handle: string): WorkflowFileSearchPlan | null {
    const stored = QUERY_HANDLE.test(handle) ? this.readSearchRequest(handle) : null;
    if (!stored) return null;
    if (stored.version === 2) return structuredClone(stored.plan);
    return {
      nameTerms: [stored.query],
      pathTerms: [],
      contentTerms: [stored.query],
    };
  }

  resolve(handle: string): string | null {
    return this.resolveForSend(handle)?.absolutePath ?? null;
  }

  async prepareForSend(handle: string, accountId: string, legacy?: LegacyFileSnapshotter): Promise<{ absolutePath: string; fileName: string } | null> {
    if (!HANDLE.test(handle)) return null;
    try {
      const stored = this.read(handle);
      if (!stored) return null;
      if (stored.version === 2) return this.resolveForSend(handle);
      if (!legacy) return null;
      const absolutePath = this.validate(stored.absolutePath, stored.moduleId, stored.scopeId);
      const snapshot = await legacy.snapshotLegacyFile(accountId, {
        absolutePath, moduleId: stored.moduleId, scopeId: stored.scopeId,
      });
      const captured = this.captureSnapshot({ ...snapshot, absolutePath: snapshot.snapshotPath });
      return this.resolveForSend(captured.handle);
    } catch (error) {
      if (error instanceof Error && (error.message === "workflow_module_permission_denied" ||
          error.message === "local_file_permission_changed")) throw error;
      return null;
    }
  }

  resolveForSend(handle: string): { absolutePath: string; fileName: string } | null {
    if (!HANDLE.test(handle)) return null;
    try {
      const stored = this.read(handle);
      if (!stored) return null;
      const absolutePath = stored.version === 1
        ? this.validate(stored.absolutePath, stored.moduleId, stored.scopeId)
        : this.validateSnapshot(stored);
      return { absolutePath, fileName: stored.version === 1 ? path.basename(absolutePath) : stored.fileName };
    } catch {
      return null;
    }
  }

  resolveBound(handle: string, moduleId: string, scopeId: string): string | null {
    if (!HANDLE.test(handle)) return null;
    try {
      const stored = this.read(handle);
      return stored?.version === 1 && stored.moduleId === moduleId && stored.scopeId === scopeId
        ? this.validate(stored.absolutePath, stored.moduleId, stored.scopeId)
        : null;
    } catch {
      return null;
    }
  }

  captureContent(fileHandle: string, content: string): { handle: string; sizeBytes: number; expiresAt: number } {
    if (!this.resolve(fileHandle)) throw new Error("workflow_file_handle_unavailable");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > 1024 * 1024) throw new Error("workflow_file_content_too_large");
    const handle = `file_content_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.writeJson(handle, { version: 1, fileHandle, content, expiresAt });
    return { handle, sizeBytes, expiresAt };
  }

  resolveContent(handle: string): string | null {
    if (!CONTENT_HANDLE.test(handle)) return null;
    try {
      const file = path.join(this.root, `${handle}.json`);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredContent>;
      if (value.version !== 1 || typeof value.fileHandle !== "string" || typeof value.content !== "string" ||
          !Number.isSafeInteger(value.expiresAt) || value.expiresAt! <= this.now() || !this.resolve(value.fileHandle)) return null;
      return value.content;
    } catch {
      return null;
    }
  }

  private validate(value: string, moduleId: string, scopeId: string): string {
    if (!path.isAbsolute(value) || !moduleId || !scopeId) throw new Error("workflow_file_artifact_invalid");
    const info = fs.lstatSync(value);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MEDIA_ARTIFACT_BYTES) throw new Error("workflow_file_artifact_invalid");
    const absolutePath = fs.realpathSync(value);
    this.permissions.assertAllowed({ moduleId, access: "read", scopeId, absolutePath });
    return absolutePath;
  }

  private cleanupSnapshots(): void {
    const snapshotRoot = path.join(this.root, "snapshots");
    if (!fs.existsSync(snapshotRoot)) return;
    const referenced = new Set<string>();
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !HANDLE.test(path.basename(entry.name, ".json")) ||
          path.extname(entry.name) !== ".json") continue;
      const descriptor = path.join(this.root, entry.name);
      try {
        const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as Partial<StoredSnapshot>;
        if (value.version !== 2 || typeof value.absolutePath !== "string") continue;
        if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt! <= this.now()) {
          fs.unlinkSync(descriptor);
          continue;
        }
        const absolutePath = this.validateSnapshot(value as StoredSnapshot);
        if (isInside(snapshotRoot, absolutePath)) referenced.add(absolutePath);
      } catch {
        // Invalid descriptors cannot authorize a snapshot, so the scan treats it as orphaned.
      }
    }
    const directories: string[] = [];
    const pending = [snapshotRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      directories.push(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          pending.push(absolutePath);
        } else if (entry.isFile() && !entry.isSymbolicLink() && isSnapshotFileName(entry.name) &&
            !referenced.has(fs.realpathSync(absolutePath))) {
          fs.unlinkSync(absolutePath);
        }
      }
    }
    for (const directory of directories.reverse()) {
      if (directory !== snapshotRoot) {
        try { fs.rmdirSync(directory); } catch { /* non-empty directories remain */ }
      }
    }
  }

  private validateSnapshot(input: { absolutePath: string; fileName: string; sha256: string; sizeBytes: number }): string {
    if (!path.isAbsolute(input.absolutePath) || path.basename(input.fileName) !== input.fileName ||
        !input.fileName || hasControl(input.fileName) || !/^[a-f0-9]{64}$/u.test(input.sha256) ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_MEDIA_ARTIFACT_BYTES) {
      throw new Error("workflow_file_snapshot_invalid");
    }
    const snapshotRoot = path.join(fs.realpathSync(this.root), "snapshots");
    const absolutePath = fs.realpathSync(input.absolutePath);
    const relative = path.relative(snapshotRoot, absolutePath);
    const info = fs.lstatSync(absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== input.sizeBytes || relative === ".." ||
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("workflow_file_snapshot_invalid");
    }
    const digest = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    if (digest !== input.sha256) throw new Error("workflow_file_snapshot_invalid");
    return absolutePath;
  }

  private write(handle: string, stored: StoredFile | StoredSnapshot): void {
    this.writeJson(handle, stored);
  }

  private writeJson(
    handle: string,
    stored: StoredFile | StoredSnapshot | StoredQuery | StoredSearchPlan | StoredLegacyQueryV4 | StoredContent,
  ): void {
    const destination = path.join(this.root, `${handle}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  }

  private readQuery(handle: string): StoredQuery | null {
    const stored = this.readSearchRequest(handle);
    return stored?.version === 1 ? stored : null;
  }

  private readSearchRequest(handle: string): StoredQuery | StoredSearchPlan | StoredLegacyQueryV3 | StoredLegacyQueryV4 | null {
    try {
      if (!QUERY_HANDLE.test(handle)) return null;
      const file = path.join(this.root, `${handle}.json`);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= this.now()) return null;
      if (value.version === 1 && typeof value.query === "string") return value as StoredQuery;
      if (value.version === 2) {
        return {
          version: 2,
          plan: parseWorkflowFileSearchPlan(value.plan),
          expiresAt: value.expiresAt as number,
        };
      }
      if (value.version === 3 && typeof value.query === "string" &&
          new Set(["best_match", "latest", "all_matches"]).has(String(value.selectionPolicy))) {
        return {
          version: 3,
          query: value.query,
          selectionPolicy: value.selectionPolicy as LegacySelectionPolicy,
          expiresAt: value.expiresAt as number,
        };
      }
      if (value.version === 4 && typeof value.query === "string" &&
          new Set(["best_match", "latest", "all_matches"]).has(String(value.selectionPolicy)) &&
          new Set(["downloads", "pictures", "documents", "any_authorized"]).has(String(value.scopePolicy))) {
        return {
          version: 4,
          query: value.query,
          selectionPolicy: value.selectionPolicy as LegacySelectionPolicy,
          scopePolicy: value.scopePolicy as LegacyScopePolicy,
          expiresAt: value.expiresAt as number,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private read(handle: string): StoredFile | StoredSnapshot | null {
    const file = path.join(this.root, `${handle}.json`);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= this.now() ||
        typeof value.absolutePath !== "string") return null;
    if (value.version === 1 && typeof value.moduleId === "string" && typeof value.scopeId === "string") return value as StoredFile;
    if (value.version === 2 && typeof value.fileName === "string" && typeof value.sha256 === "string" &&
        Number.isSafeInteger(value.sizeBytes)) return value as StoredSnapshot;
    return null;
  }
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function isInside(root: string, value: string): boolean {
  const relative = path.relative(fs.realpathSync(root), value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSnapshotFileName(value: string): boolean {
  return /^[a-f0-9]{32}(?:\.[^./\\]+)?$/u.test(value);
}
