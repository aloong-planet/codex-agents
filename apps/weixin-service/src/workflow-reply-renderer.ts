import type { InboundWorkflowControl } from "./conversation-service.js";
import type { WorkflowRunView, WorkflowPendingSignal } from "./workflow-engine.js";
import { shortSignalReference } from "./workflow-pending-response-coordinator.js";
import { WEIXIN_FILE_WORKFLOW_MESSAGES, WEIXIN_IMAGE_WORKFLOW_MESSAGES } from "./workflow-delivery-messages.js";

export function renderWorkflowRun(
  run: WorkflowRunView | undefined,
  pending: WorkflowPendingSignal[] = [],
): Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>> {
  if (!run) return { handled: true, outcome: "failed", reply: "工作流状态不可用，请重新发起。" };
  if (run.status === "failed" && run.errorCode === "workflow_file_resolver_retired") {
    return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.retired };
  }
  if (run.requestedWorkflowId === "notes.send-file-one-message" ||
      run.requestedWorkflowId === "notes.send-file-resolved" ||
      run.requestedWorkflowId === "weixin.send-files" ||
      run.requestedWorkflowId === "weixin.send-files-single-choice") {
    if (run.status === "succeeded") {
      return { handled: true, outcome: "succeeded", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.sent };
    }
    if (run.errorCode === "workflow_input_gate_no_candidates") {
      return { handled: true, outcome: "succeeded", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.notFound };
    }
    if (run.errorCode === "workflow_file_query_rewrite_failed" ||
        run.errorCode === "workflow_file_search_plan_invalid" ||
        run.errorCode === "workflow_file_query_unavailable" ||
        (run.errorCode === "workflow_step_timeout" && failedCapability(run, "files.resolve")) ||
        run.errorCode?.startsWith("workflow_file_resolver_")) {
      return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.searchFailed };
    }
    if (run.errorCode === "workflow_module_permission_denied" ||
        run.errorCode === "workflow_notes_permission_denied" ||
        run.errorCode === "local_file_permission_changed") {
      return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.permissionDenied };
    }
    if (run.errorCode === "local_file_content_conflict") {
      return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.fileChanged };
    }
    if (run.status === "outcome_unknown") {
      return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.sendUnknown };
    }
    if (run.errorCode === "workflow_map_partial_failure") {
      return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.sendPartial };
    }
    if (run.status === "failed" || run.status === "blocked") {
      return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.sendFailed };
    }
  }
  if (run.requestedWorkflowId === "media.send-image-one-message" ||
      run.requestedWorkflowId === "media.send-local-image-resolved" ||
      run.requestedWorkflowId === "weixin.send-local-images" ||
      run.requestedWorkflowId === "weixin.send-local-images-single-choice") {
    if (run.status === "succeeded") {
      return { handled: true, outcome: "succeeded", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.sent };
    }
    if (run.errorCode === "workflow_input_gate_no_candidates") {
      return { handled: true, outcome: "succeeded", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.notFound };
    }
    if (run.errorCode === "workflow_module_permission_denied") {
      return { handled: true, outcome: "failed", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.permissionDenied };
    }
    if (run.errorCode === "workflow_media_search_failed" || run.errorCode === "workflow_media_request_unavailable" ||
        run.errorCode === "workflow_file_query_rewrite_failed" || run.errorCode === "workflow_file_search_plan_invalid" ||
        run.errorCode === "workflow_file_query_unavailable" || run.errorCode?.startsWith("workflow_file_resolver_")) {
      return { handled: true, outcome: "failed", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.searchFailed };
    }
    if (run.errorCode === "workflow_step_timeout" && failedCapability(run, "files.resolve")) {
      return { handled: true, outcome: "failed", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.searchFailed };
    }
    if (run.status === "outcome_unknown") {
      return { handled: true, outcome: "failed", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.sendUnknown };
    }
    if (run.errorCode === "workflow_map_partial_failure") {
      return { handled: true, outcome: "failed", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.sendPartial };
    }
    if (run.status === "failed" || run.status === "blocked") {
      return { handled: true, outcome: "failed", reply: WEIXIN_IMAGE_WORKFLOW_MESSAGES.sendFailed };
    }
  }
  if (run.status === "succeeded") return { handled: true, outcome: "succeeded", reply: "工作流已完成。" };
  if (run.status === "needs_input") {
    const request = pending.find((entry) => entry.runId === run.runId);
    if (!request) return { handled: true, outcome: "needs_input", reply: "工作流还需要补充选择。" };
    const choices = request.candidates.map((candidate, index) => `${index + 1}. ${candidateLabel(candidate, index)}`).join("\n");
    const reference = shortSignalReference(request.signalRef);
    const instruction = request.selectionMode === "multiple"
      ? `可以回复一个或多个序号、候选描述，也可以直接说明取消；例如“1”“1和2”或“选择 ${reference} 1”。`
      : `请回复一个序号或一个候选描述，也可以直接说明取消；例如“1”或“选择 ${reference} 1”。`;
    return {
      handled: true,
      outcome: "needs_input",
      reply: `请选择：\n${choices}\n\n${instruction}`,
    };
  }
  if (run.status === "outcome_unknown") {
    return { handled: true, outcome: "failed", reply: "工作流结果未知，不会自动重试。" };
  }
  return { handled: true, outcome: "failed", reply: "工作流未完成，请检查设置后重新发起。" };
}

function failedCapability(run: WorkflowRunView, capabilityId: string): boolean {
  return run.plan?.steps.some((step) => step.status === "failed" && step.capabilityId === capabilityId) === true;
}

function candidateLabel(candidate: unknown, index: number): string {
  if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256) return candidate;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const fileName = (candidate as Record<string, unknown>).fileName;
    const rootName = (candidate as Record<string, unknown>).rootName;
    const relativePath = (candidate as Record<string, unknown>).relativePath;
    const displayPath = (candidate as Record<string, unknown>).displayPath ??
      (typeof rootName === "string" && rootName.length > 0 && typeof relativePath === "string" && relativePath.length > 0
        ? `${rootName}/${relativePath}`
        : relativePath);
    if (typeof fileName === "string" && fileName.length > 0 && fileName.length <= 256) {
      return typeof displayPath === "string" && displayPath.length > 0 && displayPath !== fileName
        ? `${fileName}（${displayPath}）`
        : fileName;
    }
    for (const key of ["name", "title"]) {
      const value = (candidate as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
    }
  }
  return `选项 ${index + 1}`;
}
