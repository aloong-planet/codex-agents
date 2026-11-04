// Startup routing seam; transport authentication and actual phone receipt require channel acceptance.
import { describe, expect, it } from "vitest";
import { OwnerNotificationRoute } from "../src/notification-channel.js";

describe("OwnerNotificationRoute", () => {
  it("retains the task scope while selecting one immutable notification destination", () => {
    const input = { memoryAccountId: "legacy-bot", scope: { accountId: "legacy-bot", target: "owner@im.wechat" },
      selected: { channel: "feishu" as const, accountId: "feishu.app", target: "feishu.owner" } };
    const route = new OwnerNotificationRoute(input);
    input.selected.target = "other";
    expect(route.scopeFor({ accountId: "feishu.app", target: "feishu.owner" })).toEqual({ accountId: "legacy-bot", target: "owner@im.wechat" });
    expect(route.resolve({ accountId: "legacy-bot", target: "owner@im.wechat" })).toEqual({ channel: "feishu", accountId: "feishu.app", target: "feishu.owner" });
    expect(route.scopeFor({ accountId: "feishu.app", target: "other" })).toBeUndefined();
    expect(route.resolve({ accountId: "foreign", target: "owner@im.wechat" })).toBeUndefined();
    expect(route.memoryScope("legacy-bot", ["feishu.owner"])).toEqual({ accountId: "legacy-bot", target: "owner@im.wechat" });
    expect(route.memoryDestination("legacy-bot", "owner@im.wechat")).toEqual({ channel: "feishu", accountId: "feishu.app", target: "feishu.owner" });
    expect(route.memoryDestination("foreign", "owner@im.wechat")).toBeUndefined();
  });
});
