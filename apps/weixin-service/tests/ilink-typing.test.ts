import { afterEach, describe, expect, it, vi } from "vitest";

import { IlinkTypingManager } from "../src/ilink-typing.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("IlinkTypingManager", () => {
  it("prefetches a ticket so start reuses the positive cache", async () => {
    const getConfig = vi.fn(async () => ({ ret: 0, typingTicket: "ticket" }));
    const sendTyping = vi.fn(async () => {});
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, () => 1_000, () => 0.5);
    const context = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    };

    manager.prefetch(context);
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lease = await manager.start(context);

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(lease.diagnostics).toMatchObject({
      ticketCache: "hit",
      getConfig: { outcome: "skipped" },
      sendStart: { outcome: "completed" },
    });
    await lease.stop();
  });

  it("coalesces overlapping prefetch and start calls for one target", async () => {
    let resolveConfig!: (value: { ret: number; typingTicket: string }) => void;
    const getConfig = vi.fn(() => new Promise<{ ret: number; typingTicket: string }>((resolve) => {
      resolveConfig = resolve;
    }));
    const sendTyping = vi.fn(async () => {});
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, () => 1_000, () => 0.5);
    const context = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    };

    manager.prefetch(context);
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    const leasePromise = manager.start(context);
    await Promise.resolve();

    expect(getConfig).toHaveBeenCalledTimes(1);
    resolveConfig({ ret: 0, typingTicket: "ticket" });
    const lease = await leasePromise;
    expect(lease.diagnostics).toMatchObject({
      ticketCache: "miss",
      getConfig: { outcome: "completed" },
      sendStart: { outcome: "completed" },
    });
    await lease.stop();
  });

  it("retries once with the newest context after an older in-flight request fails", async () => {
    let resolveFirst!: (value: { ret: number; typingTicket: string }) => void;
    const getConfig = vi.fn()
      .mockImplementationOnce(() => new Promise<{ ret: number; typingTicket: string }>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({ ret: 0, typingTicket: "fresh-ticket" });
    const sendTyping = vi.fn(async () => {});
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, () => 1_000, () => 0.5);
    const oldContext = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "old-context",
    };
    const newContext = { ...oldContext, contextToken: "new-context" };

    manager.prefetch(oldContext);
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    manager.prefetch(newContext);
    const leasePromise = manager.start(newContext);
    resolveFirst({ ret: 1, typingTicket: "" });

    const lease = await leasePromise;
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(getConfig).toHaveBeenNthCalledWith(2, newContext);
    expect(lease.active).toBe(true);
    await lease.stop();
  });

  it("does not retry a failed context during its negative-cache backoff", async () => {
    const getConfig = vi.fn(async () => ({ ret: 1, typingTicket: "" }));
    const manager = new IlinkTypingManager({ getConfig, sendTyping: vi.fn(async () => {}) });
    const context = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "same-context",
    };

    manager.prefetch(context);
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lease = await manager.start(context);

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(lease).toMatchObject({
      active: false,
      diagnostics: {
        ticketCache: "miss",
        getConfig: { outcome: "failed" },
        sendStart: { outcome: "skipped" },
      },
    });
  });

  it("does not let a request completed after close warm the cache", async () => {
    let resolveFirst!: (value: { ret: number; typingTicket: string }) => void;
    const getConfig = vi.fn()
      .mockImplementationOnce(() => new Promise<{ ret: number; typingTicket: string }>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({ ret: 0, typingTicket: "new-ticket" });
    const manager = new IlinkTypingManager({ getConfig, sendTyping: vi.fn(async () => {}) });
    const context = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    };

    manager.prefetch(context);
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    manager.close();
    resolveFirst({ ret: 0, typingTicket: "stale-ticket" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lease = await manager.start(context);

    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(lease.active).toBe(true);
    await lease.stop();
  });

  it("reports sanitized cold-cache initialization diagnostics", async () => {
    let clock = 1_000;
    const getConfig = vi.fn(async () => {
      clock += 40;
      return { ret: 0, typingTicket: "ticket" };
    });
    const sendTyping = vi.fn(async () => {
      clock += 70;
    });
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, () => clock, () => 0.5);

    const lease = await manager.start({
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    });

    expect(lease.diagnostics).toEqual({
      ticketCache: "miss",
      getConfig: { durationMs: 40, outcome: "completed" },
      sendStart: { durationMs: 70, outcome: "completed" },
    });
    await lease.stop();
  });

  it("reports a cache hit and skips getConfig on the next start", async () => {
    let clock = 2_000;
    const getConfig = vi.fn(async () => {
      clock += 25;
      return { ret: 0, typingTicket: "ticket" };
    });
    const sendTyping = vi.fn(async () => {
      clock += 15;
    });
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, () => clock, () => 0.5);
    const context = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    };

    const first = await manager.start(context);
    const second = await manager.start(context);

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(second.diagnostics).toEqual({
      ticketCache: "hit",
      getConfig: { durationMs: 0, outcome: "skipped" },
      sendStart: { durationMs: 15, outcome: "completed" },
    });
    await first.stop();
    await second.stop();
  });

  it("starts, renews every five seconds, and cancels an active typing lease", async () => {
    vi.useFakeTimers();
    const getConfig = vi.fn(async () => ({ ret: 0, typingTicket: "ticket" }));
    const sendTyping = vi.fn(async () => {});
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, Date.now, () => 0.5);
    const context = {
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    };

    const lease = await manager.start(context);
    expect(lease.active).toBe(true);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenNthCalledWith(1, context, "ticket", 1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(sendTyping.mock.calls.slice(1)).toEqual([
      [context, "ticket", 1],
      [context, "ticket", 1],
    ]);

    await lease.stop();
    expect(sendTyping).toHaveBeenNthCalledWith(4, context, "ticket", 2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendTyping).toHaveBeenCalledTimes(4);
    await lease.stop();
    expect(sendTyping).toHaveBeenCalledTimes(4);
  });

  it("returns an inactive lease when getConfig has no typing ticket", async () => {
    const manager = new IlinkTypingManager({
      getConfig: vi.fn(async () => ({ ret: 0, typingTicket: "" })),
      sendTyping: vi.fn(async () => {}),
    });

    const lease = await manager.start({
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      contextToken: "opaque-context",
    });

    expect(lease.active).toBe(false);
    expect(lease.diagnostics).toMatchObject({
      ticketCache: "miss",
      getConfig: { outcome: "failed" },
      sendStart: { durationMs: 0, outcome: "skipped" },
    });
    expect(lease.diagnostics.getConfig.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lease.diagnostics.getConfig.durationMs)).toBe(true);
    await expect(lease.stop()).resolves.toBeUndefined();
  });

  it("fails inactive on the first typing send and never shares tickets across accounts", async () => {
    const getConfig = vi.fn(async (context: { accountId: string }) => ({
      ret: 0,
      typingTicket: `ticket:${context.accountId}`,
    }));
    const sendTyping = vi.fn()
      .mockRejectedValueOnce(new Error("typing unavailable"))
      .mockResolvedValue(undefined);
    const manager = new IlinkTypingManager({ getConfig, sendTyping }, () => 3_000, () => 0.5);
    const first = { accountId: "first@im.bot", target: "owner@im.wechat", contextToken: "first-context" };
    const second = { accountId: "second@im.bot", target: "owner@im.wechat", contextToken: "second-context" };

    await expect(manager.start(first)).resolves.toMatchObject({
      active: false,
      diagnostics: {
        ticketCache: "miss",
        getConfig: { durationMs: 0, outcome: "completed" },
        sendStart: { durationMs: 0, outcome: "failed" },
      },
    });
    const secondLease = await manager.start(second);

    expect(secondLease.active).toBe(true);
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(sendTyping).toHaveBeenLastCalledWith(second, "ticket:second@im.bot", 1);
    await secondLease.stop();
  });
});
