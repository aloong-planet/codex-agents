import crypto, { randomBytes } from "node:crypto";

import type {
  ChannelSnapshot,
  SendTextResult,
  InboundTextEvent,
  FixtureOutboxEntry,
  FixtureTextOutboxEntry,
  LocalLabelUpdate,
  LoginHandle,
  WeixinChannel,
} from "./demo-service.js";
import type { LoginOutputEvent } from "./login-output.js";
import type { DurableInboundJob, DurableInboundStore } from "./durable-inbound-store.js";
import type { FixtureModelToolCall } from "./fixture-app-server-transport.js";

/** Browser-test-only port. It is reachable only when DEMO_MODE=fixture is explicit. */
export class FixturePort implements WeixinChannel {
  private snapshot: ChannelSnapshot = {
    accounts: [{ accountId: "fixture-bot", label: "测试账户", credentialStatus: "usable" }],
    targets: [
      {
        accountId: "fixture-bot",
        target: "fixture-user@im.wechat",
        label: "测试目标",
        lastInboundAt: 1_720_000_000_000,
        contextUpdatedAt: 1_720_000_000_000,
      },
    ],
  };
  private readonly snapshotListeners = new Set<(snapshot: ChannelSnapshot) => void>();
  private readonly inboundListeners = new Set<(event: InboundTextEvent) => unknown>();
  private readonly inboundCommandHandlers = new Set<(event: InboundTextEvent) => boolean | Promise<boolean>>();
  private loginListener: ((event: LoginOutputEvent) => void) | null = null;
  private inboundSequence = 0;
  private readonly fixtureOutbox: FixtureOutboxEntry[] = [];
  private readonly fixtureReplies: { accountId: string; target: string; message: string }[] = [];
  getFixtureReplies() { return structuredClone(this.fixtureReplies); }
  private readonly fixtureTextOutbox: FixtureTextOutboxEntry[] = [];
  private readonly fixtureModelToolCalls: FixtureModelToolCall[] = [];
  private inboundDispatchActive = false;
  private drainScheduled = false;
  private readonly drainingTargets = new Map<string, Promise<void>>();

  constructor(private readonly inboundStore?: DurableInboundStore, private readonly failStartup = false) {}

  async start(): Promise<void> {
    if (this.failStartup) throw new Error("fixture_weixin_startup_failed");
    this.publishSnapshot();
  }

  activateInboundDispatch(): void {
    this.inboundDispatchActive = true;
    this.scheduleDurableDrain();
  }

  pauseInboundDispatch(): void {
    this.inboundDispatchActive = false;
  }

  queueFixtureModelToolCall(call: FixtureModelToolCall): void {
    this.fixtureModelToolCalls.push(structuredClone(call));
  }

  queueFixtureModelToolCalls(calls: FixtureModelToolCall[]): void {
    this.fixtureModelToolCalls.push(...structuredClone(calls));
  }

  takeFixtureModelToolCall(): FixtureModelToolCall | undefined {
    return this.fixtureModelToolCalls.shift();
  }

  getDeliveryContext(accountId: string, target: string) {
    const snapshot = this.getSnapshot();
    const account = snapshot.accounts.find((item) => item.accountId === accountId);
    const context = snapshot.targets.find((item) => item.accountId === accountId && item.target === target);
    const durable = this.inboundStore?.checkpoint(accountId)?.contexts.find((item) => item.target === target);
    return { credentialGeneration: `fixture-binding:${accountId}`, credentialStatus: account?.credentialStatus ?? "stale",
      contextGeneration: context ? durable?.generation ?? `fixture-initial:${context.contextUpdatedAt ?? 0}` : null };
  }

  getSnapshot(): ChannelSnapshot {
    return structuredClone(this.snapshot);
  }

  onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.snapshotListeners.delete(listener);
  }

  onInboundText(listener: (event: InboundTextEvent) => unknown): () => void {
    this.inboundListeners.add(listener);
    this.scheduleDurableDrain();
    return () => this.inboundListeners.delete(listener);
  }

  onInboundCommand(handler: (event: InboundTextEvent) => boolean | Promise<boolean>): () => void {
    this.inboundCommandHandlers.add(handler);
    this.scheduleDurableDrain();
    return () => this.inboundCommandHandlers.delete(handler);
  }

  updateLocalLabels(input: LocalLabelUpdate): void {
    this.snapshot.accounts = this.snapshot.accounts.map((account) => {
      if (account.accountId !== input.accountId || input.accountLabel === undefined) return account;
      const next = { ...account };
      const label = input.accountLabel.trim();
      if (label) next.label = label;
      else delete next.label;
      return next;
    });
    this.snapshot.targets = this.snapshot.targets.map((target) => {
      if (
        target.accountId !== input.accountId ||
        target.target !== input.target ||
        input.targetLabel === undefined
      ) {
        return target;
      }
      const next = { ...target };
      const label = input.targetLabel.trim();
      if (label) next.label = label;
      else delete next.label;
      return next;
    });
    this.publishSnapshot();
  }

  startLogin(
    onEvent: (event: LoginOutputEvent) => void,
    onExit: (result: { ok: boolean; message?: string }) => void,
  ): LoginHandle {
    void onExit;
    this.loginListener = onEvent;
    queueMicrotask(() => {
      onEvent({ kind: "qr", url: "https://ilinkai.weixin.qq.com/fixture-browser-test" });
    });
    return { submitPairCode() {}, terminate() {} };
  }

  async emitFixtureInbound(text = "fixture 首条消息"): Promise<void> {
    this.loginListener?.({ kind: "connected" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const target = "fixture-user@im.wechat";
    this.inboundSequence += 1;
    const eventKey = randomBytes(32).toString("hex");
    const receivedAt = Date.now();
    this.snapshot = {
      ...this.snapshot,
      targets: this.snapshot.targets.map((item) =>
        item.accountId === "fixture-bot" && item.target === target
          ? { ...item, lastInboundAt: receivedAt, contextUpdatedAt: receivedAt }
          : item,
      ),
    };
    const event: InboundTextEvent = {
      key: eventKey,
      accountId: "fixture-bot",
      target,
      messageId: `fixture-message-${eventKey}`,
      source: "text",
      text,
      receivedAt,
      startTyping: async () => ({
        active: false,
        diagnostics: {
          ticketCache: "hit",
          getConfig: { durationMs: 0, outcome: "skipped" },
          sendStart: { durationMs: 12, outcome: "failed" },
        },
        async stop() {},
      }),
      replyText: async (message) => {
        this.fixtureReplies.push({ accountId: "fixture-bot", target, message });
        return {
        ok: true,
        messageId: "fixture-welcome",
        diagnostics: {
          prepare: { durationMs: 2, outcome: "completed" },
          sendMessage: { durationMs: 31, outcome: "completed" },
          responseRead: { durationMs: 3, outcome: "completed" },
          stateSave: { durationMs: 6, outcome: "completed" },
          requestCount: 1,
        },
        };
      },
    };
    if (this.inboundStore) {
      this.inboundStore.ingestBatch({
        accountId: event.accountId,
        nextCursor: `fixture-cursor-${this.inboundSequence}`,
        contexts: [{
          target: event.target,
          contextToken: "fixture-context-token",
          generation: crypto.randomUUID(),
          lastInboundAt: receivedAt,
          contextUpdatedAt: receivedAt,
        }],
        envelopes: [{
          eventKey: event.key,
          accountId: event.accountId,
          target: event.target,
          messageId: event.messageId,
          kind: "message",
          source: event.source,
          text: event.text,
          receivedAt: event.receivedAt,
          observedAt: receivedAt,
          contextToken: "fixture-context-token",
        }],
      });
      this.publishSnapshot();
      if (this.inboundDispatchActive) await this.ensureDurableDrain(event.accountId, event.target);
      return;
    }
    this.publishSnapshot();
    await this.dispatchInbound(event);
  }

  private async dispatchInbound(event: InboundTextEvent): Promise<void> {
    let handled = false;
    for (const handler of this.inboundCommandHandlers) {
      if (await handler(event)) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      for (const listener of this.inboundListeners) await listener(event);
    }
  }

  private scheduleDurableDrain(): void {
    if (!this.inboundStore || !this.inboundDispatchActive || this.drainScheduled ||
        (this.inboundListeners.size === 0 && this.inboundCommandHandlers.size === 0)) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.inboundStore!.blockExpiredLeases();
      for (const account of this.snapshot.accounts) {
        for (const target of this.inboundStore!.queuedTargets(account.accountId)) {
          void this.ensureDurableDrain(account.accountId, target).catch(() => {});
        }
      }
    });
  }

  private ensureDurableDrain(accountId: string, target: string): Promise<void> {
    const key = `${accountId}\u0000${target}`;
    const active = this.drainingTargets.get(key);
    if (active) return active;
    const drain = this.drainDurableInbound(accountId, target).finally(() => {
      if (this.drainingTargets.get(key) === drain) this.drainingTargets.delete(key);
      this.scheduleDurableDrain();
    });
    this.drainingTargets.set(key, drain);
    return drain;
  }

  private async drainDurableInbound(accountId: string, target: string): Promise<void> {
    if (!this.inboundStore) return;
    const owner = "fixture-port";
    while (this.inboundDispatchActive &&
           (this.inboundListeners.size > 0 || this.inboundCommandHandlers.size > 0)) {
      const lease = this.inboundStore.leaseNext(accountId, target, owner, 24 * 60 * 60 * 1_000);
      if (!lease) return;
      await this.dispatchInbound(this.bindDurableMessage(lease));
      this.inboundStore.complete(lease.eventKey, owner, lease.revision);
    }
  }

  private bindDurableMessage(job: DurableInboundJob): InboundTextEvent {
    return {
      key: job.eventKey,
      accountId: job.accountId,
      target: job.target,
      messageId: job.messageId,
      source: job.source,
      text: job.text,
      ...(job.attachments ? { attachments: job.attachments } : {}),
      ...(job.quote ? { quote: job.quote } : {}),
      receivedAt: job.receivedAt,
      observedAt: job.observedAt,
      startTyping: async () => ({
        active: false,
        diagnostics: {
          ticketCache: "hit",
          getConfig: { durationMs: 0, outcome: "skipped" },
          sendStart: { durationMs: 12, outcome: "failed" },
        },
        async stop() {},
      }),
      replyText: async (message) => {
        this.fixtureReplies.push({ accountId: job.accountId, target: job.target, message });
        return {
        ok: true,
        messageId: "fixture-welcome",
        diagnostics: {
          prepare: { durationMs: 2, outcome: "completed" },
          sendMessage: { durationMs: 31, outcome: "completed" },
          responseRead: { durationMs: 3, outcome: "completed" },
          stateSave: { durationMs: 6, outcome: "completed" },
          requestCount: 1,
        },
        };
      },
    };
  }

  async sendText(input: { accountId: string; target: string; message: string; scheduled?: import("./demo-service.js").ScheduledTextSubmission }): Promise<SendTextResult> {
    if (input.scheduled && !input.scheduled.beforeSubmit()) return { ok: false, reason: "context_missing", acceptedSegments: 0 };
    this.fixtureTextOutbox.push({ message: input.message, simulated: true, acceptedAt: Date.now() });
    return { ok: true, messageId: "fixture-message" };
  }

  getFixtureTextOutbox(): FixtureTextOutboxEntry[] {
    return this.fixtureTextOutbox.map((entry) => ({ ...entry }));
  }

  recordFixtureFile(input: { fileName: string; displayPath: string }): void {
    this.fixtureOutbox.push({
      kind: "file",
      fileName: input.fileName,
      displayPath: input.displayPath,
      simulated: true,
      acceptedAt: Date.now(),
    });
  }

  recordFixtureImage(input: { fileName: string; displayPath: string }): void {
    this.fixtureOutbox.push({
      kind: "image",
      fileName: input.fileName,
      displayPath: input.displayPath,
      simulated: true,
      acceptedAt: Date.now(),
    });
  }

  getFixtureOutbox(): FixtureOutboxEntry[] {
    return this.fixtureOutbox.map((entry) => ({ ...entry }));
  }

  async close(): Promise<void> {
    this.inboundDispatchActive = false;
    this.snapshotListeners.clear();
    this.inboundListeners.clear();
    this.inboundCommandHandlers.clear();
    this.loginListener = null;
    await Promise.allSettled([...this.drainingTargets.values()]);
  }

  private publishSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.snapshotListeners) listener(snapshot);
  }
}
