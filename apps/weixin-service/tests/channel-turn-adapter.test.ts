import { expect, it } from "vitest";
import { ChannelTurnAdapter } from "../src/channel-turn-adapter.js";

// Shared assembly seam. Platform authentication and end-to-end tool execution are tested separately.
it("prepares Feishu text with shared file tools without advertising unimplemented media delivery", async () => {
  const lifecycle: string[] = [];
  const turn = new ChannelTurnAdapter("thread", {
    key: "event", accountId: "account", target: "conversation", messageId: "message", source: "text", receivedAt: 1800000000000, text: "只回复：原文。",
  }, { accountMemory: "喜欢简洁", outboundRoots: [], isClosing: () => false, channelLabel: "飞书", outboundDelivery: false,
    workflowTools: { bind: async () => ({ promptLines: ["scope:opaque"], snapshot: () => ({ owner: "model" }),
      seal: () => { lifecycle.push("seal"); }, drain: async () => { lifecycle.push("drain"); }, release: async () => { lifecycle.push("release"); } }) },
  });
  const prepared = await turn.prepare();
  const text = prepared.input.filter((input) => input.type === "text").map((input) => input.text).join("\n");
  expect(text).toContain("个人飞书目标");
  expect(text).toContain("只回复：原文。");
  // Private turns keep the code-and-tests example of the goal-scope rule; dispatch Executors get it only from Jack's profile.
  expect(text).toContain("例如只要求提供代码和测试用例");
  expect(text).toContain("scope:opaque");
  expect(text).toContain("暂不支持发送图片或文件");
  expect(text).not.toContain("weixin.send_files");
  expect(text).not.toContain("media.send");
  await prepared.binding?.seal(); await prepared.binding?.drain(); await prepared.binding?.release();
  expect(lifecycle).toEqual(["seal", "drain", "release"]);
});
