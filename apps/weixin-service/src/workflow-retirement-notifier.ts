import type { ChannelSnapshot, SendTextResult } from "./channel-contract.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import type { WorkflowRunTargetStore } from "./workflow-run-target-store.js";
import { WEIXIN_FILE_WORKFLOW_MESSAGES } from "./workflow-delivery-messages.js";

interface RetirementDelivery {
  getSnapshot(): ChannelSnapshot;
  onSnapshotChanged(listener: () => void): () => void;
  sendText(input: { accountId: string; target: string; message: string }): Promise<SendTextResult>;
}

export class WorkflowRetirementNotifier {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly targets: WorkflowRunTargetStore,
    private readonly channel: RetirementDelivery,
  ) {}

  migrate(): string[] {
    this.engine.recoverRetirementNotices();
    return this.engine.retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired",
      ["notes.send-file-resolved", "media.send-local-image-resolved"]);
  }

  start(): void {
    if (this.closed || this.timer) return;
    const wake = () => { void this.runNow().catch(() => {}); };
    this.unsubscribe = this.channel.onSnapshotChanged(wake);
    this.timer = setInterval(wake, 60_000);
    this.timer.unref();
    wake();
  }

  async runNow(): Promise<void> {
    if (this.closed) return;
    if (this.running) return this.running;
    this.running = this.scan().finally(() => { this.running = undefined; });
    return this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.running;
  }

  private async scan(): Promise<void> {
    for (const notice of this.engine.listRetirementNotices()) {
      if (this.closed) return;
      if (notice.state !== "pending") continue;
      const target = this.targets.resolveRunTarget(notice.runId);
      if (!target) continue; // Never guess a missing historical recipient from the current panel selection.
      const snapshot = this.channel.getSnapshot();
      if (!snapshot.accounts.some((account) => account.accountId === target.accountId && account.credentialStatus === "usable") ||
          !snapshot.targets.some((item) => item.accountId === target.accountId && item.target === target.target)) continue;
      if (!this.engine.claimRetirementNotice(notice.runId)) continue;
      let state: "pending" | "accepted" | "failed" | "unknown" = "unknown";
      try {
        const result = await this.channel.sendText({ ...target, message: WEIXIN_FILE_WORKFLOW_MESSAGES.retired });
        if (result.ok) state = "accepted";
        else if ((result.acceptedSegments ?? 0) > 0 || result.duplicatePossible) state = "unknown";
        else if (result.acceptedSegments === 0 &&
          ["context_missing", "context_stale", "auth_stale", "unavailable"].includes(result.reason ?? "")) state = "pending";
        else if (result.reason === "rejected") state = "failed";
      } catch { /* A transport exception cannot prove the message was not accepted. */ }
      this.engine.finishRetirementNotice(notice.runId, state);
    }
  }
}
