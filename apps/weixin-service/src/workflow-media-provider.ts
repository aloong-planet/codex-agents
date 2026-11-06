import type { MediaDeliveryPort } from "./media-delivery.js";
export type { MediaDeliveryPort as WorkflowMediaSendPort } from "./media-delivery.js";
import type { MediaExportLibrary } from "./media-export-library.js";
import type { WorkflowMediaArtifactStore } from "./workflow-media-artifact-store.js";
import type { WorkflowMediaRequestStore } from "./workflow-media-request-store.js";
import type { LegacyFileSnapshotter, WorkflowFileArtifactStore } from "./workflow-file-artifact-store.js";
import type {
  WorkflowCapabilityDescriptor,
  WorkflowCapabilityInvocation,
  WorkflowCapabilityOutcome,
  WorkflowCapabilityProvider,
  WorkflowReconcileOutcome,
  WorkflowReconcileContext,
} from "./workflow-engine.js";

export interface WorkflowMediaTargetResolver {
  resolveRunTarget(runId: string): { accountId: string; target: string; senderAccountId?: string } | null;
}


const CATALOG: WorkflowCapabilityDescriptor[] = [
  {
    id: "media.prepare_image", version: 1, effect: "read", retryClass: "pure",
    inputSchema: {
      type: "object", required: ["fileHandle"], additionalProperties: false,
      properties: { fileHandle: { type: "string" } },
    },
    outputSchema: {
      type: "object", required: ["mediaHandle"], additionalProperties: false,
      properties: { mediaHandle: { type: "string" } },
    },
  },
  {
    id: "weixin.send_file", version: 1, effect: "external_send", retryClass: "non_idempotent",
    inputSchema: { type: "object", required: ["fileHandle"], additionalProperties: false, properties: { fileHandle: { type: "string" } } },
    outputSchema: { type: "object", required: ["accepted"], additionalProperties: false, properties: { accepted: { type: "boolean" } } },
  },
  {
    id: "weixin.submit_file", version: 1, effect: "external_send", retryClass: "non_idempotent",
    inputSchema: { type: "object", required: ["fileHandle"], additionalProperties: false, properties: { fileHandle: { type: "string" } } },
    outputSchema: { type: "object", required: ["accepted"], additionalProperties: false, properties: { accepted: { type: "boolean" } } },
  },
  {
    id: "media.resolve_images",
    version: 1,
    effect: "read",
    retryClass: "pure",
    inputSchema: {
      type: "object",
      required: ["requestHandle"],
      additionalProperties: false,
      properties: { requestHandle: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      required: ["matches", "truncated"],
      additionalProperties: false,
      properties: {
        matches: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["handle", "rootId", "rootName", "fileName", "relativePath", "sizeBytes", "modifiedAt", "expiresAt", "caption"],
            additionalProperties: false,
            properties: {
              handle: { type: "string" }, rootId: { type: "string" }, rootName: { type: "string" },
              fileName: { type: "string" }, relativePath: { type: "string" }, sizeBytes: { type: "number" },
              modifiedAt: { type: "number" }, expiresAt: { type: "number" }, caption: { type: "string" },
            },
          },
        },
        truncated: { type: "boolean" },
      },
    },
  },
  {
    id: "media.find_images",
    version: 1,
    effect: "read",
    retryClass: "pure",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        rootId: { type: "string", enum: ["downloads", "pictures", "documents"] },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["matches", "truncated"],
      properties: {
        matches: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["handle", "rootId", "rootName", "fileName", "relativePath", "sizeBytes", "modifiedAt", "expiresAt"],
            properties: {
              handle: { type: "string" }, rootId: { type: "string" }, rootName: { type: "string" },
              fileName: { type: "string" }, relativePath: { type: "string" }, sizeBytes: { type: "number" },
              modifiedAt: { type: "number" }, expiresAt: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        truncated: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    id: "weixin.send_image",
    version: 1,
    effect: "external_send",
    retryClass: "non_idempotent",
    inputSchema: {
      type: "object",
      required: ["mediaHandle"],
      properties: { mediaHandle: { type: "string" }, caption: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["accepted"],
      properties: { accepted: { type: "boolean" } },
      additionalProperties: false,
    },
  },
];

export class WorkflowMediaProvider implements WorkflowCapabilityProvider {
  constructor(
    private readonly mediaLibrary: MediaExportLibrary,
    private readonly artifacts: WorkflowMediaArtifactStore,
    private readonly targets: WorkflowMediaTargetResolver,
    private readonly sender: MediaDeliveryPort,
    private readonly files?: WorkflowFileArtifactStore,
    private readonly requests?: WorkflowMediaRequestStore,
    private readonly legacyFiles?: LegacyFileSnapshotter,
  ) {}

  catalog(): WorkflowCapabilityDescriptor[] {
    return CATALOG.map((item) => structuredClone(item));
  }

  async invoke(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (request.capabilityId === "media.prepare_image" && request.capabilityVersion === 1) {
      return this.prepareImage(request.input);
    }
    if (request.capabilityId === "media.find_images" && request.capabilityVersion === 1) {
      return this.findImages(request.input);
    }
    if (request.capabilityId === "media.resolve_images" && request.capabilityVersion === 1) {
      return this.resolveImages(request.input);
    }
    if (request.capabilityId === "weixin.send_image" && request.capabilityVersion === 1) {
      return this.sendImage(request);
    }
    if ((request.capabilityId === "weixin.send_file" || request.capabilityId === "weixin.submit_file") &&
        request.capabilityVersion === 1) return this.sendFile(request);
    return { status: "failed", errorCode: "workflow_capability_unsupported" };
  }

  private async prepareImage(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    if (!this.files) return { status: "failed", errorCode: "workflow_file_handle_unavailable" };
    const file = this.files.resolveForSend(typeof input.fileHandle === "string" ? input.fileHandle : "");
    if (!file) return { status: "failed", errorCode: "workflow_file_handle_unavailable" };
    try {
      return { status: "succeeded", output: { mediaHandle: this.artifacts.captureSnapshot(file.absolutePath, file.fileName) } };
    } catch {
      return { status: "failed", errorCode: "workflow_media_source_unavailable" };
    }
  }

  private async sendFile(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (!request.effectRef || !request.operationId || !this.files) return { status: "failed", errorCode: "workflow_effect_context_missing" };
    const target = this.targets.resolveRunTarget(request.runId);
    if (!target) return { status: "failed", errorCode: "workflow_file_handle_unavailable" };
    let file: { absolutePath: string; fileName: string } | null;
    try {
      file = await this.files.prepareForSend(
        typeof request.input.fileHandle === "string" ? request.input.fileHandle : "", target.accountId, this.legacyFiles,
      );
    } catch (error) {
      const permissionDenied = error instanceof Error && (error.message === "workflow_module_permission_denied" ||
        error.message === "local_file_permission_changed");
      return { status: "failed", errorCode: permissionDenied ? "workflow_module_permission_denied" : "workflow_file_handle_unavailable" };
    }
    if (!file) return { status: "failed", errorCode: "workflow_file_handle_unavailable" };
    try {
      const result = await this.sender.sendFile({
        ...target,
        filePath: file.absolutePath,
        fileName: file.fileName,
        operationId: request.operationId,
      });
      if (result.ok) return { status: "succeeded", output: { accepted: true } };
      if (result.reason === "unknown") return { status: "unknown", errorCode: "weixin_file_send_unknown" };
      return { status: "failed", errorCode: `weixin_file_send_${result.reason ?? "failed"}` };
    } catch { return { status: "unknown", errorCode: "weixin_file_send_unknown" }; }
  }

  async reconcile(effectRef: string, context?: WorkflowReconcileContext): Promise<WorkflowReconcileOutcome> {
    if (!effectRef.startsWith("workflow-effect:")) {
      return { status: "unknown", errorCode: "workflow_effect_ref_invalid" };
    }
    const target = context && this.targets.resolveRunTarget(context.runId);
    if (!target || !context) return { status: "unknown", errorCode: "workflow_target_unavailable" };
    return this.sender.reconcile(context.operationId, target);
  }

  private async findImages(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    const query = typeof input.query === "string" ? input.query : undefined;
    const rootId = typeof input.rootId === "string" ? input.rootId : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    try {
      const result = await this.mediaLibrary.search({
        ...(query !== undefined ? { query } : {}),
        ...(rootId !== undefined ? { rootId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { status: "succeeded", output: { matches: result.matches.map((match) => this.artifacts.capture(match)), truncated: result.truncated } };
    } catch {
      return { status: "failed", errorCode: "workflow_media_search_failed", retryable: true };
    }
  }

  private async resolveImages(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    const request = this.requests?.resolve(typeof input.requestHandle === "string" ? input.requestHandle : "");
    if (!request) return { status: "failed", errorCode: "workflow_media_request_unavailable" };
    if (request.source === "inbound") {
      const matches = request.candidates
        .filter((candidate) => this.artifacts.resolve(candidate.handle) !== null)
        .map((candidate) => ({ ...candidate, caption: request.caption ?? "" }));
      return { status: "succeeded", output: { matches, truncated: false } };
    }
    const roots = this.mediaLibrary.getPublicState().roots;
    const authorized = request.rootId
      ? roots.some((root) => root.id === request.rootId && root.enabled && root.status === "available")
      : roots.some((root) => root.enabled && root.status === "available");
    if (!authorized) return { status: "failed", errorCode: "workflow_module_permission_denied" };
    try {
      const result = await this.mediaLibrary.search({
        ...(request.query ? { query: request.query } : {}),
        ...(request.rootId ? { rootId: request.rootId } : {}),
        limit: request.selection === "latest" ? 1 : 20,
      });
      if (request.selection === "latest" && result.scanIncomplete) {
        return { status: "failed", errorCode: "workflow_media_search_failed", retryable: true };
      }
      return {
        status: "succeeded",
        output: {
          matches: result.matches.map((match) => ({
            ...this.artifacts.capture(match),
            caption: request.caption ?? "",
          })),
          truncated: result.truncated,
        },
      };
    } catch {
      return { status: "failed", errorCode: "workflow_media_search_failed", retryable: true };
    }
  }

  private async sendImage(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (!request.effectRef || !request.operationId) {
      return { status: "failed", errorCode: "workflow_effect_context_missing" };
    }
    const handle = typeof request.input.mediaHandle === "string" ? request.input.mediaHandle : "";
    const filePath = this.artifacts.resolve(handle);
    if (!filePath) return { status: "failed", errorCode: "workflow_media_handle_unavailable" };
    const target = this.targets.resolveRunTarget(request.runId);
    if (!target) return { status: "failed", errorCode: "workflow_target_unavailable" };
    const caption = typeof request.input.caption === "string" && request.input.caption.length > 0
      ? request.input.caption
      : undefined;
    try {
      const result = await this.sender.sendImage({
        ...target,
        filePath,
        operationId: request.operationId,
        ...(caption ? { caption } : {}),
      });
      if (result.ok) return { status: "succeeded", output: { accepted: true } };
      if (result.reason === "unknown") return { status: "unknown", errorCode: "weixin_media_send_unknown" };
      return { status: "failed", errorCode: `weixin_media_send_${result.reason ?? "failed"}` };
    } catch {
      return { status: "unknown", errorCode: "weixin_media_send_unknown" };
    }
  }
}
