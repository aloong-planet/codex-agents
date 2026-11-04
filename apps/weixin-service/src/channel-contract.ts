import type { AppServerTurnAdapter } from "./app-server-turn-driver.js";

export type TargetCandidate = {
  accountId: string;
  target: string;
  label?: string;
  lastInboundAt?: number;
  contextUpdatedAt?: number;
  lastSendAcceptedAt?: number;
};

export type CredentialStatus = "usable" | "stale";

export type AccountCandidate = {
  accountId: string;
  label?: string;
  credentialStatus: CredentialStatus;
};

export type ChannelSnapshot = {
  accounts: AccountCandidate[];
  targets: TargetCandidate[];
};

export type SendTextResult = {
  ok: boolean;
  messageId?: string;
  messageIds?: string[];
  totalSegments?: number;
  acceptedSegments?: number;
  truncated?: boolean;
  retriedSegments?: number;
  duplicatePossible?: boolean;
  error?: string;
  reason?:
    | "context_missing"
    | "context_stale"
    | "auth_stale"
    | "rejected"
    | "unknown"
    | "unavailable";
  providerRet?: number;
  providerErrcode?: number;
  diagnostics?: OutboundDeliveryDiagnostics;
};

export type OutboundDeliveryDiagnosticStep = {
  durationMs: number;
  outcome: "completed" | "failed" | "skipped";
};

export type OutboundDeliveryDiagnostics = {
  prepare: OutboundDeliveryDiagnosticStep;
  sendMessage: OutboundDeliveryDiagnosticStep;
  responseRead: OutboundDeliveryDiagnosticStep;
  stateSave: OutboundDeliveryDiagnosticStep;
  requestCount: number;
};

export type TypingInitializationDiagnosticStep = {
  durationMs: number;
  outcome: "completed" | "failed" | "skipped";
};

export type TypingInitializationDiagnostics = {
  ticketCache: "hit" | "miss";
  getConfig: TypingInitializationDiagnosticStep;
  sendStart: TypingInitializationDiagnosticStep;
};

export type TypingLease = {
  active: boolean;
  diagnostics?: TypingInitializationDiagnostics;
  stop(): Promise<void>;
};

export type MessageAttachment = {
  kind: "image" | "voice" | "file" | "video";
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  quoted: boolean;
};

/** Host-issued, scoped to an admitted message; never supplied by the model. */
export type DeliveryReference = {
  deliveryRef: string;
  senderId?: string;
  conversationType?: "private" | "group";
  key: string;
  accountId: string;
  target: string;
};

export type InboundMessage = DeliveryReference & {
  messageId: string;
  source: "text" | "voice" | "media";
  text: string;
  attachments?: MessageAttachment[];
  quote?: { title?: string; text?: string; attachments: MessageAttachment[] };
  receivedAt: number;
  observedAt?: number;
};

export type RejectedInboundMessage = DeliveryReference & {
  messageId: string;
  source: "voice";
  reason: "voice_too_long" | "voice_duration_invalid" | "voice_transcript_missing";
  durationMs?: number;
  receivedAt: number;
};

export type ReplyProgress = {
  runId: string;
  itemId: string;
  label: string;
  phase: "start" | "end";
  status?: "completed" | "failed" | "blocked" | "unknown";
};

export type ReplyPolicy = { maxReplyCodePoints: number; acknowledgementFallback?: "text" | "none" };

export interface ConversationChannel {
  readonly maxReplyCodePoints: number;
  /** Presentation fallback when native typing is unavailable; defaults to text. */
  readonly acknowledgementFallback?: "text" | "none";
  replyPolicy?(destination: DeliveryReference): ReplyPolicy;
  getSnapshot(): ChannelSnapshot;
  onInboundText(listener: (message: InboundMessage) => Promise<void>): () => void;
  onInboundRejected(listener: (message: RejectedInboundMessage) => Promise<void>): () => void;
  sendText(destination: DeliveryReference, message: string): Promise<SendTextResult>;
  startTyping(destination: DeliveryReference): Promise<TypingLease | undefined>;
  sendProgress(destination: DeliveryReference, progress: ReplyProgress): Promise<SendTextResult | undefined>;
}

export interface ConversationTurnFactory {
  prepare(threadId: string, message: InboundMessage, options: {
    accountMemory: string;
    outboundRoots: string[];
    isClosing: () => boolean;
    recoveryAllowed?: () => boolean;
  }): AppServerTurnAdapter;
}

/** Normalized content accepted by workflow preparation; live reply bindings are separate. */
export type InboundContent = Omit<InboundMessage, "deliveryRef">;
