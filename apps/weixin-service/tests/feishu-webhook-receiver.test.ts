import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FeishuWebhookReceiver } from "../src/feishu-webhook-receiver.js";

// Protocol fixture shape: official Feishu schema 2.0 receive-message / URL verification examples and SDK 1.76.0.
// Live public ingress, app permissions, model decisions and real-group receipt need separate acceptance.
const credentials = { appId: "cli_0123456789abcdef", verificationToken: "fixture-verification", encryptKey: "fixture-encryption" };
function envelope(messageId = "om_first", eventId = "event_first") {
  return { schema: "2.0", header: { event_id: eventId, token: credentials.verificationToken, create_time: "1608725989000",
    event_type: "im.message.receive_v1", tenant_key: "fixture-tenant", app_id: credentials.appId },
  event: { sender: { sender_id: { union_id: "on_author", user_id: "author", open_id: "ou_author" }, sender_type: "user", tenant_key: "fixture-tenant" },
    message: { message_id: messageId, root_id: "", parent_id: "", create_time: "1608725989000", chat_id: "oc_group", chat_type: "group",
      message_type: "text", content: '{"text":"帮我整理商品文案"}', mentions: [] } } };
}
function encrypted(value: unknown) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(credentials.encryptKey).digest(), iv);
  return JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final()]).toString("base64") }, null, 2);
}
function headers(body: string) {
  const timestamp = "1608725989", nonce = "fixture-nonce";
  return { "content-type": "application/json", "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce,
    "x-lark-signature": createHash("sha256").update(timestamp + nonce + credentials.encryptKey + body).digest("hex") };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
it("answers encrypted verification and acknowledges durable messages while the consumer is blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-webhook-"));
  const receiver = new FeishuWebhookReceiver({ ...credentials, port: 0, path: "/events", databasePath: join(directory, "callbacks.sqlite") });
  const received = deferred<unknown>(), release = deferred<void>();
  try {
    await receiver.start(async (event) => { received.resolve(event); await release.promise; });
    const url = `http://127.0.0.1:${receiver.port}/events`;
    const challenge = await fetch(url, { method: "POST", body: encrypted({ type: "url_verification", token: credentials.verificationToken, challenge: "challenge-value" }), signal: AbortSignal.timeout(2000) });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "challenge-value" });
    const body = encrypted(envelope());
    const response = await fetch(url, { method: "POST", headers: headers(body), body, signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(await received.promise).toEqual({ app_id: "cli_0123456789abcdef",
      sender: { sender_id: { union_id: "on_author", user_id: "author", open_id: "ou_author" }, sender_type: "user", tenant_key: "fixture-tenant" },
      message: { message_id: "om_first", root_id: "", parent_id: "", create_time: "1608725989000", chat_id: "oc_group", chat_type: "group",
        message_type: "text", content: '{"text":"帮我整理商品文案"}', mentions: [] } });
  } finally { release.resolve(); await receiver.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("recovers admitted work after consumer failure and deduplicates by message rather than event identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-webhook-restart-"));
  const options = { ...credentials, port: 0, path: "/events", databasePath: join(directory, "callbacks.sqlite") };
  let receiver = new FeishuWebhookReceiver(options);
  const failed = deferred<void>();
  try {
    await receiver.start(async () => { failed.resolve(); throw new Error("downstream_unavailable"); });
    const post = async (value: unknown) => {
      const body = encrypted(value);
      const result = await fetch(`http://127.0.0.1:${receiver.port}/events`, { method: "POST", headers: headers(body), body, signal: AbortSignal.timeout(2000) });
      expect(result.status).toBe(200);
      await result.text();
    };
    await post(envelope());
    await failed.promise;
    await post(envelope("om_first", "redelivered_event"));
    await receiver.close();
    receiver = new FeishuWebhookReceiver(options);
    const delivered: string[] = [], barrier = deferred<void>();
    await receiver.start(async (event) => {
      const value = event as { message: { message_id: string } };
      delivered.push(value.message.message_id);
      if (value.message.message_id === "om_barrier") barrier.resolve();
    });
    await post(envelope("om_first", "yet_another_event"));
    await post(envelope("om_barrier", "event_barrier"));
    await barrier.promise;
    expect(delivered).toEqual(["om_first", "om_barrier"]);
    await receiver.close();
    receiver = new FeishuWebhookReceiver(options);
    const secondBarrier = deferred<void>();
    await receiver.start(async (event) => {
      const value = event as { message: { message_id: string } };
      delivered.push(value.message.message_id);
      secondBarrier.resolve();
    });
    await post(envelope("om_first", "late_replay"));
    await post(envelope("om_after_restart", "event_after_restart"));
    await secondBarrier.promise;
    expect(delivered).toEqual(["om_first", "om_barrier", "om_after_restart"]);
  } finally { await receiver.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps failed conversation work ordered without blocking other conversations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-webhook-isolation-"));
  const receiver = new FeishuWebhookReceiver({ ...credentials, port: 0, path: "/events", databasePath: join(directory, "callbacks.sqlite") });
  const failed = deferred<void>();
  const delivered: string[] = [];
  let available = false;
  try {
    await receiver.start(async (event) => {
      const message = (event as { message: { message_id: string } }).message;
      if (message.message_id === "om_failed" && !available) { failed.resolve(); throw new Error("resource_unavailable"); }
      delivered.push(message.message_id);
    });
    const post = async (id: string, chatId: string) => {
      const value = envelope(id); value.event.message.chat_id = chatId;
      const body = encrypted(value);
      const response = await fetch(`http://127.0.0.1:${receiver.port}/events`, { method: "POST", headers: headers(body), body });
      expect(response.status).toBe(200); await response.text();
    };
    await post("om_failed", "oc_alpha"); await failed.promise;
    await post("om_following", "oc_alpha"); await post("om_other", "oc_beta");
    await expect.poll(() => delivered, { timeout: 2000 }).toEqual(["om_other"]);
    available = true;
    await expect.poll(() => delivered, { timeout: 2000 }).toEqual(["om_other", "om_failed", "om_following"]);
  } finally { available = true; await receiver.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects invalid authentication, malformed and oversized bodies without admitting messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-webhook-auth-"));
  const receiver = new FeishuWebhookReceiver({ ...credentials, port: 0, path: "/events", databasePath: join(directory, "callbacks.sqlite") });
  const messages: unknown[] = [], delivered = deferred<void>();
  try {
    await receiver.start(async (event) => { messages.push(event); delivered.resolve(); });
    const url = `http://127.0.0.1:${receiver.port}/events`;
    const validBody = encrypted(envelope());
    const wrongApp = envelope(); wrongApp.header.app_id = "cli_fedcba9876543210";
    const wrongToken = envelope(); wrongToken.header.token = "different-token";
    const cases = [
      { body: validBody, auth: {}, status: 401 },
      { body: validBody, auth: { ...headers(validBody), "x-lark-signature": "0".repeat(64) }, status: 401 },
      { body: `${validBody} `, auth: headers(validBody), status: 401 },
      { body: encrypted(wrongApp), status: 401 },
      { body: encrypted(wrongToken), status: 401 },
      { body: encrypted({ type: "url_verification", token: "wrong-token", challenge: "wrong" }), status: 401 },
      { body: "{broken", status: 400 },
      { body: '{"encrypt":"invalid ciphertext"}', status: 400 },
      { body: "x".repeat(1024 * 1024 + 1), status: 413 },
    ];
    for (const item of cases) {
      const response = await fetch(url, { method: "POST", headers: item.auth ?? headers(item.body), body: item.body, signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(item.status);
      expect(await response.json()).toEqual({});
    }
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url.replace("/events", "/api/state"))).status).toBe(404);
    expect(messages).toEqual([]);
    const accepted = await fetch(url, { method: "POST", headers: headers(validBody), body: validBody });
    expect(accepted.status).toBe(200);
    await delivered.promise;
    expect(messages).toHaveLength(1);
  } finally { await receiver.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("ignores bot and unrelated events while forwarding the next human message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-webhook-human-"));
  const receiver = new FeishuWebhookReceiver({ ...credentials, port: 0, path: "/events", databasePath: join(directory, "callbacks.sqlite") });
  const delivered = deferred<void>(), messages: string[] = [];
  try {
    await receiver.start(async (event) => { messages.push((event as { message: { message_id: string } }).message.message_id); delivered.resolve(); });
    const bot = envelope("om_bot"); bot.event.sender.sender_type = "bot";
    const system = envelope("om_system"); system.event.sender.sender_type = "system";
    const unrelated = envelope("om_unrelated"); unrelated.header.event_type = "im.chat.member.user.added_v1";
    for (const value of [bot, system, unrelated, envelope("om_human")]) {
      const body = encrypted(value);
      const response = await fetch(`http://127.0.0.1:${receiver.port}/events`, { method: "POST", headers: headers(body), body });
      expect(response.status).toBe(200);
      await response.text();
    }
    await delivered.promise;
    expect(messages).toEqual(["om_human"]);
  } finally { await receiver.close(); rmSync(directory, { recursive: true, force: true }); }
});
