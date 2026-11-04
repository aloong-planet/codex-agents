import type { LocalFileSendCandidate, LocalFileSendSnapshot } from "./local-file-tools.js";
import type { WorkflowFileArtifactStore } from "./workflow-file-artifact-store.js";
import type {
  WorkflowFileSendManifest,
  WorkflowFileSendPublicCandidate,
  WorkflowFileSendStore,
} from "./workflow-file-send-store.js";
import type {
  WorkflowCapabilityDescriptor,
  WorkflowCapabilityInvocation,
  WorkflowCapabilityOutcome,
  WorkflowCapabilityProvider,
} from "./workflow-engine.js";

type TargetResolver = {
  resolveRunTarget(runId: string): { accountId: string; target: string } | null;
};

type Snapshotter = {
  snapshotCandidates(accountId: string, candidates: LocalFileSendCandidate[], target?: string): Promise<LocalFileSendSnapshot[]>;
};

const PUBLIC_CANDIDATE_SCHEMA = {
  type: "object" as const,
  required: ["candidateRef", "fileName", "displayPath", "sizeBytes", "modifiedAt"],
  additionalProperties: false,
  properties: {
    candidateRef: { type: "string" as const }, fileName: { type: "string" as const },
    displayPath: { type: "string" as const }, sizeBytes: { type: "number" as const },
    modifiedAt: { type: "number" as const },
  },
};

const CATALOG: WorkflowCapabilityDescriptor[] = [
  {
    id: "files.load_send_manifest", version: 1, effect: "read", retryClass: "pure",
    inputSchema: {
      type: "object", required: ["manifestHandle"], additionalProperties: false,
      properties: { manifestHandle: { type: "string" } },
    },
    outputSchema: {
      type: "object", required: ["candidates", "preselected"], additionalProperties: false,
      properties: {
        candidates: { type: "array", maxItems: 20, items: PUBLIC_CANDIDATE_SCHEMA },
        preselected: { type: "array", maxItems: 20, items: PUBLIC_CANDIDATE_SCHEMA },
      },
    },
  },
  {
    id: "files.prepare_send_selection", version: 1, effect: "read", retryClass: "pure",
    inputSchema: {
      type: "object", required: ["manifestHandle", "selection"], additionalProperties: false,
      properties: { manifestHandle: { type: "string" }, selection: {} },
    },
    outputSchema: {
      type: "object", required: ["items"], additionalProperties: false,
      properties: {
        items: {
          type: "array", maxItems: 20,
          items: {
            type: "object", required: ["fileHandle"], additionalProperties: false,
            properties: { fileHandle: { type: "string" } },
          },
        },
      },
    },
  },
];

export class WorkflowFileSendProvider implements WorkflowCapabilityProvider {
  constructor(
    private readonly manifests: WorkflowFileSendStore,
    private readonly files: WorkflowFileArtifactStore,
    private readonly snapshotter: Snapshotter,
    private readonly targets: TargetResolver,
  ) {}

  catalog(): WorkflowCapabilityDescriptor[] {
    return CATALOG.map((descriptor) => structuredClone(descriptor));
  }

  async invoke(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    if (request.capabilityId === "files.load_send_manifest" && request.capabilityVersion === 1) {
      return this.load(request);
    }
    if (request.capabilityId === "files.prepare_send_selection" && request.capabilityVersion === 1) {
      return this.prepare(request);
    }
    return { status: "failed", errorCode: "workflow_capability_unsupported" };
  }

  private load(request: WorkflowCapabilityInvocation): WorkflowCapabilityOutcome {
    const bound = this.boundManifest(request);
    if (!bound) return { status: "failed", errorCode: "workflow_file_send_manifest_unavailable" };
    const candidates = this.manifests.publicCandidates(bound.manifest);
    const selected = new Set(bound.manifest.preselectedRefs);
    return {
      status: "succeeded",
      output: { candidates, preselected: candidates.filter((candidate) => selected.has(candidate.candidateRef)) },
    };
  }

  private async prepare(request: WorkflowCapabilityInvocation): Promise<WorkflowCapabilityOutcome> {
    const bound = this.boundManifest(request);
    if (!bound) return { status: "failed", errorCode: "workflow_file_send_manifest_unavailable" };
    const selection = normalizeSelection(request.input.selection);
    if (!selection || selection.length < 1 || selection.length > 20 ||
        (!bound.manifest.allowMultiple && selection.length !== 1)) {
      return { status: "failed", errorCode: "workflow_file_send_selection_invalid" };
    }
    try {
      const selected = selection.map((publicCandidate) => {
        const candidate = bound.manifest.candidates.find((entry) =>
          canonicalPublic(entry) === canonicalPublic(publicCandidate));
        if (!candidate) throw new Error("workflow_file_send_selection_invalid");
        return candidate;
      });
      const missing = selected.filter((candidate) => !candidate.snapshotHandle);
      if (missing.length > 0) {
        const snapshots = await this.snapshotter.snapshotCandidates(
          bound.target.accountId,
          missing.map((candidate) => candidate.source),
          bound.target.target,
        );
        const committed = missing.map((candidate, index) => ({
          candidateRef: candidate.candidateRef,
          snapshotHandle: this.files.captureSnapshot({
            absolutePath: snapshots[index]!.snapshotPath,
            fileName: snapshots[index]!.fileName,
            sha256: snapshots[index]!.sha256,
            sizeBytes: snapshots[index]!.sizeBytes,
          }).handle,
        }));
        bound.manifest = this.manifests.commitSnapshots(
          bound.handle,
          bound.target.accountId,
          bound.target.target,
          committed,
        );
      }
      const items = selection.map((entry) => {
        const candidate = bound.manifest.candidates.find((item) => item.candidateRef === entry.candidateRef);
        if (!candidate?.snapshotHandle || !this.files.resolve(candidate.snapshotHandle)) {
          throw new Error("workflow_file_snapshot_unavailable");
        }
        return { fileHandle: candidate.snapshotHandle };
      });
      return { status: "succeeded", output: { items } };
    } catch (error) {
      const code = error instanceof Error && /^workflow_file_[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : error instanceof Error && /^local_file_[a-z0-9_]+$/u.test(error.message)
          ? error.message
          : "workflow_file_snapshot_failed";
      return { status: "failed", errorCode: code };
    }
  }

  private boundManifest(request: WorkflowCapabilityInvocation): {
    handle: string;
    target: { accountId: string; target: string };
    manifest: WorkflowFileSendManifest;
  } | null {
    const target = this.targets.resolveRunTarget(request.runId);
    const handle = typeof request.input.manifestHandle === "string" ? request.input.manifestHandle : "";
    if (!target || !handle) return null;
    const manifest = this.manifests.resolve(handle, target.accountId, target.target);
    return manifest ? { handle, target, manifest } : null;
  }
}

function normalizeSelection(value: unknown): WorkflowFileSendPublicCandidate[] | null {
  const list = Array.isArray(value) ? value : [value];
  if (list.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) return null;
  return structuredClone(list as WorkflowFileSendPublicCandidate[]);
}

function canonicalPublic(value: WorkflowFileSendPublicCandidate): string {
  return JSON.stringify({
    candidateRef: value.candidateRef,
    fileName: value.fileName,
    displayPath: value.displayPath,
    sizeBytes: value.sizeBytes,
    modifiedAt: value.modifiedAt,
  });
}
