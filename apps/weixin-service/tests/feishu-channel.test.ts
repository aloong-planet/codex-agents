import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ConversationService } from "../src/conversation-service.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { scriptedTurnRunner } from "./fixtures/scripted-turn-runner.js";
import { FeishuChannel, type FeishuTransport } from "../src/feishu-channel.js";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { DurableEffectLedger } from "../src/durable-effect-ledger.js";
import type { InboundMessage } from "../src/channel-contract.js";
import { FeishuInboundMedia, type FeishuResourceTransport } from "../src/feishu-inbound-media.js";

// SDK event shape: @larksuiteoapi/node-sdk 1.76.0 im.message.receive_v1.
// Network transport is fake; live credentials, published permissions and phone receipt require real-channel acceptance.
const event = () => ({ app_id: "cli_0123456789abcdef", event_id: "wrapper-1",
  sender: { sender_type: "user", sender_id: { open_id: "ou_owner", union_id: "on_union" } },
  message: { message_id: "om_original", create_time: "1800000000000", chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"你好"}' },
});
class Transport implements FeishuTransport {
  handlers: Parameters<FeishuTransport["start"]>[0] | undefined;
  outbox: Parameters<FeishuTransport["sendText"]>[0][] = [];
  failStart = false;
  failIdentity = false;
  unknown = false;
  closed = false;
  async start(handlers: Parameters<FeishuTransport["start"]>[0]) { this.handlers = handlers; if (this.failStart) throw new Error("private-secret"); }
  async botOpenId() { if (this.failIdentity) throw new Error("private-secret"); return "ou_bot"; }
  async sendText(input: Parameters<FeishuTransport["sendText"]>[0]) {
    this.outbox.push(input);
    if (this.unknown) throw new Error("private-secret");
    return { code: 0, data: { message_id: "om_receipt" } };
  }
  close() { this.closed = true; }
}
function harness(resources?: FeishuResourceTransport, groups: Array<{ chatId: string; allowedSenderIds: string[] }> = []) {
  const directory = mkdtempSync(join(tmpdir(), "feishu-channel-"));
  const config = parseChannelStartupConfiguration({ channel: "feishu",
    owner: { memoryAccountId: "old-bot", bindings: [{ channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" }] },
    taskScope: { accountId: "old-bot", target: "owner@im.wechat" },
    feishu: { appId: "cli_0123456789abcdef", appSecret: "private-secret", groups },
  });
  if (config.channel !== "feishu") throw new Error("invalid_test_configuration");
  const inbox = new DurableInboundStore(join(directory, "inbox.sqlite"));
  const effects = new DurableEffectLedger(join(directory, "effects.sqlite"));
  const transport = new Transport();
  const errors: string[] = [];
  const channel = new FeishuChannel(config, transport, inbox, effects, (code) => errors.push(code), Date.now,
    resources ? new FeishuInboundMedia(join(directory, "media"), "oc_private", resources) : undefined);
  return { directory, config, channel, inbox, effects, transport, errors,
    async close() { await channel.close(); inbox.close(); effects.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it("requires the real bot mention and a group member binding before replying to that group", async () => {
  const h = harness(undefined, [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }]);
  const received: InboundMessage[] = [];
  h.channel.onInboundText(async (message) => { received.push(message); await h.channel.sendText(message, "群回复"); });
  const groupEvent = (id: string, senderId: string, mentions: unknown[], text: string, chatId = "oc_alpha") => ({
    ...event(), sender: { sender_type: "user", sender_id: { open_id: senderId } },
    message: { ...event().message, message_id: id, chat_type: "group", chat_id: chatId, mentions, content: JSON.stringify({ text }) },
  });
  const bot = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" };
  try {
    await h.channel.start(); h.channel.activateInboundDispatch();
    await h.transport.handlers!.message(groupEvent("om_guest", "ou_guest", [bot], "@_user_1 send a file"));
    await h.transport.handlers!.message(groupEvent("om_other", "ou_alice", [{ ...bot, id: { open_id: "ou_other" } }], "@_user_1 hello"));
    await h.transport.handlers!.message(groupEvent("om_all", "ou_alice", [{ key: "@_all", id: { open_id: "all" }, name: "all" }], "@_all hello"));
    await h.transport.handlers!.message(groupEvent("om_fake", "ou_alice", [], "@Agent hello"));
    await h.transport.handlers!.message(groupEvent("om_foreign", "ou_alice", [bot], "@_user_1 hello", "oc_foreign"));
    await h.transport.handlers!.message(groupEvent("om_allowed", "ou_alice", [bot, { key: "@_user_10", id: { open_id: "ou_bob" }, name: "Bob" }, { key: "@_all", id: { open_id: "all" }, name: "all" }], "@_user_1 ask @_user_10 @_all"));
    await vi.waitFor(() => expect(h.transport.outbox).toHaveLength(1));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ conversationType: "group", senderId: "ou_alice", text: "ask @Bob @all" });
    expect(h.transport.outbox[0]).toMatchObject({ chatId: "oc_alpha", text: "群回复" });
  } finally { await h.close(); }
});

it("uses rich-text at nodes only when top-level mention metadata is absent", async () => {
  const h = harness({ async getMessage() { throw new Error("unexpected quote"); }, async download() { throw new Error("passive image must not download"); } },
    [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }]);
  const received: InboundMessage[] = [];
  h.channel.onInboundText(async (message) => { received.push(message); });
  const post = { title: "", content: [[{ tag: "at", user_id: "ou_bot" }, { tag: "at", user_id: "ou_bob" }, { tag: "text", text: "群内讨论" }]] };
  const groupPost = { ...event(), sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } },
    message: { ...event().message, chat_type: "group", chat_id: "oc_alpha", message_type: "post", content: JSON.stringify(post) } };
  try {
    await h.channel.start(); h.channel.activateInboundDispatch();
    await h.transport.handlers!.message({ ...groupPost, message: { ...groupPost.message, message_id: "om_conflicting", mentions: [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "Other" }],
      content: JSON.stringify({ ...post, content: [...post.content, [{ tag: "img", image_key: "img_passive" }]] }) } });
    await h.transport.handlers!.message({ ...groupPost, message: { ...groupPost.message, message_id: "om_realpost" } });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ text: "@ou_bob群内讨论", conversationType: "group" });
    await h.transport.handlers!.message({ ...groupPost, message: { ...groupPost.message, message_id: "om_placeholderpost",
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }, { key: "@_user_10", id: { open_id: "ou_bob" }, name: "Bob" }],
      content: JSON.stringify({ title: "", content: [[{ tag: "at", user_id: "@_user_1" }, { tag: "at", user_id: "@_user_10" }, { tag: "text", text: "继续讨论" }]] }) } });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({ text: "@Bob继续讨论", conversationType: "group" });
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

it("retains bounded deduplicated discussion from guests without giving them a model turn", async () => {
  const h = harness(undefined, [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }]);
  const received: InboundMessage[] = [];
  h.channel.onInboundText(async (message) => { received.push(message); });
  const groupEvent = (id: string, text: string, senderId = "ou_guest", addressed = false) => ({
    ...event(), sender: { sender_type: "user", sender_id: { open_id: senderId } },
    message: { ...event().message, message_id: id, chat_type: "group", chat_id: "oc_alpha", content: JSON.stringify({ text }),
      mentions: addressed ? [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }] : [] },
  });
  try {
    await h.channel.start(); h.channel.activateInboundDispatch();
    for (let index = 1; index <= 101; index++) await h.transport.handlers!.message(groupEvent(`om_discussion${index}`, `discussion ${index}`, "ou_guest", index === 101));
    await h.transport.handlers!.message(groupEvent("om_discussion101", "discussion 101", "ou_guest", true));
    await h.transport.handlers!.message(groupEvent("om_question", "@_user_1 summarize", "ou_alice", true));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.discussion).toHaveLength(100);
    expect(received[0]!.discussion![0]).toMatchObject({ senderId: "ou_guest", text: "discussion 2" });
    expect(received[0]!.discussion!.at(-1)).toMatchObject({ senderId: "ou_guest", text: "discussion 101" });
    expect(new Set(received[0]!.discussion!.map((item) => item.key)).size).toBe(100);
    expect(received[0]!.text).toBe("summarize");
    expect(h.transport.outbox).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

it("continues other conversations while preserving order in a busy group", async () => {
  const h = harness(undefined, ["oc_alpha", "oc_beta"].map((chatId) => ({ chatId, allowedSenderIds: ["ou_alice"] })));
  const received: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  h.channel.onInboundText(async (message) => { received.push(message.messageId); if (message.messageId === "om_alpha1") await held; });
  const groupEvent = (id: string, chatId: string) => ({ ...event(), sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } },
    message: { ...event().message, message_id: id, chat_id: chatId, chat_type: "group", content: '{"text":"@_user_1 hi"}', mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }] } });
  try {
    await h.channel.start(); h.channel.activateInboundDispatch();
    await h.transport.handlers!.message(groupEvent("om_alpha1", "oc_alpha"));
    await vi.waitFor(() => expect(received).toEqual(["om_alpha1"]));
    await h.transport.handlers!.message(groupEvent("om_alpha2", "oc_alpha"));
    await h.transport.handlers!.message(groupEvent("om_beta", "oc_beta"));
    await h.transport.handlers!.message(event());
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toContain("om_beta"); expect(received).toContain("om_original");
    expect(received).not.toContain("om_alpha2");
    release();
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received.at(-1)).toBe("om_alpha2");
  } finally { release(); await h.close(); }
});

it("drains a group backlog in arrival order with only preceding deduplicated discussion", async () => {
  const h = harness(undefined, [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }]);
  const received: InboundMessage[] = [];
  h.channel.onInboundText(async (message) => { received.push(message); });
  const queued = (id: string, text: string, createTime: string, addressed: boolean) => ({
    ...event(), sender: { sender_type: "user", sender_id: { open_id: addressed ? "ou_alice" : "ou_guest" } },
    message: { ...event().message, message_id: id, create_time: createTime, chat_type: "group", chat_id: "oc_alpha",
      content: JSON.stringify({ text: addressed ? `@_user_1 ${text}` : text }),
      mentions: addressed ? [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }] : [] },
  });
  try {
    await h.channel.start();
    await h.transport.handlers!.message(queued("om_first", "first request", "1800000005000", true));
    await h.transport.handlers!.message(queued("om_observation1", "first discussion", "1800000004000", false));
    await h.transport.handlers!.message(queued("om_second", "second request", "1800000003000", true));
    await h.transport.handlers!.message(queued("om_observation2", "second discussion", "1800000002000", false));
    await h.transport.handlers!.message(queued("om_observation1", "first discussion", "1800000004000", false));
    await h.transport.handlers!.message(queued("om_third", "third request", "1800000001000", true));
    expect(received).toEqual([]);
    h.channel.activateInboundDispatch();
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.map((message) => message.messageId)).toEqual(["om_first", "om_second", "om_third"]);
    expect(received.map((message) => message.discussion?.map(({ senderId, text }) => ({ senderId, text })))).toEqual([
      [],
      [{ senderId: "ou_alice", text: "first request" }, { senderId: "ou_guest", text: "first discussion" }],
      [{ senderId: "ou_alice", text: "first request" }, { senderId: "ou_guest", text: "first discussion" },
        { senderId: "ou_alice", text: "second request" }, { senderId: "ou_guest", text: "second discussion" }],
    ]);
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

it("discards revoked queued group work on restart without blocking currently authorized members", async () => {
  const h = harness(undefined, [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }]);
  const addressed = (id: string, senderId: string) => ({ ...event(), sender: { sender_type: "user", sender_id: { open_id: senderId } },
    message: { ...event().message, message_id: id, chat_id: "oc_alpha", chat_type: "group", content: '{"text":"@_user_1 hi"}', mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }] } });
  let restarted: FeishuChannel | undefined;
  try {
    await h.channel.start();
    await h.transport.handlers!.message(addressed("om_old", "ou_alice"));
    const address = h.config.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_alice", conversationType: "group" })!;
    const queued = h.inbox.peekQueued(address.accountId, address.target)!;
    expect(queued.messageId).toBe("om_old");
    await h.channel.close();
    const config = parseChannelStartupConfiguration({ channel: "feishu",
      owner: { memoryAccountId: "old-bot", bindings: [{ channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" }] },
      taskScope: { accountId: "old-bot", target: "owner@im.wechat" },
      feishu: { appId: "cli_0123456789abcdef", appSecret: "private-secret", groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_bob"] }] },
    });
    if (config.channel !== "feishu") throw new Error("invalid_test_configuration");
    const transport = new Transport(); const received: string[] = [];
    restarted = new FeishuChannel(config, transport, h.inbox, h.effects, (code) => h.errors.push(code));
    restarted.onInboundText(async (message) => { received.push(message.messageId); });
    await restarted.start(); restarted.activateInboundDispatch();
    await transport.handlers!.message(addressed("om_new", "ou_bob"));
    await vi.waitFor(() => expect(received).toEqual(["om_new"]));
    expect(h.inbox.peek(queued.eventKey)?.state).toBe("completed");
    expect(h.errors).toEqual(["feishu_inbound_binding_changed"]);
  } finally { await restarted?.close(); await h.close(); }
});

it("keeps private chat usable when bot identity cannot be verified for groups", async () => {
  const h = harness(undefined, [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }]);
  h.transport.failIdentity = true;
  const received: string[] = [];
  h.channel.onInboundText(async (message) => { received.push(message.messageId); });
  try {
    await h.channel.start(); h.channel.activateInboundDispatch();
    await h.transport.handlers!.message({ ...event(), message: { ...event().message, message_id: "om_group", chat_type: "group", chat_id: "oc_alpha",
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }], content: '{"text":"@_user_1 hello"}' } });
    await h.transport.handlers!.message(event());
    await vi.waitFor(() => expect(received).toEqual(["om_original"]));
    expect(h.errors).toEqual(["feishu_bot_identity_unavailable"]);
  } finally { await h.close(); }
});

it("admits only the bound private owner, commits before acknowledging and deduplicates message IDs", async () => {
  const h = harness();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const observed = new Promise<void>((resolve) => { entered = resolve; });
  const received: InboundMessage[] = [];
  h.channel.onInboundText(async (message) => { received.push(message); entered(); await held; });
  try {
    await h.channel.start();
    h.channel.activateInboundDispatch();
    const foreign = [
      { ...event(), app_id: "cli_ffffffffffffffff" },
      { ...event(), sender: { sender_type: "user", sender_id: { open_id: "ou_foreign" } } },
      { ...event(), message: { ...event().message, chat_type: "group" } },
      { ...event(), message: { ...event().message, chat_id: "oc_foreign" } },
      { ...event(), message: { ...event().message, content: "bad-json" } },
    ];
    for (const input of foreign) await h.transport.handlers!.message(input);
    expect(received).toEqual([]);
    expect(h.inbox.queuedTargets(h.config.owner.conversationAddress().accountId)).toEqual([]);
    await h.transport.handlers!.message(event());
    await observed;
    // The core listener is still waiting, but transport acknowledgement has completed.
    expect(received).toHaveLength(1);
    expect(h.inbox.peek(received[0]!.key)).toMatchObject({ text: "你好", state: "leased", admission: { senderId: "ou_owner" } });
    await h.transport.handlers!.message({ ...event(), event_id: "wrapper-retry" });
    expect(received).toHaveLength(1);
  } finally { release(); await h.close(); }
});

it("downloads only admitted owner media and delivers its durable normalized content once", async () => {
  const downloads: unknown[] = [];
  const h = harness({ async getMessage() { throw new Error("unexpected quote"); }, async download(input) {
    downloads.push(input); const stream = Readable.from([Buffer.from("owner image")]);
    return { stream, contentType: "image/png", cancel() { stream.destroy(); } };
  } });
  let delivered!: () => void;
  const observed = new Promise<void>((resolve) => { delivered = resolve; });
  const received: InboundMessage[] = [];
  h.channel.onInboundText(async (message) => { received.push(message); delivered(); });
  const imageEvent = { ...event(), message: { ...event().message, message_type: "image", content: '{"image_key":"img_owner"}' } };
  try {
    await h.channel.start();
    await h.transport.handlers!.message({ ...imageEvent, sender: { sender_type: "user", sender_id: { open_id: "ou_foreign" } } });
    expect(downloads).toEqual([]);
    await h.transport.handlers!.message(imageEvent);
    expect(received).toEqual([]);
    expect(h.inbox.queuedTargets(h.config.owner.conversationAddress().accountId)).toEqual([h.config.owner.conversationAddress().target]);
    h.channel.activateInboundDispatch(); await observed;
    await h.transport.handlers!.message(imageEvent);
    expect(received).toHaveLength(1); expect(downloads).toHaveLength(1);
    expect(received[0]).toMatchObject({ source: "media", attachments: [{ kind: "image", sizeBytes: 11, quoted: false }] });
    expect(readFileSync(received[0]!.attachments![0]!.path, "utf8")).toBe("owner image");
    expect(h.inbox.peek(received[0]!.key)?.attachments).toEqual(received[0]!.attachments);
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

it("binds replies to admitted destinations and never resends an unknown notification operation", async () => {
  const h = harness();
  let finished!: () => void;
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  let failure: unknown;
  h.channel.onInboundText(async (message) => {
    try {
      await expect(h.channel.sendText({ ...message, target: "feishu.forged" }, "wrong")).rejects.toThrow("inbound_delivery_binding_unavailable");
      expect(await h.channel.sendText(message, "精确回复。")).toMatchObject({ ok: true, acceptedSegments: 1 });
    } catch (error) { failure = error; } finally { finished(); }
  });
  try {
    await h.channel.start(); h.channel.activateInboundDispatch();
    await h.transport.handlers!.message(event()); await completed;
    if (failure) throw failure;
    expect(h.transport.outbox).toHaveLength(1);
    expect(h.transport.outbox[0]).toMatchObject({ chatId: "oc_private", text: "精确回复。" });
    h.transport.unknown = true;
    const input = { ...h.config.owner.conversationAddress(), channel: "feishu" as const, operationId: "task:one", message: "提醒", beforeSubmit: () => true };
    expect(await h.channel.send(input)).toMatchObject({ ok: false, reason: "unknown", acceptedSegments: 0 });
    expect(await h.channel.send(input)).toMatchObject({ ok: false, reason: "unknown" });
    expect(h.transport.outbox).toHaveLength(2);
    expect(h.errors).toEqual(["feishu_send_unknown"]);
  } finally { await h.close(); }
});

it("keeps startup and active failures local and refuses delivery while unavailable", async () => {
  const h = harness();
  const input = { ...h.config.owner.conversationAddress(), channel: "feishu" as const, operationId: "task:two", message: "提醒", beforeSubmit: () => true };
  try {
    expect(await h.channel.send(input)).toMatchObject({ ok: false, reason: "unavailable" });
    h.transport.failStart = true;
    await expect(h.channel.start()).rejects.toThrow(/^feishu_startup_failed$/);
    expect(h.transport.closed).toBe(true);
    expect(await h.channel.send(input)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.transport.outbox).toEqual([]);
    expect(h.errors).toEqual(["feishu_startup_failed"]);
  } finally { await h.close(); }
  const running = harness();
  try {
    await running.channel.start();
    running.transport.handlers!.unavailable();
    expect(await running.channel.send(input)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(running.transport.outbox).toEqual([]);
    expect(running.errors).toEqual(["feishu_connection_unavailable"]);
  } finally { await running.close(); }
});

// Failure is driven through the real adapter's authenticated event and public core lifecycle.
it("delivers a model failure notice without an automatic processing acknowledgement", async () => {
  const h = harness();
  const service = new ConversationService(h.channel, {
    async startOrResume() { return "019fef94-7da4-75a2-b9fb-226af024ddcd"; },
    runTurn: scriptedTurnRunner(async () => { throw new Error("model unavailable"); }),
    close() {},
  }, new CodexServiceStore(join(h.directory, "service.json")), h.directory);
  try {
    await h.channel.start();
    await service.start();
    const address = h.config.owner.conversationAddress();
    await service.enable(address.accountId, address.target);
    h.channel.activateInboundDispatch();
    await h.transport.handlers!.message(event());
    await vi.waitFor(() => expect(service.getPublicState().runs.at(-1)?.phase).toBe("failed"));
    expect(h.transport.outbox.map((item) => item.text)).toEqual(["我暂时无法处理这条消息，请稍后再发一条新消息。"]);
  } finally { await service.close(); await h.close(); }
});
