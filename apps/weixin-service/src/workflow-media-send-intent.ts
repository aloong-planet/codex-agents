import type { InboundContent as InboundTextEvent } from "./channel-contract.js";
import type { WorkflowTemplate } from "./workflow-engine.js";
import type { WorkflowIntentRegistration, WorkflowJsonValue, WorkflowOwner } from "./workflow-gateway.js";
import type { WorkflowIntentSummary } from "./workflow-intent-planner.js";
import type { WorkflowMediaRequestStore } from "./workflow-media-request-store.js";

export const MEDIA_SEND_IMAGE_INTENT = "media.send-image";

const SUMMARY = [
  "图片来源已冻结；query、rootId、caption、selection 都是可选细化信息，缺失时不得澄清。",
  "query 仅保留文件名识别词，排除动作、媒体类型和根目录词；rootId 仅可为 downloads、pictures、documents。",
  "caption 仅在用户明确要求时输出；明确要求本地最新一张时输出 selection=latest，不得选择候选或输出路径、时间戳。",
].join("");

const MEDIA_ROOT_ALIASES = new Map<string, "downloads" | "pictures" | "documents">([
  ["downloads", "downloads"],
  ["下载", "downloads"],
  ["pictures", "pictures"],
  ["相册", "pictures"],
  ["documents", "documents"],
  ["文档", "documents"],
]);

export const MEDIA_SEND_IMAGE_WORKFLOW: WorkflowTemplate = {
  id: "media.send-image-one-message",
  version: 1,
  maxSteps: 3,
  maxDepth: 3,
  maxParallelism: 1,
  effectBudget: { read: 1, external_send: 20 },
  steps: [
    {
      id: "resolve",
      capability: "media.resolve_images",
      capabilityVersion: 1,
      triggerInputBindings: { requestHandle: "mediaRequest" },
      timeoutMs: 10_000,
    },
    {
      kind: "input_gate",
      id: "choose",
      dependsOn: ["resolve"],
      candidates: { dependency: "resolve", path: ["matches"] },
      selectionSchema: {
        type: "object",
        required: ["handle", "rootId", "rootName", "fileName", "relativePath", "sizeBytes", "modifiedAt", "expiresAt", "caption"],
        additionalProperties: false,
        properties: {
          handle: { type: "string" }, rootId: { type: "string" }, rootName: { type: "string" },
          fileName: { type: "string" }, relativePath: { type: "string" }, sizeBytes: { type: "number" },
          modifiedAt: { type: "number" }, expiresAt: { type: "number" }, caption: { type: "string" },
        },
      },
      selectionMode: "multiple",
      autoSelect: "unique_only",
      expiresInMs: 24 * 60 * 60 * 1_000,
    },
    {
      kind: "map_capability",
      id: "send",
      capability: "weixin.send_image",
      capabilityVersion: 1,
      dependsOn: ["choose"],
      items: { dependency: "choose" },
      itemInputBindings: {
        mediaHandle: { path: ["handle"] },
        caption: { path: ["caption"] },
      },
      timeoutMs: 45_000,
    },
  ],
};

export function mediaSendImageCandidates(event: InboundTextEvent): WorkflowIntentSummary[] {
  const text = event.text.trim();
  if (text.startsWith("/")) return [];
  const requestsSend = /(?:发送|发给|发我|传给|传我|回传|回发|发回)|\b(?:send|attach)\b/iu.test(text);
  const mentionsImage = /(?:图片|照片|图像|截图|原图|这张|那张|上一张)|\b(?:image|photo)\b/iu.test(text);
  const mentionsImagePath = /(?:^|[\\/\s])[^\s\\/]+\.(?:jpe?g|png|gif|webp|bmp)\b/iu.test(text);
  const hasImage = [...(event.attachments ?? []), ...(event.quote?.attachments ?? [])]
    .some((attachment) => attachment.kind === "image");
  return requestsSend && (mentionsImage || mentionsImagePath || hasImage)
    ? [{ intent: MEDIA_SEND_IMAGE_INTENT, intentVersion: 1, summary: SUMMARY, clarificationSlots: [] }]
    : [];
}

export function createMediaSendImageIntentRegistration(input: {
  owner: WorkflowOwner;
  requests: WorkflowMediaRequestStore;
}): WorkflowIntentRegistration {
  return {
    intent: MEDIA_SEND_IMAGE_INTENT,
    intentVersion: 1,
    summary: SUMMARY,
    owner: input.owner,
    workflowId: MEDIA_SEND_IMAGE_WORKFLOW.id,
    slotsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        rootId: { type: "string" },
        caption: { type: "string" },
        selection: { type: "string", enum: ["latest"] },
      },
    },
    bindInputRefs: ({ slots, trusted }) => ({
      mediaRequest: input.requests.capture(trusted.triggerId, normalizeMediaRootSlot(slots)),
    }),
  };
}

function normalizeMediaRootSlot(slots: Record<string, WorkflowJsonValue>) {
  if (slots.rootId === undefined) return slots;
  if (typeof slots.rootId !== "string") throw new Error("workflow_media_root_invalid");
  const rootId = MEDIA_ROOT_ALIASES.get(slots.rootId.trim().toLocaleLowerCase("en-US"));
  if (!rootId) throw new Error("workflow_media_root_invalid");
  return { ...slots, rootId };
}
