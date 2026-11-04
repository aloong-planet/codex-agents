import type { InboundContent as InboundTextEvent } from "./channel-contract.js";
import type { InboundWorkflowControl } from "./conversation-service.js";
import { renderWorkflowRun } from "./workflow-reply-renderer.js";
export { renderWorkflowRun } from "./workflow-reply-renderer.js";
import type {
  PendingPresentationStore,
  PendingResponseResult,
  PendingResponseRouter,
} from "./workflow-pending-response-coordinator.js";
import {
  PendingResponseCoordinator,
  pendingRequestTextHash,
} from "./workflow-pending-response-coordinator.js";
import type {
  WorkflowPendingCancellation,
  WorkflowPendingSignal,
  WorkflowRunView,
  WorkflowSignal,
  WorkflowSignalReceipt,
} from "./workflow-engine.js";
import type {
  IntentProposal,
  WorkflowGatewayInput,
  WorkflowGatewayResult,
} from "./workflow-gateway.js";
import type {
  WorkflowPlannerDiagnostic,
  WorkflowPlannerDiagnosticObserver,
  WorkflowIntentPlannerInput,
  WorkflowIntentSummary,
} from "./workflow-intent-planner.js";
import {
  workflowShadowTriggerKeyHash,
  type WorkflowShadowObservation,
} from "./workflow-shadow-store.js";

export interface WorkflowSignalEnginePort {
  listPendingSignals(accountRef: string, targetRef: string): WorkflowPendingSignal[];
  supersedePendingSignals?(accountRef: string, targetRef: string): string[];
  signal(signal: WorkflowSignal): Promise<WorkflowSignalReceipt>;
  cancelPending?(input: WorkflowPendingCancellation): Promise<WorkflowSignalReceipt>;
  get(runId: string): WorkflowRunView | undefined;
}

export interface WorkflowIntentPlannerPort {
  plan(input: WorkflowIntentPlannerInput, onDiagnostic?: WorkflowPlannerDiagnosticObserver): Promise<IntentProposal>;
}

export interface WorkflowGatewayPort {
  submit(input: WorkflowGatewayInput): Promise<WorkflowGatewayResult>;
}

export interface WorkflowShadowObserver {
  observe(input: WorkflowShadowObservation): Promise<void> | void;
}

export type ConversationWorkflowTriggerAdapterOptions = {
  engine: WorkflowSignalEnginePort;
  candidateIntents?: (event: InboundTextEvent) => WorkflowIntentSummary[];
  planner?: WorkflowIntentPlannerPort;
  gateway?: WorkflowGatewayPort;
  shadowObserver?: WorkflowShadowObserver;
  localDate?: (at: number) => string;
  timeZone?: string;
  now?: () => number;
  pendingResponseRouter?: PendingResponseRouter;
  pendingPresentations?: PendingPresentationStore;
};

export class ConversationWorkflowTriggerAdapter implements InboundWorkflowControl {
  private readonly pendingResponses: PendingResponseCoordinator;

  constructor(private readonly options: ConversationWorkflowTriggerAdapterOptions) {
    const routingParts = [options.candidateIntents, options.planner, options.gateway].filter(Boolean).length;
    if (routingParts !== 0 && routingParts !== 3) throw new Error("workflow_trigger_adapter_configuration_invalid");
    this.pendingResponses = new PendingResponseCoordinator({
      engine: options.engine,
      ...(options.pendingResponseRouter ? { router: options.pendingResponseRouter } : {}),
      ...(options.pendingPresentations ? { presentations: options.pendingPresentations } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async tryHandle(event: InboundTextEvent): ReturnType<InboundWorkflowControl["tryHandle"]> {
    try {
      const pending = await this.pendingResponses.handle({
        trustedTurn: {
          eventKey: event.key,
          accountRef: event.accountId,
          targetRef: event.target,
          occurredAt: event.receivedAt,
        },
        userText: event.text,
      });
      if (pending.owner === "workflow") {
        if (pending.kind === "resumed" || pending.kind === "redisplay") {
          const current = this.currentPending(event);
          return this.renderRunForEvent(event, pending.run, current);
        }
        if (pending.kind === "cancelled") {
          return { handled: true, outcome: "succeeded", reply: "已取消之前的操作。" };
        }
        if (pending.kind === "refresh") return this.bindPresentation(event, renderPendingRefresh(pending), pending.presentation);
        return renderPendingClarification(pending.reason);
      }
      return this.tryStartWorkflow(event, "kind" in pending && pending.kind === "new_goal" ? pending.goal : undefined);
    } catch (error) {
      return renderSignalError(error);
    }
  }

  async tryHandlePending(event: InboundTextEvent): ReturnType<NonNullable<InboundWorkflowControl["tryHandlePending"]>> {
    try {
      const pending = await this.pendingResponses.handle({
        trustedTurn: {
          eventKey: event.key,
          accountRef: event.accountId,
          targetRef: event.target,
          occurredAt: event.receivedAt,
        },
        userText: event.text,
      });
      if (pending.owner === "chat") {
        if ("kind" in pending && pending.kind === "new_goal") this.supersedeCurrentPending(event);
        return { handled: false };
      }
      if (pending.kind === "resumed" || pending.kind === "redisplay") {
        return this.renderRunForEvent(event, pending.run, this.currentPending(event));
      }
      if (pending.kind === "cancelled") {
        return { handled: true, outcome: "succeeded", reply: "已取消之前的操作。" };
      }
      if (pending.kind === "refresh") return this.bindPresentation(event, renderPendingRefresh(pending), pending.presentation);
      return renderPendingClarification(pending.reason);
    } catch (error) {
      return renderSignalError(error);
    }
  }

  private async tryStartWorkflow(
    event: InboundTextEvent,
    openGoal?: string,
  ): ReturnType<InboundWorkflowControl["tryHandle"]> {
    const { candidateIntents, planner, gateway } = this.options;
    if (!candidateIntents || !planner || !gateway) return { handled: false };
    let pendingSuperseded = false;
    if (openGoal !== undefined) {
      this.supersedeCurrentPending(event);
      pendingSuperseded = true;
    }
    const planningEvent = openGoal === undefined ? event : { ...event, text: openGoal };
    const candidates = candidateIntents(planningEvent);
    if (candidates.length === 0) return { handled: false };
    const plannerDiagnostics: WorkflowPlannerDiagnostic[] = [];
    try {
      const proposal = await planner.plan({
        currentMessage: openGoal ?? event.text,
        localDate: this.options.localDate?.(event.receivedAt) ?? localDate(event.receivedAt, this.options.timeZone),
        timeZone: this.options.timeZone ?? "Asia/Shanghai",
        candidateIntents: candidates,
      }, (diagnostic) => plannerDiagnostics.push(diagnostic));
      if (proposal.disposition === "ordinary_chat") {
        return withPlannerDiagnostics({ handled: false }, plannerDiagnostics);
      }
      if (!pendingSuperseded) this.supersedeCurrentPending(event);
      if (proposal.disposition === "needs_clarification") {
        return withPlannerDiagnostics(
          { handled: true, outcome: "needs_input", reply: "请补充完成这项操作所需的信息。" },
          plannerDiagnostics,
        );
      }
      const routed = await gateway.submit({
        protocolVersion: 1,
        proposal,
        trusted: {
          triggerId: event.key,
          source: "weixin",
          occurredAt: event.receivedAt,
          accountRef: event.accountId,
          targetRef: event.target,
        },
      });
      if (routed.owner === "shadow") {
        try {
          await this.options.shadowObserver?.observe({
            triggerKeyHash: workflowShadowTriggerKeyHash(event.key),
            intent: proposal.intent!,
            intentVersion: proposal.intentVersion!,
            workflowId: routed.workflowId,
            confidence: proposal.confidence,
            slotKeys: Object.keys(proposal.slots).sort(),
          });
        } catch {
          // Shadow telemetry cannot take reply or side-effect ownership from the legacy path.
        }
        return withPlannerDiagnostics({ handled: false }, plannerDiagnostics);
      }
      if (routed.owner !== "workflow") return withPlannerDiagnostics({ handled: false }, plannerDiagnostics);
      const run = this.options.engine.get(routed.submission.runId);
      const now = this.options.now?.() ?? Date.now();
      const pending = this.options.engine
        .listPendingSignals(event.accountId, event.target)
        .filter((request) => request.expiresAt > now);
      return withPlannerDiagnostics(this.renderRunForEvent(event, run, pending), plannerDiagnostics);
    } catch (error) {
      const timeout = error instanceof Error && error.message === "workflow_planner_timeout";
      return withPlannerDiagnostics({
        handled: true,
        outcome: "failed",
        reply: timeout
          ? "请求理解超时，尚未开始查找或发送任何内容，请稍后重试。"
          : "工作流未能安全启动，请稍后重新发起。",
      }, plannerDiagnostics);
    }
  }

  private supersedeCurrentPending(event: InboundTextEvent): void {
    const pending = this.options.engine.listPendingSignals(event.accountId, event.target)
      .filter((request) => request.expiresAt > (this.options.now?.() ?? Date.now()));
    if (pending.length === 0) return;
    if (!this.options.engine.supersedePendingSignals) {
      throw new Error("workflow_pending_supersede_unavailable");
    }
    this.options.engine.supersedePendingSignals(event.accountId, event.target);
  }

  private currentPending(event: InboundTextEvent): WorkflowPendingSignal[] {
    const now = this.options.now?.() ?? Date.now();
    return this.options.engine.listPendingSignals(event.accountId, event.target)
      .filter((request) => request.expiresAt > now);
  }

  private renderRunForEvent(
    event: InboundTextEvent,
    run: WorkflowRunView | undefined,
    pending: WorkflowPendingSignal[],
  ): Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>> {
    const rendered = renderWorkflowRun(run, pending);
    return this.bindPresentation(event, rendered, pending.find((entry) => entry.runId === run?.runId));
  }

  private bindPresentation(
    event: InboundTextEvent,
    rendered: Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>>,
    request: Pick<WorkflowPendingSignal, "runId" | "signalRef" | "revision" | "expiresAt"> | undefined,
  ): Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>> {
    if (!rendered.handled || rendered.outcome !== "needs_input" || !request || !this.options.pendingPresentations) {
      return rendered;
    }
    return {
      ...rendered,
      onAccepted: () => this.options.pendingPresentations!.put({
        accountRef: event.accountId,
        targetRef: event.target,
        runId: request.runId,
        signalRef: request.signalRef,
        revision: request.revision,
        requestTextHash: pendingRequestTextHash(event.text),
        expiresAt: request.expiresAt,
        acceptedAt: this.options.now?.() ?? Date.now(),
      }),
    };
  }
}

function withPlannerDiagnostics<T extends Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>>>(
  result: T,
  diagnostics: WorkflowPlannerDiagnostic[],
): T {
  return diagnostics.length === 0
    ? result
    : { ...result, plannerDiagnostics: diagnostics };
}

export { shortSignalReference } from "./workflow-pending-response-coordinator.js";


function localDate(at: number, timeZone = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function renderSignalError(error: unknown): Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>> {
  const code = error instanceof Error ? error.message : "workflow_signal_failed";
  if (code === "workflow_signal_expired" || code === "workflow_signal_request_unavailable" ||
      code === "workflow_signal_request_closed") {
    return { handled: true, outcome: "failed", reply: "这次待选内容已失效，请重新发起。" };
  }
  if (code === "workflow_signal_selection_invalid" || code === "workflow_signal_revision_mismatch") {
    return { handled: true, outcome: "needs_input", reply: "待选内容已经变化，请按最新提示重新选择。" };
  }
  return { handled: true, outcome: "failed", reply: "工作流选择未能处理，请重新发起。" };
}

function renderPendingClarification(
  reason: "request_closed" | "request_not_unique" | "multiple_requests" | "selection_invalid" |
    "semantic_ambiguous" | "stale",
): Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>> {
  if (reason === "request_closed") {
    return { handled: true, outcome: "failed", reply: "之前的待选任务已经结束，请重新发起。" };
  }
  if (reason === "request_not_unique") {
    return { handled: true, outcome: "needs_input", reply: "没有找到唯一对应的待选工作流，请使用提示中的引用重新选择。" };
  }
  if (reason === "multiple_requests") {
    return { handled: true, outcome: "needs_input", reply: "有多个工作流等待选择，请带上提示中的引用。" };
  }
  if (reason === "selection_invalid") {
    return { handled: true, outcome: "needs_input", reply: "选择序号不在候选范围内，请按提示重新选择。" };
  }
  if (reason === "stale") {
    return { handled: true, outcome: "needs_input", reply: "待选内容已经变化，请按最新提示重新选择。" };
  }
  return { handled: true, outcome: "needs_input", reply: "我还不能唯一确定你的选择，请回复候选序号。" };
}

function renderPendingRefresh(
  refresh: Extract<PendingResponseResult, { owner: "workflow"; kind: "refresh" }>,
): Awaited<ReturnType<InboundWorkflowControl["tryHandle"]>> {
  const latestChoices = renderLatestChoices(refresh.choices);
  if (refresh.reason === "selection_scope_changed") {
    return {
      handled: true,
      outcome: "needs_input",
      reply: "我没有继续执行，因为候选列表已经更新，无法确认你说的“都要”是否包含变化后的项目。\n\n" +
        `${latestChoices}\n\n请重新回复序号，或者再次回复“都要”。`,
    };
  }
  if (refresh.reason === "selected_missing") {
    return {
      handled: true,
      outcome: "needs_input",
      reply: `我没有继续执行，因为你刚才选择的${quotedLabels(refresh.selectedLabels)}已不在当前结果中。\n\n` +
        `${latestChoices}\n\n请重新选择。`,
    };
  }
  if (refresh.reason === "selected_changed") {
    return {
      handled: true,
      outcome: "needs_input",
      reply: `我没有继续执行，因为你刚才选择的${quotedLabels(refresh.selectedLabels)}内容已经更新。\n\n` +
        `${latestChoices}\n\n请确认后重新选择。`,
    };
  }
  if (refresh.reason === "request_replaced") {
    return {
      handled: true,
      outcome: "needs_input",
      reply: `我没有继续执行，因为当前待选内容已经换成新的列表。\n\n${latestChoices}\n\n请按新列表选择。`,
    };
  }
  if (refresh.reason === "request_expired") {
    return { handled: true, outcome: "failed", reply: "我没有继续执行，因为刚才的候选已经过期。请重新发起这项操作。" };
  }
  return { handled: true, outcome: "failed", reply: "我没有继续执行，因为刚才的操作已经结束。" };
}

function renderLatestChoices(choices: string[]): string {
  if (choices.length === 0) return "当前没有可选项目。";
  const visible = choices.slice(0, 20).map((choice, index) => `${index + 1}. ${choice}`).join("\n");
  const remaining = choices.length - 20;
  return `现在可选：\n${visible}${remaining > 0 ? `\n另有 ${remaining} 项` : ""}`;
}

function quotedLabels(labels: string[]): string {
  const visible = labels.slice(0, 3).map((label) => `「${label}」`).join("、");
  return visible || "项目";
}
