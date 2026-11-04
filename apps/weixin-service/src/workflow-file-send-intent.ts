import type { WorkflowJsonSchema, WorkflowTemplate } from "./workflow-engine.js";

export const WORKFLOW_FILE_SEND_CANDIDATE_SCHEMA: WorkflowJsonSchema = {
  type: "object",
  required: ["candidateRef", "fileName", "displayPath", "sizeBytes", "modifiedAt"],
  additionalProperties: false,
  properties: {
    candidateRef: { type: "string" },
    fileName: { type: "string" },
    displayPath: { type: "string" },
    sizeBytes: { type: "number" },
    modifiedAt: { type: "number" },
  },
};

export const WEIXIN_SEND_FILES_WORKFLOW = createTemplate("weixin.send-files", "multiple");
export const WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW = createTemplate("weixin.send-files-single-choice", "single");
export const WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW = createImageTemplate("weixin.send-local-images", "multiple");
export const WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW = createImageTemplate("weixin.send-local-images-single-choice", "single");

function createTemplate(id: string, selectionMode: "single" | "multiple"): WorkflowTemplate {
  return {
    id,
    version: 1,
    maxSteps: 4,
    maxDepth: 4,
    maxParallelism: 1,
    effectBudget: { read: 2, external_send: 20 },
    steps: [
      {
        id: "load",
        capability: "files.load_send_manifest",
        capabilityVersion: 1,
        triggerInputBindings: { manifestHandle: "sendManifest" },
        timeoutMs: 5_000,
      },
      {
        kind: "input_gate",
        id: "choose",
        dependsOn: ["load"],
        candidates: { dependency: "load", path: ["candidates"] },
        preselected: { dependency: "load", path: ["preselected"] },
        selectionSchema: WORKFLOW_FILE_SEND_CANDIDATE_SCHEMA,
        selectionMode,
        autoSelect: "unique_only",
        expiresInMs: 24 * 60 * 60 * 1_000,
      },
      {
        id: "prepare",
        capability: "files.prepare_send_selection",
        capabilityVersion: 1,
        dependsOn: ["choose"],
        triggerInputBindings: { manifestHandle: "sendManifest" },
        inputBindings: { selection: { dependency: "choose" } },
        timeoutMs: 30_000,
      },
      {
        kind: "map_capability",
        id: "send",
        capability: "weixin.submit_file",
        capabilityVersion: 1,
        dependsOn: ["prepare"],
        items: { dependency: "prepare", path: ["items"] },
        itemInputBindings: { fileHandle: { path: ["fileHandle"] } },
        timeoutMs: 45_000,
      },
    ],
  };
}

function createImageTemplate(id: string, selectionMode: "single" | "multiple"): WorkflowTemplate {
  return {
    id,
    version: 1,
    maxSteps: 5,
    maxDepth: 5,
    maxParallelism: 1,
    effectBudget: { read: 22, external_send: 20 },
    steps: [
      {
        id: "load",
        capability: "files.load_send_manifest",
        capabilityVersion: 1,
        triggerInputBindings: { manifestHandle: "sendManifest" },
        timeoutMs: 5_000,
      },
      {
        kind: "input_gate",
        id: "choose",
        dependsOn: ["load"],
        candidates: { dependency: "load", path: ["candidates"] },
        preselected: { dependency: "load", path: ["preselected"] },
        selectionSchema: WORKFLOW_FILE_SEND_CANDIDATE_SCHEMA,
        selectionMode,
        autoSelect: "unique_only",
        expiresInMs: 24 * 60 * 60 * 1_000,
      },
      {
        id: "prepare",
        capability: "files.prepare_send_selection",
        capabilityVersion: 1,
        dependsOn: ["choose"],
        triggerInputBindings: { manifestHandle: "sendManifest" },
        inputBindings: { selection: { dependency: "choose" } },
        timeoutMs: 30_000,
      },
      {
        kind: "map_capability",
        id: "prepare-image",
        capability: "media.prepare_image",
        capabilityVersion: 1,
        dependsOn: ["prepare"],
        items: { dependency: "prepare", path: ["items"] },
        itemInputBindings: { fileHandle: { path: ["fileHandle"] } },
        timeoutMs: 10_000,
      },
      {
        kind: "map_capability",
        id: "send",
        capability: "weixin.send_image",
        capabilityVersion: 1,
        dependsOn: ["prepare-image"],
        items: { dependency: "prepare-image", path: ["items"] },
        itemInputBindings: { mediaHandle: { path: ["output", "mediaHandle"] } },
        timeoutMs: 45_000,
      },
    ],
  };
}
