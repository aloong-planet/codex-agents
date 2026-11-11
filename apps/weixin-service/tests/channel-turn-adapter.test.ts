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

// A model that takes a grant's name for a folder inside the grant writes its files one level too deep.
it("tells a turn with a file grant that the listed name is the granted directory itself, and where paths start", async () => {
  const text = async (promptLines: string[]) => {
    const turn = new ChannelTurnAdapter("thread", {
      key: "event", accountId: "account", target: "conversation", messageId: "message", source: "text", receivedAt: 1800000000000, text: "保存到 demo-vault 里的 a/b.md",
    }, { accountMemory: "", outboundRoots: [], isClosing: () => false, channelLabel: "微信", outboundDelivery: true,
      workflowTools: { bind: async () => ({ promptLines, snapshot: () => ({ owner: "model" }), seal: () => {}, drain: async () => {}, release: async () => {} }) } });
    const prepared = await turn.prepare();
    await prepared.binding?.release();
    return prepared.input.filter((input) => input.type === "text").map((input) => input.text).join("\n");
  };
  const granted = await text(["scoperef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: demo-vault（可读、可写）"]);
  expect(granted).toContain("目录名称指这个授权目录本身，不是它里面的子目录");
  expect(granted).toContain("files.write 的 relativePath 和 include/exclude 里带 / 的 glob 都从该目录之下写起，不带目录名称");
  // The explanation comes before the list it explains.
  expect(granted.indexOf("不带目录名称")).toBeLessThan(granted.indexOf("scoperef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: demo-vault"));
  const ungranted = await text([]);
  expect(ungranted).toContain("本轮没有已保存且可用的本地文件目录授权。");
  expect(ungranted).not.toContain("目录名称");
});
