import type { AppServerMessage } from "./codex-app-server-client.js";
import { CodexConversationClient, type ServerRequestHandle } from "./codex-conversation-client.js";
import type { DynamicToolHost } from "./dynamic-tool-host.js";
import type { CodexTurnObserver, CodexTurnEvent, SafeToolLabel, TurnPermissionGuard } from "./codex-conversation.js";
import type { CodexUserInput } from "./codex-conversation.js";
import type { WorkflowHandoffReceipt, WorkflowToolTurnBinding, WorkflowToolTurnSnapshot } from "./workflow-tool-host.js";
import { modelTurnError } from "./model-recovery.js";

export type AppServerTurnResult<Receipt = WorkflowHandoffReceipt> =
  | { owner: "model_owned"; finalText: string }
  | { owner: "workflow_owned"; receipt: Receipt };

export type PreparedAppServerTurn = { input: CodexUserInput[]; binding?: WorkflowToolTurnBinding };
export interface AppServerTurnAdapter { prepare(): Promise<PreparedAppServerTurn>; }

/** Protocol failure remains a failure, independently of durable workflow ownership. */
export class AppServerTurnFailure extends Error {
  constructor(cause: Error, readonly ownership: WorkflowToolTurnSnapshot) {
    super(cause.message, { cause });
    this.name = "AppServerTurnFailure";
  }
}

type CompletedAgentMessage = {
  type?: unknown;
  phase?: unknown;
  text?: unknown;
};

class FinalReply<Receipt = unknown> {
  private readonly finalAnswers: string[] = [];
  private readonly unphasedAnswers: string[] = [];
  private workflowReceipt: Receipt | undefined;

  observeCompletedItem(item: CompletedAgentMessage): void {
    if (item.type !== "agentMessage" || typeof item.text !== "string") return;
    const text = item.text.trim();
    if (!text) return;
    if (item.phase === "final_answer") {
      this.finalAnswers.push(text);
      return;
    }
    if (item.phase === undefined || item.phase === null) this.unphasedAnswers.push(text);
  }

  claimWorkflow(receipt: Receipt): void {
    this.workflowReceipt = receipt;
  }

  complete(allowEmptyModelReply = false): AppServerTurnResult<Receipt> {
    if (this.workflowReceipt !== undefined) {
      return { owner: "workflow_owned", receipt: this.workflowReceipt };
    }
    const finalText = this.finalAnswers.at(-1) ?? this.unphasedAnswers.at(-1) ?? "";
    if (!finalText && !allowEmptyModelReply) {
      throw new Error("Codex turn 已完成但没有权威文本回复");
    }
    return { owner: "model_owned", finalText };
  }
}

const TURN_PROGRESS_NOTIFICATION_METHODS = new Set([
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
]);

type ActiveTurn = {
  threadId: string;
  turnId: string | null;
  driver: FinalReply<boolean>;
  resolve: (reply: AppServerTurnResult) => void;
  reject: (error: Error) => void;
  terminal: Promise<void>;
  settleTerminal: () => void;
  timer: NodeJS.Timeout | null;
  onProgress?: CodexTurnObserver;
  turnAcceptedReported: boolean;
  permissionGuardCompleted: boolean;
  reportedAgentMessageIds: Set<string>;
  requests: Set<Promise<void>>;
  ending: boolean;
  failure?: Error;
  terminalStatus?: "failed" | "interrupted" | "unknown";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}


/** Owns one protocol turn; App Server still owns the agent/tool decision loop. */
export class AppServerTurnDriver {
  private readonly active: ActiveTurn;
  private readonly completion: Promise<AppServerTurnResult>;
  private startConfirmed = false;
  private completionReceived = false;
  private started = false;
  private settled = false;
  private submitted = false;
  private preparation?: Promise<void>;
  private binding: WorkflowToolTurnBinding | undefined;
  permissionCleanupFailed = false;
  bindingCleanupFailed = false;

  constructor(
    private readonly client: CodexConversationClient,
    threadId: string,
    private readonly dynamicTools?: DynamicToolHost,
    private readonly permissionGuard?: TurnPermissionGuard,
    private readonly turnIdleTimeoutMs: number | null = 300_000,
    private readonly options: { allowEmptyReply?: boolean; onProgress?: CodexTurnObserver; retiredTurnIds?: Set<string>; onFailure?: (error: Error) => void } = {},
  ) {
    let resolve!: (reply: AppServerTurnResult) => void;
    let reject!: (error: Error) => void;
    let settleTerminal!: () => void;
    this.completion = new Promise<AppServerTurnResult>((yes, no) => { resolve = yes; reject = no; });
    void this.completion.catch(() => {});
    const terminal = new Promise<void>((done) => { settleTerminal = done; });
    this.active = {
      threadId, turnId: null, driver: new FinalReply<boolean>(), resolve, reject,
      terminal, settleTerminal, timer: null, turnAcceptedReported: false,
      permissionGuardCompleted: false, reportedAgentMessageIds: new Set(),
      requests: new Set(), ending: false, ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    };
  }

  get terminal(): Promise<void> { return this.active.terminal; }

  run(params: Record<string, unknown>, adapter?: AppServerTurnAdapter): Promise<AppServerTurnResult> {
    if (this.started) return Promise.reject(new Error("Codex turn 已提交"));
    this.started = true;
    if (adapter) {
      this.preparation = Promise.resolve().then(() => adapter.prepare()).then((prepared) => {
        this.binding = prepared.binding;
        if (!this.active.ending) this.submit({ ...params, input: prepared.input });
      }, (error: unknown) => {
        if (error instanceof AggregateError) this.bindingCleanupFailed = true;
        this.fail(error instanceof Error ? error : new Error("turn_preparation_failed"));
      });
    } else this.submit(params);
    return this.completion;
  }

  private submit(params: Record<string, unknown>): void {
    this.submitted = true;
    this.refreshIdleTimer(this.active);
    this.notifyObserver(this.active, { kind: "turn_submitted" });
    // Observe a late RPC settlement even after local failure; never rearm a finished turn.
    void this.client.request("turn/start", params).then((result) => {
      const turnId = asRecord(asRecord(result)?.turn)?.id;
      if (this.active.ending) {
        if (typeof turnId === "string" && turnId) this.options.retiredTurnIds?.add(turnId);
        return;
      }
      if (typeof turnId !== "string" || !turnId) {
        this.fail(new Error("Codex App Server 未返回有效 turn ID"));
        return;
      }
      if (this.active.turnId !== null && this.active.turnId !== turnId) {
        this.fail(new Error("Codex turn 启动身份冲突"));
        return;
      }
      this.active.turnId = turnId;
      this.startConfirmed = true;
      this.reportTurnAccepted(this.active);
      if (this.completionReceived) this.finishActive(this.active);
      else this.refreshIdleTimer(this.active);
    }, (error: unknown) => this.fail(error instanceof Error ? error : new Error("Codex 回复失败")));
  }

  fail(error: Error): void {
    if (this.settled) return;
    if (!this.active.failure) {
      this.active.failure = error;
      try { this.options.onFailure?.(error); } catch { /* Failure observers cannot prevent cleanup. */ }
    }
    this.finishActive(this.active);
  }

  async interrupt(): Promise<void> {
    if (this.active.ending) return this.terminal;
    if (!this.active.turnId) throw new Error("Codex turn 尚未被 App Server 接受");
    await this.client.request("turn/interrupt", { threadId: this.active.threadId, turnId: this.active.turnId });
    await this.terminal;
  }

  onServerRequest(handle: ServerRequestHandle): void {
    if (!this.touchActiveTurn(handle.message.params)) {
      AppServerTurnDriver.decline(handle);
      return;
    }
    let settle!: () => void;
    const operation = new Promise<void>((resolve) => { settle = resolve; });
    this.active.requests.add(operation);
    void operation.then(() => this.active.requests.delete(operation));
    void this.respondToServerRequest(handle, this.active).then(settle, settle);
  }

  static decline(handle: ServerRequestHandle): void {
    handle.respond(declineServerRequest(handle.message.id!, handle.message.method!));
  }

  onMessage(message: AppServerMessage): void {
    const params = message.params;
    if (!params || params.threadId !== this.active.threadId) return;
    const active = this.active;
    if (!this.submitted || active.ending || this.completionReceived) return;
    const messageTurnId = params.turnId ?? asRecord(params.turn)?.id;
    if (this.isRetiredTurn(messageTurnId)) return;
    if (message.method === "turn/started") {
      const turn = asRecord(params.turn);
      if (!turn || typeof turn.id !== "string" || !turn.id) return;
      if (active.turnId === null) active.turnId = turn.id;
      if (active.turnId !== turn.id) return;
      this.refreshIdleTimer(active);
      this.reportTurnAccepted(active);
      return;
    }
    if (message.method === "error" && params.willRetry !== true && asRecord(params.error)) {
      if (this.touchActiveTurn(params)) this.fail(modelTurnError(params.error, "Codex turn 执行失败"));
      return;
    }
    if (this.isTurnProgressNotification(message.method, params, active)) {
      this.refreshIdleTimer(active);
      this.reportTurnAccepted(active);
      this.notifyObserver(active, { kind: "protocol_progress" });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      if (!this.touchActiveTurn(params)) return;
      if (message.method === "item/started") this.reportItemActivity(active, params);
      else {
        const item = asRecord(params.item);
        if (item) active.driver.observeCompletedItem(item);
      }
      this.reportReasoningLifecycle(active, params, message.method === "item/started" ? "start" : "end");
      this.reportToolProgress(active, params, message.method === "item/started" ? "start" : "end");
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const turnId = params.turnId;
      if (typeof turnId !== "string" || !turnId || typeof params.delta !== "string") return;
      if (active.turnId === null) active.turnId = turnId;
      if (active.turnId === turnId && typeof params.delta === "string") {
        this.refreshIdleTimer(active);
        this.reportTurnAccepted(active);
        const itemId = typeof params.itemId === "string" ? params.itemId : "agent-message";
        if (!active.reportedAgentMessageIds.has(itemId)) {
          active.reportedAgentMessageIds.add(itemId);
          this.notifyObserver(active, { kind: "model_activity", activity: "agent_message" });
        }
        this.notifyObserver(active, { kind: "agent_message_delta" });
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (!turn || typeof turn.id !== "string") return;
      if (active.turnId === null) active.turnId = turn.id;
      if (active.turnId !== turn.id) return;
      if (turn.status !== "completed") {
        active.terminalStatus = this.turnOutcome(turn.status);
        this.fail(modelTurnError(turn.error, `Codex turn 未完成：${String(turn.status ?? "unknown")}`));
        return;
      }
      this.finishActive(active);
    }
  }

  private reportTurnAccepted(active: ActiveTurn): void {
    if (active.ending || active.turnAcceptedReported) return;
    active.turnAcceptedReported = true;
    this.notifyObserver(active, { kind: "turn_accepted" });
  }

  private refreshIdleTimer(active: ActiveTurn): void {
    if (active.ending) return;
    if (active.timer) clearTimeout(active.timer);
    if (this.turnIdleTimeoutMs === null) {
      active.timer = null;
      return;
    }
    const timer = setTimeout(() => {
      if (active.timer !== timer) return;
      this.fail(new Error("Codex 回合无进展超时"));
    }, this.turnIdleTimeoutMs);
    active.timer = timer;
  }

  private touchActiveTurn(params: Record<string, unknown> | undefined): boolean {
    if (!params || params.threadId !== this.active.threadId) return false;
    const active = this.active;
    if (!this.submitted || active.ending || this.completionReceived) return false;
    if (typeof params.turnId !== "string" || !params.turnId) return false;
    if (this.isRetiredTurn(params.turnId)) return false;
    {
      if (active.turnId === null) active.turnId = params.turnId;
      if (active.turnId !== params.turnId) return false;
    }
    this.refreshIdleTimer(active);
    return true;
  }

  private isRetiredTurn(turnId: unknown): boolean {
    return typeof turnId === "string" && turnId !== this.active.turnId &&
      this.options.retiredTurnIds?.has(turnId) === true;
  }

  private isTurnProgressNotification(
    method: string | undefined,
    params: Record<string, unknown>,
    active: ActiveTurn,
  ): boolean {
    if (!method || typeof params.turnId !== "string" || !params.turnId ||
        !(TURN_PROGRESS_NOTIFICATION_METHODS.has(method) || (method === "error" && params.willRetry === true))) return false;
    if (active.turnId === null) active.turnId = params.turnId;
    if (active.turnId !== params.turnId) return false;
    if (method === "error") return params.willRetry === true;
    return TURN_PROGRESS_NOTIFICATION_METHODS.has(method);
  }

  private reportItemActivity(active: ActiveTurn, params: Record<string, unknown>): void {
    const turnId = params.turnId;
    if (typeof turnId !== "string") return;
    if (active.turnId === null) active.turnId = turnId;
    if (active.turnId !== turnId) return;
    const item = asRecord(params.item);
    if (!item || typeof item.type !== "string") return;
    const toolTypes = new Set([
      "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
      "collabToolCall", "webSearch", "imageView", "contextCompaction",
    ]);
    const activity = item.type === "reasoning"
      ? "reasoning"
      : item.type === "agentMessage"
        ? "agent_message"
        : toolTypes.has(item.type)
          ? "tool"
          : null;
    if (!activity) return;
    this.reportTurnAccepted(active);
    this.notifyObserver(active, { kind: "model_activity", activity });
  }

  private reportReasoningLifecycle(
    active: ActiveTurn,
    params: Record<string, unknown>,
    phase: "start" | "end",
  ): void {
    const turnId = params.turnId;
    if (typeof turnId !== "string") return;
    if (active.turnId === null) active.turnId = turnId;
    if (active.turnId !== turnId) return;
    const item = asRecord(params.item);
    if (!item || item.type !== "reasoning" || typeof item.id !== "string") return;
    this.notifyObserver(active, { kind: "reasoning", itemId: item.id, phase });
  }

  private notifyObserver(active: ActiveTurn, event: CodexTurnEvent): void {
    try {
      active.onProgress?.(event);
    } catch {
      // Telemetry is best-effort and must never break the Codex turn.
    }
  }

  private turnOutcome(status: unknown): "failed" | "interrupted" | "unknown" {
    if (status === "failed") return "failed";
    if (status === "interrupted") return "interrupted";
    return "unknown";
  }

  private reportToolProgress(
    active: ActiveTurn,
    params: Record<string, unknown>,
    phase: "start" | "end",
  ): void {
    const turnId = params.turnId;
    if (typeof turnId !== "string") return;
    if (active.turnId === null) active.turnId = turnId;
    if (active.turnId !== turnId) return;
    const item = asRecord(params.item);
    if (!item || typeof item.id !== "string" || typeof item.type !== "string") return;
    const labels: Record<string, SafeToolLabel> = {
      commandExecution: "执行本地命令",
      fileChange: "修改文件",
      mcpToolCall: "调用 MCP 工具",
      dynamicToolCall: "调用本地工具",
      collabToolCall: "协同处理",
      webSearch: "搜索网页",
      imageView: "查看图片",
      contextCompaction: "整理会话上下文",
    };
    const label = labels[item.type];
    if (!label || !active.onProgress) return;
    const rawStatus = item.status;
    const status = phase === "end"
      ? rawStatus === "completed"
        ? "completed"
        : rawStatus === "failed"
          ? "failed"
          : rawStatus === "declined" || rawStatus === "blocked" || rawStatus === "cancelled" || rawStatus === "interrupted"
            ? "blocked"
            : "unknown"
      : undefined;
    this.notifyObserver(active, { kind: "tool", itemId: item.id, label, phase, ...(status ? { status } : {}) });
  }

  private async respondToServerRequest(handle: ServerRequestHandle, active: ActiveTurn): Promise<void> {
    const message = handle.message;
    const id = message.id;
    const method = message.method;
    if (id === undefined || !method) return;
    if (method === "item/tool/call" && this.dynamicTools) {
      const tool = message.params?.tool;
      if (typeof tool !== "string") {
        this.sendServerResponse(handle, { id, result: { contentItems: [], success: false } });
        return;
      }
      try {
        const threadId = message.params?.threadId;
        const turnId = message.params?.turnId;
        const namespace = message.params?.namespace;
        const context = typeof threadId === "string" && typeof turnId === "string" &&
          (namespace === null || typeof namespace === "string")
          ? { threadId, turnId, namespace }
          : undefined;
        const result = await this.dynamicTools.execute(tool, message.params?.arguments, context);
        if (context && this.dynamicTools.turnOwner?.(context) === "workflow") {
          if (this.active === active && (active.turnId === null || active.turnId === context.turnId)) {
            active.turnId ??= context.turnId;
            active.driver.claimWorkflow(true);
          }
        }
        this.sendServerResponse(handle, { id, result });
      } catch {
        this.sendServerResponse(handle, { id, result: { contentItems: [], success: false } });
      }
      return;
    }
    if (method === "item/permissions/requestApproval" && this.permissionGuard) {
      try {
        const result = await this.permissionGuard.request(message.params ?? {});
        this.sendServerResponse(handle, { id, result });
      } catch {
        this.sendServerResponse(handle, { id, error: { code: -32000, message: "request declined" } });
      }
      return;
    }
    this.sendServerResponse(handle, declineServerRequest(id, method));
  }

  private sendServerResponse(handle: ServerRequestHandle, response: AppServerMessage): void {
    if (handle.respond(response)) this.touchActiveTurn(handle.message.params);
  }

  private async completePermissionGuard(active: ActiveTurn): Promise<Error | null> {
    if (active.permissionGuardCompleted || !active.turnId || !this.permissionGuard) return null;
    active.permissionGuardCompleted = true;
    try {
      await this.permissionGuard.complete(active.threadId, active.turnId);
      return null;
    } catch {
      return new Error("写入可能已完成，但本地变更记录失败；请检查快照后再继续");
    }
  }


  private finishActive(active: ActiveTurn): void {
    if (active.ending) return;
    if (!active.failure && !this.startConfirmed) {
      this.completionReceived = true;
      this.completePendingServerRequests(active.threadId, active.turnId);
      return;
    }
    active.ending = true;
    if (active.turnId) this.options.retiredTurnIds?.add(active.turnId);
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    this.notifyObserver(active, { kind: "turn_cleanup", phase: "start" });
    this.completePendingServerRequests(active.threadId, active.turnId);
    void (async () => {
      // A close may precede preparation completion; the late binding still belongs here.
      await this.preparation;
      const cleanupErrors: unknown[] = [];
      try { this.binding?.seal(); } catch (error) { cleanupErrors.push(error); }
      await Promise.allSettled([...active.requests]);
      const permissionError = await this.completePermissionGuard(active);
      if (permissionError) {
        this.permissionCleanupFailed = true;
        if (active.failure) active.failure = permissionError;
      }
      this.notifyObserver(active, { kind: "turn_cleanup", phase: "end", ...(permissionError ? { errorCode: "permission_cleanup_failed" } : {}) });
      if (this.binding || this.bindingCleanupFailed) this.notifyObserver(active, { kind: "binding_cleanup", phase: "start" });
      let ownership: WorkflowToolTurnSnapshot = { owner: "model" };
      try {
        await this.binding?.drain();
        ownership = this.binding?.snapshot() ?? ownership;
      } catch (error) {
        // Unknown binding truth must never permit a model-text fallback.
        active.failure ??= error instanceof Error ? error : new Error("workflow_tool_receipt_unavailable");
        cleanupErrors.push(error);
      }
      let reply: AppServerTurnResult = { owner: "model_owned", finalText: "" };
      if (!active.failure) {
        try {
          if (ownership.owner === "workflow") {
            if (!ownership.receipt) throw new Error("workflow_tool_receipt_unavailable");
            reply = { owner: "workflow_owned", receipt: ownership.receipt };
          } else {
            const candidate = active.driver.complete(this.options.allowEmptyReply === true);
            if (candidate.owner !== "model_owned") throw new Error("model_only_turn_workflow_owned");
            reply = candidate;
          }
        } catch (error) {
          active.failure = error instanceof Error ? error : new Error("Codex 回复失败");
        }
      }
      try { await this.binding?.release(); } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) this.bindingCleanupFailed = true;
      if (this.binding || this.bindingCleanupFailed) this.notifyObserver(active, { kind: "binding_cleanup", phase: "end", ...(this.bindingCleanupFailed ? { errorCode: "workflow_tool_release_failed" } : {}) });
      this.notifyObserver(active, { kind: "turn_completed", status: active.failure ? active.terminalStatus ?? "failed" : "completed" });
      this.settled = true;
      active.settleTerminal();
      if (active.failure) active.reject(new AppServerTurnFailure(active.failure, ownership));
      else active.resolve(reply);
    })();
  }

  private completePendingServerRequests(threadId: string, turnId: string | null): void {
    this.client.finishServerRequests(threadId, turnId, (handle) => {
      const id = handle.message.id!;
      this.sendServerResponse(
        handle,
        handle.message.method === "item/tool/call"
          ? { id, result: { contentItems: [], success: false } }
          : { id, error: { code: -32000, message: "request cancelled" } },
      );
    });
  }
}

function declineServerRequest(id: string | number, method: string): AppServerMessage {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) {
      return { id, result: { decision: "decline" } };
    }
    if (method === "item/tool/requestUserInput") {
      return { id, result: { answers: {} } };
    }
    if (method === "mcpServer/elicitation/request") {
      return { id, result: { action: "decline", content: null, _meta: null } };
    }
    if (method === "item/tool/call") {
      return { id, result: { contentItems: [], success: false } };
    }
    return { id, error: { code: -32000, message: "request declined" } };
  }
