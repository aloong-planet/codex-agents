import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurableInboundStore } from "../src/durable-inbound-store.js";

const tempDirs: string[] = [];

function storeInTemp(): DurableInboundStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbound-store-"));
  tempDirs.push(directory);
  return new DurableInboundStore(path.join(directory, "inbound.sqlite"), () => 1_800_000_000_000);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("DurableInboundStore", () => {
  it("commits the inbound envelope, next cursor, and context checkpoint together", () => {
    const store = storeInTemp();

    const receipt = store.ingestBatch({
      accountId: "direct-bot@im.bot",
      nextCursor: "cursor-2",
      contexts: [{
        target: "owner@im.wechat",
        contextToken: "private-context-token",
        lastInboundAt: 1_799_999_999_000,
        contextUpdatedAt: 1_800_000_000_000,
      }],
      envelopes: [{
        eventKey: "a".repeat(64),
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        messageId: "message-1",
        kind: "message",
        source: "text",
        text: "可靠入站",
        receivedAt: 1_799_999_999_000,
        observedAt: 1_800_000_000_000,
        contextToken: "private-context-token",
      }],
    });

    expect(receipt).toEqual({ inserted: 1, duplicates: 0 });
    expect(store.checkpoint("direct-bot@im.bot")).toEqual({
      accountId: "direct-bot@im.bot",
      getUpdatesBuf: "cursor-2",
      contexts: [{
        target: "owner@im.wechat",
        contextToken: "private-context-token",
        lastInboundAt: 1_799_999_999_000,
        contextUpdatedAt: 1_800_000_000_000,
      }],
    });
    expect(store.peekQueued("direct-bot@im.bot", "owner@im.wechat")).toMatchObject({
      eventKey: "a".repeat(64),
      text: "可靠入站",
      state: "queued",
    });
    store.close();
  });

  it("bootstraps a legacy checkpoint once and restores it across store instances", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbound-bootstrap-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "inbound.sqlite");
    const first = new DurableInboundStore(databasePath, () => 1_800_000_000_000);

    expect(first.bootstrapCheckpoint({
      accountId: "direct-bot@im.bot",
      getUpdatesBuf: "legacy-cursor",
      contexts: [{
        target: "owner@im.wechat",
        contextToken: "legacy-context",
        lastInboundAt: 1_799_999_998_000,
        contextUpdatedAt: 1_799_999_999_000,
      }],
    })).toBe(true);
    expect(first.bootstrapCheckpoint({
      accountId: "direct-bot@im.bot",
      getUpdatesBuf: "must-not-overwrite",
      contexts: [],
    })).toBe(false);
    first.close();

    const reopened = new DurableInboundStore(databasePath);
    expect(reopened.checkpoint("direct-bot@im.bot")).toEqual({
      accountId: "direct-bot@im.bot",
      getUpdatesBuf: "legacy-cursor",
      contexts: [{
        target: "owner@im.wechat",
        contextToken: "legacy-context",
        lastInboundAt: 1_799_999_998_000,
        contextUpdatedAt: 1_799_999_999_000,
      }],
    });
    reopened.close();
  });

  it("deduplicates a replayed event while still advancing the checkpoint", () => {
    const store = storeInTemp();
    const envelope = {
      eventKey: "2".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat",
      messageId: "same-message", kind: "message" as const, source: "text" as const,
      text: "只入队一次", receivedAt: 1_799_999_999_000, observedAt: 1_800_000_000_000,
      contextToken: "context-1",
    };
    store.ingestBatch({
      accountId: "direct-bot@im.bot", nextCursor: "cursor-1",
      contexts: [{ target: "owner@im.wechat", contextToken: "context-1", lastInboundAt: envelope.receivedAt, contextUpdatedAt: envelope.observedAt }],
      envelopes: [envelope],
    });

    expect(store.ingestBatch({
      accountId: "direct-bot@im.bot", nextCursor: "cursor-2",
      contexts: [{ target: "owner@im.wechat", contextToken: "context-2", lastInboundAt: envelope.receivedAt + 1, contextUpdatedAt: envelope.observedAt + 1 }],
      envelopes: [{ ...envelope, text: "重放不覆盖原始正文", contextToken: "context-2" }],
    })).toEqual({ inserted: 0, duplicates: 1 });

    expect(store.peekQueued("direct-bot@im.bot", "owner@im.wechat")).toMatchObject({
      text: "只入队一次", contextToken: "context-1",
    });
    expect(store.checkpoint("direct-bot@im.bot")).toMatchObject({
      getUpdatesBuf: "cursor-2",
      contexts: [{ target: "owner@im.wechat", contextToken: "context-2" }],
    });
    store.close();
  });

  it("keeps queues isolated by account even when targets match", () => {
    const store = storeInTemp();
    for (const [index, accountId] of ["bot-a@im.bot", "bot-b@im.bot"].entries()) {
      store.ingestBatch({
        accountId, nextCursor: `cursor-${index}`,
        contexts: [{ target: "owner@im.wechat", contextToken: `context-${index}`, lastInboundAt: 1_799_999_999_000 + index, contextUpdatedAt: 1_800_000_000_000 }],
        envelopes: [{ eventKey: String(index + 3).repeat(64), accountId, target: "owner@im.wechat", messageId: `message-${index}`, kind: "message", source: "text", text: `账户 ${index}`, receivedAt: 1_799_999_999_000 + index, observedAt: 1_800_000_000_000, contextToken: `context-${index}` }],
      });
    }

    expect(store.leaseNext("bot-a@im.bot", "owner@im.wechat", "worker", 1_000)).toMatchObject({ text: "账户 0" });
    expect(store.leaseNext("bot-b@im.bot", "owner@im.wechat", "worker", 1_000)).toMatchObject({ text: "账户 1" });
    store.close();
  });

  it("leases one target in FIFO order and blocks an expired lease instead of replaying it", () => {
    let now = 1_800_000_000_000;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbound-lease-"));
    tempDirs.push(directory);
    const store = new DurableInboundStore(path.join(directory, "inbound.sqlite"), () => now);
    store.ingestBatch({
      accountId: "direct-bot@im.bot",
      nextCursor: "cursor-lease",
      contexts: [
        { target: "owner@im.wechat", contextToken: "context-1", lastInboundAt: now - 2, contextUpdatedAt: now },
        { target: "other@im.wechat", contextToken: "context-2", lastInboundAt: now - 1, contextUpdatedAt: now },
      ],
      envelopes: [
        { eventKey: "a".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat", messageId: "first", kind: "message", source: "text", text: "第一条", receivedAt: now - 2, observedAt: now, contextToken: "context-1" },
        { eventKey: "b".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat", messageId: "second", kind: "message", source: "text", text: "第二条", receivedAt: now - 1, observedAt: now, contextToken: "context-1" },
        { eventKey: "c".repeat(64), accountId: "direct-bot@im.bot", target: "other@im.wechat", messageId: "parallel", kind: "message", source: "text", text: "另一个目标", receivedAt: now - 1, observedAt: now, contextToken: "context-2" },
      ],
    });

    expect(store.leaseNext("direct-bot@im.bot", "owner@im.wechat", "worker-1", 1_000)).toMatchObject({
      eventKey: "a".repeat(64),
      state: "leased",
      leaseOwner: "worker-1",
      attempts: 1,
    });
    expect(store.leaseNext("direct-bot@im.bot", "owner@im.wechat", "worker-2", 1_000)).toBeNull();
    expect(store.leaseNext("direct-bot@im.bot", "other@im.wechat", "worker-2", 1_000)).toMatchObject({
      eventKey: "c".repeat(64),
    });

    now += 1_001;
    expect(store.blockExpiredLeases()).toBe(2);
    expect(store.leaseNext("direct-bot@im.bot", "owner@im.wechat", "worker-3", 1_000)).toBeNull();
    expect(store.peek("a".repeat(64))).toMatchObject({ state: "recovery_blocked" });
    expect(store.peek("b".repeat(64))).toMatchObject({ state: "queued" });
    expect(store.queuedTargets("direct-bot@im.bot")).not.toContain("owner@im.wechat");
    store.close();
  });

  it("completes only the matching lease revision and then exposes the next queued job", () => {
    const store = storeInTemp();
    store.ingestBatch({
      accountId: "direct-bot@im.bot",
      nextCursor: "cursor-complete",
      contexts: [{ target: "owner@im.wechat", contextToken: "context", lastInboundAt: 1_799_999_999_000, contextUpdatedAt: 1_800_000_000_000 }],
      envelopes: [
        { eventKey: "d".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat", messageId: "first", kind: "message", source: "text", text: "第一条", receivedAt: 1_799_999_999_000, observedAt: 1_800_000_000_000, contextToken: "context" },
        { eventKey: "e".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat", messageId: "second", kind: "message", source: "text", text: "第二条", receivedAt: 1_799_999_999_001, observedAt: 1_800_000_000_000, contextToken: "context" },
      ],
    });
    const first = store.leaseNext("direct-bot@im.bot", "owner@im.wechat", "worker-1", 1_000)!;

    expect(() => store.complete(first.eventKey, "other-worker", first.revision)).toThrow("inbound_lease_conflict");
    store.complete(first.eventKey, "worker-1", first.revision);

    expect(store.peek(first.eventKey)).toMatchObject({ state: "completed" });
    expect(store.leaseNext("direct-bot@im.bot", "owner@im.wechat", "worker-1", 1_000)).toMatchObject({
      eventKey: "e".repeat(64),
    });
    store.close();
  });

  it("round-trips media, quotes, and rejected voice metadata without exposing them through the checkpoint", () => {
    const store = storeInTemp();
    const attachment = {
      kind: "image" as const,
      path: "/private/inbound/image.jpg",
      fileName: "image.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 123,
      quoted: false,
    };
    store.ingestBatch({
      accountId: "direct-bot@im.bot",
      nextCursor: "cursor-media",
      contexts: [{ target: "owner@im.wechat", contextToken: "context", lastInboundAt: 1_799_999_999_000, contextUpdatedAt: 1_800_000_000_000 }],
      envelopes: [
        {
          eventKey: "f".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat",
          messageId: "media", kind: "message", source: "media", text: "",
          attachments: [attachment],
          quote: { title: "引用", text: "原消息", attachments: [{ ...attachment, quoted: true }] },
          receivedAt: 1_799_999_999_000, observedAt: 1_800_000_000_000, contextToken: "context",
        },
        {
          eventKey: "1".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat",
          messageId: "voice", kind: "rejected", source: "voice", text: "",
          rejectionReason: "voice_transcript_missing", durationMs: 3_000,
          receivedAt: 1_799_999_999_001, observedAt: 1_800_000_000_000, contextToken: "context",
        },
      ],
    });

    expect(store.leaseNext("direct-bot@im.bot", "owner@im.wechat", "worker", 1_000)).toMatchObject({
      attachments: [attachment],
      quote: { title: "引用", text: "原消息", attachments: [{ quoted: true }] },
    });
    expect(JSON.stringify(store.checkpoint("direct-bot@im.bot"))).not.toContain("image.jpg");
    store.close();
  });
});
