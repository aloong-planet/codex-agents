import type { WorkflowSubmission, WorkflowTrigger } from "./workflow-engine.js";

const SCHEDULE_COMPONENT = /^[A-Za-z0-9._:@-]{1,200}$/;
const WORKFLOW_ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const ACCOUNT_REF = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_REF = /^[A-Za-z0-9._-]+@im\.wechat$/;

export type WorkflowScheduleDefinition = {
  scheduleId: string;
  workflowId: string;
  accountRef?: string;
  targetRef?: string;
};

export type WorkflowScheduleOccurrence = {
  scheduleId: string;
  occurrenceId: string;
  occurredAt: number;
};

export interface WorkflowSubmissionPort {
  submit(trigger: WorkflowTrigger): Promise<WorkflowSubmission>;
}

export class WorkflowSchedulerAdapter {
  private readonly schedules = new Map<string, WorkflowScheduleDefinition>();

  constructor(
    private readonly engine: WorkflowSubmissionPort,
    definitions: WorkflowScheduleDefinition[],
  ) {
    for (const definition of definitions) {
      validateDefinition(definition);
      if (this.schedules.has(definition.scheduleId)) throw new Error("workflow_schedule_duplicate");
      this.schedules.set(definition.scheduleId, { ...definition });
    }
  }

  submitOccurrence(occurrence: WorkflowScheduleOccurrence): Promise<WorkflowSubmission> {
    if (!SCHEDULE_COMPONENT.test(occurrence.scheduleId) || !SCHEDULE_COMPONENT.test(occurrence.occurrenceId) ||
        !Number.isSafeInteger(occurrence.occurredAt) || occurrence.occurredAt < 0) {
      throw new Error("workflow_schedule_occurrence_invalid");
    }
    const definition = this.schedules.get(occurrence.scheduleId);
    if (!definition) throw new Error("workflow_schedule_unavailable");
    return this.engine.submit({
      triggerId: `schedule:${definition.scheduleId}:${occurrence.occurrenceId}`,
      source: "scheduler",
      occurredAt: occurrence.occurredAt,
      requestedWorkflowId: definition.workflowId,
      ...(definition.accountRef ? { accountRef: definition.accountRef } : {}),
      ...(definition.targetRef ? { targetRef: definition.targetRef } : {}),
      scheduleRef: definition.scheduleId,
    });
  }
}

function validateDefinition(definition: WorkflowScheduleDefinition): void {
  if (!SCHEDULE_COMPONENT.test(definition.scheduleId) || !WORKFLOW_ID.test(definition.workflowId)) {
    throw new Error("workflow_schedule_invalid");
  }
  if ((definition.accountRef === undefined) !== (definition.targetRef === undefined)) {
    throw new Error("workflow_schedule_target_incomplete");
  }
  if (definition.accountRef !== undefined &&
      (!ACCOUNT_REF.test(definition.accountRef) || !TARGET_REF.test(definition.targetRef!))) {
    throw new Error("workflow_schedule_target_invalid");
  }
}
