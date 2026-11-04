import { createHash, randomUUID } from "node:crypto";
import type { ConversationChannel, DeliveryReference, InboundContent, InboundMessage, SendTextResult } from "./channel-contract.js";
import type { ChannelStartupEntry } from "./channel-startup-config.js";
import type { NotificationChannel, NotificationDestination } from "./notification-channel.js";
import type { DurableInboundStore } from "./durable-inbound-store.js";
import type { DurableEffectLedger } from "./durable-effect-ledger.js";
import type { FeishuInboundMedia } from "./feishu-inbound-media.js";

/** Authenticated SDK boundary. start resolves only after its connection is ready. */
export interface FeishuTransport {
  start(handlers: { message(event: unknown): Promise<void>; unavailable(): void; ready(): void }): Promise<void>;
  sendText(input: { chatId: string; text: string; uuid: string }): Promise<{ code?: number; data?: { message_id?: string } }>;
  close(): void | Promise<void>;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class FeishuChannel implements ConversationChannel, NotificationChannel {
  readonly maxReplyCodePoints = 12_000;
  readonly acknowledgementFallback = "none" as const;
  private ready = false;
  private started = false;
  private closing = false;
  private dispatchEnabled = false;
  private listener: ((message: InboundMessage) => Promise<void>) | undefined;
  private readonly observers = new Set<() => void>();
  private readonly deliveries = new Map<string, { message: InboundMessage; nextSubmission: number }>();
  private draining: Promise<void> | undefined;
  private readonly leaseOwner = randomUUID();
  private readonly generation: string;
  private lastInboundAt: number | undefined;

  constructor(
    private readonly config: Extract<ChannelStartupEntry, { channel: "feishu" }>,
    private readonly transport: FeishuTransport,
    private readonly inbox: DurableInboundStore,
    private readonly effects: DurableEffectLedger,
    private readonly report: (code: string) => void,
    private readonly now: () => number = Date.now,
    private readonly media?: FeishuInboundMedia,
  ) {
    this.generation = hash(JSON.stringify([config.owner.contextHash(), config.connection.appSecret]));
  }

  async start(): Promise<void> {
    if (this.started || this.closing) throw new Error("feishu_channel_already_started");
    this.started = true;
    this.inbox.blockExpiredLeases();
    try {
      await this.transport.start({
        message: (event) => this.accept(event),
        unavailable: () => { this.ready = false; this.changed(); this.failure("feishu_connection_unavailable"); },
        ready: () => { if (!this.closing) { this.ready = true; this.changed(); this.kick(); } },
      });
      if (this.closing) throw new Error("feishu_channel_closed");
      this.ready = true;
      this.changed();
      this.kick();
    } catch {
      this.ready = false;
      this.changed();
      await this.transport.close();
      this.failure("feishu_startup_failed");
      throw new Error("feishu_startup_failed");
    }
  }

  activateInboundDispatch(): void { this.dispatchEnabled = true; this.kick(); }
  pauseInboundDispatch(): void { this.dispatchEnabled = false; }
  async close(): Promise<void> {
    this.closing = true;
    this.ready = false;
    this.dispatchEnabled = false;
    this.changed();
    await this.transport.close();
    await this.draining;
  }

  getSnapshot() {
    const address = this.config.owner.conversationAddress();
    return {
      accounts: [{ accountId: address.accountId, label: "飞书", credentialStatus: this.ready ? "usable" as const : "stale" as const }],
      targets: [{ ...address, label: "本人飞书私聊", ...(this.lastInboundAt === undefined ? {} : { lastInboundAt: this.lastInboundAt }) }],
    };
  }
  onInboundText(listener: (message: InboundMessage) => Promise<void>): () => void {
    if (this.listener) throw new Error("feishu_listener_already_bound");
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  onInboundRejected(): () => void { return () => {}; }
  async startTyping(): Promise<undefined> { return undefined; }
  async sendProgress(): Promise<undefined> { return undefined; }
  subscribe(listener: () => void): () => void { this.observers.add(listener); return () => this.observers.delete(listener); }
  state(destination: NotificationDestination) {
    const selected = destination.channel === "feishu" && this.config.owner.ownsAddress(destination.accountId, destination.target);
    return { enabled: selected && this.ready && !this.closing, credentialStatus: this.ready ? "usable" as const : "stale" as const,
      credentialGeneration: this.generation, contextGeneration: selected ? this.config.owner.contextHash() : null };
  }

  async sendText(destination: DeliveryReference, message: string): Promise<SendTextResult> {
    const binding = this.deliveries.get(destination.deliveryRef);
    const live = binding?.message;
    if (!live || live.key !== destination.key || live.accountId !== destination.accountId || live.target !== destination.target ||
        live.senderId !== destination.senderId || destination.conversationType !== "private") {
      throw new Error("inbound_delivery_binding_unavailable");
    }
    return this.submit(message, `reply:${live.key}:${binding!.nextSubmission++}`, () => this.ready && !this.closing, live.key);
  }
  async send(input: Parameters<NotificationChannel["send"]>[0]): Promise<SendTextResult> {
    if (!this.state(input).enabled) return { ok: false, reason: "unavailable", acceptedSegments: 0 };
    return this.submit(input.message, input.operationId, () => this.state(input).enabled && input.beforeSubmit());
  }

  /** Exposed by the transport callback; completing this means durable acceptance, never model completion. */
  private async accept(value: unknown): Promise<void> {
    if (this.closing) throw new Error("feishu_channel_closed");
    const event = object(value);
    const sender = object(event?.sender);
    const senderId = object(sender?.sender_id)?.open_id;
    const message = object(event?.message);
    if (!event || !message || sender?.sender_type !== "user" || typeof senderId !== "string" ||
        (event.app_id !== undefined && event.app_id !== this.config.connection.appId) || message.chat_type !== "p2p") return;
    const address = this.config.owner.admit({ accountId: this.config.connection.appId,
      target: typeof message.chat_id === "string" ? message.chat_id : "", senderId, conversationType: "private" });
    if (!address) return;
    if (typeof message.message_type !== "string" || (!this.media && message.message_type !== "text")) { this.failure("feishu_message_type_unsupported"); return; }
    if (typeof message.message_id !== "string" || !message.message_id || message.message_id.length > 512 ||
        typeof message.create_time !== "string" || !/^\d+$/.test(message.create_time) || typeof message.content !== "string") {
      this.failure("feishu_message_invalid"); return;
    }
    const receivedAt = Number(message.create_time);
    if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
      this.failure("feishu_message_invalid"); return;
    }
    const key = hash(JSON.stringify(["feishu", this.config.connection.appId, message.message_id]));
    if (this.inbox.peek(key)) return;
    let normalized: Pick<InboundContent, "source" | "text" | "attachments" | "quote">;
    if (this.media) {
      try {
        normalized = await this.media.normalize({ messageId: message.message_id, type: message.message_type, content: message.content,
          ...(typeof message.parent_id === "string" && message.parent_id ? { parentId: message.parent_id } : {}) });
      } catch { this.failure("feishu_resource_processing_failed"); throw new Error("feishu_resource_processing_failed"); }
    } else {
      let content: Record<string, unknown> | undefined;
      try { content = object(JSON.parse(message.content)); } catch { this.failure("feishu_message_invalid"); return; }
      if (typeof content?.text !== "string" || Array.from(content.text).length > 8000) { this.failure("feishu_message_invalid"); return; }
      normalized = { source: "text", text: content.text };
    }
    const inbound: InboundContent = { ...address, key, ...normalized,
      messageId: message.message_id, senderId, conversationType: "private",
      receivedAt, observedAt: this.now() };
    this.inbox.ingestMessage(inbound, this.config.owner.contextHash());
    this.lastInboundAt = receivedAt;
    this.changed();
    // Do not put model execution or outbound effects on the acknowledgement path.
    queueMicrotask(() => this.kick());
  }

  private kick(): void {
    if (this.draining || !this.ready || !this.dispatchEnabled || !this.listener || this.closing) return;
    this.draining = this.drain().catch(() => this.failure("feishu_inbound_processing_failed"))
      .finally(() => {
        this.draining = undefined;
        const address = this.config.owner.conversationAddress();
        if (this.inbox.queuedTargets(address.accountId).includes(address.target)) this.kick();
      });
  }
  private async drain(): Promise<void> {
    const address = this.config.owner.conversationAddress();
    while (this.ready && this.dispatchEnabled && this.listener && !this.closing) {
      const job = this.inbox.leaseNext(address.accountId, address.target, this.leaseOwner, 24 * 60 * 60 * 1000);
      if (!job) return;
      // A changed owner binding cannot reinterpret an earlier admission as this owner's work.
      if (job.admission?.bindingHash !== this.config.owner.contextHash() || job.admission.senderId !== this.config.binding.senderId) {
        this.failure("feishu_inbound_binding_changed"); return;
      }
      const message: InboundMessage = { ...address, key: job.eventKey, messageId: job.messageId,
        senderId: job.admission.senderId, conversationType: "private", deliveryRef: randomUUID(),
        source: job.source, text: job.text, ...(job.attachments ? { attachments: job.attachments } : {}), ...(job.quote ? { quote: job.quote } : {}),
        receivedAt: job.receivedAt, observedAt: job.observedAt };
      this.deliveries.set(message.deliveryRef, { message: { ...message }, nextSubmission: 0 });
      try {
        await this.listener(message);
        this.inbox.complete(job.eventKey, this.leaseOwner, job.revision);
      } finally { this.deliveries.delete(message.deliveryRef); }
    }
  }

  private async submit(text: string, operationId: string, beforeSubmit: () => boolean, causeEventKey?: string): Promise<SendTextResult> {
    const points = Array.from(text);
    if (!points.length || points.length > this.maxReplyCodePoints) return { ok: false, reason: "rejected", acceptedSegments: 0 };
    const segments: string[] = [];
    for (let index = 0; index < points.length; index += 4000) segments.push(points.slice(index, index + 4000).join(""));
    const address = this.config.owner.conversationAddress();
    let accepted = 0;
    const ids: string[] = [];
    for (const [ordinal, segment] of segments.entries()) {
      if (!beforeSubmit()) return { ok: false, reason: "unavailable", acceptedSegments: accepted, totalSegments: segments.length };
      const operation = `feishu:${hash(JSON.stringify([address, operationId]))}`;
      const attemptId = `${operation}:${ordinal}`;
      const clientId = hash(JSON.stringify([attemptId, segment])).slice(0, 32);
      const existing = this.effects.listByOperation(operation).find((item) => item.attemptId === attemptId);
      const prepared = this.effects.prepare({ attemptId, operationId: operation, ...address, kind: "feishu_text", clientId, ordinal,
        ...(causeEventKey ? { causeEventKey } : {}) });
      if (existing) {
        if (prepared.state === "accepted") { accepted++; continue; }
        return { ok: false, reason: prepared.state === "rejected" ? "rejected" : "unknown", acceptedSegments: accepted, totalSegments: segments.length };
      }
      let result: Awaited<ReturnType<FeishuTransport["sendText"]>>;
      try { result = await this.transport.sendText({ chatId: this.config.binding.target, text: segment, uuid: clientId }); }
      catch {
        this.effects.settle(attemptId, "unknown");
        this.failure("feishu_send_unknown");
        return { ok: false, reason: "unknown", acceptedSegments: accepted, totalSegments: segments.length };
      }
      if (result.code !== 0 || !result.data?.message_id) {
        const rejected = typeof result.code === "number" && Number.isSafeInteger(result.code) && result.code !== 0;
        this.effects.settle(attemptId, rejected ? "rejected" : "unknown", rejected ? result.code : undefined);
        this.failure(rejected ? "feishu_send_rejected" : "feishu_send_unknown");
        return { ok: false, reason: rejected ? "rejected" : "unknown", acceptedSegments: accepted, totalSegments: segments.length };
      }
      this.effects.settle(attemptId, "accepted");
      accepted++;
      ids.push(result.data.message_id);
    }
    return { ok: true, acceptedSegments: accepted, totalSegments: segments.length, messageIds: ids };
  }
  private changed(): void { for (const observer of this.observers) { try { observer(); } catch { /* Observers cannot change admission. */ } } }
  private failure(code: string): void { try { this.report(code); } catch { /* Reporting cannot alter delivery outcomes. */ } }
}
