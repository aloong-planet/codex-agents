import type { NotificationChannel, NotificationChannelState, NotificationDestination } from "./notification-channel.js";

type Route = { destination: NotificationDestination & { channel: "weixin" | "feishu" }; channel: NotificationChannel };

/** Select only the adapter named by the frozen destination; never fall back. */
export class NotificationChannelRouter implements NotificationChannel {
  private readonly routes: readonly Route[];

  constructor(routes: readonly Route[]) {
    if (!routes.length || new Set(routes.map(({ destination }) => JSON.stringify([
      destination.channel, destination.accountId, destination.target,
    ]))).size !== routes.length) throw new Error("notification_channels_invalid");
    this.routes = routes.map(({ destination, channel }) => ({ destination: { ...destination }, channel }));
  }

  state(destination: NotificationDestination): NotificationChannelState {
    return this.resolve(destination)?.state(destination) ?? {
      enabled: false, credentialStatus: "stale", credentialGeneration: "unavailable", contextGeneration: null,
    };
  }

  subscribe(listener: () => void): () => void {
    const stops = this.routes.map(({ channel }) => channel.subscribe?.(listener));
    return () => { for (const stop of stops) stop?.(); };
  }

  async send(input: Parameters<NotificationChannel["send"]>[0]) {
    const channel = this.resolve(input);
    return channel ? channel.send(input) : { ok: false as const, reason: "unavailable" as const, acceptedSegments: 0 };
  }

  private resolve(destination: NotificationDestination): NotificationChannel | undefined {
    if (destination.senderAccountId && (destination.channel !== "feishu" || !destination.target.startsWith("feishu.group."))) return undefined;
    return this.routes.find((route) => route.destination.channel === (destination.channel ?? "weixin") &&
      route.destination.accountId === destination.accountId && route.destination.target === destination.target)?.channel;
  }
}
