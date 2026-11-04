import { describe, expect, it } from "vitest";
import type { NotificationChannel } from "../src/notification-channel.js";
import { NotificationChannelRouter } from "../src/notification-channel-router.js";

// Public notification routing seam. Production connection/recovery and device receipt
// require the main fixture and real-channel acceptance, not these transport fakes.
function port() {
  let enabled = true;
  let unknown = false;
  const sent: string[] = [];
  const observers = new Set<() => void>();
  const channel: NotificationChannel = {
    state: () => ({ enabled, credentialStatus: "usable", credentialGeneration: "fixture", contextGeneration: "fixture" }),
    subscribe: (listener) => { observers.add(listener); return () => { observers.delete(listener); }; },
    send: async (input) => {
      if (!enabled || !input.beforeSubmit()) return { ok: false, reason: "unavailable", acceptedSegments: 0 };
      sent.push(`${input.accountId}/${input.target}/${input.operationId}/${input.message}`);
      return unknown ? { ok: false, reason: "unknown" } : { ok: true };
    },
  };
  return { channel, sent, uncertain: () => { unknown = true; }, availability: (value: boolean) => {
    enabled = value; for (const observer of observers) observer();
  } };
}
const wx = { channel: "weixin" as const, accountId: "bot", target: "owner@im.wechat" };
const fs = { channel: "feishu" as const, accountId: "feishu.app", target: "feishu.chat" };

describe("notification channel routing", () => {
  it("routes frozen destinations exactly and never redirects unavailable or unknown submissions", async () => {
    const left = port(), right = port();
    const router = new NotificationChannelRouter([
      { destination: wx, channel: left.channel }, { destination: fs, channel: right.channel },
    ]);
    const message = { message: "reminder", operationId: "op", beforeSubmit: () => true };
    await expect(router.send({ ...wx, ...message })).resolves.toEqual({ ok: true });
    left.uncertain();
    await expect(router.send({ ...wx, ...message, operationId: "uncertain" })).resolves.toEqual({ ok: false, reason: "unknown" });
    left.availability(false);
    await expect(router.send({ ...wx, ...message })).resolves.toEqual({ ok: false, reason: "unavailable", acceptedSegments: 0 });
    expect(router.state(wx).enabled).toBe(false);
    expect(router.state(fs).enabled).toBe(true);
    for (const destination of [{ ...wx, channel: "feishu" as const }, { ...fs, target: "foreign" }]) {
      expect(router.state(destination).enabled).toBe(false);
      await expect(router.send({ ...destination, ...message })).resolves.toEqual({ ok: false, reason: "unavailable", acceptedSegments: 0 });
    }
    await expect(router.send({ ...fs, ...message, beforeSubmit: () => false })).resolves.toEqual({ ok: false, reason: "unavailable", acceptedSegments: 0 });
    expect(right.sent).toEqual([]);
    await expect(router.send({ ...fs, ...message })).resolves.toEqual({ ok: true });
    expect(right.sent).toEqual(["feishu.app/feishu.chat/op/reminder"]);
    expect(left.sent).toEqual(["bot/owner@im.wechat/op/reminder", "bot/owner@im.wechat/uncertain/reminder"]);
  });
  it("freezes route ownership and forwards readiness changes until unsubscribed", async () => {
    const left = port(), right = port();
    const original = { ...wx };
    const routes = [{ destination: original, channel: left.channel }, { destination: fs, channel: right.channel }];
    const router = new NotificationChannelRouter(routes);
    original.target = "changed@im.wechat";
    routes.pop();
    let changes = 0;
    const stop = router.subscribe(() => { changes++; });
    left.availability(false);
    right.availability(false);
    left.availability(true);
    expect(changes).toBe(3);
    expect(router.state(wx).enabled).toBe(true);
    expect(router.state(fs).enabled).toBe(false);
    expect(router.state(original).enabled).toBe(false);
    // An old occurrence without channel metadata retains its original Weixin interpretation.
    await expect(router.send({ accountId: "bot", target: "owner@im.wechat", message: "old", operationId: "legacy", beforeSubmit: () => true }))
      .resolves.toEqual({ ok: true });
    expect(left.sent).toEqual(["bot/owner@im.wechat/legacy/old"]);
    stop(); right.availability(true); left.availability(false);
    expect(changes).toBe(3);
    expect(() => new NotificationChannelRouter([])).toThrow("notification_channels_invalid");
    expect(() => new NotificationChannelRouter([{ destination: wx, channel: left.channel }, { destination: wx, channel: right.channel }]))
      .toThrow("notification_channels_invalid");
  });

});
