import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import type { LocalDiagnostics } from "./local-diagnostics.js";
import { SandboxInstrumentation, sandboxDiagnosticError, type SandboxWorkerInstrumentation } from "./sandbox-instrumentation.js";
import { consumeSandboxTelemetry, sandboxTelemetryPreload } from "./sandbox-telemetry-channel.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_DEADLINE_MS = 5_000;

export type FileSandboxAccessSnapshot = {
  accountId: string;
  moduleId: string;
  revision: number;
  scopes: Array<{
    scopeRef: string;
    scopeId: string;
    label: string;
    directory: string;
    read: boolean;
    write: boolean;
  }>;
  spoolDirectory: string;
  deniedRoots?: string[];
};

export type FileSandboxFindOperation = {
  type: "find";
  query?: string;
  scopeRefs?: string[];
  include?: string[];
  exclude?: string[];
  kind?: "any" | "file" | "directory";
  match?: "literal" | "fuzzy";
  case?: "smart" | "sensitive" | "insensitive";
  sort?: {
    field: "relevance" | "modified_at" | "name" | "path";
    direction: "asc" | "desc";
  };
  limit?: number;
  cursor?: string;
  batchSize?: number;
  metadataConcurrency?: number;
  scanCursor?: string;
  cancelScan?: boolean;
  budget?: FileSandboxTraversalBudget;
};

export type FileSandboxTraversalBudget = {
  maxScannedEntries: number;
  maxScannedFiles: number;
  maxScannedBytes: number;
  maxGrepBytes?: number;
};

export type FileSandboxFindResult = {
  entries: Array<{
    scopeRef: string;
    fileName: string;
    relativePath: string;
    kind: "file" | "directory";
    sizeBytes: number;
    modifiedAt: number;
    relevanceScore: number;
  }>;
  scanComplete: boolean;
  resultTruncated: boolean;
  scannedEntries: number;
  scannedFiles: number;
  scannedBytes: number;
  cursor?: string;
  scanCursor?: string;
};

export type FileSandboxGrepOperation = {
  type: "grep";
  pattern: string;
  scopeRefs?: string[];
  mode?: "literal" | "regex";
  case?: "smart" | "sensitive" | "insensitive";
  include?: string[];
  exclude?: string[];
  contextLines?: number;
  limit?: number;
  cursor?: string;
  budget?: FileSandboxTraversalBudget;
};

export type FileSandboxGrepResult = {
  matches: Array<{
    scopeRef: string;
    fileName: string;
    relativePath: string;
    line: number;
    text: string;
    before: string[];
    after: string[];
    sizeBytes: number;
    modifiedAt: number;
  }>;
  skipped: Array<{
    scopeRef: string;
    relativePath: string;
    reason: "binary" | "too_large" | "decode_failed";
  }>;
  scanComplete: boolean;
  resultTruncated: boolean;
  scannedEntries: number;
  scannedFiles: number;
  scannedBytes: number;
  grepBytes: number;
  cursor?: string;
};

export type FileSandboxReadOperation = {
  type: "read";
  scopeRef: string;
  relativePath: string;
  startLine?: number;
  maxLines?: number;
  maxCharacters?: number;
};

export type FileSandboxReadResult = {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  sha256: string;
  sizeBytes: number;
  modifiedAt: number;
};

export type FileSandboxInspectOperation = {
  type: "inspect";
  scopeRef: string;
  relativePath: string;
};

export type FileSandboxEditOperation = {
  type: "edit";
  scopeRef: string;
  relativePath: string;
  expectedSha256: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

export type FileSandboxPlanEditOperation = Omit<FileSandboxEditOperation, "type"> & { type: "plan_edit" };

export type FileSandboxWriteOperation = {
  type: "write";
  scopeRef: string;
  relativePath: string;
  content: string;
  overwrite: boolean;
  expectedSha256?: string;
};

export type FileSandboxSnapshotOperation = {
  type: "snapshot";
  scopeRef: string;
  relativePath: string;
  expectedSha256?: string;
  expectedSizeBytes?: number;
  expectedModifiedAt?: number;
};

export type FileSandboxSnapshotResult = {
  snapshotPath: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
};

export type FileSandboxMutationResult = {
  sha256: string;
  sizeBytes: number;
  modifiedAt: number;
  mode: number;
};

export type FileSandboxPreparedMutation = {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  mode: number;
};

export type FileSandboxCleanupOperation = {
  type: "cleanup_prepared";
  scopeRef: string;
  relativePath: string;
  prepared: FileSandboxPreparedMutation;
};

export type FileSandboxEditPlan = {
  beforeSha256: string;
  afterSha256: string;
  sizeBytes: number;
  mode: number;
};

export type FileSandboxOperation = FileSandboxFindOperation | FileSandboxGrepOperation | FileSandboxReadOperation | FileSandboxInspectOperation |
  FileSandboxPlanEditOperation | FileSandboxEditOperation | FileSandboxWriteOperation | FileSandboxSnapshotOperation | FileSandboxCleanupOperation;
export type FileSandboxResult = FileSandboxFindResult | FileSandboxGrepResult | FileSandboxReadResult |
  FileSandboxEditPlan | FileSandboxMutationResult | FileSandboxSnapshotResult | { removed: boolean };

type SandboxResponse = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  prepared?: unknown;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  preparation?: { relativePath: string; persist(value: FileSandboxPreparedMutation): void; received: boolean };
};

export class NodeFileSandbox {
  private readonly access: FileSandboxAccessSnapshot;
  private readonly workerPath: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private input = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private ready: Promise<ChildProcessWithoutNullStreams> | undefined;
  private closed = false;
  private closing?: Promise<void>;
  private readonly instrumentation: SandboxInstrumentation;
  private readonly observations = new WeakMap<ChildProcessWithoutNullStreams, SandboxWorkerInstrumentation>();

  constructor(access: FileSandboxAccessSnapshot, workerPath = fileURLToPath(new URL("./file-sandbox-worker.mjs", import.meta.url)), private readonly diagnostics?: LocalDiagnostics) {
    this.access = validateAccessSnapshot(access);
    this.workerPath = workerPath;
    this.instrumentation = new SandboxInstrumentation(diagnostics, this.access.moduleId);
  }

  async execute(operation: FileSandboxFindOperation): Promise<FileSandboxFindResult>;
  async execute(operation: FileSandboxGrepOperation): Promise<FileSandboxGrepResult>;
  async execute(operation: FileSandboxReadOperation): Promise<FileSandboxReadResult>;
  async execute(operation: FileSandboxInspectOperation): Promise<FileSandboxMutationResult>;
  async execute(operation: FileSandboxPlanEditOperation): Promise<FileSandboxEditPlan>;
  async execute(operation: FileSandboxEditOperation, persistPrepared?: (value: FileSandboxPreparedMutation) => void): Promise<FileSandboxMutationResult>;
  async execute(operation: FileSandboxWriteOperation, persistPrepared?: (value: FileSandboxPreparedMutation) => void): Promise<FileSandboxMutationResult>;
  async execute(operation: FileSandboxSnapshotOperation): Promise<FileSandboxSnapshotResult>;
  async execute(operation: FileSandboxCleanupOperation): Promise<{ removed: boolean }>;
  async execute(operation: FileSandboxOperation, persistPrepared?: (value: FileSandboxPreparedMutation) => void): Promise<FileSandboxResult> {
    validateOperation(operation);
    const child = await this.ensureReady();
    const requestId = crypto.randomUUID();
    return this.observations.get(child)!.observe("execute", requestId, operation.type, async () => {
      const preparation = persistPrepared && (operation.type === "edit" || operation.type === "write")
        ? { relativePath: operation.relativePath, persist: persistPrepared, received: false } : undefined;
      const result = await this.request(child, { type: "execute", operation: structuredClone(operation), prepareMutation: !!preparation },
        DEFAULT_DEADLINE_MS, preparation, requestId);
      if (operation.type === "cleanup_prepared") {
        if (!result || typeof result !== "object" || Object.keys(result).length !== 1 ||
            typeof (result as { removed?: unknown }).removed !== "boolean") throw new Error("file_sandbox_protocol_invalid");
        return result as { removed: boolean };
      }
      return operation.type === "find" ? validateFindResult(result)
        : operation.type === "grep" ? validateGrepResult(result)
          : operation.type === "read" ? validateReadResult(result)
            : operation.type === "plan_edit" ? validateEditPlan(result)
              : operation.type === "snapshot" ? validateSnapshotResult(result, this.access.spoolDirectory)
                : validateMutationResult(result);
    });
  }

  async verifyReadDenied(absolutePath: string): Promise<boolean> {
    if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
      throw new Error("file_sandbox_probe_invalid");
    }
    const child = await this.ensureReady();
    const requestId = crypto.randomUUID();
    return this.observations.get(child)!.observe("execute", requestId, "verify_read_denied", async () => {
      const result = await this.request(child, { type: "verify_read_denied", absolutePath }, DEFAULT_DEADLINE_MS, undefined, requestId);
      if (!result || typeof result !== "object" || Object.keys(result).length !== 1 ||
          typeof (result as { denied?: unknown }).denied !== "boolean") {
        throw new Error("file_sandbox_protocol_invalid");
      }
      return (result as { denied: boolean }).denied;
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.child = undefined;
    this.ready = undefined;
    this.input = Buffer.alloc(0);
    for (const child of this.children) this.observations.get(child)?.close();
    this.rejectPending("file_sandbox_closed");
    this.closing = Promise.all([...this.children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 1_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    })).then(() => {});
    return this.closing;
  }

  private async ensureReady(): Promise<ChildProcessWithoutNullStreams> {
    if (this.closed) throw new Error("file_sandbox_closed");
    if (!this.ready) {
      const ready = this.start();
      this.ready = ready;
      void ready.catch(() => {
        if (this.ready === ready) this.ready = undefined;
      });
    }
    return this.ready;
  }

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    const observation = this.instrumentation.worker();
    const requestId = crypto.randomUUID();
    return observation.observe("init", requestId, "init", () => this.startWorker(observation, requestId));
  }

  private async startWorker(observation: SandboxWorkerInstrumentation, requestId: string): Promise<ChildProcessWithoutNullStreams> {
    const telemetry = sandboxTelemetryPreload(this.diagnostics);
    const readable = [this.workerPath, ...this.access.scopes.filter((scope) => scope.read).map((scope) => scope.directory)];
    if (telemetry) readable.push(telemetry);
    const writable = [this.access.spoolDirectory, ...this.access.scopes.filter((scope) => scope.write).map((scope) => scope.directory)];
    const child = spawn(process.execPath, [
      "--permission",
      ...readable.map((directory) => `--allow-fs-read=${directory}`),
      ...writable.map((directory) => `--allow-fs-write=${directory}`),
      ...(telemetry ? ["--require", telemetry] : []),
      this.workerPath,
    ], {
      env: {},
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    observation.pid = child.pid;
    this.observations.set(child, observation);
    const channel = child.stdio[3];
    if (telemetry && this.diagnostics && channel instanceof Readable) consumeSandboxTelemetry(channel, this.diagnostics, child.pid, this.access.moduleId, observation.identity);
    else if (channel instanceof Readable) channel.resume();
    this.child = child;
    this.children.add(child);
    this.input = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.consume(child, chunk));
    child.stderr.on("data", () => {
      // Worker diagnostics are intentionally not forwarded because they can contain local paths.
    });
    child.stdin.on("error", () => this.invalidate(child, "file_sandbox_write_failed"));
    child.once("error", () => this.invalidate(child, "file_sandbox_start_failed"));
    child.once("exit", (code, signal) => {
      observation.exit(code, signal);
      this.invalidate(child, "file_sandbox_exited");
    });
    child.once("close", () => this.children.delete(child));
    const initialized = await this.request(child, { type: "init", access: this.access }, DEFAULT_DEADLINE_MS, undefined, requestId).catch((error: unknown) => {
      observation.invalidate(sandboxDiagnosticError(error), requestId);
      this.invalidate(child, "file_sandbox_start_failed");
      throw error;
    });
    if (!initialized || typeof initialized !== "object" || (initialized as { ready?: unknown }).ready !== true) {
      this.invalidate(child, "file_sandbox_protocol_invalid");
      throw new Error("file_sandbox_protocol_invalid");
    }
    return child;
  }

  private request(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>, deadlineMs = DEFAULT_DEADLINE_MS, preparation?: PendingRequest["preparation"], requestId: string = crypto.randomUUID()): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("file_sandbox_closed"));
    if (child !== this.child || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
      this.invalidate(child, "file_sandbox_unavailable");
      return Promise.reject(new Error("file_sandbox_unavailable"));
    }
    const body = Buffer.from(JSON.stringify({ requestId, ...payload }), "utf8");
    if (body.length > MAX_FRAME_BYTES) return Promise.reject(new Error("file_sandbox_request_too_large"));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.observations.get(child)?.timeout(requestId, deadlineMs);
        this.invalidate(child, "file_sandbox_timeout");
      }, deadlineMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer, ...(preparation ? { preparation } : {}) });
      child.stdin.write(frame, (error) => {
        if (!error) return;
        this.invalidate(child, "file_sandbox_write_failed", requestId);
      });
    });
  }

  private consume(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= 4) {
      const length = this.input.readUInt32BE(0);
      if (length < 2 || length > MAX_FRAME_BYTES) {
        this.invalidate(child, "file_sandbox_protocol_invalid");
        return;
      }
      if (this.input.length < length + 4) return;
      const body = this.input.subarray(4, length + 4);
      this.input = this.input.subarray(length + 4);
      let response: SandboxResponse;
      try {
        response = JSON.parse(body.toString("utf8")) as SandboxResponse;
      } catch {
        this.invalidate(child, "file_sandbox_protocol_invalid");
        return;
      }
      if (!response || typeof response.requestId !== "string" || typeof response.ok !== "boolean") continue;
      const pending = this.pending.get(response.requestId);
      if (!pending) continue;
      if (response.prepared !== undefined) {
        try {
          if (!pending.preparation || pending.preparation.received) throw new Error("file_sandbox_protocol_invalid");
          const prepared = validatePreparedMutation(response.prepared, pending.preparation.relativePath);
          pending.preparation.received = true;
          // Synchronous durable journal write must finish before the worker may replace the target.
          pending.preparation.persist(prepared);
          this.acknowledgePreparation(child, response.requestId, true);
        } catch (error) {
          this.acknowledgePreparation(child, response.requestId, false);
          this.pending.delete(response.requestId);
          clearTimeout(pending.timer);
          pending.reject(error instanceof Error ? error : new Error("file_sandbox_operation_failed"));
        }
        continue;
      }
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.ok && pending.preparation && !pending.preparation.received) pending.reject(new Error("file_sandbox_protocol_invalid"));
      else if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(safeWorkerError(response.error)));
    }
  }

  private invalidate(child: ChildProcessWithoutNullStreams, code: string, requestId?: string): void {
    // Child identity is the generation fence: late events from a retired worker
    // cannot reject requests or kill the replacement worker.
    if (child !== this.child) return;
    this.observations.get(child)?.invalidate(code, requestId);
    this.child = undefined;
    this.ready = undefined;
    this.input = Buffer.alloc(0);
    this.rejectPending(code);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private rejectPending(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pending.clear();
  }

  private acknowledgePreparation(child: ChildProcessWithoutNullStreams, requestId: string, commit: boolean): void {
    if (child !== this.child) return;
    const body = Buffer.from(JSON.stringify({ requestId, type: "prepared_ack", commit }));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    child.stdin.write(frame, (error) => { if (error) this.invalidate(child, "file_sandbox_write_failed"); });
  }
}

function validateAccessSnapshot(input: FileSandboxAccessSnapshot): FileSandboxAccessSnapshot {
  if (!input || typeof input !== "object" || !input.accountId || !input.moduleId ||
      !Number.isSafeInteger(input.revision) || input.revision < 1 || !Array.isArray(input.scopes) ||
      input.scopes.length > 64 || typeof input.spoolDirectory !== "string" || !path.isAbsolute(input.spoolDirectory)) {
    throw new Error("file_sandbox_access_invalid");
  }
  const seen = new Set<string>();
  if (input.deniedRoots !== undefined && (!Array.isArray(input.deniedRoots) || input.deniedRoots.length > 100 ||
      input.deniedRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root)))) {
    throw new Error("file_sandbox_access_invalid");
  }
  const scopes = input.scopes.map((scope) => {
    if (!scope || typeof scope.scopeRef !== "string" || !scope.scopeRef || seen.has(scope.scopeRef) ||
        typeof scope.scopeId !== "string" || !scope.scopeId || typeof scope.label !== "string" || !scope.label ||
        typeof scope.directory !== "string" || !path.isAbsolute(scope.directory) ||
        typeof scope.read !== "boolean" || typeof scope.write !== "boolean") {
      throw new Error("file_sandbox_access_invalid");
    }
    seen.add(scope.scopeRef);
    const info = fs.lstatSync(scope.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("file_sandbox_access_invalid");
    return { ...scope, directory: fs.realpathSync(scope.directory) };
  });
  fs.mkdirSync(input.spoolDirectory, { recursive: true, mode: 0o700 });
  const spoolInfo = fs.lstatSync(input.spoolDirectory);
  if (!spoolInfo.isDirectory() || spoolInfo.isSymbolicLink()) throw new Error("file_sandbox_access_invalid");
  return structuredClone({ ...input, scopes, spoolDirectory: fs.realpathSync(input.spoolDirectory) });
}

function validateOperation(input: FileSandboxOperation): void {
  if (!input || !new Set(["find", "grep", "read", "inspect", "plan_edit", "edit", "write", "snapshot", "cleanup_prepared"]).has(input.type)) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "cleanup_prepared") {
    if (!input.scopeRef || typeof input.relativePath !== "string" || !input.relativePath || path.isAbsolute(input.relativePath)) {
      throw new Error("file_sandbox_operation_invalid");
    }
    validatePreparedMutation(input.prepared, input.relativePath);
  }
  if ((input.type === "find" || input.type === "grep") && input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if ((input.type === "find" || input.type === "grep") && input.budget !== undefined &&
      (!positiveInteger(input.budget.maxScannedEntries) || !positiveInteger(input.budget.maxScannedFiles) ||
       !positiveInteger(input.budget.maxScannedBytes) ||
       (input.type === "grep" && !positiveInteger(input.budget.maxGrepBytes)))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "find" && input.query !== undefined && typeof input.query !== "string") {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "grep" && (typeof input.pattern !== "string" || input.pattern.length < 1)) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "read" && (typeof input.scopeRef !== "string" || !input.scopeRef ||
      typeof input.relativePath !== "string" || !input.relativePath || path.isAbsolute(input.relativePath) ||
      (input.startLine !== undefined && (!Number.isSafeInteger(input.startLine) || input.startLine < 1)) ||
      (input.maxCharacters !== undefined && (!Number.isSafeInteger(input.maxCharacters) || input.maxCharacters < 1 || input.maxCharacters > 100_000)) ||
      (input.maxLines !== undefined && (!Number.isSafeInteger(input.maxLines) || input.maxLines < 1 || input.maxLines > 500)))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "inspect" && (typeof input.scopeRef !== "string" || !input.scopeRef ||
      typeof input.relativePath !== "string" || !input.relativePath || path.isAbsolute(input.relativePath))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if ((input.type === "plan_edit" || input.type === "edit") && (typeof input.scopeRef !== "string" || !input.scopeRef ||
      typeof input.relativePath !== "string" || !input.relativePath || path.isAbsolute(input.relativePath) ||
      !/^[a-f0-9]{64}$/u.test(input.expectedSha256) || typeof input.oldText !== "string" || !input.oldText ||
      typeof input.newText !== "string" || (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean"))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "write" && (typeof input.scopeRef !== "string" || !input.scopeRef ||
      typeof input.relativePath !== "string" || !input.relativePath || path.isAbsolute(input.relativePath) ||
      typeof input.content !== "string" || typeof input.overwrite !== "boolean" ||
      (input.overwrite ? !/^[a-f0-9]{64}$/u.test(input.expectedSha256 ?? "") : input.expectedSha256 !== undefined))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  if (input.type === "snapshot" && (typeof input.scopeRef !== "string" || !input.scopeRef ||
      typeof input.relativePath !== "string" || !input.relativePath || path.isAbsolute(input.relativePath) ||
      (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) ||
      (input.expectedSizeBytes !== undefined && (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 0)) ||
      (input.expectedModifiedAt !== undefined && !Number.isFinite(input.expectedModifiedAt)))) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

function validateFindResult(value: unknown): FileSandboxFindResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_sandbox_protocol_invalid");
  const result = value as Partial<FileSandboxFindResult>;
  if (!Array.isArray(result.entries) || typeof result.scanComplete !== "boolean" ||
      typeof result.resultTruncated !== "boolean" || result.entries.length > 500 ||
      !nonNegativeInteger(result.scannedEntries) || !nonNegativeInteger(result.scannedFiles) ||
      !nonNegativeInteger(result.scannedBytes) ||
      (result.cursor !== undefined && typeof result.cursor !== "string") ||
      (result.scanCursor !== undefined && (typeof result.scanCursor !== "string" || result.scanComplete))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  for (const entry of result.entries) {
    if (!entry || typeof entry.scopeRef !== "string" || typeof entry.fileName !== "string" ||
        typeof entry.relativePath !== "string" || path.isAbsolute(entry.relativePath) ||
        (entry.kind !== "file" && entry.kind !== "directory") || !Number.isFinite(entry.sizeBytes) ||
        !Number.isFinite(entry.modifiedAt) || !Number.isFinite(entry.relevanceScore) || Object.keys(entry).some((key) =>
          !["scopeRef", "fileName", "relativePath", "kind", "sizeBytes", "modifiedAt", "relevanceScore"].includes(key))) {
      throw new Error("file_sandbox_protocol_invalid");
    }
  }
  if (Object.keys(result).some((key) => ![
    "entries", "scanComplete", "resultTruncated", "scannedEntries", "scannedFiles", "scannedBytes", "cursor", "scanCursor",
  ].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(result as FileSandboxFindResult);
}

function validateGrepResult(value: unknown): FileSandboxGrepResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_sandbox_protocol_invalid");
  const result = value as Partial<FileSandboxGrepResult>;
  if (!Array.isArray(result.matches) || !Array.isArray(result.skipped) ||
      typeof result.scanComplete !== "boolean" || typeof result.resultTruncated !== "boolean" ||
      result.matches.length > 500 || result.skipped.length > 100 ||
      !nonNegativeInteger(result.scannedEntries) || !nonNegativeInteger(result.scannedFiles) ||
      !nonNegativeInteger(result.scannedBytes) || !nonNegativeInteger(result.grepBytes) ||
      (result.cursor !== undefined && typeof result.cursor !== "string")) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  for (const match of result.matches) {
    if (!match || typeof match.scopeRef !== "string" || typeof match.fileName !== "string" ||
        typeof match.relativePath !== "string" || path.isAbsolute(match.relativePath) ||
        !Number.isSafeInteger(match.line) || match.line < 1 || typeof match.text !== "string" ||
        !Array.isArray(match.before) || !match.before.every((line) => typeof line === "string") ||
        !Array.isArray(match.after) || !match.after.every((line) => typeof line === "string") ||
        !nonNegativeInteger(match.sizeBytes) || !Number.isFinite(match.modifiedAt)) {
      throw new Error("file_sandbox_protocol_invalid");
    }
  }
  for (const skipped of result.skipped) {
    if (!skipped || typeof skipped.scopeRef !== "string" || typeof skipped.relativePath !== "string" ||
        path.isAbsolute(skipped.relativePath) ||
        !new Set(["binary", "too_large", "decode_failed"]).has(skipped.reason)) {
      throw new Error("file_sandbox_protocol_invalid");
    }
  }
  if (Object.keys(result).some((key) =>
    ![
      "matches", "skipped", "scanComplete", "resultTruncated", "scannedEntries", "scannedFiles",
      "scannedBytes", "grepBytes", "cursor",
    ].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(result as FileSandboxGrepResult);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateReadResult(value: unknown): FileSandboxReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_sandbox_protocol_invalid");
  const result = value as Partial<FileSandboxReadResult>;
  if (typeof result.content !== "string" || !Number.isSafeInteger(result.startLine) || result.startLine! < 1 ||
      !Number.isSafeInteger(result.endLine) || result.endLine! < result.startLine! ||
      !Number.isSafeInteger(result.totalLines) || result.totalLines! < result.endLine! ||
      typeof result.truncated !== "boolean" || typeof result.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(result.sha256) || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes! < 0 ||
      !Number.isFinite(result.modifiedAt) || Object.keys(result).some((key) =>
        !["content", "startLine", "endLine", "totalLines", "truncated", "sha256", "sizeBytes", "modifiedAt"].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(result as FileSandboxReadResult);
}

function validateMutationResult(value: unknown): FileSandboxMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_sandbox_protocol_invalid");
  const result = value as Partial<FileSandboxMutationResult>;
  if (typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.sha256) ||
      !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes! < 0 || !Number.isFinite(result.modifiedAt) ||
      !Number.isSafeInteger(result.mode) || result.mode! < 0 || result.mode! > 0o777 ||
      Object.keys(result).some((key) => !["sha256", "sizeBytes", "modifiedAt", "mode"].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(result as FileSandboxMutationResult);
}

function validatePreparedMutation(value: unknown, relativePath: string): FileSandboxPreparedMutation {
  const prepared = value as FileSandboxPreparedMutation | undefined;
  const prefix = `.${path.basename(relativePath)}.codex-`;
  if (!prepared || typeof prepared.fileName !== "string" || !prepared.fileName.startsWith(prefix) ||
      !/^[a-f0-9]{24}\.tmp$/u.test(prepared.fileName.slice(prefix.length)) ||
      !/^[a-f0-9]{64}$/u.test(prepared.sha256) || !nonNegativeInteger(prepared.sizeBytes) ||
      !nonNegativeInteger(prepared.dev) || !nonNegativeInteger(prepared.ino) ||
      !Number.isFinite(prepared.birthtimeMs) || !Number.isFinite(prepared.mtimeMs) ||
      !nonNegativeInteger(prepared.mode) || prepared.mode > 0o777 ||
      Object.keys(prepared).some((key) => !["fileName", "sha256", "sizeBytes", "dev", "ino", "birthtimeMs", "mtimeMs", "mode"].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(prepared);
}

function validateEditPlan(value: unknown): FileSandboxEditPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_sandbox_protocol_invalid");
  const result = value as Partial<FileSandboxEditPlan>;
  if (typeof result.beforeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.beforeSha256) ||
      typeof result.afterSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.afterSha256) ||
      !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes! < 0 ||
      !Number.isSafeInteger(result.mode) || result.mode! < 0 || result.mode! > 0o777 ||
      Object.keys(result).some((key) => !["beforeSha256", "afterSha256", "sizeBytes", "mode"].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(result as FileSandboxEditPlan);
}

function validateSnapshotResult(value: unknown, spoolDirectory: string): FileSandboxSnapshotResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_sandbox_protocol_invalid");
  const result = value as Partial<FileSandboxSnapshotResult>;
  if (typeof result.snapshotPath !== "string" || !path.isAbsolute(result.snapshotPath) ||
      !isInsidePath(result.snapshotPath, spoolDirectory) || typeof result.fileName !== "string" || !result.fileName ||
      typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.sha256) ||
      !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes! < 0 ||
      Object.keys(result).some((key) => !["snapshotPath", "fileName", "sha256", "sizeBytes"].includes(key))) {
    throw new Error("file_sandbox_protocol_invalid");
  }
  return structuredClone(result as FileSandboxSnapshotResult);
}

function isInsidePath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeWorkerError(value: unknown): string {
  return typeof value === "string" && /^file_sandbox_[a-z0-9_]+$/u.test(value)
    ? value
    : "file_sandbox_operation_failed";
}
