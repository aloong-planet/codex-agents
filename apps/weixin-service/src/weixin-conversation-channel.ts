import { randomUUID } from "node:crypto";
import type { InboundRejectedEvent, InboundTextEvent, WeixinChannel } from "./demo-service.js";
import type { ConversationChannel, DeliveryReference, InboundMessage, RejectedInboundMessage, ReplyProgress } from "./channel-contract.js";
import { MAX_WEIXIN_LOGICAL_CODE_POINTS } from "./weixin-text-segmenter.js";

type LegacyMessage = InboundTextEvent | InboundRejectedEvent;
type Message = InboundMessage | RejectedInboundMessage;

/** Owns live reply bindings; only plain message data crosses into the conversation. */
export class WeixinConversationChannel implements ConversationChannel {
  readonly maxReplyCodePoints = MAX_WEIXIN_LOGICAL_CODE_POINTS;
  private readonly deliveries = new Map<string, LegacyMessage>();
  private readonly originals = new WeakMap<Message, LegacyMessage>();

  constructor(private readonly channel: Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected">) {}

  getSnapshot() { return this.channel.getSnapshot(); }

  onInboundText(listener: (message: InboundMessage) => Promise<void>): () => void {
    if (!this.channel.onInboundText) throw new Error("当前微信通道不支持文本入站监听");
    return this.channel.onInboundText(async (event) => {
      const message: InboundMessage = {
        ...this.reference(event), messageId: event.messageId, source: event.source,
        text: event.text, receivedAt: event.receivedAt,
        ...(event.observedAt !== undefined ? { observedAt: event.observedAt } : {}),
        ...(event.attachments ? { attachments: structuredClone(event.attachments) } : {}),
        ...(event.quote ? { quote: structuredClone(event.quote) } : {}),
      };
      await this.dispatch(message, event, listener);
    });
  }

  onInboundRejected(listener: (message: RejectedInboundMessage) => Promise<void>): () => void {
    return this.channel.onInboundRejected?.(async (event) => {
      const message: RejectedInboundMessage = {
        ...this.reference(event), messageId: event.messageId, source: event.source,
        reason: event.reason, receivedAt: event.receivedAt,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      };
      await this.dispatch(message, event, listener);
    }) ?? (() => {});
  }

  async sendText(reference: DeliveryReference, message: string) {
    return this.bound(reference).replyText(message);
  }

  async startTyping(reference: DeliveryReference) {
    const event = this.bound(reference);
    return "text" in event ? event.startTyping?.() : undefined;
  }

  async sendProgress(reference: DeliveryReference, progress: ReplyProgress) {
    const event = this.bound(reference);
    return "text" in event ? event.replyProgress?.(progress) : undefined;
  }

  legacy(message: InboundMessage): InboundTextEvent {
    const original = this.originals.get(message);
    if (!original || !("text" in original)) throw new Error("inbound_binding_unavailable");
    return original;
  }

  private reference(event: LegacyMessage): DeliveryReference {
    return { senderId: event.target, conversationType: "private", deliveryRef: randomUUID(), key: event.key, accountId: event.accountId, target: event.target };
  }

  private bound(reference: DeliveryReference): LegacyMessage {
    const event = this.deliveries.get(reference.deliveryRef);
    if (!event || event.key !== reference.key || event.accountId !== reference.accountId || event.target !== reference.target) {
      throw new Error("inbound_delivery_binding_unavailable");
    }
    return event;
  }

  private async dispatch<T extends Message>(message: T, event: LegacyMessage, listener: (message: T) => Promise<void>): Promise<void> {
    this.originals.set(message, event);
    this.deliveries.set(message.deliveryRef, event);
    try { await listener(message); }
    finally { this.deliveries.delete(message.deliveryRef); }
  }
}
