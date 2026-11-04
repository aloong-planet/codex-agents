import type { TargetCandidate, CredentialStatus, AccountCandidate, ChannelSnapshot, SendTextResult, TypingLease } from "./channel-contract.js";
export type { TargetCandidate, CredentialStatus, AccountCandidate, ChannelSnapshot, SendTextResult, OutboundDeliveryDiagnosticStep, OutboundDeliveryDiagnostics, TypingInitializationDiagnosticStep, TypingInitializationDiagnostics, TypingLease } from "./channel-contract.js";
import type { LoginOutputEvent } from "./login-output.js";
import { settleCleanup } from "./async-cleanup.js";
import type { FixtureModelToolCall } from "./fixture-app-server-transport.js";
import type { PublicDailyAiNewsState } from "./daily-ai-news-scheduler.js";
import type { PublicCodexServiceState } from "./weixin-codex-service.js";
import type { PermissionSelection } from "./weixin-codex-service.js";
import {
  MemoryAutoBindingStore,
  type AutoBindingRecord,
  type AutoBindingStateStore,
} from "./auto-binding-store.js";
import { MAX_WEIXIN_LOGICAL_CODE_POINTS } from "./weixin-text-segmenter.js";
import type { StoredIlinkMedia } from "./ilink-media.js";
import type { ChatModelSelection } from "./account-chat-model-settings.js";
import type { MediaExportPublicState } from "./media-export-library.js";
import type { PublicWorkflowState } from "./workflow-engine.js";
import type {
  PublicWorkflowModulePermissionState,
  WorkflowModulePermissionSelection,
} from "./workflow-module-permission-settings.js";

export type DemoPhase =
  | "disconnected"
  | "configured"
  | "login_starting"
  | "awaiting_scan"
  | "scanned"
  | "pair_code_required"
  | "connected"
  | "account_stale"
  | "login_error"
  | "ready"
  | "sending"
  | "sent"
  | "send_error";

export type PublicDemoState = {
  phase: DemoPhase;
  accounts: AccountCandidate[];
  targets: TargetCandidate[];
  qrDataUrl: string | null;
  selectedAccountId: string | null;
  selectedTarget: string | null;
  notice: string;
  autoBinding: PublicAutoBindingState;
  codex?: PublicCodexServiceState;
  dailyNews?: PublicDailyAiNewsState;
  contextTokenExperiment?: import("./context-token-expiry-experiment.js").PublicContextTokenExperimentState;
  mediaExports?: MediaExportPublicState;
  workflows?: PublicWorkflowState;
  workflowModulePermissions?: PublicWorkflowModulePermissionState;
  fixtureOutbox?: FixtureOutboxEntry[];
  fixtureTextOutbox?: FixtureTextOutboxEntry[];
};

export type FixtureOutboxEntry = {
  kind: "file" | "image";
  fileName: string;
  displayPath: string;
  simulated: true;
  acceptedAt: number;
};

export type FixtureTextOutboxEntry = { message: string; simulated: true; acceptedAt: number };

export type PublicAutoBindingState = {
  status: AutoBindingRecord["status"];
  accountId?: string;
  target?: string;
  updatedAt?: number;
  reason?: "auth_stale" | "rejected" | "unknown";
};

export interface CodexServiceControl {
  getPublicState(): PublicCodexServiceState;
  enable(accountId: string, target: string): Promise<void>;
  disable(accountId: string, target: string): void;
  enableMemory(accountId: string): void;
  disableMemory(accountId: string): void;
  retryLatestMemoryFailure?(accountId: string): boolean;
  confirmMemoryNotificationTarget(accountId: string, target: string): void;
  openInCodexDesktop?(accountId: string, target: string): Promise<void>;
  enableVault(): void;
  disableVault(): void;
  configurePermissions(input: PermissionSelection): void;
  configureChatModel?(accountId: string, selection: ChatModelSelection): void;
  refreshModelCatalog?(): Promise<void>;
  close(): void | Promise<void>;
}

export interface DailyAiNewsControl {
  getPublicState(): PublicDailyAiNewsState;
  preview(): Promise<void>;
  sendPreview(accountId: string, target: string): Promise<void>;
  retryNow(): Promise<void>;
  enable(accountId: string, target: string): Promise<void>;
  disable(): void;
  close(): void | Promise<void>;
}

export interface ContextTokenExperimentControl {
  start(): void;
  getPublicState(): import("./context-token-expiry-experiment.js").PublicContextTokenExperimentState;
  close(): void | Promise<void>;
}

export interface MediaExportControl {
  getPublicState(): MediaExportPublicState;
  configure(input: { rootIds: string[]; confirmed: boolean }): MediaExportPublicState;
}

export interface WorkflowRunControl {
  getPublicState(): PublicWorkflowState;
}

export interface WorkflowModulePermissionControl {
  getPublicState(): PublicWorkflowModulePermissionState;
  configure(input: WorkflowModulePermissionSelection): PublicWorkflowModulePermissionState;
}

export type LocalLabelUpdate = {
  accountId: string;
  accountLabel?: string;
  target?: string;
  targetLabel?: string;
};

export type LoginHandle = {
  submitPairCode(code: string): void;
  terminate(): void;
};

export type InboundTextEvent = {
  key: string;
  accountId: string;
  target: string;
  messageId: string;
  source: "text" | "voice" | "media";
  text: string;
  attachments?: StoredIlinkMedia[];
  quote?: { title?: string; text?: string; attachments: StoredIlinkMedia[] };
  receivedAt: number;
  observedAt?: number;
  startTyping?(): Promise<TypingLease>;
  replyProgress?(progress: {
    runId: string;
    itemId: string;
    label: string;
    phase: "start" | "end";
    status?: "completed" | "failed" | "blocked" | "unknown";
  }): Promise<SendTextResult>;
  replyText(message: string): Promise<SendTextResult>;
  replyMedia?(filePath: string, caption?: string): Promise<SendTextResult>;
};

export type InboundRejectedEvent = {
  key: string;
  accountId: string;
  target: string;
  messageId: string;
  source: "voice";
  reason: "voice_too_long" | "voice_duration_invalid" | "voice_transcript_missing";
  durationMs?: number;
  receivedAt: number;
  replyText(message: string): Promise<SendTextResult>;
};

export type ChannelDeliveryContext = {
  credentialGeneration: string; contextGeneration: string | null; credentialStatus: CredentialStatus;
};
export type ScheduledTextSubmission = { operationId: string; beforeSubmit(): boolean };

export interface WeixinChannel {
  getDeliveryContext?(accountId: string, target: string): ChannelDeliveryContext;
  start(): Promise<void>;
  activateInboundDispatch?(): void;
  pauseInboundDispatch?(): void;
  getSnapshot(): ChannelSnapshot;
  onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void): () => void;
  onInboundCommand?(handler: (event: InboundTextEvent) => boolean | Promise<boolean>): () => void;
  onInboundText?(listener: (event: InboundTextEvent) => unknown): () => void;
  onInboundRejected?(listener: (event: InboundRejectedEvent) => unknown): () => void;
  emitFixtureInbound?(text?: string): Promise<void>;
  queueFixtureModelToolCall?(call: FixtureModelToolCall): void;
  queueFixtureModelToolCalls?(calls: FixtureModelToolCall[]): void;
  getFixtureOutbox?(): FixtureOutboxEntry[];
  getFixtureTextOutbox?(): FixtureTextOutboxEntry[];
  updateLocalLabels(input: LocalLabelUpdate): void;
  startLogin(
    onEvent: (event: LoginOutputEvent) => void,
    onExit: (result: { ok: boolean; message?: string }) => void,
  ): LoginHandle;
  sendText(input: {
    accountId: string;
    target: string;
    message: string;
    scheduled?: ScheduledTextSubmission;
  }): Promise<SendTextResult>;
  close(): void | Promise<void>;
}

type QrRenderer = (url: string) => Promise<string>;

const WEIXIN_TARGET = /^[A-Za-z0-9._-]+@im\.wechat$/;
const PAIR_CODE = /^\d{1,12}$/;
const WELCOME_MESSAGE = "你好，微信连接已成功，现在可以直接给我发指令了。";

function safeFailure(prefix: string): string {
  return `${prefix}。请查看本机 Demo 终端获取详细信息。`;
}

function toPublicAutoBinding(record: AutoBindingRecord): PublicAutoBindingState {
  if (record.status === "idle") return { status: "idle" };
  if (record.status === "awaiting_inbound") {
    return {
      status: record.status,
      accountId: record.accountId,
      updatedAt: record.updatedAt,
    };
  }
  return {
    status: record.status,
    accountId: record.accountId,
    target: record.target,
    updatedAt: record.updatedAt,
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

export class DemoService {
  private state: PublicDemoState;
  private loginHandle: LoginHandle | null = null;
  private loginGeneration = 0;
  private sendInFlight = false;
  private readonly sends = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private unsubscribeSnapshot: () => void = () => {};
  private unsubscribeInbound: () => void = () => {};
  private autoBinding: AutoBindingRecord;

  constructor(
    private readonly port: WeixinChannel,
    private readonly renderQr: QrRenderer,
    private readonly codex?: CodexServiceControl,
    private readonly dailyNews?: DailyAiNewsControl,
    private readonly autoBindingStore: AutoBindingStateStore = new MemoryAutoBindingStore(),
    private readonly contextTokenExperiment?: ContextTokenExperimentControl,
    private readonly mediaExports?: MediaExportControl,
    private readonly workflows?: WorkflowRunControl,
    private readonly workflowModulePermissions?: WorkflowModulePermissionControl,
  ) {
    const snapshot = port.getSnapshot();
    this.autoBinding = this.loadAutoBinding();
    this.state = {
      phase: snapshot.accounts.some((account) => account.credentialStatus === "stale")
        ? "account_stale"
        : snapshot.accounts.length > 0
          ? "configured"
          : "disconnected",
      accounts: snapshot.accounts.map((account) => ({ ...account })),
      targets: snapshot.targets.map((target) => ({ ...target })),
      qrDataUrl: null,
      selectedAccountId: null,
      selectedTarget: null,
      notice:
        snapshot.accounts.some((account) => account.credentialStatus === "stale")
          ? "微信 bot 凭据已失效或暂停；请重新连接后再发送。"
          : snapshot.accounts.length > 0
          ? "发现已配置的微信通道账户；仍需从微信发一条消息以建立或刷新会话。"
          : "尚未发现已配置的微信通道账户。",
      autoBinding: toPublicAutoBinding(this.autoBinding),
    };
    this.unsubscribeSnapshot = port.onSnapshotChanged((next) => this.applySnapshot(next));
    this.unsubscribeInbound = port.onInboundText?.((event) => this.onInbound(event)) ?? (() => {});
    this.restoreAutoBindingSelection();
  }

  getPublicState(): PublicDemoState {
    return {
      ...this.state,
      accounts: this.state.accounts.map((account) => ({ ...account })),
      targets: this.state.targets.map((item) => ({ ...item })),
      ...(this.codex ? { codex: this.codex.getPublicState() } : {}),
      ...(this.dailyNews ? { dailyNews: this.dailyNews.getPublicState() } : {}),
      ...(this.contextTokenExperiment
        ? { contextTokenExperiment: this.contextTokenExperiment.getPublicState() }
        : {}),
      ...(this.mediaExports ? { mediaExports: this.mediaExports.getPublicState() } : {}),
      ...(this.workflows ? { workflows: this.workflows.getPublicState() } : {}),
      ...(this.workflowModulePermissions
        ? { workflowModulePermissions: this.workflowModulePermissions.getPublicState() }
        : {}),
      ...(this.port.getFixtureOutbox
        ? { fixtureOutbox: this.port.getFixtureOutbox() }
        : {}),
      ...(this.port.getFixtureTextOutbox ? { fixtureTextOutbox: this.port.getFixtureTextOutbox() } : {}),
    };
  }

  async previewDailyNews(): Promise<void> {
    if (!this.dailyNews) throw new Error("每日 AI 新闻服务不可用");
    await this.dailyNews.preview();
  }

  async sendDailyNewsPreview(accountId: string, target: string): Promise<void> {
    if (!this.dailyNews) throw new Error("每日 AI 新闻服务不可用");
    await this.dailyNews.sendPreview(accountId, target);
  }

  async retryDailyNews(): Promise<void> {
    if (!this.dailyNews) throw new Error("每日 AI 新闻服务不可用");
    await this.dailyNews.retryNow();
  }

  async enableDailyNews(accountId: string, target: string): Promise<void> {
    if (!this.dailyNews) throw new Error("每日 AI 新闻服务不可用");
    await this.dailyNews.enable(accountId, target);
  }

  disableDailyNews(): void {
    if (!this.dailyNews) throw new Error("每日 AI 新闻服务不可用");
    this.dailyNews.disable();
  }

  async enableCodex(accountId: string, target: string): Promise<void> {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    await this.codex.enable(accountId, target);
  }

  disableCodex(accountId: string, target: string): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.disable(accountId, target);
  }

  enableCodexMemory(accountId: string): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.enableMemory(accountId);
  }

  disableCodexMemory(accountId: string): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.disableMemory(accountId);
  }

  retryLatestCodexMemoryFailure(accountId: string): boolean {
    if (!this.codex?.retryLatestMemoryFailure) throw new Error("账户记忆恢复功能不可用");
    return this.codex.retryLatestMemoryFailure(accountId);
  }

  confirmCodexMemoryNotificationTarget(accountId: string, target: string): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.confirmMemoryNotificationTarget(accountId, target);
  }

  async openCodexDesktop(accountId: string, target: string): Promise<void> {
    if (!this.codex?.openInCodexDesktop) throw new Error("Codex Desktop 查看功能不可用");
    await this.codex.openInCodexDesktop(accountId, target);
  }

  enableCodexVault(): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.enableVault();
  }

  disableCodexVault(): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.disableVault();
  }

  configureCodexPermissions(input: PermissionSelection): void {
    if (!this.codex) throw new Error("独立 Codex 服务不可用");
    this.codex.configurePermissions(input);
  }

  configureMediaExports(input: { rootIds: string[]; confirmed: boolean }): void {
    if (!this.mediaExports) throw new Error("微信图片外发目录功能不可用");
    this.mediaExports.configure(input);
  }

  configureWorkflowModulePermissions(input: WorkflowModulePermissionSelection): void {
    if (!this.workflowModulePermissions) throw new Error("工作流模块权限功能不可用");
    this.workflowModulePermissions.configure(input);
  }

  configureCodexChatModel(accountId: string, selection: ChatModelSelection): void {
    if (!this.codex?.configureChatModel) throw new Error("回复模型配置功能不可用");
    this.codex.configureChatModel(accountId, selection);
  }

  async refreshCodexModelCatalog(): Promise<void> {
    if (!this.codex?.refreshModelCatalog) throw new Error("模型目录刷新功能不可用");
    await this.codex.refreshModelCatalog();
  }

  async discoverTargets(): Promise<void> {
    const snapshot = this.port.getSnapshot();
    this.applySnapshot(snapshot);
    this.state = {
      ...this.state,
      notice:
        snapshot.targets.length > 0
          ? "已从直连会话状态同步入站目标。新连接的首条消息会自动完成绑定。"
          : "直连会话中尚未发现入站目标；请先从微信给 bot 发一条消息后重试。",
    };
  }

  async emitFixtureInbound(text?: string): Promise<void> {
    if (!this.port.emitFixtureInbound) throw new Error("仅 fixture 测试模式支持此操作");
    await this.port.emitFixtureInbound(text);
  }

  async emitFixtureWorkflowInbound(text?: string, modelToolCalls?: FixtureModelToolCall[]): Promise<void> {
    if (!this.port.emitFixtureInbound || !this.codex || !this.workflowModulePermissions) {
      throw new Error("仅 fixture 测试模式支持此操作");
    }
    const module = this.workflowModulePermissions.getPublicState().modules.find((item) => item.moduleId === "notes");
    if (!module) throw new Error("fixture 笔记模块不可用");
    if (!module.saved) {
      this.workflowModulePermissions.configure({
        moduleId: module.moduleId,
        expectedRevision: module.revision,
        confirmed: true,
        scopes: module.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: false })),
      });
    }
    const target = this.port.getSnapshot().targets[0];
    if (!target) throw new Error("fixture 测试目标不可用");
    await this.codex.enable(target.accountId, target.target);
    if (modelToolCalls?.length) {
      if (!this.port.queueFixtureModelToolCalls) throw new Error("fixture 模型工具注入不可用");
      this.port.queueFixtureModelToolCalls(modelToolCalls);
    }
    await this.port.emitFixtureInbound(text);
  }

  saveLocalLabels(input: LocalLabelUpdate): void {
    this.port.updateLocalLabels(input);
  }

  startLogin(): void {
    if (this.loginHandle) throw new Error("已有登录流程正在进行");
    if (this.sendInFlight) throw new Error("真实发送正在进行，暂不能重新绑定");
    if (this.autoBinding.status === "sending") {
      throw new Error("自动问候正在发送，暂不能重新绑定");
    }
    this.saveAutoBinding({ version: 1, status: "idle" });
    const generation = ++this.loginGeneration;
    this.state = {
      ...this.state,
      phase: "login_starting",
      qrDataUrl: null,
      notice: "正在直接向腾讯 iLink 请求真实二维码……",
    };

    try {
      this.loginHandle = this.port.startLogin(
        (event) => void this.onLoginEvent(generation, event),
        (result) => this.onLoginExit(generation, result),
      );
    } catch (error) {
      this.state = {
        ...this.state,
        phase: "login_error",
        qrDataUrl: null,
        notice: safeFailure("微信直连登录无法启动"),
      };
      throw error;
    }
  }

  submitPairCode(code: string): void {
    if (this.state.phase !== "pair_code_required" || !this.loginHandle) {
      throw new Error("当前不需要配对码");
    }
    const trimmed = code.trim();
    if (!PAIR_CODE.test(trimmed)) throw new Error("配对码格式无效");
    this.loginHandle.submitPairCode(trimmed);
    this.state = {
      ...this.state,
      phase: "scanned",
      notice: "数字码已提交给腾讯 iLink，正在等待微信确认。",
    };
  }

  confirmSession(input: {
    accountId: string;
    target: string;
    inboundConfirmed: boolean;
  }): void {
    if (!input.inboundConfirmed) throw new Error("请先确认已经从微信给 bot 发过一条消息");
    const account = this.state.accounts.find((item) => item.accountId === input.accountId);
    if (!account) throw new Error("未知的微信通道账户");
    if (account.credentialStatus === "stale") throw new Error("微信 bot 凭据已失效，请重新连接");
    const target = input.target.trim();
    if (!WEIXIN_TARGET.test(target)) throw new Error("微信目标格式无效");
    if (
      !this.state.targets.some(
        (candidate) => candidate.accountId === input.accountId && candidate.target === target,
      )
    ) {
      throw new Error("尚未发现该直连入站目标，请先发送消息并重新查找");
    }

    this.state = {
      ...this.state,
      phase: "ready",
      selectedAccountId: input.accountId,
      selectedTarget: target,
      notice: "已记录你的入站消息与目标确认；发送时仍会由真实渠道验证会话。",
    };
  }

  sendTestMessage(message: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error("service_closed"));
    const sending = this.performTestSend(message);
    this.sends.add(sending);
    void sending.then(() => this.sends.delete(sending), () => this.sends.delete(sending));
    return sending;
  }

  private async performTestSend(message: string): Promise<void> {
    if (
      this.state.selectedAccountId &&
      !this.state.accounts.some(
        (account) =>
          account.accountId === this.state.selectedAccountId &&
          account.credentialStatus === "usable",
      )
    ) {
      throw new Error("微信 bot 凭据已失效，请重新连接");
    }
    if (
      !["ready", "sent", "send_error"].includes(this.state.phase) ||
      !this.state.selectedAccountId ||
      !this.state.selectedTarget
    ) {
      throw new Error("尚未完成入站消息与目标确认");
    }
    if (this.sendInFlight) throw new Error("已有一条测试消息正在发送");
    const normalized = message.trim();
    if (!normalized) throw new Error("测试消息不能为空");
    if (Array.from(normalized).length > MAX_WEIXIN_LOGICAL_CODE_POINTS) {
      throw new Error("测试消息不能超过 12000 个字符");
    }
    if (/[^\t\n\r\x20-\u{10FFFF}]/u.test(normalized)) throw new Error("测试消息包含不支持的控制字符");

    const accountId = this.state.selectedAccountId;
    const target = this.state.selectedTarget;

    this.sendInFlight = true;
    this.state = { ...this.state, phase: "sending", notice: "正在调用真实微信通道发送……" };
    try {
      const result = await this.port.sendText({
        accountId,
        target,
        message: normalized,
      });
      if (!result.ok) {
        if (result.reason === "auth_stale") {
          this.state = {
            ...this.state,
            phase: "account_stale",
            notice: "微信 bot 凭据已失效或暂停；请重新连接后再发送。没有自动重试。",
          };
          throw new Error("微信 bot 凭据已失效，请重新连接；没有自动重试");
        }
        const accepted = result.acceptedSegments ?? 0;
        if (accepted > 0) {
          const total = result.totalSegments ?? "?";
          this.state = {
            ...this.state,
            phase: "send_error",
            notice: `测试消息已接受 ${accepted}/${total} 段；后续段发送失败，不会自动重发整篇。${result.duplicatePossible ? " 某段曾超时并重试，可能重复。" : ""}`,
          };
          throw new Error(`发送仅完成 ${accepted}/${total} 段；不会自动重发整篇`);
        }
        this.state = {
          ...this.state,
          phase: "send_error",
          notice:
            "发送失败或送达状态未知；请先从微信重新发一条消息刷新上下文，再由你主动重试。没有自动重试。",
        };
        throw new Error("发送失败或送达状态未知；没有自动重试");
      }
      const accountBecameStale = this.state.accounts.some(
        (account) =>
          account.accountId === accountId && account.credentialStatus === "stale",
      );
      this.state = {
        ...this.state,
        phase: accountBecameStale ? "account_stale" : "sent",
        notice: accountBecameStale
          ? "渠道已接受本次发送；同时账户凭据已被标记为失效或暂停，后续发送需重新连接。"
          : `${(result.totalSegments ?? 1) > 1 ? `${result.totalSegments} 段已被渠道接受，请在微信端确认是否收到。` : "渠道已接受发送，请在微信端确认是否收到。"}${result.truncated ? " 正文超过 8 段容量，末段已标记截断。" : ""}${result.duplicatePossible ? " 某段曾超时并重试，可能重复。" : ""}`,
      };
    } catch (error) {
      if (this.state.phase === "account_stale" || this.state.phase === "send_error") {
        throw error;
      }
      this.state = {
        ...this.state,
        phase: "send_error",
        notice: safeFailure("发送失败或送达状态未知；没有自动重试"),
      };
      throw new Error("发送失败或送达状态未知；没有自动重试");
    } finally {
      this.sendInFlight = false;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.port.pauseInboundDispatch?.();
    this.loginGeneration += 1;
    this.loginHandle?.terminate();
    this.loginHandle = null;
    this.unsubscribeSnapshot();
    this.unsubscribeSnapshot = () => {};
    this.unsubscribeInbound();
    this.unsubscribeInbound = () => {};
    const producers = Promise.allSettled([
      () => this.codex?.close(),
      () => this.dailyNews?.close(),
      () => this.contextTokenExperiment?.close(),
    ].map(async (close) => close()));
    this.closing = settleCleanup([
      async () => {
        const failures = (await producers).filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "producer_cleanup_failed");
      },
      () => Promise.allSettled([...this.sends]),
      () => this.port.close(),
    ]);
    return this.closing;
  }

  private async onLoginEvent(generation: number, event: LoginOutputEvent): Promise<void> {
    if (generation !== this.loginGeneration) return;
    if (event.kind === "qr") {
      try {
        const qrDataUrl = await this.renderQr(event.url);
        if (generation !== this.loginGeneration) return;
        this.state = {
          ...this.state,
          phase: "awaiting_scan",
          qrDataUrl,
          notice: "真实二维码已生成，请使用手机微信扫码并在手机上确认授权。",
        };
      } catch {
        this.loginGeneration += 1;
        this.loginHandle?.terminate();
        this.loginHandle = null;
        this.state = {
          ...this.state,
          phase: "login_error",
          qrDataUrl: null,
          notice: safeFailure("二维码渲染失败"),
        };
      }
      return;
    }
    if (event.kind === "scanned") {
      this.state = { ...this.state, phase: "scanned", notice: "已扫码，正在等待微信验证。" };
      return;
    }
    if (event.kind === "pair_code_required") {
      this.state = {
        ...this.state,
        phase: "pair_code_required",
        notice: "微信要求配对码，请输入手机微信显示的数字。",
      };
      return;
    }
    try {
      await this.port.start();
    } catch {
      this.state = {
        ...this.state,
        phase: "login_error",
        qrDataUrl: null,
        notice: safeFailure("直连凭据已保存，但入站监听启动失败"),
      };
      return;
    }
    const snapshot = this.port.getSnapshot();
    const credentialsAreStale = snapshot.accounts.some(
      (account) => account.credentialStatus === "stale",
    );
    this.state = {
      ...this.state,
      phase: credentialsAreStale ? "account_stale" : "connected",
      accounts: snapshot.accounts.map((account) => ({ ...account })),
      qrDataUrl: null,
      notice: credentialsAreStale
        ? "微信已确认连接，但 bot 凭据随即被标记为失效或暂停；请重新连接后再发送。"
        : event.kind === "already_connected"
          ? "微信确认此直连 Demo 已连接。请先从微信给 bot 发一条消息。"
          : "扫码授权已完成。请先从微信给 bot 发一条消息。",
    };
    if (!credentialsAreStale) {
      const usableAccounts = snapshot.accounts.filter(
        (account) => account.credentialStatus === "usable",
      );
      const usableAccount = usableAccounts.length === 1 ? usableAccounts[0] : undefined;
      if (usableAccount) {
        try {
          this.saveAutoBinding({
            version: 1,
            status: "awaiting_inbound",
            accountId: usableAccount.accountId,
            updatedAt: Date.now(),
          });
        } catch {
          this.state = {
            ...this.state,
            phase: "login_error",
            notice: "微信已连接，但自动绑定状态无法保存；没有启动自动问候。",
          };
          return;
        }
        this.state = {
          ...this.state,
          notice: "微信连接已完成，正在监听首条微信消息；收到后会自动绑定并回复问候。",
        };
      }
    }
  }

  private onLoginExit(generation: number, result: { ok: boolean; message?: string }): void {
    if (generation !== this.loginGeneration) return;
    this.loginHandle = null;
    if (!result.ok) {
      this.state = {
        ...this.state,
        phase: "login_error",
        qrDataUrl: null,
        notice: safeFailure("微信登录流程未完成"),
      };
    }
  }

  private applySnapshot(snapshot: ChannelSnapshot): void {
    const known = new Set(
      this.state.targets.map((item) => `${item.accountId}\n${item.target}`),
    );
    const hasNewTarget = snapshot.targets.some(
      (item) => !known.has(`${item.accountId}\n${item.target}`),
    );
    const hasStaleAccount = snapshot.accounts.some(
      (account) => account.credentialStatus === "stale",
    );
    const selectedStillExists = snapshot.targets.some(
      (target) =>
        target.accountId === this.state.selectedAccountId &&
        target.target === this.state.selectedTarget,
    );
    this.state = {
      ...this.state,
      phase: hasStaleAccount
        ? "account_stale"
        : this.state.phase === "account_stale"
          ? "configured"
          : this.state.phase,
      accounts: snapshot.accounts.map((account) => ({ ...account })),
      targets: snapshot.targets.map((target) => ({ ...target })),
      selectedAccountId: selectedStillExists ? this.state.selectedAccountId : null,
      selectedTarget: selectedStillExists ? this.state.selectedTarget : null,
      notice: hasStaleAccount
        ? "微信 bot 凭据已失效或暂停；请重新连接后再发送。"
        : hasNewTarget
          ? "已自动同步新的微信入站目标。新连接会由首条消息自动完成绑定。"
          : this.state.notice,
    };
  }

  private loadAutoBinding(): AutoBindingRecord {
    try {
      const record = this.autoBindingStore.load();
      if (record.status === "sending") {
        const failed: AutoBindingRecord = { ...record, status: "failed", reason: "unknown" };
        this.autoBindingStore.save(failed);
        return failed;
      }
      return record;
    } catch {
      return { version: 1, status: "idle" };
    }
  }

  private saveAutoBinding(record: AutoBindingRecord): void {
    this.autoBindingStore.save(record);
    this.autoBinding = structuredClone(record);
    if (this.state) this.state = { ...this.state, autoBinding: toPublicAutoBinding(record) };
  }

  private restoreAutoBindingSelection(): void {
    const binding = this.autoBinding;
    if (
      (binding.status !== "accepted" && binding.status !== "failed") ||
      !("target" in binding)
    ) {
      return;
    }
    const exists = this.state.targets.some(
      (target) =>
        target.accountId === binding.accountId && target.target === binding.target,
    );
    if (!exists) return;
    this.state = {
      ...this.state,
      phase: "ready",
      selectedAccountId: binding.accountId,
      selectedTarget: binding.target,
      notice:
        binding.status === "accepted"
          ? "已自动绑定最近的微信会话；此前问候已被渠道接受。"
          : "已自动绑定最近的微信会话；此前问候发送失败或结果未知，没有自动重试。",
    };
  }

  private onInbound(event: InboundTextEvent): Promise<void> {
    const pending = this.autoBinding;
    if (pending.status !== "awaiting_inbound" || pending.accountId !== event.accountId) return Promise.resolve();
    const sending: AutoBindingRecord = {
      version: 1,
      status: "sending",
      accountId: event.accountId,
      target: event.target,
      eventKey: event.key,
      updatedAt: Date.now(),
    };
    try {
      this.saveAutoBinding(sending);
    } catch {
      this.state = {
        ...this.state,
        notice: "检测到微信消息，但自动绑定状态无法安全保存，因此没有发送问候。",
      };
      return Promise.resolve();
    }
    this.state = {
      ...this.state,
      phase: "ready",
      selectedAccountId: event.accountId,
      selectedTarget: event.target,
      notice: "已自动绑定来信目标，正在通过真实微信通道回复问候……",
    };
    return this.sendWelcome(event, sending);
  }

  private async sendWelcome(event: InboundTextEvent, sending: AutoBindingRecord): Promise<void> {
    if (sending.status !== "sending") return;
    let result: SendTextResult;
    try {
      result = await event.replyText(WELCOME_MESSAGE);
    } catch {
      result = { ok: false, reason: "unknown", error: "问候发送失败或超时" };
    }
    const bindingReason = result.reason === "auth_stale" || result.reason === "unknown"
      ? result.reason
      : "rejected";
    const completed: AutoBindingRecord = result.ok
      ? { ...sending, status: "accepted", updatedAt: Date.now() }
      : {
          ...sending,
          status: "failed",
          updatedAt: Date.now(),
          reason: bindingReason,
        };
    try {
      this.saveAutoBinding(completed);
    } catch {
      this.autoBinding = completed;
      this.state = { ...this.state, autoBinding: toPublicAutoBinding(completed) };
    }
    this.state = {
      ...this.state,
      notice: result.ok
        ? "已自动绑定来信目标；问候已被渠道接受，请在微信端确认是否收到。"
        : "已自动绑定来信目标，但问候发送失败或结果未知；没有自动重试。",
    };
  }
}
