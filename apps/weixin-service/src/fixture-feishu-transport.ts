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
  private readonly leaderSupplements = new Map<string, unknown>();
  /** Injected outputs of one team's Team Leader turns on a message (`teamTurns`), keyed by message and team. */
  private readonly teamTurns = new Map<string, { leaderPlan?: unknown[]; leaderClosing?: unknown; leaderSupplement?: unknown }>();
  private readonly crossTeamDecisions = new Map<string, unknown>();
  private readonly dispatchCalls = new Map<string, FixtureModelToolCall[]>();
  private readonly completions = new Map<string, { promise: Promise<string>; release(): void }>();
  private applications = new Map<string, FixtureFeishuTransport>();
  private onboarding: { configure(settings: never): void } | undefined;
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
  /** The fake onboarding platform that `onboardingControl` inputs configure (team-management Testing Decisions: Onboarding). */
  bindOnboarding(platform: { configure(settings: never): void }): void { this.onboarding = platform; }
  dispatchDecision(messageId: string): unknown {
    if (!this.decisions.has(messageId)) throw new Error("fixture_dispatch_decision_missing");
    return structuredClone(this.decisions.get(messageId));
  }
  /** The Coordinator's injected cross-team decision for a message; its absence fails the turn, as a missing dispatch decision does. */
  crossTeamDecision(messageId: string): unknown {
    if (!this.crossTeamDecisions.has(messageId)) throw new Error("fixture_cross_team_decision_missing");
    return structuredClone(this.crossTeamDecisions.get(messageId));
  }
  /**
   * The next injected Team Leader plan for a message, one per turn; the last one repeats once the list is used up. A team the
   * message gave its own turns (`teamTurns`) takes those. Undefined when none was injected, so the fixture Team Leader plans its default.
   */
  leaderPlan(messageId: string, teamId?: string): unknown {
    const plans = (teamId === undefined ? undefined : this.teamTurns.get(`${messageId}\u0000${teamId}`)?.leaderPlan) ?? this.leaderPlans.get(messageId);
    if (!plans?.length) return undefined;
    return structuredClone(plans.length > 1 ? plans.shift() : plans[0]);
  }
  leaderClosing(messageId: string, teamId?: string): unknown {
    const team = teamId === undefined ? undefined : this.teamTurns.get(`${messageId}\u0000${teamId}`);
    return structuredClone(team && "leaderClosing" in team ? team.leaderClosing : this.leaderClosings.get(messageId));
  }
  leaderSupplement(messageId: string, teamId?: string): unknown {
    const team = teamId === undefined ? undefined : this.teamTurns.get(`${messageId}\u0000${teamId}`);
    return structuredClone(team && "leaderSupplement" in team ? team.leaderSupplement : this.leaderSupplements.get(messageId));
  }
  /**
   * The model's tool calls and reply for an Executor turn on `messageId`. An Assignment whose title the message gave its own
   * turn (`executorTurns`) takes that one; the others share the message's.
   */
  dispatchToolQueue(messageId: string, title?: string): FixtureModelToolCallQueue {
    const key = title !== undefined && this.completions.has(executorTurnKey(messageId, title)) ? executorTurnKey(messageId, title) : messageId;
    return { takeFixtureModelToolCall: () => this.dispatchCalls.get(key)?.shift(), takeFixtureModelCompletion: () => {
      const completion = this.completions.get(key); return completion?.promise;
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
    if (input.onboardingControl !== undefined) {
      const control = input.onboardingControl;
      if (!this.onboarding || !control || typeof control !== "object" || Array.isArray(control)) throw new Error("fixture_onboarding_control_invalid");
      this.onboarding.configure(control as never);
      return;
    }
    if (input.modelControl !== undefined) {
      const control = input.modelControl as { messageId?: unknown; title?: unknown; action?: unknown };
      const key = typeof control.messageId === "string" && typeof control.title === "string" ? executorTurnKey(control.messageId, control.title) : control.messageId;
      if (typeof key !== "string" || control.action !== "release" || !this.completions.has(key)) throw new Error("fixture_model_control_invalid");
      this.completions.get(key)!.release(); return;
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
    if (input.leaderSupplement !== undefined && event?.message?.message_id) this.leaderSupplements.set(event.message.message_id, structuredClone(input.leaderSupplement));
    if (input.crossTeamDecision !== undefined && event?.message?.message_id) this.crossTeamDecisions.set(event.message.message_id, structuredClone(input.crossTeamDecision));
    if (input.teamTurns !== undefined && event?.message?.message_id) {
      if (!input.teamTurns || typeof input.teamTurns !== "object" || Array.isArray(input.teamTurns) || Object.keys(input.teamTurns).length > 5) throw new Error("fixture_team_turns_invalid");
      for (const [teamId, turns] of Object.entries(input.teamTurns as Record<string, { leaderPlan?: unknown; leaderClosing?: unknown; leaderSupplement?: unknown }>)) {
        const plans = turns.leaderPlan === undefined ? undefined : Array.isArray(turns.leaderPlan) ? turns.leaderPlan : [turns.leaderPlan];
        if (plans && (plans.length === 0 || plans.length > 5)) throw new Error("fixture_leader_plan_invalid");
        this.teamTurns.set(`${event.message.message_id}\u0000${teamId}`, structuredClone({ ...(plans ? { leaderPlan: plans } : {}),
          ...(turns.leaderClosing !== undefined ? { leaderClosing: turns.leaderClosing } : {}), ...(turns.leaderSupplement !== undefined ? { leaderSupplement: turns.leaderSupplement } : {}) }));
      }
    }
    if (input.executorTurns !== undefined && event?.message?.message_id) {
      if (!input.executorTurns || typeof input.executorTurns !== "object" || Array.isArray(input.executorTurns) || Object.keys(input.executorTurns).length > 20) throw new Error("fixture_executor_turns_invalid");
      for (const [title, turn] of Object.entries(input.executorTurns as Record<string, { modelReply?: unknown; modelHold?: unknown; modelToolCalls?: unknown }>)) {
        const key = executorTurnKey(event.message.message_id, title);
        this.completions.set(key, heldCompletion(typeof turn.modelReply === "string" ? turn.modelReply : undefined, turn.modelHold === true));
        if (turn.modelToolCalls !== undefined) this.dispatchCalls.set(key, toolCalls(turn.modelToolCalls));
      }
    }
    if ((input.modelHold === true || input.modelReply !== undefined) && event?.message?.message_id) {
      if (input.modelReply !== undefined && typeof input.modelReply !== "string") throw new Error("fixture_model_reply_invalid");
      this.completions.set(event.message.message_id, heldCompletion(input.modelReply as string | undefined, input.modelHold === true));
    }
    if (event?.message?.message_id) this.messages.set(event.message.message_id, {
      message_id: event.message.message_id, chat_id: event.message.chat_id, msg_type: event.message.message_type, body: { content: event.message.content },
    });
    if (event?.message?.message_id && input.messageDetails !== undefined) this.messages.set(event.message.message_id, structuredClone(input.messageDetails));
    if (input.modelToolCalls !== undefined) {
      const calls = toolCalls(input.modelToolCalls);
      if (input.dispatchDecision !== undefined && event?.message?.message_id) this.dispatchCalls.set(event.message.message_id, calls);
      else this.calls.push(...calls);
    }
    await this.handlers.message(input.event);
  }
}

/** Where an Assignment's own fixture turn is kept: its message and its title. */
function executorTurnKey(messageId: string, title: string): string { return `${messageId}\u0000${title}`; }
/** A model completion that resolves with `reply` (the default fixture reply when absent) at once, or when released if `hold`. */
function heldCompletion(reply: string | undefined, hold: boolean): { promise: Promise<string>; release(): void } {
  if (reply !== undefined && reply.length > 64000) throw new Error("fixture_model_reply_invalid");
  const text = reply ?? JSON.stringify({ message: "这是 fixture Codex 回复。", results: [] });
  let resolve!: (reply: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  const release = () => resolve(text);
  if (!hold) release();
  return { promise, release };
}
function toolCalls(value: unknown): FixtureModelToolCall[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("fixture_tools_invalid");
  return structuredClone(value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("fixture_tools_invalid");
    const call = item as Record<string, unknown>;
    if (typeof call.namespace !== "string" || typeof call.tool !== "string") throw new Error("fixture_tools_invalid");
    return { namespace: call.namespace, tool: call.tool, arguments: call.arguments };
  }));
}
