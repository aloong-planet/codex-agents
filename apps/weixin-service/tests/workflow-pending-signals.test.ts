import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowEngine, type WorkflowTemplate } from "../src/workflow-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("WorkflowEngine pending signal query", () => {
  it("returns only waiting inputs bound to the requested Weixin account and target", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-pending-signals-"));
    tempDirs.push(directory);
    const template: WorkflowTemplate = {
      id: "fixture.pending-signals", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [
        { id: "search", capability: "fixture.pending-search", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] },
          selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000,
        },
      ],
    };
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => 1_800_000_000_000,
      templates: [template],
      providers: [{
        catalog: () => [{
          id: "fixture.pending-search", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: { type: "object" as const },
          outputSchema: {
            type: "object" as const, required: ["matches"], additionalProperties: false,
            properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
          },
          timeoutMs: 1_000,
        }],
        invoke: async () => ({ status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } }),
      }],
    });
    await engine.start();
    const own = await engine.submit({
      triggerId: "own", source: "weixin", occurredAt: 1, requestedWorkflowId: template.id,
      accountRef: "account-a", targetRef: "target-a",
    });
    await engine.submit({
      triggerId: "other-target", source: "weixin", occurredAt: 2, requestedWorkflowId: template.id,
      accountRef: "account-a", targetRef: "target-b",
    });

    expect(engine.listPendingSignals("account-a", "target-a")).toEqual([{
      runId: own.runId,
      signalRef: engine.get(own.runId)!.pendingInput!.signalRef,
      stepId: "choose",
      revision: engine.get(own.runId)!.pendingInput!.revision,
      expiresAt: 1_800_000_060_000,
      candidates: ["Inbox.md", "Archive.md"],
      selectionMode: "single",
    }]);
    await engine.close();
  });
});
