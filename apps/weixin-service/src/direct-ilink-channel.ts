import crypto from "node:crypto";
import { ChannelTransport, readChannelJson as readJson } from "./channel-transport.js";
import type { LocalDiagnostics } from "./local-diagnostics.js";

import type {
  ChannelSnapshot,
  CredentialStatus,
  InboundRejectedEvent,
  InboundTextEvent,
  LocalLabelUpdate,
  LoginHandle,
  OutboundDeliveryDiagnostics,
  SendTextResult,
  ScheduledTextSubmission,
  WeixinChannel,
} from "./demo-service.js";
import type { LoginOutputEvent } from "./login-output.js";
import { PrivateStateStore, type PrivateIlinkState } from "./private-state-store.js";
import { DurableInboundStore, type DurableInboundContext, type DurableInboundEnvelope, type DurableInboundJob } from "./durable-inbound-store.js";
import type { EffectIntent, EffectLedger, EffectRecord, EffectState } from "./durable-effect-ledger.js";
import { segmentWeixinText } from "./weixin-text-segmenter.js";
import { IlinkMediaStore, ILINK_CDN_BASE_URL, MAX_ILINK_MEDIA_BYTES, aesEcbPaddedSize, classifyLocalMedia, uploadEncryptedMedia, type IlinkMediaKind, type StoredIlinkMedia } from "./ilink-media.js";
import { IlinkTypingManager } from "./ilink-typing.js";
import fs from "node:fs";
import path from "node:path";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type DirectIlinkChannelOptions = {
  diagnostics?: LocalDiagnostics;
  store: PrivateStateStore;
  inboundStore?: DurableInboundStore;
  fetch?: FetchLike;
  loginTimeoutMs?: number;
  now?: () => number;
  mediaStore?: IlinkMediaStore;
  effectLedger?: EffectLedger;
};

type LoginStatus = {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
};

const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
const APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const BASE_INFO = {
  channel_version: "2.4.6",
  bot_agent: "WeixinDirectDemo/0.1.0",
};
const TARGET_ID = /^[A-Za-z0-9._-]+@im\.wechat$/;
const STALE_CREDENTIAL_CODE = -14;

function unsentResult(
  error: string,
  reason?: SendTextResult["reason"],
): SendTextResult {
  return {
    ok: false,
    messageIds: [],
    totalSegments: 0,
    acceptedSegments: 0,
    truncated: false,
    retriedSegments: 0,
    duplicatePossible: false,
    error,
    ...(reason ? { reason } : {}),
  };
}
const TEXT_ITEM_TYPE = 1;
const VOICE_ITEM_TYPE = 3;
const IMAGE_ITEM_TYPE = 2;
const FILE_ITEM_TYPE = 4;
const VIDEO_ITEM_TYPE = 5;
const MAX_VOICE_DURATION_MS = 60_000;

type OutboundDiagnosticStage = Exclude<keyof OutboundDeliveryDiagnostics, "requestCount">;

function emptyOutboundDiagnostics(): OutboundDeliveryDiagnostics {
  const skipped = (): OutboundDeliveryDiagnostics[OutboundDiagnosticStage] => ({
    durationMs: 0,
    outcome: "skipped",
  });
  return {
    prepare: skipped(),
    sendMessage: skipped(),
    responseRead: skipped(),
    stateSave: skipped(),
    requestCount: 0,
  };
}

function recordOutboundDiagnostic(
  diagnostics: OutboundDeliveryDiagnostics,
  stage: OutboundDiagnosticStage,
  durationMs: number,
  outcome: "completed" | "failed",
): void {
  const current = diagnostics[stage];
  current.durationMs += Math.max(0, durationMs);
  current.outcome = current.outcome === "failed" || outcome === "failed" ? "failed" : "completed";
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function loginHeaders(authenticated = false, token?: string): HeadersInit {
  const headers: Record<string, string> = {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": APP_CLIENT_VERSION,
  };
  if (authenticated) {
    headers["Content-Type"] = "application/json";
    headers.AuthorizationType = "ilink_bot_token";
    headers["X-WECHAT-UIN"] = randomWechatUin();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function allowedQrUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))
    );
  } catch {
    return false;
  }
}

function safeRedirectBase(host: unknown): string | null {
  if (typeof host !== "string" || !host) return null;
  try {
    const url = new URL(`https://${host}`);
    if (
      url.username ||
      url.password ||
      url.port ||
      (url.hostname !== "weixin.qq.com" && !url.hostname.endsWith(".weixin.qq.com"))
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export class DirectIlinkChannel implements WeixinChannel {
  private readonly transport: ChannelTransport;
  private state: PrivateIlinkState | null;
  private readonly stateLoadFailed: boolean;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly typingManager: IlinkTypingManager;
  private loginAbort: AbortController | null = null;
  private monitorAbort: AbortController | null = null;
  private monitoring: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private pendingPairCode: string | null = null;
  private pairCodeResolver: ((code: string) => void) | null = null;
  private credentialStatus: CredentialStatus = "usable";
  private readonly snapshotListeners = new Set<(snapshot: ChannelSnapshot) => void>();
  private readonly inboundListeners = new Set<(event: InboundTextEvent) => unknown>();
  private readonly inboundCommandHandlers = new Set<(event: InboundTextEvent) => boolean | Promise<boolean>>();
  private readonly rejectedListeners = new Set<(event: InboundRejectedEvent) => unknown>();
  private readonly recentOutboundClientIds = new Set<string>();
  private readonly dispatchOwner = crypto.randomUUID();
  private readonly drainingTargets = new Map<string, Promise<unknown>>();
  private drainScheduled = false;
  private inboundDispatchActive = false;

  constructor(private readonly options: DirectIlinkChannelOptions) {
    this.fetch = options.fetch ?? (globalThis.fetch as FetchLike);
    this.transport = new ChannelTransport(this.fetch, options.diagnostics);
    this.now = options.now ?? Date.now;
    this.typingManager = new IlinkTypingManager({
      getConfig: async (context) => {
        const state = this.state;
        if (!state || state.accountId !== context.accountId) throw new Error("微信直连账户已变化");
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 15_000);
        try {
          const response = await this.postAuthenticated(state.baseUrl, "ilink/bot/getconfig", {
            ilink_user_id: context.target,
            context_token: context.contextToken,
            base_info: BASE_INFO,
          }, abort.signal);
          return {
            ret: typeof response.ret === "number" ? response.ret : 0,
            typingTicket: typeof response.typing_ticket === "string" ? response.typing_ticket : "",
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      sendTyping: async (context, typingTicket, status) => {
        const state = this.state;
        if (!state || state.accountId !== context.accountId) throw new Error("微信直连账户已变化");
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 15_000);
        try {
          const response = await this.postAuthenticated(state.baseUrl, "ilink/bot/sendtyping", {
            ilink_user_id: context.target,
            typing_ticket: typingTicket,
            status,
            base_info: BASE_INFO,
          }, abort.signal);
          const ret = typeof response.ret === "number" ? response.ret : 0;
          if (ret !== 0) throw new Error("腾讯 iLink 拒绝 typing 状态");
        } finally {
          clearTimeout(timeout);
        }
      },
    }, this.now);
    try {
      const stored = options.store.load();
      if (stored && options.inboundStore) {
        options.inboundStore.bindCredentials(stored.accountId, bindingGeneration(stored), !stored.bindingGeneration);
        options.inboundStore.bootstrapCheckpoint({
          accountId: stored.accountId,
          getUpdatesBuf: stored.getUpdatesBuf,
          contexts: Object.entries(stored.contextTokens).flatMap(([target, contextToken]) => {
            const metadata = stored.targetMetadata?.[target];
            if (!metadata?.lastInboundAt || !metadata.contextUpdatedAt) return [];
            return [{
              target,
              contextToken,
              lastInboundAt: metadata.lastInboundAt,
              contextUpdatedAt: metadata.contextUpdatedAt,
              ...(metadata.contextGeneration ? { generation: metadata.contextGeneration } : {}),
            }];
          }),
        });
        const checkpoint = options.inboundStore.checkpoint(stored.accountId);
        this.state = checkpoint ? this.mergeCheckpoint(stored, checkpoint) : stored;
      } else {
        this.state = stored;
      }
      this.stateLoadFailed = false;
    } catch {
      this.state = null;
      this.stateLoadFailed = true;
    }
  }

  getDeliveryContext(accountId: string, target: string) {
    const state = this.state;
    if (!state || state.accountId !== accountId) return { credentialGeneration: "unavailable", contextGeneration: null, credentialStatus: "stale" as const };
    const persisted = this.options.store.load();
    if (!persisted || bindingGeneration(persisted) !== bindingGeneration(state)) {
      return { credentialGeneration: persisted ? bindingGeneration(persisted) : "unavailable", contextGeneration: null, credentialStatus: "stale" as const };
    }
    const durable = this.options.inboundStore?.checkpoint(accountId)?.contexts.find((context) => context.target === target);
    const currentToken = durable?.contextToken ?? persisted.contextTokens[target];
    const currentGeneration = durable?.generation ?? persisted.targetMetadata?.[target]?.contextGeneration;
    const token = state.contextTokens[target];
    const current = token === currentToken && (!currentGeneration || currentGeneration === state.targetMetadata?.[target]?.contextGeneration);
    return { credentialGeneration: bindingGeneration(state), credentialStatus: this.credentialStatus,
      contextGeneration: token && current ? state.targetMetadata?.[target]?.contextGeneration ?? crypto.createHash("sha256").update(`${token}\0${state.targetMetadata?.[target]?.contextUpdatedAt ?? 0}`).digest("hex") : null };
  }

  getSnapshot(): ChannelSnapshot {
    const state = this.state;
    if (!state) return { accounts: [], targets: [] };
    return {
      accounts: [
        {
          accountId: state.accountId,
          ...(state.accountLabel ? { label: state.accountLabel } : {}),
          credentialStatus: this.credentialStatus,
        },
      ],
      targets: Object.keys(state.contextTokens).map((target) => {
        const metadata = state.targetMetadata?.[target];
        return {
          accountId: state.accountId,
          target,
          ...(metadata?.label ? { label: metadata.label } : {}),
          ...(metadata?.lastInboundAt ? { lastInboundAt: metadata.lastInboundAt } : {}),
          ...(metadata?.contextUpdatedAt
            ? { contextUpdatedAt: metadata.contextUpdatedAt }
            : {}),
          ...(metadata?.lastSendAcceptedAt
            ? { lastSendAcceptedAt: metadata.lastSendAcceptedAt }
            : {}),
        };
      }),
    };
  }

  onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    this.publishSnapshotTo(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onInboundText(listener: (event: InboundTextEvent) => unknown): () => void {
    this.inboundListeners.add(listener);
    this.scheduleDurableDrain();
    return () => this.inboundListeners.delete(listener);
  }

  onInboundCommand(handler: (event: InboundTextEvent) => boolean | Promise<boolean>): () => void {
    this.inboundCommandHandlers.add(handler);
    this.scheduleDurableDrain();
    return () => this.inboundCommandHandlers.delete(handler);
  }

  onInboundRejected(listener: (event: InboundRejectedEvent) => unknown): () => void {
    this.rejectedListeners.add(listener);
    this.scheduleDurableDrain();
    return () => this.rejectedListeners.delete(listener);
  }

  activateInboundDispatch(): void {
    this.inboundDispatchActive = true;
    this.scheduleDurableDrain();
  }

  pauseInboundDispatch(): void {
    this.inboundDispatchActive = false;
  }

  updateLocalLabels(input: LocalLabelUpdate): void {
    const state = this.state;
    if (!state || input.accountId !== state.accountId) {
      throw new Error("未知的微信直连账户");
    }
    if (input.targetLabel !== undefined && !input.target) {
      throw new Error("目标别名缺少微信目标");
    }
    if (input.target && !state.contextTokens[input.target]) {
      throw new Error("未知的微信入站目标");
    }
    const targetMetadata = { ...(state.targetMetadata ?? {}) };
    if (input.target) {
      targetMetadata[input.target] = {
        ...(targetMetadata[input.target] ?? {}),
        ...(input.targetLabel !== undefined ? { label: input.targetLabel } : {}),
      };
    }
    const nextState: PrivateIlinkState = {
      ...state,
      ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
      ...(Object.keys(targetMetadata).length > 0 ? { targetMetadata } : {}),
    };
    this.options.store.save(nextState);
    const saved = this.options.store.load();
    if (!saved) throw new Error("本地别名保存失败");
    this.state = saved;
    this.publishSnapshot();
  }

  async start(): Promise<void> {
    if (this.closing) return;
    if (this.stateLoadFailed) throw new Error("微信直连私有状态不可用");
    if (!this.state || this.monitorAbort) return;
    const captured = this.state;
    const abort = new AbortController();
    this.monitorAbort = abort;
    try {
      const notifyResponse = await this.postAuthenticated(
        this.state.baseUrl,
        "ilink/bot/msg/notifystart",
        { base_info: BASE_INFO },
        abort.signal,
      );
      if (abort.signal.aborted || !this.state || bindingGeneration(this.state) !== bindingGeneration(captured)) return;
      if (this.hasStaleCredentialCode(notifyResponse)) {
        this.markCredentialStale(captured);
        return;
      }
    } catch {
      if (abort.signal.aborted) return;
      // This lifecycle notification is optional; the inbound monitor remains authoritative.
    }
    if (abort.signal.aborted || this.closing) return;
    this.prefetchRecentTypingTickets();
    this.monitoring = this.monitor(abort).catch(() => {
      if (this.monitorAbort === abort) this.monitorAbort = null;
    });
  }

  startLogin(
    onEvent: (event: LoginOutputEvent) => void,
    onExit: (result: { ok: boolean; message?: string }) => void,
  ): LoginHandle {
    if (this.stateLoadFailed) throw new Error("微信直连私有状态不可用，请先修复或移走状态文件");
    if (this.loginAbort) throw new Error("已有登录流程正在进行");
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    const abort = new AbortController();
    this.loginAbort = abort;
    this.pendingPairCode = null;
    let closed = false;
    const finish = (result: { ok: boolean; message?: string }) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (this.loginAbort === abort) this.loginAbort = null;
      onExit(result);
    };
    const timeout = setTimeout(() => {
      abort.abort();
      finish({ ok: false, message: "腾讯微信直连登录超时" });
    }, Math.max(this.options.loginTimeoutMs ?? 480_000, 1000));

    void this.runLogin(abort.signal, onEvent)
      .then(() => finish({ ok: true }))
      .catch(() => {
        if (!abort.signal.aborted) finish({ ok: false, message: "腾讯微信直连登录未完成" });
      });

    return {
      submitPairCode: (code: string) => {
        if (!/^\d{1,12}$/.test(code) || abort.signal.aborted) return;
        if (this.pairCodeResolver) {
          const resolve = this.pairCodeResolver;
          this.pairCodeResolver = null;
          resolve(code);
        } else {
          this.pendingPairCode = code;
        }
      },
      terminate() {
        abort.abort();
        finish({ ok: false, message: "腾讯微信直连登录已停止" });
      },
    };
  }

  async sendText(input: {
    accountId: string;
    target: string;
    message: string;
    scheduled?: ScheduledTextSubmission;
  }): Promise<SendTextResult> {
    const state = this.state;
    if (!state || input.accountId !== state.accountId) {
      return unsentResult("未知的微信直连账户", "unavailable");
    }
    if (this.credentialStatus === "stale") {
      return unsentResult("微信 bot 凭据已失效或暂停", "auth_stale");
    }
    const contextToken = state.contextTokens[input.target];
    if (!TARGET_ID.test(input.target) || !contextToken) {
      return unsentResult("目标尚未建立直连会话", "context_missing");
    }

    return this.sendTextWithContext(input, contextToken);
  }

  async sendImage(input: {
    accountId: string;
    target: string;
    filePath: string;
    operationId: string;
    caption?: string;
  }): Promise<SendTextResult> {
    const state = this.state;
    if (!state || input.accountId !== state.accountId) {
      return unsentResult("未知的微信直连账户", "unavailable");
    }
    if (this.credentialStatus === "stale") {
      return unsentResult("微信 bot 凭据已失效或暂停", "auth_stale");
    }
    const contextToken = state.contextTokens[input.target];
    if (!TARGET_ID.test(input.target) || !contextToken) {
      return unsentResult("目标尚未建立直连会话", "context_missing");
    }
    return this.sendMediaWithContext(input, contextToken, undefined, input.operationId);
  }

  async sendFile(input: { accountId: string; target: string; filePath: string; fileName?: string; operationId: string }): Promise<SendTextResult> {
    return this.sendImage(input);
  }

  async reconcileMediaOperation(operationId: string): Promise<
    | { status: "accepted" }
    | { status: "rejected"; errorCode: string }
    | { status: "unknown"; errorCode?: string }
  > {
    const ledger = this.options.effectLedger as (EffectLedger & { listByOperation?: (operationId: string) => EffectRecord[] }) | undefined;
    if (!ledger?.listByOperation) {
      return { status: "unknown", errorCode: "weixin_effect_ledger_unavailable" };
    }
    let records;
    try {
      records = ledger.listByOperation(operationId);
    } catch {
      return { status: "unknown", errorCode: "weixin_effect_operation_invalid" };
    }
    const finalAttempt = records.find((record) => record.kind === "weixin_media_send");
    if (finalAttempt?.state === "accepted") return { status: "accepted" };
    if (finalAttempt?.state === "rejected") return { status: "rejected", errorCode: "weixin_media_send_rejected" };
    if (finalAttempt) return { status: "unknown", errorCode: "weixin_media_send_unknown" };
    if (records.some((record) => record.state === "unknown" || record.state === "prepared")) {
      return { status: "unknown", errorCode: "weixin_media_stage_unknown" };
    }
    if (records.length > 0) return { status: "rejected", errorCode: "weixin_media_send_not_attempted" };
    return { status: "unknown", errorCode: "weixin_media_operation_missing" };
  }

  private async sendTextWithContext(
    input: { accountId: string; target: string; message: string; scheduled?: ScheduledTextSubmission },
    contextToken: string,
    causeEventKey?: string,
  ): Promise<SendTextResult> {
    const diagnostics = emptyOutboundDiagnostics();
    const planStartedAt = this.now();
    if (input.scheduled && (!input.scheduled.beforeSubmit() || !input.message || Array.from(input.message).length > 1500)) {
      return unsentResult("定时推送条件已变化，未提交本段", "context_missing");
    }
    const plan = input.scheduled ? { segments: [input.message], truncated: false } : segmentWeixinText(input.message);
    recordOutboundDiagnostic(diagnostics, "prepare", this.now() - planStartedAt, "completed");
    const acceptedIds: string[] = [];
    let retriedSegments = 0;
    const duplicatePossible = false;
    const operationId = input.scheduled?.operationId ?? crypto.randomUUID();

    for (const [ordinal, segment] of plan.segments.entries()) {
      const messageId = `weixin-direct:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      this.rememberOutboundClientId(messageId);
      let outcome = await this.sendTextSegment(
        input,
        contextToken,
        segment,
        messageId,
        diagnostics,
        { operationId, ordinal, ...(causeEventKey ? { causeEventKey } : {}) },
      );

      if (!input.scheduled && !outcome.ok && outcome.retryable && outcome.reason === "rejected") {
        retriedSegments += 1;
        outcome = await this.sendTextSegment(
          input,
          contextToken,
          segment,
          messageId,
          diagnostics,
          { operationId, ordinal, ...(causeEventKey ? { causeEventKey } : {}) },
        );
      }

      if (!outcome.ok) {
        return {
          ok: false,
          messageIds: acceptedIds,
          ...(acceptedIds.length ? { messageId: acceptedIds.at(-1)! } : {}),
          totalSegments: plan.segments.length,
          acceptedSegments: acceptedIds.length,
          truncated: plan.truncated,
          retriedSegments,
          duplicatePossible,
          diagnostics: structuredClone(diagnostics),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.providerRet !== undefined ? { providerRet: outcome.providerRet } : {}),
          ...(outcome.providerErrcode !== undefined
            ? { providerErrcode: outcome.providerErrcode }
            : {}),
        };
      }
      acceptedIds.push(messageId);
    }

    return {
      ok: true,
      messageId: acceptedIds.at(-1)!,
      messageIds: acceptedIds,
      totalSegments: plan.segments.length,
      acceptedSegments: acceptedIds.length,
      truncated: plan.truncated,
      retriedSegments,
      duplicatePossible,
      diagnostics: structuredClone(diagnostics),
    };
  }

  private async sendProgressWithContext(
    input: {
      accountId: string;
      target: string;
      runId: string;
      itemId: string;
      label: string;
      phase: "start" | "end";
      status?: "completed" | "failed" | "blocked" | "unknown";
    },
    contextToken: string,
    causeEventKey?: string,
  ): Promise<SendTextResult> {
    const state = this.state;
    if (!state || state.accountId !== input.accountId || this.credentialStatus === "stale") {
      return unsentResult("微信直连账户不可用");
    }
    const clientId = `weixin-progress:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    this.rememberOutboundClientId(clientId);
    const item = input.phase === "start"
      ? {
          type: 11,
          create_time_ms: this.now(),
          is_completed: false,
          tool_call_start_item: { tool_name: input.label, tool_call_id: input.itemId },
        }
      : {
          type: 12,
          create_time_ms: this.now(),
          is_completed: true,
          tool_call_result_item: {
            tool_name: input.label,
            tool_call_id: input.itemId,
            status: input.status ?? "unknown",
          },
        };
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    let attemptId: string | undefined;
    try {
      attemptId = this.prepareEffect({
        operationId: crypto.randomUUID(),
        ...(causeEventKey ? { causeEventKey } : {}),
        accountId: input.accountId,
        target: input.target,
        kind: "weixin_progress",
        clientId,
      });
      const response = await this.postAuthenticated(
        state.baseUrl,
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: input.target,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [item],
            context_token: contextToken,
            run_id: input.runId,
          },
          base_info: BASE_INFO,
        },
        abort.signal,
      );
      const ret = typeof response.ret === "number" ? response.ret : 0;
      const errcode = typeof response.errcode === "number" ? response.errcode : 0;
      if (ret !== 0 || errcode !== 0) {
        this.settleEffect(attemptId, "rejected", ret || errcode);
        return unsentResult("腾讯 iLink 拒绝运行进度", "rejected");
      }
      this.settleEffect(attemptId, "accepted");
      return { ok: true, messageId: clientId, messageIds: [clientId], totalSegments: 1, acceptedSegments: 1, truncated: false, retriedSegments: 0, duplicatePossible: false };
    } catch {
      if (attemptId || !this.options.effectLedger) {
        this.settleEffect(attemptId, "unknown");
        return unsentResult("腾讯 iLink 运行进度发送失败或超时", "unknown");
      }
      return unsentResult("本地出站账本不可用，未发送微信运行进度", "unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendMediaWithContext(
    input: { accountId: string; target: string; filePath: string; fileName?: string; caption?: string },
    contextToken: string,
    causeEventKey?: string,
    stableOperationId?: string,
  ): Promise<SendTextResult> {
    const state = this.state;
    if (!state || state.accountId !== input.accountId || this.credentialStatus === "stale") return unsentResult("微信直连账户不可用");
    const stat = fs.lstatSync(input.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ILINK_MEDIA_BYTES) return unsentResult("媒体文件无效或超过 100 MiB");
    const buffer = fs.readFileSync(input.filePath);
    const classified = classifyLocalMedia(input.filePath);
    const kind = classified.kind;
    const fileName = input.fileName ?? classified.fileName;
    if (!fileName || path.basename(fileName) !== fileName || Array.from(fileName).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })) return unsentResult("文件名无效", "rejected");
    const aesKey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString("hex");
    const rawMd5 = crypto.createHash("md5").update(buffer).digest("hex");
    const operationId = stableOperationId ?? crypto.randomUUID();
    let uploadUrlAttempt: string | undefined;
    try {
      uploadUrlAttempt = this.prepareEffect({ operationId, ...(causeEventKey ? { causeEventKey } : {}), accountId: input.accountId, target: input.target, kind: "weixin_media_upload_url" });
    } catch {
      return unsentResult("本地出站账本不可用，未请求媒体上传", "unavailable");
    }
    const uploadUrlAbort = new AbortController();
    const uploadUrlTimeout = setTimeout(() => uploadUrlAbort.abort(new DOMException("deadline", "TimeoutError")), 15_000);
    let upload: Record<string, unknown>;
    try {
      upload = await this.postAuthenticated(state.baseUrl, "ilink/bot/getuploadurl", { filekey, media_type: kind === "image" ? 1 : kind === "video" ? 2 : 3, to_user_id: input.target, rawsize: buffer.length, rawfilemd5: rawMd5, filesize: aesEcbPaddedSize(buffer.length), no_need_thumb: true, aeskey: aesKey.toString("hex"), base_info: BASE_INFO }, uploadUrlAbort.signal);
    } catch {
      this.settleEffect(uploadUrlAttempt, "unknown");
      return unsentResult("腾讯 iLink 媒体上传地址请求失败或超时", "unknown");
    } finally {
      clearTimeout(uploadUrlTimeout);
    }
    const uploadRet = typeof upload.ret === "number" ? upload.ret : 0;
    const uploadErrcode = typeof upload.errcode === "number" ? upload.errcode : 0;
    if (uploadRet !== 0 || uploadErrcode !== 0) {
      this.settleEffect(uploadUrlAttempt, "rejected", uploadRet || uploadErrcode);
      return unsentResult("腾讯 iLink 拒绝媒体上传请求", "rejected");
    }
    this.settleEffect(uploadUrlAttempt, "accepted");
    const uploadUrl = typeof upload.upload_full_url === "string" ? upload.upload_full_url : typeof upload.upload_param === "string" ? `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : "";
    if (!uploadUrl) return unsentResult("腾讯未返回媒体上传地址", "unavailable");
    let uploadAttempt: string | undefined;
    try {
      uploadAttempt = this.prepareEffect({ operationId, ...(causeEventKey ? { causeEventKey } : {}), accountId: input.accountId, target: input.target, kind: "weixin_media_upload" });
    } catch {
      return unsentResult("本地出站账本不可用，未上传媒体", "unavailable");
    }
    const mediaUploadAbort = new AbortController();
    const mediaUploadTimeout = setTimeout(() => mediaUploadAbort.abort(new DOMException("deadline", "TimeoutError")), 15_000);
    let downloadParam: string;
    try {
      downloadParam = await uploadEncryptedMedia({ buffer, uploadUrl, aesKey, transport: this.transport, signal: mediaUploadAbort.signal });
      this.settleEffect(uploadAttempt, "accepted");
    } catch {
      this.settleEffect(uploadAttempt, "unknown");
      return unsentResult("腾讯媒体 CDN 上传失败或结果未知", "unknown");
    } finally {
      clearTimeout(mediaUploadTimeout);
    }
    if (input.caption) {
      const captionResult = await this.sendTextWithContext({ accountId: input.accountId, target: input.target, message: input.caption }, contextToken, causeEventKey);
      if (!captionResult.ok) return captionResult;
    }
    const clientId = `weixin-direct:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"), encrypt_type: 1 };
    const item = kind === "image" ? { type: 2, image_item: { media, mid_size: aesEcbPaddedSize(buffer.length) } } : kind === "video" ? { type: 5, video_item: { media, video_size: aesEcbPaddedSize(buffer.length) } } : { type: 4, file_item: { media, file_name: fileName, len: String(buffer.length), md5: rawMd5 } };
    let sendAttempt: string | undefined;
    try {
      sendAttempt = this.prepareEffect({ operationId, ...(causeEventKey ? { causeEventKey } : {}), accountId: input.accountId, target: input.target, kind: "weixin_media_send", clientId });
    } catch {
      return unsentResult("本地出站账本不可用，未发送媒体消息", "unavailable");
    }
    const mediaSendAbort = new AbortController();
    const mediaSendTimeout = setTimeout(() => mediaSendAbort.abort(new DOMException("deadline", "TimeoutError")), 15_000);
    let response: Record<string, unknown>;
    try {
      response = await this.postAuthenticated(state.baseUrl, "ilink/bot/sendmessage", { msg: { from_user_id: "", to_user_id: input.target, client_id: clientId, message_type: 2, message_state: 2, item_list: [item], context_token: contextToken }, base_info: BASE_INFO }, mediaSendAbort.signal);
    } catch {
      this.settleEffect(sendAttempt, "unknown");
      return unsentResult("腾讯 iLink 媒体发送失败或结果未知", "unknown");
    } finally {
      clearTimeout(mediaSendTimeout);
    }
    const sendRet = typeof response.ret === "number" ? response.ret : 0;
    const sendErrcode = typeof response.errcode === "number" ? response.errcode : 0;
    if (sendRet !== 0 || sendErrcode !== 0) {
      this.settleEffect(sendAttempt, "rejected", sendRet || sendErrcode);
      return unsentResult("腾讯 iLink 拒绝媒体发送", "rejected");
    }
    this.settleEffect(sendAttempt, "accepted");
    this.recordSendAcceptance(input.accountId, input.target);
    return { ok: true, messageId: clientId, messageIds: [clientId], totalSegments: 1, acceptedSegments: 1, truncated: false, retriedSegments: 0, duplicatePossible: false };
  }

  private async sendTextSegment(
    input: { accountId: string; target: string; scheduled?: ScheduledTextSubmission },
    contextToken: string,
    message: string,
    messageId: string,
    diagnostics: OutboundDeliveryDiagnostics,
    effect: { operationId: string; ordinal: number; causeEventKey?: string },
  ): Promise<{
    ok: boolean;
    retryable: boolean;
    error?: string;
    reason?: SendTextResult["reason"];
    providerRet?: number;
    providerErrcode?: number;
  }> {
    const state = this.state;
    if (!state || input.accountId !== state.accountId) {
      return { ok: false, retryable: false, error: "微信直连账户已变化" };
    }
    if (this.credentialStatus === "stale") {
      return {
        ok: false,
        retryable: false,
        error: "微信 bot 凭据已失效或暂停",
        reason: "auth_stale",
      };
    }

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    const requestPreparedAt = this.now();
    let request: { url: URL; init: RequestInit };
    try {
      request = this.authenticatedRequest(
        state.baseUrl,
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: input.target,
            client_id: messageId,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: message } }],
            context_token: contextToken,
          },
          base_info: BASE_INFO,
        },
        abort.signal,
      );
      recordOutboundDiagnostic(diagnostics, "prepare", this.now() - requestPreparedAt, "completed");
    } catch {
      recordOutboundDiagnostic(diagnostics, "prepare", this.now() - requestPreparedAt, "failed");
      clearTimeout(timeout);
      return {
        ok: false,
        retryable: false,
        error: "腾讯 iLink 发送失败或超时",
        reason: "unknown",
      };
    }
    let attemptId: string | undefined;
    try {
      attemptId = this.prepareEffect({
        operationId: effect.operationId,
        ...(effect.causeEventKey ? { causeEventKey: effect.causeEventKey } : {}),
        accountId: input.accountId,
        target: input.target,
        kind: "weixin_text",
        clientId: messageId,
        ordinal: effect.ordinal,
      });
    } catch {
      clearTimeout(timeout);
      return {
        ok: false,
        retryable: false,
        error: "本地出站账本不可用，未发送微信消息",
        reason: "unavailable",
      };
    }
    if (input.scheduled && !input.scheduled.beforeSubmit()) {
      this.settleEffect(attemptId, "rejected");
      clearTimeout(timeout);
      return { ok: false, retryable: false, reason: "context_missing", error: "定时推送条件已变化，未提交本段" };
    }
    diagnostics.requestCount += 1;
    let rawResponse: Response;
    const sendStartedAt = this.now();
    try {
      rawResponse = await this.fetch(request.url, request.init);
      recordOutboundDiagnostic(diagnostics, "sendMessage", this.now() - sendStartedAt, "completed");
    } catch {
      this.settleEffect(attemptId, "unknown");
      recordOutboundDiagnostic(diagnostics, "sendMessage", this.now() - sendStartedAt, "failed");
      clearTimeout(timeout);
      return {
        ok: false,
        retryable: false,
        error: "腾讯 iLink 发送失败或超时",
        reason: "unknown",
      };
    }
    const responseStartedAt = this.now();
    let response: Record<string, unknown>;
    try {
      response = await readJson(rawResponse);
      recordOutboundDiagnostic(diagnostics, "responseRead", this.now() - responseStartedAt, "completed");
    } catch {
      this.settleEffect(attemptId, "unknown");
      recordOutboundDiagnostic(diagnostics, "responseRead", this.now() - responseStartedAt, "failed");
      clearTimeout(timeout);
      return {
        ok: false,
        retryable: false,
        error: "腾讯 iLink 发送失败或超时",
        reason: "unknown",
      };
    }
    try {
      const ret = typeof response.ret === "number" ? response.ret : 0;
      const errcode = typeof response.errcode === "number" ? response.errcode : 0;
      if (this.hasStaleCredentialCode(response)) {
        this.settleEffect(attemptId, "rejected", ret || errcode);
        this.markCredentialStale(state);
        return {
          ok: false,
          retryable: false,
          error: "微信 bot 凭据已失效或暂停",
          reason: "auth_stale",
          providerRet: ret,
          providerErrcode: errcode,
        };
      }
      if (ret === -2 || errcode === -2) {
        this.settleEffect(attemptId, "rejected", ret || errcode);
        return {
          ok: false,
          retryable: false,
          error: "微信发送上下文已失效",
          reason: "context_stale",
          providerRet: ret,
          providerErrcode: errcode,
        };
      }
      if (ret !== 0 || errcode !== 0) {
        this.settleEffect(attemptId, "rejected", ret || errcode);
        return {
          ok: false,
          retryable: true,
          error: "腾讯 iLink 拒绝发送",
          reason: "rejected",
          providerRet: ret,
          providerErrcode: errcode,
        };
      }
      this.settleEffect(attemptId, "accepted");
      const stateSaveStartedAt = this.now();
      const stateSaved = this.recordSendAcceptance(state.accountId, input.target);
      recordOutboundDiagnostic(
        diagnostics,
        "stateSave",
        this.now() - stateSaveStartedAt,
        stateSaved ? "completed" : "failed",
      );
      return { ok: true, retryable: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private prepareEffect(input: Omit<EffectIntent, "attemptId">): string | undefined {
    if (!this.options.effectLedger) return undefined;
    const attemptId = crypto.randomUUID();
    this.options.effectLedger.prepare({ attemptId, ...input });
    return attemptId;
  }

  private settleEffect(
    attemptId: string | undefined,
    outcome: Exclude<EffectState, "prepared">,
    providerCode?: number,
  ): void {
    if (!attemptId || !this.options.effectLedger) return;
    try {
      this.options.effectLedger.settle(attemptId, outcome, providerCode);
    } catch {
      // A prepared record remains conservatively unsafe when terminal persistence fails.
    }
  }

  private recordSendAcceptance(accountId: string, target: string): boolean {
    const latestState = this.state;
    if (latestState?.accountId !== accountId) return false;
    const nextState: PrivateIlinkState = {
      ...latestState,
      targetMetadata: {
        ...(latestState.targetMetadata ?? {}),
        [target]: {
          ...(latestState.targetMetadata?.[target] ?? {}),
          lastSendAcceptedAt: this.now(),
        },
      },
    };
    try {
      this.options.store.save(nextState);
      this.state = nextState;
      this.publishSnapshot();
      return true;
    } catch {
      // The channel already accepted the send; auxiliary metadata cannot reverse that fact.
      return false;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.inboundDispatchActive = false;
    this.typingManager.close();
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    const notifyStop = async () => {
      if (!this.state) return;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 5000);
      await this.postAuthenticated(
        this.state.baseUrl,
        "ilink/bot/msg/notifystop",
        { base_info: BASE_INFO },
        abort.signal,
      )
        .catch(() => {})
        .finally(() => clearTimeout(timeout));
    };
    this.closing = Promise.allSettled([this.monitoring, ...this.drainingTargets.values(), notifyStop()]).then(() => undefined);
    return this.closing;
  }

  private async runLogin(
    signal: AbortSignal,
    onEvent: (event: LoginOutputEvent) => void,
  ): Promise<void> {
    let qrSession = await this.requestQr(signal);
    onEvent({ kind: "qr", url: qrSession.qrUrl });
    let refreshCount = 0;
    let verifyCode: string | undefined;
    let scannedEmitted = false;
    let statusBaseUrl = LOGIN_BASE_URL;

    while (!signal.aborted) {
      const query = new URLSearchParams({ qrcode: qrSession.opaqueId });
      if (verifyCode) query.set("verify_code", verifyCode);
      let statusResponse: Response;
      try {
        statusResponse = await this.fetch(
          `${statusBaseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
          { method: "GET", headers: loginHeaders(), signal },
        );
      } catch {
        if (signal.aborted) throw new Error("腾讯登录已停止");
        await this.wait(1000, signal);
        continue;
      }
      const status = (await readJson(statusResponse)) as LoginStatus;
      if (status.status === "expired" || status.status === "verify_code_blocked") {
        refreshCount += 1;
        if (refreshCount > 3) throw new Error("腾讯二维码多次失效");
        qrSession = await this.requestQr(signal);
        verifyCode = undefined;
        scannedEmitted = false;
        onEvent({ kind: "qr", url: qrSession.qrUrl });
        continue;
      }
      if (status.status === "wait") {
        await this.wait(1000, signal);
        continue;
      }
      if (status.status === "scaned") {
        verifyCode = undefined;
        if (!scannedEmitted) {
          scannedEmitted = true;
          onEvent({ kind: "scanned" });
        }
        await this.wait(1000, signal);
        continue;
      }
      if (status.status === "need_verifycode") {
        onEvent({ kind: "pair_code_required" });
        verifyCode = await this.waitForPairCode(signal);
        continue;
      }
      if (status.status === "scaned_but_redirect") {
        const redirectBase = safeRedirectBase(status.redirect_host);
        if (!redirectBase) throw new Error("腾讯登录重定向无效");
        statusBaseUrl = redirectBase;
        continue;
      }
      if (status.status === "binded_redirect") {
        if (!this.state) throw new Error("腾讯已绑定，但本 Demo 没有对应凭据");
        onEvent({ kind: "already_connected" });
        return;
      }
      if (status.status !== "confirmed") throw new Error("腾讯登录尚未确认");
      if (!status.bot_token || !status.ilink_bot_id) throw new Error("腾讯登录凭据缺失");

      const nextState: PrivateIlinkState = {
        version: 1,
        bindingGeneration: crypto.randomUUID(),
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || LOGIN_BASE_URL,
        ...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
        getUpdatesBuf: "",
        contextTokens: {},
      };
      this.options.store.save(nextState);
      this.options.inboundStore?.bindCredentials(nextState.accountId, bindingGeneration(nextState));
      this.state = nextState;
      this.credentialStatus = "usable";
      this.publishSnapshot();
      onEvent({ kind: "connected" });
      return;
    }
    throw new Error("腾讯登录已停止");
  }

  private async requestQr(signal: AbortSignal): Promise<{ opaqueId: string; qrUrl: string }> {
    const qrResponse = await this.fetch(
      `${LOGIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      {
        method: "POST",
        headers: loginHeaders(true),
        body: JSON.stringify({
          local_token_list: this.state ? [this.state.token] : [],
        }),
        signal,
      },
    );
    const qr = await readJson(qrResponse);
    const opaqueId = qr.qrcode;
    const qrUrl = qr.qrcode_img_content;
    if (typeof opaqueId !== "string" || !opaqueId || !allowedQrUrl(qrUrl)) {
      throw new Error("腾讯二维码返回格式无效");
    }
    return { opaqueId, qrUrl };
  }

  private waitForPairCode(signal: AbortSignal): Promise<string> {
    if (this.pendingPairCode) {
      const code = this.pendingPairCode;
      this.pendingPairCode = null;
      return Promise.resolve(code);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pairCodeResolver = null;
        reject(new Error("腾讯登录已停止"));
      };
      this.pairCodeResolver = (code) => {
        signal.removeEventListener("abort", onAbort);
        resolve(code);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("腾讯登录已停止"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async postAuthenticated(
    baseUrl: string,
    endpoint: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const request = this.authenticatedRequest(baseUrl, endpoint, body, signal);
    return this.transport.json(request.url, request.init);
  }

  private authenticatedRequest(
    baseUrl: string,
    endpoint: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): { url: URL; init: RequestInit } {
    if (!this.state) throw new Error("微信直连尚未登录");
    return {
      url: new URL(endpoint, `${baseUrl.replace(/\/$/, "")}/`),
      init: {
        method: "POST",
        headers: loginHeaders(true, this.state.token),
        body: JSON.stringify(body),
        signal,
      },
    };
  }

  private async monitor(abort: AbortController): Promise<void> {
    while (!abort.signal.aborted && this.state) {
      const captured = this.state;
      try {
        const response = await this.postAuthenticated(
          this.state.baseUrl,
          "ilink/bot/getupdates",
          {
            get_updates_buf: this.state.getUpdatesBuf,
            base_info: BASE_INFO,
          },
          abort.signal,
        );
        if (!this.state || bindingGeneration(this.state) !== bindingGeneration(captured) || abort.signal.aborted) return;
        const ret = typeof response.ret === "number" ? response.ret : 0;
        const errcode = typeof response.errcode === "number" ? response.errcode : 0;
        if (ret === STALE_CREDENTIAL_CODE || errcode === STALE_CREDENTIAL_CODE) {
          this.markCredentialStale(captured);
          return;
        }
        if (ret !== 0 || errcode !== 0) {
          await this.wait(2000, abort.signal);
          continue;
        }

        const nextState: PrivateIlinkState = {
          ...this.state,
          getUpdatesBuf:
            typeof response.get_updates_buf === "string" && response.get_updates_buf
              ? response.get_updates_buf
              : this.state.getUpdatesBuf,
          contextTokens: { ...this.state.contextTokens },
        };
        let receivedContextToken = false;
        const inboundEvents: InboundTextEvent[] = [];
        const rejectedEvents: InboundRejectedEvent[] = [];
        const durableContexts: DurableInboundContext[] = [];
        const durableEnvelopes: DurableInboundEnvelope[] = [];
        if (Array.isArray(response.msgs)) {
          for (const message of response.msgs) {
            if (!message || typeof message !== "object" || Array.isArray(message)) continue;
            const record = message as Record<string, unknown>;
            if (
              typeof record.from_user_id === "string" &&
              TARGET_ID.test(record.from_user_id) &&
              typeof record.context_token === "string" &&
              record.context_token
            ) {
              nextState.contextTokens[record.from_user_id] = record.context_token;
              const observedAt = this.now();
              const contextGeneration = crypto.createHash("sha256").update(JSON.stringify([
                bindingGeneration(captured), record.from_user_id, record.context_token,
                record.message_id ?? null, record.seq ?? null, record.client_id ?? null, record.create_time_ms ?? null,
              ])).digest("hex").slice(0, 36);
              const sourceTime = record.create_time_ms;
              const lastInboundAt =
                typeof sourceTime === "number" &&
                Number.isSafeInteger(sourceTime) &&
                sourceTime > 0 &&
                sourceTime <= observedAt + 5 * 60_000
                  ? sourceTime
                  : observedAt;
              nextState.targetMetadata = {
                ...(nextState.targetMetadata ?? {}),
                [record.from_user_id]: {
                  ...(nextState.targetMetadata?.[record.from_user_id] ?? {}),
                  lastInboundAt,
                  contextUpdatedAt: observedAt,
                  contextGeneration,
                },
              };
              receivedContextToken = true;
              durableContexts.push({
                target: record.from_user_id,
                contextToken: record.context_token,
                lastInboundAt,
                contextUpdatedAt: observedAt,
                generation: contextGeneration,
              });

              const inbound = await this.createInboundTextEvent(record, {
                accountId: nextState.accountId,
                target: record.from_user_id,
                contextToken: record.context_token,
                receivedAt: lastInboundAt,
                observedAt,
              });
              if (inbound) {
                inboundEvents.push(inbound);
                durableEnvelopes.push({
                  eventKey: inbound.key,
                  accountId: inbound.accountId,
                  target: inbound.target,
                  messageId: inbound.messageId,
                  kind: "message",
                  source: inbound.source,
                  text: inbound.text,
                  ...(inbound.attachments ? { attachments: inbound.attachments } : {}),
                  ...(inbound.quote ? { quote: inbound.quote } : {}),
                  receivedAt: inbound.receivedAt,
                  observedAt: inbound.observedAt ?? observedAt,
                  contextToken: record.context_token,
                });
              } else {
                const rejected = this.createInboundRejectedEvent(record, {
                  accountId: nextState.accountId,
                  target: record.from_user_id,
                  contextToken: record.context_token,
                  receivedAt: lastInboundAt,
                });
                if (rejected) rejectedEvents.push(rejected);
                if (rejected) {
                  durableEnvelopes.push({
                    eventKey: rejected.key,
                    accountId: rejected.accountId,
                    target: rejected.target,
                    messageId: rejected.messageId,
                    kind: "rejected",
                    source: "voice",
                    text: "",
                    rejectionReason: rejected.reason,
                    ...(rejected.durationMs !== undefined ? { durationMs: rejected.durationMs } : {}),
                    receivedAt: rejected.receivedAt,
                    observedAt,
                    contextToken: record.context_token,
                  });
                }
              }
            }
          }
        }
        if (!this.state || bindingGeneration(this.state) !== bindingGeneration(captured) || abort.signal.aborted) return;
        const durable = this.options.inboundStore;
        if (durable) {
          durable.ingestBatch({
            accountId: nextState.accountId,
            nextCursor: nextState.getUpdatesBuf,
            contexts: durableContexts,
            envelopes: durableEnvelopes,
          });
          try {
            this.options.store.save(nextState);
          } catch {
            // SQLite is authoritative for the inbound cursor and target context checkpoint.
          }
        } else {
          this.options.store.save(nextState);
        }
        this.state = nextState;
        for (const envelope of durableEnvelopes) {
          if (envelope.kind !== "message") continue;
          this.typingManager.prefetch({
            accountId: envelope.accountId,
            target: envelope.target,
            contextToken: envelope.contextToken,
          });
        }
        if (receivedContextToken) this.publishSnapshot();
        if (durable) this.scheduleDurableDrain();
        else for (const event of inboundEvents) await this.publishInbound(event);
        if (!durable) for (const event of rejectedEvents) await this.publishRejected(event);
      } catch {
        if (abort.signal.aborted) return;
        await this.wait(2000, abort.signal);
      }
    }
  }

  private publishSnapshot(): void {
    for (const listener of this.snapshotListeners) this.publishSnapshotTo(listener);
  }

  private mergeCheckpoint(
    state: PrivateIlinkState,
    checkpoint: ReturnType<DurableInboundStore["checkpoint"]> & {},
  ): PrivateIlinkState {
    const contextTokens = { ...state.contextTokens };
    const targetMetadata = { ...(state.targetMetadata ?? {}) };
    for (const context of checkpoint.contexts) {
      contextTokens[context.target] = context.contextToken;
      targetMetadata[context.target] = {
        ...(targetMetadata[context.target] ?? {}),
        lastInboundAt: context.lastInboundAt,
        contextUpdatedAt: context.contextUpdatedAt,
        ...(context.generation ? { contextGeneration: context.generation } : {}),
      };
    }
    return {
      ...state,
      getUpdatesBuf: checkpoint.getUpdatesBuf,
      contextTokens,
      ...(Object.keys(targetMetadata).length > 0 ? { targetMetadata } : {}),
    };
  }

  private async createInboundTextEvent(
    record: Record<string, unknown>,
    context: { accountId: string; target: string; contextToken: string; receivedAt: number; observedAt: number },
  ): Promise<InboundTextEvent | null> {
    if (record.message_type !== 1) return null;
    if (
      typeof record.client_id === "string" &&
      this.recentOutboundClientIds.has(record.client_id)
    ) return null;
    if (!Array.isArray(record.item_list)) return null;
    let text = "";
    let source: InboundTextEvent["source"] = "text";
    for (const item of record.item_list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      if (value.type !== TEXT_ITEM_TYPE || !value.text_item || typeof value.text_item !== "object") continue;
      const candidate = (value.text_item as Record<string, unknown>).text;
      if (typeof candidate === "string" && candidate.trim()) {
        text = candidate.trim().slice(0, 8000);
        break;
      }
    }
    if (!text) {
      for (const item of record.item_list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        if (value.type !== VOICE_ITEM_TYPE || !value.voice_item || typeof value.voice_item !== "object") continue;
        const voice = value.voice_item as Record<string, unknown>;
        const duration = voice.playtime;
        const candidate = voice.text;
        if (
          typeof duration !== "number" ||
          !Number.isSafeInteger(duration) ||
          duration <= 0 ||
          duration > MAX_VOICE_DURATION_MS ||
          typeof candidate !== "string" ||
          !candidate.trim()
        ) return null;
        source = "voice";
        text = candidate.trim().slice(0, 8000);
        break;
      }
    }
    const messageId = typeof record.message_id === "string" && record.message_id
      ? record.message_id
      : "unknown";
    const keyMaterial = JSON.stringify([
      context.accountId, context.target, messageId, record.seq ?? null,
      record.client_id ?? null, record.create_time_ms ?? null,
    ]);
    const key = crypto.createHash("sha256").update(keyMaterial).digest("hex");
    const attachments: StoredIlinkMedia[] = [];
    let quote: InboundTextEvent["quote"];
    if (this.options.mediaStore) {
      let mediaOrdinal = 0;
      const materialize = async (item: Record<string, unknown>, quoted: boolean): Promise<void> => {
        const type = item.type;
        if (type === VOICE_ITEM_TYPE) return;
        const field = type === IMAGE_ITEM_TYPE ? "image_item" : type === FILE_ITEM_TYPE ? "file_item" : type === VIDEO_ITEM_TYPE ? "video_item" : "";
        if (!field || !item[field] || typeof item[field] !== "object") return;
        const payload = item[field] as Record<string, unknown>;
        const media = payload.media;
        if (!media || typeof media !== "object") return;
        const mediaRecord = media as Record<string, unknown>;
        const fullUrl = typeof mediaRecord.full_url === "string" ? mediaRecord.full_url : undefined;
        const encryptQueryParam = typeof mediaRecord.encrypt_query_param === "string" ? mediaRecord.encrypt_query_param : undefined;
        if (!fullUrl && !encryptQueryParam) return;
        const kind: IlinkMediaKind = type === IMAGE_ITEM_TYPE ? "image" : type === FILE_ITEM_TYPE ? "file" : "video";
        const imageHex = kind === "image" && typeof payload.aeskey === "string" ? Buffer.from(payload.aeskey, "hex").toString("base64") : undefined;
        const aes = imageHex ?? (typeof mediaRecord.aes_key === "string" ? mediaRecord.aes_key : undefined);
        const itemKey = crypto.createHash("sha256").update(`${key}:${mediaOrdinal++}`).digest("hex");
        const saved = await this.options.mediaStore!.materialize({ kind, ...(fullUrl ? { fullUrl } : {}), ...(encryptQueryParam ? { encryptQueryParam } : {}), ...(aes ? { aesKeyBase64: aes } : {}), target: context.target, messageKey: itemKey, quoted, ...(typeof payload.file_name === "string" ? { fileName: payload.file_name } : {}) });
        attachments.push(saved);
      };
      for (const raw of record.item_list) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        if ([IMAGE_ITEM_TYPE, VOICE_ITEM_TYPE, FILE_ITEM_TYPE, VIDEO_ITEM_TYPE].includes(Number(item.type))) {
          await materialize(item, false).catch(() => {});
        }
        const ref = item.ref_msg;
        if (ref && typeof ref === "object" && !Array.isArray(ref)) {
          const refRecord = ref as Record<string, unknown>;
          const refItem = refRecord.message_item;
          const quotedAttachments: StoredIlinkMedia[] = [];
          const before = attachments.length;
          if (refItem && typeof refItem === "object" && !Array.isArray(refItem)) await materialize(refItem as Record<string, unknown>, true).catch(() => {});
          quotedAttachments.push(...attachments.splice(before));
          const refValue = refItem && typeof refItem === "object" ? refItem as Record<string, unknown> : null;
          const refTextItem = refValue?.text_item;
          const refText = refTextItem && typeof refTextItem === "object" ? (refTextItem as Record<string, unknown>).text : undefined;
          quote = { ...(typeof refRecord.title === "string" ? { title: refRecord.title } : {}), ...(typeof refText === "string" ? { text: refText } : {}), attachments: quotedAttachments };
        }
      }
    }
    if (!text && attachments.length === 0 && (!quote || quote.attachments.length === 0)) return null;
    return {
      key,
      accountId: context.accountId,
      target: context.target,
      messageId,
      source: text ? source : "media",
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(quote ? { quote } : {}),
      receivedAt: context.receivedAt,
      observedAt: context.observedAt,
      startTyping: () => this.typingManager.start({
        accountId: context.accountId,
        target: context.target,
        contextToken: context.contextToken,
      }),
      replyProgress: (progress) => this.sendProgressWithContext(
        { accountId: context.accountId, target: context.target, ...progress },
        context.contextToken,
        key,
      ),
      replyText: (message) => this.sendTextWithContext(
        { accountId: context.accountId, target: context.target, message },
        context.contextToken,
        key,
      ),
      replyMedia: (filePath, caption) => this.sendMediaWithContext({ accountId: context.accountId, target: context.target, filePath, ...(caption ? { caption } : {}) }, context.contextToken, key),
    };
  }

  private async publishInbound(event: InboundTextEvent): Promise<void> {
    for (const handler of this.inboundCommandHandlers) {
      if (await handler(event)) return;
    }
    for (const listener of this.inboundListeners) {
      await listener(event);
    }
  }

  private scheduleDurableDrain(): void {
    const durable = this.options.inboundStore;
    const state = this.state;
    if (!durable || !state || !this.inboundDispatchActive || this.drainScheduled ||
        (this.inboundListeners.size === 0 && this.inboundCommandHandlers.size === 0 && this.rejectedListeners.size === 0)) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (!this.inboundDispatchActive || this.state?.accountId !== state.accountId) return;
      durable.blockExpiredLeases();
      for (const target of durable.queuedTargets(state.accountId)) {
        if (this.drainingTargets.has(target)) continue;
        const drain = this.drainDurableTarget(state.accountId, target).then((progressed) => {
          this.drainingTargets.delete(target);
          if (progressed) this.scheduleDurableDrain();
        }, () => {
          this.drainingTargets.delete(target);
        });
        this.drainingTargets.set(target, drain);
      }
    });
  }

  private async drainDurableTarget(accountId: string, target: string): Promise<boolean> {
    const durable = this.options.inboundStore;
    if (!durable) return false;
    let progressed = false;
    while (this.inboundListeners.size > 0 || this.inboundCommandHandlers.size > 0 || this.rejectedListeners.size > 0) {
      if (!this.inboundDispatchActive || this.state?.accountId !== accountId) return progressed;
      const head = durable.peekQueued(accountId, target);
      if (!head) return progressed;
      if (head.kind === "rejected" && this.rejectedListeners.size === 0) return progressed;
      if (head.kind === "message" && this.inboundListeners.size === 0 && this.inboundCommandHandlers.size === 0) return progressed;
      const lease = durable.leaseNext(accountId, target, this.dispatchOwner, 24 * 60 * 60 * 1000);
      if (!lease) return progressed;
      try {
        if (lease.kind === "message") await this.publishInbound(this.bindDurableMessage(lease));
        else await this.publishRejected(this.bindDurableRejected(lease));
        durable.complete(lease.eventKey, this.dispatchOwner, lease.revision);
        progressed = true;
      } catch {
        return progressed;
      }
    }
    return progressed;
  }

  private bindDurableMessage(job: DurableInboundJob): InboundTextEvent {
    this.typingManager.prefetch({
      accountId: job.accountId,
      target: job.target,
      contextToken: job.contextToken,
    });
    return {
      key: job.eventKey,
      accountId: job.accountId,
      target: job.target,
      messageId: job.messageId,
      source: job.source,
      text: job.text,
      ...(job.attachments ? { attachments: job.attachments } : {}),
      ...(job.quote ? { quote: job.quote } : {}),
      receivedAt: job.receivedAt,
      observedAt: job.observedAt,
      startTyping: () => this.typingManager.start({
        accountId: job.accountId,
        target: job.target,
        contextToken: job.contextToken,
      }),
      replyProgress: (progress) => this.sendProgressWithContext(
        { accountId: job.accountId, target: job.target, ...progress },
        job.contextToken,
        job.eventKey,
      ),
      replyText: (message) => this.sendTextWithContext(
        { accountId: job.accountId, target: job.target, message },
        job.contextToken,
        job.eventKey,
      ),
      replyMedia: (filePath, caption) => this.sendMediaWithContext(
        { accountId: job.accountId, target: job.target, filePath, ...(caption ? { caption } : {}) },
        job.contextToken,
        job.eventKey,
      ),
    };
  }

  private prefetchRecentTypingTickets(): void {
    const state = this.state;
    if (!state) return;
    const targets = Object.keys(state.contextTokens)
      .sort((left, right) =>
        (state.targetMetadata?.[right]?.contextUpdatedAt ?? 0) -
        (state.targetMetadata?.[left]?.contextUpdatedAt ?? 0),
      )
      .slice(0, 3);
    for (const target of targets) {
      const contextToken = state.contextTokens[target];
      if (!contextToken) continue;
      this.typingManager.prefetch({ accountId: state.accountId, target, contextToken });
    }
  }

  private bindDurableRejected(job: DurableInboundJob): InboundRejectedEvent {
    if (!job.rejectionReason) throw new Error("inbound_rejection_invalid");
    return {
      key: job.eventKey,
      accountId: job.accountId,
      target: job.target,
      messageId: job.messageId,
      source: "voice",
      reason: job.rejectionReason,
      ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
      receivedAt: job.receivedAt,
      replyText: (message) => this.sendTextWithContext(
        { accountId: job.accountId, target: job.target, message },
        job.contextToken,
        job.eventKey,
      ),
    };
  }

  private createInboundRejectedEvent(
    record: Record<string, unknown>,
    context: { accountId: string; target: string; contextToken: string; receivedAt: number },
  ): InboundRejectedEvent | null {
    if (record.message_type !== 1) return null;
    if (
      typeof record.client_id === "string" &&
      this.recentOutboundClientIds.has(record.client_id)
    ) return null;
    if (!Array.isArray(record.item_list)) return null;
    const item = record.item_list.find((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      return (candidate as Record<string, unknown>).type === VOICE_ITEM_TYPE;
    });
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const voiceItem = (item as Record<string, unknown>).voice_item;
    if (!voiceItem || typeof voiceItem !== "object" || Array.isArray(voiceItem)) return null;
    const voice = voiceItem as Record<string, unknown>;
    const duration = voice.playtime;
    const reason: InboundRejectedEvent["reason"] =
      typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0
        ? "voice_duration_invalid"
        : duration > MAX_VOICE_DURATION_MS
          ? "voice_too_long"
          : "voice_transcript_missing";
    const messageId = typeof record.message_id === "string" && record.message_id
      ? record.message_id
      : "unknown";
    const keyMaterial = JSON.stringify([
      context.accountId,
      context.target,
      messageId,
      record.seq ?? null,
      record.client_id ?? null,
      record.create_time_ms ?? null,
    ]);
    const key = crypto.createHash("sha256").update(keyMaterial).digest("hex");
    return {
      key,
      accountId: context.accountId,
      target: context.target,
      messageId,
      source: "voice",
      reason,
      ...(typeof duration === "number" && Number.isSafeInteger(duration)
        ? { durationMs: duration }
        : {}),
      receivedAt: context.receivedAt,
      replyText: (message) => this.sendTextWithContext(
        { accountId: context.accountId, target: context.target, message },
        context.contextToken,
        key,
      ),
    };
  }

  private async publishRejected(event: InboundRejectedEvent): Promise<void> {
    for (const listener of this.rejectedListeners) {
      await listener(event);
    }
  }

  private rememberOutboundClientId(clientId: string): void {
    this.recentOutboundClientIds.add(clientId);
    while (this.recentOutboundClientIds.size > 100) {
      const oldest = this.recentOutboundClientIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.recentOutboundClientIds.delete(oldest);
    }
  }

  private hasStaleCredentialCode(response: Record<string, unknown>): boolean {
    return (
      response.ret === STALE_CREDENTIAL_CODE ||
      response.errcode === STALE_CREDENTIAL_CODE
    );
  }

  private markCredentialStale(captured: PrivateIlinkState): void {
    if (!captured || !this.state || bindingGeneration(captured) !== bindingGeneration(this.state)) return;
    if (this.credentialStatus === "stale") return;
    this.credentialStatus = "stale";
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    this.publishSnapshot();
  }

  private publishSnapshotTo(listener: (snapshot: ChannelSnapshot) => void): void {
    try {
      listener(this.getSnapshot());
    } catch {
      // A presentation observer must not terminate the authoritative iLink monitor.
    }
  }
}

function bindingGeneration(state: PrivateIlinkState): string {
  return state.bindingGeneration ?? crypto.createHash("sha256").update(`${state.accountId}\0${state.token}`).digest("hex");
}
