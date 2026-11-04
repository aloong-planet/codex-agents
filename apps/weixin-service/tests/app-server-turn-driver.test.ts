import { expect, it } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { FixtureAppServerTransport } from "../src/fixture-app-server-transport.js";
import type { AppServerTransport } from "../src/codex-app-server-client.js";

for (const hasFinal of [true, false]) {
  it(`selects the last ${hasFinal ? "final answer" : "unphased message"} through the protocol driver`, async () => {
    const peer = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => undefined }, () => "answer");
    const transport: AppServerTransport = {
      send: (message) => peer.send(message), close: () => peer.close(),
      onExit: (listener) => peer.onExit(listener),
      onMessage: (listener) => peer.onMessage((message) => {
        if (message.method === "item/completed" && message.params?.item &&
            (message.params.item as { type?: string }).type === "agentMessage") {
          for (const item of [
            { type: "agentMessage", text: "older fallback" },
            ...(hasFinal ? [{ type: "agentMessage", phase: "final_answer", text: "authoritative" }] : []),
            { type: "agentMessage", text: "newer fallback" },
            { type: "agentMessage", phase: "commentary", text: "private" },
          ]) listener({ ...message, params: { ...message.params, item } });
        } else listener(message);
      }),
    };
    const conversation = new CodexConversation(() => transport);
    try {
      const thread = await conversation.startOrResume(undefined, "/workspace");
      await expect(conversation.reply(thread, "hello")).resolves.toBe(hasFinal ? "authoritative" : "newer fallback");
    } finally { await conversation.close(); }
  });
}
