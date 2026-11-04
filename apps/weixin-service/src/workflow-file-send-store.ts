import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { LocalFileSendCandidate } from "./local-file-tools.js";

const HANDLE = /^sendmanifest_[a-f0-9]{32}$/u;
const CANDIDATE_REF = /^sendcandidate_[a-f0-9]{32}$/u;

export type WorkflowFileSendPublicCandidate = {
  candidateRef: string;
  fileName: string;
  displayPath: string;
  sizeBytes: number;
  modifiedAt: number;
};

export type WorkflowFileSendCandidate = WorkflowFileSendPublicCandidate & {
  source: LocalFileSendCandidate;
  snapshotHandle?: string;
};

export type WorkflowFileSendManifest = {
  version: 1;
  accountRef: string;
  targetRef: string;
  eventKey: string;
  allowMultiple: boolean;
  candidates: WorkflowFileSendCandidate[];
  preselectedRefs: string[];
  expiresAt: number;
};

export class WorkflowFileSendStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 24 * 60 * 60 * 1_000,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }

  capture(input: {
    accountRef: string;
    targetRef: string;
    eventKey: string;
    allowMultiple: boolean;
    candidates: Array<{ source: LocalFileSendCandidate; snapshotHandle?: string }>;
    selected: boolean;
  }): { handle: string; expiresAt: number } {
    if (!input.accountRef || !input.targetRef || !input.eventKey || typeof input.allowMultiple !== "boolean" ||
        !Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 20 ||
        (!input.selected && input.candidates.length < 2) ||
        (input.selected && input.candidates.some((candidate) => !candidate.snapshotHandle)) ||
        (!input.selected && input.candidates.some((candidate) => candidate.snapshotHandle !== undefined))) {
      throw new Error("workflow_file_send_manifest_invalid");
    }
    const candidates = input.candidates.map((candidate): WorkflowFileSendCandidate => {
      validateSource(candidate.source);
      return {
        candidateRef: `sendcandidate_${crypto.randomBytes(16).toString("hex")}`,
        fileName: candidate.source.fileName,
        displayPath: candidate.source.displayPath,
        sizeBytes: candidate.source.sizeBytes,
        modifiedAt: candidate.source.modifiedAt,
        source: structuredClone(candidate.source),
        ...(candidate.snapshotHandle ? { snapshotHandle: candidate.snapshotHandle } : {}),
      };
    });
    const handle = `sendmanifest_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    const manifest: WorkflowFileSendManifest = {
      version: 1,
      accountRef: input.accountRef,
      targetRef: input.targetRef,
      eventKey: input.eventKey,
      allowMultiple: input.allowMultiple,
      candidates,
      preselectedRefs: input.selected ? candidates.map((candidate) => candidate.candidateRef) : [],
      expiresAt,
    };
    this.write(handle, manifest);
    return { handle, expiresAt };
  }

  resolve(handle: string, accountRef: string, targetRef: string): WorkflowFileSendManifest | null {
    if (!HANDLE.test(handle)) return null;
    try {
      const manifest = this.read(handle);
      if (!manifest || manifest.expiresAt <= this.now() || manifest.accountRef !== accountRef ||
          manifest.targetRef !== targetRef) return null;
      return structuredClone(manifest);
    } catch {
      return null;
    }
  }

  publicCandidates(manifest: WorkflowFileSendManifest): WorkflowFileSendPublicCandidate[] {
    return manifest.candidates.map(({ candidateRef, fileName, displayPath, sizeBytes, modifiedAt }) => ({
      candidateRef, fileName, displayPath, sizeBytes, modifiedAt,
    }));
  }

  commitSnapshots(
    handle: string,
    accountRef: string,
    targetRef: string,
    snapshots: Array<{ candidateRef: string; snapshotHandle: string }>,
  ): WorkflowFileSendManifest {
    const manifest = this.resolve(handle, accountRef, targetRef);
    if (!manifest || snapshots.length < 1 || new Set(snapshots.map((entry) => entry.candidateRef)).size !== snapshots.length) {
      throw new Error("workflow_file_send_manifest_unavailable");
    }
    const byRef = new Map(snapshots.map((entry) => [entry.candidateRef, entry.snapshotHandle]));
    if (snapshots.some((entry) => !CANDIDATE_REF.test(entry.candidateRef) || !entry.snapshotHandle) ||
        [...byRef.keys()].some((candidateRef) => !manifest.candidates.some((candidate) => candidate.candidateRef === candidateRef))) {
      throw new Error("workflow_file_send_manifest_invalid");
    }
    const candidates = manifest.candidates.map((candidate) => {
      const snapshotHandle = byRef.get(candidate.candidateRef);
      if (!snapshotHandle) return candidate;
      if (candidate.snapshotHandle && candidate.snapshotHandle !== snapshotHandle) {
        throw new Error("workflow_file_send_manifest_conflict");
      }
      return { ...candidate, snapshotHandle };
    });
    const updated = { ...manifest, candidates };
    this.write(handle, updated);
    return structuredClone(updated);
  }

  private write(handle: string, manifest: WorkflowFileSendManifest): void {
    const destination = path.join(this.root, `${handle}.json`);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
    const file = fs.openSync(temporary, fs.constants.O_RDONLY);
    try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
    fs.renameSync(temporary, destination);
    const directory = fs.openSync(this.root, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }

  private read(handle: string): WorkflowFileSendManifest | null {
    const file = path.join(this.root, `${handle}.json`);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorkflowFileSendManifest>;
    if (value.version !== 1 || typeof value.accountRef !== "string" || typeof value.targetRef !== "string" ||
        typeof value.eventKey !== "string" || typeof value.allowMultiple !== "boolean" ||
        !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 20 ||
        !Array.isArray(value.preselectedRefs) || !Number.isSafeInteger(value.expiresAt)) return null;
    for (const candidate of value.candidates) {
      if (!candidate || !CANDIDATE_REF.test(candidate.candidateRef) || typeof candidate.fileName !== "string" ||
          typeof candidate.displayPath !== "string" || !Number.isFinite(candidate.sizeBytes) ||
          !Number.isFinite(candidate.modifiedAt) || (candidate.snapshotHandle !== undefined && typeof candidate.snapshotHandle !== "string")) {
        return null;
      }
      validateSource(candidate.source);
    }
    if (value.preselectedRefs.some((ref) => typeof ref !== "string" ||
        !value.candidates!.some((candidate) => candidate.candidateRef === ref))) return null;
    return value as WorkflowFileSendManifest;
  }
}

function validateSource(source: LocalFileSendCandidate): void {
  if (!source || typeof source !== "object" || !source.moduleId || !Number.isSafeInteger(source.moduleRevision) ||
      source.moduleRevision < 1 || !source.scopeId || !source.relativePath || path.isAbsolute(source.relativePath) ||
      path.basename(source.fileName) !== source.fileName || !source.fileName || hasControl(source.fileName) ||
      !source.displayPath || source.displayPath.length > 4_096 || !Number.isSafeInteger(source.sizeBytes) ||
      source.sizeBytes < 0 || !Number.isFinite(source.modifiedAt)) {
    throw new Error("workflow_file_send_manifest_invalid");
  }
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
