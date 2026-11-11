import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileQueryScheduler } from "./file-query-scheduler.js";
import { settleCleanup } from "./async-cleanup.js";

import {
  NodeFileSandbox,
  type FileSandboxFindOperation,
  type FileSandboxFindResult,
  type FileSandboxGrepOperation,
  type FileSandboxGrepResult,
} from "./file-sandbox.js";
import { LocalFileOperationStore, type LocalFileOperationRecord } from "./local-file-operation-store.js";
import { narrowingRootsBelow, type NarrowingRoots, type WorkflowModulePermissionState } from "./workflow-module-permission-store.js";
import type {
  InlineWorkflowToolExecutor,
  TrustedWorkflowTurn,
  WorkflowToolRequest,
} from "./workflow-tool-host.js";

type PermissionSource = {
  get(moduleId: string): WorkflowModulePermissionState | undefined;
};

type LocalFileToolsBudget = {
  maxCalls: number;
  maxScannedEntries: number;
  maxScannedFiles: number;
  maxScannedBytes: number;
  maxGrepBytes: number;
  maxResultItems: number;
  maxReadFiles: number;
  maxReadCharacters: number;
  maxWriteBytes: number;
  maxSnapshotBytes: number;
  maxWallClockMs: number;
};

type ScopeBinding = {
  moduleId: string;
  moduleRevision: number;
  scopeRef: string;
  scopeId: string;
  label: string;
  directory: string;
  read: boolean;
  write: boolean;
  /** The directories below this grant that a saved scope closed or left read-only when the turn was bound. */
  closedRoots: string[];
  readOnlyRoots: string[];
};

type FileBinding = {
  incompleteSearch: boolean;
  fileRef: string;
  moduleId: string;
  moduleRevision: number;
  scopeRef: string;
  relativePath: string;
  fileName: string;
  kind: "file" | "directory";
  sizeBytes: number;
  modifiedAt: number;
};

type TurnSession = {
  eventKey: string;
  dispatchRequestId?: string;
  dispatchRetry?: boolean;
  accountId: string;
  scopes: Map<string, ScopeBinding>;
  sandboxes: Map<string, NodeFileSandbox>;
  files: Map<string, FileBinding>;
  fileRefsByIdentity: Map<string, string>;
  cursors: Map<string, { toolId: "files.find" | "files.grep"; queryHash: string; offset: number }>;
  traversalTail: Promise<void>;
  abort: AbortController;
  queueWaitMs: number;
  executionWallClockMs: number;
  activeCalls: number;
  activeSince: number;
  calls: number;
  scannedEntries: number;
  scannedFiles: number;
  scannedBytes: number;
  grepBytes: number;
  resultItems: number;
  readCharacters: number;
  reservedReadCharacters: number;
  readFiles: Set<string>;
  writeBytes: number;
};

export type LocalFileToolsTurnBinding = {
  promptLines: string[];
  release(): Promise<void>;
};

export type LocalFileSendSnapshot = {
  snapshotPath: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
};

export type LocalFileSendCandidate = {
  moduleId: string;
  moduleRevision: number;
  scopeId: string;
  relativePath: string;
  fileName: string;
  displayPath: string;
  sizeBytes: number;
  modifiedAt: number;
};

export class LocalFileTools implements InlineWorkflowToolExecutor {
  dispatchEvidence(requestId: string): { completed: number; unknown: number } {
    return this.operations.dispatchEvidence(requestId);
  }
  private closing: Promise<void> | undefined;
  private readonly diagnostics: import("./local-diagnostics.js").LocalDiagnostics | undefined;
  private readonly sessions = new Map<string, TurnSession>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly moduleIds: string[];
  private readonly spoolDirectory: string;
  private readonly budget: LocalFileToolsBudget;
  private readonly operations: LocalFileOperationStore;
  private readonly now: () => number;
  private readonly queryScheduler: FileQueryScheduler;
  private readonly maxQueryWaitMs: number;
  private readonly afterMutationDurable: () => void;
  private readonly afterMutationPrepared: () => void;
  private readonly protectedRoots: string[];

  constructor(
    private readonly permissions: PermissionSource,
    options: {
      moduleIds: string[];
      spoolDirectory: string;
      operationDatabasePath?: string;
      budget?: Partial<LocalFileToolsBudget>;
      queryScheduling?: { maxQueuedBatches?: number; maxWaitMs?: number };
      now?: () => number;
      afterMutationDurable?: () => void;
      afterMutationPrepared?: () => void;
      diagnostics?: import("./local-diagnostics.js").LocalDiagnostics | undefined;
      /** The service's own state, configuration and credentials; refused to every target, whatever the grant. */
      protectedRoots: string[];
    },
  ) {
    if (!Array.isArray(options.moduleIds) || options.moduleIds.length < 1 ||
        typeof options.spoolDirectory !== "string" || !path.isAbsolute(options.spoolDirectory) ||
        !Array.isArray(options.protectedRoots) || options.protectedRoots.length < 1) {
      throw new Error("local_file_tools_config_invalid");
    }
    this.moduleIds = [...new Set(options.moduleIds)];
    this.protectedRoots = options.protectedRoots.map(canonicalProtectedPath);
    this.diagnostics = options.diagnostics;
    this.spoolDirectory = options.spoolDirectory;
    this.operations = new LocalFileOperationStore(
      options.operationDatabasePath ?? path.join(options.spoolDirectory, "local-file-operations.sqlite"),
    );
    this.now = options.now ?? Date.now;
    this.queryScheduler = new FileQueryScheduler(options.queryScheduling?.maxQueuedBatches, this.now);
    this.maxQueryWaitMs = options.queryScheduling?.maxWaitMs ?? 60_000;
    if (!Number.isSafeInteger(this.maxQueryWaitMs) || this.maxQueryWaitMs < 1) throw new Error("local_file_tools_config_invalid");
    this.afterMutationDurable = options.afterMutationDurable ?? (() => {});
    this.afterMutationPrepared = options.afterMutationPrepared ?? (() => {});
    this.budget = {
      maxCalls: options.budget?.maxCalls ?? 24,
      maxScannedEntries: options.budget?.maxScannedEntries ?? 500_000,
      maxScannedFiles: options.budget?.maxScannedFiles ?? 250_000,
      maxScannedBytes: options.budget?.maxScannedBytes ?? 512 * 1024 * 1024,
      maxGrepBytes: options.budget?.maxGrepBytes ?? 64 * 1024 * 1024,
      maxResultItems: options.budget?.maxResultItems ?? 500,
      maxReadFiles: options.budget?.maxReadFiles ?? 20,
      maxReadCharacters: options.budget?.maxReadCharacters ?? 100_000,
      maxWriteBytes: options.budget?.maxWriteBytes ?? 16 * 1024 * 1024,
      maxSnapshotBytes: options.budget?.maxSnapshotBytes ?? 512 * 1024 * 1024,
      maxWallClockMs: options.budget?.maxWallClockMs ?? 60_000,
    };
    if (!Object.values(this.budget).every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("local_file_tools_config_invalid");
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.abort.abort();
    this.closing = settleCleanup([
      ...sessions.flatMap((session) => [...session.sandboxes.values()].map((sandbox) => () => sandbox.close())),
      () => this.operations.close(),
    ]);
    return this.closing;
  }

  bindTurn(trusted: TrustedWorkflowTurn): LocalFileToolsTurnBinding {
    if (this.closing) throw new Error("local_file_tools_closed");
    if (this.sessions.has(trusted.eventKey)) throw new Error("local_file_turn_already_bound");
    const scopes = new Map<string, ScopeBinding>();
    const sandboxes = new Map<string, NodeFileSandbox>();
    const saved = this.savedPermissions();
    for (const [moduleId, state] of saved.states) {
      const moduleScopes = state.scopes
        .filter((scope) => scope.read || scope.write)
        .map((scope) => ({
          moduleId,
          moduleRevision: state.revision,
          scopeRef: opaque("scoperef"),
          ...scope,
          read: scope.read || scope.write,
          ...narrowingRootsBelow(scope.directory, saved.scopes),
        }));
      if (moduleScopes.length === 0) continue;
      for (const scope of moduleScopes) scopes.set(scope.scopeRef, scope);
      sandboxes.set(moduleId, new NodeFileSandbox({
        accountId: trusted.accountId,
        moduleId,
        revision: state.revision,
        deniedRoots: this.protectedRoots,
        scopes: moduleScopes.map((scope) => ({
          scopeRef: scope.scopeRef,
          scopeId: scope.scopeId,
          label: scope.label,
          directory: scope.directory,
          read: scope.read,
          write: scope.write,
          ...canonicalRoots(scope),
        })),
        spoolDirectory: path.join(this.spoolDirectory, safeSegment(trusted.accountId), moduleId, String(state.revision)),
      }, undefined, this.diagnostics));
    }
    const session: TurnSession = {
      eventKey: trusted.eventKey,
      ...(trusted.dispatchRequestId ? { dispatchRequestId: trusted.dispatchRequestId } : {}),
      ...(trusted.dispatchRetry ? { dispatchRetry: true } : {}),
      accountId: trusted.accountId,
      scopes,
      sandboxes,
      files: new Map(),
      fileRefsByIdentity: new Map(),
      cursors: new Map(),
      traversalTail: Promise.resolve(),
      abort: new AbortController(),
      queueWaitMs: 0,
      executionWallClockMs: 0,
      activeCalls: 0,
      activeSince: 0,
      calls: 0,
      scannedEntries: 0,
      scannedFiles: 0,
      scannedBytes: 0,
      grepBytes: 0,
      resultItems: 0,
      readCharacters: 0,
      reservedReadCharacters: 0,
      readFiles: new Set(),
      writeBytes: 0,
    };
    this.sessions.set(trusted.eventKey, session);
    const promptLines = [...scopes.values()]
      .sort((left, right) => left.label.localeCompare(right.label) || left.scopeRef.localeCompare(right.scopeRef))
      .map((scope) => `${scope.scopeRef}: ${scope.label}（${scope.read ? "可读" : "不可读"}${scope.write ? "、可写" : "、不可写"}）`);
    let releasing: Promise<void> | undefined;
    return {
      promptLines,
      release: () => releasing ??= (async () => {
        session.abort.abort();
        await settleCleanup([...sandboxes.values()].map((sandbox) => () => sandbox.close()));
        if (this.sessions.get(trusted.eventKey) === session) this.sessions.delete(trusted.eventKey);
      })(),
    };
  }

  async execute(request: WorkflowToolRequest, trusted: TrustedWorkflowTurn): Promise<unknown> {
    const session = this.sessions.get(trusted.eventKey);
    if (!session || session.accountId !== trusted.accountId || session.abort.signal.aborted) throw new Error("local_file_turn_unavailable");
    this.assertTurnBudget(session);
    session.calls += 1;
    if (request.toolId === "files.find" && request.toolVersion === 2) {
      return this.serializeTraversal(session, () => this.find(session, request.arguments));
    }
    if (request.toolId === "files.grep" && request.toolVersion === 2) {
      return this.serializeTraversal(session, () => this.grep(session, request.arguments));
    }
    return this.executeTimed(session, async () => {
      if (request.toolId === "files.read" && request.toolVersion === 2) return await this.read(session, request.arguments);
      if (request.toolId === "files.edit" && request.toolVersion === 1) {
        return await this.serializeMutation(session.accountId, () => {
          this.assertExecutionTimeRemaining(session);
          return this.edit(session, request.arguments);
        });
      }
      if (request.toolId === "files.write" && request.toolVersion === 1) {
        return await this.serializeMutation(session.accountId, () => {
          this.assertExecutionTimeRemaining(session);
          return this.write(session, request.arguments);
        });
      }
      if (new Set(["files.find", "files.grep", "files.read", "files.edit", "files.write"]).has(request.toolId)) {
        throw new Error("local_file_tool_version_unsupported");
      }
      throw new Error("local_file_tool_unsupported");
    });
  }

  private async executeTimed<T>(session: TurnSession, operation: () => Promise<T>): Promise<T> {
    this.assertExecutionTimeRemaining(session);
    if (session.activeCalls++ === 0) session.activeSince = this.now();
    try { return await operation(); }
    finally {
      if (--session.activeCalls === 0) session.executionWallClockMs += Math.max(0, this.now() - session.activeSince);
    }
  }

  private async queryBatch<T>(session: TurnSession, scopeRefs: string[], type: "find" | "grep", operation: () => Promise<T>): Promise<T> {
    const requested = this.now();
    let started: number | undefined;
    let queueWaitMs = 0;
    let outcome = "failed";
    try {
      const result = await this.queryScheduler.run(session.abort.signal, this.maxQueryWaitMs - session.queueWaitMs, async (waited) => {
        queueWaitMs = waited;
        session.queueWaitMs += waited;
        started = this.now();
        this.assertGrantsCurrent(session, scopeRefs);
        try {
          const value = await this.executeTimed(session, operation);
          if (session.abort.signal.aborted) throw new Error("local_file_turn_unavailable");
          return value;
        } catch (error) {
          // A cancelled request can settle before its worker's close grace ends.
          if (session.abort.signal.aborted) await Promise.all([...session.sandboxes.values()].map((sandbox) => sandbox.close()));
          throw error;
        }
      });
      outcome = "succeeded";
      return result;
    } catch (error) {
      if (started === undefined) {
        queueWaitMs = Math.max(0, this.now() - requested);
        session.queueWaitMs += queueWaitMs;
      }
      outcome = error instanceof Error ? error.message : "failed";
      throw error;
    } finally {
      this.checkpoint("files.query.scheduling", { eventKey: session.eventKey, operation: type, queueWaitMs,
        executionMs: started === undefined ? 0 : Math.max(0, this.now() - started), outcome });
    }
  }

  private checkpoint(name: string, attributes: Record<string, unknown>): void {
    try { this.diagnostics?.checkpoint(name, attributes); } catch { /* Diagnostics never own query admission. */ }
  }

  async snapshotForSend(trusted: TrustedWorkflowTurn, fileRefs: string[]): Promise<LocalFileSendSnapshot[]> {
    return this.snapshotCandidates(trusted.accountId, this.describeForSend(trusted, fileRefs));
  }

  describeForSend(trusted: TrustedWorkflowTurn, fileRefs: string[]): LocalFileSendCandidate[] {
    const session = this.sessions.get(trusted.eventKey);
    if (!session || session.accountId !== trusted.accountId || !Array.isArray(fileRefs) || fileRefs.length < 1 ||
        fileRefs.length > 20 || new Set(fileRefs).size !== fileRefs.length) {
      throw new Error("local_file_reference_invalid");
    }
    return fileRefs.map((fileRef) => {
      const file = session.files.get(fileRef);
      const scope = file ? session.scopes.get(file.scopeRef) : undefined;
      if (!file || file.kind !== "file" || !scope?.read) throw new Error("local_file_reference_invalid");
      if (file.incompleteSearch) throw new Error("local_file_search_incomplete");
      if (session.fileRefsByIdentity.get(`${file.moduleId}\u0000${file.scopeRef}\u0000${file.relativePath}`) !== file.fileRef) {
        throw new Error("local_file_content_conflict");
      }
      return {
        moduleId: file.moduleId,
        moduleRevision: file.moduleRevision,
        scopeId: scope.scopeId,
        relativePath: file.relativePath,
        fileName: file.fileName,
        displayPath: `${scope.label}/${file.relativePath}`,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
      };
    });
  }

  async snapshotLegacyFile(
    accountId: string,
    input: { moduleId: string; scopeId: string; absolutePath: string },
  ): Promise<LocalFileSendSnapshot> {
    const state = this.permissions.get(input.moduleId);
    const scope = state?.scopes.find((candidate) => candidate.scopeId === input.scopeId && candidate.read);
    if (!state?.saved || !scope || !this.moduleIds.includes(input.moduleId)) throw new Error("local_file_permission_changed");
    const relative = path.relative(scope.directory, input.absolutePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("local_file_path_unsafe");
    }
    const info = fs.lstatSync(input.absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("local_file_path_unsafe");
    const relativePath = relative.split(path.sep).join("/");
    const snapshots = await this.snapshotCandidates(accountId, [{
      moduleId: input.moduleId, moduleRevision: state.revision, scopeId: input.scopeId,
      relativePath, fileName: path.basename(input.absolutePath), displayPath: `${scope.label}/${relativePath}`,
      sizeBytes: info.size, modifiedAt: info.mtimeMs,
    }]);
    return snapshots[0]!;
  }

  async snapshotCandidates(accountId: string, candidates: LocalFileSendCandidate[]): Promise<LocalFileSendSnapshot[]> {
    if (!accountId || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 20) {
      throw new Error("local_file_reference_invalid");
    }
    return this.serializeMutation(accountId, () => this.snapshotCandidatesWithinQuota(accountId, candidates));
  }

  private async snapshotCandidatesWithinQuota(
    accountId: string,
    candidates: LocalFileSendCandidate[],
  ): Promise<LocalFileSendSnapshot[]> {
    const accountSpool = path.join(this.spoolDirectory, safeSegment(accountId));
    const requestedBytes = candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0);
    if (!Number.isSafeInteger(requestedBytes) || directoryFileBytes(accountSpool) + requestedBytes > this.budget.maxSnapshotBytes) {
      throw new Error("local_file_snapshot_quota_exceeded");
    }
    const sandboxes = new Map<string, { sandbox: NodeFileSandbox; refs: Map<string, string> }>();
    const snapshots: LocalFileSendSnapshot[] = [];
    try {
      for (const candidate of candidates) {
        let runtime = sandboxes.get(candidate.moduleId);
        if (!runtime) {
          const state = this.permissions.get(candidate.moduleId);
          if (!state?.saved || state.revision !== candidate.moduleRevision) throw new Error("local_file_permission_changed");
          const readableScopes = state.scopes.filter((scope) => scope.read);
          const saved = this.savedPermissions().scopes;
          const refs = new Map(readableScopes.map((scope) => [scope.scopeId, opaque("sendscope")]));
          const sandbox = new NodeFileSandbox({
            accountId,
            moduleId: candidate.moduleId,
            revision: state.revision,
            deniedRoots: this.protectedRoots,
            scopes: readableScopes.map((scope) => ({ ...scope, scopeRef: refs.get(scope.scopeId)!,
              ...canonicalRoots(narrowingRootsBelow(scope.directory, saved)) })),
            spoolDirectory: path.join(this.spoolDirectory, safeSegment(accountId), candidate.moduleId, String(state.revision)),
          }, undefined, this.diagnostics);
          runtime = { sandbox, refs };
          sandboxes.set(candidate.moduleId, runtime);
        }
        const scopeRef = runtime.refs.get(candidate.scopeId);
        if (!scopeRef) throw new Error("local_file_permission_changed");
        const snapshot = await runtime.sandbox.execute({
          type: "snapshot",
          scopeRef,
          relativePath: candidate.relativePath,
          expectedSizeBytes: candidate.sizeBytes,
          expectedModifiedAt: candidate.modifiedAt,
        });
        durabilityBarrierAbsolute(snapshot.snapshotPath);
        snapshots.push(snapshot);
      }
      return snapshots;
    } catch (error) {
      for (const snapshot of snapshots) {
        try { fs.unlinkSync(snapshot.snapshotPath); } catch { /* incomplete preflight cleanup is best effort */ }
      }
      throw translateMutationError(error);
    } finally {
      await Promise.allSettled([...sandboxes.values()].map(async ({ sandbox }) => sandbox.close()));
    }
  }

  private async serializeTraversal<T>(session: TurnSession, operation: () => Promise<T>): Promise<T> {
    const previous = session.traversalTail;
    let release!: () => void;
    session.traversalTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      // Scans share aggregate traversal limits; another scan sees settled consumption.
      if (session.abort.signal.aborted) throw new Error("local_file_turn_unavailable");
      this.assertExecutionTimeRemaining(session);
      return await operation();
    } finally { release(); }
  }

  private async find(session: TurnSession, value: unknown): Promise<unknown> {
    const input = record(value);
    const requestedScopes = optionalStringArray(input.scopeRefs);
    const groups = groupScopes(session, requestedScopes, "read");
    const limit = integer(input.limit) ?? 20;
    const query = { ...input };
    delete query.cursor;
    delete query.limit;
    const queryHash = hashStable(query);
    const offset = this.resolveCursor(session, input.cursor, "files.find", queryHash);
    const fetchLimit = offset + limit;
    if (fetchLimit > 500) throw new Error("local_file_turn_budget_exhausted");
    const results: FileSandboxFindResult[] = [];
    let omittedGroups = false;
    for (const [moduleId, scopeRefs] of groups) {
      const remaining = this.remainingTraversalBudget(session, false);
      if (!remaining) {
        omittedGroups = true;
        break;
      }
      const sandbox = session.sandboxes.get(moduleId)!;
      let result: FileSandboxFindResult | undefined;
      let scanCursor: string | undefined;
      try {
        do {
          this.assertExecutionTimeRemaining(session);
          this.assertGrantsCurrent(session, scopeRefs);
          const batchBudget = this.remainingTraversalBudget(session, false);
          if (!batchBudget) { omittedGroups = true; break; }
          const started = this.now();
          const continuation = scanCursor;
          scanCursor = undefined;
          let dispatched = false;
          try {
            result = await this.queryBatch(session, scopeRefs, "find", () => {
              dispatched = true;
              return sandbox.execute({ ...query, type: "find", scopeRefs,
                limit: fetchLimit, budget: batchBudget, batchSize: 2048,
                ...(continuation ? { scanCursor: continuation } : {}),
              } as FileSandboxFindOperation);
            });
          } catch (error) {
            if (!dispatched) scanCursor = continuation;
            if (error instanceof Error && error.message === "file_sandbox_timeout") throw new Error("local_file_search_timeout");
            throw error;
          }
          scanCursor = result.scanCursor;
          this.consumeTraversal(session, result);
          this.assertGrantsCurrent(session, scopeRefs);
          this.checkpoint("files.find.batch", {
            scannedEntries: result.scannedEntries, scannedFiles: result.scannedFiles,
            elapsedMs: Math.max(0, this.now() - started), scanComplete: result.scanComplete,
            stopReason: result.scanComplete ? "complete" : scanCursor ? "yield" : "budget",
          });
        } while (scanCursor);
      } finally {
        if (scanCursor && !session.abort.signal.aborted) {
          await sandbox.execute({ ...query, type: "find", scopeRefs, limit: fetchLimit,
            batchSize: 2048, scanCursor, cancelScan: true } as FileSandboxFindOperation);
        }
      }
      if (!result) throw new Error("local_file_turn_budget_exhausted");
      results.push(result);
      if (omittedGroups || !result.scanComplete) {
        omittedGroups = true;
        break;
      }
    }
    const sort = input.sort && typeof input.sort === "object" && !Array.isArray(input.sort)
      ? input.sort as { field?: unknown; direction?: unknown }
      : undefined;
    for (const scopeRefs of groups.values()) this.assertGrantsCurrent(session, scopeRefs);
    const entries = results.flatMap((result) => result.entries);
    sortFindEntries(entries, sort?.field, sort?.direction, session.scopes);
    const page = entries.slice(offset, fetchLimit);
    const scanComplete = !omittedGroups && results.every((result) => result.scanComplete);
    const selected = page.map((entry) => ({
      fileRef: this.captureFile(session, entry, false, !scanComplete),
      scopeRef: entry.scopeRef,
      fileName: entry.fileName,
      relativePath: entry.relativePath,
      displayPath: `${session.scopes.get(entry.scopeRef)!.label}/${entry.relativePath}`,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
    }));
    const resultTruncated = entries.length > fetchLimit || results.some((result) => result.resultTruncated);
    this.consumeResults(session, selected.length);
    return {
      entries: selected,
      scanComplete,
      resultTruncated,
      ...(resultTruncated ? { cursor: this.createCursor(session, "files.find", queryHash, offset + selected.length) } : {}),
    };
  }

  /** What is saved now for the modules the file tools serve. A module that was never saved has no scope, so it narrows nothing. */
  private savedPermissions(): { states: Map<string, WorkflowModulePermissionState>; scopes: WorkflowModulePermissionState["scopes"] } {
    const states = new Map<string, WorkflowModulePermissionState>();
    for (const moduleId of this.moduleIds) {
      const state = this.permissions.get(moduleId);
      if (state?.saved) states.set(moduleId, state);
    }
    return { states, scopes: [...states.values()].flatMap((state) => state.scopes) };
  }

  /**
   * Refuses a call once what is saved differs from what the turn was bound to, for the grants the call addresses: the grant's
   * module was saved again, or the scopes saved below the grant narrow it differently (failure modes 4, 8 and 9).
   */
  private assertGrantsCurrent(session: TurnSession, scopeRefs: string[]): void {
    const saved = this.savedPermissions();
    for (const scopeRef of scopeRefs) {
      const scope = session.scopes.get(scopeRef)!;
      if (saved.states.get(scope.moduleId)?.revision !== scope.moduleRevision ||
          !sameRoots(narrowingRootsBelow(scope.directory, saved.scopes), scope)) {
        throw new Error("local_file_permission_changed");
      }
    }
  }

  private async grep(session: TurnSession, value: unknown): Promise<unknown> {
    const input = record(value);
    const requestedScopes = optionalStringArray(input.scopeRefs);
    const groups = groupScopes(session, requestedScopes, "read");
    const limit = integer(input.limit) ?? 20;
    const query = { ...input };
    delete query.cursor;
    delete query.limit;
    const queryHash = hashStable(query);
    const offset = this.resolveCursor(session, input.cursor, "files.grep", queryHash);
    const fetchLimit = offset + limit;
    if (fetchLimit > 500) throw new Error("local_file_turn_budget_exhausted");
    const results: FileSandboxGrepResult[] = [];
    let omittedGroups = false;
    for (const [moduleId, scopeRefs] of groups) {
      const remaining = this.remainingTraversalBudget(session, true);
      if (!remaining) {
        omittedGroups = true;
        break;
      }
      const sandbox = session.sandboxes.get(moduleId)!;
      const result = await this.queryBatch(session, scopeRefs, "grep", () => sandbox.execute({
        ...query,
        type: "grep",
        scopeRefs,
        limit: fetchLimit,
        budget: remaining,
      } as FileSandboxGrepOperation));
      this.assertGrantsCurrent(session, scopeRefs);
      results.push(result);
      this.consumeTraversal(session, result);
      if (!result.scanComplete) {
        omittedGroups = true;
        break;
      }
    }
    const scanComplete = !omittedGroups && results.every((result) => result.scanComplete);
    const matches = results.flatMap((result) => result.matches.map((match) => ({
      ...match,
      fileRef: this.captureFile(session, {
        ...match,
        kind: "file",
      }, false, !scanComplete),
    }))).sort((left, right) => stableCompare(left.relativePath, right.relativePath) ||
      left.line - right.line || compareScopeBindings(session.scopes, left.scopeRef, right.scopeRef));
    const selected = matches.slice(offset, fetchLimit).map((match) => ({
      fileRef: match.fileRef,
      scopeRef: match.scopeRef,
      fileName: match.fileName,
      relativePath: match.relativePath,
      displayPath: `${session.scopes.get(match.scopeRef)!.label}/${match.relativePath}`,
      line: match.line,
      text: match.text,
      before: match.before,
      after: match.after,
    }));
    const resultTruncated = matches.length > fetchLimit || results.some((result) => result.resultTruncated);
    this.consumeResults(session, selected.length);
    return {
      matches: selected,
      skipped: results.flatMap((result) => result.skipped.map((skipped) => ({
        scopeRef: skipped.scopeRef,
        displayPath: `${session.scopes.get(skipped.scopeRef)!.label}/${skipped.relativePath}`,
        reason: skipped.reason,
      }))),
      scanComplete,
      resultTruncated,
      ...(resultTruncated ? { cursor: this.createCursor(session, "files.grep", queryHash, offset + selected.length) } : {}),
    };
  }

  private resolveCursor(
    session: TurnSession,
    value: unknown,
    toolId: "files.find" | "files.grep",
    queryHash: string,
  ): number {
    if (value === undefined) return 0;
    const cursor = stringValue(value);
    const state = cursor ? session.cursors.get(cursor) : undefined;
    if (!state || state.toolId !== toolId || state.queryHash !== queryHash) {
      throw new Error("local_file_cursor_invalid");
    }
    return state.offset;
  }

  private createCursor(
    session: TurnSession,
    toolId: "files.find" | "files.grep",
    queryHash: string,
    offset: number,
  ): string {
    const cursor = opaque("cursor");
    session.cursors.set(cursor, { toolId, queryHash, offset });
    return cursor;
  }

  private assertTurnBudget(session: TurnSession): void {
    if (session.calls >= this.budget.maxCalls || session.scannedEntries >= this.budget.maxScannedEntries ||
        session.scannedFiles >= this.budget.maxScannedFiles || session.scannedBytes >= this.budget.maxScannedBytes ||
        session.grepBytes >= this.budget.maxGrepBytes || session.resultItems >= this.budget.maxResultItems ||
        session.readCharacters >= this.budget.maxReadCharacters || session.writeBytes >= this.budget.maxWriteBytes) {
      throw new Error("local_file_turn_budget_exhausted");
    }
    this.assertExecutionTimeRemaining(session);
  }

  private assertExecutionTimeRemaining(session: TurnSession): void {
    if (session.executionWallClockMs + (session.activeCalls > 0 ? Math.max(0, this.now() - session.activeSince) : 0) >= this.budget.maxWallClockMs) {
      throw new Error("local_file_turn_budget_exhausted");
    }
  }

  private remainingTraversalBudget(session: TurnSession, grepOperation: boolean): FileSandboxFindOperation["budget"] | undefined {
    const maxScannedEntries = this.budget.maxScannedEntries - session.scannedEntries;
    const maxScannedFiles = this.budget.maxScannedFiles - session.scannedFiles;
    const maxScannedBytes = this.budget.maxScannedBytes - session.scannedBytes;
    const maxGrepBytes = this.budget.maxGrepBytes - session.grepBytes;
    if (maxScannedEntries < 1 || maxScannedFiles < 1 || maxScannedBytes < 1 || (grepOperation && maxGrepBytes < 1)) {
      return undefined;
    }
    return {
      maxScannedEntries,
      maxScannedFiles,
      maxScannedBytes,
      ...(grepOperation ? { maxGrepBytes } : {}),
    };
  }

  private consumeTraversal(session: TurnSession, result: FileSandboxFindResult | FileSandboxGrepResult): void {
    session.scannedEntries += result.scannedEntries;
    session.scannedFiles += result.scannedFiles;
    if ("grepBytes" in result) {
      session.scannedBytes += result.scannedBytes;
      session.grepBytes += result.grepBytes;
    }
  }

  private async read(session: TurnSession, value: unknown): Promise<unknown> {
    const input = record(value);
    const fileRef = stringValue(input.fileRef);
    const file = fileRef ? session.files.get(fileRef) : undefined;
    if (!file || file.kind !== "file") throw new Error("local_file_reference_invalid");
    const sandbox = session.sandboxes.get(file.moduleId);
    if (!sandbox) throw new Error("local_file_reference_invalid");
    const startLine = integer(input.startLine);
    const maxLines = integer(input.maxLines);
    const identity = `${file.moduleId}\u0000${file.scopeRef}\u0000${file.relativePath}`;
    if (!session.readFiles.has(identity) && session.readFiles.size >= this.budget.maxReadFiles) {
      throw new Error("local_file_turn_budget_exhausted");
    }
    // Admit distinct files before dispatch; repeated pages retain the same admission.
    session.readFiles.add(identity);
    const available = this.budget.maxReadCharacters - session.readCharacters - session.reservedReadCharacters;
    const reservation = Math.min(100_000, Math.max(1, file.sizeBytes), available);
    if (reservation < 1) throw new Error("local_file_turn_budget_exhausted");
    session.reservedReadCharacters += reservation;
    try {
      this.assertGrantsCurrent(session, [file.scopeRef]);
      const result = await sandbox.execute({
        type: "read",
        scopeRef: file.scopeRef,
        relativePath: file.relativePath,
        ...(startLine ? { startLine } : {}),
        ...(maxLines ? { maxLines } : {}),
        maxCharacters: reservation,
      });
      session.readCharacters += Array.from(result.content).length;
      return { ...result, fileRef };
    } catch (error) {
      if (error instanceof Error && error.message === "file_sandbox_read_budget_exhausted") {
        throw new Error("local_file_turn_budget_exhausted");
      }
      if (error instanceof Error && error.message === "file_sandbox_permission_denied") throw new Error("local_file_permission_denied");
      throw error;
    } finally {
      session.reservedReadCharacters -= reservation;
    }
  }

  private async edit(session: TurnSession, value: unknown): Promise<unknown> {
    const input = record(value);
    const fileRef = stringValue(input.fileRef);
    const file = fileRef ? session.files.get(fileRef) : undefined;
    if (!file || file.kind !== "file") throw new Error("local_file_reference_invalid");
    const scope = session.scopes.get(file.scopeRef);
    const sandbox = session.sandboxes.get(file.moduleId);
    if (!scope?.read || !scope.write || !sandbox) throw new Error("local_file_permission_denied");
    const normalizedRequest = {
      kind: "edit",
      eventKey: session.eventKey,
      moduleId: file.moduleId,
      scopeId: scope.scopeId,
      relativePath: file.relativePath,
      expectedSha256: requiredSha256(input.expectedSha256),
      oldText: requiredString(input.oldText),
      newText: requiredString(input.newText, true),
      replaceAll: input.replaceAll === true,
    };
    const dispatch = dispatchMutationKeys(normalizedRequest);
    const replay = session.dispatchRequestId && session.dispatchRetry
      ? this.operations.dispatchReplay(session.dispatchRequestId, session.eventKey, dispatch.resource, dispatch.logical) : undefined;
    const requestHash = replay?.requestHash ?? hashStable(normalizedRequest);
    const operationKey = replay?.operationKey ?? hashStable({ event: normalizedRequest.eventKey, requestHash });
    const previous = replay ?? this.operations.get(operationKey);
    this.assertCurrentMutationAccess(scope, true);
    if (previous?.status === "completed" && previous.result) {
      await this.assertCompletedMutationCurrent(sandbox, scope, file.relativePath, previous.result);
      return this.restoreMutationResult(session, file.scopeRef, file.relativePath, file.fileName, previous.result);
    }
    if (session.fileRefsByIdentity.get(`${file.moduleId}\u0000${file.scopeRef}\u0000${file.relativePath}`) !== file.fileRef) {
      throw new Error("local_file_content_conflict");
    }
    const operation = {
      scopeRef: file.scopeRef,
      relativePath: file.relativePath,
      expectedSha256: normalizedRequest.expectedSha256,
      oldText: normalizedRequest.oldText,
      newText: normalizedRequest.newText,
      ...(typeof input.replaceAll === "boolean" ? { replaceAll: input.replaceAll } : {}),
    };
    let planned = previous?.planned;
    if (!planned) {
      try {
        const plan = await sandbox.execute({ type: "plan_edit", ...operation });
        planned = { sha256: plan.afterSha256, sizeBytes: plan.sizeBytes, mode: plan.mode };
      } catch (error) {
        throw translateMutationError(error);
      }
    }
    this.consumeWriteBytes(session, planned.sizeBytes);
    this.operations.start(operationKey, requestHash, planned);
    if (session.dispatchRequestId) this.operations.bindDispatch(session.dispatchRequestId, session.eventKey, dispatch.resource, dispatch.logical, operationKey);
    if (previous?.status === "started") {
      const reconciled = await this.reconcileStartedMutation(
        sandbox,
        scope,
        file.relativePath,
        normalizedRequest.expectedSha256,
        previous,
        { changed: true },
      );
      if (reconciled) return this.restoreMutationResult(session, file.scopeRef, file.relativePath, file.fileName, reconciled);
    }
    let result;
    try {
      result = await sandbox.execute({
        type: "edit",
        ...operation,
      }, (prepared) => {
        this.operations.prepare(operationKey, requestHash, prepared);
        this.afterMutationPrepared();
      });
    } catch (error) {
      throw translateMutationError(error);
    }
    durabilityBarrier(scope.directory, file.relativePath);
    this.afterMutationDurable();
    const completed = { ...result, changed: true };
    this.operations.complete(operationKey, requestHash, completed);
    return this.restoreMutationResult(session, file.scopeRef, file.relativePath, file.fileName, completed);
  }

  private async write(session: TurnSession, value: unknown): Promise<unknown> {
    const input = record(value);
    const scopeRef = requiredString(input.scopeRef);
    const scope = session.scopes.get(scopeRef);
    if (!scope) throw new Error("local_file_reference_invalid");
    const sandbox = scope ? session.sandboxes.get(scope.moduleId) : undefined;
    if (!scope?.write || !sandbox) throw new Error("local_file_permission_denied");
    // Everything below, the operation journal's keys included, uses the path below the root.
    const relativePath = pathBelowRoot(scope, requiredRelativePath(input.relativePath));
    const overwrite = input.overwrite;
    if (typeof overwrite !== "boolean") throw new Error("local_file_tool_arguments_invalid");
    if (overwrite && !scope.read) throw new Error("local_file_permission_denied");
    const normalizedRequest = {
      kind: "write",
      eventKey: session.eventKey,
      moduleId: scope.moduleId,
      scopeId: scope.scopeId,
      relativePath,
      content: requiredString(input.content, true),
      overwrite,
      expectedSha256: overwrite ? requiredSha256(input.expectedSha256) : null,
    };
    const dispatch = dispatchMutationKeys(normalizedRequest);
    const replay = session.dispatchRequestId && session.dispatchRetry
      ? this.operations.dispatchReplay(session.dispatchRequestId, session.eventKey, dispatch.resource, dispatch.logical) : undefined;
    const requestHash = replay?.requestHash ?? hashStable(normalizedRequest);
    const operationKey = replay?.operationKey ?? hashStable({ event: normalizedRequest.eventKey, requestHash });
    const previous = replay ?? this.operations.get(operationKey);
    this.assertCurrentMutationAccess(scope, overwrite);
    if (previous?.status === "completed" && previous.result) {
      await this.assertCompletedMutationCurrent(sandbox, scope, relativePath, previous.result);
      return this.restoreMutationResult(session, scopeRef, relativePath, path.basename(relativePath), previous.result);
    }
    const content = normalizedRequest.content;
    const planned = previous?.planned ?? {
      sha256: crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      mode: overwrite ? currentMode(scope.directory, relativePath) : 0o600,
    };
    this.consumeWriteBytes(session, planned.sizeBytes);
    this.operations.start(operationKey, requestHash, planned);
    if (session.dispatchRequestId) this.operations.bindDispatch(session.dispatchRequestId, session.eventKey, dispatch.resource, dispatch.logical, operationKey);
    if (previous?.status === "started") {
      const reconciled = await this.reconcileStartedMutation(
        sandbox,
        scope,
        relativePath,
        overwrite ? normalizedRequest.expectedSha256! : undefined,
        previous,
        { created: !overwrite },
      );
      if (reconciled) return this.restoreMutationResult(session, scopeRef, relativePath, path.basename(relativePath), reconciled);
    }
    let result;
    try {
      result = await sandbox.execute({
        type: "write",
        scopeRef,
        relativePath,
        content: requiredString(input.content, true),
        overwrite,
        ...(overwrite ? { expectedSha256: requiredSha256(input.expectedSha256) } : {}),
      }, (prepared) => {
        this.operations.prepare(operationKey, requestHash, prepared);
        this.afterMutationPrepared();
      });
    } catch (error) {
      throw translateMutationError(error);
    }
    durabilityBarrier(scope.directory, relativePath);
    this.afterMutationDurable();
    const completed = { ...result, created: !overwrite };
    this.operations.complete(operationKey, requestHash, completed);
    return this.restoreMutationResult(session, scopeRef, relativePath, path.basename(relativePath), completed);
  }

  private async assertCompletedMutationCurrent(
    sandbox: NodeFileSandbox,
    scope: ScopeBinding,
    relativePath: string,
    result: NonNullable<LocalFileOperationRecord["result"]>,
  ): Promise<void> {
    try {
      const current = await sandbox.execute({ type: "inspect", scopeRef: scope.scopeRef, relativePath });
      if (current.sha256 !== result.sha256 || current.sizeBytes !== result.sizeBytes || current.modifiedAt !== result.modifiedAt) {
        throw new Error("local_file_content_conflict");
      }
    } catch (error) {
      throw translateMutationError(error);
    }
  }

  private assertCurrentMutationAccess(scope: ScopeBinding, requiresRead: boolean): void {
    const saved = this.savedPermissions();
    const state = saved.states.get(scope.moduleId);
    const current = state?.scopes.find((candidate) => candidate.scopeId === scope.scopeId);
    if (!state || state.revision !== scope.moduleRevision || !current?.write ||
        (requiresRead && !(current.read || current.write)) || current.directory !== scope.directory ||
        !sameRoots(narrowingRootsBelow(scope.directory, saved.scopes), scope)) {
      throw new Error("local_file_permission_changed");
    }
  }

  private restoreMutationResult(
    session: TurnSession,
    scopeRef: string,
    relativePath: string,
    fileName: string,
    result: NonNullable<LocalFileOperationRecord["result"]>,
  ): unknown {
    const currentRef = session.fileRefsByIdentity.get(`${session.scopes.get(scopeRef)!.moduleId}\u0000${scopeRef}\u0000${relativePath}`);
    const current = currentRef ? session.files.get(currentRef) : undefined;
    const fileRef = current && current.sizeBytes === result.sizeBytes && current.modifiedAt === result.modifiedAt
      ? current.fileRef
      : this.captureFile(session, {
          scopeRef,
          fileName,
          relativePath,
          kind: "file",
          sizeBytes: result.sizeBytes,
          modifiedAt: result.modifiedAt,
        }, true);
    session.files.get(fileRef)!.incompleteSearch = false;
    return { fileRef, relativePath, displayPath: `${session.scopes.get(scopeRef)!.label}/${relativePath}`, ...result,
      ...(result.changed || result.created === false
        ? { metadataPreservation: { mode: "preserved", other: "not_guaranteed" } } : {}),
    };
  }

  private async serializeMutation<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutationQueues.set(accountId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationQueues.get(accountId) === current) this.mutationQueues.delete(accountId);
    }
  }

  private async reconcileStartedMutation(
    sandbox: NodeFileSandbox,
    scope: ScopeBinding,
    relativePath: string,
    beforeSha256: string | undefined,
    previous: LocalFileOperationRecord,
    disposition: { created?: boolean; changed?: boolean },
  ): Promise<NonNullable<LocalFileOperationRecord["result"]> | undefined> {
    try {
      if (previous.prepared) {
        await sandbox.execute({ type: "cleanup_prepared", scopeRef: scope.scopeRef, relativePath, prepared: previous.prepared });
      }
      const current = await sandbox.execute({
        type: "inspect",
        scopeRef: scope.scopeRef,
        relativePath,
      });
      if (current.sha256 === previous.planned.sha256) {
        durabilityBarrier(scope.directory, relativePath);
        const completed = {
          sha256: current.sha256,
          sizeBytes: current.sizeBytes,
          modifiedAt: current.modifiedAt,
          mode: current.mode,
          ...disposition,
        };
        this.operations.complete(previous.operationKey, previous.requestHash, completed);
        return completed;
      }
      if (beforeSha256 && current.sha256 === beforeSha256) return undefined;
      throw new Error("local_file_content_conflict");
    } catch (error) {
      if (error instanceof Error && error.message === "file_sandbox_file_missing" && beforeSha256 === undefined) {
        return undefined;
      }
      if (error instanceof Error && error.message === "local_file_content_conflict") throw error;
      throw translateMutationError(error);
    }
  }

  private captureFile(
    session: TurnSession,
    entry: Pick<FileSandboxFindResult["entries"][number], "scopeRef" | "fileName" | "relativePath" | "kind" | "sizeBytes" | "modifiedAt">,
    forceNew = false,
    incompleteSearch = false,
  ): string {
    const scope = session.scopes.get(entry.scopeRef);
    if (!scope) throw new Error("local_file_scope_invalid");
    const identity = `${scope.moduleId}\u0000${entry.scopeRef}\u0000${entry.relativePath}`;
    const current = session.fileRefsByIdentity.get(identity);
    if (current && !forceNew) {
      session.files.get(current)!.incompleteSearch = incompleteSearch;
      return current;
    }
    const fileRef = opaque("fileref");
    session.fileRefsByIdentity.set(identity, fileRef);
    session.files.set(fileRef, {
      incompleteSearch,
      fileRef,
      moduleId: scope.moduleId,
      moduleRevision: scope.moduleRevision,
      scopeRef: entry.scopeRef,
      relativePath: entry.relativePath,
      fileName: entry.fileName,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
    });
    return fileRef;
  }

  private consumeResults(session: TurnSession, count: number): void {
    if (session.resultItems + count > this.budget.maxResultItems) {
      throw new Error("local_file_turn_budget_exhausted");
    }
    session.resultItems += count;
  }

  private consumeWriteBytes(session: TurnSession, count: number): void {
    if (session.writeBytes + count > this.budget.maxWriteBytes) {
      throw new Error("local_file_turn_budget_exhausted");
    }
    session.writeBytes += count;
  }
}

function directoryFileBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        total += fs.lstatSync(absolutePath).size;
        if (!Number.isSafeInteger(total)) throw new Error("local_file_snapshot_quota_exceeded");
      }
    }
  }
  return total;
}

function canonicalProtectedPath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("local_file_tools_config_invalid");
  // The native call returns the on-disk case, as the sandbox worker's real paths do; the JavaScript one keeps the case given.
  if (fs.existsSync(input)) return fs.realpathSync.native(input);
  const parent = path.dirname(input);
  if (parent === input) throw new Error("local_file_tools_config_invalid");
  return path.join(canonicalProtectedPath(parent), path.basename(input));
}

/** A grant's narrowing roots as the sandbox worker's real paths spell them. */
function canonicalRoots(roots: NarrowingRoots): NarrowingRoots {
  return { closedRoots: roots.closedRoots.map(canonicalProtectedPath), readOnlyRoots: roots.readOnlyRoots.map(canonicalProtectedPath) };
}

function sameRoots(left: NarrowingRoots, right: NarrowingRoots): boolean {
  const same = (one: string[], other: string[]) => one.length === other.length && one.every((root, index) => root === other[index]);
  return same(left.closedRoots, right.closedRoots) && same(left.readOnlyRoots, right.readOnlyRoots);
}

function groupScopes(
  session: TurnSession,
  requested: string[] | undefined,
  access: "read" | "write",
): Map<string, string[]> {
  const selected = requested ?? [...session.scopes.values()].filter((scope) => scope[access]).map((scope) => scope.scopeRef);
  const groups = new Map<string, string[]>();
  for (const scopeRef of selected) {
    const scope = session.scopes.get(scopeRef);
    if (!scope) throw new Error("local_file_reference_invalid");
    if (!scope[access]) throw new Error("local_file_permission_denied");
    const refs = groups.get(scope.moduleId) ?? [];
    refs.push(scopeRef);
    groups.set(scope.moduleId, refs);
  }
  if (groups.size === 0) throw new Error("local_file_permission_denied");
  return groups;
}

function sortFindEntries(
  entries: Array<FileSandboxFindResult["entries"][number]>,
  field: unknown,
  directionValue: unknown,
  scopes: Map<string, ScopeBinding>,
): void {
  const selectedField = field === "modified_at" || field === "name" || field === "path" ? field : "relevance";
  const direction = directionValue === "asc" ? 1 : -1;
  entries.sort((left, right) => {
    const primary = selectedField === "modified_at" ? (left.modifiedAt - right.modifiedAt) * direction
      : selectedField === "name" ? stableCompare(left.fileName, right.fileName) * direction
        : selectedField === "path" ? stableCompare(left.relativePath, right.relativePath) * direction
          : (left.relevanceScore - right.relevanceScore) * direction;
    return primary || stableCompare(left.relativePath, right.relativePath) || compareScopeBindings(scopes, left.scopeRef, right.scopeRef);
  });
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareScopeBindings(scopes: Map<string, ScopeBinding>, leftRef: string, rightRef: string): number {
  const left = scopes.get(leftRef)!;
  const right = scopes.get(rightRef)!;
  return stableCompare(left.moduleId, right.moduleId) || stableCompare(left.scopeId, right.scopeId);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local_file_tool_arguments_invalid");
  return structuredClone(value as Record<string, unknown>);
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("local_file_tool_arguments_invalid");
  }
  return [...value];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function requiredString(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length < 1)) {
    throw new Error("local_file_tool_arguments_invalid");
  }
  return value;
}

function requiredSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("local_file_tool_arguments_invalid");
  }
  return value;
}

function requiredRelativePath(value: unknown): string {
  const relativePath = requiredString(value);
  if (path.isAbsolute(relativePath) || relativePath.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("local_file_tool_arguments_invalid");
  }
  return relativePath.replaceAll("\\", "/");
}

/**
 * The path below the grant's root that a write addresses. Results show every file as `<label>/<path below the root>`, so a path
 * that begins with the label addresses the grant by its name when the root holds no entry of that name. When it holds one, or
 * that cannot be told, the path stays literal (workflow-module-permissions, failure mode 21).
 */
function pathBelowRoot(scope: ScopeBinding, relativePath: string): string {
  const named = `${scope.label}/`;
  if (!relativePath.startsWith(named)) return relativePath;
  try {
    fs.lstatSync(path.join(scope.directory, scope.label));
    return relativePath;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? relativePath.slice(named.length) : relativePath;
  }
}

function translateMutationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (/^local_file_[a-z0-9_]+$/u.test(message)) return new Error(message);
  if (message === "file_sandbox_content_conflict" || message === "file_sandbox_edit_conflict") {
    return new Error("local_file_content_conflict");
  }
  if (message === "file_sandbox_file_exists") return new Error("local_file_file_exists");
  if (message === "file_sandbox_permission_denied") return new Error("local_file_permission_denied");
  return new Error("local_file_mutation_failed");
}

function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function safeSegment(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function hashStable(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function durabilityBarrier(canonicalRoot: string, relativePath: string): void {
  try {
    const absolutePath = path.join(canonicalRoot, ...relativePath.split("/"));
    const file = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
    const directory = fs.openSync(path.dirname(absolutePath), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) {
    throw translateMutationError(error);
  }
}

function durabilityBarrierAbsolute(absolutePath: string): void {
  const file = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
  const directory = fs.openSync(path.dirname(absolutePath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function currentMode(canonicalRoot: string, relativePath: string): number {
  const absolutePath = path.join(canonicalRoot, ...relativePath.split("/"));
  const info = fs.lstatSync(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("local_file_path_unsafe");
  return info.mode & 0o777;
}

// A retry may have fresh file references and a fresh read hash; those do not authorize repeating the same edit.
function dispatchMutationKeys(request: Record<string, unknown>): { resource: string; logical: string } {
  const logical = { ...request }; delete logical.expectedSha256;
  return { resource: hashStable([request.moduleId, request.scopeId, request.relativePath]), logical: hashStable(logical) };
}
