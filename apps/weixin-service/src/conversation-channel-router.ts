import { randomUUID } from "node:crypto";
import type {
  ConversationChannel, ConversationTurnFactory, DeliveryReference, InboundMessage,
  RejectedInboundMessage, ReplyProgress, ReplyPolicy,
} from "./channel-contract.js";
import type { ChannelConversationIdentity } from "./personal-owner-identity.js";

type Route = {
  owner: ChannelConversationIdentity;
  channel: ConversationChannel;
  turns: ConversationTurnFactory;
};
type LiveBinding = { route: Route; original: InboundMessage | RejectedInboundMessage; reference: DeliveryReference };

/** Routes live replies and turn preparation through the original authenticated adapter. */
export class ConversationChannelRouter implements ConversationChannel, ConversationTurnFactory {
  readonly maxReplyCodePoints: number;
  private readonly routes: readonly Route[];
  private readonly bindings = new Map<string, LiveBinding>();

  constructor(routes: readonly Route[]) {
    if (routes.length === 0 || new Set(routes.map(({ owner }) => owner.conversationAddress().accountId)).size !== routes.length ||
        new Set(routes.map(({ owner }) => owner.memoryAccountId)).size !== 1) throw new Error("conversation_routes_invalid");
    this.routes = routes.map((route) => ({ ...route }));
    this.maxReplyCodePoints = Math.min(...routes.map(({ channel }) => channel.maxReplyCodePoints));
  }

  getSnapshot() {
    return {
      accounts: this.routes.flatMap(({ owner, channel }) => channel.getSnapshot().accounts.filter((account) => owner.ownsAccount(account.accountId))),
      targets: this.routes.flatMap(({ owner, channel }) => channel.getSnapshot().targets.filter((target) => owner.ownsAddress(target.accountId, target.target))),
    };
  }

  onInboundText(listener: (message: InboundMessage) => Promise<void>): () => void {
    const stops = this.routes.map((route) => route.channel.onInboundText((message) => this.dispatch(route, message, listener)));
    return () => { for (const stop of stops) stop(); };
  }

  onInboundRejected(listener: (message: RejectedInboundMessage) => Promise<void>): () => void {
    const stops = this.routes.map((route) => route.channel.onInboundRejected((message) => this.dispatch(route, message, listener)));
    return () => { for (const stop of stops) stop(); };
  }

  replyPolicy(reference: DeliveryReference): ReplyPolicy {
    const { route, original } = this.bound(reference);
    return route.channel.replyPolicy?.(original) ?? {
      maxReplyCodePoints: route.channel.maxReplyCodePoints,
      acknowledgementFallback: route.channel.acknowledgementFallback ?? "text",
    };
  }

  sendText(reference: DeliveryReference, text: string) {
    const { route, original } = this.bound(reference);
    return route.channel.sendText(original, text);
  }
  startTyping(reference: DeliveryReference) {
    const { route, original } = this.bound(reference);
    return route.channel.startTyping(original);
  }
  sendProgress(reference: DeliveryReference, progress: ReplyProgress) {
    const { route, original } = this.bound(reference);
    return route.channel.sendProgress(original, progress);
  }
  prepare(threadId: string, message: InboundMessage, options: Parameters<ConversationTurnFactory["prepare"]>[2]) {
    const { route, original } = this.bound(message);
    if (!("text" in original)) throw new Error("conversation_turn_reference_invalid");
    return route.turns.prepare(threadId, original, options);
  }

  private async dispatch<T extends InboundMessage | RejectedInboundMessage>(route: Route, original: T, listener: (message: T) => Promise<void>) {
    if (!route.owner.accepts(original)) return;
    const message = { ...structuredClone(original), deliveryRef: randomUUID() };
    this.bindings.set(message.deliveryRef, { route, original, reference: { ...message } });
    try { await listener(message); }
    finally { this.bindings.delete(message.deliveryRef); }
  }

  private bound(reference: DeliveryReference): LiveBinding {
    const binding = this.bindings.get(reference.deliveryRef);
    const expected = binding?.reference;
    if (!binding || !expected || expected.key !== reference.key || expected.accountId !== reference.accountId ||
        expected.target !== reference.target || expected.senderId !== reference.senderId || expected.conversationType !== reference.conversationType) {
      throw new Error("conversation_delivery_reference_unavailable");
    }
    return binding;
  }
}
