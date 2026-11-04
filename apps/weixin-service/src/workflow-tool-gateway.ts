import type { WorkflowSubmission, WorkflowTrigger } from "./workflow-engine.js";
import type { WorkflowToolCatalog } from "./workflow-tool-catalog.js";
import type {
  TrustedWorkflowTurn,
  WorkflowHandoffReceipt,
  WorkflowToolGateway as WorkflowToolGatewayPort,
  WorkflowToolGatewayResult,
  WorkflowToolRequest,
} from "./workflow-tool-host.js";

export type WorkflowToolRegistration = {
  toolId: string;
  toolVersion: number;
  templateId: string;
  workflowIds?: string[];
  resolveWorkflowId?(input: {
    arguments: unknown;
    trusted: TrustedWorkflowTurn;
  }): string;
  bindInputRefs(input: {
    arguments: unknown;
    trusted: TrustedWorkflowTurn;
  }): Promise<Record<string, string>> | Record<string, string>;
};

export interface WorkflowToolEnginePort {
  supersedePendingSignals(accountRef: string, targetRef: string): string[];
  submit(trigger: WorkflowTrigger): Promise<WorkflowSubmission>;
  get(runId: string): unknown;
}

export type WorkflowToolReplyProjector = (
  run: unknown,
  trusted: TrustedWorkflowTurn,
) => WorkflowHandoffReceipt;

export class WorkflowToolGateway implements WorkflowToolGatewayPort {
  private readonly registrations = new Map<string, WorkflowToolRegistration>();

  constructor(
    private readonly catalog: WorkflowToolCatalog,
    registrations: readonly WorkflowToolRegistration[],
    private readonly engine: WorkflowToolEnginePort,
    private readonly projector: WorkflowToolReplyProjector,
  ) {
    for (const registration of registrations) {
      const member = catalog.get(registration.toolId, registration.toolVersion);
      if (!member || member.executionClass !== "terminal_workflow" ||
          member.templateId !== registration.templateId) {
        throw new Error("workflow_tool_registration_mismatch");
      }
      if ((registration.resolveWorkflowId === undefined) !== (registration.workflowIds === undefined) ||
          registration.workflowIds?.length === 0 ||
          registration.workflowIds?.some((workflowId) => !workflowId || workflowId.length > 128)) {
        throw new Error("workflow_tool_registration_mismatch");
      }
      const key = registrationKey(registration.toolId, registration.toolVersion);
      if (this.registrations.has(key)) throw new Error("workflow_tool_registration_duplicate");
      this.registrations.set(key, registration);
    }
  }

  async submit(request: WorkflowToolRequest, trusted: TrustedWorkflowTurn): Promise<WorkflowToolGatewayResult> {
    const member = this.catalog.get(request.toolId, request.toolVersion);
    if (!member) throw new Error("workflow_tool_unavailable");
    if (member.executionClass !== "terminal_workflow") throw new Error("workflow_tool_not_terminal");
    if (!this.catalog.accepts(request.toolId, request.toolVersion, request.arguments)) {
      throw new Error("workflow_tool_arguments_invalid");
    }
    const registration = this.registrations.get(registrationKey(request.toolId, request.toolVersion));
    if (!registration || registration.templateId !== member.templateId) {
      throw new Error("workflow_tool_registration_unavailable");
    }
    const inputRefs = await registration.bindInputRefs({
      arguments: structuredClone(request.arguments),
      trusted: structuredClone(trusted),
    });
    validateInputRefs(inputRefs);
    const requestedWorkflowId = registration.resolveWorkflowId
      ? registration.resolveWorkflowId({
          arguments: structuredClone(request.arguments),
          trusted: structuredClone(trusted),
        })
      : registration.templateId;
    if (registration.workflowIds && !registration.workflowIds.includes(requestedWorkflowId)) {
      throw new Error("workflow_tool_template_unavailable");
    }
    this.engine.supersedePendingSignals(trusted.accountId, trusted.target);
    const submission = await this.engine.submit({
      triggerId: trusted.eventKey,
      source: "weixin",
      occurredAt: trusted.occurredAt,
      requestedWorkflowId,
      accountRef: trusted.accountId,
      targetRef: trusted.target,
      inputRefs: structuredClone(inputRefs),
    });
    // Durable acceptance is independent of the disposable presentation. Nothing
    // after this boundary may turn a projection failure into a preflight retry.
    const claimed: WorkflowToolGatewayResult = { disposition: "claimed", runRef: submission.runId };
    try {
      const run = this.engine.get(submission.runId);
      if (!run) throw new Error("workflow_tool_run_unavailable");
      claimed.receipt = this.projector(run, structuredClone(trusted));
    } catch {
      claimed.receiptErrorCode = "workflow_tool_receipt_unavailable";
    }
    return claimed;
  }
}

function registrationKey(toolId: string, version: number): string {
  return `${toolId}@${version}`;
}

function validateInputRefs(inputRefs: Record<string, string>): void {
  if (!inputRefs || typeof inputRefs !== "object" || Array.isArray(inputRefs) ||
      Object.keys(inputRefs).length > 32 ||
      Object.entries(inputRefs).some(([key, value]) =>
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) ||
        typeof value !== "string" || value.length === 0 || value.length > 512)) {
    throw new Error("workflow_tool_input_refs_invalid");
  }
}
