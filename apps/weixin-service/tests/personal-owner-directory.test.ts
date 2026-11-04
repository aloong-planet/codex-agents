import { describe, expect, it } from "vitest";
import { PersonalOwnerDirectory, PersonalOwnerIdentity, type PersonalOwnerConfiguration } from "../src/personal-owner-identity.js";

// Host-decoded identity seam; platform authentication is covered at adapter ingress.
const config: PersonalOwnerConfiguration = { memoryAccountId: "legacy-bot", bindings: [
  { channel: "weixin", accountId: "legacy-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
  { channel: "feishu", accountId: "app", target: "chat", senderId: "person" },
] };
describe("shared personal owner directory", () => {
  it("shares curated memory scope while retaining each independent binding", () => {
    const weixin = new PersonalOwnerIdentity(config, "weixin");
    const feishu = new PersonalOwnerIdentity(config, "feishu");
    const directory = new PersonalOwnerDirectory([weixin, feishu]);
    const wx = weixin.conversationAddress(), fs = feishu.conversationAddress();
    expect(directory.memoryScope(wx.accountId)).toBe("legacy-bot");
    expect(directory.memoryScope(fs.accountId)).toBe("legacy-bot");
    expect(directory.contextHash(wx.accountId, wx.target)).toBe(weixin.contextHash());
    expect(directory.contextHash(fs.accountId, fs.target)).toBe(feishu.contextHash());
    expect(directory.contextHash(wx.accountId, wx.target)).not.toBe(directory.contextHash(fs.accountId, fs.target));
    expect(directory.accepts({ ...wx, senderId: "owner@im.wechat", conversationType: "private" })).toBe(true);
    expect(directory.accepts({ ...fs, senderId: "person", conversationType: "private" })).toBe(true);
    expect(directory.accepts({ ...fs, senderId: "owner@im.wechat", conversationType: "private" })).toBe(false);
    expect(directory.accepts({ ...fs, senderId: "person", conversationType: "group" })).toBe(false);
    expect(directory.accepts({ ...fs, conversationType: "private" })).toBe(false);
    expect(() => directory.memoryScope("stranger")).toThrow("owner_account_unbound");
    expect(() => directory.contextHash(wx.accountId, fs.target)).toThrow("owner_identity_unbound");
    expect(() => new PersonalOwnerDirectory([])).toThrow("owner_directory_invalid");
    expect(() => new PersonalOwnerDirectory([weixin, weixin])).toThrow("owner_directory_invalid");
    expect(() => new PersonalOwnerDirectory([weixin, new PersonalOwnerIdentity({ ...config, memoryAccountId: "different-owner" }, "feishu")])).toThrow("owner_directory_invalid");
    const changed = new PersonalOwnerDirectory([weixin, new PersonalOwnerIdentity({ ...config, bindings: [config.bindings[0]!, { ...config.bindings[1]!, senderId: "replacement" }] }, "feishu")]);
    expect(changed.contextHash(wx.accountId, wx.target)).toBe(directory.contextHash(wx.accountId, wx.target));
    expect(changed.contextHash(fs.accountId, fs.target)).not.toBe(directory.contextHash(fs.accountId, fs.target));
  });
});
