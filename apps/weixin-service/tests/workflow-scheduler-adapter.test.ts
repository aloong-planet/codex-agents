import { describe, expect, it, vi } from "vitest";

import { WorkflowSchedulerAdapter } from "../src/workflow-scheduler-adapter.js";

describe("WorkflowSchedulerAdapter", () => {
  it("submits a stable scheduler occurrence directly to its configured workflow", async () => {
    const submit = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const adapter = new WorkflowSchedulerAdapter(
      { submit },
      [{ scheduleId: "morning-note", workflowId: "notes.morning", accountRef: "account-a", targetRef: "user@im.wechat" }],
    );

    await expect(adapter.submitOccurrence({
      scheduleId: "morning-note",
      occurrenceId: "2026-08-24:0830",
      occurredAt: Date.parse("2026-08-24T08:30:00+08:00"),
    })).resolves.toEqual({ runId: "run-1", duplicate: false });

    expect(submit).toHaveBeenCalledWith({
      triggerId: "schedule:morning-note:2026-08-24:0830",
      source: "scheduler",
      occurredAt: Date.parse("2026-08-24T08:30:00+08:00"),
      requestedWorkflowId: "notes.morning",
      accountRef: "account-a",
      targetRef: "user@im.wechat",
      scheduleRef: "morning-note",
    });
  });

  it("rejects missing schedules and incomplete outbound targets before submitting", async () => {
    const submit = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    expect(() => new WorkflowSchedulerAdapter(
      { submit },
      [{ scheduleId: "broken", workflowId: "notes.morning", accountRef: "account-a" }],
    )).toThrow("workflow_schedule_target_incomplete");

    const adapter = new WorkflowSchedulerAdapter({ submit }, []);
    expect(() => adapter.submitOccurrence({
      scheduleId: "missing",
      occurrenceId: "2026-08-24:0830",
      occurredAt: Date.parse("2026-08-24T08:30:00+08:00"),
    })).toThrow("workflow_schedule_unavailable");
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects duplicate schedule definitions instead of choosing one", () => {
    const submit = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    expect(() => new WorkflowSchedulerAdapter({ submit }, [
      { scheduleId: "same", workflowId: "notes.first" },
      { scheduleId: "same", workflowId: "notes.second" },
    ])).toThrow("workflow_schedule_duplicate");
  });
});
