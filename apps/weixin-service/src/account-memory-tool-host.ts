import type { NotificationDestination, OwnerNotificationRoute } from "./notification-channel.js";
import crypto from "node:crypto";
import type { OwnedReminderIntent, ReminderIntentOwnership } from "./reminder-intent-ownership.js";

import type { DynamicToolDefinition, DynamicToolFunctionDefinition, DynamicToolHost, DynamicToolResult } from "./dynamic-tool-host.js";
import { resolvePlannedEventTarget } from "./account-event-resolver.js";
import { type MemoryCategory, type MemoryEventKind, type MemoryMutation, type MemoryCommitReceipt, AccountMemoryStore, normalizeMemoryValue } from "./account-memory-store.js";
import { resolveMemoryTarget, type MemorySearchCandidate } from "./account-memory-resolver.js";
import type { MemoryMutationPolicy } from "./account-memory-system.js";

export type ManagedTaskMemorySource = { id: string; name: string; revision: number; template: string };

export type AccountMemoryToolBinding = {
  managedTasks?: ManagedTaskMemorySource[];
  candidateEntryIds?: string[];
  accountId: string;
  jobId: string;
  batchId: string;
  evidenceEntryIds: string[];
  evidenceTexts?: Record<string, string>;
  evidenceOrigins?: Record<string, { eventKey: string; target: string; senderAccountId?: string }>;
  evidenceLocalDates?: Record<string, string>;
  reminderContext?: { batchId: string; plans: Array<{ ordinal: number; planId: string; summary: string }> };
  mutationPolicy: MemoryMutationPolicy;
};

const evidenceSchema = { type: "array", items: { type: "string" }, minItems: 1 };
const nullableLocalTimeSchema = {
  anyOf: [
    { type: "string", pattern: "^[0-9]{2}:[0-9]{2}$" },
    { type: "null" },
  ],
};
const nullableStringSchema = { anyOf: [{ type: "string" }, { type: "null" }] };
const definitions: DynamicToolFunctionDefinition[] = [
  {
    type: "function",
    name: "account_memory_commit",
    description: "Commit semantic memory decisions. Account scope, entry identity, and operation policy are injected by the host.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["basedOnRevision", "batchId", "decisions"],
      properties: {
        basedOnRevision: { type: "integer", minimum: 0 },
        batchId: { type: "string", minLength: 1, maxLength: 128 },
        decisions: {
          type: "array", maxItems: 50,
          items: { anyOf: [
            {
              type: "object", additionalProperties: false,
              required: ["kind", "taskId", "match", "retainedValue", "evidenceEntryIds"],
              properties: {
                kind: { type: "string", const: "task_settings" }, taskId: { type: "string" },
                match: nullableStringSchema, retainedValue: nullableStringSchema, evidenceEntryIds: evidenceSchema,
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "category", "value", "evidenceEntryIds", "confidence"],
              properties: {
                kind: { type: "string", const: "remember" },
                category: { type: "string", enum: ["preferences", "projects", "decisions", "constraints"] },
                value: { type: "string" }, evidenceEntryIds: evidenceSchema, confidence: { type: "number" },
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "match", "value", "evidenceEntryIds", "confidence"],
              properties: {
                kind: { type: "string", const: "revise" }, match: { type: "string" }, value: { type: "string" },
                evidenceEntryIds: evidenceSchema, confidence: { type: "number" },
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "evidenceEntryIds"],
              properties: { kind: { type: "string", const: "forget" }, evidenceEntryIds: evidenceSchema },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "eventKind", "localDate", "timePrecision", "localTime", "summary", "sourceText", "planMatch", "evidenceEntryIds", "confidence"],
              properties: {
                kind: { type: "string", const: "record_event" }, eventKind: { type: "string", enum: ["planned", "observed"] },
                localDate: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                timePrecision: { type: "string", enum: ["date", "morning", "afternoon", "evening", "exact"] },
                localTime: nullableLocalTimeSchema,
                summary: { type: "string" }, sourceText: nullableStringSchema, planMatch: nullableStringSchema, evidenceEntryIds: evidenceSchema, confidence: { type: "number" },
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "match", "eventKind", "localDate", "timePrecision", "localTime", "summary", "evidenceEntryIds", "confidence"],
              properties: {
                kind: { type: "string", const: "revise_event" }, match: { type: "string" },
                eventKind: { type: "string", const: "planned" },
                localDate: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                timePrecision: { type: "string", enum: ["date", "morning", "afternoon", "evening", "exact"] },
                localTime: nullableLocalTimeSchema,
                summary: { type: "string" }, evidenceEntryIds: evidenceSchema, confidence: { type: "number" },
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "match", "status", "evidenceEntryIds"],
              properties: {
                kind: { type: "string", const: "set_plan_outcome" }, match: { type: "string" },
                status: { type: "string", enum: ["cancelled", "unfulfilled"] }, evidenceEntryIds: evidenceSchema,
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["kind", "match", "outcome", "summary", "evidenceEntryIds", "confidence"],
              properties: {
                kind: { type: "string", const: "resolve_reminder" },
                match: nullableStringSchema,
                outcome: { type: "string", enum: ["occurred", "cancelled", "unfulfilled"] },
                summary: nullableStringSchema, evidenceEntryIds: evidenceSchema, confidence: { type: "number" },
              },
            },
          ] },
        },
      },
    },
  },
];

export type AccountMemoryCommitOutcome =
  | { status: "committed"; receipt: MemoryCommitReceipt }
  | { status: "needs_clarification"; reason: "target_missing" | "target_ambiguous" | "outcome_ambiguous"; candidateIds: string[] };

export function accountMemoryDecisionOutputSchema(): Record<string, unknown> {
  return structuredClone(definitions[0]!.inputSchema);
}

export class AccountMemoryToolHost implements DynamicToolHost {
  private readonly bindings = new Map<string, AccountMemoryToolBinding>();
  private readonly receipts = new Map<string, MemoryCommitReceipt>();
  private readonly clarifications = new Map<string, { reason: "target_missing" | "target_ambiguous" | "outcome_ambiguous"; candidateIds: string[] }>();

  constructor(
    private readonly store: AccountMemoryStore,
    private readonly search?: { search(accountId: string, query: string): Promise<MemorySearchCandidate[]> },
    private readonly reminderOwnership?: ReminderIntentOwnership,
    private readonly notificationRoute?: OwnerNotificationRoute,
  ) {}

  definitions(): DynamicToolDefinition[] { return structuredClone(definitions); }

  bind(threadId: string, binding: AccountMemoryToolBinding): void {
    this.bindings.set(threadId, {
      ...binding,
      evidenceEntryIds: [...binding.evidenceEntryIds],
      ...(binding.managedTasks ? { managedTasks: structuredClone(binding.managedTasks) } : {}),
      ...(binding.candidateEntryIds ? { candidateEntryIds: [...binding.candidateEntryIds] } : {}),
      mutationPolicy: structuredClone(binding.mutationPolicy),
      ...(binding.evidenceOrigins ? { evidenceOrigins: structuredClone(binding.evidenceOrigins) } : {}),
      ...(binding.evidenceTexts ? { evidenceTexts: { ...binding.evidenceTexts } } : {}),
      ...(binding.evidenceLocalDates ? { evidenceLocalDates: { ...binding.evidenceLocalDates } } : {}),
      ...(binding.reminderContext ? { reminderContext: structuredClone(binding.reminderContext) } : {}),
    });
  }

  release(threadId: string): void { this.bindings.delete(threadId); this.receipts.delete(threadId); this.clarifications.delete(threadId); }
  receipt(threadId: string): MemoryCommitReceipt | undefined {
    const receipt = this.receipts.get(threadId);
    return receipt ? { ...receipt } : undefined;
  }
  clarification(threadId: string): { reason: "target_missing" | "target_ambiguous" | "outcome_ambiguous"; candidateIds: string[] } | undefined {
    const clarification = this.clarifications.get(threadId);
    return clarification ? { ...clarification, candidateIds: [...clarification.candidateIds] } : undefined;
  }

  async commit(binding: AccountMemoryToolBinding, argumentsValue: unknown): Promise<AccountMemoryCommitOutcome> {
    const trustedBinding: AccountMemoryToolBinding = {
      ...binding,
      evidenceEntryIds: [...binding.evidenceEntryIds],
      ...(binding.managedTasks ? { managedTasks: structuredClone(binding.managedTasks) } : {}),
      ...(binding.candidateEntryIds ? { candidateEntryIds: [...binding.candidateEntryIds] } : {}),
      mutationPolicy: structuredClone(binding.mutationPolicy),
      ...(binding.evidenceOrigins ? { evidenceOrigins: structuredClone(binding.evidenceOrigins) } : {}),
      ...(binding.evidenceTexts ? { evidenceTexts: { ...binding.evidenceTexts } } : {}),
      ...(binding.evidenceLocalDates ? { evidenceLocalDates: { ...binding.evidenceLocalDates } } : {}),
      ...(binding.reminderContext ? { reminderContext: structuredClone(binding.reminderContext) } : {}),
    };
    const input = asRecord(argumentsValue);
    if (!input || input.batchId !== trustedBinding.batchId || !Number.isInteger(input.basedOnRevision) || !Array.isArray(input.decisions)) {
      throw new Error("memory_arguments_invalid");
    }
    try {
      const replay = this.store.receipt(trustedBinding.accountId, trustedBinding.batchId);
      if (replay) return { status: "committed", receipt: replay };
      const eventQuery = input.decisions
        .map((item) => asRecord(item))
        .filter((item) => ["revise_event", "set_plan_outcome"].includes(String(item?.kind)) && typeof item?.match === "string")
        .map((item) => String(item!.match))
        .concat(trustedBinding.reminderContext?.plans.map((plan) => plan.summary) ?? [])
        .join(" ");
      const snapshot = this.store.read(trustedBinding.accountId, eventQuery);
      const reminderIntents: OwnedReminderIntent[] = [];
      const mutations = await decisionsToMutations(
        input.decisions,
        trustedBinding,
        snapshot.entries,
        snapshot.events,
        this.search,
        this.reminderOwnership ? reminderIntents : undefined,
      );
      assertNoConflictingPlanMutations(mutations);
      const planDestinations: Record<string, NotificationDestination> = {};
      if (this.notificationRoute?.capturesCreationDestination) {
        for (const mutation of mutations) {
          if (mutation.op !== "event_add" || mutation.eventKind !== "planned") continue;
          const targets = [...new Set(mutation.evidenceEntryIds.map((id) => trustedBinding.evidenceOrigins?.[id]?.target))];
          const senders = [...new Set(mutation.evidenceEntryIds.map((id) => trustedBinding.evidenceOrigins?.[id]?.senderAccountId))];
          if (targets.length !== 1) throw new Error("memory_plan_origin_ambiguous");
          if (senders.length !== 1) throw new Error("memory_plan_origin_ambiguous");
          const destination = targets[0] === undefined
            ? this.notificationRoute.legacyMemoryDestination(trustedBinding.accountId)
            : this.notificationRoute.captureMemory(trustedBinding.accountId, targets[0], senders[0]);
          if (!destination) throw new Error("memory_plan_origin_unbound");
          planDestinations[mutation.id] = destination;
        }
      }
      const receipt = this.store.apply(trustedBinding.accountId, {
        batchId: trustedBinding.batchId,
        basedOnRevision: input.basedOnRevision as number,
        evidenceEntryIds: new Set(trustedBinding.evidenceEntryIds),
        mutations, planDestinations,
      }, reminderIntents.length ? this.reminderOwnership?.memoryAdmission(reminderIntents) : undefined);
      return { status: "committed", receipt };
    } catch (error) {
      if (error instanceof MemoryReconcileClarification) {
        return {
          status: "needs_clarification",
          reason: error.reason,
          candidateIds: [...error.candidateIds],
        };
      }
      throw error;
    }
  }

  async execute(tool: string, argumentsValue: unknown, context?: { threadId: string; turnId: string }): Promise<DynamicToolResult> {
    const binding = context ? this.bindings.get(context.threadId) : undefined;
    if (!binding || !context) return failure("memory_binding_missing");
    if (tool !== "account_memory_commit") return failure("memory_tool_unknown");
    if (this.receipts.has(context.threadId) || this.clarifications.has(context.threadId)) return failure("already_committed");
    try {
      const outcome = await this.commit(binding, argumentsValue);
      if (outcome.status === "needs_clarification") {
        const clarification = { reason: outcome.reason, candidateIds: [...outcome.candidateIds] };
        this.clarifications.set(context.threadId, clarification);
        return success({ status: "needs_clarification", ...clarification });
      }
      this.receipts.set(context.threadId, outcome.receipt);
      return success(outcome.receipt);
    } catch (error) {
      return failure(error instanceof Error ? error.message : "memory_commit_failed");
    }
  }
}

async function decisionsToMutations(
  value: unknown[],
  binding: AccountMemoryToolBinding,
  entries: ReturnType<AccountMemoryStore["read"]>["entries"],
  events: ReturnType<AccountMemoryStore["read"]>["events"],
  search?: { search(accountId: string, query: string): Promise<MemorySearchCandidate[]> },
  reminderIntents?: OwnedReminderIntent[],
): Promise<MemoryMutation[]> {
  if (value.length > 50) throw new Error("memory_arguments_invalid");
  if (value.length === 0) return [];
  if (!["free_add", "reconcile"].includes(binding.mutationPolicy.mode) && value.length !== 1) throw new Error("memory_policy_violation");
  const seenValues = new Set(entries.map((entry) => normalizeMemoryValue(entry.value)));
  const decisions = value.filter((item) => {
    if (binding.mutationPolicy.mode !== "reconcile") return true;
    const decision = asRecord(item);
    if (decision?.kind !== "remember" || typeof decision.value !== "string") return true;
    const normalized = normalizeMemoryValue(decision.value);
    if (seenValues.has(normalized)) return false;
    seenValues.add(normalized);
    return true;
  });
  const rankedByMatch = new Map<string, MemorySearchCandidate[]>();
  if (binding.mutationPolicy.mode === "reconcile" && search) {
    for (const item of decisions) {
      const decision = asRecord(item);
      if (decision?.kind !== "revise" || typeof decision.match !== "string") continue;
      const local = resolveMemoryTarget(decision.match, entries, []);
      if (local.status === "needs_clarification" && local.reason === "target_missing") {
        const ranked = await withTimeout(search.search(binding.accountId, decision.match), 15_000).catch(() => []);
        rankedByMatch.set(decision.match, ranked);
      }
    }
  }
  return decisions.flatMap((item, decisionIndex): MemoryMutation | MemoryMutation[] => {
    const decision = asRecord(item);
    if (!decision || typeof decision.kind !== "string") throw new Error("memory_arguments_invalid");
    const evidenceEntryIds = stringArray(decision.evidenceEntryIds);
    if (evidenceEntryIds.some((id) => !binding.evidenceEntryIds.includes(id))) throw new Error("memory_evidence_invalid");
    if (decision.kind === "task_settings") {
      if (binding.mutationPolicy.mode === "single_remove") throw new Error("memory_policy_violation");
      const task = binding.managedTasks?.find((item) => item.id === decision.taskId);
      if (!task) throw new Error("memory_task_authority_invalid");
      if (decision.match === null && decision.retainedValue === null) {
        if (binding.mutationPolicy.mode === "single_update") throw new Error("memory_policy_violation");
        return [];
      }
      if (typeof decision.match !== "string" || !decision.match.trim()
        || (decision.retainedValue !== null && typeof decision.retainedValue !== "string")) throw new Error("memory_arguments_invalid");
      const candidates = entries.filter((entry) => binding.candidateEntryIds?.includes(entry.id));
      const matches = candidates.filter((entry) => entry.value === decision.match);
      if (matches.length !== 1) throw new MemoryReconcileClarification(matches.length ? "target_ambiguous" : "target_missing", matches.map((entry) => entry.id));
      if (binding.mutationPolicy.mode === "single_update") {
        if (matches[0]!.id !== binding.mutationPolicy.targetId) throw new Error("memory_policy_violation");
        if (!evidenceEntryIds.includes(binding.mutationPolicy.evidenceEntryId)) throw new Error("memory_policy_evidence_invalid");
      }
      return { op: "supersede_task", id: matches[0]!.id, taskId: task.id, taskRevision: task.revision,
        retainedValue: decision.retainedValue as string | null, evidenceEntryIds };
    }
    if (decision.kind === "record_event") {
      if (!["free_add", "reconcile"].includes(binding.mutationPolicy.mode)) throw new Error("memory_policy_violation");
      if (!(["planned", "observed"] as const).includes(decision.eventKind as MemoryEventKind)
        || typeof decision.localDate !== "string"
        || typeof decision.summary !== "string"
        || typeof decision.confidence !== "number") throw new Error("memory_arguments_invalid");
      if (decision.eventKind === "observed" && typeof decision.planMatch === "string" && binding.reminderContext) {
        validateReminderCompletionEvidence(evidenceEntryIds, decision.localDate, binding);
      } else {
        validateEventEvidence(evidenceEntryIds, decision.localDate, binding);
      }
      const addition: MemoryMutation = {
        op: "event_add", id: generatedEventId(binding.batchId, decisionIndex, decision.eventKind as MemoryEventKind),
        eventKind: decision.eventKind as MemoryEventKind, localDate: decision.localDate,
        timezone: "Asia/Shanghai", summary: decision.summary,
        ...(decision.eventKind === "planned" ? normalizedPlanTime(decision) : {}),
        evidenceEntryIds, confidence: decision.confidence,
      };
      if (decision.eventKind === "planned" && reminderIntents && binding.evidenceOrigins) {
        if (evidenceEntryIds.length !== 1 || typeof decision.sourceText !== "string") throw new Error("memory_arguments_invalid");
        const source = binding.evidenceOrigins[evidenceEntryIds[0]!];
        const originalText = binding.evidenceTexts?.[evidenceEntryIds[0]!];
        if (!source || !originalText) throw new Error("memory_arguments_invalid");
        reminderIntents.push({ accountId: binding.accountId, ...source,
          originalText, sourceText: decision.sourceText, owner: addition.id });
      }
      if (decision.planMatch === undefined || decision.planMatch === null) return addition;
      if (decision.eventKind !== "observed" || typeof decision.planMatch !== "string" || decision.planMatch.trim().length === 0) throw new Error("memory_event_plan_invalid");
      const resolution = resolvePlanMatch(decision.planMatch, events, binding.reminderContext);
      if (resolution.status === "needs_clarification") {
        throw new MemoryReconcileClarification(resolution.reason, resolution.candidateIds);
      }
      return [
        { ...addition, fulfillsPlanId: resolution.targetId },
        { op: "event_complete", id: resolution.targetId, observedEventId: addition.id, evidenceEntryIds },
      ];
    }
    if (decision.kind === "resolve_reminder") {
      if (binding.mutationPolicy.mode !== "reconcile" || !binding.reminderContext
        || !["occurred", "cancelled", "unfulfilled"].includes(String(decision.outcome))
        || typeof decision.confidence !== "number") throw new Error("memory_policy_violation");
      if (decision.match !== undefined && decision.match !== null && typeof decision.match !== "string") {
        throw new Error("memory_arguments_invalid");
      }
      const resolution = resolveReminderReplyTarget(evidenceEntryIds, events, binding, decision.match as string | null | undefined);
      if (resolution.status === "needs_clarification") throw new MemoryReconcileClarification(resolution.reason, resolution.candidateIds);
      validateReminderOutcomeEvidence(evidenceEntryIds, String(decision.outcome), binding);
      if (decision.outcome !== "occurred") {
        if (decision.summary !== null) throw new Error("memory_arguments_invalid");
        return { op: "event_set_status", id: resolution.targetId, status: decision.outcome as "cancelled" | "unfulfilled", evidenceEntryIds };
      }
      if (typeof decision.summary !== "string" || decision.summary.trim().length === 0) throw new Error("memory_arguments_invalid");
      const localDate = reminderReplyLocalDate(evidenceEntryIds, binding, decision.summary);
      const addition: MemoryMutation = {
        op: "event_add", id: generatedEventId(binding.batchId, decisionIndex, "observed"),
        eventKind: "observed", localDate, timezone: "Asia/Shanghai", summary: decision.summary,
        fulfillsPlanId: resolution.targetId, evidenceEntryIds, confidence: decision.confidence,
      };
      return [
        addition,
        { op: "event_complete", id: resolution.targetId, observedEventId: addition.id, evidenceEntryIds },
      ];
    }
    if (decision.kind === "revise_event") {
      if (binding.mutationPolicy.mode !== "reconcile"
        || decision.eventKind !== "planned"
        || typeof decision.match !== "string"
        || typeof decision.localDate !== "string"
        || typeof decision.summary !== "string"
        || typeof decision.confidence !== "number") throw new Error("memory_policy_violation");
      const resolution = resolvePlanMatch(decision.match, events, binding.reminderContext, true);
      if (resolution.status === "needs_clarification") {
        throw new MemoryReconcileClarification(resolution.reason, resolution.candidateIds);
      }
      const existing = events.find((event) => event.id === resolution.targetId)!;
      validateEventRevisionEvidence(evidenceEntryIds, decision.localDate, existing.localDate, binding);
      return {
        op: "event_update", id: resolution.targetId, localDate: decision.localDate,
        timezone: "Asia/Shanghai", summary: decision.summary,
        ...normalizedPlanTime(decision),
        evidenceEntryIds, confidence: decision.confidence,
      };
    }
    if (decision.kind === "set_plan_outcome") {
      if (binding.mutationPolicy.mode !== "reconcile" || typeof decision.match !== "string"
        || !["cancelled", "unfulfilled"].includes(String(decision.status))) throw new Error("memory_policy_violation");
      validatePlanOutcomeEvidence(evidenceEntryIds, String(decision.status), binding);
      const resolution = resolvePlanMatch(decision.match, events, binding.reminderContext, true);
      if (resolution.status === "needs_clarification") throw new MemoryReconcileClarification(resolution.reason, resolution.candidateIds);
      return { op: "event_set_status", id: resolution.targetId, status: decision.status as "cancelled" | "unfulfilled", evidenceEntryIds };
    }
    if (binding.mutationPolicy.mode === "free_add") {
      if (decision.kind !== "remember") throw new Error("memory_policy_violation");
      const categories = ["preferences", "projects", "decisions", "constraints"] as const;
      if (!categories.includes(decision.category as MemoryCategory) || typeof decision.value !== "string" || typeof decision.confidence !== "number") throw new Error("memory_arguments_invalid");
      return {
        op: "add", id: generatedId(decision.category as MemoryCategory, decision.value),
        category: decision.category as MemoryCategory, value: decision.value,
        evidenceEntryIds, confidence: decision.confidence,
      };
    }
    if (binding.mutationPolicy.mode === "reconcile") {
      if (decision.kind === "remember") {
        const categories = ["preferences", "projects", "decisions", "constraints"] as const;
        if (!categories.includes(decision.category as MemoryCategory) || typeof decision.value !== "string" || typeof decision.confidence !== "number") throw new Error("memory_arguments_invalid");
        return {
          op: "add", id: generatedId(decision.category as MemoryCategory, decision.value),
          category: decision.category as MemoryCategory, value: decision.value,
          evidenceEntryIds, confidence: decision.confidence,
        };
      }
      if (decision.kind !== "revise" || typeof decision.match !== "string" || typeof decision.value !== "string" || typeof decision.confidence !== "number") throw new Error("memory_policy_violation");
      const resolution = resolveMemoryTarget(decision.match, entries, rankedByMatch.get(decision.match) ?? []);
      if (resolution.status === "needs_clarification") {
        throw new MemoryReconcileClarification(resolution.reason, resolution.candidateIds);
      }
      return {
        op: "update", id: resolution.targetId, value: decision.value,
        evidenceEntryIds, confidence: decision.confidence,
      };
    }
    const policy = binding.mutationPolicy;
    if (!evidenceEntryIds.includes(policy.evidenceEntryId)) throw new Error("memory_policy_evidence_invalid");
    if (policy.mode === "single_update") {
      if (decision.kind !== "revise" || typeof decision.confidence !== "number") throw new Error("memory_policy_violation");
      return { op: "update", id: policy.targetId, value: policy.replacement, evidenceEntryIds, confidence: decision.confidence };
    }
    if (decision.kind !== "forget") throw new Error("memory_policy_violation");
    validateForgetEvidence(evidenceEntryIds, binding);
    return { op: "remove", id: policy.targetId, evidenceEntryIds, reason: "user_forget_request" };
  });
}

class MemoryReconcileClarification extends Error {
  constructor(
    readonly reason: "target_missing" | "target_ambiguous" | "outcome_ambiguous",
    readonly candidateIds: string[],
  ) {
    super(`memory_reconcile_${reason}`);
  }
}

function generatedId(category: MemoryCategory, value: unknown): string {
  if (typeof value !== "string") throw new Error("memory_arguments_invalid");
  return `memory-${category}-${crypto.createHash("sha256").update(value.normalize("NFKC").toLocaleLowerCase("zh-CN")).digest("hex").slice(0, 12)}`;
}

function generatedEventId(batchId: string, decisionIndex: number, eventKind: MemoryEventKind): string {
  const fingerprint = `${batchId}\n${decisionIndex}\n${eventKind}`;
  return `event-${eventKind}-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 12)}`;
}

function validateEventEvidence(ids: string[], localDate: string, binding: AccountMemoryToolBinding): void {
  const expectedDates = ids.flatMap((id) => {
    const text = binding.evidenceTexts?.[id];
    const trustedDate = binding.evidenceLocalDates?.[id];
    if (!text || !trustedDate) return [];
    const expected = eventDateFromEvidence(text, trustedDate);
    return expected ? [expected] : [];
  });
  if (expectedDates.length === 0) throw new Error("memory_event_evidence_invalid");
  if (expectedDates.length > 0 && expectedDates.some((expected) => expected !== localDate)) {
    throw new Error("memory_event_date_mismatch");
  }
}

function validateEventRevisionEvidence(ids: string[], localDate: string, existingDate: string, binding: AccountMemoryToolBinding): void {
  const hasExplicitDate = ids.some((id) => {
    const text = binding.evidenceTexts?.[id];
    const trustedDate = binding.evidenceLocalDates?.[id];
    return Boolean(text && trustedDate && eventDateFromEvidence(text, trustedDate));
  });
  if (hasExplicitDate) {
    validateEventEvidence(ids, localDate, binding);
    return;
  }
  if (localDate !== existingDate) throw new Error("memory_event_date_mismatch");
}

function validateReminderCompletionEvidence(ids: string[], localDate: string, binding: AccountMemoryToolBinding): void {
  const evidence = ids.map((id) => binding.evidenceTexts?.[id] ?? "").join("\n");
  if (!/(?:已完成|完成了|做完了|已经做了|已经去了|已经看了|已经吃了)/u.test(evidence)) {
    throw new Error("memory_event_evidence_invalid");
  }
  const trustedDates = ids.map((id) => binding.evidenceLocalDates?.[id]).filter((date): date is string => Boolean(date));
  if (trustedDates.length === 0 || trustedDates.some((date) => date !== localDate)) throw new Error("memory_event_date_mismatch");
}

function resolveReminderReplyTarget(
  ids: string[],
  events: ReturnType<AccountMemoryStore["read"]>["events"],
  binding: AccountMemoryToolBinding,
  match?: string | null,
) {
  const plans = binding.reminderContext?.plans ?? [];
  if (typeof match === "string") {
    if (match.trim().length === 0) {
      return { status: "needs_clarification" as const, reason: "target_missing" as const, candidateIds: [] };
    }
    const scopedEvents = plans.flatMap((plan) => {
      const event = events.find((candidate) => candidate.id === plan.planId && candidate.planStatus === "pending");
      return event ? [event] : [];
    });
    return resolvePlannedEventTarget(match, scopedEvents);
  }
  if (plans.length === 1) {
    const event = events.find((candidate) => candidate.id === plans[0]!.planId && candidate.planStatus === "pending");
    return event
      ? { status: "resolved" as const, targetId: event.id }
      : { status: "needs_clarification" as const, reason: "target_missing" as const, candidateIds: [] };
  }
  const evidence = ids.map((id) => binding.evidenceTexts?.[id] ?? "").join("\n");
  const ordinal = /^\s*(?:第\s*)?(\d+)(?:\s*[项个条])?(?:[，,、.。\s]|$)/u.exec(evidence)?.[1];
  if (ordinal) return resolvePlanMatch(ordinal, events, binding.reminderContext);
  const scopedEvents = plans.flatMap((plan) => {
    const event = events.find((candidate) => candidate.id === plan.planId && candidate.planStatus === "pending");
    return event ? [event] : [];
  });
  const direct = resolvePlannedEventTarget(evidence, scopedEvents);
  if (direct.status === "resolved") return direct;
  const anchors = reminderReplyAnchors(evidence);
  const ranked = scopedEvents
    .map((event) => ({ event, overlap: reminderReplyAnchors(event.summary).filter((anchor) => anchors.includes(anchor)).length }))
    .sort((left, right) => right.overlap - left.overlap || left.event.id.localeCompare(right.event.id));
  if (ranked[0] && ranked[0].overlap >= 2 && (!ranked[1] || ranked[0].overlap > ranked[1].overlap)) {
    return { status: "resolved" as const, targetId: ranked[0].event.id };
  }
  return {
    status: "needs_clarification" as const,
    reason: plans.length === 0 ? "target_missing" as const : "target_ambiguous" as const,
    candidateIds: ranked.filter((candidate) => candidate.overlap > 0).map((candidate) => candidate.event.id),
  };
}

function assertNoConflictingPlanMutations(mutations: MemoryMutation[]): void {
  const targets = new Set<string>();
  for (const mutation of mutations) {
    if (!["event_update", "event_complete", "event_set_status"].includes(mutation.op)) continue;
    if (targets.has(mutation.id)) throw new Error("memory_event_conflicting_mutations");
    targets.add(mutation.id);
  }
}

function reminderReplyAnchors(value: string): string[] {
  const normalized = normalizeMemoryValue(value)
    .replace(/(?:已经|刚刚|刚才|完成|做完|办完|搞定|还没|尚未|没有|没能|未能|取消|算了|准备|打算|计划)/gu, "")
    .replace(/[我了的得地是在要去做今明昨晚早上下中午点时分第项个条，,、.。！？!?\s]/gu, "");
  return [...new Set(Array.from(normalized).filter((character) => /[\p{L}\p{N}]/u.test(character)))];
}

function validateReminderOutcomeEvidence(ids: string[], outcome: string, binding: AccountMemoryToolBinding): void {
  const evidence = ids.map((id) => binding.evidenceTexts?.[id] ?? "").join("\n").trim();
  const cancelled = /(?:取消(?:了)?|算了|不(?!是).{0,30}了)/u.test(evidence);
  const unfulfilled = /(?:还没|尚未|没有|没能|未能|未完成)/u.test(evidence);
  const futureOrChange = /(?:准备|打算|计划|改到|改成|改为|延期|推迟)/u.test(evidence);
  const occurred = /(?:(?:已经|已|刚刚?|刚才).{0,80}(?:了|完|好)|(?:完成|做完|办完|搞定).{0,4}|.{1,60}(?:完|好)?了)/u.test(evidence);
  const matches = outcome === "cancelled" ? cancelled
    : outcome === "unfulfilled" ? unfulfilled && !cancelled
      : occurred && !cancelled && !unfulfilled && !futureOrChange;
  if (!matches) throw new MemoryReconcileClarification("outcome_ambiguous", []);
}

function reminderReplyLocalDate(ids: string[], binding: AccountMemoryToolBinding, summary: string): string {
  const hasSeveralPlans = (binding.reminderContext?.plans.length ?? 0) > 1;
  const dates = ids.flatMap((id) => {
    const trustedDate = binding.evidenceLocalDates?.[id];
    if (!trustedDate) return [];
    const evidence = binding.evidenceTexts?.[id] ?? "";
    if (!hasSeveralPlans) return [eventDateFromEvidence(evidence, trustedDate) ?? trustedDate];
    const summaryDate = eventDateFromEvidence(summary, trustedDate);
    if (!summaryDate) return [trustedDate];
    if (eventDateFromEvidence(evidence, trustedDate) !== summaryDate) throw new Error("memory_event_date_mismatch");
    return [summaryDate];
  });
  if (dates.length === 0 || dates.some((date) => date !== dates[0])) throw new Error("memory_event_date_mismatch");
  return dates[0]!;
}

function eventDateFromEvidence(text: string, trustedDate: string): string | undefined {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/u)?.[1];
  if (iso) return iso;
  const monthDay = text.match(/(\d{1,2})月(\d{1,2})日/u);
  if (monthDay) return `${trustedDate.slice(0, 4)}-${monthDay[1]!.padStart(2, "0")}-${monthDay[2]!.padStart(2, "0")}`;
  const weekday = text.match(/(下周|本周|这周)?(?:星期|周)([一二三四五六日天])/u);
  if (weekday) {
    const targetDay = "一二三四五六日天".indexOf(weekday[2]!) + 1;
    const normalizedTargetDay = targetDay === 8 ? 7 : targetDay;
    const currentDay = ((new Date(`${trustedDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const delta = weekday[1] === "下周"
      ? 7 - currentDay + normalizedTargetDay
      : weekday[1]
        ? normalizedTargetDay - currentDay
        : (normalizedTargetDay - currentDay + 7) % 7;
    return shiftLocalDate(trustedDate, delta);
  }
  if (/(?:后天|后晚)/u.test(text)) return shiftLocalDate(trustedDate, 2);
  if (/(?:明天|明早|明晨|明晚)/u.test(text)) return shiftLocalDate(trustedDate, 1);
  if (/(?:前天|前晚)/u.test(text)) return shiftLocalDate(trustedDate, -2);
  if (/(?:昨天|昨早|昨晨|昨晚)/u.test(text)) return shiftLocalDate(trustedDate, -1);
  if (/(?:今天|今早|今晨|今午|今晚)/u.test(text)) return trustedDate;
  return undefined;
}

function shiftLocalDate(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validateForgetEvidence(ids: string[], binding: AccountMemoryToolBinding): void {
  const evidence = ids.map((id) => binding.evidenceTexts?.[id] ?? "").join("\n");
  if (!/(?:请?忘记|不要再记|删除.{0,12}记忆)/u.test(evidence)) throw new Error("memory_remove_evidence_invalid");
}

function resolvePlanMatch(
  match: unknown,
  events: ReturnType<AccountMemoryStore["read"]>["events"],
  context?: AccountMemoryToolBinding["reminderContext"],
  includeResolved = false,
) {
  if (typeof match !== "string") throw new Error("memory_arguments_invalid");
  const ordinal = /^\s*(\d+)\s*$/u.exec(match)?.[1];
  if (ordinal && context) {
    const bound = context.plans.find((plan) => plan.ordinal === Number(ordinal));
    const event = bound ? events.find((candidate) => candidate.id === bound.planId && candidate.planStatus === "pending") : undefined;
    return event
      ? { status: "resolved" as const, targetId: event.id }
      : { status: "needs_clarification" as const, reason: "target_missing" as const, candidateIds: [] };
  }
  return resolvePlannedEventTarget(match, events, includeResolved ? ["pending", "occurred", "cancelled", "unfulfilled"] : ["pending"]);
}

function normalizedPlanTime(decision: Record<string, unknown>): { timePrecision: "date" | "morning" | "afternoon" | "evening" | "exact"; localTime?: string } {
  const precision = ["date", "morning", "afternoon", "evening", "exact"].includes(String(decision.timePrecision))
    ? String(decision.timePrecision) as "date" | "morning" | "afternoon" | "evening" | "exact"
    : "date";
  if (precision !== "exact") return { timePrecision: precision };
  if (typeof decision.localTime !== "string" || !/^\d{2}:\d{2}$/u.test(decision.localTime)) throw new Error("memory_event_invalid");
  return { timePrecision: precision, localTime: decision.localTime };
}

function validatePlanOutcomeEvidence(ids: string[], status: string, binding: AccountMemoryToolBinding): void {
  const evidence = ids.map((id) => binding.evidenceTexts?.[id] ?? "").join("\n");
  const valid = status === "cancelled"
    ? /(?:取消|不去了|不做了|不用了)/u.test(evidence)
    : /(?:没(?:有)?(?:做|完成|去|看|吃)|未完成|没有落实)/u.test(evidence);
  if (!valid) throw new Error("memory_event_outcome_evidence_invalid");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) throw new Error("memory_arguments_invalid");
  return [...value] as string[];
}
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function success(value: unknown): DynamicToolResult { return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] }; }
function failure(code: string): DynamicToolResult { return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ error: code }) }] }; }
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("memory_search_timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
