import { describe, expect, it } from "vitest";

import { AccountChatModelSettings } from "../src/account-chat-model-settings.js";

const catalog = [
  { model: "gpt-5.6-luna", displayName: "Luna", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" },
  { model: "gpt-5.6-terra", displayName: "Terra", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
  { model: "gpt-5.6-sol", displayName: "Sol", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
  { model: "gpt-7-new", displayName: "New", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
] as const;

describe("AccountChatModelSettings", () => {
  it("defaults each account to the reviewed fast model without persisting a setting", () => {
    const settings = new AccountChatModelSettings([], { fetchedAt: 123, models: [...catalog] });

    expect(settings.resolve("bot-a@im.bot")).toEqual({
      available: true,
      model: "gpt-5.6-luna",
      effort: "low",
      configRevision: 0,
      source: "track",
      track: "fast",
    });
    expect(settings.snapshot().settings).toEqual([]);
  });

  it("keeps unknown future models pinned-only and isolates settings by account", () => {
    const settings = new AccountChatModelSettings([], { fetchedAt: 123, models: [...catalog] });

    settings.configure("bot-a@im.bot", { mode: "pinned", model: "gpt-7-new", effort: "low" }, 456);

    expect(settings.resolve("bot-a@im.bot")).toMatchObject({ model: "gpt-7-new", source: "pinned", configRevision: 1 });
    expect(settings.resolve("bot-b@im.bot")).toMatchObject({ model: "gpt-5.6-luna", source: "track", track: "fast" });
    expect(settings.publicState("bot-a@im.bot").catalog.models.map((model) => model.model)).toContain("gpt-7-new");
  });

  it("rejects a pinned model effort that the current catalog does not support", () => {
    const settings = new AccountChatModelSettings([], { fetchedAt: 123, models: [...catalog] });

    expect(() => settings.configure("bot-a@im.bot", {
      mode: "pinned",
      model: "gpt-7-new",
      effort: "high",
    }, 456)).toThrow("模型不支持所选推理强度");
  });

  it("degrades an automatic track to the catalog default effort without changing the track model", () => {
    const settings = new AccountChatModelSettings([{ accountId: "bot-a@im.bot", selection: { mode: "track", track: "fast", effort: "high" }, revision: 4, updatedAt: 1 }], {
      fetchedAt: 123,
      models: [{ ...catalog[0], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }],
    });

    expect(settings.resolve("bot-a@im.bot")).toMatchObject({ available: true, model: "gpt-5.6-luna", effort: "medium", degraded: true, configRevision: 4 });
  });
});
