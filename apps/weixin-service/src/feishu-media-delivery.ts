import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MediaDeliveryPort, MediaDeliveryInput } from "./media-delivery.js";
import type { SendTextResult } from "./channel-contract.js";
import type { DurableEffectLedger } from "./durable-effect-ledger.js";
import type { ChannelStartupConfiguration } from "./channel-startup-config.js";

export interface FeishuMediaTransport {
  upload(input: { kind: "image" | "file"; bytes: Buffer; fileName: string }): Promise<string>;
  sendResource(input: { chatId: string; msgType: "image" | "file" | "post"; content: string; uuid: string }):
    Promise<{ code?: number; data?: { message_id?: string } }>;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rejected = (): SendTextResult => ({ ok: false, reason: "rejected", acceptedSegments: 0 });

/** Converts already authorized private snapshots into one durable, owner-bound media submission. */
export class FeishuMediaDelivery implements MediaDeliveryPort {
  constructor(private readonly config: Pick<ChannelStartupConfiguration, "owner" | "binding">, private readonly transport: FeishuMediaTransport,
    private readonly ledger: DurableEffectLedger, private readonly snapshotRoots: readonly string[],
    private readonly ready: () => boolean,
    private readonly destination: import("./media-delivery.js").MediaDeliveryDestination = config.owner.conversationAddress()) {
    if (config.binding.channel !== "feishu" || !config.owner.admit({ ...config.binding, conversationType: "private" })) {
      throw new Error("feishu_media_binding_invalid");
    }
    if (!config.owner.deliveryTarget(destination.accountId, destination.target)) throw new Error("feishu_media_binding_invalid");
  }

  sendImage(input: MediaDeliveryInput & { caption?: string }): Promise<SendTextResult> { return this.send("image", input); }
  sendFile(input: MediaDeliveryInput & { fileName?: string }): Promise<SendTextResult> { return this.send("file", input); }
  async reconcile(operationId: string) {
    const rows = this.ledger.listByOperation(this.operation(operationId));
    const row = rows.find((item) => item.kind === "feishu_media");
    if (row?.state === "accepted") return { status: "accepted" as const };
    if (row?.state === "rejected") return { status: "rejected" as const, errorCode: "feishu_media_rejected" };
    return { status: "unknown" as const };
  }

  private operation(id: string): string {
    return `feishu-media:${hash(JSON.stringify([this.destination, id]))}`;
  }

  private async send(kind: "image" | "file", input: MediaDeliveryInput & { caption?: string; fileName?: string }): Promise<SendTextResult> {
    if (input.accountId !== this.destination.accountId || input.target !== this.destination.target || input.senderAccountId !== this.destination.senderAccountId || !this.ready()) {
      return { ok: false, reason: "unavailable", acceptedSegments: 0 };
    }
    const fileName = input.fileName ?? path.basename(input.filePath);
    if (!fileName || fileName.length > 255 || /[/\\\r\n\0]/u.test(fileName) || fileName === "." || fileName === ".." ||
        (input.caption !== undefined && Array.from(input.caption).length > 12000)) return rejected();
    let bytes: Buffer;
    try { bytes = this.readSnapshot(input.filePath, (kind === "image" ? 10 : 30) * 1024 * 1024); }
    catch { return rejected(); }
    const operationId = this.operation(input.operationId);
    const attemptId = `${operationId}:submit`;
    const clientId = hash(JSON.stringify([kind, hash(bytes), fileName, input.caption ?? ""])).slice(0, 32);
    const previous = this.ledger.listByOperation(operationId).find((row) => row.attemptId === attemptId);
    let record;
    try { record = this.ledger.prepare({ attemptId, operationId, ...this.destination, kind: "feishu_media", clientId }); }
    catch { return rejected(); }
    if (previous) {
      if (record.state === "accepted") return { ok: true, acceptedSegments: 1, totalSegments: 1 };
      return { ok: false, reason: record.state === "rejected" ? "rejected" : "unknown", acceptedSegments: 0 };
    }
    try {
      const key = await this.transport.upload({ kind, bytes, fileName });
      if (!key || key.length > 512) throw new Error("feishu_resource_key_invalid");
      if (!this.ready()) {
        this.ledger.settle(attemptId, "rejected");
        return { ok: false, reason: "unavailable", acceptedSegments: 0 };
      }
      const content = kind === "file" ? { file_key: key } : input.caption
        ? { zh_cn: { title: "", content: [[{ tag: "img", image_key: key }], [{ tag: "text", text: input.caption }]] } }
        : { image_key: key };
      const encoded = JSON.stringify(content);
      if (Buffer.byteLength(encoded) > 29 * 1024) { this.ledger.settle(attemptId, "rejected"); return rejected(); }
      const result = await this.transport.sendResource({ chatId: this.config.owner.deliveryTarget(this.destination.accountId, this.destination.target)!,
        msgType: kind === "image" && input.caption ? "post" : kind, content: encoded,
        uuid: hash(JSON.stringify([operationId, clientId])).slice(0, 32) });
      if (result.code === 0 && result.data?.message_id) {
        this.ledger.settle(attemptId, "accepted");
        return { ok: true, acceptedSegments: 1, totalSegments: 1, messageId: result.data.message_id };
      }
      const definite = Number.isSafeInteger(result.code) && result.code !== 0;
      this.ledger.settle(attemptId, definite ? "rejected" : "unknown");
      return { ok: false, reason: definite ? "rejected" : "unknown", acceptedSegments: 0 };
    } catch {
      this.ledger.settle(attemptId, "unknown");
      return { ok: false, reason: "unknown", acceptedSegments: 0 };
    }
  }

  private readSnapshot(candidate: string, limit: number): Buffer {
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error("snapshot_symlink");
    const real = fs.realpathSync(candidate);
    if (!this.snapshotRoots.some((root) => {
      try {
        const relative = path.relative(fs.realpathSync(root), real);
        return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
      } catch { return false; }
    })) throw new Error("snapshot_outside_root");
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size < 1 || before.size > limit) throw new Error("snapshot_size_invalid");
      const buffer = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
        if (!count) break;
        size += count;
      }
      const after = fs.fstatSync(fd);
      if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error("snapshot_changed");
      }
      return buffer.subarray(0, size);
    } finally { fs.closeSync(fd); }
  }
}
