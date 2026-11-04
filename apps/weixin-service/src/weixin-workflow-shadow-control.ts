import type { InboundTextEvent } from "./demo-service.js";
import type { CompletedInboundObserver, InboundWorkflowControl } from "./weixin-codex-service.js";

export type WeixinWorkflowShadowControlOptions = {
  shouldObserve: (event: InboundTextEvent) => boolean;
  alreadyObserved?: (event: InboundTextEvent) => boolean;
  maxPending?: number;
  onError?: (error: unknown) => void;
  close?: () => void;
};

export class WeixinWorkflowShadowObserver implements CompletedInboundObserver {
  private readonly queue: InboundTextEvent[] = [];
  private readonly scheduledKeys = new Set<string>();
  private readonly maxPending: number;
  private drainPromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly shadow: InboundWorkflowControl,
    private readonly options: WeixinWorkflowShadowControlOptions,
  ) {
    this.maxPending = options.maxPending ?? 32;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) {
      throw new Error("workflow_shadow_max_pending_invalid");
    }
  }

  observe(event: InboundTextEvent): void {
    if (this.closed) return;
    setImmediate(() => this.schedule(event));
  }

  async idle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.drainPromise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const event of this.queue.splice(0)) this.scheduledKeys.delete(event.key);
    try {
      this.options.close?.();
    } catch (error) {
      this.report(error);
    }
  }

  private schedule(event: InboundTextEvent): void {
    if (this.closed || this.scheduledKeys.has(event.key)) return;
    try {
      if (!this.options.shouldObserve(event) || this.options.alreadyObserved?.(event)) return;
    } catch (error) {
      this.report(error);
      return;
    }
    if (this.queue.length >= this.maxPending) {
      this.report(new Error("workflow_shadow_queue_full"));
      return;
    }
    this.scheduledKeys.add(event.key);
    this.queue.push(event);
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => { this.drainPromise = null; });
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const event = this.queue.shift();
      if (!event) return;
      try {
        const result = await this.shadow.tryHandle(event);
        if (result.handled && result.outcome === "failed") {
          this.report(new Error("workflow_shadow_failed"));
        }
      } catch (error) {
        this.report(error);
      } finally {
        this.scheduledKeys.delete(event.key);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics cannot affect the production owner.
    }
  }
}
