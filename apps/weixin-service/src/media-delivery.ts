import type { SendTextResult } from "./channel-contract.js";

/** Local artifact ceiling; a transport may impose a stricter submission limit. */
export const MAX_MEDIA_ARTIFACT_BYTES = 100 * 1024 * 1024;

export type MediaDeliveryDestination = { accountId: string; target: string };

export type MediaDeliveryInput = {
  accountId: string;
  target: string;
  filePath: string;
  operationId: string;
};
export type MediaDeliveryReconciliation =
  | { status: "accepted" }
  | { status: "rejected"; errorCode: string }
  | { status: "unknown"; errorCode?: string };

/** Receives a trusted destination and prepared local artifact, never platform credentials. */
export interface MediaDeliveryPort {
  sendImage(input: MediaDeliveryInput & { caption?: string }): Promise<SendTextResult>;
  sendFile(input: MediaDeliveryInput & { fileName?: string }): Promise<SendTextResult>;
  reconcile(operationId: string, destination?: MediaDeliveryDestination): Promise<MediaDeliveryReconciliation>;
}
