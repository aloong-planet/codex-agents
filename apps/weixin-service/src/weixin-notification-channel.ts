import type { WeixinChannel } from "./demo-service.js";
import type { NotificationChannel, NotificationDestination, NotificationChannelState } from "./notification-channel.js";
import type { SendTextResult } from "./channel-contract.js";

export class WeixinNotificationChannel implements NotificationChannel {
  constructor(
    private readonly channel: Pick<WeixinChannel, "getSnapshot" | "getDeliveryContext" | "sendText" | "onSnapshotChanged">,
    private readonly enabled: (destination: NotificationDestination) => boolean,
    private readonly onFailure: (result: SendTextResult) => void = () => {},
  ) {}

  state(destination: NotificationDestination): NotificationChannelState {
    if (destination.channel && destination.channel !== "weixin") return { enabled: false, credentialStatus: "stale", credentialGeneration: "unavailable", contextGeneration: null };
    const { accountId, target } = destination;
    return {
      enabled: this.enabled(destination),
      contextUpdatedAt: this.channel.getSnapshot().targets.find((item) => item.accountId === accountId && item.target === target)?.contextUpdatedAt ?? 0,
      ...(this.channel.getDeliveryContext?.(accountId, target) ?? { credentialGeneration: "unavailable", contextGeneration: null, credentialStatus: "stale" as const }),
    };
  }

  subscribe(listener: () => void): () => void { return this.channel.onSnapshotChanged(listener); }

  async send(input: Parameters<NotificationChannel["send"]>[0]): Promise<SendTextResult> {
    let result: SendTextResult;
    if (!this.state(input).enabled || !input.beforeSubmit()) result = { ok: false, reason: "unavailable", acceptedSegments: 0 };
    else {
      try {
        result = await this.channel.sendText({ accountId: input.accountId, target: input.target, message: input.message,
          scheduled: { operationId: input.operationId, beforeSubmit: input.beforeSubmit } });
      } catch { result = { ok: false, reason: "unknown" }; }
    }
    if (!result.ok) { try { this.onFailure(result); } catch { /* Local reporting cannot change the receipt. */ } }
    return result;
  }
}
