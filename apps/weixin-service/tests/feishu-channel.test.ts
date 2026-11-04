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
  unknown = false;
  closed = false;
  async start(handlers: Parameters<FeishuTransport["start"]>[0]) { this.handlers = handlers; if (this.failStart) throw new Error("private-secret"); }
  async sendText(input: Parameters<FeishuTransport["sendText"]>[0]) {
    this.outbox.push(input);
    if (this.unknown) throw new Error("private-secret");
    return { code: 0, data: { message_id: "om_receipt" } };
  }
  close() { this.closed = true; }
}
function harness(resources?: FeishuResourceTransport) {
  const directory = mkdtempSync(join(tmpdir(), "feishu-channel-"));
  const config = parseChannelStartupConfiguration({ channel: "feishu",
    owner: { memoryAccountId: "old-bot", bindings: [{ channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" }] },
    taskScope: { accountId: "old-bot", target: "owner@im.wechat" },
    feishu: { appId: "cli_0123456789abcdef", appSecret: "private-secret" },
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
