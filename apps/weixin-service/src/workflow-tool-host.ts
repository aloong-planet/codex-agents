import type { SpanContext } from "@opentelemetry/api";
import { isDeepStrictEqual } from "node:util";
import type { LocalDiagnostics } from "./local-diagnostics.js";
import type { DynamicToolContext, DynamicToolHost, DynamicToolResult } from "./dynamic-tool-host.js";
import type { WorkflowToolCatalog } from "./workflow-tool-catalog.js";

export type WorkflowToolRequest = {
  toolId: string;
  toolVersion: number;
  arguments: unknown;
};

export type TrustedWorkflowTurn = {
  eventKey: string;
  accountId: string;
  target: string;
  requesterRef?: string;
  senderAccountId?: string;
  dispatchRequestId?: string;
  dispatchRetry?: boolean;
  occurredAt: number;
  originalTextRef: string;
  attachmentRefs: string[];
  quoteRef?: string;
};

export type WorkflowHandoffReceipt = {
  outcome: "accepted" | "rejected" | "needs_input" | "blocked" | "waiting_external" | "unknown";
  reply: string;
  runRef?: string;
  onAccepted?: () => Promise<void> | void;
};

export type WorkflowToolGatewayResult =
  | { disposition: "continue"; result: unknown }
  | { disposition: "claimed"; runRef: string; receipt?: WorkflowHandoffReceipt; receiptErrorCode?: string };

export interface WorkflowToolGateway {
  submit(request: WorkflowToolRequest, trusted: TrustedWorkflowTurn): Promise<WorkflowToolGatewayResult>;
}

export interface InlineWorkflowToolExecutor {
  execute(request: WorkflowToolRequest, trusted: TrustedWorkflowTurn): Promise<unknown>;
}

export type WorkflowToolTurnSnapshot =
  | { owner: "model"; turnId?: string }
  | { owner: "workflow"; turnId: string; runRef?: string; receipt?: WorkflowHandoffReceipt; receiptErrorCode?: string };

export type WorkflowToolTurnBinding = {
  promptLines?: string[];
  snapshot(): WorkflowToolTurnSnapshot;
  seal(): void;
  drain(): Promise<void>;
  release(): Promise<void>;
  resume?(): string[];
  recoveryBlocked?(): boolean;
};

export type WorkflowToolTraceEvent = {
  toolId: string;
  toolVersion: number;
  executionClass: "inline_query" | "inline_mutation" | "terminal_workflow";
  argumentSummary: {
    keys: string[];
    unknownKeyCount?: number;
    stringLengths?: Record<string, number>;
    arrayLengths?: Record<string, number>;
    queryInputs?: Record<string, unknown>;
    queryOptions?: Record<string, string | number | Record<string, string>>;
  };
  waitMs: number;
  durationMs: number;
  resultBytes: number;
  resultSuccess: boolean;
  resultSummary?: {
    scanComplete: boolean; resultTruncated: boolean; entryCount?: number; matchCount?: number;
    skippedCount?: number; skippedByReason?: Record<string, number>;
  };
  errorCode?: string;
  ownerBefore: "model" | "workflow";
  ownerAfter: "model" | "workflow";
  runRef?: string;
};

export type WorkflowToolHostOptions = {
  diagnostics?: LocalDiagnostics;
  now?: () => number;
  trace?: (event: WorkflowToolTraceEvent) => void;
};

type Binding = {
  diagnosticParent?: SpanContext;
  trusted: TrustedWorkflowTurn;
  owner: "model" | "terminal_preflighting" | "workflow";
  acceptedCalls: number;
  mutationQueues: Map<string, Promise<void>>;
  activeMutations: Set<Promise<void>>;
  sealed: boolean;
  operations: Set<Promise<unknown>>;
  turnId?: string;
  receipt?: WorkflowHandoffReceipt;
  runRef?: string;
  receiptErrorCode?: string;
  recovered: boolean;
  retiredTurns: Set<string>;
  observations: Array<{ toolId: string; arguments: unknown; result: DynamicToolResult; mutation: boolean }>;
  uncertainEffect: boolean;
};

const MAX_TOOL_RESULT_BYTES = 65_536;
const MAX_TOOL_CALLS_PER_TURN = 24;

export class WorkflowToolHost implements DynamicToolHost {
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private readonly catalog: WorkflowToolCatalog,
    private readonly gateway: WorkflowToolGateway,
    private readonly inlineTools?: InlineWorkflowToolExecutor,
    private readonly options: WorkflowToolHostOptions = {},
  ) {}

  definitions() {
    return this.catalog.definitions();
  }

  contractHash(): string {
    return this.catalog.contractHash();
  }

  turnOwner(context: DynamicToolContext): "model" | "workflow" {
    const binding = this.bindings.get(context.threadId);
    if (!binding || (binding.turnId !== undefined && binding.turnId !== context.turnId)) return "model";
    return publicOwner(binding.owner);
  }

  bind(threadId: string, trusted: TrustedWorkflowTurn): WorkflowToolTurnBinding {
    if (!threadId || this.bindings.has(threadId)) throw new Error("workflow_tool_turn_already_bound");
    const binding: Binding = {
      trusted: structuredClone(trusted),
      owner: "model",
      acceptedCalls: 0,
      mutationQueues: new Map(),
      activeMutations: new Set(),
      sealed: false,
      operations: new Set(),
      recovered: false, retiredTurns: new Set(), observations: [], uncertainEffect: false,
      ...(this.options.diagnostics?.current() ? { diagnosticParent: this.options.diagnostics.current()! } : {}),
    };
    this.bindings.set(threadId, binding);
    const seal = () => { binding.sealed = true; };
    let draining: Promise<void> | undefined;
    const drain = () => {
      seal();
      return draining ??= Promise.allSettled([...binding.operations]).then(() => undefined);
    };
    let releasing: Promise<void> | undefined;
    return {
      snapshot: () => snapshotBinding(binding),
      seal,
      drain,
      recoveryBlocked: () => binding.recovered && binding.uncertainEffect,
      resume: () => {
        if (!binding.sealed || binding.operations.size || releasing || binding.owner !== "model" || binding.uncertainEffect) {
          throw new Error("model_recovery_effect_unconfirmed");
        }
        if (binding.turnId) binding.retiredTurns.add(binding.turnId);
        delete binding.turnId;
        binding.sealed = false;
        binding.recovered = true;
        draining = undefined;
        const evidence = binding.observations.map((entry) => JSON.stringify({ tool: entry.toolId, arguments: entry.arguments,
          result: entry.result, ...(entry.mutation ? { alreadyExecuted: true } : {}) }));
        if (Buffer.byteLength(evidence.join("\n")) > MAX_TOOL_RESULT_BYTES) throw new Error("model_recovery_evidence_too_large");
        return evidence;
      },
      release: () => releasing ??= drain().then(() => {
        if (this.bindings.get(threadId) === binding) this.bindings.delete(threadId);
      }),
    };
  }

  async execute(
    tool: string,
    argumentsValue: unknown,
    context?: { threadId: string; turnId: string; namespace: string | null },
  ): Promise<DynamicToolResult> {
    const diagnostics = this.options.diagnostics;
    const binding = context ? this.bindings.get(context.threadId) : undefined;
    if (binding?.sealed) return protocolFailure("workflow_tool_turn_closed");
    let resolve!: (result: DynamicToolResult | PromiseLike<DynamicToolResult>) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<DynamicToolResult>((done, failed) => { resolve = done; reject = failed; });
    binding?.operations.add(operation);
    try { resolve(diagnostics
      ? diagnostics.run("tool.call", { toolId: `${context?.namespace}.${tool}` }, async () => {
        const result = await this.executeObserved(tool, argumentsValue, context);
        const errorCode = resultErrorCode(result) ?? binding?.receiptErrorCode;
        diagnostics.result({ status: !result.success || errorCode ? "rejected" : "succeeded", resultSuccess: result.success, domainSuccess: result.success && !errorCode, errorCode });
        return result;
      }, context ? this.bindings.get(context.threadId)?.diagnosticParent : undefined)
      : this.executeObserved(tool, argumentsValue, context));
    } catch (error) { reject(error); }
    try {
      return await operation;
    } finally {
      binding?.operations.delete(operation);
    }
  }

  private async executeObserved(tool: string, argumentsValue: unknown, context?: { threadId: string; turnId: string; namespace: string | null }): Promise<DynamicToolResult> {
    if (!context || context.namespace === null) return protocolFailure("workflow_tool_context_invalid");
    const binding = this.bindings.get(context.threadId);
    if (!binding) return protocolFailure("workflow_tool_context_invalid");
    if (binding.retiredTurns.has(context.turnId)) return protocolFailure("workflow_tool_turn_mismatch");
    if (binding.turnId !== undefined && binding.turnId !== context.turnId) {
      return protocolFailure("workflow_tool_turn_mismatch");
    }
    binding.turnId ??= context.turnId;
    if (binding.owner === "workflow") {
      return domainFailure("workflow_turn_already_claimed", false, "stop");
    }

    const toolId = `${context.namespace}.${tool}`;
    const member = this.catalog.members().find((candidate) => candidate.id === toolId);
    if (!member) return protocolFailure("workflow_tool_unavailable");
    const startedAt = this.now();
    const ownerBefore = publicOwner(binding.owner);
    if (!this.catalog.accepts(member.id, member.version, argumentsValue)) {
      return this.finishTrace(member, argumentsValue, binding, startedAt, 0, domainFailure(
        "workflow_tool_arguments_invalid",
        true,
        "correct_arguments",
        this.catalog.validationIssues(member.id, member.version, argumentsValue),
      ), ownerBefore);
    }
    if (binding.owner === "terminal_preflighting" && member.executionClass !== "inline_query") {
      return this.finishTrace(member, argumentsValue, binding, startedAt, 0,
        domainFailure("workflow_terminal_preflight_in_progress", true, "wait"), ownerBefore);
    }
    if (binding.acceptedCalls >= MAX_TOOL_CALLS_PER_TURN) {
      return this.finishTrace(member, argumentsValue, binding, startedAt, 0,
        domainFailure("workflow_tool_budget_exhausted", false, "stop"), ownerBefore);
    }
    binding.acceptedCalls += 1;
    if (binding.recovered && member.executionClass !== "inline_query" && binding.observations.some((entry) => entry.mutation)) {
      const previous = binding.observations.find((entry) => entry.mutation && entry.toolId === toolId && isDeepStrictEqual(entry.arguments, argumentsValue));
      if (!previous) binding.uncertainEffect = true;
      return previous ? structuredClone(previous.result) : domainFailure("model_recovery_effect_unconfirmed", false, "stop");
    }

    const request = {
      toolId: member.id,
      toolVersion: member.version,
      arguments: structuredClone(argumentsValue),
    };
    if (member.executionClass === "inline_query") {
      if (!this.inlineTools) {
        return this.finishTrace(member, argumentsValue, binding, startedAt, 0,
          protocolFailure("workflow_inline_tool_unavailable"), ownerBefore);
      }
      const result = await this.executeInline(request, binding);
      binding.observations.push({ toolId, arguments: structuredClone(argumentsValue), result: structuredClone(result), mutation: false });
      return this.finishTrace(member, argumentsValue, binding, startedAt, 0, result, ownerBefore);
    }
    if (member.executionClass === "inline_mutation") {
      if (!this.inlineTools) {
        return this.finishTrace(member, argumentsValue, binding, startedAt, 0,
          protocolFailure("workflow_inline_tool_unavailable"), ownerBefore);
      }
      const result = await this.executeMutation(request, binding, member, argumentsValue, startedAt, ownerBefore);
      binding.observations.push({ toolId, arguments: structuredClone(argumentsValue), result: structuredClone(result), mutation: true });
      if (!result.success || resultErrorCode(result)) binding.uncertainEffect = true;
      return result;
    }

    binding.owner = "terminal_preflighting";
    const waitStartedAt = this.now();
    let waitMs = 0;
    try {
      await Promise.all([...binding.activeMutations]);
      waitMs = Math.max(0, this.now() - waitStartedAt);
      const result = await this.gateway.submit(request, structuredClone(binding.trusted));
      if (result.disposition === "continue") {
        binding.owner = "model";
        return this.finishTrace(member, argumentsValue, binding, startedAt, waitMs,
          success(result.result), ownerBefore);
      }
      binding.owner = "workflow";
      binding.runRef = result.runRef;
      if (result.receipt) binding.receipt = { ...result.receipt, runRef: result.receipt.runRef ?? result.runRef };
      if (result.receiptErrorCode) binding.receiptErrorCode = result.receiptErrorCode;
      return this.finishTrace(member, argumentsValue, binding, startedAt, waitMs,
        success({ status: "workflow_claimed", finalReplyOwner: "workflow" }), ownerBefore);
    } catch (error) {
      binding.uncertainEffect = true;
      if (binding.owner !== "workflow") binding.owner = "model";
      const code = safeDomainError(error);
      return this.finishTrace(member, argumentsValue, binding, startedAt, waitMs,
        code ? failureForDomainCode(code) : protocolFailure("workflow_terminal_preflight_failed"), ownerBefore);
    }
  }

  private async executeInline(request: WorkflowToolRequest, binding: Binding): Promise<DynamicToolResult> {
    try {
      return success(await this.inlineTools!.execute(request, structuredClone(binding.trusted)));
    } catch (error) {
      const code = safeDomainError(error);
      return code ? failureForDomainCode(code) : protocolFailure("workflow_tool_internal_error");
    }
  }

  private executeMutation(
    request: WorkflowToolRequest,
    binding: Binding,
    member: ReturnType<WorkflowToolCatalog["members"]>[number],
    argumentsValue: unknown,
    startedAt: number,
    ownerBefore: "model" | "workflow",
  ): Promise<DynamicToolResult> {
    const resourceKey = mutationResourceKey(request);
    const previous = binding.mutationQueues.get(resourceKey) ?? Promise.resolve();
    const queuedAt = this.now();
    const execution = previous.catch(() => {}).then(async () => {
      const waitMs = Math.max(0, this.now() - queuedAt);
      const result = await this.executeInline(request, binding);
      return this.finishTrace(member, argumentsValue, binding, startedAt, waitMs, result, ownerBefore);
    });
    const tail = execution.then(() => {}, () => {});
    binding.mutationQueues.set(resourceKey, tail);
    binding.activeMutations.add(tail);
    void tail.finally(() => {
      binding.activeMutations.delete(tail);
      if (binding.mutationQueues.get(resourceKey) === tail) binding.mutationQueues.delete(resourceKey);
    });
    return execution;
  }

  private finishTrace(
    member: ReturnType<WorkflowToolCatalog["members"]>[number],
    argumentsValue: unknown,
    binding: Binding,
    startedAt: number,
    waitMs: number,
    result: DynamicToolResult,
    ownerBefore: "model" | "workflow",
  ): DynamicToolResult {
    try {
      const resultSummary = ["files.find", "files.grep"].includes(member.id) ? searchResultSummary(result) : undefined;
      const diagnosticEvent: WorkflowToolTraceEvent = {
        toolId: member.id,
        toolVersion: member.version,
        executionClass: member.executionClass,
        argumentSummary: summarizeArguments(argumentsValue, member.inputSchema, member.id),
        waitMs,
        durationMs: Math.max(0, this.now() - startedAt),
        resultBytes: result.contentItems.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0),
        resultSuccess: result.success,
        ...(resultSummary ? { resultSummary } : {}),
        ...((resultErrorCode(result) ?? binding.receiptErrorCode)
          ? { errorCode: (resultErrorCode(result) ?? binding.receiptErrorCode)! } : {}),
        ...(binding.runRef ? { runRef: binding.runRef } : {}),
        ownerBefore,
        ownerAfter: publicOwner(binding.owner),
      };
      this.options.diagnostics?.toolResult(diagnosticEvent);
      this.options.trace?.(diagnosticEvent);
    } catch {
      // Trace output is observational and cannot change tool execution.
    }
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function snapshotBinding(binding: Binding): WorkflowToolTurnSnapshot {
  if (binding.owner === "workflow" && binding.turnId) {
    return {
      owner: "workflow",
      turnId: binding.turnId,
      ...(binding.runRef ? { runRef: binding.runRef } : {}),
      ...(binding.receiptErrorCode ? { receiptErrorCode: binding.receiptErrorCode } : {}),
      ...(binding.receipt ? { receipt: { ...binding.receipt } } : {}),
    };
  }
  return { owner: "model", ...(binding.turnId ? { turnId: binding.turnId } : {}) };
}

function success(value: unknown): DynamicToolResult {
  let text: string;
  try {
    text = JSON.stringify({ ok: true, data: value, meta: {} });
  } catch {
    return protocolFailure("workflow_tool_result_encoding_failed");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    return domainFailure("workflow_tool_result_too_large", true, "narrow_request");
  }
  return { success: true, contentItems: [{ type: "inputText", text }] };
}

function domainFailure(
  code: string,
  retryable: boolean,
  action: string,
  fieldIssues: string[] = [],
): DynamicToolResult {
  return {
    success: true,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({
        ok: false,
        error: {
          code,
          retryable,
          action,
          ...(fieldIssues.length > 0 ? { fieldIssues } : {}),
        },
      }),
    }],
  };
}

function protocolFailure(code: string): DynamicToolResult {
  return {
    success: false,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ ok: false, error: { code, retryable: true, action: "retry_later" } }),
    }],
  };
}

function safeDomainError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  if (!/^(?:local_file|file_sandbox|workflow_file|workflow_media|workflow_module)_[a-z0-9_]+$/u.test(message)) {
    return null;
  }
  if (message === "local_file_query_queue_full" || message === "local_file_query_queue_timeout") return message;
  if (message === "local_file_search_timeout" || message === "local_file_search_incomplete") return message;
  return /(?:arguments|budget|quota|permission|reference|cursor|scope|content|path|file_(?:exists|missing|invalid|too_large)|result_too_large|regex|range|conflict|unsupported|source_unavailable|handle_unavailable)/u.test(message)
    ? message
    : null;
}

function failureForDomainCode(code: string): DynamicToolResult {
  if (code === "local_file_query_queue_full" || code === "local_file_query_queue_timeout") return domainFailure(code, true, "retry_later");
  if (code === "local_file_search_timeout" || code === "local_file_search_incomplete") return domainFailure(code, false, "change_request");
  if (code.includes("permission")) return domainFailure(code, false, "check_permissions");
  if (/(?:budget|quota|too_large)/u.test(code)) return domainFailure(code, true, "narrow_request");
  if (/(?:reference|cursor|handle|stale)/u.test(code)) return domainFailure(code, true, "refresh_reference");
  if (/(?:arguments|regex|range)/u.test(code)) return domainFailure(code, true, "correct_arguments");
  if (/(?:conflict|exists|missing)/u.test(code)) return domainFailure(code, true, "refresh_state");
  return domainFailure(code, false, "change_request");
}

function mutationResourceKey(request: WorkflowToolRequest): string {
  const argumentsRecord = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)
    ? request.arguments as Record<string, unknown>
    : {};
  if (request.toolId === "files.edit" && typeof argumentsRecord.fileRef === "string") {
    return `${request.toolId}:${argumentsRecord.fileRef}`;
  }
  if (request.toolId === "files.write" && typeof argumentsRecord.scopeRef === "string" &&
      typeof argumentsRecord.relativePath === "string") {
    return `${request.toolId}:${argumentsRecord.scopeRef}:${argumentsRecord.relativePath}`;
  }
  return request.toolId;
}

function publicOwner(owner: Binding["owner"]): "model" | "workflow" {
  return owner === "workflow" ? "workflow" : "model";
}

function summarizeArguments(
  value: unknown,
  inputSchema: Record<string, unknown>,
  toolId: string,
): WorkflowToolTraceEvent["argumentSummary"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { keys: [] };
  const properties = inputSchema.properties && typeof inputSchema.properties === "object" &&
    !Array.isArray(inputSchema.properties)
    ? inputSchema.properties as Record<string, unknown>
    : {};
  const allEntries = Object.entries(value as Record<string, unknown>);
  const entries = allEntries
    .filter(([key]) => Object.hasOwn(properties, key))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 32);
  const stringLengths = Object.fromEntries(entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, entry]) => [key, Array.from(entry).length]));
  const arrayLengths = Object.fromEntries(entries
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, entry]) => [key, entry.length]));
  const queryOptions = ["files.find", "files.grep"].includes(toolId)
    ? summarizeQueryOptions(Object.fromEntries(entries)) : {};
  const queryInputs = ["files.find", "files.grep"].includes(toolId)
    ? Object.fromEntries(allEntries) : undefined;
  return {
    keys: entries.map(([key]) => key),
    ...(allEntries.length > entries.length ? { unknownKeyCount: allEntries.length - entries.length } : {}),
    ...(Object.keys(stringLengths).length > 0 ? { stringLengths } : {}),
    ...(Object.keys(arrayLengths).length > 0 ? { arrayLengths } : {}),
    ...(queryInputs ? { queryInputs } : {}),
    ...(Object.keys(queryOptions).length > 0 ? { queryOptions } : {}),
  };
}

function summarizeQueryOptions(args: Record<string, unknown>): NonNullable<WorkflowToolTraceEvent["argumentSummary"]["queryOptions"]> {
  // Keep the existing indexable options; queryInputs separately retains the full query.
  const options: NonNullable<WorkflowToolTraceEvent["argumentSummary"]["queryOptions"]> = {};
  for (const [key, allowed] of Object.entries({
    kind: ["any", "file", "directory"], match: ["literal", "fuzzy"],
    mode: ["literal", "regex"], case: ["smart", "sensitive", "insensitive"],
  })) {
    const value = args[key];
    if (typeof value === "string" && allowed.includes(value)) options[key] = value;
  }
  for (const [key, minimum, maximum] of [["limit", 1, 100], ["contextLines", 0, 10]] as const) {
    const value = args[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum) options[key] = value;
  }
  if (args.sort && typeof args.sort === "object" && !Array.isArray(args.sort)) {
    const { field, direction } = args.sort as Record<string, unknown>;
    if (typeof field === "string" && ["relevance", "modified_at", "name", "path"].includes(field) &&
      typeof direction === "string" && ["asc", "desc"].includes(direction)) options.sort = { field, direction };
  }
  return options;
}

function resultErrorCode(result: DynamicToolResult): string | undefined {
  for (const item of result.contentItems) {
    try {
      const envelope = JSON.parse(item.text) as { error?: { code?: unknown } };
      if (typeof envelope.error?.code === "string") return envelope.error.code;
    } catch {
      // Non-envelope content is still accounted for by resultBytes.
    }
  }
  return undefined;
}

function searchResultSummary(result: DynamicToolResult): WorkflowToolTraceEvent["resultSummary"] {
  for (const item of result.contentItems) {
    try {
      const envelope = JSON.parse(item.text) as { ok?: boolean; data?: {
        scanComplete?: unknown; resultTruncated?: unknown; entries?: unknown; matches?: unknown; skipped?: unknown;
      } };
      const data = envelope?.data;
      if (envelope?.ok === true && typeof data?.scanComplete === "boolean" && typeof data.resultTruncated === "boolean") {
        const skippedByReason: Record<string, number> = Object.create(null);
        if (Array.isArray(data.skipped)) {
          for (const skipped of data.skipped) {
            const reason = skipped && typeof skipped === "object" ? skipped.reason : undefined;
            const key = typeof reason === "string" ? reason : "missing_reason";
            skippedByReason[key] = (skippedByReason[key] ?? 0) + 1;
          }
        }
        return {
          scanComplete: data.scanComplete, resultTruncated: data.resultTruncated,
          ...(Array.isArray(data.entries) ? { entryCount: data.entries.length } : {}),
          ...(Array.isArray(data.matches) ? { matchCount: data.matches.length } : {}),
          ...(Array.isArray(data.skipped) ? { skippedCount: data.skipped.length, skippedByReason } : {}),
        };
      }
    } catch { /* Only allowlisted scalar completeness metadata is diagnostic. */ }
  }
  return undefined;
}
