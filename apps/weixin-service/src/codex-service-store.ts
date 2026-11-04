import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseMainReplyFailure, parseStoredMainBusinessResult, type MainReplyFailureCode, type StoredMainBusinessResult } from "./main-reply-result.js";

import type { ChatModelCatalog, ChatModelSetting, ChatModelTrack, CodexModelDescriptor, CodexReasoningEffort } from "./account-chat-model-settings.js";
import type { OutboundDeliveryDiagnostics, TypingInitializationDiagnostics } from "./demo-service.js";
import type { WorkflowPlannerDiagnostic } from "./workflow-intent-planner.js";

export type CodexTranscriptEntry = {
  id: string;
  accountId: string;
  target: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  status: "received" | "ack_accepted" | "ack_unknown" | "accepted" | "partial" | "agent_failed" | "send_failed";
  businessResult?: StoredMainBusinessResult;
  replyFailure?: MainReplyFailureCode;
};

export type CodexServiceState = {
  version: 6 | 7;
  targetSessions: Array<{
    accountId: string;
    target: string;
    threadId: string;
    threadProfile: "native-relay-v2";
    toolContractHash?: string;
    ownerBindingHash?: string;
    accessContextEpoch?: number;
  }>;
  accessContextEpoch?: number;
  permissions: PermissionState;
  enabledTargets: Array<{ accountId: string; target: string }>;
  processedKeys: string[];
  transcript: CodexTranscriptEntry[];
  runtimeRuns: TargetRuntimeRun[];
  modelSettings?: ChatModelSetting[];
  modelCatalog?: ChatModelCatalog;
};

export type TargetRunPhase = "queued" | "typing" | "thinking" | "tool" | "sending" | "completed" | "failed" | "interrupted";
export type TargetRuntimeStep = { itemHash: string; label: string; status: "running" | "completed" | "failed" | "blocked" | "unknown"; at: number };
export type TargetRunTimingStage = "inbound" | "queue" | "typing_start" | "acknowledgement" | "agent" | "typing_stop" | "outbound";
export type TargetRunTiming = {
  stage: TargetRunTimingStage;
  startedAt: number;
  completedAt?: number;
  outcome?: "completed" | "failed" | "unknown" | "unavailable" | "interrupted";
};
export type AgentRunTimingStage = "app_server_prepare" | "first_model_wait" | "model_reasoning" | "tool_execution" | "tool_result_wait" | "final_generation";
export type AgentRunTiming = {
  stage: AgentRunTimingStage;
  startedAt: number;
  completedAt?: number;
  outcome?: "completed" | "failed" | "unknown" | "interrupted";
  label?: "执行本地命令" | "修改文件" | "调用 MCP 工具" | "调用本地工具" | "协同处理" | "搜索网页" | "查看图片" | "整理会话上下文";
  correlationHash?: string;
};
export type TargetRuntimeRun = {
  accountId: string; target: string; runId: string; phase: TargetRunPhase; queueDepth: number;
  startedAt: number; updatedAt: number; completedAt?: number; activeTool?: string;
  recentSteps: TargetRuntimeStep[];
  timings: TargetRunTiming[];
  agentTimings: AgentRunTiming[];
  agentTimingsTruncated: boolean;
  typingDiagnostics?: TypingInitializationDiagnostics;
  outboundDiagnostics?: OutboundDeliveryDiagnostics;
  workflowPlannerDiagnostics?: WorkflowPlannerDiagnostic[];
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  modelSelectionSource?: "track" | "pinned";
  modelConfigRevision?: number;
};

export type PermissionMode = "safe" | "guarded_plus" | "advanced_controlled";

export type PermissionRoot = {
  id: string;
  canonicalPath: string;
  displayName: string;
};

export type PermissionState = {
  onboardingCompleted: boolean;
  mode: PermissionMode;
  roots: PermissionRoot[];
  networkPolicy: "readonly_retrieval";
  destructivePolicy: "block";
  revision: number;
};

const THREAD_ID = /^[0-9a-f-]{36}$/i;
const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^(?:[A-Za-z0-9._-]+@im\.wechat|feishu\.[0-9a-f]{64})$/;
const KEY = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parse(value: unknown): CodexServiceState {
  const root = record(value);
  if (!root || (root.version !== 1 && root.version !== 2 && root.version !== 3 && root.version !== 4 && root.version !== 5 && root.version !== 6 && root.version !== 7)) {
    throw new Error("Codex 服务状态格式无效");
  }
  if (root.vaultWriteEnabled !== undefined && typeof root.vaultWriteEnabled !== "boolean") {
    throw new Error("Codex 服务状态格式无效");
  }
  if (!Array.isArray(root.enabledTargets) || root.enabledTargets.length > 100) {
    throw new Error("Codex 服务状态格式无效");
  }
  const enabledTargets = root.enabledTargets.map((value) => {
    const item = record(value);
    if (
      !item ||
      typeof item.accountId !== "string" ||
      !ACCOUNT_ID.test(item.accountId) ||
      typeof item.target !== "string" ||
      !TARGET_ID.test(item.target)
    ) throw new Error("Codex 服务状态格式无效");
    return { accountId: item.accountId, target: item.target };
  });
  const targetSessions = root.version === 1
    ? []
    : (() => {
        if (!Array.isArray(root.targetSessions) || root.targetSessions.length > 100) {
          throw new Error("Codex 服务状态格式无效");
        }
        return root.targetSessions.map((value) => {
          const item = record(value);
          if (
            !item ||
            typeof item.accountId !== "string" || !ACCOUNT_ID.test(item.accountId) ||
            typeof item.target !== "string" || !TARGET_ID.test(item.target) ||
            typeof item.threadId !== "string" || !THREAD_ID.test(item.threadId) ||
            item.threadProfile !== "native-relay-v1" && item.threadProfile !== "native-relay-v2"
          ) throw new Error("Codex 服务状态格式无效");
          if (item.threadProfile === "native-relay-v1") return null;
          if (item.ownerBindingHash !== undefined && (typeof item.ownerBindingHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.ownerBindingHash))) throw new Error("Codex 服务状态格式无效");
          return {
            accountId: item.accountId,
            target: item.target,
            threadId: item.threadId,
            threadProfile: "native-relay-v2" as const,
            ...(typeof item.ownerBindingHash === "string" ? { ownerBindingHash: item.ownerBindingHash } : {}),
            ...(typeof item.toolContractHash === "string" && /^[a-f0-9]{64}$/u.test(item.toolContractHash)
              ? { toolContractHash: item.toolContractHash }
              : {}),
            accessContextEpoch: item.accessContextEpoch === undefined
              ? 0
              : parseAccessContextEpoch(item.accessContextEpoch),
          };
        }).filter((item): item is NonNullable<typeof item> => item !== null);
      })();
  if (!Array.isArray(root.processedKeys) || root.processedKeys.length > 1000) {
    throw new Error("Codex 服务状态格式无效");
  }
  const processedKeys = root.processedKeys.map((key) => {
    if (typeof key !== "string" || !KEY.test(key)) throw new Error("Codex 服务状态格式无效");
    return key;
  });
  if (!Array.isArray(root.transcript) || root.transcript.length > 200) {
    throw new Error("Codex 服务状态格式无效");
  }
  const transcript = root.transcript.map((value): CodexTranscriptEntry => {
    const item = record(value);
    const statuses = ["received", "ack_accepted", "ack_unknown", "accepted", "partial", "agent_failed", "send_failed"];
    if (
      !item ||
      typeof item.id !== "string" || item.id.length > 200 ||
      typeof item.accountId !== "string" || !ACCOUNT_ID.test(item.accountId) ||
      typeof item.target !== "string" || !TARGET_ID.test(item.target) ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.text !== "string" || Array.from(item.text).length > 12_000 ||
      !Number.isSafeInteger(item.createdAt) || (item.createdAt as number) <= 0 ||
      typeof item.status !== "string" || !statuses.includes(item.status)
    ) throw new Error("Codex 服务状态格式无效");
    return {
      id: item.id,
      accountId: item.accountId,
      target: item.target,
      role: item.role,
      text: item.text,
      createdAt: item.createdAt as number,
      status: item.status as CodexTranscriptEntry["status"],
      ...(item.businessResult === undefined ? {} : (() => {
        if (item.role !== "assistant") throw new Error("main_reply_record_invalid");
        return { businessResult: parseStoredMainBusinessResult(item.businessResult) };
      })()),
      ...(item.replyFailure === undefined ? {} : (() => {
        if (item.role !== "assistant" || item.businessResult !== undefined ||
            (item.status !== "agent_failed" && item.status !== "send_failed")) throw new Error("main_reply_record_invalid");
        return { replyFailure: parseMainReplyFailure(item.replyFailure) };
      })()),
    };
  });
  const permissions = root.version === 3 || root.version === 4 || root.version === 5 || root.version === 6 || root.version === 7
    ? parsePermissions(root.permissions)
    : defaultPermissions();
  const runtimeRuns = root.version === 4 || root.version === 5 || root.version === 6 || root.version === 7
    ? parseRuntimeRuns(root.runtimeRuns, root.version !== 4, root.version === 6 || root.version === 7)
    : [];
  const modelSettings = root.version === 7 ? parseModelSettings(root.modelSettings) : [];
  const modelCatalog = root.version === 7 ? parseModelCatalog(root.modelCatalog) : { fetchedAt: 0, models: [] };
  return {
    version: 7,
    targetSessions,
    accessContextEpoch: root.accessContextEpoch === undefined
      ? 0
      : parseAccessContextEpoch(root.accessContextEpoch),
    permissions,
    enabledTargets,
    processedKeys,
    transcript,
    runtimeRuns,
    modelSettings,
    modelCatalog,
  };
}

function parseAccessContextEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Codex 服务状态格式无效");
  }
  return value as number;
}

const REASONING_EFFORTS: CodexReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function parseModelSettings(value: unknown): ChatModelSetting[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Codex 服务状态格式无效");
  return value.map((raw): ChatModelSetting => {
    const item = record(raw);
    const selection = record(item?.selection);
    if (!item || typeof item.accountId !== "string" || !ACCOUNT_ID.test(item.accountId) || !selection ||
      !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 ||
      !Number.isSafeInteger(item.updatedAt) || (item.updatedAt as number) < 0 ||
      typeof selection.effort !== "string" || !REASONING_EFFORTS.includes(selection.effort as CodexReasoningEffort)) {
      throw new Error("Codex 服务状态格式无效");
    }
    const parsedSelection = selection.mode === "track" && (selection.track === "fast" || selection.track === "balanced" || selection.track === "quality")
      ? { mode: "track" as const, track: selection.track as ChatModelTrack, effort: selection.effort as CodexReasoningEffort }
      : selection.mode === "pinned" && typeof selection.model === "string" && /^[A-Za-z0-9._/@-]{1,120}$/.test(selection.model)
        ? { mode: "pinned" as const, model: selection.model, effort: selection.effort as CodexReasoningEffort }
        : null;
    if (!parsedSelection) throw new Error("Codex 服务状态格式无效");
    return { accountId: item.accountId, selection: parsedSelection, revision: item.revision as number, updatedAt: item.updatedAt as number };
  });
}

function parseModelCatalog(value: unknown): ChatModelCatalog {
  const item = record(value);
  if (!item || !Number.isSafeInteger(item.fetchedAt) || (item.fetchedAt as number) < 0 || !Array.isArray(item.models) || item.models.length > 200) {
    throw new Error("Codex 服务状态格式无效");
  }
  return { fetchedAt: item.fetchedAt as number, models: item.models.map(parseModelDescriptor) };
}

function parseModelDescriptor(raw: unknown): CodexModelDescriptor {
  const item = record(raw);
  if (!item || typeof item.model !== "string" || !/^[A-Za-z0-9._/@-]{1,120}$/.test(item.model) ||
    typeof item.displayName !== "string" || item.displayName.length < 1 || item.displayName.length > 120 ||
    typeof item.hidden !== "boolean" || !Array.isArray(item.inputModalities) || item.inputModalities.length > 10 ||
    !item.inputModalities.every((value) => typeof value === "string" && value.length <= 40) ||
    !Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length > REASONING_EFFORTS.length ||
    !item.supportedReasoningEfforts.every((value) => typeof value === "string" && REASONING_EFFORTS.includes(value as CodexReasoningEffort)) ||
    typeof item.defaultReasoningEffort !== "string" || !REASONING_EFFORTS.includes(item.defaultReasoningEffort as CodexReasoningEffort) ||
    (item.upgrade !== undefined && (typeof item.upgrade !== "string" || item.upgrade.length > 120))) {
    throw new Error("Codex 服务状态格式无效");
  }
  return {
    model: item.model,
    displayName: item.displayName,
    hidden: item.hidden,
    inputModalities: item.inputModalities as string[],
    supportedReasoningEfforts: item.supportedReasoningEfforts as CodexReasoningEffort[],
    defaultReasoningEffort: item.defaultReasoningEffort as CodexReasoningEffort,
    ...(item.upgrade ? { upgrade: item.upgrade as string } : {}),
  };
}

function parseTypingDiagnostics(value: unknown): TypingInitializationDiagnostics | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (!item || (item.ticketCache !== "hit" && item.ticketCache !== "miss")) {
    throw new Error("Codex 服务状态格式无效");
  }
  const parseStep = (value: unknown): TypingInitializationDiagnostics["getConfig"] => {
    const step = record(value);
    if (
      !step ||
      !Number.isSafeInteger(step.durationMs) ||
      (step.durationMs as number) < 0 ||
      (step.durationMs as number) > 60_000 ||
      (step.outcome !== "completed" && step.outcome !== "failed" && step.outcome !== "skipped") ||
      (step.outcome === "skipped" && step.durationMs !== 0)
    ) throw new Error("Codex 服务状态格式无效");
    return { durationMs: step.durationMs as number, outcome: step.outcome };
  };
  const diagnostics: TypingInitializationDiagnostics = {
    ticketCache: item.ticketCache,
    getConfig: parseStep(item.getConfig),
    sendStart: parseStep(item.sendStart),
  };
  const cacheHit = diagnostics.ticketCache === "hit";
  const configSkipped = diagnostics.getConfig.outcome === "skipped";
  const configFailed = diagnostics.getConfig.outcome === "failed";
  const sendSkipped = diagnostics.sendStart.outcome === "skipped";
  if (cacheHit !== configSkipped || configFailed !== sendSkipped) {
    throw new Error("Codex 服务状态格式无效");
  }
  return diagnostics;
}

function parseOutboundDiagnostics(value: unknown): OutboundDeliveryDiagnostics | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (
    !item ||
    !Number.isSafeInteger(item.requestCount) ||
    (item.requestCount as number) < 0 ||
    (item.requestCount as number) > 16
  ) throw new Error("Codex 服务状态格式无效");
  const parseStep = (value: unknown): OutboundDeliveryDiagnostics["prepare"] => {
    const step = record(value);
    if (
      !step ||
      !Number.isSafeInteger(step.durationMs) ||
      (step.durationMs as number) < 0 ||
      (step.durationMs as number) > 300_000 ||
      (step.outcome !== "completed" && step.outcome !== "failed" && step.outcome !== "skipped") ||
      (step.outcome === "skipped" && step.durationMs !== 0)
    ) throw new Error("Codex 服务状态格式无效");
    return { durationMs: step.durationMs as number, outcome: step.outcome };
  };
  const diagnostics: OutboundDeliveryDiagnostics = {
    prepare: parseStep(item.prepare),
    sendMessage: parseStep(item.sendMessage),
    responseRead: parseStep(item.responseRead),
    stateSave: parseStep(item.stateSave),
    requestCount: item.requestCount as number,
  };
  if (
    diagnostics.prepare.outcome === "skipped" ||
    (diagnostics.requestCount === 0 && (
      diagnostics.sendMessage.outcome !== "skipped" ||
      diagnostics.responseRead.outcome !== "skipped" ||
      diagnostics.stateSave.outcome !== "skipped"
    )) ||
    (diagnostics.requestCount > 0 && diagnostics.sendMessage.outcome === "skipped") ||
    (diagnostics.responseRead.outcome === "skipped" && diagnostics.stateSave.outcome !== "skipped")
  ) throw new Error("Codex 服务状态格式无效");
  return diagnostics;
}

function parseRuntimeRuns(value: unknown, hasTimings: boolean, hasAgentTimings: boolean): TargetRuntimeRun[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Codex 服务状态格式无效");
  const phases: TargetRunPhase[] = ["queued", "typing", "thinking", "tool", "sending", "completed", "failed", "interrupted"];
  const statuses: TargetRuntimeStep["status"][] = ["running", "completed", "failed", "blocked", "unknown"];
  const timingStages: TargetRunTimingStage[] = ["inbound", "queue", "typing_start", "acknowledgement", "agent", "typing_stop", "outbound"];
  const timingOutcomes: NonNullable<TargetRunTiming["outcome"]>[] = ["completed", "failed", "unknown", "unavailable", "interrupted"];
  const agentTimingStages: AgentRunTimingStage[] = ["app_server_prepare", "first_model_wait", "model_reasoning", "tool_execution", "tool_result_wait", "final_generation"];
  const agentTimingOutcomes: NonNullable<AgentRunTiming["outcome"]>[] = ["completed", "failed", "unknown", "interrupted"];
  const agentTimingLabels: NonNullable<AgentRunTiming["label"]>[] = ["执行本地命令", "修改文件", "调用 MCP 工具", "调用本地工具", "协同处理", "搜索网页", "查看图片", "整理会话上下文"];
  return value.map((value): TargetRuntimeRun => {
    const item = record(value);
    if (!item || typeof item.accountId !== "string" || !ACCOUNT_ID.test(item.accountId) || typeof item.target !== "string" || !TARGET_ID.test(item.target) || typeof item.runId !== "string" || !THREAD_ID.test(item.runId) || typeof item.phase !== "string" || !phases.includes(item.phase as TargetRunPhase) || !Number.isSafeInteger(item.queueDepth) || (item.queueDepth as number) < 0 || (item.queueDepth as number) > 100 || !Number.isSafeInteger(item.startedAt) || (item.startedAt as number) <= 0 || !Number.isSafeInteger(item.updatedAt) || (item.updatedAt as number) <= 0 || !Array.isArray(item.recentSteps) || item.recentSteps.length > 20) throw new Error("Codex 服务状态格式无效");
    const recentSteps = item.recentSteps.map((value): TargetRuntimeStep => {
      const step = record(value);
      if (!step || typeof step.itemHash !== "string" || !/^[0-9a-f]{64}$/.test(step.itemHash) || typeof step.label !== "string" || step.label.length < 1 || step.label.length > 40 || typeof step.status !== "string" || !statuses.includes(step.status as TargetRuntimeStep["status"]) || !Number.isSafeInteger(step.at) || (step.at as number) <= 0) throw new Error("Codex 服务状态格式无效");
      return { itemHash: step.itemHash, label: step.label, status: step.status as TargetRuntimeStep["status"], at: step.at as number };
    });
    const rawTimings = hasTimings ? item.timings : [];
    if (!Array.isArray(rawTimings) || rawTimings.length > 12) throw new Error("Codex 服务状态格式无效");
    const timings = rawTimings.map((value): TargetRunTiming => {
      const timing = record(value);
      if (!timing || typeof timing.stage !== "string" || !timingStages.includes(timing.stage as TargetRunTimingStage) || !Number.isSafeInteger(timing.startedAt) || (timing.startedAt as number) <= 0) throw new Error("Codex 服务状态格式无效");
      const completedAt = Number.isSafeInteger(timing.completedAt) && (timing.completedAt as number) > 0
        ? timing.completedAt as number
        : undefined;
      if (completedAt !== undefined && completedAt < (timing.startedAt as number)) throw new Error("Codex 服务状态格式无效");
      if (timing.outcome !== undefined && (typeof timing.outcome !== "string" || !timingOutcomes.includes(timing.outcome as NonNullable<TargetRunTiming["outcome"]>))) throw new Error("Codex 服务状态格式无效");
      return {
        stage: timing.stage as TargetRunTimingStage,
        startedAt: timing.startedAt as number,
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(timing.outcome !== undefined ? { outcome: timing.outcome as NonNullable<TargetRunTiming["outcome"]> } : {}),
      };
    });
    const rawAgentTimings = hasAgentTimings ? item.agentTimings : [];
    if (!Array.isArray(rawAgentTimings) || rawAgentTimings.length > 50) throw new Error("Codex 服务状态格式无效");
    const agentTimings = rawAgentTimings.map((value): AgentRunTiming => {
      const timing = record(value);
      if (!timing || typeof timing.stage !== "string" || !agentTimingStages.includes(timing.stage as AgentRunTimingStage) || !Number.isSafeInteger(timing.startedAt) || (timing.startedAt as number) <= 0) throw new Error("Codex 服务状态格式无效");
      const completedAt = Number.isSafeInteger(timing.completedAt) && (timing.completedAt as number) > 0
        ? timing.completedAt as number
        : undefined;
      if (completedAt !== undefined && completedAt < (timing.startedAt as number)) throw new Error("Codex 服务状态格式无效");
      if (timing.outcome !== undefined && (typeof timing.outcome !== "string" || !agentTimingOutcomes.includes(timing.outcome as NonNullable<AgentRunTiming["outcome"]>))) throw new Error("Codex 服务状态格式无效");
      const isTool = timing.stage === "tool_execution";
      if (isTool !== (typeof timing.label === "string" && agentTimingLabels.includes(timing.label as NonNullable<AgentRunTiming["label"]>))) throw new Error("Codex 服务状态格式无效");
      const isCorrelated = isTool || timing.stage === "model_reasoning";
      if (isCorrelated !== (typeof timing.correlationHash === "string" && /^[0-9a-f]{64}$/.test(timing.correlationHash))) throw new Error("Codex 服务状态格式无效");
      return {
        stage: timing.stage as AgentRunTimingStage,
        startedAt: timing.startedAt as number,
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(timing.outcome !== undefined ? { outcome: timing.outcome as NonNullable<AgentRunTiming["outcome"]> } : {}),
        ...(isTool ? { label: timing.label as NonNullable<AgentRunTiming["label"]> } : {}),
        ...(isCorrelated ? { correlationHash: timing.correlationHash as string } : {}),
      };
    });
    if (hasAgentTimings && typeof item.agentTimingsTruncated !== "boolean") throw new Error("Codex 服务状态格式无效");
    const hasModelMeta = typeof item.model === "string" && /^[A-Za-z0-9._/@-]{1,120}$/.test(item.model) && typeof item.reasoningEffort === "string" && REASONING_EFFORTS.includes(item.reasoningEffort as CodexReasoningEffort) && (item.modelSelectionSource === "track" || item.modelSelectionSource === "pinned") && Number.isSafeInteger(item.modelConfigRevision) && (item.modelConfigRevision as number) >= 0;
    if (item.model !== undefined && !hasModelMeta) throw new Error("Codex 服务状态格式无效");
    const typingDiagnostics = parseTypingDiagnostics(item.typingDiagnostics);
    const outboundDiagnostics = parseOutboundDiagnostics(item.outboundDiagnostics);
    const workflowPlannerDiagnostics = parseWorkflowPlannerDiagnostics(item.workflowPlannerDiagnostics);
    return { accountId: item.accountId, target: item.target, runId: item.runId, phase: item.phase as TargetRunPhase, queueDepth: item.queueDepth as number, startedAt: item.startedAt as number, updatedAt: item.updatedAt as number, ...(Number.isSafeInteger(item.completedAt) && (item.completedAt as number) > 0 ? { completedAt: item.completedAt as number } : {}), ...(typeof item.activeTool === "string" && item.activeTool.length <= 40 ? { activeTool: item.activeTool } : {}), recentSteps, timings, agentTimings, agentTimingsTruncated: hasAgentTimings ? item.agentTimingsTruncated as boolean : false, ...(typingDiagnostics ? { typingDiagnostics } : {}), ...(outboundDiagnostics ? { outboundDiagnostics } : {}), ...(workflowPlannerDiagnostics ? { workflowPlannerDiagnostics } : {}), ...(hasModelMeta ? { model: item.model as string, reasoningEffort: item.reasoningEffort as CodexReasoningEffort, modelSelectionSource: item.modelSelectionSource as "track" | "pinned", modelConfigRevision: item.modelConfigRevision as number } : {}) };
  });
}

function parseWorkflowPlannerDiagnostics(value: unknown): WorkflowPlannerDiagnostic[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error("Codex 服务状态格式无效");
  const phases: WorkflowPlannerDiagnostic["phase"][] = ["runtime", "initial", "repair"];
  const stages: WorkflowPlannerDiagnostic["stage"][] = ["app_server_prepare", "turn_accepted", "first_model_event", "structured_output"];
  const outcomes: WorkflowPlannerDiagnostic["outcome"][] = ["completed", "timeout", "failed", "not_reached"];
  const errorCodes: NonNullable<WorkflowPlannerDiagnostic["errorCode"]>[] = ["planner_timeout", "app_server_timeout", "turn_timeout", "planner_failed"];
  return value.map((candidate): WorkflowPlannerDiagnostic => {
    const item = record(candidate);
    if (!item || (item.attempt !== 1 && item.attempt !== 2) || item.generation !== item.attempt ||
        typeof item.phase !== "string" || !phases.includes(item.phase as WorkflowPlannerDiagnostic["phase"]) ||
        typeof item.stage !== "string" || !stages.includes(item.stage as WorkflowPlannerDiagnostic["stage"]) ||
        !Number.isSafeInteger(item.startedAt) || (item.startedAt as number) <= 0 ||
        !Number.isSafeInteger(item.completedAt) || (item.completedAt as number) < (item.startedAt as number) ||
        !Number.isSafeInteger(item.durationMs) || item.durationMs !== (item.completedAt as number) - (item.startedAt as number) ||
        typeof item.outcome !== "string" || !outcomes.includes(item.outcome as WorkflowPlannerDiagnostic["outcome"]) ||
        (item.errorCode !== undefined && (typeof item.errorCode !== "string" || !errorCodes.includes(item.errorCode as NonNullable<WorkflowPlannerDiagnostic["errorCode"]>)))) {
      throw new Error("Codex 服务状态格式无效");
    }
    return {
      attempt: item.attempt,
      generation: item.generation as 1 | 2,
      phase: item.phase as WorkflowPlannerDiagnostic["phase"],
      stage: item.stage as WorkflowPlannerDiagnostic["stage"],
      startedAt: item.startedAt as number,
      completedAt: item.completedAt as number,
      durationMs: item.durationMs as number,
      outcome: item.outcome as WorkflowPlannerDiagnostic["outcome"],
      ...(item.errorCode !== undefined ? { errorCode: item.errorCode as NonNullable<WorkflowPlannerDiagnostic["errorCode"]> } : {}),
    };
  });
}

function defaultPermissions(): PermissionState {
  return {
    onboardingCompleted: false,
    mode: "safe",
    roots: [],
    networkPolicy: "readonly_retrieval",
    destructivePolicy: "block",
    revision: 0,
  };
}

function parsePermissions(value: unknown): PermissionState {
  const item = record(value);
  const modes: PermissionMode[] = ["safe", "guarded_plus", "advanced_controlled"];
  if (
    !item ||
    typeof item.onboardingCompleted !== "boolean" ||
    typeof item.mode !== "string" || !modes.includes(item.mode as PermissionMode) ||
    !Array.isArray(item.roots) || item.roots.length > 20 ||
    item.networkPolicy !== "readonly_retrieval" ||
    item.destructivePolicy !== "block" ||
    !Number.isSafeInteger(item.revision) || (item.revision as number) < 0
  ) throw new Error("Codex 服务状态格式无效");
  const roots = item.roots.map((value): PermissionRoot => {
    const candidate = record(value);
    if (
      !candidate ||
      typeof candidate.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(candidate.id) ||
      typeof candidate.canonicalPath !== "string" || !path.isAbsolute(candidate.canonicalPath) ||
      typeof candidate.displayName !== "string" || candidate.displayName.length < 1 ||
      candidate.displayName.length > 80
    ) throw new Error("Codex 服务状态格式无效");
    return {
      id: candidate.id,
      canonicalPath: path.resolve(candidate.canonicalPath),
      displayName: candidate.displayName,
    };
  });
  return {
    onboardingCompleted: item.onboardingCompleted,
    mode: item.mode as PermissionMode,
    roots,
    networkPolicy: "readonly_retrieval",
    destructivePolicy: "block",
    revision: item.revision as number,
  };
}

export class CodexServiceStore {
  constructor(private readonly filePath: string) {}

  load(): CodexServiceState {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 7,
        targetSessions: [],
        accessContextEpoch: 0,
        permissions: defaultPermissions(),
        enabledTargets: [],
        processedKeys: [],
        transcript: [],
        runtimeRuns: [],
        modelSettings: [],
        modelCatalog: { fetchedAt: 0, models: [] },
      };
    }
    const file = fs.lstatSync(this.filePath);
    const directory = fs.statSync(path.dirname(this.filePath));
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || (directory.mode & 0o077)) {
      throw new Error("Codex 服务状态文件权限不安全");
    }
    try {
      return parse(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && error.message.includes("权限不安全")) throw error;
      throw new Error("Codex 服务状态格式无效");
    }
  }

  save(state: CodexServiceState): void {
    const normalized = parse(state);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.codex-service-${crypto.randomUUID()}.tmp`);
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(normalized), "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
}
