import path from "node:path";
import { WorkflowEngine, type WorkflowTemplate } from "../../src/workflow-engine.js";
import { WorkflowRunTargetStore } from "../../src/workflow-run-target-store.js";

// Historical 24efdc4 notes.send-file-resolved protocol shape. The resolver is
// an external-model boundary substitute; state and crash recovery use the real Engine.
// This fixture does not test file authorization or contact Tencent.
const directory = process.argv[2]!;
const targets = new WorkflowRunTargetStore(path.join(directory, "workflow-targets.sqlite"));
const candidate = { type: "object" as const, required: ["fileHandle", "fileName", "displayPath", "matchSource", "score", "modifiedAt", "expiresAt"], additionalProperties: false,
  properties: { fileHandle: { type: "string" as const }, fileName: { type: "string" as const }, displayPath: { type: "string" as const },
    matchSource: { type: "string" as const, enum: ["name_path", "content"] }, score: { type: "number" as const },
    modifiedAt: { type: "number" as const }, expiresAt: { type: "number" as const } } };
const template: WorkflowTemplate = {
  id: "notes.send-file-resolved", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
  effectBudget: { read: 1, external_send: 20 }, steps: [
    { id: "resolve", capability: "files.resolve", capabilityVersion: 1,
      input: { moduleId: "notes", scopeIds: ["vault"], extensions: [".md"] },
      triggerInputBindings: { requestHandle: "fileQuery" }, timeoutMs: 30_000 },
    { kind: "input_gate", id: "choose", dependsOn: ["resolve"], candidates: { dependency: "resolve", path: ["matches"] },
      preselected: { dependency: "resolve", path: ["preselected"] }, selectionSchema: candidate,
      selectionMode: "multiple", autoSelect: "unique_only", expiresInMs: 86_400_000 },
    { kind: "map_capability", id: "send", capability: "weixin.send_file", capabilityVersion: 1,
      dependsOn: ["choose"], items: { dependency: "choose" }, itemInputBindings: { fileHandle: { path: ["fileHandle"] } }, timeoutMs: 45_000 },
  ],
};
const engine = new WorkflowEngine(path.join(directory, "workflows.sqlite"), {
  templates: [template], onRunAccepted: ({ runId }) => targets.bind(runId, "fixture-bot", "fixture-user@im.wechat"),
  providers: [{ catalog: () => [{
    id: "files.resolve", version: 1, effect: "read", retryClass: "pure",
    inputSchema: { type: "object", required: ["moduleId", "scopeIds", "requestHandle", "extensions"], additionalProperties: false,
      properties: { moduleId: { type: "string" }, scopeIds: { type: "array", maxItems: 16, items: { type: "string" } },
        requestHandle: { type: "string" }, extensions: { type: "array", maxItems: 16, items: { type: "string" } } } },
    outputSchema: { type: "object", required: ["resolution", "matches", "preselected", "scanComplete", "resultTruncated"], additionalProperties: false,
      properties: { resolution: { type: "string", enum: ["selected", "needs_choice", "not_found", "incomplete"] },
        matches: { type: "array", maxItems: 20, items: candidate }, preselected: { type: "array", maxItems: 20, items: candidate },
        scanComplete: { type: "boolean" }, resultTruncated: { type: "boolean" } } },
  }, {
    id: "weixin.send_file", version: 1, effect: "external_send", retryClass: "non_idempotent",
    inputSchema: { type: "object", required: ["fileHandle"], additionalProperties: false, properties: { fileHandle: { type: "string" } } },
    outputSchema: { type: "object", required: ["accepted"], properties: { accepted: { type: "boolean" } } },
  }], invoke: async (request) => {
    if (request.capabilityId !== "files.resolve") throw new Error("unexpected_file_send");
    process.stdout.write(JSON.stringify(engine.get(request.runId)) + "\n");
    return new Promise(() => {});
  } }],
});
await engine.start();
await engine.submit({ source: "weixin", triggerId: "retirement-inflight", occurredAt: Date.now(),
  accountRef: "fixture-bot", targetRef: "fixture-user@im.wechat", requestedWorkflowId: template.id,
  inputRefs: { fileQuery: "filequery_0123456789abcdef0123456789abcdef" } });
