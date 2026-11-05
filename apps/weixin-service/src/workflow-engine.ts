import crypto from "node:crypto";
import fs from "node:fs";
import type { LocalDiagnostics } from "./local-diagnostics.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkflowTrigger = {
  triggerId: string;
  source: "weixin" | "scheduler" | "fixture";
  occurredAt: number;
  requestedWorkflowId?: string;
  accountRef?: string;
  targetRef?: string;
  requesterRef?: string;
  scheduleRef?: string;
  inputRefs?: Record<string, string>;
};

export type WorkflowSubmission = {
  runId: string;
  duplicate: boolean;
};

export type WorkflowSignal = {
  signalId: string;
  signalRef: string;
  expectedRevision: number;
  accountRef?: string;
  targetRef?: string;
  requesterRef?: string;
  selection: unknown;
};

export type WorkflowSignalReceipt = {
  runId: string;
  duplicate: boolean;
};

export type WorkflowPendingCancellation = {
  cancellationId: string;
  signalRef: string;
  expectedRevision: number;
  accountRef?: string;
  targetRef?: string;
  requesterRef?: string;
};

export type WorkflowPendingInput = {
  signalRef: string;
  stepId: string;
  revision: number;
  expiresAt: number;
};

export type WorkflowPendingSignal = WorkflowPendingInput & {
  runId: string;
  candidates: unknown[];
  selectionMode?: "single" | "multiple";
};

export type WorkflowRunView = {
  runId: string;
  source: WorkflowTrigger["source"];
  triggerId: string;
  occurredAt: number;
  status: WorkflowRunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  requestedWorkflowId?: string;
  errorCode?: string;
  plan?: WorkflowPlanView;
  effects?: WorkflowEffectView[];
  pendingInput?: WorkflowPendingInput;
};

export type PublicWorkflowState = {
  runs: PublicWorkflowRun[];
};

export type PublicWorkflowRun = {
  runRef: string;
  source: WorkflowTrigger["source"];
  workflowId: string;
  workflowVersion?: number;
  occurredAt: number;
  status: WorkflowRunStatus;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  steps: PublicWorkflowStep[];
  effects: PublicWorkflowEffect[];
};

export type PublicWorkflowStep = {
  stepId: string;
  capabilityId: string;
  dependsOn: string[];
  attemptCount: number;
  status: WorkflowStepView["status"];
};

export type PublicWorkflowEffect = {
  stepId: string;
  state: WorkflowEffectView["state"];
  errorCode?: string;
};

export type WorkflowEffectView = {
  effectRef: string;
  stepId: string;
  operationId: string;
  state: "prepared" | "accepted" | "rejected" | "unknown";
  errorCode?: string;
};

export type WorkflowPlanView = {
  specId: string;
  specVersion: number;
  planHash: string;
  effectBudget: WorkflowEffectBudget;
  authorizationSnapshots: WorkflowAuthorizationSnapshot[];
  steps: WorkflowStepView[];
};

export type WorkflowAuthorizationSnapshot = {
  moduleId: string;
  revision: number;
  scopes: Array<{ scopeId: string; read: boolean; write: boolean }>;
};

export type WorkflowStepView = {
  stepId: string;
  capabilityId: string;
  capabilityVersion: number;
  dependsOn: string[];
  resourceKeys: string[];
  attemptCount: number;
  status: "pending" | "waiting_input" | "succeeded" | "failed" | "rejected" | "unknown" | "skipped";
};

export type WorkflowCondition = {
  dependency: string;
  path?: string[];
  equals: null | boolean | number | string;
};

export type WorkflowRetryPolicy = {
  maxAttempts: number;
  initialBackoffMs: number;
  maxElapsedMs: number;
};

export type WorkflowInputBinding = {
  dependency: string;
  path?: string[];
};

export type WorkflowResourceKeyBinding = {
  dependency: string;
  output: string;
};

export type WorkflowCapabilityStepSpec = {
  kind?: "capability";
  id: string;
  capability: string;
  capabilityVersion: number;
  dependsOn?: string[];
  when?: WorkflowCondition;
  resourceKeys?: string[];
  resourceKeyBindings?: WorkflowResourceKeyBinding[];
  retry?: WorkflowRetryPolicy;
  input?: Record<string, unknown>;
  inputBindings?: Record<string, WorkflowInputBinding>;
  triggerInputBindings?: Record<string, string>;
  /** Omit only together with timeoutMode="provider_managed". */
  timeoutMs?: number;
  timeoutMode?: "provider_managed";
};

export type WorkflowInputGateStepSpec = {
  kind: "input_gate";
  id: string;
  dependsOn: string[];
  candidates: WorkflowInputBinding;
  preselected?: WorkflowInputBinding;
  selectionSchema: WorkflowJsonSchema;
  selectionMode?: "single" | "multiple";
  autoSelect: "unique_only";
  expiresInMs: number;
};

export type WorkflowMapItemBinding = { path?: string[] };

export type WorkflowMapCapabilityStepSpec = {
  kind: "map_capability";
  id: string;
  capability: string;
  capabilityVersion: number;
  dependsOn: string[];
  items: WorkflowInputBinding;
  input?: Record<string, unknown>;
  itemInputBindings: Record<string, WorkflowMapItemBinding>;
  timeoutMs: number;
};

export type WorkflowStepSpec = WorkflowCapabilityStepSpec | WorkflowInputGateStepSpec | WorkflowMapCapabilityStepSpec;

export type WorkflowTemplate = {
  id: string;
  version: number;
  maxSteps: number;
  maxDepth: number;
  maxParallelism: number;
  effectBudget: WorkflowEffectBudget;
  steps: WorkflowStepSpec[];
};

export type WorkflowEffect = "read" | "write" | "external_send" | "destructive";
export type WorkflowEffectBudget = Partial<Record<WorkflowEffect, number>>;

export type WorkflowCapabilityDescriptor = {
  id: string;
  version: number;
  effect: WorkflowEffect;
  retryClass: "pure" | "idempotent" | "non_idempotent";
  inputSchema: WorkflowJsonSchema;
  outputSchema: WorkflowJsonSchema;
  resourceKeyOutputs?: Record<string, { path: string[] }>;
  modulePermission?: (
    | { moduleId: string; moduleIdInput?: never }
    | { moduleId?: never; moduleIdInput: string }
  ) & { access: "read" | "write" } & (
    | { scopeInput: string; scopeListInput?: never }
    | { scopeInput?: never; scopeListInput: string }
  );
};

export type WorkflowJsonSchema = {
  type?: "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";
  enum?: Array<null | boolean | number | string>;
  required?: string[];
  properties?: Record<string, WorkflowJsonSchema>;
  additionalProperties?: boolean;
  items?: WorkflowJsonSchema;
  maxItems?: number;
};

export type WorkflowCapabilityInvocation = {
  runId: string;
  stepId: string;
  capabilityId: string;
  capabilityVersion: number;
  input: Record<string, unknown>;
  dependencyResults: Record<string, unknown>;
  resourceKeys: string[];
  effectRef?: string;
  operationId?: string;
};

export type WorkflowCapabilityOutcome =
  | { status: "succeeded"; output?: unknown }
  | { status: "failed"; errorCode: string; retryable?: boolean }
  | { status: "unknown"; errorCode?: string };

type WorkflowStepExecutionOutcome = WorkflowCapabilityOutcome |
  { status: "rejected"; errorCode: string } |
  { status: "waiting_input"; candidates: unknown[] };

export type WorkflowReconcileOutcome =
  | { status: "accepted" }
  | { status: "rejected"; errorCode: string }
  | { status: "unknown"; errorCode?: string };

export type WorkflowReconcileContext = { runId: string; operationId: string };

export interface WorkflowCapabilityProvider {
  catalog(): WorkflowCapabilityDescriptor[];
  invoke(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome>;
  reconcile?(effectRef: string, context: WorkflowReconcileContext): Promise<WorkflowReconcileOutcome>;
}

export interface WorkflowModulePermissionAuthorizer {
  snapshot(moduleId: string): WorkflowAuthorizationSnapshot | undefined;
  assertAllowed(input: {
    moduleId: string;
    access: "read" | "write";
    scopeId: string;
    absolutePath?: string;
  }): void;
}

export type WorkflowRunStatus =
  | "accepted"
  | "planning"
  | "ready"
  | "running"
  | "needs_input"
  | "waiting_external"
  | "succeeded"
  | "failed"
  | "blocked"
  | "outcome_unknown"
  | "cancelled";

export type WorkflowEngineDependencies = {
  diagnostics?: LocalDiagnostics;
  now?: () => number;
  createRunId?: () => string;
  templates?: WorkflowTemplate[];
  providers?: WorkflowCapabilityProvider[];
  sleep?: (milliseconds: number) => Promise<void>;
  modulePermissions?: WorkflowModulePermissionAuthorizer;
  resourceLeaseMs?: number;
  resourceLockPollMs?: number;
  resourceLockWaitMs?: number;
  onRunAccepted?: (accepted: { runId: string; trigger: WorkflowTrigger }) => void;
};

export type WorkflowRetirementNotice = {
  runId: string;
  state: "pending" | "sending" | "accepted" | "failed" | "unknown";
  nextAttemptAt: number;
};

export class WorkflowEngine {
  private readonly diagnostics: LocalDiagnostics | undefined;
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly modulePermissions: WorkflowModulePermissionAuthorizer | undefined;
  private readonly resourceLeaseMs: number;
  private readonly resourceLockPollMs: number;
  private readonly resourceLockWaitMs: number;
  private readonly onRunAccepted: WorkflowEngineDependencies["onRunAccepted"];
  private readonly templates = new Map<string, WorkflowTemplate>();
  private readonly capabilities = new Map<string, RegisteredCapability>();
  private started = false;

  constructor(databasePath: string, dependencies: WorkflowEngineDependencies = {}) {
    this.diagnostics = dependencies.diagnostics;
    for (const template of dependencies.templates ?? []) {
      if (this.templates.has(template.id)) throw new Error("workflow_template_duplicate");
      this.templates.set(template.id, template);
    }
    for (const provider of dependencies.providers ?? []) {
      for (const descriptor of provider.catalog()) {
        validateCapabilityDescriptor(descriptor);
        const key = capabilityKey(descriptor.id, descriptor.version);
        if (this.capabilities.has(key)) throw new Error("workflow_capability_duplicate");
        this.capabilities.set(key, { descriptor, provider });
      }
    }
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_run (
        run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('weixin', 'scheduler', 'fixture')),
        trigger_id TEXT NOT NULL,
        requested_workflow_id TEXT,
        account_ref TEXT,
        target_ref TEXT,
        trigger_input_refs_json TEXT NOT NULL DEFAULT '{}',
        occurred_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'accepted', 'planning', 'ready', 'running', 'needs_input',
          'waiting_external', 'succeeded', 'failed', 'blocked',
          'outcome_unknown', 'cancelled'
        )),
        error_code TEXT,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (source, trigger_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_retirement_notice (
        run_id TEXT PRIMARY KEY REFERENCES workflow_run(run_id),
        state TEXT NOT NULL CHECK (state IN ('pending','sending','accepted','failed','unknown')),
        next_attempt_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_transition (
        transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        revision INTEGER NOT NULL,
        event TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        UNIQUE (run_id, revision)
      );
      CREATE TABLE IF NOT EXISTS workflow_plan (
        run_id TEXT PRIMARY KEY REFERENCES workflow_run(run_id),
        spec_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_step (
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        step_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version INTEGER NOT NULL,
        depends_on_json TEXT NOT NULL,
        resource_keys_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'rejected', 'unknown', 'skipped')),
        error_code TEXT,
        output_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id),
        UNIQUE (run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS workflow_effect (
        effect_ref TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        step_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'rejected', 'unknown')),
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_resource_lease (
        resource_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_signal_request (
        signal_ref TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        step_id TEXT NOT NULL,
        candidate_hash TEXT NOT NULL,
        selection_schema_json TEXT NOT NULL,
        candidate_revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'consumed', 'expired', 'superseded', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_signal (
        signal_id TEXT PRIMARY KEY,
        signal_ref TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        account_ref TEXT,
        target_ref TEXT,
        candidate_revision INTEGER NOT NULL,
        selection_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_pending_cancellation (
        cancellation_id TEXT PRIMARY KEY,
        signal_ref TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        account_ref TEXT,
        target_ref TEXT,
        candidate_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const runColumns = this.database.prepare("PRAGMA table_info(workflow_run)").all() as unknown as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "trigger_input_refs_json")) {
      this.database.exec("ALTER TABLE workflow_run ADD COLUMN trigger_input_refs_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!runColumns.some((column) => column.name === "account_ref")) {
      this.database.exec("ALTER TABLE workflow_run ADD COLUMN account_ref TEXT");
    }
    if (!runColumns.some((column) => column.name === "target_ref")) {
      this.database.exec("ALTER TABLE workflow_run ADD COLUMN target_ref TEXT");
    }
    for (const table of ["workflow_run", "workflow_signal", "workflow_pending_cancellation"]) {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "requester_ref")) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN requester_ref TEXT`);
      }
    }
    const stepColumns = this.database.prepare("PRAGMA table_info(workflow_step)").all() as unknown as Array<{ name: string }>;
    if (!stepColumns.some((column) => column.name === "output_json")) {
      this.database.exec("ALTER TABLE workflow_step ADD COLUMN output_json TEXT");
    }
    const signalRequestColumns = this.database.prepare("PRAGMA table_info(workflow_signal_request)")
      .all() as unknown as Array<{ name: string }>;
    if (!signalRequestColumns.some((column) => column.name === "candidate_revision")) {
      this.database.exec("ALTER TABLE workflow_signal_request ADD COLUMN candidate_revision INTEGER NOT NULL DEFAULT 0");
    }
    const signalRequestSchema = this.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_signal_request'",
    ).get() as { sql: string } | undefined;
    if (signalRequestSchema && !signalRequestSchema.sql.includes("'cancelled'")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          CREATE TABLE workflow_signal_request_v2 (
            signal_ref TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
            step_id TEXT NOT NULL,
            candidate_hash TEXT NOT NULL,
            selection_schema_json TEXT NOT NULL,
            candidate_revision INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('waiting', 'consumed', 'expired', 'superseded', 'cancelled')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (run_id, step_id)
          );
          INSERT INTO workflow_signal_request_v2(
            signal_ref, run_id, step_id, candidate_hash, selection_schema_json,
            candidate_revision, expires_at, state, created_at, updated_at
          )
          SELECT signal_ref, run_id, step_id, candidate_hash, selection_schema_json,
            candidate_revision, expires_at, state, created_at, updated_at
          FROM workflow_signal_request;
          DROP TABLE workflow_signal_request;
          ALTER TABLE workflow_signal_request_v2 RENAME TO workflow_signal_request;
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const signalColumns = this.database.prepare("PRAGMA table_info(workflow_signal)")
      .all() as unknown as Array<{ name: string }>;
    if (!signalColumns.some((column) => column.name === "candidate_revision")) {
      this.database.exec("ALTER TABLE workflow_signal ADD COLUMN candidate_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.now = dependencies.now ?? Date.now;
    this.createRunId = dependencies.createRunId ?? crypto.randomUUID;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.modulePermissions = dependencies.modulePermissions;
    this.resourceLeaseMs = validateDuration(dependencies.resourceLeaseMs ?? 30_000, "workflow_resource_lease_invalid");
    this.resourceLockPollMs = validateDuration(dependencies.resourceLockPollMs ?? 25, "workflow_resource_poll_invalid");
    this.resourceLockWaitMs = validateDuration(dependencies.resourceLockWaitMs ?? 30_000, "workflow_resource_wait_invalid");
    this.onRunAccepted = dependencies.onRunAccepted;
  }

  async submit(trigger: WorkflowTrigger): Promise<WorkflowSubmission> {
    return this.diagnostics ? this.diagnostics.run("workflow.submit", {}, () => this.submitObserved(trigger)) : this.submitObserved(trigger);
  }

  private async submitObserved(trigger: WorkflowTrigger): Promise<WorkflowSubmission> {
    validateTrigger(trigger);
    const existing = this.readByTrigger(trigger.source, trigger.triggerId);
    if (existing) return this.duplicateSubmission(existing, trigger);

    const runId = this.createRunId();
    if (!isBoundedIdentifier(runId)) throw new Error("workflow_run_id_invalid");
    const at = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO workflow_run(
          run_id, source, trigger_id, requested_workflow_id, account_ref, target_ref, requester_ref,
          trigger_input_refs_json, occurred_at,
          status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?)
      `).run(
        runId,
        trigger.source,
        trigger.triggerId,
        trigger.requestedWorkflowId ?? null,
        trigger.accountRef ?? null,
        trigger.targetRef ?? null,
        trigger.requesterRef ?? null,
        canonicalJson(trigger.inputRefs ?? {}),
        trigger.occurredAt,
        at,
        at,
      );
      if (Number(result.changes) === 1) {
        this.onRunAccepted?.({ runId, trigger: structuredClone(trigger) });
        this.database.prepare(`
          INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
          VALUES (?, 0, 'accepted', ?)
        `).run(runId, at);
        this.database.exec("COMMIT");
        if (this.started && trigger.requestedWorkflowId) await this.process(runId);
        return { runId, duplicate: false };
      }
      this.database.exec("ROLLBACK");
      const duplicate = this.readByTrigger(trigger.source, trigger.triggerId);
      if (!duplicate) throw new Error("workflow_submit_failed");
      return this.duplicateSubmission(duplicate, trigger);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async signal(signal: WorkflowSignal): Promise<WorkflowSignalReceipt> {
    return this.diagnostics ? this.diagnostics.run("workflow.signal", {}, () => this.signalObserved(signal)) : this.signalObserved(signal);
  }

  private async signalObserved(signal: WorkflowSignal): Promise<WorkflowSignalReceipt> {
    validateSignal(signal);
    const duplicate = this.readSignal(signal.signalId);
    if (duplicate) return duplicateSignalReceipt(duplicate, signal);

    const request = this.readSignalRequest(signal.signalRef);
    if (!request) throw new Error("workflow_signal_request_unavailable");
    this.diagnostics?.result(this.diagnostics.references({ runId: request.run_id }));
    if (request.state !== "waiting") throw new Error("workflow_signal_request_closed");
    const run = this.readRunBinding(request.run_id);
    if (!run || run.status !== "needs_input") throw new Error("workflow_signal_run_unavailable");
    if (signal.expectedRevision !== request.candidate_revision || run.revision !== request.candidate_revision) {
      throw new Error("workflow_signal_revision_mismatch");
    }
    if (run.account_ref !== (signal.accountRef ?? null) || run.target_ref !== (signal.targetRef ?? null) ||
        run.requester_ref !== (signal.requesterRef ?? null)) {
      throw new Error("workflow_signal_source_mismatch");
    }
    if (request.expires_at <= this.now()) {
      this.expireSignalRequest(request, run.revision);
      throw new Error("workflow_signal_expired");
    }

    const plan = this.readFrozenPlan(request.run_id);
    const gate = plan.steps.find((step): step is CompiledInputGateStep =>
      step.kind === "input_gate" && step.id === request.step_id);
    if (!gate || canonicalJson(gate.selectionSchema) !== request.selection_schema_json) {
      throw new Error("workflow_signal_contract_mismatch");
    }
    const state = this.readExecutionState(request.run_id);
    const resolved = valueAtPath(state.results[gate.candidates.dependency], gate.candidates.path ?? []);
    if (!resolved.found || !Array.isArray(resolved.value) ||
        hashCanonicalJson(resolved.value) !== request.candidate_hash) {
      throw new Error("workflow_signal_candidates_mismatch");
    }
    const candidates: unknown[] = resolved.value;
    const selections = gate.selectionMode === "multiple"
      ? (Array.isArray(signal.selection) ? signal.selection : [])
      : [signal.selection];
    if (selections.length < 1 || new Set(selections.map(canonicalJson)).size !== selections.length ||
        selections.some((selection) => !matchesJsonSchema(selection, gate.selectionSchema) ||
          !candidates.some((candidate) => canonicalJson(candidate) === canonicalJson(selection)))) {
      throw new Error("workflow_signal_selection_invalid");
    }

    const at = this.now();
    const nextRevision = run.revision + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const concurrentDuplicate = this.readSignal(signal.signalId);
      if (concurrentDuplicate) {
        this.database.exec("ROLLBACK");
        return duplicateSignalReceipt(concurrentDuplicate, signal);
      }
      const inserted = this.database.prepare(`
        INSERT INTO workflow_signal(
          signal_id, signal_ref, run_id, account_ref, target_ref, requester_ref, candidate_revision, selection_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.signalId, signal.signalRef, request.run_id, signal.accountRef ?? null,
        signal.targetRef ?? null, signal.requesterRef ?? null, signal.expectedRevision, canonicalJson(signal.selection), at,
      );
      if (Number(inserted.changes) !== 1) throw new Error("workflow_signal_conflict");
      const consumed = this.database.prepare(`
        UPDATE workflow_signal_request SET state = 'consumed', updated_at = ?
        WHERE signal_ref = ? AND state = 'waiting'
      `).run(at, signal.signalRef);
      const completed = this.database.prepare(`
        UPDATE workflow_step SET status = 'succeeded', error_code = NULL, output_json = ?, updated_at = ?
        WHERE run_id = ? AND step_id = ? AND status = 'pending'
      `).run(canonicalJson(signal.selection), at, request.run_id, request.step_id);
      const resumed = this.database.prepare(`
        UPDATE workflow_run SET status = 'running', error_code = NULL, revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ? AND status = 'needs_input'
      `).run(nextRevision, at, request.run_id, run.revision);
      if (Number(consumed.changes) !== 1 || Number(completed.changes) !== 1 || Number(resumed.changes) !== 1) {
        throw new Error("workflow_signal_state_conflict");
      }
      this.database.prepare(`
        INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
        VALUES (?, ?, 'signal_received', ?)
      `).run(request.run_id, nextRevision, at);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    await this.process(request.run_id);
    return { runId: request.run_id, duplicate: false };
  }

  async cancelPending(cancellation: WorkflowPendingCancellation): Promise<WorkflowSignalReceipt> {
    return this.diagnostics ? this.diagnostics.run("workflow.cancel", {}, () => this.cancelPendingObserved(cancellation)) : this.cancelPendingObserved(cancellation);
  }

  private async cancelPendingObserved(cancellation: WorkflowPendingCancellation): Promise<WorkflowSignalReceipt> {
    validatePendingCancellation(cancellation);
    const existing = this.database.prepare(`
      SELECT cancellation_id, signal_ref, run_id, account_ref, target_ref, requester_ref, candidate_revision
      FROM workflow_pending_cancellation WHERE cancellation_id = ?
    `).get(cancellation.cancellationId) as PendingCancellationRow | undefined;
    if (existing) return duplicateCancellationReceipt(existing, cancellation);

    const request = this.readSignalRequest(cancellation.signalRef);
    if (!request) throw new Error("workflow_signal_request_unavailable");
    if (request.state !== "waiting") throw new Error("workflow_signal_request_closed");
    const run = this.readRunBinding(request.run_id);
    if (!run || run.status !== "needs_input") throw new Error("workflow_signal_run_unavailable");
    if (cancellation.expectedRevision !== request.candidate_revision || run.revision !== request.candidate_revision) {
      throw new Error("workflow_signal_revision_mismatch");
    }
    if (run.account_ref !== (cancellation.accountRef ?? null) ||
        run.target_ref !== (cancellation.targetRef ?? null) ||
        run.requester_ref !== (cancellation.requesterRef ?? null)) {
      throw new Error("workflow_signal_source_mismatch");
    }
    if (request.expires_at <= this.now()) {
      this.expireSignalRequest(request, run.revision);
      throw new Error("workflow_signal_expired");
    }

    const at = this.now();
    const nextRevision = run.revision + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = this.database.prepare(`
        SELECT cancellation_id, signal_ref, run_id, account_ref, target_ref, requester_ref, candidate_revision
        FROM workflow_pending_cancellation WHERE cancellation_id = ?
      `).get(cancellation.cancellationId) as PendingCancellationRow | undefined;
      if (concurrent) {
        this.database.exec("ROLLBACK");
        return duplicateCancellationReceipt(concurrent, cancellation);
      }
      const inserted = this.database.prepare(`
        INSERT INTO workflow_pending_cancellation(
          cancellation_id, signal_ref, run_id, account_ref, target_ref, requester_ref, candidate_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cancellation.cancellationId, cancellation.signalRef, request.run_id,
        cancellation.accountRef ?? null, cancellation.targetRef ?? null, cancellation.requesterRef ?? null,
        cancellation.expectedRevision, at,
      );
      const closed = this.database.prepare(`
        UPDATE workflow_signal_request SET state = 'cancelled', updated_at = ?
        WHERE signal_ref = ? AND state = 'waiting'
      `).run(at, cancellation.signalRef);
      const cancelled = this.database.prepare(`
        UPDATE workflow_run SET status = 'cancelled', error_code = 'workflow_pending_cancelled',
          revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ? AND status = 'needs_input'
      `).run(nextRevision, at, request.run_id, run.revision);
      if (Number(inserted.changes) !== 1 || Number(closed.changes) !== 1 || Number(cancelled.changes) !== 1) {
        throw new Error("workflow_pending_cancel_conflict");
      }
      this.database.prepare(`
        INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
        VALUES (?, ?, 'pending_cancelled', ?)
      `).run(request.run_id, nextRevision, at);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    return { runId: request.run_id, duplicate: false };
  }

  async start(): Promise<void> {
    this.started = true;
    this.reconcileExpiredPendingSignals();
    this.reconcileDuplicatePendingSignals();
    await this.reconcileUnknownEffects();
    const rows = this.database.prepare(`
      SELECT run_id FROM workflow_run
      WHERE status IN ('accepted', 'running') AND requested_workflow_id IS NOT NULL
      ORDER BY created_at, run_id
    `).all() as unknown as Array<{ run_id: string }>;
    for (const row of rows) await this.process(row.run_id);
  }

  retirePendingCapability(
    capabilityId: string, capabilityVersion: number, errorCode: string,
    unplannedWorkflowIds: readonly string[] = [],
  ): string[] {
    if (this.started) throw new Error("workflow_migration_after_start");
    if (!isBoundedIdentifier(capabilityId) || !Number.isSafeInteger(capabilityVersion) || capabilityVersion < 1) {
      throw new Error("workflow_capability_invalid");
    }
    const safeError = sanitizeErrorCode(errorCode);
    if (unplannedWorkflowIds.some((id) => !isBoundedIdentifier(id))) throw new Error("workflow_template_invalid");
    const rows = this.database.prepare(`
      SELECT run.run_id, run.revision
      FROM workflow_run AS run
      WHERE run.status IN ('accepted', 'planning', 'ready', 'running')
        AND (EXISTS (
          SELECT 1 FROM workflow_step AS step WHERE step.run_id = run.run_id
            AND step.status = 'pending' AND step.capability_id = ? AND step.capability_version = ?
        ) OR (
          run.requested_workflow_id IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM workflow_plan AS plan WHERE plan.run_id = run.run_id)
        ))
      ORDER BY run.created_at, run.run_id
    `).all(capabilityId, capabilityVersion, JSON.stringify(unplannedWorkflowIds)) as unknown as Array<{ run_id: string; revision: number }>;
    const at = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.database.prepare(`
          UPDATE workflow_step SET status = 'skipped', error_code = ?, updated_at = ?
          WHERE run_id = ? AND status = 'pending'
        `).run(safeError, at, row.run_id);
        const nextRevision = row.revision + 1;
        const updated = this.database.prepare(`
          UPDATE workflow_run SET status = 'failed', error_code = ?, revision = ?, updated_at = ?
          WHERE run_id = ? AND revision = ? AND status IN ('accepted', 'planning', 'ready', 'running')
        `).run(safeError, nextRevision, at, row.run_id, row.revision);
        if (Number(updated.changes) !== 1) throw new Error("workflow_revision_conflict");
        this.database.prepare(`
          INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
          VALUES (?, ?, 'failed', ?)
        `).run(row.run_id, nextRevision, at);
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO workflow_retirement_notice(run_id, state, next_attempt_at, updated_at)
        SELECT run_id, 'pending', ?, ? FROM workflow_run WHERE status = 'failed' AND error_code = ?
      `).run(at, at, safeError);
      this.database.exec("COMMIT");
      return rows.map((row) => row.run_id);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listRetirementNotices(): WorkflowRetirementNotice[] {
    const rows = this.database.prepare(`
      SELECT run_id, state, next_attempt_at FROM workflow_retirement_notice ORDER BY rowid
    `).all() as Array<{ run_id: string; state: WorkflowRetirementNotice["state"]; next_attempt_at: number }>;
    return rows.map((row) => ({ runId: row.run_id, state: row.state, nextAttemptAt: row.next_attempt_at }));
  }

  recoverRetirementNotices(): void {
    if (this.started) throw new Error("workflow_migration_after_start");
    this.database.prepare("UPDATE workflow_retirement_notice SET state = 'unknown', updated_at = ? WHERE state = 'sending'")
      .run(this.now());
  }

  claimRetirementNotice(runId: string): boolean {
    const at = this.now();
    return Number(this.database.prepare(`
      UPDATE workflow_retirement_notice SET state = 'sending', updated_at = ?
      WHERE run_id = ? AND state = 'pending' AND next_attempt_at <= ?
    `).run(at, runId, at).changes) === 1;
  }

  finishRetirementNotice(runId: string, state: Exclude<WorkflowRetirementNotice["state"], "sending">): void {
    if (!["pending", "accepted", "failed", "unknown"].includes(state)) throw new Error("workflow_notice_state_invalid");
    const at = this.now();
    this.database.prepare(`
      UPDATE workflow_retirement_notice SET state = ?, next_attempt_at = ?, updated_at = ?
      WHERE run_id = ? AND state = 'sending'
    `).run(state, state === "pending" ? at + 60_000 : at, at, runId);
  }

  get(runId: string): WorkflowRunView | undefined {
    const row = this.database.prepare(`
      SELECT run_id, source, trigger_id, requested_workflow_id, account_ref, target_ref, occurred_at,
             status, error_code, revision, created_at, updated_at
      FROM workflow_run WHERE run_id = ?
    `).get(runId) as WorkflowRunRow | undefined;
    return row
      ? { ...decodeRun(row), ...this.readPlan(runId), ...this.readEffects(runId), ...this.readPendingInput(runId) }
      : undefined;
  }

  listPendingSignals(accountRef: string, targetRef: string, requesterRef?: string): WorkflowPendingSignal[] {
    if (!isBoundedIdentifier(accountRef) || !isBoundedIdentifier(targetRef) ||
        (requesterRef !== undefined && !isBoundedIdentifier(requesterRef))) {
      throw new Error("workflow_signal_source_invalid");
    }
    const rows = this.database.prepare(`
      SELECT request.signal_ref, request.run_id, request.step_id, request.candidate_hash,
             request.candidate_revision, request.expires_at
      FROM workflow_signal_request AS request
      JOIN workflow_run AS run ON run.run_id = request.run_id
      WHERE request.state = 'waiting'
        AND run.status = 'needs_input' AND run.account_ref = ? AND run.target_ref = ? AND run.requester_ref IS ?
      ORDER BY request.created_at, request.signal_ref
    `).all(accountRef, targetRef, requesterRef ?? null) as Array<{
      signal_ref: string;
      run_id: string;
      step_id: string;
      candidate_hash: string;
      candidate_revision: number;
      expires_at: number;
    }>;
    return rows.map((row) => {
      const plan = this.readFrozenPlan(row.run_id);
      const gate = plan.steps.find((step): step is CompiledInputGateStep =>
        step.kind === "input_gate" && step.id === row.step_id);
      if (!gate) throw new Error("workflow_signal_contract_mismatch");
      const state = this.readExecutionState(row.run_id);
      const resolved = valueAtPath(state.results[gate.candidates.dependency], gate.candidates.path ?? []);
      if (!resolved.found || !Array.isArray(resolved.value) ||
          hashCanonicalJson(resolved.value) !== row.candidate_hash) {
        throw new Error("workflow_signal_candidates_mismatch");
      }
      return {
        runId: row.run_id,
        signalRef: row.signal_ref,
        stepId: row.step_id,
        revision: row.candidate_revision,
        expiresAt: row.expires_at,
        candidates: structuredClone(resolved.value),
        selectionMode: gate.selectionMode,
      };
    });
  }

  supersedePendingSignals(accountRef: string, targetRef: string, requesterRef?: string): string[] {
    if (!isBoundedIdentifier(accountRef) || !isBoundedIdentifier(targetRef) ||
        (requesterRef !== undefined && !isBoundedIdentifier(requesterRef))) {
      throw new Error("workflow_signal_source_invalid");
    }
    const at = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const runIds = this.supersedePendingSignalsInTransaction(accountRef, targetRef, at, undefined, requesterRef);
      this.database.exec("COMMIT");
      return runIds;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getStepOutput(runId: string, stepId: string): unknown | undefined {
    if (!isBoundedIdentifier(runId) || !isBoundedIdentifier(stepId)) return undefined;
    const row = this.database.prepare(`
      SELECT output_json FROM workflow_step
      WHERE run_id = ? AND step_id = ? AND status = 'succeeded'
    `).get(runId, stepId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return undefined;
    try {
      return JSON.parse(row.output_json) as unknown;
    } catch {
      return undefined;
    }
  }

  getPublicState(limit = 50): PublicWorkflowState {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("workflow_public_limit_invalid");
    }
    const rows = this.database.prepare(`
      SELECT run_id, source, trigger_id, requested_workflow_id, account_ref, target_ref, occurred_at,
             status, error_code, revision, created_at, updated_at
      FROM workflow_run
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ?
    `).all(limit) as unknown as WorkflowRunRow[];
    return {
      runs: rows.map((row) => {
        const run = { ...decodeRun(row), ...this.readPlan(row.run_id), ...this.readEffects(row.run_id) };
        return {
          runRef: publicRunRef(row.run_id),
          source: run.source,
          workflowId: run.plan?.specId ?? run.requestedWorkflowId ?? "未指定工作流",
          ...(run.plan ? { workflowVersion: run.plan.specVersion } : {}),
          occurredAt: run.occurredAt,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          ...(run.errorCode ? { errorCode: run.errorCode } : {}),
          steps: (run.plan?.steps ?? []).map((step) => ({
            stepId: step.stepId,
            capabilityId: step.capabilityId,
            dependsOn: [...step.dependsOn],
            attemptCount: step.attemptCount,
            status: step.status,
          })),
          effects: (run.effects ?? []).map((effect) => ({
            stepId: effect.stepId,
            state: effect.state,
            ...(effect.errorCode ? { errorCode: effect.errorCode } : {}),
          })),
        };
      }),
    };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private readByTrigger(source: WorkflowTrigger["source"], triggerId: string): WorkflowRunView | undefined {
    const row = this.database.prepare(`
      SELECT run_id, source, trigger_id, requested_workflow_id, account_ref, target_ref, occurred_at,
             status, error_code, revision, created_at, updated_at
      FROM workflow_run WHERE source = ? AND trigger_id = ?
    `).get(source, triggerId) as WorkflowRunRow | undefined;
    return row ? decodeRun(row) : undefined;
  }

  private readPendingInput(runId: string): Pick<WorkflowRunView, "pendingInput"> {
    const row = this.database.prepare(`
      SELECT signal_ref, step_id, candidate_revision, expires_at
      FROM workflow_signal_request
      WHERE run_id = ? AND state = 'waiting'
    `).get(runId) as { signal_ref: string; step_id: string; candidate_revision: number; expires_at: number } | undefined;
    return row ? { pendingInput: {
      signalRef: row.signal_ref, stepId: row.step_id, revision: row.candidate_revision, expiresAt: row.expires_at,
    } } : {};
  }

  private readSignal(signalId: string): WorkflowSignalRow | undefined {
    return this.database.prepare(`
      SELECT signal_id, signal_ref, run_id, account_ref, target_ref, requester_ref, candidate_revision, selection_json, created_at
      FROM workflow_signal WHERE signal_id = ?
    `).get(signalId) as WorkflowSignalRow | undefined;
  }

  private readSignalRequest(signalRef: string): WorkflowSignalRequestRow | undefined {
    return this.database.prepare(`
      SELECT signal_ref, run_id, step_id, candidate_hash, selection_schema_json,
             candidate_revision, expires_at, state, created_at, updated_at
      FROM workflow_signal_request WHERE signal_ref = ?
    `).get(signalRef) as WorkflowSignalRequestRow | undefined;
  }

  private readRunBinding(runId: string): WorkflowRunBindingRow | undefined {
    return this.database.prepare(`
      SELECT run_id, account_ref, target_ref, requester_ref, status, revision
      FROM workflow_run WHERE run_id = ?
    `).get(runId) as WorkflowRunBindingRow | undefined;
  }

  private readFrozenPlan(runId: string): CompiledPlan {
    const row = this.database.prepare("SELECT plan_json FROM workflow_plan WHERE run_id = ?")
      .get(runId) as { plan_json: string } | undefined;
    if (!row) throw new Error("workflow_plan_unavailable");
    try {
      return JSON.parse(row.plan_json) as CompiledPlan;
    } catch {
      throw new Error("workflow_plan_invalid");
    }
  }

  private readExecutionState(runId: string): {
    results: Record<string, unknown>;
    completed: Set<string>;
    pending: Set<string>;
  } {
    const rows = this.database.prepare(`
      SELECT step_id, status, output_json FROM workflow_step WHERE run_id = ? ORDER BY ordinal
    `).all(runId) as unknown as Array<{ step_id: string; status: string; output_json: string | null }>;
    const results: Record<string, unknown> = {};
    const completed = new Set<string>();
    const pending = new Set<string>();
    for (const row of rows) {
      if (row.status === "pending") {
        pending.add(row.step_id);
        continue;
      }
      if (row.status === "succeeded" || row.status === "skipped") completed.add(row.step_id);
      if (row.status === "succeeded" && row.output_json !== null) {
        try {
          results[row.step_id] = JSON.parse(row.output_json) as unknown;
        } catch {
          throw new Error("workflow_step_output_invalid");
        }
      }
    }
    return { results, completed, pending };
  }

  private expireSignalRequest(request: WorkflowSignalRequestRow, expectedRevision: number): void {
    const at = this.now();
    const nextRevision = expectedRevision + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.database.prepare(`
        UPDATE workflow_signal_request SET state = 'expired', updated_at = ?
        WHERE signal_ref = ? AND state = 'waiting'
      `).run(at, request.signal_ref);
      const blocked = this.database.prepare(`
        UPDATE workflow_run SET status = 'blocked', error_code = 'workflow_signal_expired',
          revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ? AND status = 'needs_input'
      `).run(nextRevision, at, request.run_id, expectedRevision);
      if (Number(expired.changes) !== 1 || Number(blocked.changes) !== 1) {
        throw new Error("workflow_signal_state_conflict");
      }
      this.database.prepare(`
        INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
        VALUES (?, ?, 'blocked', ?)
      `).run(request.run_id, nextRevision, at);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private reconcileDuplicatePendingSignals(): void {
    const scopes = this.database.prepare(`
      SELECT run.account_ref, run.target_ref, run.requester_ref
      FROM workflow_signal_request AS request
      JOIN workflow_run AS run ON run.run_id = request.run_id
      WHERE request.state = 'waiting' AND run.status = 'needs_input'
        AND run.account_ref IS NOT NULL AND run.target_ref IS NOT NULL
      GROUP BY run.account_ref, run.target_ref, run.requester_ref
      HAVING COUNT(*) > 1
    `).all() as unknown as Array<{ account_ref: string; target_ref: string; requester_ref: string | null }>;
    for (const scope of scopes) {
      const newest = this.database.prepare(`
        SELECT run.run_id
        FROM workflow_signal_request AS request
        JOIN workflow_run AS run ON run.run_id = request.run_id
        WHERE request.state = 'waiting' AND run.status = 'needs_input'
          AND run.account_ref = ? AND run.target_ref = ? AND run.requester_ref IS ?
        ORDER BY run.occurred_at DESC, run.created_at DESC, run.run_id DESC
        LIMIT 1
      `).get(scope.account_ref, scope.target_ref, scope.requester_ref) as { run_id: string } | undefined;
      if (!newest) continue;
      const at = this.now();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.supersedePendingSignalsInTransaction(scope.account_ref, scope.target_ref, at, newest.run_id, scope.requester_ref ?? undefined);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private reconcileExpiredPendingSignals(): void {
    const rows = this.database.prepare(`
      SELECT request.*
      FROM workflow_signal_request AS request
      JOIN workflow_run AS run ON run.run_id = request.run_id
      WHERE request.state = 'waiting' AND run.status = 'needs_input' AND request.expires_at <= ?
      ORDER BY request.expires_at, request.signal_ref
    `).all(this.now()) as unknown as WorkflowSignalRequestRow[];
    for (const request of rows) {
      const run = this.readRunBinding(request.run_id);
      if (run?.status === "needs_input") this.expireSignalRequest(request, run.revision);
    }
  }

  private duplicateSubmission(existing: WorkflowRunView, trigger: WorkflowTrigger): WorkflowSubmission {
    const binding = this.readRunBinding(existing.runId);
    const sourceBindingConflict = trigger.source !== "scheduler" && (
      binding?.account_ref !== (trigger.accountRef ?? null) || binding?.target_ref !== (trigger.targetRef ?? null) ||
      binding?.requester_ref !== (trigger.requesterRef ?? null)
    );
    if (existing.occurredAt !== trigger.occurredAt || existing.requestedWorkflowId !== trigger.requestedWorkflowId ||
        sourceBindingConflict ||
        canonicalJson(this.readTriggerInputRefs(existing.runId)) !== canonicalJson(trigger.inputRefs ?? {})) {
      throw new Error("workflow_trigger_conflict");
    }
    return { runId: existing.runId, duplicate: true };
  }

  private async process(runId: string): Promise<void> {
    if (!this.diagnostics) return this.processObserved(runId);
    return this.diagnostics.run("workflow.process", this.diagnostics.references({ runId }), async () => {
      try { await this.processObserved(runId); }
      finally { this.diagnostics?.result({ status: this.get(runId)?.status }); }
    });
  }

  private async processObserved(runId: string): Promise<void> {
    let run = this.get(runId);
    if (!run || !run.requestedWorkflowId || !new Set(["accepted", "running"]).has(run.status)) return;
    try {
      let plan: CompiledPlan;
      let results: Record<string, unknown>;
      let completed: Set<string>;
      let pending: Set<string>;
      if (run.status === "accepted") {
        this.transition(runId, run.revision, "planning");
        plan = this.compile(run.requestedWorkflowId, this.readTriggerInputRefs(runId));
        this.persistPlan(runId, plan);
        run = this.get(runId)!;
        this.transition(runId, run.revision, "ready");
        run = this.get(runId)!;
        this.transition(runId, run.revision, "running");
        results = {};
        completed = new Set<string>();
        pending = new Set(plan.steps.map((step) => step.id));
      } else {
        plan = this.readFrozenPlan(runId);
        const state = this.readExecutionState(runId);
        results = state.results;
        completed = state.completed;
        pending = state.pending;
      }
      while (pending.size > 0) {
        const ready = plan.steps
          .filter((step) => pending.has(step.id) && step.dependsOn.every((dependency) => completed.has(dependency)))
          .slice(0, plan.maxParallelism);
        if (ready.length === 0) throw new Error("workflow_execution_deadlock");
        const outcomes = await Promise.all(ready.map(async (step) => {
          if (step.kind === "input_gate") {
            const resolved = valueAtPath(results[step.candidates.dependency], step.candidates.path ?? []);
            if (!resolved.found || !Array.isArray(resolved.value)) {
              return {
                step,
                skipped: false as const,
                outcome: { status: "failed" as const, errorCode: "workflow_input_gate_candidates_invalid" },
              };
            }
            const candidates: unknown[] = resolved.value;
            if (candidates.length === 0) {
              return {
                step,
                skipped: false as const,
                outcome: { status: "failed" as const, errorCode: "workflow_input_gate_no_candidates" },
              };
            }
            if (step.preselected) {
              const selected = valueAtPath(
                results[step.preselected.dependency],
                step.preselected.path ?? [],
              );
              if (!selected.found || !Array.isArray(selected.value)) {
                return {
                  step,
                  skipped: false as const,
                  outcome: { status: "failed" as const, errorCode: "workflow_input_gate_preselected_invalid" },
                };
              }
              if (selected.value.length > 0) {
                const canonicalSelections = selected.value.map(canonicalJson);
                const validCardinality = step.selectionMode === "multiple"
                  ? canonicalSelections.length <= candidates.length
                  : canonicalSelections.length === 1;
                const validSelection = validCardinality &&
                  new Set(canonicalSelections).size === canonicalSelections.length &&
                  selected.value.every((selection) =>
                    matchesJsonSchema(selection, step.selectionSchema) &&
                    candidates.some((candidate) => canonicalJson(candidate) === canonicalJson(selection)));
                if (!validSelection) {
                  return {
                    step,
                    skipped: false as const,
                    outcome: { status: "failed" as const, errorCode: "workflow_input_gate_preselected_invalid" },
                  };
                }
                return {
                  step,
                  skipped: false as const,
                  outcome: {
                    status: "succeeded" as const,
                    output: structuredClone(step.selectionMode === "multiple" ? selected.value : selected.value[0]),
                  },
                };
              }
            }
            if (candidates.length !== 1) {
              return {
                step,
                skipped: false as const,
                outcome: { status: "waiting_input" as const, candidates: structuredClone(candidates) },
              };
            }
            const selection = step.selectionMode === "multiple" ? [candidates[0]] : candidates[0];
            return {
              step,
              skipped: false as const,
              outcome: matchesJsonSchema(candidates[0], step.selectionSchema)
                ? { status: "succeeded" as const, output: structuredClone(selection) }
                : { status: "failed" as const, errorCode: "workflow_input_gate_selection_invalid" },
            };
          }
          if (step.kind === "map_capability") {
            return {
              step,
              skipped: false as const,
              outcome: await this.executeMapCapability(runId, step, plan, results),
            };
          }
          if (step.when && !conditionMatches(step.when, results)) {
            return { step, skipped: true as const };
          }
          const registration = this.capabilities.get(capabilityKey(step.capability, step.capabilityVersion));
          if (!registration) throw new Error("workflow_capability_version_unavailable");
          const dependencyResults = Object.fromEntries(step.dependsOn.map((dependency) => [dependency, results[dependency]]));
          let resourceKeys: string[];
          let input: Record<string, unknown>;
          try {
            resourceKeys = resolveResourceKeys(step, plan.steps, this.capabilities, results);
            input = resolveStepInput(step.input, step.inputBindings, results);
            this.setStepResourceKeys(runId, step.id, resourceKeys);
          } catch (error) {
            return {
              step,
              skipped: false as const,
              outcome: { status: "failed" as const, errorCode: sanitizeWorkflowError(error) },
            };
          }
          if (!matchesJsonSchema(input, registration.descriptor.inputSchema)) {
            return {
              step,
              skipped: false as const,
              outcome: { status: "failed" as const, errorCode: "workflow_step_input_invalid" },
            };
          }
          try {
            assertModulePermission(
              registration.descriptor,
              input,
              plan.authorizationSnapshots,
              this.modulePermissions,
            );
          } catch (error) {
            return {
              step,
              skipped: false as const,
              outcome: { status: "failed" as const, errorCode: sanitizeWorkflowError(error) },
            };
          }
          const invocation = {
            runId,
            stepId: step.id,
            capabilityId: step.capability,
            capabilityVersion: step.capabilityVersion,
            input,
            dependencyResults,
            resourceKeys,
          };
          const outcome = registration.descriptor.effect === "read"
            ? await invokeWithRetry({
                retry: step.retry,
                retryClass: registration.descriptor.retryClass,
                sleep: this.sleep,
                invoke: async () => {
                  this.incrementStepAttempt(runId, step.id);
                  try {
                    return await invokeWithTimeout(registration.provider.invoke(invocation), step.timeoutMs);
                  } catch (error) {
                    return {
                      status: "failed" as const,
                      errorCode: error instanceof Error && error.message === "workflow_step_timeout"
                        ? "workflow_step_timeout"
                        : "workflow_provider_failed",
                    };
                  }
                },
              })
            : await this.invokeEffect({
                runId,
                step,
                registration,
                invocation,
              });
          return {
            step,
            skipped: false as const,
            outcome: outcome.status === "succeeded" &&
              !matchesJsonSchema(outcome.output ?? null, registration.descriptor.outputSchema)
              ? { status: "failed" as const, errorCode: "workflow_step_output_invalid" }
              : outcome,
          };
        }));
        let failed = false;
        let waiting: { step: CompiledInputGateStep; candidates: unknown[] } | undefined;
        for (const result of outcomes) {
          const { step } = result;
          if (result.skipped) {
            pending.delete(step.id);
            completed.add(step.id);
            this.setStepOutcome(runId, step.id, "skipped");
            continue;
          }
          const { outcome } = result;
          if (outcome.status === "waiting_input") {
            if (step.kind !== "input_gate") throw new Error("workflow_input_gate_invalid");
            waiting = { step, candidates: outcome.candidates };
            continue;
          }
          pending.delete(step.id);
          if (outcome.status === "unknown") {
            this.setStepOutcome(runId, step.id, "unknown", outcome.errorCode);
            failed = true;
            continue;
          }
          if (outcome.status === "rejected") {
            this.setStepOutcome(runId, step.id, "rejected", outcome.errorCode);
            failed = true;
            continue;
          }
          if (outcome.status === "failed") {
            this.setStepOutcome(runId, step.id, "failed", outcome.errorCode);
            failed = true;
            continue;
          }
          results[step.id] = outcome.output;
          completed.add(step.id);
          this.setStepOutcome(runId, step.id, "succeeded", undefined, outcome.output);
        }
        if (failed) {
          const failedOutcome = outcomes.find((result) => !result.skipped &&
            new Set(["unknown", "failed", "rejected"]).has(result.outcome.status));
          let errorCode = "workflow_step_failed";
          if (failedOutcome && !failedOutcome.skipped) {
            if (failedOutcome.outcome.status === "unknown") errorCode = "workflow_effect_outcome_unknown";
            else if (failedOutcome.outcome.status === "failed" || failedOutcome.outcome.status === "rejected") {
              errorCode = sanitizeErrorCode(failedOutcome.outcome.errorCode);
            }
          }
          this.transitionCurrent(runId, runTerminalStatus(errorCode), errorCode);
          return;
        }
        if (waiting) {
          this.pauseForInput(runId, waiting.step, waiting.candidates);
          return;
        }
      }
      this.transitionCurrent(runId, "succeeded");
    } catch (error) {
      const errorCode = sanitizeWorkflowError(error);
      const current = this.get(runId);
      if (current?.status === "planning") this.transition(runId, current.revision, runTerminalStatus(errorCode), errorCode);
      else if (current?.status === "ready" || current?.status === "running") {
        this.transition(runId, current.revision, runTerminalStatus(errorCode), errorCode);
      }
    }
  }

  private async invokeEffect(input: {
    runId: string;
    step: CompiledCapabilityStep;
    registration: RegisteredCapability;
    invocation: Omit<WorkflowCapabilityInvocation, "effectRef" | "operationId">;
    attemptStepId?: string;
    itemOrdinal?: number;
    itemTotal?: number;
  }): Promise<WorkflowStepExecutionOutcome> {
    if (!this.diagnostics) return this.invokeEffectObserved(input);
    return this.diagnostics.run("workflow.effect", { ...this.diagnostics.references({ runId: input.runId }), itemOrdinal: input.itemOrdinal, itemTotal: input.itemTotal }, async () => {
      const result = await this.invokeEffectObserved(input);
      this.diagnostics?.result({ status: result.status, errorCode: "errorCode" in result ? result.errorCode : undefined });
      return result;
    });
  }

  private async invokeEffectObserved(input: {
    runId: string;
    step: CompiledCapabilityStep;
    registration: RegisteredCapability;
    invocation: Omit<WorkflowCapabilityInvocation, "effectRef" | "operationId">;
    attemptStepId?: string;
  }): Promise<WorkflowStepExecutionOutcome> {
    const { runId, step, registration, invocation } = input;
    const lease = await this.acquireResources(runId, step.id, invocation.resourceKeys);
    try {
      const effect = this.prepareEffect(runId, step, registration.descriptor);
      this.diagnostics?.result(this.diagnostics.references({ effectId: effect.effect_ref }));
      this.diagnostics?.checkpoint("workflow.effect", this.diagnostics.references({ runId, effectId: effect.effect_ref }));
      this.incrementStepAttempt(runId, input.attemptStepId ?? step.id);
      let outcome: WorkflowCapabilityOutcome;
      try {
        if (step.timeoutMs === undefined) throw new Error("workflow_step_timeout_invalid");
        outcome = await invokeWithTimeout(registration.provider.invoke({
          ...invocation,
          effectRef: effect.effect_ref,
          operationId: effect.operation_id,
        }), step.timeoutMs, true);
      } catch {
        this.settleEffect(effect.effect_ref, "unknown", "workflow_effect_outcome_unknown");
        return { status: "unknown", errorCode: "workflow_effect_outcome_unknown" };
      }
      if (outcome.status === "succeeded") {
        this.settleEffect(effect.effect_ref, "accepted");
        return outcome;
      }
      if (outcome.status === "failed") {
        const errorCode = sanitizeErrorCode(outcome.errorCode);
        this.settleEffect(effect.effect_ref, "rejected", errorCode);
        return { status: "rejected", errorCode };
      }
      const errorCode = sanitizeErrorCode(outcome.errorCode ?? "workflow_effect_outcome_unknown");
      this.settleEffect(effect.effect_ref, "unknown", errorCode);
      return { status: "unknown", errorCode };
    } finally {
      this.releaseResources(lease);
    }
  }

  private async executeMapCapability(
    runId: string,
    step: CompiledMapCapabilityStep,
    plan: CompiledPlan,
    results: Record<string, unknown>,
  ): Promise<WorkflowStepExecutionOutcome> {
    const registration = this.capabilities.get(capabilityKey(step.capability, step.capabilityVersion));
    if (!registration) return { status: "failed", errorCode: "workflow_capability_version_unavailable" };
    const resolved = valueAtPath(results[step.items.dependency], step.items.path ?? []);
    if (!resolved.found || !Array.isArray(resolved.value) || resolved.value.length < 1 ||
        resolved.value.length > step.maxItems) {
      return { status: "failed", errorCode: "workflow_map_items_invalid" };
    }
    const dependencyResults = Object.fromEntries(
      step.dependsOn.map((dependency) => [dependency, results[dependency]]),
    );
    const itemOutcomes: Array<{ ordinal: number; status: string; output?: unknown; errorCode?: string }> = [];
    const batch = { selectedCount: resolved.value.length, attemptedCount: 0, acceptedCount: 0, rejectedCount: 0, unknownCount: 0 };
    for (let index = 0; index < resolved.value.length; index += 1) {
      const item = resolved.value[index];
      const input = structuredClone(step.input);
      let bindingInvalid = false;
      for (const [target, binding] of Object.entries(step.itemInputBindings)) {
        const value = valueAtPath(item, binding.path ?? []);
        if (!value.found) {
          bindingInvalid = true;
          break;
        }
        input[target] = structuredClone(value.value);
      }
      if (bindingInvalid || !matchesJsonSchema(input, registration.descriptor.inputSchema)) {
        itemOutcomes.push({ ordinal: index + 1, status: "failed", errorCode: "workflow_step_input_invalid" });
        continue;
      }
      try {
        assertModulePermission(registration.descriptor, input, plan.authorizationSnapshots, this.modulePermissions);
      } catch (error) {
        itemOutcomes.push({
          ordinal: index + 1, status: "failed", errorCode: sanitizeWorkflowError(error),
        });
        continue;
      }
      const itemStep: CompiledCapabilityStep = {
        kind: "capability",
        id: `${step.id}#${index + 1}`,
        capability: step.capability,
        capabilityVersion: step.capabilityVersion,
        dependsOn: step.dependsOn,
        resourceKeys: [],
        resourceKeyBindings: [],
        retry: { maxAttempts: 1, initialBackoffMs: 0, maxElapsedMs: step.timeoutMs },
        input,
        inputBindings: {},
        timeoutMs: step.timeoutMs,
      };
      const invocation = {
        runId,
        stepId: itemStep.id,
        capabilityId: step.capability,
        capabilityVersion: step.capabilityVersion,
        input,
        dependencyResults,
        resourceKeys: [] as string[],
      };
      const outcome = registration.descriptor.effect === "read"
        ? await invokeWithTimeout(registration.provider.invoke(invocation), step.timeoutMs)
          .catch(() => ({ status: "failed" as const, errorCode: "workflow_provider_failed" }))
        : await this.invokeEffect({
            runId, step: itemStep, registration, invocation, attemptStepId: step.id, itemOrdinal: index + 1, itemTotal: resolved.value.length,
          });
      if (registration.descriptor.effect !== "read") {
        batch.attemptedCount += 1;
        if (outcome.status === "succeeded") batch.acceptedCount += 1;
        else if (outcome.status === "unknown") batch.unknownCount += 1;
        else batch.rejectedCount += 1;
      }
      if (outcome.status === "waiting_input") {
        itemOutcomes.push({ ordinal: index + 1, status: "failed", errorCode: "workflow_map_outcome_invalid" });
      } else if (outcome.status === "succeeded" &&
          !matchesJsonSchema(outcome.output ?? null, registration.descriptor.outputSchema)) {
        itemOutcomes.push({ ordinal: index + 1, status: "failed", errorCode: "workflow_step_output_invalid" });
      } else {
        itemOutcomes.push({
          ordinal: index + 1,
          status: outcome.status,
          ...(outcome.status === "succeeded" ? { output: outcome.output ?? null } : {}),
          ...(outcome.status !== "succeeded" ? { errorCode: outcome.errorCode } : {}),
        });
      }
    }
    if (registration.descriptor.effect !== "read") this.diagnostics?.checkpoint("workflow.batch", {
      ...this.diagnostics.references({ runId }), ...batch, notAttemptedCount: batch.selectedCount - batch.attemptedCount,
    });
    if (itemOutcomes.some((item) => item.status === "unknown")) {
      return { status: "unknown", errorCode: "workflow_effect_outcome_unknown" };
    }
    const failures = itemOutcomes.filter((item) => item.status !== "succeeded");
    if (failures.length > 0) {
      return {
        status: "rejected",
        errorCode: failures.length < itemOutcomes.length
          ? "workflow_map_partial_failure"
          : sanitizeErrorCode(failures[0]!.errorCode ?? "workflow_step_failed"),
      };
    }
    return { status: "succeeded", output: { items: itemOutcomes } };
  }

  private pauseForInput(runId: string, step: CompiledInputGateStep, candidates: unknown[]): void {
    const run = this.get(runId);
    if (!run || run.status !== "running") throw new Error("workflow_run_state_conflict");
    const at = this.now();
    const signalRef = `workflow-signal:${crypto.createHash("sha256").update(`${runId}\u0000${step.id}`).digest("hex")}`;
    const candidateHash = crypto.createHash("sha256").update(canonicalJson(candidates)).digest("hex");
    const nextRevision = run.revision + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.readRunBinding(runId);
      if (binding?.account_ref && binding.target_ref) {
        const newest = this.database.prepare(`
          SELECT run.run_id, run.occurred_at, run.created_at
          FROM workflow_signal_request AS request
          JOIN workflow_run AS run ON run.run_id = request.run_id
          WHERE request.state = 'waiting' AND run.status = 'needs_input'
            AND run.account_ref = ? AND run.target_ref = ? AND run.requester_ref IS ?
          ORDER BY run.occurred_at DESC, run.created_at DESC, run.run_id DESC
          LIMIT 1
        `).get(binding.account_ref, binding.target_ref, binding.requester_ref) as {
          run_id: string;
          occurred_at: number;
          created_at: number;
        } | undefined;
        if (newest && comparePendingOrder(
          { occurredAt: newest.occurred_at, createdAt: newest.created_at, runId: newest.run_id },
          { occurredAt: run.occurredAt, createdAt: run.createdAt, runId },
        ) > 0) {
          const cancelled = this.database.prepare(`
            UPDATE workflow_run SET status = 'cancelled', error_code = 'workflow_pending_superseded',
              revision = ?, updated_at = ?
            WHERE run_id = ? AND revision = ? AND status = 'running'
          `).run(nextRevision, at, runId, run.revision);
          if (Number(cancelled.changes) !== 1) throw new Error("workflow_pending_supersede_conflict");
          this.database.prepare(`
            INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
            VALUES (?, ?, 'superseded', ?)
          `).run(runId, nextRevision, at);
          this.database.exec("COMMIT");
          return;
        }
        this.supersedePendingSignalsInTransaction(binding.account_ref, binding.target_ref, at, runId, binding.requester_ref ?? undefined);
      }
      this.database.prepare(`
        INSERT INTO workflow_signal_request(
          signal_ref, run_id, step_id, candidate_hash, selection_schema_json,
          candidate_revision, expires_at, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
      `).run(
        signalRef,
        runId,
        step.id,
        candidateHash,
        canonicalJson(step.selectionSchema),
        nextRevision,
        at + step.expiresInMs,
        at,
        at,
      );
      const updated = this.database.prepare(`
        UPDATE workflow_run SET status = 'needs_input', error_code = NULL, revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ? AND status = 'running'
      `).run(nextRevision, at, runId, run.revision);
      if (Number(updated.changes) !== 1) throw new Error("workflow_revision_conflict");
      this.database.prepare(`
        INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
        VALUES (?, ?, 'needs_input', ?)
      `).run(runId, nextRevision, at);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private supersedePendingSignalsInTransaction(
    accountRef: string,
    targetRef: string,
    at: number,
    exceptRunId?: string,
    requesterRef?: string,
  ): string[] {
    const rows = this.database.prepare(`
      SELECT request.signal_ref, run.run_id, run.revision
      FROM workflow_signal_request AS request
      JOIN workflow_run AS run ON run.run_id = request.run_id
      WHERE request.state = 'waiting' AND run.status = 'needs_input'
        AND run.account_ref = ? AND run.target_ref = ? AND run.requester_ref IS ?
        AND (? IS NULL OR run.run_id <> ?)
      ORDER BY request.created_at, request.signal_ref
    `).all(accountRef, targetRef, requesterRef ?? null, exceptRunId ?? null, exceptRunId ?? null) as unknown as Array<{
      signal_ref: string;
      run_id: string;
      revision: number;
    }>;
    for (const row of rows) {
      const nextRevision = row.revision + 1;
      const request = this.database.prepare(`
        UPDATE workflow_signal_request SET state = 'superseded', updated_at = ?
        WHERE signal_ref = ? AND state = 'waiting'
      `).run(at, row.signal_ref);
      const run = this.database.prepare(`
        UPDATE workflow_run SET status = 'cancelled', error_code = 'workflow_pending_superseded',
          revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ? AND status = 'needs_input'
      `).run(nextRevision, at, row.run_id, row.revision);
      if (Number(request.changes) !== 1 || Number(run.changes) !== 1) {
        throw new Error("workflow_pending_supersede_conflict");
      }
      this.database.prepare(`
        INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
        VALUES (?, ?, 'superseded', ?)
      `).run(row.run_id, nextRevision, at);
    }
    return rows.map((row) => row.run_id);
  }

  private prepareEffect(
    runId: string,
    step: CompiledStep,
    descriptor: WorkflowCapabilityDescriptor,
  ): WorkflowEffectRow {
    const digest = crypto.createHash("sha256").update(`${runId}\u0000${step.id}`).digest("hex");
    const effectRef = `workflow-effect:${digest}`;
    const operationId = `workflow-operation:${digest}`;
    const at = this.now();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO workflow_effect(
        effect_ref, run_id, step_id, operation_id, capability_id, capability_version,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `).run(effectRef, runId, step.id, operationId, descriptor.id, descriptor.version, at, at);
    const record = this.readEffect(effectRef);
    if (!record) throw new Error("workflow_effect_prepare_failed");
    if (Number(result.changes) === 0 && (
      record.run_id !== runId || record.step_id !== step.id || record.operation_id !== operationId ||
      record.capability_id !== descriptor.id || record.capability_version !== descriptor.version
    )) throw new Error("workflow_effect_conflict");
    if (record.state !== "prepared") throw new Error("workflow_effect_replay_forbidden");
    return record;
  }

  private settleEffect(
    effectRef: string,
    state: "accepted" | "rejected" | "unknown",
    errorCode?: string,
    allowReconcile = false,
  ): void {
    const allowedState = allowReconcile ? "state IN ('prepared', 'unknown')" : "state = 'prepared'";
    const result = this.database.prepare(`
      UPDATE workflow_effect SET state = ?, error_code = ?, updated_at = ?
      WHERE effect_ref = ? AND ${allowedState}
    `).run(state, errorCode ?? null, this.now(), effectRef);
    if (Number(result.changes) !== 1) {
      const existing = this.readEffect(effectRef);
      if (existing?.state === state && (existing.error_code ?? undefined) === errorCode) return;
      throw new Error("workflow_effect_outcome_conflict");
    }
  }

  private readEffect(effectRef: string): WorkflowEffectRow | undefined {
    return this.database.prepare(`
      SELECT effect_ref, run_id, step_id, operation_id, capability_id, capability_version,
             state, error_code, created_at, updated_at
      FROM workflow_effect WHERE effect_ref = ?
    `).get(effectRef) as WorkflowEffectRow | undefined;
  }

  private readEffects(runId: string): Pick<WorkflowRunView, "effects"> {
    const rows = this.database.prepare(`
      SELECT effect_ref, run_id, step_id, operation_id, capability_id, capability_version,
             state, error_code, created_at, updated_at
      FROM workflow_effect WHERE run_id = ? ORDER BY created_at, step_id
    `).all(runId) as unknown as WorkflowEffectRow[];
    if (rows.length === 0) return {};
    return {
      effects: rows.map((row) => ({
        effectRef: row.effect_ref,
        stepId: row.step_id,
        operationId: row.operation_id,
        state: row.state,
        ...(row.error_code ? { errorCode: row.error_code } : {}),
      })),
    };
  }

  private async reconcileUnknownEffects(): Promise<void> {
    const rows = this.database.prepare(`
      SELECT effect_ref, run_id, step_id, operation_id, capability_id, capability_version,
             state, error_code, created_at, updated_at
      FROM workflow_effect WHERE state IN ('prepared', 'unknown')
      ORDER BY created_at, effect_ref
    `).all() as unknown as WorkflowEffectRow[];
    for (const row of rows) {
      const registration = this.capabilities.get(capabilityKey(row.capability_id, row.capability_version));
      if (!registration?.provider.reconcile) {
        if (row.state === "prepared") {
          this.settleEffect(row.effect_ref, "unknown", "workflow_effect_outcome_unknown");
          this.finishReconciledRun(row, { status: "unknown", errorCode: "workflow_effect_outcome_unknown" });
        }
        continue;
      }
      let outcome: WorkflowReconcileOutcome;
      try {
        outcome = await registration.provider.reconcile(row.effect_ref, { runId: row.run_id, operationId: row.operation_id });
      } catch {
        continue;
      }
      if (outcome.status === "unknown") {
        if (row.state === "prepared") {
          const errorCode = sanitizeErrorCode(outcome.errorCode ?? "workflow_effect_outcome_unknown");
          this.settleEffect(row.effect_ref, "unknown", errorCode, true);
          this.finishReconciledRun(row, { status: "unknown", errorCode });
        }
        continue;
      }
      if (outcome.status === "accepted") {
        this.settleEffect(row.effect_ref, "accepted", undefined, true);
        this.finishReconciledRun(row, outcome);
      } else {
        const errorCode = sanitizeErrorCode(outcome.errorCode);
        this.settleEffect(row.effect_ref, "rejected", errorCode, true);
        this.finishReconciledRun(row, { status: "rejected", errorCode });
      }
    }
  }

  private finishReconciledRun(row: WorkflowEffectRow, outcome: WorkflowReconcileOutcome): void {
    const run = this.get(row.run_id);
    if (!run || (run.status !== "outcome_unknown" && run.status !== "running")) return;
    const parentStepId = this.effectParentStepId(row.run_id, row.step_id);
    if (parentStepId !== row.step_id) {
      const unresolved = this.database.prepare(`
        SELECT COUNT(*) AS count FROM workflow_effect
        WHERE run_id = ? AND (step_id = ? OR substr(step_id, 1, length(?) + 1) = ? || '#')
          AND state IN ('prepared', 'unknown')
      `).get(row.run_id, parentStepId, parentStepId, parentStepId) as { count: number };
      if (unresolved.count > 0) {
        if (outcome.status === "unknown" && run.status !== "outcome_unknown") {
          this.replaceStepOutcome(row.run_id, parentStepId, "unknown", outcome.errorCode);
          this.transition(row.run_id, run.revision, "outcome_unknown", "workflow_effect_outcome_unknown");
        }
        return;
      }
      const settled = this.database.prepare(`
        SELECT state, error_code FROM workflow_effect
        WHERE run_id = ? AND (step_id = ? OR substr(step_id, 1, length(?) + 1) = ? || '#')
        ORDER BY step_id
      `).all(row.run_id, parentStepId, parentStepId, parentStepId) as unknown as Array<{
        state: WorkflowEffectRow["state"];
        error_code: string | null;
      }>;
      const rejected = settled.filter((effect) => effect.state === "rejected");
      if (rejected.length > 0) {
        const errorCode = rejected.length < settled.length
          ? "workflow_map_partial_failure"
          : sanitizeErrorCode(rejected[0]!.error_code ?? "workflow_step_failed");
        this.replaceStepOutcome(row.run_id, parentStepId, "rejected", errorCode);
        this.transition(row.run_id, run.revision, "failed", errorCode);
        return;
      }
      this.replaceStepOutcome(row.run_id, parentStepId, "succeeded");
      const unfinished = this.database.prepare(`
        SELECT COUNT(*) AS count FROM workflow_step
        WHERE run_id = ? AND status NOT IN ('succeeded', 'skipped')
      `).get(row.run_id) as { count: number };
      if (unfinished.count === 0) this.transition(row.run_id, run.revision, "succeeded");
      else this.transition(row.run_id, run.revision, "blocked", "workflow_recovery_output_unavailable");
      return;
    }
    if (outcome.status === "accepted") {
      this.replaceStepOutcome(row.run_id, row.step_id, "succeeded");
      const unresolvedEffects = this.database.prepare(`
        SELECT COUNT(*) AS count FROM workflow_effect
        WHERE run_id = ? AND state IN ('prepared', 'unknown')
      `).get(row.run_id) as { count: number };
      if (unresolvedEffects.count > 0) return;
      const unfinished = this.database.prepare(`
        SELECT COUNT(*) AS count FROM workflow_step
        WHERE run_id = ? AND status NOT IN ('succeeded', 'skipped')
      `).get(row.run_id) as { count: number };
      if (unfinished.count === 0) this.transition(row.run_id, run.revision, "succeeded");
      else this.transition(row.run_id, run.revision, "blocked", "workflow_recovery_output_unavailable");
      return;
    }
    if (outcome.status === "rejected") {
      this.replaceStepOutcome(row.run_id, row.step_id, "rejected", outcome.errorCode);
      this.transition(row.run_id, run.revision, "failed", outcome.errorCode);
      return;
    }
    this.replaceStepOutcome(row.run_id, row.step_id, "unknown", outcome.errorCode);
    if (run.status !== "outcome_unknown") {
      this.transition(row.run_id, run.revision, "outcome_unknown", "workflow_effect_outcome_unknown");
    }
  }

  private effectParentStepId(runId: string, effectStepId: string): string {
    const direct = this.database.prepare(
      "SELECT step_id FROM workflow_step WHERE run_id = ? AND step_id = ?",
    ).get(runId, effectStepId) as { step_id: string } | undefined;
    if (direct) return direct.step_id;
    const separator = effectStepId.lastIndexOf("#");
    if (separator < 1 || !/^\d+$/u.test(effectStepId.slice(separator + 1))) return effectStepId;
    const candidate = effectStepId.slice(0, separator);
    const parent = this.database.prepare(
      "SELECT step_id FROM workflow_step WHERE run_id = ? AND step_id = ?",
    ).get(runId, candidate) as { step_id: string } | undefined;
    return parent?.step_id ?? effectStepId;
  }

  private async acquireResources(runId: string, stepId: string, keys: string[]): Promise<ResourceLease | undefined> {
    if (keys.length === 0) return undefined;
    const sortedKeys = [...new Set(keys)].sort();
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.resourceLockWaitMs;
    while (true) {
      const at = this.now();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM workflow_resource_lease WHERE expires_at <= ?").run(at);
        const placeholders = sortedKeys.map(() => "?").join(",");
        const occupied = this.database.prepare(`
          SELECT resource_key FROM workflow_resource_lease WHERE resource_key IN (${placeholders}) LIMIT 1
        `).get(...sortedKeys);
        if (!occupied) {
          const insert = this.database.prepare(`
            INSERT INTO workflow_resource_lease(
              resource_key, run_id, step_id, lease_token, expires_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `);
          for (const key of sortedKeys) {
            insert.run(key, runId, stepId, token, at + this.resourceLeaseMs, at);
          }
          this.database.exec("COMMIT");
          const timer = setInterval(() => this.renewResources(token), Math.max(1, Math.floor(this.resourceLeaseMs / 3)));
          timer.unref();
          return { token, timer };
        }
        this.database.exec("ROLLBACK");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      if (Date.now() >= deadline) throw new Error("workflow_resource_busy");
      await this.sleep(this.resourceLockPollMs);
    }
  }

  private renewResources(token: string): void {
    try {
      const at = this.now();
      this.database.prepare(`
        UPDATE workflow_resource_lease SET expires_at = ?, updated_at = ? WHERE lease_token = ?
      `).run(at + this.resourceLeaseMs, at, token);
    } catch {
      // The foreground completion path remains authoritative; a lost lease fails closed at release/invoke boundaries.
    }
  }

  private releaseResources(lease: ResourceLease | undefined): void {
    if (!lease) return;
    clearInterval(lease.timer);
    this.database.prepare("DELETE FROM workflow_resource_lease WHERE lease_token = ?").run(lease.token);
  }

  private compile(workflowId: string, triggerInputRefs: Record<string, string>): CompiledPlan {
    const template = this.templates.get(workflowId);
    if (!template) throw new Error("workflow_template_unavailable");
    validateTemplate(template, this.capabilities);
    const steps = topologicalSteps(template.steps).map((step): CompiledStep => {
      if (step.kind === "input_gate") {
        return {
          kind: "input_gate",
          id: step.id,
          dependsOn: [...step.dependsOn],
          candidates: structuredClone(step.candidates),
          ...(step.preselected ? { preselected: structuredClone(step.preselected) } : {}),
          selectionSchema: structuredClone(step.selectionSchema),
          selectionMode: step.selectionMode ?? "single",
          autoSelect: step.autoSelect,
          expiresInMs: step.expiresInMs,
        };
      }
      if (step.kind === "map_capability") {
        const itemsSchema = mapItemsSchema(step, new Map(template.steps.map((item) => [item.id, item])), this.capabilities);
        if (itemsSchema?.type !== "array" || !Number.isSafeInteger(itemsSchema.maxItems)) {
          throw new Error("workflow_map_items_invalid");
        }
        return {
          kind: "map_capability",
          id: step.id,
          capability: step.capability,
          capabilityVersion: step.capabilityVersion,
          dependsOn: [...step.dependsOn],
          items: structuredClone(step.items),
          maxItems: itemsSchema.maxItems!,
          input: structuredClone(step.input ?? {}),
          itemInputBindings: structuredClone(step.itemInputBindings),
          timeoutMs: step.timeoutMs,
        };
      }
      return {
        kind: "capability",
        id: step.id,
        capability: step.capability,
        capabilityVersion: step.capabilityVersion,
        dependsOn: [...(step.dependsOn ?? [])],
        ...(step.when ? { when: structuredClone(step.when) } : {}),
        resourceKeys: [...(step.resourceKeys ?? [])].sort(),
        resourceKeyBindings: structuredClone(step.resourceKeyBindings ?? []).sort((left, right) =>
          `${left.dependency}\u0000${left.output}`.localeCompare(`${right.dependency}\u0000${right.output}`)),
        retry: structuredClone(step.retry ?? {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxElapsedMs: step.timeoutMs ?? 600_000,
        }),
        input: resolveTriggerInput(step, triggerInputRefs),
        inputBindings: structuredClone(step.inputBindings ?? {}),
        ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
        ...(step.timeoutMode === undefined ? {} : { timeoutMode: step.timeoutMode }),
      };
    });
    const authorizationSnapshots = collectAuthorizationSnapshots(steps, this.capabilities, this.modulePermissions);
    const frozen = {
      specId: template.id,
      specVersion: template.version,
      maxParallelism: template.maxParallelism,
      effectBudget: { ...template.effectBudget },
      authorizationSnapshots,
      steps,
    };
    return { ...frozen, planHash: crypto.createHash("sha256").update(canonicalJson(frozen)).digest("hex") };
  }

  private persistPlan(runId: string, plan: CompiledPlan): void {
    const at = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO workflow_plan(run_id, spec_id, spec_version, plan_hash, plan_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, plan.specId, plan.specVersion, plan.planHash, canonicalJson(plan), at);
      const insertStep = this.database.prepare(`
        INSERT INTO workflow_step(
          run_id, step_id, ordinal, capability_id, capability_version,
          depends_on_json, resource_keys_json, status, attempt_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
      `);
      plan.steps.forEach((step, ordinal) => {
        insertStep.run(
          runId, step.id, ordinal,
          step.kind === "input_gate" ? "workflow.input_gate" : step.capability,
          step.kind === "input_gate" ? 1 : step.capabilityVersion,
          JSON.stringify(step.dependsOn), JSON.stringify(step.kind === "capability" ? step.resourceKeys : []), at,
        );
      });
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readTriggerInputRefs(runId: string): Record<string, string> {
    const row = this.database.prepare(
      "SELECT trigger_input_refs_json FROM workflow_run WHERE run_id = ?",
    ).get(runId) as { trigger_input_refs_json: string } | undefined;
    if (!row) throw new Error("workflow_run_unavailable");
    try {
      const value: unknown = JSON.parse(row.trigger_input_refs_json);
      validateTriggerInputRefs(value);
      return value as Record<string, string>;
    } catch (error) {
      if (error instanceof Error && error.message === "workflow_trigger_input_invalid") throw error;
      throw new Error("workflow_trigger_input_invalid");
    }
  }

  private transition(runId: string, expectedRevision: number, status: WorkflowRunStatus, errorCode?: string): void {
    const at = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const nextRevision = expectedRevision + 1;
      const result = this.database.prepare(`
        UPDATE workflow_run SET status = ?, error_code = ?, revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(status, errorCode ?? null, nextRevision, at, runId, expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("workflow_revision_conflict");
      this.database.prepare(`
        INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
        VALUES (?, ?, ?, ?)
      `).run(runId, nextRevision, status, at);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.diagnostics?.checkpoint("workflow.state", { ...this.diagnostics.references({ runId }), status, revision: expectedRevision + 1, errorCode });
  }

  private transitionCurrent(runId: string, status: WorkflowRunStatus, errorCode?: string): void {
    const run = this.get(runId);
    if (!run) throw new Error("workflow_run_unavailable");
    this.transition(runId, run.revision, status, errorCode);
  }

  private setStepOutcome(
    runId: string,
    stepId: string,
    status: "succeeded" | "failed" | "rejected" | "unknown" | "skipped",
    errorCode?: string,
    output?: unknown,
  ): void {
    const result = this.database.prepare(`
      UPDATE workflow_step SET status = ?, error_code = ?, output_json = ?, updated_at = ?
      WHERE run_id = ? AND step_id = ? AND status = 'pending'
    `).run(status, errorCode ?? null, status === "succeeded" ? canonicalJson(output ?? null) : null, this.now(), runId, stepId);
    if (Number(result.changes) !== 1) throw new Error("workflow_step_state_conflict");
  }

  private replaceStepOutcome(
    runId: string,
    stepId: string,
    status: "succeeded" | "rejected" | "unknown",
    errorCode?: string,
  ): void {
    const result = this.database.prepare(`
      UPDATE workflow_step SET status = ?, error_code = ?, updated_at = ?
      WHERE run_id = ? AND step_id = ? AND status IN ('pending', 'unknown')
    `).run(status, errorCode ?? null, this.now(), runId, stepId);
    if (Number(result.changes) !== 1) throw new Error("workflow_step_state_conflict");
  }

  private incrementStepAttempt(runId: string, stepId: string): void {
    const result = this.database.prepare(`
      UPDATE workflow_step SET attempt_count = attempt_count + 1, updated_at = ?
      WHERE run_id = ? AND step_id = ? AND status = 'pending'
    `).run(this.now(), runId, stepId);
    if (Number(result.changes) !== 1) throw new Error("workflow_step_state_conflict");
  }

  private setStepResourceKeys(runId: string, stepId: string, resourceKeys: string[]): void {
    const result = this.database.prepare(`
      UPDATE workflow_step SET resource_keys_json = ?, updated_at = ?
      WHERE run_id = ? AND step_id = ? AND status = 'pending'
    `).run(JSON.stringify(resourceKeys), this.now(), runId, stepId);
    if (Number(result.changes) !== 1) throw new Error("workflow_step_state_conflict");
  }

  private readPlan(runId: string): Pick<WorkflowRunView, "plan"> {
    const plan = this.database.prepare(`
      SELECT spec_id, spec_version, plan_hash, plan_json FROM workflow_plan WHERE run_id = ?
    `).get(runId) as { spec_id: string; spec_version: number; plan_hash: string; plan_json: string } | undefined;
    if (!plan) return {};
    const rows = this.database.prepare(`
      SELECT step.step_id, step.capability_id, step.capability_version, step.depends_on_json,
             step.resource_keys_json,
             CASE WHEN request.state = 'waiting' THEN 'waiting_input' ELSE step.status END AS status,
             step.attempt_count
      FROM workflow_step AS step
      LEFT JOIN workflow_signal_request AS request
        ON request.run_id = step.run_id AND request.step_id = step.step_id
      WHERE step.run_id = ? ORDER BY step.ordinal
    `).all(runId) as unknown as WorkflowStepRow[];
    return {
      plan: {
        specId: plan.spec_id,
        specVersion: plan.spec_version,
        planHash: plan.plan_hash,
        effectBudget: (JSON.parse(plan.plan_json) as CompiledPlan).effectBudget,
        authorizationSnapshots: (JSON.parse(plan.plan_json) as CompiledPlan).authorizationSnapshots,
        steps: rows.map((row) => ({
          stepId: row.step_id,
          capabilityId: row.capability_id,
          capabilityVersion: row.capability_version,
          dependsOn: JSON.parse(row.depends_on_json) as string[],
          resourceKeys: JSON.parse(row.resource_keys_json) as string[],
          attemptCount: row.attempt_count,
          status: row.status as WorkflowStepView["status"],
        })),
      },
    };
  }
}

function publicRunRef(runId: string): string {
  return `wf-${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
}

type WorkflowRunRow = {
  run_id: string;
  source: string;
  trigger_id: string;
  requested_workflow_id: string | null;
  account_ref: string | null;
  target_ref: string | null;
  occurred_at: number;
  status: string;
  error_code: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
};

type WorkflowRunBindingRow = {
  run_id: string;
  account_ref: string | null;
  target_ref: string | null;
  requester_ref: string | null;
  status: WorkflowRunStatus;
  revision: number;
};

type WorkflowSignalRequestRow = {
  signal_ref: string;
  run_id: string;
  step_id: string;
  candidate_hash: string;
  selection_schema_json: string;
  candidate_revision: number;
  expires_at: number;
  state: "waiting" | "consumed" | "expired" | "superseded" | "cancelled";
  created_at: number;
  updated_at: number;
};

type WorkflowSignalRow = {
  signal_id: string;
  signal_ref: string;
  run_id: string;
  account_ref: string | null;
  target_ref: string | null;
  requester_ref: string | null;
  candidate_revision: number;
  selection_json: string;
  created_at: number;
};

type PendingCancellationRow = {
  cancellation_id: string;
  signal_ref: string;
  run_id: string;
  account_ref: string | null;
  target_ref: string | null;
  requester_ref: string | null;
  candidate_revision: number;
};

type WorkflowEffectRow = {
  effect_ref: string;
  run_id: string;
  step_id: string;
  operation_id: string;
  capability_id: string;
  capability_version: number;
  state: "prepared" | "accepted" | "rejected" | "unknown";
  error_code: string | null;
  created_at: number;
  updated_at: number;
};

type ResourceLease = {
  token: string;
  timer: NodeJS.Timeout;
};

function comparePendingOrder(
  left: { occurredAt: number; createdAt: number; runId: string },
  right: { occurredAt: number; createdAt: number; runId: string },
): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.runId.localeCompare(right.runId);
}

function decodeRun(row: WorkflowRunRow): WorkflowRunView {
  return {
    runId: row.run_id,
    source: row.source as WorkflowTrigger["source"],
    triggerId: row.trigger_id,
    ...(row.requested_workflow_id ? { requestedWorkflowId: row.requested_workflow_id } : {}),
    occurredAt: row.occurred_at,
    status: row.status as WorkflowRunView["status"],
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateTrigger(trigger: WorkflowTrigger): void {
  if (!isBoundedIdentifier(trigger.triggerId)) throw new Error("workflow_trigger_id_invalid");
  if (!new Set(["weixin", "scheduler", "fixture"]).has(trigger.source)) {
    throw new Error("workflow_trigger_source_invalid");
  }
  if (!Number.isSafeInteger(trigger.occurredAt) || trigger.occurredAt < 0) {
    throw new Error("workflow_trigger_time_invalid");
  }
  if (trigger.requestedWorkflowId !== undefined && !isBoundedIdentifier(trigger.requestedWorkflowId)) {
    throw new Error("workflow_template_id_invalid");
  }
  if (trigger.accountRef !== undefined && !isBoundedIdentifier(trigger.accountRef)) {
    throw new Error("workflow_account_ref_invalid");
  }
  if (trigger.targetRef !== undefined && !isBoundedIdentifier(trigger.targetRef)) {
    throw new Error("workflow_target_ref_invalid");
  }
  if (trigger.scheduleRef !== undefined && !isBoundedIdentifier(trigger.scheduleRef)) {
    throw new Error("workflow_schedule_ref_invalid");
  }
  if ((trigger.requesterRef !== undefined && !isBoundedIdentifier(trigger.requesterRef)) ||
      (trigger.source !== "scheduler" && trigger.targetRef?.startsWith("feishu.group.") && !trigger.requesterRef)) {
    throw new Error("workflow_requester_ref_invalid");
  }
  validateTriggerInputRefs(trigger.inputRefs ?? {});
}

function validateSignal(signal: WorkflowSignal): void {
  if (!isBoundedIdentifier(signal.signalId) || !isBoundedIdentifier(signal.signalRef)) {
    throw new Error("workflow_signal_invalid");
  }
  if (signal.accountRef !== undefined && !isBoundedIdentifier(signal.accountRef)) {
    throw new Error("workflow_signal_invalid");
  }
  if (signal.targetRef !== undefined && !isBoundedIdentifier(signal.targetRef)) {
    throw new Error("workflow_signal_invalid");
  }
  if (!Number.isSafeInteger(signal.expectedRevision) || signal.expectedRevision < 0) {
    throw new Error("workflow_signal_invalid");
  }
  if (signal.requesterRef !== undefined && !isBoundedIdentifier(signal.requesterRef)) {
    throw new Error("workflow_signal_invalid");
  }
  canonicalJson(signal.selection);
}

function validatePendingCancellation(cancellation: WorkflowPendingCancellation): void {
  if (!isBoundedIdentifier(cancellation.cancellationId) || !isBoundedIdentifier(cancellation.signalRef) ||
      (cancellation.accountRef !== undefined && !isBoundedIdentifier(cancellation.accountRef)) ||
      (cancellation.targetRef !== undefined && !isBoundedIdentifier(cancellation.targetRef)) ||
      (cancellation.requesterRef !== undefined && !isBoundedIdentifier(cancellation.requesterRef)) ||
      !Number.isSafeInteger(cancellation.expectedRevision) || cancellation.expectedRevision < 0) {
    throw new Error("workflow_pending_cancel_invalid");
  }
}

function duplicateCancellationReceipt(
  existing: PendingCancellationRow,
  cancellation: WorkflowPendingCancellation,
): WorkflowSignalReceipt {
  if (existing.signal_ref !== cancellation.signalRef ||
      existing.candidate_revision !== cancellation.expectedRevision ||
      existing.account_ref !== (cancellation.accountRef ?? null) ||
      existing.target_ref !== (cancellation.targetRef ?? null) ||
      existing.requester_ref !== (cancellation.requesterRef ?? null)) {
    throw new Error("workflow_pending_cancel_conflict");
  }
  return { runId: existing.run_id, duplicate: true };
}

function duplicateSignalReceipt(existing: WorkflowSignalRow, signal: WorkflowSignal): WorkflowSignalReceipt {
  if (existing.signal_ref !== signal.signalRef || existing.candidate_revision !== signal.expectedRevision ||
      existing.account_ref !== (signal.accountRef ?? null) ||
      existing.target_ref !== (signal.targetRef ?? null) ||
      existing.requester_ref !== (signal.requesterRef ?? null) || existing.selection_json !== canonicalJson(signal.selection)) {
    throw new Error("workflow_signal_conflict");
  }
  return { runId: existing.run_id, duplicate: true };
}

function hashCanonicalJson(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateTriggerInputRefs(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_trigger_input_invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > 16 || entries.some(([key, reference]) =>
    !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key) ||
    typeof reference !== "string" || !/^[a-z][a-z0-9]{1,31}_[a-f0-9]{32}$/.test(reference))) {
    throw new Error("workflow_trigger_input_invalid");
  }
}

function isBoundedIdentifier(value: string): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

type RegisteredCapability = {
  descriptor: WorkflowCapabilityDescriptor;
  provider: WorkflowCapabilityProvider;
};

type CompiledCapabilityStep = {
  kind: "capability";
  id: string;
  capability: string;
  capabilityVersion: number;
  dependsOn: string[];
  when?: WorkflowCondition;
  resourceKeys: string[];
  resourceKeyBindings: WorkflowResourceKeyBinding[];
  retry: WorkflowRetryPolicy;
  input: Record<string, unknown>;
  inputBindings: Record<string, WorkflowInputBinding>;
  timeoutMs?: number;
  timeoutMode?: "provider_managed";
};

type CompiledInputGateStep = {
  kind: "input_gate";
  id: string;
  dependsOn: string[];
  candidates: WorkflowInputBinding;
  preselected?: WorkflowInputBinding;
  selectionSchema: WorkflowJsonSchema;
  selectionMode: "single" | "multiple";
  autoSelect: "unique_only";
  expiresInMs: number;
};

type CompiledMapCapabilityStep = {
  kind: "map_capability";
  id: string;
  capability: string;
  capabilityVersion: number;
  dependsOn: string[];
  items: WorkflowInputBinding;
  maxItems: number;
  input: Record<string, unknown>;
  itemInputBindings: Record<string, WorkflowMapItemBinding>;
  timeoutMs: number;
};

type CompiledStep = CompiledCapabilityStep | CompiledInputGateStep | CompiledMapCapabilityStep;

type CompiledPlan = {
  specId: string;
  specVersion: number;
  planHash: string;
  maxParallelism: number;
  effectBudget: WorkflowEffectBudget;
  authorizationSnapshots: WorkflowAuthorizationSnapshot[];
  steps: CompiledStep[];
};

type WorkflowStepRow = {
  step_id: string;
  capability_id: string;
  capability_version: number;
  depends_on_json: string;
  resource_keys_json: string;
  status: string;
  attempt_count: number;
};

function capabilityKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function validateCapabilityDescriptor(descriptor: WorkflowCapabilityDescriptor): void {
  if (!isBoundedIdentifier(descriptor.id) || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1 ||
      !new Set(["read", "write", "external_send", "destructive"]).has(descriptor.effect) ||
      !new Set(["pure", "idempotent", "non_idempotent"]).has(descriptor.retryClass) ||
      !isValidJsonSchema(descriptor.inputSchema) || descriptor.inputSchema.type !== "object" ||
      !isValidJsonSchema(descriptor.outputSchema) || !validResourceKeyOutputs(descriptor)) {
    throw new Error("workflow_capability_invalid");
  }
  validateModulePermissionDescriptor(descriptor);
}

function validateModulePermissionDescriptor(descriptor: WorkflowCapabilityDescriptor): void {
  const permission = descriptor.modulePermission;
  if (!permission) return;
  const scopeField = permissionScopeField(permission);
  const scopeSchema = descriptor.inputSchema.properties?.[scopeField];
  const scopeIsList = "scopeListInput" in permission && permission.scopeListInput !== undefined;
  const staticModuleId = "moduleId" in permission ? permission.moduleId : undefined;
  const moduleIdInput = "moduleIdInput" in permission ? permission.moduleIdInput : undefined;
  const moduleSchema = moduleIdInput ? descriptor.inputSchema.properties?.[moduleIdInput] : undefined;
  if (typeof permission !== "object" || Array.isArray(permission) ||
      !isBoundedIdentifier(scopeField) ||
      ((staticModuleId === undefined) === (moduleIdInput === undefined)) ||
      (staticModuleId !== undefined && !isBoundedIdentifier(staticModuleId)) ||
      (moduleIdInput !== undefined && (!isBoundedIdentifier(moduleIdInput) || moduleSchema?.type !== "string" ||
        moduleIdInput === scopeField || !(descriptor.inputSchema.required ?? []).includes(moduleIdInput))) ||
      !new Set(["read", "write"]).has(permission.access) || descriptor.effect !== permission.access ||
      (scopeIsList
        ? scopeSchema?.type !== "array" || scopeSchema.items?.type !== "string" ||
          !Number.isSafeInteger(scopeSchema.maxItems) || Number(scopeSchema.maxItems) < 1
        : scopeSchema?.type !== "string") ||
      !(descriptor.inputSchema.required ?? []).includes(scopeField)) {
    throw new Error("workflow_capability_invalid");
  }
}

function permissionScopeField(permission: NonNullable<WorkflowCapabilityDescriptor["modulePermission"]>): string {
  const value = "scopeInput" in permission ? permission.scopeInput : permission.scopeListInput;
  return typeof value === "string" ? value : "";
}

function permissionScopeIds(
  permission: NonNullable<WorkflowCapabilityDescriptor["modulePermission"]>,
  input: Record<string, unknown>,
): string[] {
  const field = permissionScopeField(permission);
  const value = input[field];
  const ids = "scopeListInput" in permission ? value : [value];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 ||
      ids.some((scopeId) => typeof scopeId !== "string" || !isBoundedIdentifier(scopeId)) ||
      new Set(ids).size !== ids.length) {
    throw new Error("workflow_module_permission_denied");
  }
  return ids as string[];
}

function moduleIdForPermission(
  permission: NonNullable<WorkflowCapabilityDescriptor["modulePermission"]>,
  input: Record<string, unknown>,
): string {
  const value = "moduleId" in permission ? permission.moduleId : input[permission.moduleIdInput];
  if (typeof value !== "string" || !isBoundedIdentifier(value)) {
    throw new Error("workflow_module_permission_denied");
  }
  return value;
}

function collectAuthorizationSnapshots(
  steps: CompiledStep[],
  capabilities: Map<string, RegisteredCapability>,
  authorizer: WorkflowModulePermissionAuthorizer | undefined,
): WorkflowAuthorizationSnapshot[] {
  const snapshots = new Map<string, WorkflowAuthorizationSnapshot>();
  for (const step of steps) {
    if (step.kind === "input_gate") continue;
    const descriptor = capabilities.get(capabilityKey(step.capability, step.capabilityVersion))?.descriptor;
    const permission = descriptor?.modulePermission;
    if (!permission) continue;
    const moduleId = moduleIdForPermission(permission, step.input);
    const snapshot = snapshots.get(moduleId) ?? authorizer?.snapshot(moduleId);
    if (!snapshot || !snapshot.scopes.some((scope) => scope[permission.access])) {
      throw new Error("workflow_module_permission_denied");
    }
    const scopeField = permissionScopeField(permission);
    const dynamicScope = step.kind === "map_capability"
      ? Boolean(step.itemInputBindings[scopeField])
      : Boolean(step.inputBindings[scopeField]);
    if (!dynamicScope) {
      const scopeIds = permissionScopeIds(permission, step.input);
      if (scopeIds.some((scopeId) => !snapshot.scopes.find((scope) =>
        scope.scopeId === scopeId && scope[permission.access]))) {
        throw new Error("workflow_module_permission_denied");
      }
    }
    snapshots.set(moduleId, {
      moduleId: snapshot.moduleId,
      revision: snapshot.revision,
      scopes: [...snapshot.scopes]
        .map((scope) => ({ ...scope }))
        .sort((left, right) => left.scopeId.localeCompare(right.scopeId)),
    });
  }
  return [...snapshots.values()].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
}

function assertModulePermission(
  descriptor: WorkflowCapabilityDescriptor,
  input: Record<string, unknown>,
  snapshots: WorkflowAuthorizationSnapshot[],
  authorizer: WorkflowModulePermissionAuthorizer | undefined,
): void {
  const permission = descriptor.modulePermission;
  if (!permission) return;
  const moduleId = moduleIdForPermission(permission, input);
  const scopeIds = permissionScopeIds(permission, input);
  const snapshot = snapshots.find((candidate) => candidate.moduleId === moduleId);
  if (!authorizer || scopeIds.some((scopeId) => !snapshot?.scopes.find((scope) =>
    scope.scopeId === scopeId && scope[permission.access]))) {
    throw new Error("workflow_module_permission_denied");
  }
  for (const scopeId of scopeIds) authorizer.assertAllowed({ moduleId, access: permission.access, scopeId });
}

function validateTemplate(template: WorkflowTemplate, capabilities: Map<string, RegisteredCapability>): void {
  if (!isBoundedIdentifier(template.id) || !Number.isSafeInteger(template.version) || template.version < 1) {
    throw new Error("workflow_template_invalid");
  }
  if (!Number.isSafeInteger(template.maxSteps) || template.maxSteps < 1 || template.maxSteps > 32 ||
      !Number.isSafeInteger(template.maxDepth) || template.maxDepth < 1 || template.maxDepth > 8 ||
      !Number.isSafeInteger(template.maxParallelism) || template.maxParallelism < 1 || template.maxParallelism > 4 ||
      template.steps.length < 1 || template.steps.length > template.maxSteps) {
    throw new Error("workflow_plan_limit_exceeded");
  }
  const stepIds = new Set<string>();
  const stepsById = new Map<string, WorkflowStepSpec>();
  validateEffectBudget(template.effectBudget);
  const effectCounts: WorkflowEffectBudget = {};
  for (const step of template.steps) {
    if (!isBoundedIdentifier(step.id) || stepIds.has(step.id)) throw new Error("workflow_step_invalid");
    stepIds.add(step.id);
    stepsById.set(step.id, step);
  }
  for (const step of template.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!stepIds.has(dependency)) throw new Error("workflow_dependency_missing");
    }
    if (step.kind === "input_gate") {
      validateInputGateStep(step, stepsById, capabilities);
      continue;
    }
    if (step.kind === "map_capability") {
      const registration = capabilities.get(capabilityKey(step.capability, step.capabilityVersion));
      if (!registration) throw new Error("workflow_capability_version_unavailable");
      if (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 600_000) {
        throw new Error("workflow_step_timeout_invalid");
      }
      const itemsSchema = mapItemsSchema(step, stepsById, capabilities);
      if (itemsSchema?.type !== "array" || !itemsSchema.items || !Number.isSafeInteger(itemsSchema.maxItems) ||
          itemsSchema.maxItems! < 1 || itemsSchema.maxItems! > 32 ||
          !step.dependsOn.includes(step.items.dependency)) {
        throw new Error("workflow_map_items_invalid");
      }
      validateMapItemBindings(step, itemsSchema.items, registration.descriptor.inputSchema);
      const boundTargets = new Set(Object.keys(step.itemInputBindings));
      const staticRequired = registration.descriptor.inputSchema.required?.filter((key) => !boundTargets.has(key));
      if (!matchesJsonSchema(step.input ?? {}, {
        ...registration.descriptor.inputSchema,
        ...(staticRequired ? { required: staticRequired } : {}),
      })) throw new Error("workflow_step_input_invalid");
      effectCounts[registration.descriptor.effect] =
        (effectCounts[registration.descriptor.effect] ?? 0) + itemsSchema.maxItems!;
      continue;
    }
    if (step.timeoutMode !== undefined && step.timeoutMode !== "provider_managed") {
      throw new Error("workflow_step_timeout_invalid");
    }
    if ((step.timeoutMs === undefined) !== (step.timeoutMode === "provider_managed")) {
      throw new Error("workflow_step_timeout_invalid");
    }
    if (step.timeoutMs !== undefined &&
        (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 600_000)) {
      throw new Error("workflow_step_timeout_invalid");
    }
    if (step.when) {
      validateCondition(step.when, step.dependsOn ?? []);
      const dependency = stepsById.get(step.when.dependency);
      const dependencyOutputSchema = dependency ? stepOutputSchema(dependency, capabilities, stepsById) : undefined;
      if (!dependencyOutputSchema) throw new Error("workflow_capability_version_unavailable");
      if (!conditionMatchesSchema(step.when, dependencyOutputSchema)) {
        throw new Error("workflow_condition_schema_incompatible");
      }
    }
    const resourceKeys = step.resourceKeys ?? [];
    if (resourceKeys.some((key) => !isBoundedIdentifier(key)) || new Set(resourceKeys).size !== resourceKeys.length) {
      throw new Error("workflow_resource_key_invalid");
    }
    validateResourceKeyBindings(step, stepsById, capabilities);
    const registration = capabilities.get(capabilityKey(step.capability, step.capabilityVersion));
    if (!registration) throw new Error("workflow_capability_version_unavailable");
    if (step.timeoutMode === "provider_managed" &&
        (registration.descriptor.effect !== "read" || step.retry !== undefined)) {
      throw new Error("workflow_step_timeout_invalid");
    }
    validateRetryPolicy(step.retry, registration.descriptor.retryClass, step.timeoutMs);
    effectCounts[registration.descriptor.effect] = (effectCounts[registration.descriptor.effect] ?? 0) + 1;
    validateInputBindings(step, registration.descriptor.inputSchema, stepsById, capabilities);
    validateTriggerInputBindings(step, registration.descriptor.inputSchema);
    const boundTargets = new Set([
      ...Object.keys(step.inputBindings ?? {}),
      ...Object.keys(step.triggerInputBindings ?? {}),
    ]);
    const permission = registration.descriptor.modulePermission;
    if (permission && "moduleIdInput" in permission && boundTargets.has(permission.moduleIdInput)) {
      throw new Error("workflow_step_input_invalid");
    }
    const staticRequired = registration.descriptor.inputSchema.required?.filter((key) => !boundTargets.has(key));
    const staticInputSchema: WorkflowJsonSchema = {
      ...registration.descriptor.inputSchema,
      ...(staticRequired ? { required: staticRequired } : {}),
    };
    if (!matchesJsonSchema(step.input ?? {}, staticInputSchema)) {
      throw new Error("workflow_step_input_invalid");
    }
  }
  if (Object.entries(effectCounts).some(([effect, count]) =>
    count > (template.effectBudget[effect as WorkflowEffect] ?? 0))) {
    throw new Error("workflow_effect_budget_exceeded");
  }
  const ordered = topologicalSteps(template.steps);
  const depth = new Map<string, number>();
  for (const step of ordered) {
    const dependencies = step.dependsOn ?? [];
    depth.set(step.id, dependencies.length === 0 ? 1 : 1 + Math.max(...dependencies.map((id) => depth.get(id) ?? 0)));
  }
  if (Math.max(...depth.values()) > template.maxDepth) throw new Error("workflow_plan_depth_exceeded");
}

function validateInputGateStep(
  step: WorkflowInputGateStepSpec,
  stepsById: Map<string, WorkflowStepSpec>,
  capabilities: Map<string, RegisteredCapability>,
): void {
  if (step.autoSelect !== "unique_only" || !new Set(["single", "multiple"]).has(step.selectionMode ?? "single") ||
      !Number.isSafeInteger(step.expiresInMs) ||
      step.expiresInMs < 1_000 || step.expiresInMs > 7 * 24 * 60 * 60 * 1_000 ||
      !isValidJsonSchema(step.selectionSchema) || !isBoundedIdentifier(step.candidates.dependency) ||
      !step.dependsOn.includes(step.candidates.dependency) ||
      (step.candidates.path !== undefined && (!Array.isArray(step.candidates.path) ||
        step.candidates.path.length > 8 || step.candidates.path.some((segment) => !isBoundedIdentifier(segment)))) ||
      (step.preselected !== undefined && (!isBoundedIdentifier(step.preselected.dependency) ||
        !step.dependsOn.includes(step.preselected.dependency) ||
        (step.preselected.path !== undefined && (!Array.isArray(step.preselected.path) ||
          step.preselected.path.length > 8 ||
          step.preselected.path.some((segment) => !isBoundedIdentifier(segment))))))) {
    throw new Error("workflow_input_gate_invalid");
  }
  const dependency = stepsById.get(step.candidates.dependency);
  const outputSchema = dependency ? stepOutputSchema(dependency, capabilities, stepsById) : undefined;
  const candidatesSchema = outputSchema ? schemaAtPath(outputSchema, step.candidates.path ?? []) : undefined;
  if (candidatesSchema?.type !== "array" || !candidatesSchema.items ||
      !schemasCompatible(candidatesSchema.items, step.selectionSchema)) {
    throw new Error("workflow_input_gate_schema_incompatible");
  }
  if (step.preselected) {
    const preselectedDependency = stepsById.get(step.preselected.dependency);
    const preselectedOutputSchema = preselectedDependency
      ? stepOutputSchema(preselectedDependency, capabilities, stepsById)
      : undefined;
    const preselectedSchema = preselectedOutputSchema
      ? schemaAtPath(preselectedOutputSchema, step.preselected.path ?? [])
      : undefined;
    if (preselectedSchema?.type !== "array" || !preselectedSchema.items ||
        !schemasCompatible(preselectedSchema.items, step.selectionSchema)) {
      throw new Error("workflow_input_gate_schema_incompatible");
    }
  }
}

function stepOutputSchema(
  step: WorkflowStepSpec,
  capabilities: Map<string, RegisteredCapability>,
  stepsById?: Map<string, WorkflowStepSpec>,
): WorkflowJsonSchema | undefined {
  if (step.kind === "input_gate") {
    return step.selectionMode === "multiple"
      ? { type: "array", items: step.selectionSchema }
      : step.selectionSchema;
  }
  if (step.kind === "map_capability") {
    const descriptor = capabilities.get(capabilityKey(step.capability, step.capabilityVersion))?.descriptor;
    const itemSource = stepsById ? mapItemsSchema(step, stepsById, capabilities) : undefined;
    const maxItems = itemSource?.maxItems;
    if (!descriptor || itemSource?.type !== "array" || typeof maxItems !== "number" || !Number.isSafeInteger(maxItems)) {
      return { type: "object" };
    }
    return {
      type: "object",
      required: ["items"],
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          maxItems,
          items: {
            type: "object",
            required: ["ordinal", "status", "output"],
            additionalProperties: false,
            properties: {
              ordinal: { type: "integer" },
              status: { type: "string", enum: ["succeeded"] },
              output: descriptor.outputSchema,
            },
          },
        },
      },
    };
  }
  return capabilities.get(capabilityKey(step.capability, step.capabilityVersion))?.descriptor.outputSchema;
}

function mapItemsSchema(
  step: WorkflowMapCapabilityStepSpec,
  stepsById: Map<string, WorkflowStepSpec>,
  capabilities: Map<string, RegisteredCapability>,
): WorkflowJsonSchema | undefined {
  const dependency = stepsById.get(step.items.dependency);
  if (dependency?.kind === "input_gate" && dependency.selectionMode === "multiple" &&
      (step.items.path ?? []).length === 0) {
    const candidateDependency = stepsById.get(dependency.candidates.dependency);
    const candidateOutput = candidateDependency
      ? stepOutputSchema(candidateDependency, capabilities, stepsById)
      : undefined;
    const candidateSchema = candidateOutput
      ? schemaAtPath(candidateOutput, dependency.candidates.path ?? [])
      : undefined;
    return candidateSchema?.type === "array"
      ? { type: "array", items: dependency.selectionSchema, ...(candidateSchema.maxItems !== undefined
          ? { maxItems: candidateSchema.maxItems }
          : {}) }
      : undefined;
  }
  const outputSchema = dependency ? stepOutputSchema(dependency, capabilities, stepsById) : undefined;
  return outputSchema ? schemaAtPath(outputSchema, step.items.path ?? []) : undefined;
}

function validateMapItemBindings(
  step: WorkflowMapCapabilityStepSpec,
  itemSchema: WorkflowJsonSchema,
  inputSchema: WorkflowJsonSchema,
): void {
  const entries = Object.entries(step.itemInputBindings);
  if (entries.length < 1 || entries.some(([target, binding]) => {
    const targetSchema = inputSchema.properties?.[target];
    const sourceSchema = schemaAtPath(itemSchema, binding.path ?? []);
    return !isBoundedIdentifier(target) || !targetSchema || !sourceSchema ||
      (binding.path !== undefined && (binding.path.length > 8 ||
        binding.path.some((segment) => !isBoundedIdentifier(segment)))) ||
      !schemasCompatible(sourceSchema, targetSchema);
  })) throw new Error("workflow_map_binding_invalid");
}

function validateEffectBudget(budget: WorkflowEffectBudget | undefined): void {
  if (!budget) throw new Error("workflow_effect_budget_invalid");
  const effects = new Set<WorkflowEffect>(["read", "write", "external_send", "destructive"]);
  for (const [effect, count] of Object.entries(budget)) {
    if (!effects.has(effect as WorkflowEffect) || !Number.isSafeInteger(count) || count < 0 || count > 32) {
      throw new Error("workflow_effect_budget_invalid");
    }
  }
}

function validateRetryPolicy(
  policy: WorkflowRetryPolicy | undefined,
  retryClass: WorkflowCapabilityDescriptor["retryClass"],
  timeoutMs: number | undefined,
): void {
  if (!policy) return;
  if (timeoutMs === undefined || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 5 ||
      !Number.isSafeInteger(policy.initialBackoffMs) || policy.initialBackoffMs < 0 || policy.initialBackoffMs > 60_000 ||
      !Number.isSafeInteger(policy.maxElapsedMs) || policy.maxElapsedMs < 1 || policy.maxElapsedMs > 600_000 ||
      (policy.maxAttempts > 1 && retryClass !== "pure")) {
    throw new Error("workflow_retry_policy_invalid");
  }
  const requiredElapsedMs = timeoutMs * policy.maxAttempts + Array.from(
    { length: policy.maxAttempts - 1 },
    (_, index) => policy.initialBackoffMs * (2 ** index),
  ).reduce((total, backoff) => total + backoff, 0);
  if (policy.maxElapsedMs < requiredElapsedMs) throw new Error("workflow_retry_policy_invalid");
}

function validateCondition(condition: WorkflowCondition, dependencies: string[]): void {
  if (!isBoundedIdentifier(condition.dependency) || !dependencies.includes(condition.dependency) ||
      (condition.path !== undefined && (!Array.isArray(condition.path) || condition.path.length > 8 ||
        condition.path.some((segment) => !isBoundedIdentifier(segment)))) ||
      (condition.equals !== null && !["boolean", "number", "string"].includes(typeof condition.equals)) ||
      (typeof condition.equals === "number" && !Number.isFinite(condition.equals))) {
    throw new Error("workflow_condition_invalid");
  }
}

function validateInputBindings(
  step: WorkflowCapabilityStepSpec,
  inputSchema: WorkflowJsonSchema,
  stepsById: Map<string, WorkflowStepSpec>,
  capabilities: Map<string, RegisteredCapability>,
): void {
  if (step.inputBindings !== undefined &&
      (!step.inputBindings || typeof step.inputBindings !== "object" || Array.isArray(step.inputBindings))) {
    throw new Error("workflow_input_binding_invalid");
  }
  for (const [target, binding] of Object.entries(step.inputBindings ?? {})) {
    if (!isBoundedIdentifier(target) || Object.hasOwn(step.input ?? {}, target) ||
        !binding || typeof binding !== "object" || Array.isArray(binding) ||
        !isBoundedIdentifier(binding.dependency) || !(step.dependsOn ?? []).includes(binding.dependency) ||
        (binding.path !== undefined && (!Array.isArray(binding.path) || binding.path.length > 8 ||
          binding.path.some((segment) => !isBoundedIdentifier(segment)))) ||
        inputSchema.type !== "object" || !inputSchema.properties || !Object.hasOwn(inputSchema.properties, target)) {
      throw new Error("workflow_input_binding_invalid");
    }
    const dependency = stepsById.get(binding.dependency);
    const dependencyOutputSchema = dependency ? stepOutputSchema(dependency, capabilities, stepsById) : undefined;
    const sourceSchema = dependencyOutputSchema
      ? schemaAtPath(dependencyOutputSchema, binding.path ?? [])
      : undefined;
    if (!sourceSchema || !schemasCompatible(sourceSchema, inputSchema.properties[target]!)) {
      throw new Error("workflow_input_binding_schema_incompatible");
    }
  }
}

function validateTriggerInputBindings(step: WorkflowCapabilityStepSpec, inputSchema: WorkflowJsonSchema): void {
  const bindings = step.triggerInputBindings;
  if (bindings !== undefined && (!bindings || typeof bindings !== "object" || Array.isArray(bindings))) {
    throw new Error("workflow_trigger_input_binding_invalid");
  }
  if (Object.keys(bindings ?? {}).length > 16) throw new Error("workflow_trigger_input_binding_invalid");
  for (const [target, source] of Object.entries(bindings ?? {})) {
    const targetSchema = inputSchema.properties?.[target];
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(target) ||
        !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(source) ||
        Object.hasOwn(step.input ?? {}, target) || Object.hasOwn(step.inputBindings ?? {}, target) ||
        inputSchema.type !== "object" || targetSchema?.type !== "string") {
      throw new Error("workflow_trigger_input_binding_invalid");
    }
  }
}

function validResourceKeyOutputs(descriptor: WorkflowCapabilityDescriptor): boolean {
  if (descriptor.resourceKeyOutputs !== undefined &&
      (!descriptor.resourceKeyOutputs || typeof descriptor.resourceKeyOutputs !== "object" ||
        Array.isArray(descriptor.resourceKeyOutputs))) return false;
  for (const [name, output] of Object.entries(descriptor.resourceKeyOutputs ?? {})) {
    if (!isBoundedIdentifier(name) || !output || typeof output !== "object" || Array.isArray(output) ||
        !Array.isArray(output.path) || output.path.length > 8 ||
        output.path.some((segment) => !isBoundedIdentifier(segment)) ||
        schemaAtPath(descriptor.outputSchema, output.path)?.type !== "string") return false;
  }
  return true;
}

function validateResourceKeyBindings(
  step: WorkflowCapabilityStepSpec,
  stepsById: Map<string, WorkflowStepSpec>,
  capabilities: Map<string, RegisteredCapability>,
): void {
  if (step.resourceKeyBindings !== undefined && !Array.isArray(step.resourceKeyBindings)) {
    throw new Error("workflow_resource_key_binding_invalid");
  }
  const seen = new Set<string>();
  for (const binding of step.resourceKeyBindings ?? []) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
        !isBoundedIdentifier(binding.dependency) || !(step.dependsOn ?? []).includes(binding.dependency) ||
        !isBoundedIdentifier(binding.output)) throw new Error("workflow_resource_key_binding_invalid");
    const signature = `${binding.dependency}\u0000${binding.output}`;
    if (seen.has(signature)) throw new Error("workflow_resource_key_binding_invalid");
    seen.add(signature);
    const dependency = stepsById.get(binding.dependency);
    const descriptor = dependency && dependency.kind !== "input_gate"
      ? capabilities.get(capabilityKey(dependency.capability, dependency.capabilityVersion))?.descriptor
      : undefined;
    if (!descriptor?.resourceKeyOutputs?.[binding.output]) {
      throw new Error("workflow_resource_key_binding_invalid");
    }
  }
}

function resolveResourceKeys(
  step: CompiledCapabilityStep,
  planSteps: CompiledStep[],
  capabilities: Map<string, RegisteredCapability>,
  results: Record<string, unknown>,
): string[] {
  const keys = [...step.resourceKeys];
  for (const binding of step.resourceKeyBindings) {
    const dependency = planSteps.find((candidate) => candidate.id === binding.dependency);
    const descriptor = dependency && dependency.kind !== "input_gate"
      ? capabilities.get(capabilityKey(dependency.capability, dependency.capabilityVersion))?.descriptor
      : undefined;
    const output = descriptor?.resourceKeyOutputs?.[binding.output];
    const resolved = output ? valueAtPath(results[binding.dependency], output.path) : { found: false as const };
    if (!resolved.found || typeof resolved.value !== "string" || !isBoundedIdentifier(resolved.value)) {
      throw new Error("workflow_resource_key_resolution_failed");
    }
    keys.push(resolved.value);
  }
  if (new Set(keys).size !== keys.length) throw new Error("workflow_resource_key_resolution_failed");
  return keys.sort();
}

function resolveStepInput(
  staticInput: Record<string, unknown>,
  bindings: Record<string, WorkflowInputBinding>,
  results: Record<string, unknown>,
): Record<string, unknown> {
  const input = structuredClone(staticInput);
  for (const [target, binding] of Object.entries(bindings)) {
    const resolved = valueAtPath(results[binding.dependency], binding.path ?? []);
    if (!resolved.found) throw new Error("workflow_input_binding_missing");
    input[target] = structuredClone(resolved.value);
  }
  return input;
}

function resolveTriggerInput(
  step: WorkflowCapabilityStepSpec,
  triggerInputRefs: Record<string, string>,
): Record<string, unknown> {
  const input = structuredClone(step.input ?? {});
  for (const [target, source] of Object.entries(step.triggerInputBindings ?? {})) {
    if (!Object.hasOwn(triggerInputRefs, source)) throw new Error("workflow_trigger_input_missing");
    const reference = triggerInputRefs[source]!;
    input[target] = reference;
  }
  return input;
}

function conditionMatches(condition: WorkflowCondition, results: Record<string, unknown>): boolean {
  let value = results[condition.dependency];
  for (const segment of condition.path ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !Object.hasOwn(value as Record<string, unknown>, segment)) return false;
    value = (value as Record<string, unknown>)[segment];
  }
  return Object.is(value, condition.equals);
}

function conditionMatchesSchema(condition: WorkflowCondition, outputSchema: WorkflowJsonSchema): boolean {
  const schema = schemaAtPath(outputSchema, condition.path ?? []);
  return schema ? matchesJsonSchema(condition.equals, schema) : false;
}

function schemaAtPath(schema: WorkflowJsonSchema, segments: string[]): WorkflowJsonSchema | undefined {
  let current = schema;
  for (const segment of segments) {
    if (current.type !== "object" || !current.properties || !Object.hasOwn(current.properties, segment)) return undefined;
    current = current.properties[segment]!;
  }
  return current;
}

function schemasCompatible(source: WorkflowJsonSchema, target: WorkflowJsonSchema): boolean {
  if (target.type === undefined) return true;
  if (source.type !== target.type && !(source.type === "integer" && target.type === "number")) return false;
  if (target.enum) {
    return Boolean(source.enum?.every((value) => target.enum!.some((candidate) => Object.is(candidate, value))));
  }
  if (target.type === "array" && target.items) {
    return Boolean(source.items && schemasCompatible(source.items, target.items));
  }
  if (target.type === "object") {
    const sourceProperties = source.properties ?? {};
    const targetProperties = target.properties ?? {};
    for (const required of target.required ?? []) {
      if (!(source.required ?? []).includes(required) || !sourceProperties[required] ||
          !targetProperties[required] || !schemasCompatible(sourceProperties[required], targetProperties[required])) return false;
    }
    for (const [key, sourceProperty] of Object.entries(sourceProperties)) {
      const targetProperty = targetProperties[key];
      if (targetProperty && !schemasCompatible(sourceProperty, targetProperty)) return false;
      if (!targetProperty && target.additionalProperties === false) return false;
    }
    if (target.additionalProperties === false && source.additionalProperties !== false) return false;
  }
  return true;
}

function valueAtPath(value: unknown, segments: string[]): { found: true; value: unknown } | { found: false } {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current) ||
        !Object.hasOwn(current as Record<string, unknown>, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

export function isValidJsonSchema(schema: unknown, depth = 0): schema is WorkflowJsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 16) return false;
  const candidate = schema as WorkflowJsonSchema;
  if (candidate.type !== undefined && !new Set([
    "null", "boolean", "number", "integer", "string", "array", "object",
  ]).has(candidate.type)) return false;
  if (candidate.enum !== undefined && (!Array.isArray(candidate.enum) || candidate.enum.length === 0 ||
      candidate.enum.some((value) => value !== null && !["boolean", "number", "string"].includes(typeof value)))) {
    return false;
  }
  const candidateType = candidate.type;
  if (candidate.enum && candidateType &&
      candidate.enum.some((value) => !matchesJsonSchema(value, { type: candidateType }))) return false;
  if (candidate.required !== undefined && (!Array.isArray(candidate.required) ||
      candidate.required.some((key) => !isBoundedIdentifier(key)) || new Set(candidate.required).size !== candidate.required.length)) {
    return false;
  }
  if (candidate.additionalProperties !== undefined && typeof candidate.additionalProperties !== "boolean") return false;
  if (candidate.properties !== undefined) {
    if (!candidate.properties || typeof candidate.properties !== "object" || Array.isArray(candidate.properties)) return false;
    for (const [key, child] of Object.entries(candidate.properties)) {
      if (!isBoundedIdentifier(key) || !isValidJsonSchema(child, depth + 1)) return false;
    }
  }
  if (candidate.required?.some((key) => !Object.hasOwn(candidate.properties ?? {}, key))) return false;
  if (candidate.items !== undefined && !isValidJsonSchema(candidate.items, depth + 1)) return false;
  if (candidate.maxItems !== undefined &&
      (!Number.isSafeInteger(candidate.maxItems) || candidate.maxItems < 0 || candidate.maxItems > 10_000)) return false;
  if (candidate.type !== "object" &&
      (candidate.required !== undefined || candidate.properties !== undefined || candidate.additionalProperties !== undefined)) return false;
  if (candidate.type !== "array" && (candidate.items !== undefined || candidate.maxItems !== undefined)) return false;
  return true;
}

export function matchesJsonSchema(value: unknown, schema: WorkflowJsonSchema): boolean {
  if (!isJsonData(value)) return false;
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isSafeInteger(value);
    case "string": return typeof value === "string";
    case "array":
      return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        (!schema.items || value.every((item) => matchesJsonSchema(item, schema.items!)));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (schema.required?.some((key) => !Object.hasOwn(record, key))) return false;
      if (schema.additionalProperties === false &&
          Object.keys(record).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
      return Object.entries(schema.properties ?? {}).every(([key, child]) =>
        !Object.hasOwn(record, key) || matchesJsonSchema(record[key], child));
    }
    default:
      return value === null || ["boolean", "number", "string"].includes(typeof value) ||
        (Array.isArray(value) && value.every((item) => matchesJsonSchema(item, {}))) ||
        (!!value && typeof value === "object" && Object.values(value as Record<string, unknown>)
          .every((item) => matchesJsonSchema(item, {})));
  }
}

function isJsonData(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const valid = children.every((child) => isJsonData(child, ancestors));
  ancestors.delete(value);
  return valid;
}

function topologicalSteps(steps: WorkflowStepSpec[]): WorkflowStepSpec[] {
  const pending = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const ordered: WorkflowStepSpec[] = [];
  while (pending.size > 0) {
    const ready = steps.filter((step) => pending.has(step.id) && (step.dependsOn ?? []).every((id) => completed.has(id)));
    if (ready.length === 0) throw new Error("workflow_plan_cycle");
    for (const step of ready) {
      pending.delete(step.id);
      completed.add(step.id);
      ordered.push(step);
    }
  }
  return ordered;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeWorkflowError(error: unknown): string {
  if (error instanceof Error && /^workflow_[a-z0-9_]{1,120}$/.test(error.message)) return error.message;
  return "workflow_provider_failed";
}

function sanitizeErrorCode(errorCode: string): string {
  return /^[a-z][a-z0-9_]{0,120}$/.test(errorCode) ? errorCode : "workflow_step_failed";
}

function runTerminalStatus(errorCode: string): "failed" | "blocked" | "outcome_unknown" {
  if (errorCode === "workflow_effect_outcome_unknown") return "outcome_unknown";
  return errorCode === "workflow_module_permission_denied" ? "blocked" : "failed";
}

async function invokeWithTimeout(
  invocation: Promise<WorkflowCapabilityOutcome>,
  timeoutMs: number | undefined,
  unknownOnTimeout = false,
): Promise<WorkflowCapabilityOutcome> {
  if (timeoutMs === undefined) return await invocation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invocation,
      new Promise<WorkflowCapabilityOutcome>((resolve) => {
        timer = setTimeout(() => resolve(unknownOnTimeout
          ? { status: "unknown", errorCode: "workflow_effect_outcome_unknown" }
          : { status: "failed", errorCode: "workflow_step_timeout", retryable: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeWithRetry(input: {
  retry: WorkflowRetryPolicy;
  retryClass: WorkflowCapabilityDescriptor["retryClass"];
  sleep: (milliseconds: number) => Promise<void>;
  invoke: () => Promise<WorkflowCapabilityOutcome>;
}): Promise<WorkflowCapabilityOutcome> {
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= input.retry.maxAttempts; attempt += 1) {
    const outcome = await input.invoke();
    if (outcome.status !== "failed" || !outcome.retryable || input.retryClass !== "pure" ||
        attempt === input.retry.maxAttempts) return outcome;
    const backoffMs = input.retry.initialBackoffMs * (2 ** (attempt - 1));
    if (Date.now() - startedAt + backoffMs > input.retry.maxElapsedMs) return outcome;
    await input.sleep(backoffMs);
  }
  return { status: "failed", errorCode: "workflow_retry_exhausted" };
}

function validateDuration(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) throw new Error(errorCode);
  return value;
}
