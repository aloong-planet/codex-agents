import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadChannelStartupConfiguration, parseChannelStartupConfiguration } from "../src/channel-startup-config.js";

// Configuration seam only. Actual startup/transport and real phone receipt are separate acceptance paths.
const configuration = () => ({
  channel: "feishu",
  owner: { memoryAccountId: "old-bot@im.bot", bindings: [
    { channel: "weixin", accountId: "old-bot@im.bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
    { channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" },
  ] },
  taskScope: { accountId: "old-bot@im.bot", target: "owner@im.wechat" },
  feishu: { appId: "cli_0123456789abcdef", appSecret: "test-secret-never-log" },
});

describe("startup channel configuration", () => {
  it("rejects malformed group lists without widening a private binding", () => {
    const base = configuration();
    for (const groups of [null, {}, [{ chatId: "*", allowedSenderIds: ["ou_alice"] }],
      [{ chatId: "oc_private", allowedSenderIds: ["ou_alice"] }],
      [{ chatId: "oc_alpha", allowedSenderIds: ["*"] }],
      [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice", "ou_alice"] }],
      [{ chatId: "oc_alpha", allowedSenderIds: [] }, { chatId: "oc_alpha", allowedSenderIds: [] }]]) {
      expect(() => parseChannelStartupConfiguration({ ...base, feishu: { ...base.feishu, groups } })).toThrow(/^channel_startup_configuration_invalid$/);
    }
    const privateOnly = parseChannelStartupConfiguration(base);
    expect(privateOnly.owner.conversationAddresses()).toHaveLength(1);
    expect(privateOnly.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_owner", conversationType: "group" })).toBeUndefined();
  });
  it("keeps group authority and memory separate while retaining the private owner", () => {
    const input = { ...configuration(), feishu: { ...configuration().feishu, groups: [
      { chatId: "oc_alpha", allowedSenderIds: ["ou_alice", "ou_bob"] },
      { chatId: "oc_beta", allowedSenderIds: ["ou_bob"] },
    ] } };
    const result = parseChannelStartupConfiguration(input);
    const owner = result.owner;
    const alpha = owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_alice", conversationType: "group" });
    const beta = owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_beta", senderId: "ou_bob", conversationType: "group" });
    expect(alpha).toBeDefined(); expect(beta).toBeDefined();
    expect(alpha!.accountId).toBe(owner.conversationAddress().accountId);
    expect(alpha!.target).not.toBe(beta!.target);
    expect(owner.memoryScope(alpha!.accountId, alpha!.target)).not.toBe("old-bot@im.bot");
    expect(owner.memoryScope(alpha!.accountId, alpha!.target)).not.toBe(owner.memoryScope(beta!.accountId, beta!.target));
    expect(owner.memoryScope(owner.conversationAddress().accountId, owner.conversationAddress().target)).toBe("old-bot@im.bot");
    input.feishu.groups[0]!.allowedSenderIds.push("ou_guest");
    expect(owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_guest", conversationType: "group" })).toBeUndefined();
    expect(owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_beta", senderId: "ou_alice", conversationType: "group" })).toBeUndefined();
    expect(owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_alice", conversationType: "private" })).toBeUndefined();
  });

  it("captures one selected owner and retains stable task storage independently of the recipient", () => {
    const input = configuration();
    const result = parseChannelStartupConfiguration(input);
    input.channel = "weixin";
    input.owner.bindings[1]!.senderId = "ou_foreign";
    input.taskScope.target = "foreign@im.wechat";
    expect(result.channel).toBe("feishu");
    expect(result.owner.memoryAccountId).toBe("old-bot@im.bot");
    expect(result.taskScope).toEqual({ accountId: "old-bot@im.bot", target: "owner@im.wechat" });
    const address = result.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner", conversationType: "private" });
    expect(address).toBeDefined();
    expect(result.notificationRoute.scopeFor(address!)).toEqual({ accountId: "old-bot@im.bot", target: "owner@im.wechat" });
    expect(result.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_foreign", conversationType: "private" })).toBeUndefined();
  });
  it("freezes both enabled bindings while sharing only owner memory and task scope", () => {
    const input = { ...configuration(), channel: undefined, enabledChannels: ["weixin", "feishu"] };
    const result = parseChannelStartupConfiguration(input);
    input.enabledChannels.pop();
    input.owner.bindings[1]!.target = "oc_changed";
    expect(result.enabledChannels).toEqual(["weixin", "feishu"]);
    expect(result.entries.map((entry) => entry.channel)).toEqual(["weixin", "feishu"]);
    const [weixin, feishu] = result.entries;
    expect(weixin!.owner.memoryAccountId).toBe("old-bot@im.bot");
    expect(feishu!.owner.memoryAccountId).toBe("old-bot@im.bot");
    expect(weixin!.owner.conversationAddress()).toEqual({ accountId: "old-bot@im.bot", target: "owner@im.wechat" });
    expect(feishu!.binding.target).toBe("oc_private");
    expect(feishu!.owner.conversationAddress()).not.toEqual(weixin!.owner.conversationAddress());
    expect(result.notificationRoute.capture(weixin!.owner.conversationAddress())).toEqual({
      channel: "weixin", accountId: "old-bot@im.bot", target: "owner@im.wechat",
    });
    expect(result.notificationRoute.resolve(result.taskScope)).toEqual({ channel: "feishu", ...feishu!.owner.conversationAddress() });
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.enabledChannels)).toBe(true);
    expect(result.entries.every(Object.isFrozen)).toBe(true);
  });

  it("fails closed on missing selection, owner, retained scope or Feishu credentials without leaking input", () => {
    const base = configuration();
    const invalid = [null, {}, { ...base, channel: undefined }, { ...base, channel: "other" },
      { ...base, owner: undefined }, { ...base, owner: { ...base.owner, bindings: [] } },
      { ...base, owner: { ...base.owner, bindings: [base.owner.bindings[0], base.owner.bindings[0]] } },
      { ...base, taskScope: undefined }, { ...base, feishu: {} },
      { ...base, feishu: { ...base.feishu, appId: "cli_ffffffffffffffff" } },
      { ...base, owner: { ...base.owner, bindings: [base.owner.bindings[0], { ...base.owner.bindings[1], target: "not-a-chat" }] } },
    ];
    for (const input of invalid) {
      expect(() => parseChannelStartupConfiguration(input)).toThrow(/^channel_startup_configuration_invalid$/);
    }
    expect(() => loadChannelStartupConfiguration(undefined)).toThrow("channel_startup_configuration_required");
    // The inactive adapter's credentials are not a prerequisite for selecting Weixin.
    expect(parseChannelStartupConfiguration({ ...base, channel: "weixin", feishu: undefined }).channel).toBe("weixin");
  });

  it("rejects ambiguous enabled sets and requires only enabled transport credentials", () => {
    const base = { ...configuration(), channel: undefined };
    for (const enabledChannels of [[], ["weixin", "weixin"], ["other"], "weixin", null, ["weixin", "feishu", "weixin"]]) {
      expect(() => parseChannelStartupConfiguration({ ...base, enabledChannels })).toThrow(/^channel_startup_configuration_invalid$/);
    }
    for (const input of [
      { ...base, enabledChannels: ["weixin", "feishu"], channel: "feishu" },
      { ...base, enabledChannels: ["weixin"], channel: "feishu" },
      { ...base, enabledChannels: ["weixin", "feishu"], feishu: undefined },
      { ...base, enabledChannels: ["weixin", "feishu"], owner: { ...base.owner, bindings: [base.owner.bindings[0]] } },
    ]) expect(() => parseChannelStartupConfiguration(input)).toThrow(/^channel_startup_configuration_invalid$/);
    const weixin = parseChannelStartupConfiguration({ ...base, enabledChannels: ["weixin"], feishu: undefined });
    expect(weixin.entries.map((entry) => entry.channel)).toEqual(["weixin"]);
    expect(weixin.notificationRoute.capturesCreationDestination).toBe(true);
    // Retaining an inactive binding allows legacy future preferences without activating its transport.
    expect(weixin.notificationRoute.resolve(weixin.taskScope)?.channel).toBe("feishu");
    expect(parseChannelStartupConfiguration({ ...configuration(), enabledChannels: ["feishu"] }).enabledChannels).toEqual(["feishu"]);
    expect(parseChannelStartupConfiguration(configuration()).enabledChannels).toEqual(["feishu"]);
  });

  it("reads configuration once and applies file edits only on the next load", () => {
    const directory = mkdtempSync(join(tmpdir(), "channel-startup-"));
    const path = join(directory, "channel.json");
    try {
      writeFileSync(path, JSON.stringify({ ...configuration(), channel: "weixin" }));
      const running = loadChannelStartupConfiguration(path);
      writeFileSync(path, JSON.stringify(configuration()));
      const restarted = loadChannelStartupConfiguration(path);
      expect(running.channel).toBe("weixin");
      expect(restarted.channel).toBe("feishu");
      expect(running.owner.memoryAccountId).toBe("old-bot@im.bot");
      expect(restarted.owner.memoryAccountId).toBe("old-bot@im.bot");
      expect(restarted.taskScope).toEqual({ accountId: "old-bot@im.bot", target: "owner@im.wechat" });
      writeFileSync(path, "invalid-json-with-test-secret-never-log");
      expect(() => loadChannelStartupConfiguration(path)).toThrow(/^channel_startup_configuration_unreadable$/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
