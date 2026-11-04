import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboundTextEvent } from "../src/demo-service.js";
import { renderWorkflowRun, WeixinWorkflowTriggerAdapter } from "../src/weixin-workflow-trigger-adapter.js";
import { pendingRequestTextHash, type PendingPresentation } from "../src/workflow-pending-response-coordinator.js";
import { WorkflowEngine, type WorkflowTemplate } from "../src/workflow-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("WeixinWorkflowTriggerAdapter integration", () => {
  it.each([undefined, "single", "multiple"] as const)("presents %s choices consistently and resumes the same frozen run without repeating search", async (selectionMode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-trigger-adapter-integration-"));
    tempDirs.push(directory);
    let searches = 0;
    const selected: unknown[] = [];
    const template: WorkflowTemplate = {
      id: "fixture.weixin-trigger-adapter", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
      effectBudget: { read: 2 },
      steps: [
        { id: "search", capability: "fixture.adapter-search", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] },
          selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000,
          ...(selectionMode ? { selectionMode } : {}),
        },
        {
          id: "use", capability: "fixture.adapter-use", capabilityVersion: 1, dependsOn: ["choose"],
          inputBindings: { selected: { dependency: "choose" } }, timeoutMs: 1_000,
        },
      ],
    };
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => 1_800_000_000_000,
      templates: [template],
      providers: [{
        catalog: () => [{
          id: "fixture.adapter-search", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: { type: "object" as const },
          outputSchema: {
            type: "object" as const, required: ["matches"], additionalProperties: false,
            properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
          },
          timeoutMs: 1_000,
        }, {
          id: "fixture.adapter-use", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: {
            type: "object" as const, required: ["selected"], additionalProperties: false,
            properties: { selected: selectionMode === "multiple"
              ? { type: "array" as const, items: { type: "string" as const } }
              : { type: "string" as const } },
          },
          outputSchema: { type: "object" as const }, timeoutMs: 1_000,
        }],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.adapter-search") {
            searches += 1;
            return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
          }
          selected.push((request.input as { selected: string }).selected);
          return { status: "succeeded" as const, output: {} };
        },
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "original", source: "weixin", occurredAt: 1,
      requestedWorkflowId: template.id, accountRef: "account-a", targetRef: "target-a",
    });
    expect(engine.get(submission.runId)?.status).toBe("needs_input");
    const waiting = engine.listPendingSignals("account-a", "target-a");
    const initial = renderWorkflowRun(engine.get(submission.runId), waiting);
    const expectedInstruction = selectionMode === "multiple"
      ? "可以回复一个或多个序号、候选描述，也可以直接说明取消"
      : "请回复一个序号或一个候选描述，也可以直接说明取消";
    expect(initial.handled && initial.reply).toContain(expectedInstruction);
    expect(initial.handled && initial.reply.includes("1和2")).toBe(selectionMode === "multiple");
    let presentation: PendingPresentation | undefined = {
      accountRef: "account-a", targetRef: "target-a", runId: submission.runId,
      signalRef: waiting[0]!.signalRef, revision: waiting[0]!.revision,
      expiresAt: waiting[0]!.expiresAt, acceptedAt: 1_800_000_000_000,
      requestTextHash: pendingRequestTextHash("把笔记原文件发给我"),
    };

    const route = vi.fn(async (input: {
      requests: Array<{ requestRef: string; choices: Array<{ choiceRef: string }> }>;
    }) => ({
      kind: "respond",
      requestRef: input.requests[0]!.requestRef,
      choiceRefs: [input.requests[0]!.choices[1]!.choiceRef],
    }));
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine,
      pendingResponseRouter: { route },
      pendingPresentations: { get: () => presentation, put: (value) => { presentation = value; } },
      now: () => 1_800_000_000_001,
    });
    const inbound: InboundTextEvent = {
      key: "selection", messageId: "selection", accountId: "account-a", target: "target-a",
      source: "text", text: "选第2个", receivedAt: 1_800_000_000_001, replyText: vi.fn(),
    };
    const redisplayed = await adapter.tryHandlePending({ ...inbound, key: "repeat", text: "把笔记原文件发给我" });
    expect(redisplayed).toMatchObject(initial);
    expect(route).not.toHaveBeenCalled();
    await expect(adapter.tryHandle(inbound)).resolves.toEqual({
      handled: true, outcome: "succeeded", reply: "工作流已完成。",
    });
    expect(engine.get(submission.runId)?.status).toBe("succeeded");
    expect(route).toHaveBeenCalledOnce();
    expect(searches).toBe(1);
    expect(selected).toEqual(selectionMode === "multiple" ? [["Archive.md"]] : ["Archive.md"]);
    await engine.close();
  });
});
