import type { InboundContent as InboundTextEvent } from "./channel-contract.js";
import { settleCleanup } from "./async-cleanup.js";
import type { WorkflowPendingSignal, WorkflowRunView } from "./workflow-engine.js";
import type {
  WorkflowFileArtifactStore,
} from "./workflow-file-artifact-store.js";
import type { LocalFileSendCandidate, LocalFileSendSnapshot } from "./local-file-tools.js";
import type { WorkflowFileSendStore } from "./workflow-file-send-store.js";
import {
  MEDIA_SEND_IMAGE_WORKFLOW,
} from "./workflow-media-send-intent.js";
import {
  WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW,
  WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW,
  WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW,
  WEIXIN_SEND_FILES_WORKFLOW,
} from "./workflow-file-send-intent.js";
import type { WorkflowJsonValue } from "./workflow-gateway.js";
import type { PendingPresentationStore } from "./workflow-pending-response-coordinator.js";
import { pendingRequestTextHash } from "./workflow-pending-response-coordinator.js";
import type { WorkflowToolRegistration, WorkflowToolReplyProjector } from "./workflow-tool-gateway.js";
import type { TrustedWorkflowTurn, WorkflowToolHost, WorkflowToolTurnBinding } from "./workflow-tool-host.js";
import { renderWorkflowRun } from "./workflow-reply-renderer.js";

export const MAIN_WEIXIN_DISABLED_FEATURES = ["shell_tool", "unified_exec"] as const;

type MediaRequestBindingStore = {
  captureFromTool(triggerId: string, input: Record<string, WorkflowJsonValue>): string;
};

type MediaTurnEvidenceStore = {
  prepareForToolTurn(event: InboundTextEvent): void;
  release(triggerId: string): void;
};

type PendingWorkflowView = {
  listPendingSignals(accountRef: string, targetRef: string): WorkflowPendingSignal[];
};

type OriginalTextResolver = {
  resolveQuery(handle: string): string | null;
};

type LocalFileTurnControl = {
  bindTurn(trusted: TrustedWorkflowTurn): { promptLines: string[]; release(): Promise<void> | void };
};

type LocalFileSendControl = {
  describeForSend(trusted: TrustedWorkflowTurn, fileRefs: string[]): LocalFileSendCandidate[];
  snapshotForSend(trusted: TrustedWorkflowTurn, fileRefs: string[]): Promise<LocalFileSendSnapshot[]>;
};

type DirectLocalMediaBinding = {
  localFiles: LocalFileSendControl;
  files: Pick<WorkflowFileArtifactStore, "captureSnapshot">;
  manifests: Pick<WorkflowFileSendStore, "capture">;
};

export function createWorkflowToolReplyProjector(
  engine: PendingWorkflowView,
  presentations: PendingPresentationStore,
  now: () => number,
  originalText?: OriginalTextResolver,
): WorkflowToolReplyProjector {
  return (runValue: unknown, trusted: TrustedWorkflowTurn) => {
    const run = runValue as WorkflowRunView | undefined;
    const pending = engine.listPendingSignals(trusted.accountId, trusted.target)
      .filter((request) => request.expiresAt > now());
    const rendered = renderWorkflowRun(run, pending);
    if (!rendered.handled) throw new Error("workflow_tool_reply_unavailable");
    const outcome = rendered.outcome === "succeeded"
      ? "accepted" as const
      : rendered.outcome === "needs_input"
        ? "needs_input" as const
        : run?.status === "outcome_unknown"
          ? "unknown" as const
          : run?.status === "blocked"
            ? "blocked" as const
            : run?.status === "waiting_external"
              ? "waiting_external" as const
              : "rejected" as const;
    if (outcome !== "needs_input" || !run) return { outcome, reply: rendered.reply };
    const request = pending.find((candidate) => candidate.runId === run.runId);
    const userText = originalText?.resolveQuery(trusted.originalTextRef);
    if (!request || userText === null || userText === undefined) throw new Error("workflow_pending_presentation_unavailable");
    return {
      outcome,
      reply: rendered.reply,
      onAccepted: () => presentations.put({
        accountRef: trusted.accountId,
        targetRef: trusted.target,
        runId: run.runId,
        signalRef: request.signalRef,
        revision: request.revision,
        requestTextHash: pendingRequestTextHash(userText),
        expiresAt: request.expiresAt,
        acceptedAt: now(),
      }),
    };
  };
}

export function createMediaSendToolRegistration(
  requests: MediaRequestBindingStore,
  directLocal: DirectLocalMediaBinding,
): WorkflowToolRegistration {
  return {
    toolId: "media.send",
    toolVersion: 1,
    templateId: "media.send-image",
    workflowIds: [
      MEDIA_SEND_IMAGE_WORKFLOW.id,
      WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW.id,
      WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW.id,
    ],
    resolveWorkflowId: ({ arguments: input }) => {
      if (mediaArguments(input).source !== "local") return MEDIA_SEND_IMAGE_WORKFLOW.id;
      const send = sendFilesArguments(input);
      return send.disposition === "needs_choice" && !send.allowMultiple
        ? WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW.id
        : WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW.id;
    },
    bindInputRefs: ({ arguments: input, trusted }) => {
      const argumentsRecord = mediaArguments(input);
      if (argumentsRecord.source === "local") {
        return captureSendManifest(argumentsRecord, trusted, directLocal.localFiles, directLocal.files, directLocal.manifests);
      }
      return { mediaRequest: requests.captureFromTool(trusted.eventKey, argumentsRecord) };
    },
  };
}

export function createWeixinSendFilesToolRegistration(
  localFiles: LocalFileSendControl,
  files: Pick<WorkflowFileArtifactStore, "captureSnapshot">,
  manifests: Pick<WorkflowFileSendStore, "capture">,
): WorkflowToolRegistration {
  return {
    toolId: "weixin.send_files",
    toolVersion: 1,
    templateId: WEIXIN_SEND_FILES_WORKFLOW.id,
    workflowIds: [WEIXIN_SEND_FILES_WORKFLOW.id, WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW.id],
    resolveWorkflowId: ({ arguments: value }) => {
      const input = sendFilesArguments(value);
      return input.disposition === "needs_choice" && !input.allowMultiple
        ? WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW.id
        : WEIXIN_SEND_FILES_WORKFLOW.id;
    },
    bindInputRefs: ({ arguments: value, trusted }) =>
      captureSendManifest(value, trusted, localFiles, files, manifests),
  };
}

async function captureSendManifest(
  value: unknown,
  trusted: TrustedWorkflowTurn,
  localFiles: LocalFileSendControl,
  files: Pick<WorkflowFileArtifactStore, "captureSnapshot">,
  manifests: Pick<WorkflowFileSendStore, "capture">,
): Promise<{ sendManifest: string }> {
  const input = sendFilesArguments(value);
  const refs = input.disposition === "selected" ? input.fileRefs : input.candidateRefs;
  const candidates = localFiles.describeForSend(trusted, refs);
  if (input.disposition === "needs_choice") {
    return {
      sendManifest: manifests.capture({
        accountRef: trusted.accountId,
        targetRef: trusted.target,
        eventKey: trusted.eventKey,
        allowMultiple: input.allowMultiple,
        selected: false,
        candidates: candidates.map((source) => ({ source })),
      }).handle,
    };
  }
  const snapshots = await localFiles.snapshotForSend(trusted, refs);
  const captured = snapshots.map((snapshot) => files.captureSnapshot({
    absolutePath: snapshot.snapshotPath,
    fileName: snapshot.fileName,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.sizeBytes,
  }).handle);
  return {
    sendManifest: manifests.capture({
      accountRef: trusted.accountId,
      targetRef: trusted.target,
      eventKey: trusted.eventKey,
      allowMultiple: true,
      selected: true,
      candidates: candidates.map((source, index) => ({ source, snapshotHandle: captured[index]! })),
    }).handle,
  };
}

export class WorkflowToolProductionControl {
  private readonly activeBindings = new Set<string>();
  constructor(
    private readonly host: Pick<WorkflowToolHost, "bind" | "contractHash">,
    private readonly fileArtifacts: Pick<WorkflowFileArtifactStore, "captureQuery" | "deleteQuery">,
    private readonly mediaRequests?: MediaTurnEvidenceStore,
    private readonly localFiles?: LocalFileTurnControl,
  ) {}

  contractHash(): string {
    return this.host.contractHash();
  }

  async bind(threadId: string, event: InboundTextEvent): Promise<WorkflowToolTurnBinding> {
    if (this.activeBindings.has(threadId)) throw new Error("workflow_tool_turn_already_bound");
    const hasAttachments = (event.attachments?.length ?? 0) + (event.quote?.attachments.length ?? 0) > 0;
    const originalText = this.fileArtifacts.captureQuery(event.key, event.text, { allowEmpty: hasAttachments });
    this.activeBindings.add(threadId);
    const trusted: TrustedWorkflowTurn = {
      eventKey: event.key,
      accountId: event.accountId,
      target: event.target,
      occurredAt: event.receivedAt,
      originalTextRef: originalText.handle,
      attachmentRefs: [],
    };
    let binding: WorkflowToolTurnBinding;
    let localBinding: ReturnType<LocalFileTurnControl["bindTurn"]> | undefined;
    try {
      this.mediaRequests?.prepareForToolTurn(event);
      localBinding = this.localFiles?.bindTurn(trusted);
      binding = this.host.bind(threadId, trusted);
    } catch (error) {
      const errors = [error];
      for (const release of [
        () => localBinding?.release(),
        () => this.mediaRequests?.release(event.key),
        () => this.fileArtifacts.deleteQuery(originalText.handle),
      ]) {
        try { await release(); } catch (cleanupError) { errors.push(cleanupError); }
      }
      if (errors.length === 1) {
        this.activeBindings.delete(threadId);
        throw error;
      }
      throw new AggregateError(errors, "workflow_tool_binding_cleanup_failed");
    }
    let releasing: Promise<void> | undefined;
    return {
      ...(localBinding ? { promptLines: [...localBinding.promptLines] } : {}),
      snapshot: binding.snapshot,
      seal: binding.seal,
      drain: binding.drain,
      ...(binding.resume ? { resume: binding.resume } : {}),
      ...(binding.recoveryBlocked ? { recoveryBlocked: binding.recoveryBlocked } : {}),
      release: () => releasing ??= (async () => {
        await binding.drain();
        const snapshot = binding.snapshot();
        try { await settleCleanup([
          () => binding.release(),
          () => localBinding?.release(),
          () => this.mediaRequests?.release(event.key),
          () => { if (snapshot.owner === "model") this.fileArtifacts.deleteQuery(originalText.handle); },
        ]); } catch (error) { throw new AggregateError([error], "workflow_tool_release_failed"); }
        this.activeBindings.delete(threadId);
      })(),
    };
  }
}

function mediaArguments(value: unknown): Record<string, WorkflowJsonValue> & { source: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).source !== "string") {
    throw new Error("workflow_media_tool_arguments_invalid");
  }
  return value as Record<string, WorkflowJsonValue> & { source: string };
}

type SendFilesArguments =
  | { disposition: "selected"; fileRefs: string[] }
  | { disposition: "needs_choice"; candidateRefs: string[]; allowMultiple: boolean };

function sendFilesArguments(value: unknown): SendFilesArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow_file_send_arguments_invalid");
  const input = value as Record<string, unknown>;
  if (input.disposition === "selected" && Array.isArray(input.fileRefs) &&
      input.fileRefs.every((ref) => typeof ref === "string")) {
    return { disposition: "selected", fileRefs: [...input.fileRefs] as string[] };
  }
  if (input.disposition === "needs_choice" && Array.isArray(input.candidateRefs) &&
      input.candidateRefs.every((ref) => typeof ref === "string") && typeof input.allowMultiple === "boolean") {
    return {
      disposition: "needs_choice",
      candidateRefs: [...input.candidateRefs] as string[],
      allowMultiple: input.allowMultiple,
    };
  }
  throw new Error("workflow_file_send_arguments_invalid");
}
