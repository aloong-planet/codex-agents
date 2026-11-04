import type { ConversationOwner } from "./personal-owner-identity.js";
import crypto from "node:crypto";
import fs from "node:fs";
import type { DiagnosticSpan, LocalDiagnostics } from "./local-diagnostics.js";
import path from "node:path";

import {
  type AgentRunTiming,
  type CodexServiceState,
  type CodexTranscriptEntry,
  type PermissionMode,
  CodexServiceStore,
} from "./codex-service-store.js";
import type {
  RejectedInboundMessage as InboundRejectedEvent,
  InboundMessage as InboundTextEvent,
  OutboundDeliveryDiagnostics,
  SendTextResult,
  TypingInitializationDiagnostics,
  ConversationChannel,
  ConversationTurnFactory,
} from "./channel-contract.js";
import type {
  CodexToolProgressEvent,
  CodexTurnEvent,
  CodexTurnObserver,
  FrozenTurnPolicy,
} from "./codex-conversation.js";
import type { CodexDesktopNavigator } from "./codex-desktop.js";
import type {
  CompletedMemoryTurn,
  PublicAccountMemoryState,
} from "./account-memory-system.js";
import {
  AccountChatModelSettings,
  builtInChatModelCatalog,
  type ChatModelSelection,
  type CodexModelDescriptor,
  type ResolvedChatModel,
} from "./account-chat-model-settings.js";
import type { WorkflowPlannerDiagnostic } from "./workflow-intent-planner.js";
import { settleCleanup } from "./async-cleanup.js";
import { AppServerTurnFailure } from "./app-server-turn-driver.js";
import type { CodexConversation } from "./codex-conversation.js";
import { MAIN_REPLY_OUTPUT_SCHEMA, MainReplyProtocolError, parseMainReply, type MainReplyFailureCode, type StoredMainBusinessResult } from "./main-reply-result.js";

export interface CodexAgent {
  isThreadReady?(threadId: string): boolean;
  listModels?(): Promise<CodexModelDescriptor[]>;
  startOrResume(threadId: string | undefined, cwd: string, runtimeWorkspaceRoots?: string[], onLifecycle?: import("./codex-conversation.js").CodexSessionObserver): Promise<string>;
  runTurn: CodexConversation["runTurn"];
  close(): void | Promise<void>;
}

export type ConversationRuntime = { agent: CodexAgent; cwd: string; runtimeWorkspaceRoots: string[] };

export interface VaultCapabilityControl {
  readonly name: string;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

export interface InboundWorkflowControl {
  tryHandlePending?(event: InboundTextEvent): Promise<
    | { handled: false; plannerDiagnostics?: WorkflowPlannerDiagnostic[] }
    | {
        handled: true;
        reply: string;
        outcome: "succeeded" | "needs_input" | "failed";
        onAccepted?: () => Promise<void> | void;
        plannerDiagnostics?: WorkflowPlannerDiagnostic[];
      }
  >;
  tryHandle(event: InboundTextEvent): Promise<
    | { handled: false; plannerDiagnostics?: WorkflowPlannerDiagnostic[] }
    | {
        handled: true;
        reply: string;
        outcome: "succeeded" | "needs_input" | "failed";
        onAccepted?: () => Promise<void> | void;
        plannerDiagnostics?: WorkflowPlannerDiagnostic[];
      }
  >;
}

export interface CompletedInboundObserver {
  observe(event: InboundTextEvent): void;
}

export interface AccountMemoryControl {
  start(): Promise<void>;
  registerAccount?(accountId: string): void;
  enable(accountId: string): void;
  disable(accountId: string): void;
  retryLatestFailed?(accountId: string): boolean;
  confirmNotificationTarget?(accountId: string, target: string): void;
  captureTurn(turn: CompletedMemoryTurn): Promise<{ queued: boolean; jobId?: string }>;
  recall(accountId: string, currentUserText?: string): string;
  getPublicState?(): PublicAccountMemoryState;
  close(): void | Promise<void>;
}

export type PermissionSelection = {
  mode: PermissionMode;
  rootIds: string[];
  confirmed: boolean;
};

export type PublicCodexServiceState = {
  status: "disabled" | "starting" | "idle" | "thinking" | "sending" | "error";
  threadReady: boolean;
  enabledTargets: Array<{ accountId: string; target: string }>;
  transcript: CodexTranscriptEntry[];
  notice: string;
  runs: Array<{
    accountId: string;
    target: string;
    phase: import("./codex-service-store.js").TargetRunPhase;
    queueDepth: number;
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
    activeTool?: string;
    recentSteps: Array<{ label: string; status: string; at: number }>;
    timings: Array<import("./codex-service-store.js").TargetRunTiming & { durationMs?: number }>;
    agentTimings: Array<Omit<AgentRunTiming, "correlationHash"> & { durationMs?: number }>;
    agentTimingsTruncated: boolean;
    typingDiagnostics?: TypingInitializationDiagnostics;
    outboundDiagnostics?: OutboundDeliveryDiagnostics;
    workflowPlannerDiagnostics?: WorkflowPlannerDiagnostic[];
    totalDurationMs?: number;
    model?: string;
    reasoningEffort?: import("./account-chat-model-settings.js").CodexReasoningEffort;
    modelSelectionSource?: "track" | "pinned";
    modelConfigRevision?: number;
  }>;
  permissions: {
    onboardingCompleted: boolean;
    mode: PermissionMode;
    capability: { restrictedReadSupported: boolean };
    candidates: Array<{ id: string; displayName: string; path: string }>;
    selectedRoots: Array<{ id: string; displayName: string }>;
    revision: number;
    pendingCount: number;
  };
  memory?: PublicAccountMemoryState;
  models?: {
    catalog: ReturnType<AccountChatModelSettings["publicState"]>["catalog"];
    accounts: Array<{ accountId: string; selection: ReturnType<AccountChatModelSettings["publicState"]>["selection"]; revision: number; resolved: ReturnType<AccountChatModelSettings["publicState"]>["resolved"] }>;
  };
};

const FAILURE_NOTICE = "我暂时无法处理这条消息，请稍后再发一条新消息。";
const ACK_NOTICE = "已收到，正在处理。";
const VOICE_ACK_NOTICE = "已收到语音，正在处理。";
const VOICE_REJECTION_NOTICES: Record<InboundRejectedEvent["reason"], string> = {
  voice_too_long: "这条语音超过 60 秒，暂不处理。请拆分后重发，或改发文字。",
  voice_duration_invalid: "这条语音的时长信息无效，暂不处理。请改发文字。",
  voice_transcript_missing: "这条语音没有可用的腾讯转写文字，请改发文字。",
};
const VOICE_REJECTION_LABELS: Record<InboundRejectedEvent["reason"], string> = {
  voice_too_long: "语音超过 60 秒",
  voice_duration_invalid: "语音时长信息无效",
  voice_transcript_missing: "腾讯未提供语音转写",
};
const THREAD_PROFILE = "native-relay-v2" as const;

export class ConversationService {
  private state: CodexServiceState;
  private status: PublicCodexServiceState["status"];
  private notice: string;
  private replyPersistenceFailed = false;
  private started = false;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly readyTargets = new Set<string>();
  private readonly startingTargets = new Map<string, Promise<string>>();
  private unsubscribe: () => void = () => {};
  private unsubscribeRejected: () => void = () => {};
  private readonly queues = new Map<string, Promise<void>>();
  private readonly completedObservationQueue: InboundTextEvent[] = [];
  private readonly pendingRunStarts = new Map<string, { observedAt: number; queuedAt: number; model?: ResolvedChatModel }>();
  private readonly agentTraceStates = new Map<string, {
    activeTools: Set<string>;
    firstModelSeen: boolean;
    finalGenerationStarted: boolean;
  }>();
  private readonly reservedKeys: Set<string>;
  private readonly modelSettings: AccountChatModelSettings;
  private readonly groupRuntimes = new Map<string, ConversationRuntime>();

  constructor(
    private readonly channel: ConversationChannel,
    private readonly agent: CodexAgent,
    private readonly store: CodexServiceStore,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
    private readonly vault?: VaultCapabilityControl,
    private readonly runtimeWorkspaceRoots: string[] = [cwd],
    private readonly restrictedReadSupported = false,
    private readonly mediaReadRoot?: string,
    private readonly turns?: ConversationTurnFactory,
    private readonly desktop?: CodexDesktopNavigator,
    private readonly memory?: AccountMemoryControl,
    private readonly inboundWorkflows?: InboundWorkflowControl,
    private readonly completedInboundObserver?: CompletedInboundObserver,
    private readonly workflowTools?: { contractHash?(): string },
    private readonly diagnostics?: LocalDiagnostics,
    private readonly owner?: ConversationOwner,
    private readonly createGroupRuntime?: (accountId: string, target: string) => ConversationRuntime,
  ) {
    this.state = store.load();
    this.modelSettings = new AccountChatModelSettings(
      this.state.modelSettings ?? [],
      (this.state.modelCatalog?.models.length ?? 0) > 0 ? this.state.modelCatalog! : builtInChatModelCatalog(),
    );
    const recovered = this.state.runtimeRuns.map((run) => {
      if (!["queued", "typing", "thinking", "tool", "sending"].includes(run.phase)) return run;
      const rest = { ...run };
      delete rest.activeTool;
      const interruptedAt = this.now();
      const timings = run.timings.map((timing) => timing.completedAt === undefined
        ? { ...timing, completedAt: Math.max(timing.startedAt, interruptedAt), outcome: "interrupted" as const }
        : timing);
      const agentTimings = run.agentTimings.map((timing) => timing.completedAt === undefined
        ? { ...timing, completedAt: Math.max(timing.startedAt, interruptedAt), outcome: "interrupted" as const }
        : timing);
      return { ...rest, phase: "interrupted" as const, completedAt: interruptedAt, updatedAt: interruptedAt, timings, agentTimings };
    });
    if (recovered.some((run, index) => run !== this.state.runtimeRuns[index])) {
      this.state = { ...this.state, runtimeRuns: recovered };
      this.store.save(this.state);
    }
    this.vault?.setEnabled(false);
    this.reservedKeys = new Set(this.state.processedKeys);
    this.status = this.state.enabledTargets.length > 0 ? "starting" : "disabled";
    this.notice = this.state.enabledTargets.length > 0
      ? "正在恢复独立 Codex 服务。"
      : "请选择已发现的微信目标并明确启用自动回复。";
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("weixin_service_closed"));
    return this.starting ??= this.startOnce().finally(() => { if (!this.started) this.starting = undefined; });
  }

  private async startOnce(): Promise<void> {
    if (this.started) return;
    await this.memory?.start();
    if (this.closing) return;
    const memoryScopes = new Set<string>();
    for (const account of this.channel.getSnapshot().accounts) {
      if (!this.owner || this.owner.ownsAccount(account.accountId)) {
        memoryScopes.add(this.memoryAccount(account.accountId));
      }
    }
    for (const address of this.channel.getSnapshot().targets) {
      if (!this.owner || this.owner.ownsAddress(address.accountId, address.target)) {
        memoryScopes.add(this.memoryAccount(address.accountId, address.target));
      }
    }
    for (const scope of memoryScopes) this.memory?.registerAccount?.(scope);
    const subscribe = this.channel.onInboundText;
    if (!subscribe) throw new Error("当前微信通道不支持文本入站监听");
    this.unsubscribe = subscribe.call(this.channel, (event) => this.onInbound(event));
    this.unsubscribeRejected = this.channel.onInboundRejected?.call(
      this.channel,
      (event) => this.onRejected(event),
    ) ?? (() => {});
    this.started = true;
    if (this.state.enabledTargets.length > 0) {
      await Promise.all(this.state.enabledTargets.filter((item) => !this.owner || this.owner.ownsAddress(item.accountId, item.target)).map(async (item) => {
        try { await this.ensureAgent(item.accountId, item.target); }
        catch (error) {
          if (!item.target.startsWith("feishu.group.")) throw error;
          this.diagnostics?.checkpoint("group.runtime", { status: "unavailable", errorCode: "group_runtime_start_failed" });
        }
      }));
    }
    await this.refreshModelCatalog(false).catch(() => {});
  }

  configureChatModel(accountId: string, selection: ChatModelSelection): void {
    const known = this.channel.getSnapshot().accounts.some((account) => account.accountId === accountId);
    if (!known) throw new Error("只能为已连接的微信账户配置回复模型");
    this.modelSettings.configure(accountId, selection, this.now());
    this.persistModelSettings();
    this.notice = "回复模型已保存，将从下一条新微信消息开始生效。";
  }

  async refreshModelCatalog(force = true): Promise<void> {
    if (!force && this.modelSettings.snapshot().catalog.fetchedAt > this.now() - 6 * 60 * 60 * 1000) return;
    if (!this.agent.listModels) throw new Error("当前 Codex App Server 不支持模型目录");
    const models = await this.agent.listModels();
    this.modelSettings.replaceCatalog({ fetchedAt: this.now(), models });
    this.persistModelSettings();
    this.notice = `模型目录已刷新，共 ${this.modelSettings.snapshot().catalog.models.length} 个可用模型。`;
  }

  async enable(accountId: string, target: string): Promise<void> {
    if (this.owner && !this.owner.ownsAddress(accountId, target)) throw new Error("owner_identity_unbound");
    const known = this.channel.getSnapshot().targets.some(
      (candidate) => candidate.accountId === accountId && candidate.target === target,
    );
    if (!known) throw new Error("只能启用已发现的微信入站目标");
    if (!this.state.enabledTargets.some((item) => item.accountId === accountId && item.target === target)) {
      this.state = {
        ...this.state,
        enabledTargets: [...this.state.enabledTargets, { accountId, target }].slice(-100),
      };
      this.store.save(this.state);
    }
    this.memory?.confirmNotificationTarget?.(this.memoryAccount(accountId, target), target);
    await this.ensureAgent(accountId, target);
  }

  disable(accountId: string, target: string): void {
    this.state = {
      ...this.state,
      enabledTargets: this.state.enabledTargets.filter(
        (item) => item.accountId !== accountId || item.target !== target,
      ),
    };
    this.store.save(this.state);
    this.status = this.state.enabledTargets.length > 0 ? "idle" : "disabled";
    this.notice = this.state.enabledTargets.length > 0
      ? "该目标已停用，其他已授权目标仍在监听。"
      : "Codex 自动回复已停用。";
  }

  enableMemory(accountId: string): void {
    const known = this.channel.getSnapshot().accounts.some((account) => account.accountId === accountId);
    if (!known) throw new Error("只能为已连接的微信账户启用记忆");
    if (!this.memory) throw new Error("账户记忆功能不可用");
    this.memory.enable(this.memoryAccount(accountId));
    this.notice = "账户级长期记忆已启用；目标变化时仍共用同一份记忆。";
  }

  disableMemory(accountId: string): void {
    if (!this.memory) throw new Error("账户记忆功能不可用");
    this.memory.disable(this.memoryAccount(accountId));
    this.notice = "账户级长期记忆已停用；既有 MEMORY.md 保留但不再读取或更新。";
  }

  retryLatestMemoryFailure(accountId: string): boolean {
    if (!this.memory?.retryLatestFailed) throw new Error("账户记忆恢复功能不可用");
    const retried = this.memory.retryLatestFailed(this.memoryAccount(accountId));
    this.notice = retried ? "已重新处理最近一条失败的记忆任务。" : "当前账户没有可重新处理的失败记忆任务。";
    return retried;
  }

  confirmMemoryNotificationTarget(accountId: string, target: string): void {
    if (this.owner && !this.owner.ownsAddress(accountId, target)) throw new Error("owner_target_unbound");
    const known = this.channel.getSnapshot().targets.some(
      (candidate) => candidate.accountId === accountId && candidate.target === target,
    );
    if (!known) throw new Error("只能选择已发现的微信入站目标作为计划提醒接收人");
    if (!this.memory?.confirmNotificationTarget) throw new Error("账户计划提醒功能不可用");
    this.memory.confirmNotificationTarget(this.memoryAccount(accountId, target), target);
    this.notice = "已将当前微信目标确认为该账户的计划提醒接收人。";
  }

  async openInCodexDesktop(accountId: string, target: string): Promise<void> {
    const enabled = this.state.enabledTargets.some(
      (item) => item.accountId === accountId && item.target === target,
    );
    const session = this.state.targetSessions.find(
      (item) => item.accountId === accountId && item.target === target,
    );
    if (!enabled || !session) {
      throw new Error("当前目标尚未建立 Codex 任务，请先启用并完成一次微信交互");
    }
    if (!this.desktop) throw new Error("Codex Desktop 查看功能不可用");

    await this.desktop.openThread(session.threadId);
    this.notice = "已请求 Codex Desktop 打开当前任务；原生页面可能提示任务正在其他位置运行。";
  }

  enableVault(): void {
    throw new Error("旧写权限开关已停用；请在三档权限向导中重新授权");
  }

  disableVault(): void {
    this.vault?.setEnabled(false);
    this.notice = "本地文件写入保持关闭；请使用三档权限向导管理后续权限。";
  }

  configurePermissions(input: PermissionSelection): void {
    if (!this.restrictedReadSupported) {
      throw new Error("当前 Codex 版本不支持严格目录隔离；不能启用三档权限");
    }
    const modes: PermissionMode[] = ["safe", "guarded_plus", "advanced_controlled"];
    if (!modes.includes(input.mode)) throw new Error("权限模式无效");
    if (!input.confirmed) throw new Error("请先确认权限范围与限制");
    if (!Array.isArray(input.rootIds) || input.rootIds.length < 1 || input.rootIds.length > 20) {
      throw new Error("请至少选择一个授权目录");
    }
    const candidates = this.permissionCandidates();
    const selected = [...new Set(input.rootIds)].map((id) => {
      const candidate = candidates.find((item) => item.id === id);
      if (!candidate) throw new Error("授权目录无效");
      const info = fs.lstatSync(candidate.path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("授权目录不可用");
      const canonicalPath = fs.realpathSync(candidate.path);
      return { id: candidate.id, canonicalPath, displayName: candidate.displayName };
    });
    const next = {
      ...this.state,
      permissions: {
        onboardingCompleted: true,
        mode: input.mode,
        roots: selected,
        networkPolicy: "readonly_retrieval" as const,
        destructivePolicy: "block" as const,
        revision: this.state.permissions.revision + 1,
      },
    };
    this.store.save(next);
    this.state = next;
    this.notice = "权限设置已保存；新设置从下一条微信消息开始生效。";
  }

  narrowFileAccessContext(): void {
    const nextEpoch = (this.state.accessContextEpoch ?? 0) + 1;
    this.state = { ...this.state, accessContextEpoch: nextEpoch };
    this.store.save(this.state);
    for (const target of this.state.enabledTargets) {
      this.readyTargets.delete(this.targetKey(target.accountId, target.target));
    }
    this.status = this.state.enabledTargets.length > 0 ? "starting" : this.status;
    this.notice = "本地文件读取范围已收窄；下一条微信消息将使用新的独立 Codex 任务。";
  }

  getPublicState(): PublicCodexServiceState {
    const activeTargets = this.state.enabledTargets.filter((item) => !this.owner || this.owner.ownsAddress(item.accountId, item.target));
    return {
      status: this.replyPersistenceFailed ? "error" : this.status,
      threadReady: activeTargets.length > 0 && activeTargets.every(
        (item) => {
          const session = this.state.targetSessions.find(
            (session) => session.accountId === item.accountId && session.target === item.target,
          );
          return session !== undefined && this.readyTargets.has(this.targetKey(item.accountId, item.target)) &&
            this.runtimeForConversation(item.accountId, item.target).agent.isThreadReady?.(session.threadId) !== false;
        },
      ),
      enabledTargets: this.state.enabledTargets.map((item) => ({ ...item })),
      transcript: structuredClone(this.state.transcript),
      runs: this.state.runtimeRuns.map((run) => ({
        accountId: run.accountId,
        target: run.target,
        phase: run.phase,
        queueDepth: run.queueDepth,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
        ...(run.activeTool ? { activeTool: run.activeTool } : {}),
        recentSteps: run.recentSteps.map((step) => ({ label: step.label, status: step.status, at: step.at })),
        timings: run.timings.map((timing) => ({
          ...timing,
          ...(timing.completedAt !== undefined ? { durationMs: timing.completedAt - timing.startedAt } : {}),
        })),
        agentTimings: run.agentTimings.map((timing) => ({
          stage: timing.stage,
          startedAt: timing.startedAt,
          ...(timing.completedAt !== undefined ? { completedAt: timing.completedAt } : {}),
          ...(timing.outcome ? { outcome: timing.outcome } : {}),
          ...(timing.label ? { label: timing.label } : {}),
          ...(timing.completedAt !== undefined ? { durationMs: timing.completedAt - timing.startedAt } : {}),
        })),
        agentTimingsTruncated: run.agentTimingsTruncated,
        ...(run.typingDiagnostics ? { typingDiagnostics: structuredClone(run.typingDiagnostics) } : {}),
        ...(run.outboundDiagnostics ? { outboundDiagnostics: structuredClone(run.outboundDiagnostics) } : {}),
        ...(run.workflowPlannerDiagnostics
          ? { workflowPlannerDiagnostics: structuredClone(run.workflowPlannerDiagnostics) }
          : {}),
        ...(run.model ? {
          model: run.model,
          reasoningEffort: run.reasoningEffort,
          modelSelectionSource: run.modelSelectionSource,
          modelConfigRevision: run.modelConfigRevision,
        } : {}),
        ...(run.completedAt !== undefined && run.timings[0]
          ? { totalDurationMs: run.completedAt - run.timings[0].startedAt }
          : {}),
      })),
      notice: this.replyPersistenceFailed
        ? `${this.notice} 检测到本地回复记录保存失败；发送状态以各条回复为准，不会因此自动重发。`
        : this.notice,
      models: {
        catalog: this.modelSettings.snapshot().catalog,
        accounts: this.channel.getSnapshot().accounts.map((account) => {
          const state = this.modelSettings.publicState(account.accountId);
          return { accountId: account.accountId, selection: state.selection, revision: state.revision, resolved: state.resolved };
        }),
      },
      permissions: {
        onboardingCompleted: this.state.permissions.onboardingCompleted,
        mode: this.state.permissions.mode,
        capability: { restrictedReadSupported: this.restrictedReadSupported },
        candidates: this.permissionCandidates(),
        selectedRoots: this.state.permissions.roots.map(({ id, displayName }) => ({ id, displayName })),
        revision: this.state.permissions.revision,
        pendingCount: 0,
      },
      ...(this.memory?.getPublicState ? { memory: this.memory.getPublicState() } : {}),
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.unsubscribe();
    this.unsubscribe = () => {};
    this.unsubscribeRejected();
    this.unsubscribeRejected = () => {};
    this.started = false;
    this.closing = settleCleanup([
      () => this.agent.close(),
      () => Promise.allSettled([...new Set([...this.groupRuntimes.values()].map((runtime) => runtime.agent))].map((agent) => agent.close())),
      () => Promise.allSettled([this.starting, ...this.startingTargets.values(), ...this.queues.values()]),
      () => this.memory?.close(),
      () => {
        this.pendingRunStarts.clear();
        this.agentTraceStates.clear();
        this.readyTargets.clear();
      },
    ]);
    return this.closing;
  }

  private async ensureAgent(accountId: string, target: string): Promise<string> {
    if (this.closing) throw new Error("weixin_service_closed");
    const key = this.targetKey(accountId, target);
    const runtime = this.runtimeForConversation(accountId, target);
    const session = this.state.targetSessions.find(
      (item) => item.accountId === accountId && item.target === target,
    );
    const expectedToolContract = this.workflowTools?.contractHash?.();
    const ownerBindingHash = this.owner?.contextHash(accountId, target);
    const accessContextEpoch = this.state.accessContextEpoch ?? 0;
    const compatibleSession = session && session.ownerBindingHash === ownerBindingHash &&
      (expectedToolContract === undefined || session.toolContractHash === expectedToolContract) &&
      (session.accessContextEpoch ?? 0) === accessContextEpoch
      ? session
      : undefined;
    if (this.readyTargets.has(key) && compatibleSession &&
        runtime.agent.isThreadReady?.(compatibleSession.threadId) !== false) return compatibleSession.threadId;
    const starting = this.startingTargets.get(key);
    if (starting) return starting;

    this.status = "starting";
    this.notice = "正在启动独立 Codex 服务。";
    const promise = (async () => {
      try {
        const threadId = await runtime.agent.startOrResume(
          compatibleSession?.threadId,
          runtime.cwd,
          runtime.runtimeWorkspaceRoots,
          ...(this.diagnostics ? [(event: import("./codex-conversation.js").CodexSessionEvent) => this.diagnostics?.checkpoint("runtime.stage", { stage: event.kind, status: event.phase })] as const : []),
        );
        if (this.closing) throw new Error("weixin_service_closed");
        this.state = {
          ...this.state,
          targetSessions: [
            ...this.state.targetSessions.filter(
              (item) => item.accountId !== accountId || item.target !== target,
            ),
            {
              accountId,
              target,
              threadId,
              threadProfile: THREAD_PROFILE,
              ...(ownerBindingHash ? { ownerBindingHash } : {}),
              ...(expectedToolContract ? { toolContractHash: expectedToolContract } : {}),
              accessContextEpoch,
            },
          ].slice(-100),
        };
        this.store.save(this.state);
        this.readyTargets.add(key);
        this.status = "idle";
        this.notice = "独立 Codex 服务已就绪，等待已启用目标发来新消息。";
        return threadId;
      } catch (error) {
        this.status = "error";
        this.notice = "独立 Codex 服务启动失败；未向微信发送消息。";
        throw error;
      } finally {
        this.startingTargets.delete(key);
      }
    })();
    this.startingTargets.set(key, promise);
    return promise;
  }

  private onInbound(event: InboundTextEvent): Promise<void> {
    return this.diagnostics
      ? this.diagnostics.run("weixin.inbound", this.diagnostics.references({ ...event, eventKey: event.key }), () => this.acceptInbound(event))
      : this.acceptInbound(event);
  }

  private acceptInbound(event: InboundTextEvent): Promise<void> {
    if (this.owner && !this.owner.accepts(event)) return Promise.resolve();
    if (this.closing) return Promise.reject(new Error("weixin_service_closed"));
    if (!this.state.enabledTargets.some(
      (item) => item.accountId === event.accountId && item.target === event.target,
    )) return Promise.resolve();
    if (this.reservedKeys.has(event.key)) return Promise.resolve();

    const frozenModel = this.modelSettings.resolve(event.accountId);
    const userEntry: CodexTranscriptEntry = {
      id: crypto.randomUUID(),
      accountId: event.accountId,
      target: event.target,
      role: "user",
      text: event.source === "voice" ? `[语音转写] ${event.text}` : event.text,
      createdAt: event.receivedAt > 0 ? event.receivedAt : this.now(),
      status: "received",
    };
    const nextState: CodexServiceState = {
      ...this.state,
      transcript: [...this.state.transcript, userEntry].slice(-200),
    };
    try {
      this.store.save(nextState);
      this.state = nextState;
      this.reservedKeys.add(event.key);
    } catch {
      this.status = "error";
      this.notice = "收到微信消息，但无法安全保存处理记录；本条未回复。";
      return Promise.reject(new Error("codex_inbound_persist_failed"));
    }
    const key = this.targetKey(event.accountId, event.target);
    const runId = crypto.randomUUID();
    this.queueRuntime(event, runId, frozenModel);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const execution = previous.then(async () => {
      if (this.closing) throw new Error("weixin_service_closed");
      this.beginRuntime(event, runId, "typing");
      if (await this.tryHandleEcho(event, runId)) return;
      this.startTiming(event, runId, "typing_start");
      const typing = await this.channel.startTyping(event).catch(() => undefined);
      this.completeTiming(event, runId, "typing_start", typing?.active ? "completed" : "unavailable");
      if (typing?.diagnostics) this.recordTypingDiagnostics(event, runId, typing.diagnostics);
      if (!typing?.active && (this.channel.replyPolicy?.(event) ?? this.channel).acknowledgementFallback !== "none") await this.sendAcknowledgement(event, runId);
      if (!this.workflowTools || this.inboundWorkflows?.tryHandlePending) {
        const workflowHandled = await this.tryHandleInboundWorkflow(event, userEntry, runId, async () => {
          if (!typing?.active) return;
          this.startTiming(event, runId, "typing_stop");
          let outcome: "completed" | "unknown" = "completed";
          try {
            await typing.stop();
          } catch {
            outcome = "unknown";
          }
          this.completeTiming(event, runId, "typing_stop", outcome);
        }, this.workflowTools !== undefined);
        if (workflowHandled) return;
      }
      await this.processInbound(event, userEntry, runId, frozenModel, async () => {
        if (!typing?.active) return;
        this.startTiming(event, runId, "typing_stop");
        let outcome: "completed" | "unknown" = "completed";
        try {
          await typing.stop();
        } catch {
          outcome = "unknown";
        }
        this.completeTiming(event, runId, "typing_stop", outcome);
      });
    });
    const current = execution.catch(() => {});
    this.queues.set(key, current);
    void current.finally(() => {
      if (this.completedInboundObserver) {
        this.completedObservationQueue.push(event);
      }
      if (this.queues.get(key) === current) this.queues.delete(key);
      if (this.queues.size > 0) return;
      const completed = this.completedObservationQueue.splice(0);
      for (const observed of completed) {
        try {
          this.completedInboundObserver?.observe(observed);
        } catch {
          // Background observations never change the completed user path.
        }
      }
    });
    return execution;
  }

  private async tryHandleInboundWorkflow(
    event: InboundTextEvent,
    userEntry: CodexTranscriptEntry,
    runId: string,
    stopTyping: () => Promise<void>,
    pendingOnly = false,
  ): Promise<boolean> {
    if (!this.inboundWorkflows) return false;
    const routed = pendingOnly
      ? await this.inboundWorkflows.tryHandlePending?.(event) ?? { handled: false as const }
      : await this.inboundWorkflows.tryHandle(event);
    if (routed.plannerDiagnostics) {
      this.recordWorkflowPlannerDiagnostics(event, runId, routed.plannerDiagnostics);
    }
    if (!routed.handled) return false;

    this.status = "sending";
    this.setRuntimePhase(event, runId, "sending");
    const result = await this.replyTextWhileStoppingTyping(event, runId, stopTyping, routed.reply);
    let acceptedMetadataRecorded = true;
    if (result.ok && routed.onAccepted) {
      try {
        await routed.onAccepted();
      } catch {
        acceptedMetadataRecorded = false;
      }
    }
    const accepted = result.acceptedSegments ?? 0;
    const assistantEntry = this.appendAssistant(
      event,
      routed.reply,
      result.ok ? "accepted" : accepted > 0 ? "partial" : "send_failed",
    );
    const completed = routed.outcome !== "failed" && result.ok;
    this.status = completed ? "idle" : "error";
    this.notice = result.ok
      ? routed.outcome === "succeeded"
        ? "笔记工作流回复已发送。"
        : routed.outcome === "needs_input"
          ? acceptedMetadataRecorded
            ? "笔记工作流正在等待选择；提示已发送。"
            : "笔记工作流正在等待选择；提示已发送，但选择上下文记录失败。"
          : "笔记工作流未完成；说明已发送。"
      : "笔记工作流回复发送失败或结果未知；不会自动重试。";
    this.finishRuntime(event, runId, completed ? "completed" : "failed");
    await this.captureMemoryTurn(event, userEntry, assistantEntry);
    return true;
  }

  private async tryHandleEcho(event: InboundTextEvent, runId: string): Promise<boolean> {
    const trimmed = event.text.trim();
    if (!trimmed.startsWith("/")) return false;
    const spaceIndex = trimmed.indexOf(" ");
    const command = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
    if (command !== "/echo") return false;

    const startedAt = this.now();
    const message = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
    if (message) {
      this.setRuntimePhase(event, runId, "sending");
      const result = await this.replyTextTimed(event, runId, message);
      this.appendAssistant(event, message, result.ok ? "accepted" : "send_failed");
      if (!result.ok) {
        const failure = await this.replyTextTimed(event, runId, FAILURE_NOTICE);
        this.appendAssistant(event, FAILURE_NOTICE, failure.ok ? "agent_failed" : "send_failed");
        this.finishRuntime(event, runId, "failed");
        return true;
      }
    }
    const eventTime = event.receivedAt > 0 ? event.receivedAt : 0;
    const timing = [
      "⏱ 通道耗时",
      `├ 事件时间: ${eventTime > 0 ? new Date(eventTime).toISOString() : "N/A"}`,
      `├ 平台→Demo: ${eventTime > 0 ? `${Math.max(0, startedAt - eventTime)}ms` : "N/A"}`,
      `└ Demo 处理: ${Math.max(0, this.now() - startedAt)}ms`,
    ].join("\n");
    const timingResult = await this.replyTextTimed(event, runId, timing);
    this.appendAssistant(event, timing, timingResult.ok ? "accepted" : "send_failed");
    this.finishRuntime(event, runId, timingResult.ok ? "completed" : "failed");
    return true;
  }

  private onRejected(event: InboundRejectedEvent): Promise<void> {
    return this.diagnostics
      ? this.diagnostics.run("weixin.rejected", this.diagnostics.references({ ...event, eventKey: event.key }), () => this.acceptRejected(event))
      : this.acceptRejected(event);
  }

  private acceptRejected(event: InboundRejectedEvent): Promise<void> {
    if (this.owner && !this.owner.accepts(event)) return Promise.resolve();
    if (!this.state.enabledTargets.some(
      (item) => item.accountId === event.accountId && item.target === event.target,
    )) return Promise.resolve();
    if (this.reservedKeys.has(event.key)) return Promise.resolve();

    const userEntry: CodexTranscriptEntry = {
      id: crypto.randomUUID(),
      accountId: event.accountId,
      target: event.target,
      role: "user",
      text: `[语音未处理] ${VOICE_REJECTION_LABELS[event.reason]}`,
      createdAt: event.receivedAt > 0 ? event.receivedAt : this.now(),
      status: "received",
    };
    const nextState: CodexServiceState = {
      ...this.state,
      transcript: [...this.state.transcript, userEntry].slice(-200),
    };
    try {
      this.store.save(nextState);
      this.state = nextState;
      this.reservedKeys.add(event.key);
    } catch {
      this.status = "error";
      this.notice = "收到微信语音，但无法安全保存处理记录；本条未回复。";
      return Promise.reject(new Error("codex_inbound_persist_failed"));
    }

    const key = this.targetKey(event.accountId, event.target);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const execution = previous.then(async () => {
      this.status = "sending";
      const notice = VOICE_REJECTION_NOTICES[event.reason];
      const result = await this.channel.sendText(event, notice).catch(() => ({ ok: false as const }));
      this.diagnostics?.result({ status: result.ok ? "accepted" : "failed" });
      this.appendAssistant(event, notice, result.ok ? "accepted" : "send_failed");
      this.status = result.ok ? "idle" : "error";
      this.notice = result.ok
        ? "语音未进入 Codex；固定说明已被腾讯 iLink 渠道接受。"
        : "语音未进入 Codex；固定说明发送失败或结果未知，不会自动重试。";
    });
    const current = execution.catch(() => {});
    this.queues.set(key, current);
    void current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
    return execution;
  }

  private async processInbound(
    event: InboundTextEvent,
    userEntry: CodexTranscriptEntry,
    runId: string,
    frozenModel: ResolvedChatModel,
    stopTyping: () => Promise<void> = async () => {},
  ): Promise<void> {
    let reply: string;
    let workflowOnAccepted: (() => Promise<void> | void) | undefined;
    let workflowClaimed = false;
    let workflowReceiptReply: string | undefined;
    let businessResult: StoredMainBusinessResult | undefined;
    let drainProgress = async (): Promise<void> => {};
    if (!frozenModel.available) {
      this.status = "sending";
      const notice = "当前回复模型不可用，请在插件面板重新选择模型，然后重新发送这条消息。";
      const result = await this.replyTextWhileStoppingTyping(event, runId, stopTyping, notice);
      this.appendAssistant(event, notice, result.ok ? "agent_failed" : "send_failed");
      this.status = "error";
      this.notice = `${notice} 原消息未自动重试。`;
      this.finishRuntime(event, runId, "failed");
      return;
    }
    try {
      this.memory?.registerAccount?.(this.memoryAccount(event.accountId, event.target));
      const threadId = await this.ensureAgent(event.accountId, event.target);
      this.setRuntimePhase(event, runId, "thinking");
      this.status = "thinking";
      this.notice = "独立 Codex 服务正在处理最新微信消息。";
      const policy = event.conversationType === "group" ? undefined : this.policyForTurn();
      const outboundRoots = this.state.permissions.onboardingCompleted
        ? this.state.permissions.roots.map((root) => root.canonicalPath)
        : [];
      const forwarded = new Set<string>();
      let progressChain = Promise.resolve();
      let drainSpan: DiagnosticSpan | undefined;
      let bindingSpan: DiagnosticSpan | undefined;
      let protocolEndedAt: number | undefined;
      drainProgress = async () => { await progressChain; };
      const onProgress: CodexTurnObserver = (progress) => {
        if (progress.kind === "binding_cleanup") {
          if (progress.phase === "start") bindingSpan = this.diagnostics?.startSpan("app_server.turn_cleanup", {});
          else {
            try { bindingSpan?.end({ status: progress.errorCode ? "failed" : "succeeded", errorCode: progress.errorCode }); } catch { /* Observational only. */ }
          }
          return;
        }
        if (progress.kind === "turn_submitted") this.startTiming(event, runId, "agent");
        if (progress.kind === "turn_cleanup") {
          if (progress.phase === "start") {
            protocolEndedAt = this.now();
            drainSpan = this.diagnostics?.startSpan("app_server.turn_drain", {});
          } else {
            try { drainSpan?.end({ status: progress.errorCode ? "failed" : "succeeded", errorCode: progress.errorCode }); } catch { /* Observational only. */ }
          }
          return;
        }
        if (progress.kind === "turn_completed") {
          this.completeTerminalAgentTimings(event, runId, progress.status, protocolEndedAt);
          this.completeTiming(event, runId, "agent", progress.status, false, protocolEndedAt);
        }
        if (progress.kind === "protocol_progress" || progress.kind === "agent_message_delta") this.diagnostics?.progress(runId, progress.kind);
        this.recordAgentTimingEvent(event, runId, progress);
        if (progress.kind !== "tool") return;
        const dedupeKey = `${progress.itemId}:${progress.phase}`;
        if (forwarded.has(dedupeKey)) return;
        forwarded.add(dedupeKey);
        this.recordRuntimeProgress(event, runId, progress);
        progressChain = progressChain.then(async () => {
          await this.channel.sendProgress(event, {
            runId,
            itemId: progress.itemId,
            label: progress.label,
            phase: progress.phase,
            ...(progress.status ? { status: progress.status } : {}),
          }).catch(() => ({ ok: false as const }));
        });
      };
      if (!this.turns) throw new Error("conversation_turn_factory_missing");
      const recoveryEpoch = this.state.accessContextEpoch ?? 0;
      const recoveryRevision = this.state.permissions.revision;
      const result = await this.runtimeForConversation(event.accountId, event.target).agent.runTurn(
        threadId,
        this.turns.prepare(threadId, event, {
          accountMemory: this.memory?.recall(this.memoryAccount(event.accountId, event.target), event.text) ?? "",
          outboundRoots,
          isClosing: () => this.closing !== undefined,
          recoveryAllowed: () => recoveryEpoch === (this.state.accessContextEpoch ?? 0) &&
            recoveryRevision === this.state.permissions.revision && this.state.enabledTargets.some(
              (target) => target.accountId === event.accountId && target.target === event.target),
        }),
        policy,
        onProgress,
        { model: frozenModel.model, effort: frozenModel.effort, outputSchema: MAIN_REPLY_OUTPUT_SCHEMA },
      );
      await progressChain;
      this.completeTerminalAgentTimings(event, runId, "completed");
      this.completeTiming(event, runId, "agent", "completed");
      if (result.owner === "workflow_owned") {
        workflowClaimed = true;
        workflowReceiptReply = result.receipt.reply;
        workflowOnAccepted = result.receipt.onAccepted;
      }
      let selectedReply = workflowReceiptReply;
      if (result.owner === "model_owned") {
        const parsed = parseMainReply(result.finalText);
        selectedReply = parsed.message;
        businessResult = { version: 1, source: "main_model", inboundKey: event.key, results: parsed.results };
      }
      if (selectedReply === undefined) throw new Error("workflow_tool_receipt_unavailable");
      reply = Array.from(selectedReply.trim()).slice(0, (this.channel.replyPolicy?.(event) ?? this.channel).maxReplyCodePoints).join("");
      if (!reply) throw new Error("Codex 返回空回复");
    } catch (error) {
      this.completeTiming(event, runId, "agent", "failed");
      this.completeOpenAgentTimings(event, runId, "failed");
      this.diagnostics?.checkpoint("app_server.turn.failed", {
        runRef: runId,
        errorCode: error instanceof Error ? error.message : "non_error_failure",
      });
      if (error instanceof AppServerTurnFailure && error.ownership.owner === "workflow") {
        workflowClaimed = true;
        workflowReceiptReply = error.ownership.receipt?.reply;
        workflowOnAccepted = error.ownership.receipt?.onAccepted;
      }
      await drainProgress();
      const ownedReply = workflowClaimed ? workflowReceiptReply?.trim() : undefined;
      if (ownedReply) {
        reply = Array.from(ownedReply)
          .slice(0, (this.channel.replyPolicy?.(event) ?? this.channel).maxReplyCodePoints)
          .join("");
      } else {
        this.status = "sending";
        const recoveryFailure = error instanceof Error && error.message.startsWith("model_recovery_");
        const failureNotice = recoveryFailure
          ? error.message === "model_recovery_effect_unconfirmed"
            ? "模型连接中断，部分操作的结果无法安全确认，因此已停止自动续跑。已执行的操作不会自动重复，请核对结果后再继续。"
            : "模型连接中断，自动恢复未能完成，本次请求已停止。请稍后再发一条新消息。"
          : FAILURE_NOTICE;
        const result = await this.replyTextWhileStoppingTyping(
          event,
          runId,
          stopTyping,
          failureNotice,
        );
        const assistantEntry = this.appendAssistant(event, failureNotice, result.ok ? "agent_failed" : "send_failed",
          undefined, error instanceof MainReplyProtocolError ? error.code : undefined);
        this.status = "error";
        this.notice = result.ok
          ? "Codex 处理失败，已发送一次固定失败提示；不会自动重试。"
          : "Codex 处理失败，固定失败提示也未确认发送；不会自动重试。";
        this.finishRuntime(event, runId, "failed");
        await this.captureMemoryTurn(event, userEntry, assistantEntry);
        return;
      }
    }

    this.status = "sending";
    this.setRuntimePhase(event, runId, "sending");
    const result = await this.replyTextWhileStoppingTyping(event, runId, stopTyping, reply);
    let acceptedMetadataRecorded = true;
    if (result.ok && workflowOnAccepted) {
      try {
        await workflowOnAccepted();
      } catch {
        acceptedMetadataRecorded = false;
      }
    }
    const accepted = result.acceptedSegments ?? 0;
    const assistantEntry = this.appendAssistant(
      event,
      reply,
      result.ok ? "accepted" : accepted > 0 ? "partial" : "send_failed",
      businessResult,
    );
    this.status = result.ok ? "idle" : "error";
    this.notice = result.ok
      ? `回复已被腾讯 iLink 渠道接受${(result.totalSegments ?? 1) > 1 ? `（共 ${result.totalSegments} 段）` : ""}。${result.truncated ? " 正文过长，末段已标记截断。" : ""}${result.duplicatePossible ? " 某段曾超时并重试，可能重复。" : ""}${acceptedMetadataRecorded ? "" : " 待选上下文记录失败。"}`
      : accepted > 0
        ? `回复已接受 ${accepted}/${result.totalSegments ?? "?"} 段；不会自动重发整篇。${result.duplicatePossible ? " 某段可能重复。" : ""}`
        : "回复发送失败或结果未知；不会自动重试。";
    this.finishRuntime(event, runId, result.ok ? "completed" : "failed");
    await this.captureMemoryTurn(event, userEntry, assistantEntry);
  }

  private persistModelSettings(): void {
    const snapshot = this.modelSettings.snapshot();
    this.state = { ...this.state, version: 7, modelSettings: snapshot.settings, modelCatalog: snapshot.catalog };
    this.store.save(this.state);
  }

  private memoryAccount(accountId: string, target?: string): string {
    return this.owner?.memoryScope(accountId, target) ?? accountId;
  }

  private runtimeForConversation(accountId: string, target: string): ConversationRuntime {
    if (!target.startsWith("feishu.group.")) return {
      agent: this.agent, cwd: this.cwd,
      runtimeWorkspaceRoots: [...this.runtimeWorkspaceRoots, ...(this.mediaReadRoot ? [this.mediaReadRoot] : [])],
    };
    const key = this.targetKey(accountId, target);
    let runtime = this.groupRuntimes.get(key);
    if (!runtime) {
      if (!this.createGroupRuntime) throw new Error("group_runtime_unavailable");
      runtime = this.createGroupRuntime(accountId, target);
      this.groupRuntimes.set(key, runtime);
    }
    return runtime;
  }

  private async captureMemoryTurn(
    event: Pick<InboundTextEvent, "key" | "accountId" | "target" | "text">,
    userEntry: CodexTranscriptEntry,
    assistantEntry: CodexTranscriptEntry,
  ): Promise<void> {
    await this.memory?.captureTurn({
      accountId: this.memoryAccount(event.accountId, event.target),
      target: event.target,
      userEntry: {
        source: { eventKey: event.key, target: event.target },
        id: userEntry.id,
        text: event.text,
        createdAt: userEntry.createdAt,
        status: userEntry.status,
      },
      assistantEntry: {
        id: assistantEntry.id,
        text: assistantEntry.text,
        createdAt: assistantEntry.createdAt,
        status: assistantEntry.status,
      },
    }).catch(() => {
      this.notice = `${this.notice} 记忆整理任务未能安全排队。`;
    });
  }

  private queueRuntime(event: Pick<InboundTextEvent, "accountId" | "target" | "observedAt">, runId: string, model?: ResolvedChatModel): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    const now = this.now();
    const observedAt = typeof event.observedAt === "number" ? event.observedAt : now;
    this.pendingRunStarts.set(runId, { observedAt, queuedAt: now, ...(model ? { model } : {}) });
    const active = existing && ["queued", "typing", "thinking", "tool", "sending"].includes(existing.phase);
    const next = active
      ? { ...existing, queueDepth: existing.queueDepth + 1, updatedAt: now }
      : { accountId: event.accountId, target: event.target, runId, phase: "queued" as const, queueDepth: 0, startedAt: now, updatedAt: now, recentSteps: [], timings: [
          { stage: "inbound" as const, startedAt: observedAt, completedAt: now, outcome: "completed" as const },
          { stage: "queue" as const, startedAt: now },
        ], agentTimings: [], agentTimingsTruncated: false, ...(model?.available ? { model: model.model, reasoningEffort: model.effort, modelSelectionSource: model.source, modelConfigRevision: model.configRevision } : {}) };
    this.saveRuntime(next);
  }

  private beginRuntime(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    phase: "typing" | "thinking" | "sending",
  ): void {
    const pending = this.pendingRunStarts.get(runId);
    this.pendingRunStarts.delete(runId);
    const existing = this.runtimeFor(event.accountId, event.target);
    if (existing?.runId === runId) {
      this.completeTiming(event, runId, "queue", "completed");
      this.setRuntimePhase(event, runId, phase);
      return;
    }
    const now = this.now();
    const queuedAt = pending?.queuedAt ?? now;
    const observedAt = pending?.observedAt ?? queuedAt;
    this.saveRuntime({
      accountId: event.accountId,
      target: event.target,
      runId,
      phase,
      queueDepth: Math.max(0, (existing?.queueDepth ?? 1) - 1),
      startedAt: queuedAt,
      updatedAt: now,
      recentSteps: [],
      timings: [
        { stage: "inbound", startedAt: observedAt, completedAt: queuedAt, outcome: "completed" },
        { stage: "queue", startedAt: queuedAt, completedAt: Math.max(queuedAt, now), outcome: "completed" },
      ],
      agentTimings: [],
      agentTimingsTruncated: false,
      ...(pending?.model?.available ? { model: pending.model.model, reasoningEffort: pending.model.effort, modelSelectionSource: pending.model.source, modelConfigRevision: pending.model.configRevision } : {}),
    });
  }

  private setRuntimePhase(event: Pick<InboundTextEvent, "accountId" | "target">, runId: string, phase: "typing" | "thinking" | "sending"): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    const now = this.now();
    const next = existing?.runId === runId
      ? (() => { const rest = { ...existing }; delete rest.activeTool; return { ...rest, phase, updatedAt: now }; })()
      : { accountId: event.accountId, target: event.target, runId, phase, queueDepth: Math.max(0, (existing?.queueDepth ?? 1) - 1), startedAt: now, updatedAt: now, recentSteps: existing?.recentSteps ?? [], timings: existing?.timings ?? [], agentTimings: existing?.agentTimings ?? [], agentTimingsTruncated: existing?.agentTimingsTruncated ?? false };
    this.saveRuntime(next);
  }

  private recordRuntimeProgress(event: Pick<InboundTextEvent, "accountId" | "target">, runId: string, progress: CodexToolProgressEvent): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    const at = this.now();
    const itemHash = crypto.createHash("sha256").update(progress.itemId).digest("hex");
    const recentSteps = [...existing.recentSteps.filter((step) => step.itemHash !== itemHash), {
      itemHash,
      label: progress.label,
      status: progress.phase === "start" ? "running" as const : progress.status ?? "unknown",
      at,
    }].slice(-20);
    const rest = { ...existing };
    delete rest.activeTool;
    this.saveRuntime({ ...rest, phase: progress.phase === "start" ? "tool" : "thinking", updatedAt: at, ...(progress.phase === "start" ? { activeTool: progress.label } : {}), recentSteps });
  }

  private recordAgentTimingEvent(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    telemetry: CodexTurnEvent,
  ): void {
    const trace = this.agentTraceStates.get(runId) ?? {
      activeTools: new Set<string>(),
      firstModelSeen: false,
      finalGenerationStarted: false,
    };
    this.agentTraceStates.set(runId, trace);
    if (telemetry.kind === "turn_submitted") {
      this.startAgentTiming(event, runId, "app_server_prepare");
      return;
    }
    if (telemetry.kind === "turn_accepted") {
      this.completeAgentTiming(event, runId, "app_server_prepare", "completed");
      if (!trace.firstModelSeen) this.startAgentTiming(event, runId, "first_model_wait");
      return;
    }
    if (telemetry.kind === "model_activity") {
      this.completeAgentTiming(event, runId, "app_server_prepare", "completed");
      if (!trace.firstModelSeen) {
        this.startAgentTiming(event, runId, "first_model_wait");
        trace.firstModelSeen = true;
        this.completeAgentTiming(event, runId, "first_model_wait", "completed");
      }
      this.completeAgentTiming(event, runId, "tool_result_wait", "completed");
      return;
    }
    if (telemetry.kind === "reasoning") {
      const correlationHash = this.hashTimingCorrelation(telemetry.itemId);
      if (telemetry.phase === "start") {
        this.startAgentTiming(event, runId, "model_reasoning", { correlationHash });
      } else {
        this.completeAgentTiming(event, runId, "model_reasoning", "completed", correlationHash);
      }
      return;
    }
    if (telemetry.kind === "tool") {
      const correlationHash = this.hashTimingCorrelation(telemetry.itemId);
      if (telemetry.phase === "start") {
        trace.activeTools.add(correlationHash);
        this.startAgentTiming(event, runId, "tool_execution", {
          correlationHash,
          label: telemetry.label,
        });
      } else {
        this.completeAgentTiming(
          event,
          runId,
          "tool_execution",
          telemetry.status === "completed" ? "completed" : telemetry.status === "unknown" ? "unknown" : "failed",
          correlationHash,
        );
        trace.activeTools.delete(correlationHash);
        if (trace.activeTools.size === 0) this.startAgentTiming(event, runId, "tool_result_wait");
      }
      return;
    }
    if (telemetry.kind === "agent_message_delta") {
      if (!trace.firstModelSeen) {
        this.recordAgentTimingEvent(event, runId, { kind: "model_activity", activity: "agent_message" });
      }
      this.completeAgentTiming(event, runId, "tool_result_wait", "completed");
      if (!trace.finalGenerationStarted) {
        trace.finalGenerationStarted = true;
        this.startAgentTiming(event, runId, "final_generation");
      }
      return;
    }
    if (telemetry.kind === "turn_completed") {
      this.completeTerminalAgentTimings(event, runId, telemetry.status);
    }
  }

  private startAgentTiming(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    stage: AgentRunTiming["stage"],
    details: Partial<Pick<AgentRunTiming, "correlationHash" | "label">> = {},
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    const duplicate = existing.agentTimings.some((timing) =>
      timing.stage === stage && timing.completedAt === undefined &&
      timing.correlationHash === details.correlationHash);
    if (duplicate) return;
    if (existing.agentTimings.length >= 50) {
      if (!existing.agentTimingsTruncated) this.saveRuntime({ ...existing, agentTimingsTruncated: true });
      return;
    }
    const now = this.now();
    this.saveRuntime({
      ...existing,
      updatedAt: now,
      agentTimings: [...existing.agentTimings, {
        stage,
        startedAt: now,
        ...(details.label ? { label: details.label } : {}),
        ...(details.correlationHash ? { correlationHash: details.correlationHash } : {}),
      }],
    });
  }

  private completeAgentTiming(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    stage: AgentRunTiming["stage"],
    outcome: NonNullable<AgentRunTiming["outcome"]>,
    correlationHash?: string,
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    let index = -1;
    for (let candidate = existing.agentTimings.length - 1; candidate >= 0; candidate -= 1) {
      const timing = existing.agentTimings[candidate];
      if (timing?.stage === stage && timing.completedAt === undefined &&
        timing.correlationHash === correlationHash) {
        index = candidate;
        break;
      }
    }
    if (index < 0) return;
    const now = this.now();
    const agentTimings = existing.agentTimings.map((timing, candidate) => candidate === index
      ? { ...timing, completedAt: Math.max(timing.startedAt, now), outcome }
      : timing);
    this.saveRuntime({ ...existing, updatedAt: now, agentTimings });
  }

  private completeTerminalAgentTimings(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    status: "completed" | "failed" | "interrupted" | "unknown",
    completedAt?: number,
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    const now = this.now();
    const terminalOutcome = status === "completed" ? "completed" : status;
    const agentTimings = existing.agentTimings.map((timing): AgentRunTiming => timing.completedAt === undefined
      ? {
          ...timing,
          completedAt: Math.max(timing.startedAt, completedAt ?? now),
          outcome: status === "completed" && (timing.stage === "tool_execution" || timing.stage === "model_reasoning")
            ? "unknown" as const
            : terminalOutcome,
        }
      : timing);
    this.saveRuntime({ ...existing, updatedAt: now, agentTimings });
  }

  private completeOpenAgentTimings(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    outcome: "failed" | "interrupted" | "unknown",
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    const now = this.now();
    const agentTimings = existing.agentTimings.map((timing): AgentRunTiming => timing.completedAt === undefined
      ? { ...timing, completedAt: Math.max(timing.startedAt, now), outcome }
      : timing);
    this.saveRuntime({ ...existing, updatedAt: now, agentTimings });
  }

  private hashTimingCorrelation(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private finishRuntime(event: Pick<InboundTextEvent, "accountId" | "target">, runId: string, phase: "completed" | "failed"): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    const now = this.now();
    const rest = { ...existing };
    delete rest.activeTool;
    this.saveRuntime({ ...rest, phase, updatedAt: now, completedAt: now }, true);
    this.agentTraceStates.delete(runId);
  }

  private startTiming(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    stage: import("./codex-service-store.js").TargetRunTimingStage,
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    const now = this.now();
    this.saveRuntime({ ...existing, updatedAt: now, timings: [...existing.timings, { stage, startedAt: now }].slice(-12) });
  }

  private completeTiming(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    stage: import("./codex-service-store.js").TargetRunTimingStage,
    outcome: NonNullable<import("./codex-service-store.js").TargetRunTiming["outcome"]>,
    afterReply = false,
    completedAt?: number,
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    let index = -1;
    for (let candidate = existing.timings.length - 1; candidate >= 0; candidate -= 1) {
      const timing = existing.timings[candidate];
      if (timing?.stage === stage && timing.completedAt === undefined) {
        index = candidate;
        break;
      }
    }
    if (index < 0) return;
    const now = this.now();
    const timings = existing.timings.map((timing, candidate) => candidate === index
      ? { ...timing, completedAt: Math.max(timing.startedAt, completedAt ?? now), outcome }
      : timing);
    this.saveRuntime({ ...existing, updatedAt: now, timings }, afterReply);
  }

  private recordTypingDiagnostics(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    diagnostics: TypingInitializationDiagnostics,
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    this.saveRuntime({ ...existing, updatedAt: this.now(), typingDiagnostics: structuredClone(diagnostics) });
  }

  private recordWorkflowPlannerDiagnostics(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    diagnostics: WorkflowPlannerDiagnostic[],
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    this.saveRuntime({
      ...existing,
      updatedAt: this.now(),
      workflowPlannerDiagnostics: structuredClone(diagnostics).slice(-32),
    });
  }

  private sendTimingOutcome(result: SendTextResult): NonNullable<import("./codex-service-store.js").TargetRunTiming["outcome"]> {
    if (result.ok) return "completed";
    if (!result.reason || result.reason === "unknown") return "unknown";
    return "failed";
  }

  private async replyTextTimed(event: InboundTextEvent, runId: string, message: string): Promise<SendTextResult> {
    this.startTiming(event, runId, "outbound");
    const result: SendTextResult = await this.channel.sendText(event, message).catch(() => ({ ok: false, reason: "unknown" }));
    if (result.diagnostics) this.recordOutboundDiagnostics(event, runId, result.diagnostics);
    this.completeTiming(event, runId, "outbound", this.sendTimingOutcome(result), true);
    return result;
  }

  private recordOutboundDiagnostics(
    event: Pick<InboundTextEvent, "accountId" | "target">,
    runId: string,
    diagnostics: OutboundDeliveryDiagnostics,
  ): void {
    const existing = this.runtimeFor(event.accountId, event.target);
    if (!existing || existing.runId !== runId) return;
    this.saveRuntime({
      ...existing,
      updatedAt: this.now(),
      outboundDiagnostics: structuredClone(diagnostics),
    }, true);
  }

  private async replyTextWhileStoppingTyping(
    event: InboundTextEvent,
    runId: string,
    stopTyping: () => Promise<void>,
    message: string,
  ): Promise<SendTextResult> {
    const stopPromise = stopTyping().catch(() => {});
    const result = await this.replyTextTimed(event, runId, message);
    await stopPromise;
    return result;
  }

  private runtimeFor(accountId: string, target: string) {
    return this.state.runtimeRuns.find((run) => run.accountId === accountId && run.target === target);
  }

  private saveRuntime(run: CodexServiceState["runtimeRuns"][number], afterReply = false): void {
    this.state = { ...this.state, runtimeRuns: [...this.state.runtimeRuns.filter((item) => item.accountId !== run.accountId || item.target !== run.target), run].slice(-100) };
    if (afterReply) this.persistReplyState();
    else this.store.save(this.state);
    this.diagnostics?.runtime(run);
  }

  private persistReplyState(): void {
    try {
      this.store.save(this.state);
    } catch {
      // This process-local warning survives later notices, not a process restart.
      this.replyPersistenceFailed = true;
    }
  }

  private policyForTurn(): FrozenTurnPolicy | undefined {
    const permissions = this.state.permissions;
    if (!permissions.onboardingCompleted) return undefined;
    const candidates = this.permissionCandidates();
    const readableRoots = permissions.roots.map((root) => {
      const candidate = candidates.find((item) => item.id === root.id);
      if (!candidate || candidate.displayName !== root.displayName) {
        throw new Error("已授权目录不再可用");
      }
      const info = fs.lstatSync(candidate.path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("已授权目录不再可用");
      const canonicalPath = fs.realpathSync(candidate.path);
      if (canonicalPath !== root.canonicalPath) throw new Error("已授权目录已发生变化");
      return canonicalPath;
    });
    return {
      revision: permissions.revision,
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
        access: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots: [...readableRoots, ...(this.mediaReadRoot ? [this.mediaReadRoot] : [])],
        },
        networkAccess: false,
      },
    };
  }

  private async sendAcknowledgement(event: InboundTextEvent, runId: string): Promise<void> {
    this.status = "sending";
    const notice = event.source === "voice" ? VOICE_ACK_NOTICE : ACK_NOTICE;
    this.startTiming(event, runId, "acknowledgement");
    const result = await this.channel.sendText(event, notice).catch(() => ({ ok: false as const }));
    this.completeTiming(event, runId, "acknowledgement", result.ok ? "completed" : "unknown");
    this.appendAssistant(event, notice, result.ok ? "ack_accepted" : "ack_unknown");
    this.notice = result.ok
      ? "已发送处理回执，Codex 正在执行。"
      : "处理回执未确认送达；仍会执行一次并尝试发送最终结果。";
  }

  private appendAssistant(
    event: Pick<InboundTextEvent | InboundRejectedEvent, "accountId" | "target">,
    text: string,
    status: CodexTranscriptEntry["status"],
    businessResult?: StoredMainBusinessResult,
    replyFailure?: MainReplyFailureCode,
  ): CodexTranscriptEntry {
    const entry: CodexTranscriptEntry = {
      id: crypto.randomUUID(),
      accountId: event.accountId,
      target: event.target,
      role: "assistant",
      text,
      createdAt: this.now(),
      status,
      ...(businessResult ? { businessResult: structuredClone(businessResult) } : {}),
      ...(replyFailure ? { replyFailure } : {}),
    };
    this.state = {
      ...this.state,
      transcript: [...this.state.transcript, entry].slice(-200),
    };
    this.persistReplyState();
    return entry;
  }


  private targetKey(accountId: string, target: string): string {
    return `${accountId}\u0000${target}`;
  }

  private permissionCandidates(): Array<{ id: string; displayName: string; path: string }> {
    return this.runtimeWorkspaceRoots.map((root, index) => ({
      id: index === 0 ? "workspace" : index === 1 ? "demo-vault" : `root-${index + 1}`,
      displayName: index === 0 ? "codex-weixin 项目" : index === 1 ? "demo Vault" : `授权目录 ${index + 1}`,
      path: path.resolve(root),
    }));
  }
}
