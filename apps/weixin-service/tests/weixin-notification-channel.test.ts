// Native transport seam; no real Weixin request or mobile receipt.
import { describe, expect, it, vi } from "vitest";
import { WeixinNotificationChannel } from "../src/weixin-notification-channel.js";
import type { WeixinChannel } from "../src/demo-service.js";

describe("Weixin notification adapter", () => {
  it("preserves operation identity and submission guard, and refuses another channel", async () => {
    const sendText = vi.fn<WeixinChannel["sendText"]>(async () => ({ ok: true }));
    const failures: unknown[] = [];
    const native = { getSnapshot: () => ({ accounts: [], targets: [] }), sendText,
      getDeliveryContext: () => ({ credentialStatus: "usable" as const, credentialGeneration: "login-1", contextGeneration: "context-1" }),
      onSnapshotChanged: () => () => {} };
    const adapter = new WeixinNotificationChannel(native, () => true, (result) => failures.push(result));
    const beforeSubmit = () => true;
    await expect(adapter.send({ accountId: "bot", target: "owner", message: "喝水", operationId: "occurrence:part-1", beforeSubmit })).resolves.toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledExactlyOnceWith({ accountId: "bot", target: "owner", message: "喝水", scheduled: { operationId: "occurrence:part-1", beforeSubmit } });
    await expect(adapter.send({ channel: "feishu", accountId: "bot", target: "owner", message: "禁止", operationId: "wrong", beforeSubmit })).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    await expect(adapter.send({ accountId: "bot", target: "owner", message: "禁止", operationId: "cancelled", beforeSubmit: () => false })).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(2);
    expect(adapter.state({ accountId: "bot", target: "owner" })).toMatchObject({ enabled: true, credentialGeneration: "login-1", contextGeneration: "context-1" });
  });

  it.each(["reject", "throw"])("reports %s locally without retrying or changing an uncertain receipt", async (mode) => {
    const sendText = vi.fn<WeixinChannel["sendText"]>(async () => { if (mode === "throw") throw new Error("network lost"); return { ok: false, reason: "unknown" }; });
    const report = vi.fn(() => { throw new Error("report failed"); });
    const adapter = new WeixinNotificationChannel({ getSnapshot: () => ({ accounts: [], targets: [] }), sendText, onSnapshotChanged: () => () => {} }, () => true, report);
    await expect(adapter.send({ accountId: "bot", target: "owner", message: "喝水", operationId: "one", beforeSubmit: () => true })).resolves.toEqual({ ok: false, reason: "unknown" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: false, reason: "unknown" });
  });
});
