// Transport-boundary contract only; real upload/phone receipt requires DirectIlink tests and owner acceptance.
import { describe, expect, it, vi } from "vitest";
import type { SendTextResult } from "../src/channel-contract.js";
import { WeixinMediaDelivery } from "../src/weixin-media-delivery.js";

function transport(result: SendTextResult = { ok: true, messageId: "accepted-1" }) {
  return {
    sendImage: vi.fn(async () => result),
    sendFile: vi.fn(async () => result),
    reconcileMediaOperation: vi.fn(async () => ({ status: "unknown" as const, errorCode: "receipt_missing" })),
  };
}

describe("WeixinMediaDelivery", () => {
  it("projects the trusted image snapshot and operation into exactly one submission", async () => {
    const channel = transport();
    const delivery = new WeixinMediaDelivery(channel);
    const input = { accountId: "bot", target: "owner@im.wechat", filePath: "/snapshots/image.png", operationId: "workflow-operation:image-1", caption: "caption", contextToken: "must-not-cross" };
    expect(await delivery.sendImage(input)).toEqual({ ok: true, messageId: "accepted-1" });
    expect(channel.sendImage.mock.calls).toEqual([[{ accountId: "bot", target: "owner@im.wechat", filePath: "/snapshots/image.png", operationId: "workflow-operation:image-1", caption: "caption" }]]);
    expect(channel.sendFile).not.toHaveBeenCalled();
  });
  it.each(["rejected", "unknown"] as const)("preserves %s file results without retrying", async (reason) => {
    const channel = transport({ ok: false, reason, error: "submission_failed" });
    const delivery = new WeixinMediaDelivery(channel);
    expect(await delivery.sendFile({ accountId: "bot", target: "owner@im.wechat", filePath: "/snapshots/report.pdf", operationId: "workflow-operation:file-1", fileName: "报告.pdf" })).toEqual({ ok: false, reason, error: "submission_failed" });
    expect(channel.sendFile.mock.calls).toEqual([[{ accountId: "bot", target: "owner@im.wechat", filePath: "/snapshots/report.pdf", operationId: "workflow-operation:file-1", fileName: "报告.pdf" }]]);
    expect(channel.sendImage).not.toHaveBeenCalled();
    expect(await delivery.reconcile("workflow-operation:file-1")).toEqual({ status: "unknown", errorCode: "receipt_missing" });
    expect(channel.reconcileMediaOperation.mock.calls).toEqual([["workflow-operation:file-1"]]);
    expect(channel.sendFile).toHaveBeenCalledTimes(1);
  });

});
