import fs from "node:fs";
import path from "node:path";

import type { DirectMarkdownVault } from "./direct-markdown-vault.js";
import type { WorkflowModulePermissionStore } from "./workflow-module-permission-store.js";
import type { WorkflowNoteArtifactStore } from "./workflow-note-artifact-store.js";
import type { WorkflowFileArtifactStore } from "./workflow-file-artifact-store.js";
import type {
  WorkflowCapabilityDescriptor,
  WorkflowCapabilityInvocation,
  WorkflowCapabilityOutcome,
  WorkflowCapabilityProvider,
} from "./workflow-engine.js";

const MODULE_ID = "notes";

const CATALOG: WorkflowCapabilityDescriptor[] = [
  {
    id: "notes.export_file", version: 1, effect: "read", retryClass: "pure",
    modulePermission: { moduleId: MODULE_ID, access: "read", scopeInput: "scopeId" },
    inputSchema: { type: "object", required: ["scopeId", "noteHandle"], additionalProperties: false, properties: { scopeId: { type: "string" }, noteHandle: { type: "string" } } },
    outputSchema: { type: "object", required: ["fileHandle", "fileName", "sizeBytes", "expiresAt"], additionalProperties: false, properties: { fileHandle: { type: "string" }, fileName: { type: "string" }, sizeBytes: { type: "number" }, expiresAt: { type: "number" } } },
  },
  {
    id: "notes.search-request", version: 1, effect: "read", retryClass: "pure",
    modulePermission: { moduleId: MODULE_ID, access: "read", scopeInput: "scopeId" },
    inputSchema: {
      type: "object", required: ["scopeId", "requestHandle"], additionalProperties: false,
      properties: { scopeId: { type: "string" }, requestHandle: { type: "string" } },
    },
    outputSchema: {
      type: "object", required: ["matches"], additionalProperties: false,
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object", required: ["noteHandle", "fileName", "expiresAt"], additionalProperties: false,
            properties: { noteHandle: { type: "string" }, fileName: { type: "string" }, expiresAt: { type: "number" } },
          },
        },
      },
    },
  },
  {
    id: "notes.search", version: 1, effect: "read", retryClass: "pure",
    modulePermission: { moduleId: MODULE_ID, access: "read", scopeInput: "scopeId" },
    inputSchema: {
      type: "object", required: ["scopeId", "query"], additionalProperties: false,
      properties: { scopeId: { type: "string" }, query: { type: "string" } },
    },
    outputSchema: {
      type: "object", required: ["matches"], additionalProperties: false,
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object", required: ["noteHandle", "fileName", "expiresAt"], additionalProperties: false,
            properties: { noteHandle: { type: "string" }, fileName: { type: "string" }, expiresAt: { type: "number" } },
          },
        },
      },
    },
  },
  {
    id: "notes.read", version: 1, effect: "read", retryClass: "pure",
    modulePermission: { moduleId: MODULE_ID, access: "read", scopeInput: "scopeId" },
    inputSchema: {
      type: "object", required: ["scopeId", "noteHandle"], additionalProperties: false,
      properties: { scopeId: { type: "string" }, noteHandle: { type: "string" } },
    },
    outputSchema: {
      type: "object", required: ["contentHandle", "sha256", "sizeBytes", "expiresAt"], additionalProperties: false,
      properties: {
        contentHandle: { type: "string" }, sha256: { type: "string" }, sizeBytes: { type: "number" }, expiresAt: { type: "number" },
      },
    },
  },
  {
    id: "notes.create", version: 1, effect: "write", retryClass: "non_idempotent",
    modulePermission: { moduleId: MODULE_ID, access: "write", scopeInput: "scopeId" },
    inputSchema: {
      type: "object", required: ["scopeId", "relativePath", "contentHandle"], additionalProperties: false,
      properties: { scopeId: { type: "string" }, relativePath: { type: "string" }, contentHandle: { type: "string" } },
    },
    outputSchema: {
      type: "object", required: ["noteHandle", "sha256"], additionalProperties: false,
      properties: { noteHandle: { type: "string" }, sha256: { type: "string" } },
    },
  },
  {
    id: "notes.update", version: 1, effect: "write", retryClass: "non_idempotent",
    modulePermission: { moduleId: MODULE_ID, access: "write", scopeInput: "scopeId" },
    inputSchema: {
      type: "object", required: ["scopeId", "noteHandle", "contentHandle", "expectedSha256"], additionalProperties: false,
      properties: {
        scopeId: { type: "string" }, noteHandle: { type: "string" }, contentHandle: { type: "string" }, expectedSha256: { type: "string" },
      },
    },
    outputSchema: {
      type: "object", required: ["noteHandle", "sha256"], additionalProperties: false,
      properties: { noteHandle: { type: "string" }, sha256: { type: "string" } },
    },
  },
];

export class WorkflowNotesProvider implements WorkflowCapabilityProvider {
  private readonly vaultRoot: string;

  constructor(
    private readonly vault: DirectMarkdownVault,
    vaultRoot: string,
    private readonly artifacts: WorkflowNoteArtifactStore,
    private readonly permissions: WorkflowModulePermissionStore,
    private readonly files?: WorkflowFileArtifactStore,
  ) {
    this.vaultRoot = fs.realpathSync(vaultRoot);
  }

  catalog(): WorkflowCapabilityDescriptor[] {
    return CATALOG.map((item) => structuredClone(item));
  }

  async invoke(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (request.capabilityVersion !== 1) return { status: "failed", errorCode: "workflow_capability_unsupported" };
    if (request.capabilityId === "notes.search-request") return this.searchRequest(request.input);
    if (request.capabilityId === "notes.search") return this.search(request.input);
    if (request.capabilityId === "notes.read") return this.read(request.input);
    if (request.capabilityId === "notes.export_file") return this.exportFile(request.input);
    if (request.capabilityId === "notes.create") return this.create(request);
    if (request.capabilityId === "notes.update") return this.update(request);
    return { status: "failed", errorCode: "workflow_capability_unsupported" };
  }

  private async exportFile(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    if (!this.files) return { status: "failed", errorCode: "workflow_file_artifact_unavailable" };
    const scopeId = typeof input.scopeId === "string" ? input.scopeId : "";
    const noteHandle = typeof input.noteHandle === "string" ? input.noteHandle : "";
    const relativePath = this.artifacts.resolveNotePath(noteHandle);
    if (!relativePath) return { status: "failed", errorCode: "workflow_note_handle_unavailable" };
    try {
      this.resolveScope(scopeId);
      const absolutePath = path.join(this.vaultRoot, ...relativePath.split("/"));
      this.permissions.assertAllowed({ moduleId: MODULE_ID, access: "read", scopeId, absolutePath });
      const file = this.files.capture({ absolutePath, moduleId: MODULE_ID, scopeId });
      return { status: "succeeded", output: { fileHandle: file.handle, fileName: file.fileName, sizeBytes: file.sizeBytes, expiresAt: file.expiresAt } };
    } catch (error) {
      return { status: "failed", errorCode: this.errorCode(error) };
    }
  }

  private async searchRequest(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    const requestHandle = typeof input.requestHandle === "string" ? input.requestHandle : "";
    const query = this.artifacts.resolveSearchRequest(requestHandle);
    if (query === null) return { status: "failed", errorCode: "workflow_note_search_request_unavailable" };
    return this.search({ scopeId: input.scopeId, query });
  }

  private async search(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    const scopeId = typeof input.scopeId === "string" ? input.scopeId : "";
    const query = typeof input.query === "string" ? input.query : "";
    try {
      const scope = this.resolveScope(scopeId);
      this.permissions.assertAllowed({ moduleId: MODULE_ID, access: "read", scopeId, absolutePath: scope.absolutePath });
      const paths = scope.relativeDirectory
        ? await this.vault.searchForSelectionWithin(scope.relativeDirectory, query)
        : await this.vault.searchForSelection(query);
      return {
        status: "succeeded",
        output: { matches: paths.map((relativePath) => {
          const note = this.artifacts.captureNotePath(relativePath);
          return { noteHandle: note.handle, fileName: note.fileName, expiresAt: note.expiresAt };
        }) },
      };
    } catch (error) {
      return { status: "failed", errorCode: this.errorCode(error) };
    }
  }

  private async read(input: Record<string, unknown>): Promise<WorkflowCapabilityOutcome> {
    const scopeId = typeof input.scopeId === "string" ? input.scopeId : "";
    const noteHandle = typeof input.noteHandle === "string" ? input.noteHandle : "";
    const relativePath = this.artifacts.resolveNotePath(noteHandle);
    if (!relativePath) return { status: "failed", errorCode: "workflow_note_handle_unavailable" };
    try {
      this.resolveScope(scopeId);
      const absolutePath = path.join(this.vaultRoot, ...relativePath.split("/"));
      this.permissions.assertAllowed({ moduleId: MODULE_ID, access: "read", scopeId, absolutePath });
      const note = await this.vault.read(relativePath);
      const content = this.artifacts.captureContent(noteHandle, note.content);
      return {
        status: "succeeded",
        output: { contentHandle: content.handle, sha256: note.sha256, sizeBytes: content.sizeBytes, expiresAt: content.expiresAt },
      };
    } catch (error) {
      return { status: "failed", errorCode: this.errorCode(error) };
    }
  }

  private resolveScope(scopeId: string): { absolutePath: string; relativeDirectory: string } {
    const scope = this.permissions.get(MODULE_ID)?.scopes.find((candidate) => candidate.scopeId === scopeId);
    if (!scope) throw new Error("workflow_module_permission_denied");
    const absolutePath = fs.realpathSync(scope.directory);
    const relative = path.relative(this.vaultRoot, absolutePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("workflow_module_permission_denied");
    }
    return { absolutePath, relativeDirectory: relative === "" ? "" : relative.split(path.sep).join("/") };
  }

  private async create(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (!request.effectRef || !request.operationId) return { status: "failed", errorCode: "workflow_effect_context_missing" };
    const scopeId = typeof request.input.scopeId === "string" ? request.input.scopeId : "";
    const relativePath = typeof request.input.relativePath === "string" ? request.input.relativePath : "";
    const contentHandle = typeof request.input.contentHandle === "string" ? request.input.contentHandle : "";
    const content = this.artifacts.resolveContent(contentHandle);
    if (content === null) return { status: "failed", errorCode: "workflow_note_content_unavailable" };
    try {
      this.resolveScope(scopeId);
      const absolutePath = path.join(this.vaultRoot, ...relativePath.split("/"));
      this.permissions.assertAllowed({ moduleId: MODULE_ID, access: "write", scopeId, absolutePath });
      const revision = await this.vault.create(relativePath, content);
      const note = this.artifacts.captureNotePath(revision.path);
      return { status: "succeeded", output: { noteHandle: note.handle, sha256: revision.sha256 } };
    } catch (error) {
      return { status: "failed", errorCode: this.writeErrorCode(error) };
    }
  }

  private async update(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (!request.effectRef || !request.operationId) return { status: "failed", errorCode: "workflow_effect_context_missing" };
    const scopeId = typeof request.input.scopeId === "string" ? request.input.scopeId : "";
    const noteHandle = typeof request.input.noteHandle === "string" ? request.input.noteHandle : "";
    const contentHandle = typeof request.input.contentHandle === "string" ? request.input.contentHandle : "";
    const expectedSha256 = typeof request.input.expectedSha256 === "string" ? request.input.expectedSha256 : "";
    const relativePath = this.artifacts.resolveNotePath(noteHandle);
    const content = this.artifacts.resolveContent(contentHandle);
    if (!relativePath) return { status: "failed", errorCode: "workflow_note_handle_unavailable" };
    if (content === null) return { status: "failed", errorCode: "workflow_note_content_unavailable" };
    try {
      this.resolveScope(scopeId);
      const absolutePath = path.join(this.vaultRoot, ...relativePath.split("/"));
      this.permissions.assertAllowed({ moduleId: MODULE_ID, access: "write", scopeId, absolutePath });
      const revision = await this.vault.update(relativePath, content, expectedSha256);
      return { status: "succeeded", output: { noteHandle, sha256: revision.sha256 } };
    } catch (error) {
      return { status: "failed", errorCode: this.writeErrorCode(error) };
    }
  }

  private writeErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return "workflow_note_already_exists";
    if (message.startsWith("workflow_module_")) return "workflow_notes_permission_denied";
    if (message.startsWith("Markdown 已被修改")) return "workflow_notes_revision_conflict";
    return "workflow_notes_write_failed";
  }

  private errorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    return message.startsWith("workflow_module_")
      ? "workflow_notes_permission_denied"
      : "workflow_notes_read_failed";
  }
}
