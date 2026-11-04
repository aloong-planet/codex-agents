import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";
import { WorkflowSchedulerAdapter } from "../src/workflow-scheduler-adapter.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("scheduler target binding", () => {
  it("binds the configured target before a scheduled effect executes and never replaces it on duplicate delivery", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-schedule-target-"));
    dirs.push(directory);
    const targets = new WorkflowRunTargetStore(path.join(directory, "targets.sqlite"));
    const observed: Array<{ accountId: string; target: string }> = [];
    const engine = new WorkflowEngine(path.join(directory, "workflows.sqlite"), {
      createRunId: () => "scheduled-run",
      templates: [{
        id: "fixture.scheduled-send", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { external_send: 1 },
        steps: [{ id: "send", capability: "fixture.scheduled-send", capabilityVersion: 1, timeoutMs: 1_000 }],
      }],
      providers: [{
        catalog: () => [{
          id: "fixture.scheduled-send", version: 1, effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
          inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const },
        }],
        invoke: async (request) => {
          const target = targets.resolveRunTarget(request.runId);
          if (!target) return { status: "failed" as const, errorCode: "workflow_run_target_missing" };
          observed.push(target);
          return { status: "succeeded" as const, output: {} };
        },
      }],
      onRunAccepted: ({ runId, trigger }) => {
        if (trigger.accountRef && trigger.targetRef) targets.bind(runId, trigger.accountRef, trigger.targetRef);
      },
    });
    await engine.start();

    const first = new WorkflowSchedulerAdapter(engine, [{
      scheduleId: "scheduled-send", workflowId: "fixture.scheduled-send",
      accountRef: "account-a", targetRef: "first@im.wechat",
    }]);
    const occurrence = { scheduleId: "scheduled-send", occurrenceId: "2026-08-24:0830", occurredAt: 1_800_000_000_000 };
    await expect(first.submitOccurrence(occurrence)).resolves.toEqual({ runId: "scheduled-run", duplicate: false });

    const changed = new WorkflowSchedulerAdapter(engine, [{
      scheduleId: "scheduled-send", workflowId: "fixture.scheduled-send",
      accountRef: "account-b", targetRef: "second@im.wechat",
    }]);
    await expect(changed.submitOccurrence(occurrence)).resolves.toEqual({ runId: "scheduled-run", duplicate: true });
    expect(observed).toEqual([{ accountId: "account-a", target: "first@im.wechat" }]);
    expect(targets.resolveRunTarget("scheduled-run")).toEqual({ accountId: "account-a", target: "first@im.wechat" });

    await engine.close();
    targets.close();
  });
});
