import type { FeishuTransport } from "./feishu-channel.js";
import type { FixtureModelToolCall, FixtureModelToolCallQueue } from "./fixture-app-server-transport.js";
import { Readable } from "node:stream";
import type { FeishuMediaTransport } from "./feishu-media-delivery.js";
import type { FeishuResourceTransport } from "./feishu-inbound-media.js";

/** Explicit fixture mode only; events still pass through FeishuChannel durable admission. */
export class FixtureFeishuTransport implements FeishuTransport, FeishuMediaTransport, FeishuResourceTransport, FixtureModelToolCallQueue {
  private handlers: Parameters<FeishuTransport["start"]>[0] | undefined;
  private calls: FixtureModelToolCall[] = [];
  private readonly outbox: { chatId: string; message: string; simulated: true; acceptedAt: number }[] = [];
  private readonly uploads = new Map<string, { kind: "image" | "file"; bytes: Buffer; fileName: string }>();
  private readonly resources = new Map<string, { bytes: Buffer; contentType: string }>();
  private readonly messages = new Map<string, unknown>();
  private readonly mediaOutbox: { chatId: string; kind: string; fileName: string; bytesBase64: string; simulated: true }[] = [];
  constructor(private readonly failStartup = false) {}
  async start(handlers: Parameters<FeishuTransport["start"]>[0]): Promise<void> {
    if (this.failStartup) throw new Error("fixture_feishu_startup_failed");
    this.handlers = handlers;
  }
  close(): void { this.handlers = undefined; }
  async sendText(input: Parameters<FeishuTransport["sendText"]>[0]) {
    if (!this.handlers) throw new Error("fixture_feishu_not_started");
    this.outbox.push({ chatId: input.chatId, message: input.text, simulated: true, acceptedAt: Date.now() });
    return { code: 0, data: { message_id: `fixture-feishu-${this.outbox.length}` } };
  }
  takeFixtureModelToolCall() { return this.calls.shift(); }
  getTextOutbox() { return structuredClone(this.outbox); }
  getMediaOutbox() { return structuredClone(this.mediaOutbox); }
  async upload(input: Parameters<FeishuMediaTransport["upload"]>[0]) {
    if (!this.handlers) throw new Error("fixture_feishu_not_started");
    const key = `fixture_resource_${this.uploads.size + 1}`;
    this.uploads.set(key, { ...input, bytes: Buffer.from(input.bytes) });
    return key;
  }
  async sendResource(input: Parameters<FeishuMediaTransport["sendResource"]>[0]) {
    if (!this.handlers) throw new Error("fixture_feishu_not_started");
    const content = JSON.parse(input.content);
    const key = input.msgType === "post" ? content.zh_cn?.content?.[0]?.[0]?.image_key : content.image_key ?? content.file_key;
    const uploaded = this.uploads.get(key);
    if (!uploaded) return { code: 230001 };
    this.mediaOutbox.push({ chatId: input.chatId, kind: uploaded.kind, fileName: uploaded.fileName, bytesBase64: uploaded.bytes.toString("base64"), simulated: true });
    return { code: 0, data: { message_id: `fixture-media-${this.mediaOutbox.length}` } };
  }
  async getMessage(messageId: string) {
    const message = this.messages.get(messageId);
    return { code: message ? 0 : 230001, data: { items: message ? [message] : [] } };
  }
  async download(input: Parameters<FeishuResourceTransport["download"]>[0]) {
    const resource = this.resources.get(JSON.stringify(input));
    if (!resource) throw new Error("fixture_resource_missing");
    const stream = Readable.from([Buffer.from(resource.bytes)]);
    return { stream, contentType: resource.contentType, cancel() { stream.destroy(); } };
  }
  async emit(value: unknown): Promise<void> {
    if (!this.handlers) throw new Error("fixture_feishu_not_started");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture_input_invalid");
    const input = value as Record<string, unknown>;
    if (input.connection === "unavailable") { this.handlers.unavailable(); return; }
    if (input.connection === "ready") { this.handlers.ready(); return; }
    if (input.resources !== undefined) {
      if (!Array.isArray(input.resources) || input.resources.length > 20) throw new Error("fixture_resources_invalid");
      for (const resource of input.resources) {
        if (!resource || typeof resource !== "object" || typeof resource.messageId !== "string" || typeof resource.resourceKey !== "string" ||
            !["image", "file"].includes(resource.type) || typeof resource.bytesBase64 !== "string" || resource.bytesBase64.length > 2 * 1024 * 1024 || typeof resource.contentType !== "string") throw new Error("fixture_resources_invalid");
        this.resources.set(JSON.stringify({ messageId: resource.messageId, resourceKey: resource.resourceKey, type: resource.type }),
          { bytes: Buffer.from(resource.bytesBase64, "base64"), contentType: resource.contentType });
      }
    }
    const event = input.event as { message?: { message_id?: string; chat_id?: string; message_type?: string; content?: string } } | undefined;
    if (event?.message?.message_id) this.messages.set(event.message.message_id, {
      message_id: event.message.message_id, chat_id: event.message.chat_id, msg_type: event.message.message_type, body: { content: event.message.content },
    });
    if (input.modelToolCalls !== undefined) {
      if (!Array.isArray(input.modelToolCalls) || input.modelToolCalls.length > 20) throw new Error("fixture_tools_invalid");
      const calls = input.modelToolCalls.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture_tools_invalid");
        const call = value as Record<string, unknown>;
        if (typeof call.namespace !== "string" || typeof call.tool !== "string") throw new Error("fixture_tools_invalid");
        return { namespace: call.namespace, tool: call.tool, arguments: call.arguments };
      });
      this.calls.push(...structuredClone(calls));
    }
    await this.handlers.message(input.event);
  }
}
