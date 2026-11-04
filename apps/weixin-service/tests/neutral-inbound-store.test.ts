import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import type { InboundContent } from "../src/channel-contract.js";

// Durable admission seam only; authenticated platform decoding and phone delivery are separate.
const message: InboundContent = {
  key: "a".repeat(64), accountId: "feishu.account", target: "feishu.conversation",
  senderId: "ou_owner", conversationType: "private", messageId: "om_message",
  source: "text", text: "可靠消息", receivedAt: 1_800_000_000_000,
};

it("durably accepts neutral messages once without creating a Weixin checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "neutral-inbox-"));
  const path = join(directory, "inbox.sqlite");
  let store = new DurableInboundStore(path);
  try {
    expect(store.ingestMessage(message, "b".repeat(64))).toEqual({ inserted: 1, duplicates: 0 });
    store.close();
    store = new DurableInboundStore(path);
    expect(store.ingestMessage({ ...message, text: "duplicate changed" }, "c".repeat(64))).toEqual({ inserted: 0, duplicates: 1 });
    expect(store.checkpoint("feishu.account")).toBeNull();
    expect(store.queuedTargets("feishu.account")).toEqual(["feishu.conversation"]);
    const job = store.leaseNext("feishu.account", "feishu.conversation", "worker", 1000)!;
    expect(job).toMatchObject({ text: "可靠消息", state: "leased", admission: { senderId: "ou_owner", conversationType: "private", bindingHash: "b".repeat(64) } });
    store.complete(job.eventKey, "worker", job.revision);
    expect(store.peek(message.key)?.state).toBe("completed");
    expect(store.ingestMessage(message, "b".repeat(64))).toEqual({ inserted: 0, duplicates: 1 });
    expect(store.queuedTargets("feishu.account")).toEqual([]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("blocks uncertain processing after restart without replay or bypass by the next message", () => {
  const directory = mkdtempSync(join(tmpdir(), "neutral-inbox-"));
  const path = join(directory, "inbox.sqlite");
  let now = 1_800_000_000_000;
  let store = new DurableInboundStore(path, () => now);
  try {
    store.ingestMessage(message, "b".repeat(64));
    store.ingestMessage({ ...message, key: "d".repeat(64), messageId: "om_second", receivedAt: now + 1 }, "b".repeat(64));
    expect(store.leaseNext(message.accountId, message.target, "worker", 1000)?.state).toBe("leased");
    store.close();
    now += 1001;
    store = new DurableInboundStore(path, () => now);
    expect(store.blockExpiredLeases()).toBe(1);
    expect(store.peek(message.key)?.state).toBe("recovery_blocked");
    expect(store.peek("d".repeat(64))?.state).toBe("queued");
    expect(store.leaseNext(message.accountId, message.target, "next-worker", 1000)).toBeNull();
    expect(store.queuedTargets(message.accountId)).toEqual([]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("preserves normalized current and quoted attachments across reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "neutral-media-inbox-"));
  const database = join(directory, "inbox.sqlite");
  let store = new DurableInboundStore(database);
  const image = { kind: "image" as const, path: join(directory, "image.png"), fileName: "image.png", mimeType: "image/png", sizeBytes: 12, quoted: false };
  const file = { kind: "file" as const, path: join(directory, "file.pdf"), fileName: "报告.pdf", mimeType: "application/pdf", sizeBytes: 25, quoted: true };
  try {
    expect(() => store.ingestMessage({ ...message, attachments: [{ ...image, path: "relative.png" }] }, "b".repeat(64))).toThrow("inbound_media_invalid");
    expect(() => store.ingestMessage({ ...message, quote: { text: "a".repeat(8001), attachments: [] } }, "b".repeat(64))).toThrow("inbound_quote_invalid");
    expect(store.queuedTargets(message.accountId)).toEqual([]);
    expect(store.ingestMessage({ ...message, source: "media", attachments: [image], quote: { text: "原始说明", attachments: [file] } }, "b".repeat(64))).toEqual({ inserted: 1, duplicates: 0 });
    store.close(); store = new DurableInboundStore(database);
    const job = store.leaseNext(message.accountId, message.target, "media-worker", 1000);
    expect(job).toMatchObject({ source: "media", text: "可靠消息",
      attachments: [{ kind: "image", path: join(directory, "image.png"), fileName: "image.png", mimeType: "image/png", sizeBytes: 12, quoted: false }],
      quote: { text: "原始说明", attachments: [{ kind: "file", path: join(directory, "file.pdf"), fileName: "报告.pdf", mimeType: "application/pdf", sizeBytes: 25, quoted: true }] },
    });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
