import type { WorkflowTemplate } from "./workflow-engine.js";

const FILE_SELECTION_SCHEMA = {
  type: "object" as const,
  required: ["fileHandle", "fileName", "displayPath", "matchSource", "expiresAt"],
  additionalProperties: false,
  properties: {
    fileHandle: { type: "string" as const },
    fileName: { type: "string" as const },
    displayPath: { type: "string" as const },
    matchSource: { type: "string" as const, enum: ["name_path", "content"] },
    expiresAt: { type: "number" as const },
  },
};

export const NOTES_SEND_FILE_WORKFLOW: WorkflowTemplate = {
  id: "notes.send-file-one-message",
  version: 1,
  maxSteps: 3,
  maxDepth: 3,
  maxParallelism: 1,
  effectBudget: { read: 1, external_send: 20 },
  steps: [
    {
      id: "locate",
      capability: "files.locate",
      capabilityVersion: 1,
      input: { moduleId: "notes", scopeId: "vault", extensions: [".md"] },
      triggerInputBindings: { requestHandle: "fileQuery" },
      timeoutMs: 10_000,
    },
    {
      kind: "input_gate",
      id: "choose",
      dependsOn: ["locate"],
      candidates: { dependency: "locate", path: ["matches"] },
      selectionSchema: FILE_SELECTION_SCHEMA,
      selectionMode: "multiple",
      autoSelect: "unique_only",
      expiresInMs: 24 * 60 * 60 * 1_000,
    },
    {
      kind: "map_capability",
      id: "send",
      capability: "weixin.send_file",
      capabilityVersion: 1,
      dependsOn: ["choose"],
      items: { dependency: "choose" },
      itemInputBindings: { fileHandle: { path: ["fileHandle"] } },
      timeoutMs: 45_000,
    },
  ],
};
