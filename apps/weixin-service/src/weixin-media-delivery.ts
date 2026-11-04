import type { DirectIlinkChannel } from "./direct-ilink-channel.js";
import type { MediaDeliveryPort } from "./media-delivery.js";

/** Keeps iLink destination resolution, upload conversion and ledger lookup behind the port. */
export class WeixinMediaDelivery implements MediaDeliveryPort {
  constructor(private readonly channel: Pick<DirectIlinkChannel, "sendImage" | "sendFile" | "reconcileMediaOperation">) {}

  sendImage(input: Parameters<MediaDeliveryPort["sendImage"]>[0]) {
    return this.channel.sendImage({
      accountId: input.accountId, target: input.target, filePath: input.filePath, operationId: input.operationId,
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
    });
  }

  sendFile(input: Parameters<MediaDeliveryPort["sendFile"]>[0]) {
    return this.channel.sendFile({
      accountId: input.accountId, target: input.target, filePath: input.filePath, operationId: input.operationId,
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    });
  }

  reconcile(operationId: string) { return this.channel.reconcileMediaOperation(operationId); }
}
