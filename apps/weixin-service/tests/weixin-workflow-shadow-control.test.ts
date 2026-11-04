import { describe, expect, it, vi } from "vitest";

import type { InboundTextEvent } from "../src/demo-service.js";
import { WeixinWorkflowShadowObserver } from "../src/weixin-workflow-shadow-control.js";

function event(key: string, text = "把 AI 代理笔记原文件发给我"): InboundTextEvent {
  return {
    key,
    accountId: "account-a",
    target: "target-a",
    messageId: key,
    source: "text",
    text,
    receivedAt: 1_800_000_000_000,
    replyText: vi.fn(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("WeixinWorkflowShadowObserver", () => {
  it("starts background shadow planning after the completed-turn notification returns", async () => {
    const gate = deferred();
    const order: string[] = [];
    const shadow = {
      tryHandle: vi.fn(async () => {
        order.push("shadow");
        await gate.promise;
        return { handled: false as const };
      }),
    };
    const control = new WeixinWorkflowShadowObserver(shadow, {
      shouldObserve: () => true,
    });

    control.observe(event("message-1"));
    expect(order).toEqual([]);

    await vi.waitFor(() => expect(shadow.tryHandle).toHaveBeenCalledTimes(1));
    gate.resolve();
    await control.idle();
  });

  it("deduplicates the same reliable inbound key while it is queued or running", async () => {
    const gate = deferred();
    const shadow = {
      tryHandle: vi.fn(async () => {
        await gate.promise;
        return { handled: false as const };
      }),
    };
    const control = new WeixinWorkflowShadowObserver(
      shadow,
      { shouldObserve: () => true },
    );

    control.observe(event("message-duplicate"));
    control.observe(event("message-duplicate"));
    await vi.waitFor(() => expect(shadow.tryHandle).toHaveBeenCalledTimes(1));
    gate.resolve();
    await control.idle();
    expect(shadow.tryHandle).toHaveBeenCalledTimes(1);
  });

  it("runs one shadow task at a time and drops new work when the bounded queue is full", async () => {
    const first = deferred();
    const calls: string[] = [];
    const onError = vi.fn();
    const shadow = {
      tryHandle: vi.fn(async (input: InboundTextEvent) => {
        calls.push(input.key);
        if (input.key === "message-1") await first.promise;
        return { handled: false as const };
      }),
    };
    const control = new WeixinWorkflowShadowObserver(
      shadow,
      { shouldObserve: () => true, maxPending: 1, onError },
    );

    control.observe(event("message-1"));
    await vi.waitFor(() => expect(calls).toEqual(["message-1"]));
    control.observe(event("message-2"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    control.observe(event("message-3"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.resolve();
    await control.idle();

    expect(calls).toEqual(["message-1", "message-2"]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "workflow_shadow_queue_full" }));
  });

  it("isolates candidate, durable-dedup and shadow failures from the legacy owner", async () => {
    const shadow = { tryHandle: vi.fn(async () => { throw new Error("planner failed"); }) };
    const onError = vi.fn();
    const control = new WeixinWorkflowShadowObserver(shadow, {
      shouldObserve: (input) => {
        if (input.key === "candidate-error") throw new Error("filter failed");
        return input.text.includes("笔记");
      },
      alreadyObserved: (input) => input.key === "already-observed",
      onError,
    });

    expect(() => control.observe(event("ordinary", "你好"))).not.toThrow();
    expect(() => control.observe(event("already-observed"))).not.toThrow();
    expect(() => control.observe(event("candidate-error"))).not.toThrow();
    expect(() => control.observe(event("shadow-failure"))).not.toThrow();
    await control.idle();

    expect(shadow.tryHandle).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("stops accepting shadow work and closes its owned runtime without changing legacy handling", async () => {
    const close = vi.fn();
    const shadow = { tryHandle: vi.fn(async () => ({ handled: false as const })) };
    const control = new WeixinWorkflowShadowObserver(shadow, {
      shouldObserve: () => true,
      close,
    });

    control.close();
    control.observe(event("after-close"));
    await Promise.resolve();

    expect(shadow.tryHandle).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
