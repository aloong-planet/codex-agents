import {
  isValidJsonSchema,
  matchesJsonSchema,
  type WorkflowJsonSchema,
  type WorkflowSubmission,
  type WorkflowTrigger,
} from "./workflow-engine.js";

export type WorkflowOwner = "legacy" | "shadow" | "workflow";
export type WorkflowIntentDisposition = "ordinary_chat" | "workflow" | "needs_clarification";
export type WorkflowJsonValue = null | boolean | number | string | WorkflowJsonValue[] | {
  [key: string]: WorkflowJsonValue;
};

export type IntentProposal = {
  disposition: WorkflowIntentDisposition;
  intent?: string;
  intentVersion?: number;
  confidence: number;
  slots: Record<string, WorkflowJsonValue>;
  missingSlots: string[];
};

export type TrustedWorkflowTrigger = Omit<WorkflowTrigger, "requestedWorkflowId" | "inputRefs">;

export type WorkflowIntentRegistration = {
  intent: string;
  intentVersion: number;
  summary: string;
  owner: WorkflowOwner;
  workflowId: string;
  slotsSchema: WorkflowJsonSchema;
  bindInputRefs(input: {
    slots: Record<string, WorkflowJsonValue>;
    trusted: TrustedWorkflowTrigger;
  }): Promise<Record<string, string>> | Record<string, string>;
};

export type WorkflowGatewayInput = {
  protocolVersion: number;
  proposal: unknown;
  trusted: TrustedWorkflowTrigger;
};

export type WorkflowGatewayResult =
  | { owner: "legacy" | "shadow"; workflowId: string }
  | { owner: "workflow"; workflowId: string; submission: WorkflowSubmission };

export interface WorkflowSubmissionPort {
  submit(trigger: WorkflowTrigger): Promise<WorkflowSubmission>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROPOSAL_KEYS = new Set([
  "disposition", "intent", "intentVersion", "confidence", "slots", "missingSlots",
]);

export class IntentRegistry {
  private readonly registrations = new Map<string, WorkflowIntentRegistration>();

  constructor(registrations: WorkflowIntentRegistration[]) {
    for (const registration of registrations) {
      validateRegistration(registration);
      const key = intentKey(registration.intent, registration.intentVersion);
      if (this.registrations.has(key)) throw new Error("workflow_intent_duplicate");
      this.registrations.set(key, Object.freeze({
        ...registration,
        slotsSchema: freezeJson(structuredClone(registration.slotsSchema)),
      }));
    }
  }

  get(intent: string, version: number): WorkflowIntentRegistration | undefined {
    return this.registrations.get(intentKey(intent, version));
  }

  summaries(): Array<{ intent: string; intentVersion: number; summary: string }> {
    return [...this.registrations.values()]
      .map(({ intent, intentVersion, summary }) => ({ intent, intentVersion, summary }))
      .sort((left, right) => intentKey(left.intent, left.intentVersion)
        .localeCompare(intentKey(right.intent, right.intentVersion)));
  }
}

export class WorkflowGateway {
  constructor(
    private readonly intents: IntentRegistry,
    private readonly engine: WorkflowSubmissionPort,
  ) {}

  async submit(input: WorkflowGatewayInput): Promise<WorkflowGatewayResult> {
    if (input.protocolVersion !== 1) throw new Error("workflow_gateway_protocol_unsupported");
    const proposal = parseIntentProposal(input.proposal);
    if (proposal.disposition !== "workflow") throw new Error("workflow_gateway_proposal_not_actionable");
    if (!proposal.intent || proposal.intentVersion === undefined) {
      throw new Error("workflow_intent_proposal_invalid");
    }
    const registration = this.intents.get(proposal.intent, proposal.intentVersion);
    if (!registration) throw new Error("workflow_intent_unavailable");
    if (!matchesJsonSchema(proposal.slots, registration.slotsSchema)) {
      throw new Error("workflow_intent_slots_invalid");
    }
    if (proposal.missingSlots.length > 0) throw new Error("workflow_intent_slots_missing");
    if (registration.owner !== "workflow") {
      return { owner: registration.owner, workflowId: registration.workflowId };
    }

    const inputRefs = await registration.bindInputRefs({
      slots: structuredClone(proposal.slots),
      trusted: structuredClone(input.trusted),
    });
    const submission = await this.engine.submit({
      ...structuredClone(input.trusted),
      requestedWorkflowId: registration.workflowId,
      inputRefs,
    });
    return { owner: "workflow", workflowId: registration.workflowId, submission };
  }
}

export function parseIntentProposal(value: unknown): IntentProposal {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROPOSAL_KEYS.has(key))) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  if (!new Set<unknown>(["ordinary_chat", "workflow", "needs_clarification"]).has(value.disposition) ||
      typeof value.confidence !== "number" || !Number.isFinite(value.confidence) ||
      value.confidence < 0 || value.confidence > 1 || !isRecord(value.slots) ||
      !isJsonValue(value.slots) || !isStringArray(value.missingSlots)) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  if (value.intent !== undefined && (!isIdentifier(value.intent))) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  if (value.intentVersion !== undefined &&
      (!Number.isSafeInteger(value.intentVersion) || Number(value.intentVersion) <= 0)) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  const disposition = value.disposition as WorkflowIntentDisposition;
  if (disposition === "ordinary_chat" &&
      (value.intent !== undefined || value.intentVersion !== undefined ||
       Object.keys(value.slots).length > 0 || value.missingSlots.length > 0)) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  if (disposition === "workflow" &&
      (value.intent === undefined || value.intentVersion === undefined || value.missingSlots.length > 0)) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  if (disposition === "needs_clarification" && value.missingSlots.length === 0) {
    throw new Error("workflow_intent_proposal_invalid");
  }
  return structuredClone(value) as IntentProposal;
}

function validateRegistration(registration: WorkflowIntentRegistration): void {
  if (!isIdentifier(registration.intent) || !Number.isSafeInteger(registration.intentVersion) ||
      registration.intentVersion <= 0 || !isIdentifier(registration.workflowId) ||
      !new Set<unknown>(["legacy", "shadow", "workflow"]).has(registration.owner) ||
      typeof registration.summary !== "string" || registration.summary.length < 1 ||
      registration.summary.length > 256 || !isValidJsonSchema(registration.slotsSchema) ||
      registration.slotsSchema.type !== "object" || typeof registration.bindInputRefs !== "function") {
    throw new Error("workflow_intent_registration_invalid");
  }
}

function intentKey(intent: string, version: number): string {
  return `${intent}@${version}`;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every((entry) =>
    typeof entry === "string" && entry.length > 0 && entry.length <= 128);
}

function isJsonValue(value: unknown, depth = 0): value is WorkflowJsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value !== "string" || value.length <= 4_096;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every((entry) => isJsonValue(entry, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, entry]) =>
    key.length > 0 && key.length <= 128 && isJsonValue(entry, depth + 1));
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
