import crypto from "node:crypto";

import type {
  WorkflowPendingSignal,
  WorkflowRunView,
  WorkflowSignal,
  WorkflowSignalReceipt,
} from "./workflow-engine.js";

export interface PendingResponseEnginePort {
  listPendingSignals(accountRef: string, targetRef: string, requesterRef?: string): WorkflowPendingSignal[];
  signal(signal: WorkflowSignal): Promise<WorkflowSignalReceipt>;
  cancelPending?(input: {
    cancellationId: string;
    signalRef: string;
    expectedRevision: number;
    accountRef: string;
    targetRef: string;
    requesterRef?: string;
  }): Promise<WorkflowSignalReceipt>;
  get(runId: string): WorkflowRunView | undefined;
}

export type PendingResponseInput = {
  trustedTurn: {
    eventKey: string;
    accountRef: string;
    targetRef: string;
    requesterRef?: string;
    occurredAt: number;
  };
  userText: string;
};

export type PendingResponseResult =
  | { owner: "chat" }
  | { owner: "chat"; kind: "new_goal"; goal: string }
  | { owner: "workflow"; kind: "resumed"; run: WorkflowRunView | undefined }
  | { owner: "workflow"; kind: "cancelled"; run: WorkflowRunView | undefined }
  | { owner: "workflow"; kind: "redisplay"; run: WorkflowRunView | undefined }
  | {
      owner: "workflow";
      kind: "refresh";
      reason: "selection_scope_changed" | "selected_missing" | "selected_changed" |
        "request_expired" | "request_closed" | "request_replaced";
      selectedLabels: string[];
      choices: string[];
      presentation?: Pick<WorkflowPendingSignal, "runId" | "signalRef" | "revision" | "expiresAt">;
    }
  | {
      owner: "workflow";
      kind: "clarify";
      reason: "request_closed" | "request_not_unique" | "multiple_requests" | "selection_invalid" |
        "semantic_ambiguous" | "stale";
    };

export type PendingResponseCoordinatorOptions = {
  engine: PendingResponseEnginePort;
  router?: PendingResponseRouter;
  presentations?: PendingPresentationStore;
  now?: () => number;
};

export type PendingPresentation = {
  accountRef: string;
  targetRef: string;
  requesterRef?: string;
  runId: string;
  signalRef: string;
  revision: number;
  requestTextHash: string;
  expiresAt: number;
  acceptedAt: number;
};

export interface PendingPresentationStore {
  get(accountRef: string, targetRef: string, requesterRef?: string): PendingPresentation | undefined;
  put(presentation: PendingPresentation): void;
}

export type PendingContextProjection = {
  userText: string;
  requests: Array<{
    requestRef: string;
    choices: Array<{ choiceRef: string; ordinal: number; label: string }>;
  }>;
};

export interface PendingResponseRouter {
  route(input: PendingContextProjection): Promise<unknown>;
}

const EXPLICIT_SELECTION = /^(?:请)?(?:选择|确认|发送)\s+(?:工作流\s+)?([a-f0-9]{6})\s+(?:第\s*)?(\d{1,2})(?:\s*个)?$/iu;
const BARE_ORDINAL = /^([1-9]\d?)$/u;

export class PendingResponseCoordinator {
  constructor(private readonly options: PendingResponseCoordinatorOptions) {}

  async handle(input: PendingResponseInput): Promise<PendingResponseResult> {
    const allPending = this.options.engine.listPendingSignals(
      input.trustedTurn.accountRef,
      input.trustedTurn.targetRef,
      input.trustedTurn.requesterRef,
    );
    const pending = allPending.filter((request) => request.expiresAt > (this.options.now?.() ?? Date.now()));
    const text = input.userText.trim();
    const explicit = EXPLICIT_SELECTION.exec(text);
    const bareOrdinal = explicit ? null : BARE_ORDINAL.exec(text);
    if (!explicit && !bareOrdinal) {
      const presented = this.presentedRequest(input, pending);
      if (presented && presented.presentation.requestTextHash === pendingRequestTextHash(text)) {
        return {
          owner: "workflow",
          kind: "redisplay",
          run: this.options.engine.get(presented.request.runId),
        };
      }
      if (pending.length === 0 || !this.options.router) return { owner: "chat" };
      const initialProjection = projectPending(text, pending);
      const routed = parseRouterResult(await this.options.router.route(initialProjection));
      if (routed.kind === "ordinary_message") return { owner: "chat" };
      if (routed.kind === "new_goal") {
        return { owner: "chat", kind: "new_goal", goal: routed.goal };
      }
      if (routed.kind === "cancel") {
        const initialRequestIndex = initialProjection.requests
          .findIndex((request) => request.requestRef === routed.requestRef);
        if (initialRequestIndex < 0) return { owner: "workflow", kind: "clarify", reason: "stale" };
        const initialRequest = pending[initialRequestIndex]!;
        const current = this.options.engine
          .listPendingSignals(input.trustedTurn.accountRef, input.trustedTurn.targetRef, input.trustedTurn.requesterRef)
          .filter((request) => request.expiresAt > (this.options.now?.() ?? Date.now()));
        const request = current.find((candidate) => samePendingRequest(candidate, initialRequest));
        if (!request) return { owner: "workflow", kind: "clarify", reason: "stale" };
        if (!this.options.engine.cancelPending) throw new Error("workflow_pending_cancel_unavailable");
        const receipt = await this.options.engine.cancelPending({
          cancellationId: `weixin-cancel:${crypto.createHash("sha256").update(input.trustedTurn.eventKey).digest("hex").slice(0, 32)}`,
          signalRef: request.signalRef,
          expectedRevision: request.revision,
          accountRef: input.trustedTurn.accountRef,
          targetRef: input.trustedTurn.targetRef,
          ...(input.trustedTurn.requesterRef ? { requesterRef: input.trustedTurn.requesterRef } : {}),
        });
        return { owner: "workflow", kind: "cancelled", run: this.options.engine.get(receipt.runId) };
      }
      if (routed.kind !== "respond") return { owner: "workflow", kind: "clarify", reason: "semantic_ambiguous" };
      const initialRequestIndex = initialProjection.requests
        .findIndex((request) => request.requestRef === routed.requestRef);
      if (initialRequestIndex < 0) return { owner: "workflow", kind: "clarify", reason: "stale" };
      const requestedRefs = new Set(routed.choiceRefs);
      const choiceIndexes = initialProjection.requests[initialRequestIndex]!.choices
        .map((choice, index) => requestedRefs.has(choice.choiceRef) ? index : -1)
        .filter((index) => index >= 0);
      if (choiceIndexes.length !== requestedRefs.size) {
        return { owner: "workflow", kind: "clarify", reason: "stale" };
      }
      const initialRequest = pending[initialRequestIndex]!;
      const currentNow = this.options.now?.() ?? Date.now();
      const current = this.options.engine
        .listPendingSignals(input.trustedTurn.accountRef, input.trustedTurn.targetRef, input.trustedTurn.requesterRef)
        .filter((request) => request.expiresAt > currentNow);
      const rebound = rebindSelections(current, initialRequest, choiceIndexes, currentNow);
      if (rebound.kind === "refresh") return { owner: "workflow", ...rebound };
      return this.submitSelections(input, rebound.request, rebound.choiceIndexes);
    }

    let matches: WorkflowPendingSignal[];
    if (explicit) {
      const reference = explicit[1]!.toLowerCase();
      matches = allPending.filter((request) => shortSignalReference(request.signalRef).startsWith(reference));
      if (matches.length === 0) return { owner: "workflow", kind: "clarify", reason: "request_closed" };
      if (matches.length !== 1) return { owner: "workflow", kind: "clarify", reason: "request_not_unique" };
    } else {
      const presented = this.presentedRequest(input, pending);
      if (!presented) {
        return pending.length > 1
          ? { owner: "workflow", kind: "clarify", reason: "multiple_requests" }
          : { owner: "chat" };
      }
      matches = [presented.request];
    }

    const initialRequest = matches[0]!;
    const ordinal = Number(explicit?.[2] ?? bareOrdinal?.[1]);
    const initialChoiceIndex = ordinal - 1;
    if (initialRequest.candidates[initialChoiceIndex] === undefined) {
      return { owner: "workflow", kind: "clarify", reason: "selection_invalid" };
    }
    const currentNow = this.options.now?.() ?? Date.now();
    const current = this.options.engine
      .listPendingSignals(input.trustedTurn.accountRef, input.trustedTurn.targetRef, input.trustedTurn.requesterRef)
      .filter((request) => request.expiresAt > currentNow);
    const rebound = rebindSelections(current, initialRequest, [initialChoiceIndex], currentNow);
    if (rebound.kind === "refresh") return { owner: "workflow", ...rebound };
    return this.submitSelections(input, rebound.request, rebound.choiceIndexes);
  }

  private presentedRequest(
    input: PendingResponseInput,
    pending: WorkflowPendingSignal[],
  ): { presentation: PendingPresentation; request: WorkflowPendingSignal } | undefined {
    const presentation = this.options.presentations?.get(
      input.trustedTurn.accountRef,
      input.trustedTurn.targetRef,
      input.trustedTurn.requesterRef,
    );
    if (!presentation || presentation.accountRef !== input.trustedTurn.accountRef ||
        presentation.targetRef !== input.trustedTurn.targetRef ||
        presentation.requesterRef !== input.trustedTurn.requesterRef ||
        presentation.expiresAt <= (this.options.now?.() ?? Date.now())) return undefined;
    const matches = pending.filter((request) => request.runId === presentation.runId &&
      request.signalRef === presentation.signalRef && request.revision === presentation.revision);
    return matches.length === 1 ? { presentation, request: matches[0]! } : undefined;
  }

  private async submitSelection(
    input: PendingResponseInput,
    request: WorkflowPendingSignal,
    choiceIndex: number,
  ): Promise<PendingResponseResult> {
    const selection = request.candidates[choiceIndex];
    if (selection === undefined) return { owner: "workflow", kind: "clarify", reason: "selection_invalid" };
    const receipt = await this.options.engine.signal({
      signalId: `weixin-signal:${crypto.createHash("sha256").update(input.trustedTurn.eventKey).digest("hex").slice(0, 32)}`,
      signalRef: request.signalRef,
      expectedRevision: request.revision,
      accountRef: input.trustedTurn.accountRef,
      targetRef: input.trustedTurn.targetRef,
      ...(input.trustedTurn.requesterRef ? { requesterRef: input.trustedTurn.requesterRef } : {}),
      selection: request.selectionMode === "multiple" ? [selection] : selection,
    });
    return { owner: "workflow", kind: "resumed", run: this.options.engine.get(receipt.runId) };
  }

  private async submitSelections(
    input: PendingResponseInput,
    request: WorkflowPendingSignal,
    choiceIndexes: number[],
  ): Promise<PendingResponseResult> {
    if (choiceIndexes.length === 1) return this.submitSelection(input, request, choiceIndexes[0]!);
    const selection = choiceIndexes.map((choiceIndex) => request.candidates[choiceIndex]);
    if (selection.length < 1 || selection.some((candidate) => candidate === undefined)) {
      return { owner: "workflow", kind: "clarify", reason: "selection_invalid" };
    }
    const receipt = await this.options.engine.signal({
      signalId: `weixin-signal:${crypto.createHash("sha256").update(input.trustedTurn.eventKey).digest("hex").slice(0, 32)}`,
      signalRef: request.signalRef,
      expectedRevision: request.revision,
      accountRef: input.trustedTurn.accountRef,
      targetRef: input.trustedTurn.targetRef,
      ...(input.trustedTurn.requesterRef ? { requesterRef: input.trustedTurn.requesterRef } : {}),
      selection,
    });
    return { owner: "workflow", kind: "resumed", run: this.options.engine.get(receipt.runId) };
  }
}

export function shortSignalReference(signalRef: string): string {
  const suffix = signalRef.includes(":") ? signalRef.slice(signalRef.lastIndexOf(":") + 1) : signalRef;
  return suffix.slice(0, 6).toLowerCase();
}

export function pendingRequestTextHash(text: string): string {
  const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function projectPending(userText: string, requests: WorkflowPendingSignal[]): PendingContextProjection {
  return {
    userText,
    requests: requests.map((request) => {
      const requestRef = opaqueReference(`${request.signalRef}:${request.revision}`);
      return {
        requestRef,
        choices: request.candidates.map((candidate, index) => ({
          choiceRef: opaqueReference(`${requestRef}:${index}:${canonicalJson(candidate)}`),
          ordinal: index + 1,
          label: candidateLabel(candidate, index),
        })),
      };
    }),
  };
}

function opaqueReference(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function samePendingRequest(current: WorkflowPendingSignal, initial: WorkflowPendingSignal): boolean {
  return current.signalRef === initial.signalRef && current.runId === initial.runId &&
    current.stepId === initial.stepId && current.revision === initial.revision &&
    current.selectionMode === initial.selectionMode &&
    canonicalJson(current.candidates) === canonicalJson(initial.candidates);
}

function rebindSelections(
  currentRequests: WorkflowPendingSignal[],
  initial: WorkflowPendingSignal,
  initialChoiceIndexes: number[],
  now: number,
):
  | { kind: "rebound"; request: WorkflowPendingSignal; choiceIndexes: number[] }
  | Omit<Extract<PendingResponseResult, { kind: "refresh" }>, "owner"> {
  const selectedLabels = initialChoiceIndexes.map((index) => candidateLabel(initial.candidates[index], index));
  const requests = currentRequests.filter((current) =>
    current.signalRef === initial.signalRef && current.runId === initial.runId &&
    current.stepId === initial.stepId && current.selectionMode === initial.selectionMode);
  if (requests.length !== 1) {
    return {
      kind: "refresh",
      reason: currentRequests.length > 0
        ? "request_replaced"
        : initial.expiresAt <= now ? "request_expired" : "request_closed",
      selectedLabels,
      ...refreshPresentation(currentRequests.length === 1 ? currentRequests[0] : undefined),
    };
  }
  const request = requests[0]!;
  const presentation = refreshPresentation(request);
  const initialIdentities = uniqueCandidateIdentities(initial.candidates);
  const currentIdentities = uniqueCandidateIdentities(request.candidates);
  if (!initialIdentities || !currentIdentities) {
    return { kind: "refresh", reason: "selected_changed", selectedLabels, ...presentation };
  }
  const selectedAll = initialChoiceIndexes.length === initial.candidates.length;
  if (selectedAll && !sameStringSet(initialIdentities, currentIdentities)) {
    return { kind: "refresh", reason: "selection_scope_changed", selectedLabels, ...presentation };
  }
  const currentIndexByIdentity = new Map(currentIdentities.map((identity, index) => [identity, index]));
  const choiceIndexes: number[] = [];
  for (const initialIndex of initialChoiceIndexes) {
    const identity = initialIdentities[initialIndex];
    if (identity === undefined) {
      return { kind: "refresh", reason: "selected_missing", selectedLabels, ...presentation };
    }
    const currentIndex = currentIndexByIdentity.get(identity);
    if (currentIndex === undefined) {
      return { kind: "refresh", reason: "selected_missing", selectedLabels, ...presentation };
    }
    if (candidateSemanticJson(initial.candidates[initialIndex]) !==
        candidateSemanticJson(request.candidates[currentIndex])) {
      return { kind: "refresh", reason: "selected_changed", selectedLabels, ...presentation };
    }
    choiceIndexes.push(currentIndex);
  }
  return { kind: "rebound", request, choiceIndexes };
}

function refreshPresentation(request: WorkflowPendingSignal | undefined) {
  if (!request) return { choices: [] };
  const { runId, signalRef, revision, expiresAt } = request;
  return { choices: candidateLabels(request.candidates), presentation: { runId, signalRef, revision, expiresAt } };
}

function candidateLabels(candidates: unknown[]): string[] {
  return candidates.map((candidate, index) => candidateLabel(candidate, index));
}

function uniqueCandidateIdentities(candidates: unknown[]): string[] | undefined {
  const identities = candidates.map(candidateStableIdentity);
  return new Set(identities).size === identities.length ? identities : undefined;
}

function candidateStableIdentity(candidate: unknown): string {
  if (typeof candidate === "string") return `string:${candidate.normalize("NFKC")}`;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return `value:${canonicalJson(candidate)}`;
  }
  const record = candidate as Record<string, unknown>;
  const rootId = normalizedIdentityPart(record.rootId);
  const relativePath = normalizedIdentityPart(record.relativePath);
  if (rootId && relativePath) return `path:${rootId}/${relativePath}`;
  const displayPath = normalizedIdentityPart(record.displayPath);
  if (displayPath) return `display:${displayPath}`;
  const rootName = normalizedIdentityPart(record.rootName);
  const fileName = normalizedIdentityPart(record.fileName);
  if (rootName && fileName) return `file:${rootName}/${fileName}`;
  for (const key of ["handle", "fileHandle", "noteHandle"]) {
    const handle = normalizedIdentityPart(record[key]);
    if (handle) return `${key}:${handle}`;
  }
  return `object:${canonicalJson(candidate)}`;
}

function normalizedIdentityPart(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.normalize("NFKC").trim()
    : undefined;
}

const VOLATILE_CANDIDATE_FIELDS = new Set([
  "expiresAt", "handle", "fileHandle", "noteHandle", "score", "matchSource", "matchCount",
]);

function candidateSemanticJson(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return canonicalJson(candidate);
  return canonicalJson(Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_CANDIDATE_FIELDS.has(key)),
  ));
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateLabel(candidate: unknown, index: number): string {
  if (typeof candidate === "string") return safeLabel(candidate) ?? `选项 ${index + 1}`;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return `选项 ${index + 1}`;
  const record = candidate as Record<string, unknown>;
  for (const key of ["fileName", "name", "title", "displayPath", "relativePath"]) {
    const label = safeLabel(record[key]);
    if (label) return label;
  }
  return `选项 ${index + 1}`;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  if (!label || label.length > 256 || label.startsWith("/") || containsControlCharacter(label)) return undefined;
  return label;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

type RouterResult =
  | { kind: "respond"; requestRef: string; choiceRefs: string[] }
  | { kind: "cancel"; requestRef: string }
  | { kind: "new_goal"; goal: string }
  | { kind: "clarify" }
  | { kind: "ordinary_message" };

function parseRouterResult(value: unknown): RouterResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "clarify" };
  const root = value as Record<string, unknown>;
  if (root.kind === "ordinary_message" && Object.keys(root).length === 1) return { kind: "ordinary_message" };
  if (root.kind === "clarify" && Object.keys(root).length === 1) return { kind: "clarify" };
  if (root.kind === "new_goal" && Object.keys(root).length === 2 && typeof root.goal === "string") {
    const goal = root.goal.trim();
    return goal.length >= 1 && goal.length <= 2_048 ? { kind: "new_goal", goal } : { kind: "clarify" };
  }
  if (root.kind === "cancel" && Object.keys(root).length === 2 &&
      typeof root.requestRef === "string" && /^[a-f0-9]{12}$/.test(root.requestRef)) {
    return { kind: "cancel", requestRef: root.requestRef };
  }
  if (root.kind === "respond" && Object.keys(root).length === 3 &&
      typeof root.requestRef === "string" && /^[a-f0-9]{12}$/.test(root.requestRef) &&
      Array.isArray(root.choiceRefs) && root.choiceRefs.length >= 1 && root.choiceRefs.length <= 100 &&
      root.choiceRefs.every((choiceRef) => typeof choiceRef === "string" && /^[a-f0-9]{12}$/.test(choiceRef)) &&
      new Set(root.choiceRefs).size === root.choiceRefs.length) {
    return { kind: "respond", requestRef: root.requestRef, choiceRefs: root.choiceRefs as string[] };
  }
  return { kind: "clarify" };
}
