import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { FixturePort } from "../src/fixture-port.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("FixturePort durable inbound parity", () => {
  it("publishes refreshed context only after its durable generation is available to recovery listeners", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-context-"));
    tempDirs.push(directory);
    const store = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
    const port = new FixturePort(store);
    const observed: Array<string | null> = [];
    const unsubscribe = port.onSnapshotChanged(() => observed.push(port.getDeliveryContext("fixture-bot", "fixture-user@im.wechat").contextGeneration));
    try {
      await port.emitFixtureInbound("刷新会话");
      expect(observed.at(-1)).toBe(store.checkpoint("fixture-bot")?.contexts[0]?.generation);
      const result = await port.sendText({ accountId: "fixture-bot", target: "fixture-user@im.wechat", message: "不能发送",
        scheduled: { operationId: "denied", beforeSubmit: () => false } });
      expect(result).toMatchObject({ ok: false, reason: "context_missing", acceptedSegments: 0 });
      expect(port.getFixtureTextOutbox()).toEqual([]);
    } finally { unsubscribe(); port.close(); store.close(); }
  });

  it("does not deduplicate a new message after the fixture port restarts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-inbound-identity-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "inbound.sqlite");
    const received: string[] = [];
    for (const text of ["创建待选请求", "我想要第二个"]) {
      const store = new DurableInboundStore(databasePath);
      const port = new FixturePort(store);
      try {
        port.onInboundText((event) => { received.push(event.text); });
        port.activateInboundDispatch();
        await port.emitFixtureInbound(text);
      } finally {
        await port.close();
        store.close();
      }
    }
    expect(received).toEqual(["创建待选请求", "我想要第二个"]);
  });

  it("persists, leases, dispatches, and completes fixture inbound before returning", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-inbound-"));
    tempDirs.push(directory);
    const store = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
    const port = new FixturePort(store);
    const received = vi.fn();
    port.onInboundText(received);
    port.activateInboundDispatch();

    await port.emitFixtureInbound("把相册中最新一张图片发给我");

    expect(received).toHaveBeenCalledTimes(1);
    const event = received.mock.calls[0]?.[0];
    expect(event?.text).toBe("把相册中最新一张图片发给我");
    expect(store.peek(event.key)).toMatchObject({ state: "completed", attempts: 1 });
    expect(store.checkpoint("fixture-bot")).toMatchObject({
      getUpdatesBuf: "fixture-cursor-1",
    });
    expect(store.queuedTargets("fixture-bot")).toEqual([]);

    await port.close();
    store.close();
  });

  it("pending_and_inbox_recover_after_restart drains queued inbox in original order", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-inbound-restart-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "inbound.sqlite");
    const first = new DurableInboundStore(databasePath, () => 1_800_000_000_000);
    first.ingestBatch({
      accountId: "fixture-bot",
      nextCursor: "fixture-cursor-restart",
      contexts: [{
        target: "fixture-user@im.wechat",
        contextToken: "fixture-context-token",
        lastInboundAt: 1_799_999_999_000,
        contextUpdatedAt: 1_800_000_000_000,
      }],
      envelopes: [
        {
          eventKey: "1".repeat(64), accountId: "fixture-bot", target: "fixture-user@im.wechat",
          messageId: "before-restart-1", kind: "message", source: "text", text: "第一条",
          receivedAt: 1_799_999_999_000, observedAt: 1_800_000_000_000,
          contextToken: "fixture-context-token",
        },
        {
          eventKey: "2".repeat(64), accountId: "fixture-bot", target: "fixture-user@im.wechat",
          messageId: "before-restart-2", kind: "message", source: "text", text: "第二条",
          receivedAt: 1_799_999_999_001, observedAt: 1_800_000_000_000,
          contextToken: "fixture-context-token",
        },
      ],
    });
    first.close();

    const reopened = new DurableInboundStore(databasePath, () => 1_800_000_000_001);
    const port = new FixturePort(reopened);
    const received: string[] = [];
    port.onInboundText((event) => { received.push(event.text); });

    port.activateInboundDispatch();

    await vi.waitFor(() => expect(received).toEqual(["第一条", "第二条"]));
    expect(reopened.peek("1".repeat(64))).toMatchObject({ state: "completed", attempts: 1 });
    expect(reopened.peek("2".repeat(64))).toMatchObject({ state: "completed", attempts: 1 });
    await port.close();
    reopened.close();
  });

  it("blocks an expired in-flight fixture message after restart instead of replaying it", async () => {
    let now = 1_800_000_000_000;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-inbound-expired-lease-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "inbound.sqlite");
    const store = new DurableInboundStore(databasePath, () => now);
    store.ingestBatch({
      accountId: "fixture-bot",
      nextCursor: "fixture-cursor-expired-lease",
      contexts: [{
        target: "fixture-user@im.wechat", contextToken: "fixture-context-token",
        lastInboundAt: now - 1, contextUpdatedAt: now,
      }],
      envelopes: [{
        eventKey: "5".repeat(64), accountId: "fixture-bot", target: "fixture-user@im.wechat",
        messageId: "leased-before-restart", kind: "message", source: "text", text: "不要重复执行",
        receivedAt: now - 1, observedAt: now, contextToken: "fixture-context-token",
      }],
    });
    expect(store.leaseNext("fixture-bot", "fixture-user@im.wechat", "old-fixture", 1_000))
      .toMatchObject({ state: "leased" });
    store.close();

    now += 1_001;
    const reopened = new DurableInboundStore(databasePath, () => now);
    const port = new FixturePort(reopened);
    const received = vi.fn();
    port.onInboundText(received);
    port.activateInboundDispatch();

    await vi.waitFor(() => expect(reopened.peek("5".repeat(64))).toMatchObject({
      state: "recovery_blocked",
      attempts: 1,
    }));
    expect(received).not.toHaveBeenCalled();
    await port.close();
    reopened.close();
  });

  it("keeps an undispatched successor queued when the fixture port closes mid-drain", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-inbound-close-"));
    tempDirs.push(directory);
    const store = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
    store.ingestBatch({
      accountId: "fixture-bot",
      nextCursor: "fixture-cursor-close",
      contexts: [{
        target: "fixture-user@im.wechat", contextToken: "fixture-context-token",
        lastInboundAt: 1_799_999_999_000, contextUpdatedAt: 1_800_000_000_000,
      }],
      envelopes: [
        {
          eventKey: "3".repeat(64), accountId: "fixture-bot", target: "fixture-user@im.wechat",
          messageId: "close-1", kind: "message", source: "text", text: "处理中",
          receivedAt: 1_799_999_999_000, observedAt: 1_800_000_000_000,
          contextToken: "fixture-context-token",
        },
        {
          eventKey: "4".repeat(64), accountId: "fixture-bot", target: "fixture-user@im.wechat",
          messageId: "close-2", kind: "message", source: "text", text: "仍应排队",
          receivedAt: 1_799_999_999_001, observedAt: 1_800_000_000_000,
          contextToken: "fixture-context-token",
        },
      ],
    });
    const port = new FixturePort(store);
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const received: string[] = [];
    port.onInboundText(async (event) => {
      received.push(event.text);
      if (event.text === "处理中") await firstPending;
    });
    port.activateInboundDispatch();
    await vi.waitFor(() => expect(received).toEqual(["处理中"]));

    const closing = port.close();
    releaseFirst();
    await closing;

    await vi.waitFor(() => expect(store.peek("3".repeat(64))).toMatchObject({ state: "completed" }));
    expect(store.peek("4".repeat(64))).toMatchObject({ state: "queued", attempts: 0 });
    store.close();
  });
});
