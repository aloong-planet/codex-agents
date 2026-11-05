import type { MediaDeliveryDestination, MediaDeliveryPort, MediaDeliveryReconciliation } from "./media-delivery.js";

type MediaRoute = { destination: MediaDeliveryDestination; delivery: MediaDeliveryPort };

/** Resolves both submission and recovery from the persisted run destination. */
export class MediaDeliveryRouter implements MediaDeliveryPort {
  private readonly routes: readonly MediaRoute[];

  constructor(routes: readonly MediaRoute[]) {
    if (routes.length === 0 || new Set(routes.map(({ destination }) => JSON.stringify([destination.accountId, destination.target, destination.senderAccountId]))).size !== routes.length) {
      throw new Error("media_routes_invalid");
    }
    this.routes = routes.map(({ destination, delivery }) => ({ destination: { ...destination }, delivery }));
  }

  async sendImage(input: Parameters<MediaDeliveryPort["sendImage"]>[0]) {
    const delivery = this.resolve(input);
    return delivery ? delivery.sendImage(input) : { ok: false as const, reason: "unavailable" as const, acceptedSegments: 0 };
  }
  async sendFile(input: Parameters<MediaDeliveryPort["sendFile"]>[0]) {
    const delivery = this.resolve(input);
    return delivery ? delivery.sendFile(input) : { ok: false as const, reason: "unavailable" as const, acceptedSegments: 0 };
  }
  async reconcile(operationId: string, destination?: MediaDeliveryDestination): Promise<MediaDeliveryReconciliation> {
    const delivery = destination && this.resolve(destination);
    return delivery ? delivery.reconcile(operationId, destination) : { status: "unknown", errorCode: "media_destination_unavailable" };
  }

  private resolve(destination: MediaDeliveryDestination): MediaDeliveryPort | undefined {
    return this.routes.find((route) => route.destination.accountId === destination.accountId && route.destination.target === destination.target && route.destination.senderAccountId === destination.senderAccountId)?.delivery;
  }
}
