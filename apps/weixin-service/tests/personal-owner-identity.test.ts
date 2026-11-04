import { describe, expect, it } from "vitest";
import { PersonalOwnerIdentity, type PersonalOwnerConfiguration } from "../src/personal-owner-identity.js";

// Host identity seam only: Feishu authenticated event decoding is covered by ticket 05.
const configuration: PersonalOwnerConfiguration = { memoryAccountId: "old-bot@im.bot", bindings: [
  { channel: "weixin", accountId: "old-bot@im.bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
  { channel: "feishu", accountId: "app-id", target: "private-chat", senderId: "owner-open-id" },
] };

describe("personal owner identity", () => {
  it("preserves legacy addresses and memory while isolating another channel", () => {
    const weixin = new PersonalOwnerIdentity(configuration, "weixin");
    const feishu = new PersonalOwnerIdentity(configuration, "feishu");
    expect(weixin.conversationAddress()).toEqual({ accountId: "old-bot@im.bot", target: "owner@im.wechat" });
    const address = feishu.admit({ accountId: "app-id", target: "private-chat", senderId: "owner-open-id", conversationType: "private" });
    expect(address).toBeDefined();
    expect(address).not.toEqual(weixin.conversationAddress());
    expect(feishu.memoryScope(address!.accountId)).toBe("old-bot@im.bot");
    expect(weixin.memoryScope("old-bot@im.bot")).toBe("old-bot@im.bot");
    expect(() => feishu.memoryScope("unrelated")).toThrow("owner_account_unbound");
    expect(feishu.accepts({ ...address!, senderId: "owner-open-id", conversationType: "private" })).toBe(true);
    expect(weixin.accepts({ ...address!, senderId: "owner-open-id", conversationType: "private" })).toBe(false);
  });

  it("rejects foreign, group and incomplete identities before issuing an address", () => {
    const owner = new PersonalOwnerIdentity(configuration, "feishu");
    const valid = { accountId: "app-id", target: "private-chat", senderId: "owner-open-id", conversationType: "private" as const };
    for (const field of ["accountId", "target", "senderId"] as const) expect(owner.admit({ ...valid, [field]: "foreign" })).toBeUndefined();
    expect(owner.admit({ ...valid, conversationType: "group" })).toBeUndefined();
    expect(owner.admit({ accountId: "app-id", target: "private-chat" })).toBeUndefined();
    expect(owner.admit(valid)).toBeDefined();
  });

  it("takes an immutable startup snapshot and rejects duplicate or missing bindings", () => {
    const config = structuredClone(configuration);
    const owner = new PersonalOwnerIdentity(config, "feishu");
    config.bindings[1]!.senderId = "replacement";
    expect(owner.admit({ accountId: "app-id", target: "private-chat", senderId: "owner-open-id", conversationType: "private" })).toBeDefined();
    expect(() => new PersonalOwnerIdentity({ ...configuration, bindings: [configuration.bindings[0]!, configuration.bindings[0]!] }, "weixin")).toThrow("owner_binding_invalid");
    expect(() => new PersonalOwnerIdentity({ ...configuration, bindings: [configuration.bindings[0]!] }, "feishu")).toThrow("owner_channel_unbound");
  });
});
