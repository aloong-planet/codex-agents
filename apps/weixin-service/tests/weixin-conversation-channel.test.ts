import { describe, expect, it, vi } from "vitest";
import type { InboundTextEvent, InboundRejectedEvent, WeixinChannel } from "../src/demo-service.js";
import type { DeliveryReference, InboundMessage } from "../src/channel-contract.js";
import { WeixinConversationChannel } from "../src/weixin-conversation-channel.js";

// Uses the production iLink event shape at its callback seam. No network or phone
// receipt is tested; production-equivalent ingress remains covered by main-reply suites.
function harness() {
  let text: (event: InboundTextEvent) => unknown = () => {};
  let rejected: (event: InboundRejectedEvent) => unknown = () => {};
  const source: Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected"> = {
    getSnapshot: () => ({ accounts: [], targets: [] }),
    onInboundText(listener) { text = listener; return () => { text = () => {}; }; },
    onInboundRejected(listener) { rejected = listener; return () => { rejected = () => {}; }; },
  };
  return { adapter: new WeixinConversationChannel(source), emit: (event: InboundTextEvent) => text(event), reject: (event: InboundRejectedEvent) => rejected(event) };
}
function event(target = "opaque-owner-destination"): InboundTextEvent {
  return { key: "inbound-1", accountId: "opaque-account", target, messageId: "message-1", source: "text",
    text: "原样回复：你好。", receivedAt: 123, replyText: vi.fn(async () => ({ ok: true })) };
}

describe("Weixin conversation message and delivery seam", () => {
  it("passes plain data and sends using a serialized host-bound reference", async () => {
    const { adapter, emit } = harness();
    const inbound = { ...event(), contextToken: "private-token", pollingCursor: "private-cursor" };
    adapter.onInboundText(async (message) => {
      const copy = JSON.parse(JSON.stringify(message)) as InboundMessage;
      expect(copy).toEqual({ senderId: "opaque-owner-destination", conversationType: "private", deliveryRef: expect.any(String), key: "inbound-1", accountId: "opaque-account",
        target: "opaque-owner-destination", messageId: "message-1", source: "text", text: "原样回复：你好。", receivedAt: 123 });
      expect(structuredClone(message)).toEqual(copy);
      await expect(adapter.sendText(copy, "你好。")).resolves.toEqual({ ok: true });
    });
    await emit(inbound);
    expect(inbound.replyText).toHaveBeenCalledExactlyOnceWith("你好。");
  });

  it("rejects altered identity and expired delivery references without another send", async () => {
    const { adapter, emit } = harness();
    const inbound = event();
    let saved: DeliveryReference | undefined;
    adapter.onInboundText(async (message) => {
      saved = structuredClone(message);
      for (const field of ["accountId", "target", "key", "deliveryRef"] as const) {
        await expect(adapter.sendText({ ...message, [field]: "forged" }, "禁止发送")).rejects.toThrow("inbound_delivery_binding_unavailable");
      }
      await adapter.sendText(message, "允许发送");
    });
    await emit(inbound);
    expect(saved).toBeDefined();
    await expect(adapter.sendText(saved!, "禁止重复发送")).rejects.toThrow("inbound_delivery_binding_unavailable");
    expect(inbound.replyText).toHaveBeenCalledExactlyOnceWith("允许发送");
  });

  it("keeps overlapping equal message keys bound to their original destinations", async () => {
    const { adapter, emit } = harness();
    const first = event("destination-a"), second = event("destination-b");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    adapter.onInboundText(async (message) => {
      if (++count === 2) release();
      await ready;
      await adapter.sendText(JSON.parse(JSON.stringify(message)) as InboundMessage, message.target);
    });
    await Promise.all([emit(first), emit(second)]);
    expect(first.replyText).toHaveBeenCalledExactlyOnceWith("destination-a");
    expect(second.replyText).toHaveBeenCalledExactlyOnceWith("destination-b");
  });

  it("releases rejected-message bindings when the listener fails", async () => {
    const { adapter, reject } = harness();
    const replyText = vi.fn(async () => ({ ok: true }));
    let saved: DeliveryReference | undefined;
    adapter.onInboundRejected(async (message) => {
      saved = structuredClone(message);
      await adapter.sendText(message, "请改发文字。");
      throw new Error("listener failed");
    });
    await expect(reject({ key: "voice-1", accountId: "account", target: "destination", messageId: "voice",
      source: "voice", reason: "voice_transcript_missing", receivedAt: 123, replyText })).rejects.toThrow("listener failed");
    expect(saved).toBeDefined();
    await expect(adapter.sendText(saved!, "不重发")).rejects.toThrow("inbound_delivery_binding_unavailable");
    expect(replyText).toHaveBeenCalledExactlyOnceWith("请改发文字。");
  });
});
