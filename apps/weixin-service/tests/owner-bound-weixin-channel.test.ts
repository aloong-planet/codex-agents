import { expect, it } from "vitest";
import { bindWeixinOwner } from "../src/owner-bound-weixin-channel.js";
import { PersonalOwnerIdentity } from "../src/personal-owner-identity.js";
import type { InboundTextEvent, WeixinChannel } from "../src/demo-service.js";

// Native channel seam; real iLink credential validation is a separate adapter/live acceptance path.
it("restricts legacy panel, command hooks, inbound text and sends to the configured owner", async () => {
  const outbox: string[] = [];
  let listener: ((event: InboundTextEvent) => unknown) | undefined;
  let command: ((event: InboundTextEvent) => boolean | Promise<boolean>) | undefined;
  const native: WeixinChannel = {
    start: async () => {}, close() {}, updateLocalLabels() {}, startLogin() { throw new Error("unused"); },
    getSnapshot: () => ({ accounts: [{ accountId: "bot", credentialStatus: "usable" }, { accountId: "foreign", credentialStatus: "usable" }],
      targets: [{ accountId: "bot", target: "owner@im.wechat" }, { accountId: "bot", target: "foreign@im.wechat" }] }),
    onSnapshotChanged: () => () => {},
    onInboundText: (handler) => { listener = handler; return () => {}; },
    onInboundCommand: (handler) => { command = handler; return () => {}; },
    sendText: async (input) => { outbox.push(input.message); return { ok: true }; },
  };
  const owner = new PersonalOwnerIdentity({ memoryAccountId: "bot", bindings: [{ channel: "weixin", accountId: "bot", target: "owner@im.wechat", senderId: "owner@im.wechat" }] }, "weixin");
  const channel = bindWeixinOwner(native, owner);
  const received: string[] = [];
  const commands: string[] = [];
  channel.onInboundText!((event) => { received.push(event.text); });
  channel.onInboundCommand!((event) => { commands.push(event.text); return true; });
  const event: InboundTextEvent = { key: "a".repeat(64), accountId: "bot", target: "owner@im.wechat", messageId: "one", source: "text", text: "本人", receivedAt: Date.now(), replyText: async () => ({ ok: true }) };
  await listener!({ ...event, target: "foreign@im.wechat", text: "外人" });
  expect(await command!({ ...event, target: "foreign@im.wechat", text: "外人" })).toBe(false);
  expect(await channel.sendText({ accountId: "bot", target: "foreign@im.wechat", message: "错误目标" })).toMatchObject({ ok: false, reason: "unavailable" });
  await listener!(event); await command!(event);
  expect(await channel.sendText({ accountId: "bot", target: "owner@im.wechat", message: "本人回复" })).toEqual({ ok: true });
  expect(received).toEqual(["本人"]); expect(commands).toEqual(["本人"]); expect(outbox).toEqual(["本人回复"]);
  expect(channel.getSnapshot()).toEqual({ accounts: [{ accountId: "bot", credentialStatus: "usable" }], targets: [{ accountId: "bot", target: "owner@im.wechat" }] });
});
