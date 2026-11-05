import type { FeishuTransport } from "./feishu-channel.js";
import type { FeishuResourceTransport } from "./feishu-inbound-media.js";
import type { FeishuMediaTransport } from "./feishu-media-delivery.js";
import { settleCleanup } from "./async-cleanup.js";
import { FeishuWebhookReceiver } from "./feishu-webhook-receiver.js";

/** Combines authenticated REST operations with the separately bound durable HTTP receiver. */
export class FeishuWebhookTransport implements FeishuTransport, FeishuResourceTransport, FeishuMediaTransport {
  constructor(private readonly outbound: FeishuTransport & FeishuResourceTransport & FeishuMediaTransport,
    private readonly receiver: FeishuWebhookReceiver) {}

  async start(handlers: Parameters<FeishuTransport["start"]>[0]): Promise<void> {
    try {
      await this.outbound.start({ message: async () => {}, ready() {}, unavailable: handlers.unavailable });
      await this.receiver.start(handlers.message);
      handlers.ready();
    } catch { await this.close(); throw new Error("feishu_webhook_startup_failed"); }
  }
  close(): Promise<void> { return settleCleanup([() => this.receiver.close(), () => this.outbound.close()]); }
  botOpenId(): Promise<string> {
    if (!this.outbound.botOpenId) return Promise.reject(new Error("feishu_bot_identity_unavailable"));
    return this.outbound.botOpenId();
  }
  sendText(input: Parameters<FeishuTransport["sendText"]>[0]) { return this.outbound.sendText(input); }
  getMessage(messageId: string) { return this.outbound.getMessage(messageId); }
  download(input: Parameters<FeishuResourceTransport["download"]>[0]) { return this.outbound.download(input); }
  upload(input: Parameters<FeishuMediaTransport["upload"]>[0]) { return this.outbound.upload(input); }
  sendResource(input: Parameters<FeishuMediaTransport["sendResource"]>[0]) { return this.outbound.sendResource(input); }
}
