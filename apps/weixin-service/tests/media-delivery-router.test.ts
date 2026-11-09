import { describe, expect, it, vi } from "vitest";
import type { MediaDeliveryPort } from "../src/media-delivery.js";
import { MediaDeliveryRouter } from "../src/media-delivery-router.js";

// Neutral host route seam; real snapshot bytes and platform ledger behavior remain
// adapter regression cases. Production dual-channel composition is ticket 12.
function port() {
  return {
    sendImage: vi.fn<MediaDeliveryPort["sendImage"]>(async () => ({ ok: true })),
    sendFile: vi.fn<MediaDeliveryPort["sendFile"]>(async () => ({ ok: true })),
    reconcile: vi.fn<MediaDeliveryPort["reconcile"]>(async () => ({ status: "unknown" })),
  };
}
const wx = { accountId: "bot", target: "owner@im.wechat" };
const feishu = { accountId: "feishu.app", target: "feishu.chat" };
describe("source-bound media routing", () => {
  it("sends images and files only through their bound conversation, without fallback", async () => {
    const left = port(), right = port();
    const router = new MediaDeliveryRouter([{ destination: wx, delivery: left }, { destination: feishu, delivery: right }]);
    await router.sendImage({ ...wx, filePath: "/snapshot/wx.png", operationId: "wx-image", caption: "wx" });
    await router.sendFile({ ...feishu, filePath: "/snapshot/fs.txt", operationId: "fs-file", fileName: "fs.txt" });
    expect(left.sendImage.mock.calls).toEqual([[{ accountId: "bot", target: "owner@im.wechat", filePath: "/snapshot/wx.png", operationId: "wx-image", caption: "wx" }]]);
    expect(right.sendFile.mock.calls).toEqual([[{ accountId: "feishu.app", target: "feishu.chat", filePath: "/snapshot/fs.txt", operationId: "fs-file", fileName: "fs.txt" }]]);
    expect(left.sendFile).not.toHaveBeenCalled(); expect(right.sendImage).not.toHaveBeenCalled();
    right.sendImage.mockResolvedValueOnce({ ok: false, reason: "unknown" });
    await expect(router.sendImage({ ...feishu, filePath: "/snapshot/fs.png", operationId: "fs-image" })).resolves.toEqual({ ok: false, reason: "unknown" });
    expect(left.sendImage).toHaveBeenCalledTimes(1);
    await expect(router.sendFile({ accountId: "bot", target: "feishu.chat", filePath: "/snapshot/x", operationId: "unbound" }))
      .resolves.toEqual({ ok: false, reason: "unavailable", acceptedSegments: 0 });
    expect(right.sendFile).toHaveBeenCalledTimes(1); expect(left.sendFile).not.toHaveBeenCalled();
    expect(() => new MediaDeliveryRouter([{ destination: wx, delivery: left }, { destination: wx, delivery: right }])).toThrow("media_routes_invalid");
  });
  it("reconciles the original destination after router recreation and never probes or resends elsewhere", async () => {
    const left = port(), right = port();
    left.reconcile.mockResolvedValue({ status: "accepted" });
    const routes = [{ destination: wx, delivery: left }, { destination: feishu, delivery: right }];
    await new MediaDeliveryRouter(routes).sendFile({ ...wx, filePath: "/snapshot/a", operationId: "original" });
    const reopened = new MediaDeliveryRouter(routes);
    await expect(reopened.reconcile("original", wx)).resolves.toEqual({ status: "accepted" });
    await expect(reopened.reconcile("original", feishu)).resolves.toEqual({ status: "unknown" });
    expect(left.reconcile.mock.calls).toEqual([["original", { accountId: "bot", target: "owner@im.wechat" }]]);
    expect(right.reconcile.mock.calls).toEqual([["original", { accountId: "feishu.app", target: "feishu.chat" }]]);
    await expect(reopened.reconcile("original")).resolves.toEqual({ status: "unknown", errorCode: "media_destination_unavailable" });
    await expect(new MediaDeliveryRouter([{ destination: feishu, delivery: right }]).reconcile("original", wx))
      .resolves.toEqual({ status: "unknown", errorCode: "media_destination_unavailable" });
    expect(left.reconcile).toHaveBeenCalledTimes(1); expect(right.reconcile).toHaveBeenCalledTimes(1);
    expect(left.sendFile).toHaveBeenCalledTimes(1); expect(right.sendFile).not.toHaveBeenCalled();
    expect(left.sendImage).not.toHaveBeenCalled(); expect(right.sendImage).not.toHaveBeenCalled();
  });


  // A team saved while the service runs sends media with its own application (ticket 11, decision D5).
  it("routes a sending identity added after construction, and refuses a second route for the same destination", async () => {
    const left = port(), added = port();
    const router = new MediaDeliveryRouter([{ destination: feishu, delivery: left }]);
    const team = { ...feishu, senderAccountId: "cli_daisy" };
    await expect(router.sendFile({ ...team, filePath: "/snapshot/a", operationId: "before" })).resolves.toEqual({ ok: false, reason: "unavailable", acceptedSegments: 0 });
    router.add({ destination: team, delivery: added });
    await router.sendFile({ ...team, filePath: "/snapshot/a", operationId: "after" });
    expect([added.sendFile.mock.calls.map(([input]) => input.operationId), left.sendFile.mock.calls.length]).toEqual([["after"], 0]);
    expect(() => router.add({ destination: team, delivery: left })).toThrow(/^media_routes_invalid$/);
  });
});
