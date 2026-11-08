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
  private readonly decisions = new Map<string, unknown>();
  private readonly leaderPlans = new Map<string, unknown[]>();
  private readonly leaderClosings = new Map<string, unknown>();
  private readonly dispatchCalls = new Map<string, FixtureModelToolCall[]>();
  private readonly completions = new Map<string, { promise: Promise<string>; release(): void }>();
  private applications = new Map<string, FixtureFeishuTransport>();
  private textOutcomes: Array<"accepted" | "rejected" | "unknown" | "held"> = [];
  private releaseText: (() => void) | undefined;
  private mediaOutcomes: Array<"accepted" | "rejected" | "unknown"> = [];
  private readonly mediaOutbox: { chatId: string; kind: string; fileName: string; bytesBase64: string; simulated: true }[] = [];
  constructor(private readonly failStartup = false, private readonly identity = "ou_fixturebot") {}
  async start(handlers: Parameters<FeishuTransport["start"]>[0]): Promise<void> {
    if (this.failStartup) throw new Error("fixture_feishu_startup_failed");
    this.handlers = handlers;
  }
  close(): void { this.releaseText?.(); this.handlers = undefined; }
  async botOpenId(): Promise<string> { return this.identity; }
  async sendText(input: Parameters<FeishuTransport["sendText"]>[0]) {
    if (!this.handlers) throw new Error("fixture_feishu_not_started");
    const outcome = this.textOutcomes.shift();
    if (outcome === "rejected") return { code: 230001 };
    this.outbox.push({ chatId: input.chatId, message: input.text, simulated: true, acceptedAt: Date.now() });
    if (outcome === "held") await new Promise<void>((resolve) => { this.releaseText = resolve; });
    if (outcome === "unknown") throw new Error("fixture_feishu_response_lost");
    return { code: 0, data: { message_id: `fixture-feishu-${this.outbox.length}` } };
  }
  takeFixtureModelToolCall() { return this.calls.shift(); }
  bindApplications(applications: ReadonlyMap<string, FixtureFeishuTransport>): void { this.applications = new Map(applications); }
  dispatchDecision(messageId: string): unknown {
    if (!this.decisions.has(messageId)) throw new Error("fixture_dispatch_decision_missing");
    return structuredClone(this.decisions.get(messageId));
  }
  /**
   * The next injected Team Leader plan for a message, one per turn; the last one repeats once the list is used up.
   * Undefined when the message injected none, so the fixture Team Leader plans its default.
   */
  leaderPlan(messageId: string): unknown {
    const plans = this.leaderPlans.get(messageId);
    if (!plans?.length) return undefined;
    return structuredClone(plans.length > 1 ? plans.shift() : plans[0]);
  }
  leaderClosing(messageId: string): unknown { return structuredClone(this.leaderClosings.get(messageId)); }
  dispatchToolQueue(messageId: string): FixtureModelToolCallQueue {
    return { takeFixtureModelToolCall: () => this.dispatchCalls.get(messageId)?.shift(), takeFixtureModelCompletion: () => {
      const completion = this.completions.get(messageId); return completion?.promise;
    } };
  }
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
    const outcome = this.mediaOutcomes.shift();
    if (outcome === "rejected") return { code: 230001 };
    this.mediaOutbox.push({ chatId: input.chatId, kind: uploaded.kind, fileName: uploaded.fileName, bytesBase64: uploaded.bytes.toString("base64"), simulated: true });
    if (outcome === "unknown") throw new Error("fixture_feishu_response_lost");
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
    if (input.applicationControl !== undefined) {
      const control = input.applicationControl as { agentId?: unknown; textOutcomes?: unknown; mediaOutcomes?: unknown; connection?: unknown; releaseText?: unknown };
      const peer = typeof control.agentId === "string" ? this.applications.get(control.agentId) : undefined;
      if (!peer) throw new Error("fixture_application_unknown");
      if (control.textOutcomes !== undefined) {
        if (!Array.isArray(control.textOutcomes) || control.textOutcomes.length > 20 || control.textOutcomes.some((item) => !["accepted", "rejected", "unknown", "held"].includes(item))) throw new Error("fixture_send_outcomes_invalid");
        peer.textOutcomes = control.textOutcomes as Array<"accepted" | "rejected" | "unknown" | "held">;
      }
      if (control.releaseText === true) { peer.releaseText?.(); peer.releaseText = undefined; }
      if (control.connection !== undefined) await peer.emit({ connection: control.connection });
      if (control.mediaOutcomes !== undefined) {
        if (!Array.isArray(control.mediaOutcomes) || control.mediaOutcomes.length > 20 || control.mediaOutcomes.some((item) => !["accepted", "rejected", "unknown"].includes(item))) throw new Error("fixture_send_outcomes_invalid");
        peer.mediaOutcomes = control.mediaOutcomes as Array<"accepted" | "rejected" | "unknown">;
      }
      return;
    }
    if (input.modelControl !== undefined) {
      const control = input.modelControl as { messageId?: unknown; action?: unknown };
      if (typeof control.messageId !== "string" || control.action !== "release" || !this.completions.has(control.messageId)) throw new Error("fixture_model_control_invalid");
      this.completions.get(control.messageId)!.release(); return;
    }
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
    if (input.dispatchDecision !== undefined && event?.message?.message_id) this.decisions.set(event.message.message_id, structuredClone(input.dispatchDecision));
    if (input.leaderPlan !== undefined && event?.message?.message_id) {
      const plans = Array.isArray(input.leaderPlan) ? input.leaderPlan : [input.leaderPlan];
      if (plans.length === 0 || plans.length > 5) throw new Error("fixture_leader_plan_invalid");
      this.leaderPlans.set(event.message.message_id, structuredClone(plans));
    }
    if (input.leaderClosing !== undefined && event?.message?.message_id) this.leaderClosings.set(event.message.message_id, structuredClone(input.leaderClosing));
    if ((input.modelHold === true || input.modelReply !== undefined) && event?.message?.message_id) {
      if (input.modelReply !== undefined && (typeof input.modelReply !== "string" || input.modelReply.length > 64000)) throw new Error("fixture_model_reply_invalid");
      const reply = typeof input.modelReply === "string" ? input.modelReply : JSON.stringify({ message: "这是 fixture Codex 回复。", results: [] });
      let resolve!: (reply: string) => void;
      const promise = new Promise<string>((done) => { resolve = done; });
      const release = () => resolve(reply);
      this.completions.set(event.message.message_id, { promise, release });
      if (input.modelHold !== true) release();
    }
    if (event?.message?.message_id) this.messages.set(event.message.message_id, {
      message_id: event.message.message_id, chat_id: event.message.chat_id, msg_type: event.message.message_type, body: { content: event.message.content },
    });
    if (event?.message?.message_id && input.messageDetails !== undefined) this.messages.set(event.message.message_id, structuredClone(input.messageDetails));
    if (input.modelToolCalls !== undefined) {
      if (!Array.isArray(input.modelToolCalls) || input.modelToolCalls.length > 20) throw new Error("fixture_tools_invalid");
      const calls = input.modelToolCalls.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture_tools_invalid");
        const call = value as Record<string, unknown>;
        if (typeof call.namespace !== "string" || typeof call.tool !== "string") throw new Error("fixture_tools_invalid");
        return { namespace: call.namespace, tool: call.tool, arguments: call.arguments };
      });
      if (input.dispatchDecision !== undefined && event?.message?.message_id) this.dispatchCalls.set(event.message.message_id, structuredClone(calls));
      else this.calls.push(...structuredClone(calls));
    }
    await this.handlers.message(input.event);
  }
}
