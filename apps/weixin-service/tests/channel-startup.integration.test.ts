import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { LocalFileOperationStore } from "../src/local-file-operation-store.js";
import { config, dispatchConfig, freePort, start, stop } from "./support/real-main.js";
import { seedMemory } from "./support/memory.js";
import { processWaitLimitMs } from "./support/process-wait.js";
import { memoryAccountId } from "../src/agent-profile.js";

// Real main composition and durable processing; external model/Feishu/Weixin peers are fixtures.
// Live app permissions, delivery and phone receipt require separately authorized user-observed acceptance.
// Cancel uses a canned fixture Router decision; this verifies host effects, not live-model semantics.
// Production coordinator JSON decoding and tool-free invocation are covered in agent-dispatch-classifier.test.ts.
// DISPATCH_RESULT_SCOPE_LIVE=1 opts into real model goal-scope checks; all channel sends remain fixtures.

it("keeps Penny bookkeeping private while existing Weixin and group dispatch remain usable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penny-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory, true);
    const webhook = { port: await freePort(), path: "/feishu/penny/events", verificationToken: "penny-token", encryptKey: "penny-key" };
    const penny = { appId: "cli_eeeeeeeeeeeeeeee", appSecret: "penny-secret", tenantKey: "penny-tenant", ownerOpenId: "ou_pennyowner", privateChatId: "oc_pennyprivate", webhook };
    const configPath = join(directory, "penny.json"); writeFileSync(configPath, JSON.stringify(penny), { mode: 0o600 });
    const text = "午饭 35.27 元 PENNY_PRIVATE_FACT";
    const commands = { [text]: { kind: "record", evidence: text, book: "personal", entries: [{ date: "2026-11-06", kind: "expense", amount: "35.27", currency: "CNY",
      description: "PENNY_PRIVATE_FACT", category: "餐饮", selfTransferConfirmed: false, originalRef: null, unrecordedOriginal: null, status: "settled", issue: null }] },
      本月汇总: { kind: "query", book: "personal", from: "2026-11-01", to: "2026-11-30", category: null } };
    const env = { PENNY_CONFIG_PATH: configPath, WORKFLOW_FIXTURE_FINANCE_COMMANDS: JSON.stringify(commands) };
    running = await start(directory, env);
    await running.until((state) => state.penny?.ready === true && state.channels?.feishu?.ready === true);
    await running.post("/api/fixture/feishu/inbound", { applicationControl: { agentId: "penny", textOutcomes: ["held"] } });
    const event = { schema: "2.0", header: { event_id: "penny_main", event_type: "im.message.receive_v1", app_id: penny.appId, tenant_key: penny.tenantKey, token: webhook.verificationToken },
      event: { sender: { sender_type: "user", sender_id: { open_id: penny.ownerOpenId } }, message: { message_id: "om_penny_main", chat_id: penny.privateChatId, chat_type: "p2p",
        create_time: String(Date.now()), message_type: "text", content: JSON.stringify({ text }) } } };
    const postPenny = async (messageId: string, messageText: string) => {
      event.event.message.message_id = messageId; event.event.message.content = JSON.stringify({ text: messageText });
      const iv = randomBytes(16), cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(webhook.encryptKey).digest(), iv);
      const body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(event)), cipher.final()]).toString("base64") });
      const timestamp = "1608725989", nonce = "penny-main";
      const response = await fetch(`http://127.0.0.1:${webhook.port}${webhook.path}`, { method: "POST", body, headers: {
        "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce,
        "x-lark-signature": createHash("sha256").update(timestamp + nonce + webhook.encryptKey + body).digest("hex"),
      } });
      expect(response.status).toBe(200); await response.text();
    };
    await postPenny("om_penny_main", text); await postPenny("om_penny_main", text);
    const recorded = await running.until((state) => state.pennyFixtureTextOutbox?.length === 1);
    expect(recorded.pennyFixtureTextOutbox).toEqual([expect.objectContaining({ chatId: "oc_pennyprivate", message: expect.stringContaining("F00000001（版本 1）\n个人账 · 2026-11-06 · 支出 ¥35.27 · PENNY_PRIVATE_FACT") })]);
    await running.post("/api/fixture/workflow/inbound", { text: "微信独立消息" });
    await running.post("/api/fixture/feishu/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_penny_group_regression", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: '{"text":"帮我整理闲鱼商品描述"}' } },
      dispatchDecision: { kind: "dispatch", agentId: "alice", requestId: null, summary: "整理闲鱼商品描述", message: "" },
    });
    const result = await running.until((state) => state.weixinFixtureReplies?.length === 2 && state.agentFixtureOutboxes?.alice?.text.length === 2);
    expect(result.weixinFixtureReplies?.map((reply) => reply.message)).toEqual(["已收到，正在处理。", "这是 fixture Codex 回复。"]);
    expect(result.agentFixtureOutboxes?.alice?.text.map((reply) => reply.message)).toEqual(["我安排执行者 1（能力档 1）处理：整理闲鱼商品描述。完成后会在本群汇报。", "这是 fixture Codex 回复。"]);
    const { pennyFixtureTextOutbox, ...operational } = result;
    expect(pennyFixtureTextOutbox).toHaveLength(1);
    expect(JSON.stringify(operational)).not.toMatch(/PENNY_PRIVATE_FACT|35\.27|F00000001/u);
    expect(result.fixtureModelRequests).toHaveLength(2);
    console.log(JSON.stringify({ kind: "penny_main_acceptance", pennyReply: pennyFixtureTextOutbox, weixinCommand: "微信独立消息", weixinReplies: result.weixinFixtureReplies,
      runs: result.codex.runs, workflows: result.workflows, outbox: result.fixtureOutbox, groupReplies: result.agentFixtureOutboxes?.alice?.text }));
    await running.crash(); running = undefined;
    running = await start(directory, env);
    await running.until((state) => state.penny?.ready === true);
    await postPenny("om_penny_query_after_crash", "本月汇总");
    const recovered = await running.until((state) => state.pennyFixtureTextOutbox?.at(-1)?.message.includes("净支出") === true);
    expect(recovered.pennyFixtureTextOutbox).toHaveLength(1);
    expect(recovered.pennyFixtureTextOutbox![0]!.message).toContain("净支出 ¥35.27");
    expect(recovered.pennyFixtureTextOutbox![0]!.message.match(/F\d{8}/gu)).toEqual(["F00000001"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("contains an invalid Penny configuration without blocking existing private messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penny-unavailable-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    writeFileSync(join(directory, "penny.json"), '{"appSecret":"MUST_NOT_LEAK"}', { mode: 0o600 });
    running = await start(directory, { PENNY_CONFIG_PATH: join(directory, "penny.json") });
    await running.post("/api/fixture/workflow/inbound", { text: "Penny 暂不可用时继续微信对话" });
    const result = await running.until((state) => state.weixinFixtureReplies?.length === 2);
    expect(result.penny).toEqual({ configured: true, ready: false, error: "penny_configuration_unavailable" });
    expect(result.weixinFixtureReplies?.map((reply) => reply.message)).toEqual(["已收到，正在处理。", "这是 fixture Codex 回复。"]);
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAK");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("contains Penny callback startup failure while later Weixin messages still succeed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penny-port-conflict-"));
  const occupied = createServer();
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("no_port");
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    writeFileSync(join(directory, "penny.json"), JSON.stringify({ appId: "cli_eeeeeeeeeeeeeeee", appSecret: "PENNY_SECRET_UNAVAILABLE",
      tenantKey: "penny-tenant", ownerOpenId: "ou_pennyowner", privateChatId: "oc_pennyprivate",
      webhook: { port: address.port, path: "/feishu/penny/events", verificationToken: "penny-token", encryptKey: "penny-key" },
    }), { mode: 0o600 });
    running = await start(directory, { PENNY_CONFIG_PATH: join(directory, "penny.json") });
    await running.until((state) => state.penny?.error === "penny_startup_unavailable");
    await running.post("/api/fixture/workflow/inbound", { text: "Penny 端口冲突后继续微信对话" });
    const result = await running.until((state) => state.weixinFixtureReplies?.length === 2);
    expect(result.penny).toEqual({ configured: true, ready: false, error: "penny_startup_unavailable" });
    expect(result.weixinFixtureReplies?.map((reply) => reply.message)).toEqual(["已收到，正在处理。", "这是 fixture Codex 回复。"]);
    expect(JSON.stringify(result)).not.toContain("PENNY_SECRET_UNAVAILABLE");
  } finally {
    await running?.close(); await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

it("receives signed webhook events through real main and replies once through the configured Feishu sender", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-webhook-main-"));
  const callbackPort = await freePort();
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const base = config("feishu");
    const webhook = { port: callbackPort, path: "/feishu/events", verificationToken: "fixture-token", encryptKey: "fixture-key" };
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...base, feishu: { ...base.feishu, receiveMode: "webhook", webhook } }));
    running = await start(directory);
    const event = { schema: "2.0", header: { event_id: "event_main", event_type: "im.message.receive_v1", app_id: base.feishu.appId, token: webhook.verificationToken },
      event: { sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } }, message: { message_id: "om_http_main", chat_id: "oc_private", chat_type: "p2p",
        create_time: String(Date.now()), message_type: "text", content: '{"text":"Webhook 接收测试"}' } } };
    for (const eventId of ["event_main", "event_redelivery"]) {
      event.header.event_id = eventId;
      const iv = randomBytes(16), cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(webhook.encryptKey).digest(), iv);
      const body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(event)), cipher.final()]).toString("base64") });
      const timestamp = "1608725989", nonce = "fixture-http-nonce";
      const response = await fetch(`http://127.0.0.1:${callbackPort}/feishu/events`, { method: "POST", headers: {
        "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce,
        "x-lark-signature": createHash("sha256").update(timestamp + nonce + webhook.encryptKey + body).digest("hex"),
      }, body, signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      await response.text();
    }
    const result = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    expect(result.fixtureTextOutbox).toEqual([expect.objectContaining({ chatId: "oc_private", message: "这是 fixture Codex 回复。" })]);
    expect(result.fixtureModelRequests).toHaveLength(1);
    expect(result.codex.runs.at(-1)?.phase).toBe("completed");
    expect(result.codex.transcript.filter((item) => item.role === "user").map((item) => item.text)).toEqual(["Webhook 接收测试"]);
    console.log(JSON.stringify({ kind: "webhook_main_acceptance", replies: result.fixtureTextOutbox, runs: result.codex.runs.map(({ phase }) => phase) }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("switches via stop/configure/start, retains permissions and histories, and keeps the running selector fixed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-main-"));
  const configPath = join(directory, "channel.json");
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(configPath, JSON.stringify(config("weixin")));
    running = await start(directory);
    await running.post("/api/codex/permissions/configure", { mode: "safe", rootIds: ["workspace"], confirmed: true });
    await running.post("/api/fixture/workflow/inbound", { text: "微信第一条" });
    const first = await running.until((s) => s.codex.transcript.some((e) => e.role === "assistant" && e.text === "这是 fixture Codex 回复。"));
    expect(first.codex.runs.at(-1)?.phase).toBe("completed");
    expect(first.codex.transcript.filter((e) => e.role === "assistant").map((e) => e.text)).toEqual(["已收到，正在处理。", "这是 fixture Codex 回复。"]);
    const savedPermissions = first.codex.permissions;
    const reminderCommand = "稍后提醒我：切换后提醒。";
    const reminderAt = Date.now() + 5000;
    await running.post("/api/fixture/workflow/inbound", { text: reminderCommand, modelToolCalls: [{ namespace: "schedules", tool: "create", arguments: {
      name: "切换提醒", instruction: "切换后提醒。", reminderText: "切换后提醒。", reminderMode: "natural",
      at: new Date(reminderAt).toISOString(), sourceText: reminderCommand,
    } }] });
    const scheduled = await running.state();
    expect(scheduled.codex.runs.at(-1)?.phase).toBe("completed");
    expect(scheduled.fixtureTextOutbox?.some((item) => item.message === "切换后提醒。")).toBe(false);
    await running.close();
    writeFileSync(configPath, JSON.stringify(config("feishu")));
    running = await start(directory);
    const second = await running.state();
    expect(second.accounts).toHaveLength(1);
    expect(second.accounts[0]!.accountId).not.toBe("fixture-bot");
    expect(second.codex.threadReady).toBe(true);
    expect(second.codex.permissions).toEqual(savedPermissions);
    // A file edit while running cannot select another transport.
    writeFileSync(configPath, JSON.stringify(config("weixin")));
    await running.post("/api/fixture/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_second", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"飞书第二条"}' } } });
    const replied = await running.until((s) => s.fixtureTextOutbox?.some((item) => item.message === "这是 fixture Codex 回复。") === true);
    expect(replied.fixtureTextOutbox?.map((item) => item.message)).toEqual(["这是 fixture Codex 回复。"]);
    expect(replied.channel).toBe("feishu");
    expect(replied.codex.runs.at(-1)?.phase).toBe("completed");
    expect(replied.codex.transcript.filter((e) => e.role === "user").map((e) => e.text)).toEqual(["微信第一条", reminderCommand, "飞书第二条"]);
    await delay(Math.max(0, reminderAt - Date.now()) + 300);
    const notification = await running.state();
    expect(notification.fixtureTextOutbox?.filter((item) => item.message === "切换后提醒。")).toHaveLength(0);
    await running.close();
    running = await start(directory);
    expect((await running.state()).accounts.map((item) => item.accountId)).toEqual(["fixture-bot"]);
    await running.post("/api/fixture/workflow/inbound", { text: "微信第三条" });
    const restored = await running.until((s) => s.codex.transcript.filter((e) => e.role === "assistant" && e.text === "这是 fixture Codex 回复。").length === 4);
    expect(restored.codex.transcript.filter((e) => e.role === "user").map((e) => e.text)).toEqual(["微信第一条", reminderCommand, "飞书第二条", "微信第三条"]);
    expect(restored.codex.transcript.filter((e) => e.role === "assistant").slice(-2).map((e) => e.text)).toEqual(["已收到，正在处理。", "这是 fixture Codex 回复。"]);
    expect(restored.codex.permissions).toEqual(savedPermissions);
    const delivered = await running.until((state) => state.fixtureTextOutbox?.some((item) => item.message === "切换后提醒。") === true);
    expect(delivered.fixtureTextOutbox?.filter((item) => item.message === "切换后提醒。")).toHaveLength(1);
    console.log(JSON.stringify({ kind: "channel_restart_transcript", feishuOutbox: notification.fixtureTextOutbox, transcript: restored.codex.transcript.map(({ role, text, target }) => ({ role, text, target })), runs: restored.codex.runs.map(({ phase, target }) => ({ phase, target })) }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);

it("contains a group runtime startup failure while private and other group conversations remain usable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "group-startup-failure-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const personal = config("weixin");
    const configuration = { ...personal, channel: undefined, enabledChannels: ["weixin", "feishu"],
      feishu: { ...personal.feishu, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_alice"] }] } };
    writeFileSync(join(directory, "channel.json"), JSON.stringify(configuration));
    const feishu = parseChannelStartupConfiguration(configuration).entries.find((entry) => entry.channel === "feishu")!;
    const alpha = feishu.owner.conversationAddresses()[1]!;
    const blocked = join(directory, "group-model-runtimes", alpha.target);
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "workspace"), "synthetic runtime path conflict");
    for (const attempt of [1, 2]) {
      running = await start(directory);
      await running.until((state) => state.channels?.feishu?.ready === true);
      for (const chatId of ["oc_private", "oc_beta", "oc_alpha"]) {
        const group = chatId !== "oc_private";
        await running.post("/api/fixture/feishu/inbound", { event: { app_id: "cli_0123456789abcdef",
          sender: { sender_type: "user", sender_id: { open_id: group ? "ou_alice" : "ou_owner" } },
          message: { message_id: `om_failure_${attempt}_${chatId}`, create_time: String(Date.now()), chat_id: chatId,
            chat_type: group ? "group" : "p2p", message_type: "text", content: JSON.stringify({ text: group ? "@_user_1 hello" : "hello" }),
            ...(group ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_fixturebot" }, name: "Agent" }] } : {}) } } });
      }
      const state = await running.until((value) => value.feishuFixtureTextOutbox?.length === 3);
      expect(state.feishuFixtureTextOutbox).toEqual([
        expect.objectContaining({ chatId: "oc_private", message: "这是 fixture Codex 回复。" }),
        expect.objectContaining({ chatId: "oc_beta", message: "这是 fixture Codex 回复。" }),
        expect.objectContaining({ chatId: "oc_alpha", message: "我暂时无法处理这条消息，请稍后再发一条新消息。" }),
      ]);
      expect(state.fixtureModelRequests).toHaveLength(2);
      await running.close(); running = undefined;
    }
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);

it("delivers an inbound Feishu image through the shared media workflow", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-media-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("feishu")));
    running = await start(directory);
    await running.post("/api/fixture/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_image", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "image", content: '{"image_key":"img_fixture"}' } },
      resources: [{ messageId: "om_image", resourceKey: "img_fixture", type: "image", contentType: "image/png", bytesBase64: png }],
      modelToolCalls: [{ namespace: "media", tool: "send", arguments: { kind: "image", source: "current" } }],
    });
    const result = await running.until((state) => state.workflows?.runs.some((run) => run.workflowId === "media.send-image-one-message" && run.status === "succeeded") === true &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text === "图片已发送，请查收。");
    expect(result.fixtureTextOutbox?.map((item) => item.message)).toEqual(["图片已发送，请查收。"]);
    expect(result.fixtureMediaOutbox).toEqual([expect.objectContaining({ chatId: "oc_private", kind: "image", bytesBase64: png })]);
    expect(result.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text).toBe("图片已发送，请查收。");
    console.log(JSON.stringify({ kind: "feishu_media_transcript", command: "发送当前图片（模型 fixture 调用 media.send current）", transcript: result.codex.transcript, runs: result.workflows?.runs, outbox: result.fixtureMediaOutbox }));
    await running.post("/api/fixture/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_quote", parent_id: "om_image", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"把引用的图片发给我"}' } },
      modelToolCalls: [{ namespace: "media", tool: "send", arguments: { kind: "image", source: "referenced" } }],
    });
    const quoted = await running.until((state) => state.codex.transcript.filter((entry) => entry.role === "assistant" && entry.text === "图片已发送，请查收。").length === 2);
    expect(quoted.fixtureMediaOutbox).toHaveLength(2);
    expect(quoted.fixtureMediaOutbox?.[1]).toMatchObject({ chatId: "oc_private", kind: "image", bytesBase64: png });
    expect(quoted.workflows?.runs.filter((run) => run.workflowId === "media.send-image-one-message" && run.status === "succeeded")).toHaveLength(2);
    console.log(JSON.stringify({ kind: "feishu_media_quote_transcript", command: "把引用的图片发给我", transcript: quoted.codex.transcript, runs: quoted.workflows?.runs, outbox: quoted.fixtureMediaOutbox }));
    await running.post("/api/fixture/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_recent", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"再发一下刚才的图片"}' } },
      modelToolCalls: [{ namespace: "media", tool: "send", arguments: { kind: "image", source: "recent" } }],
    });
    const recent = await running.until((state) => state.codex.transcript.filter((entry) => entry.role === "assistant" && entry.text === "图片已发送，请查收。").length === 3);
    expect(recent.fixtureMediaOutbox).toHaveLength(3);
    expect(recent.fixtureMediaOutbox?.[2]).toMatchObject({ chatId: "oc_private", kind: "image", bytesBase64: png });
    expect(recent.workflows?.runs.filter((run) => run.workflowId === "media.send-image-one-message" && run.status === "succeeded")).toHaveLength(3);
    console.log(JSON.stringify({ kind: "feishu_media_recent_transcript", command: "再发一下刚才的图片", transcript: recent.codex.transcript, runs: recent.workflows?.runs, outbox: recent.fixtureMediaOutbox }));
    const sendPost = (id: string) => running!.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "post",
          content: JSON.stringify({ title: "", content: [[{ tag: "img", image_key: "img_one" }], [{ tag: "img", image_key: "img_two" }]] }) } },
      resources: [{ messageId: id, resourceKey: "img_one", type: "image", contentType: "image/png", bytesBase64: png },
        { messageId: id, resourceKey: "img_two", type: "image", contentType: "image/png", bytesBase64: Buffer.from("second image").toString("base64") }],
      modelToolCalls: [{ namespace: "media", tool: "send", arguments: { kind: "image", source: "current" } }],
    });
    const answer = (id: string, text: string) => running!.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
    });
    await sendPost("om_multi");
    const waiting = await running.until((state) => state.workflows?.runs.some((run) => run.status === "needs_input") === true &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text.includes("2.") === true);
    const pending = waiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    expect(pending.effects).toEqual([]);
    expect(waiting.fixtureMediaOutbox).toHaveLength(3);
    await answer("om_select_image", "2");
    const selected = await running.until((state) => state.workflows?.runs.find((run) => run.runRef === pending.runRef)?.status === "succeeded" &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text === "图片已发送，请查收。");
    expect(selected.fixtureMediaOutbox).toHaveLength(4);
    expect(selected.fixtureMediaOutbox?.[3]).toMatchObject({ chatId: "oc_private", kind: "image", bytesBase64: Buffer.from("second image").toString("base64") });
    console.log(JSON.stringify({ kind: "feishu_multi_image_selection", commands: ["两张图片，无文字；模型选择 media.send current", "2"], pending, transcript: selected.codex.transcript, runs: selected.workflows?.runs, outbox: selected.fixtureMediaOutbox }));
    await sendPost("om_cancel_multi");
    const cancelWaiting = await running.until((state) => state.workflows?.runs.some((run) => run.status === "needs_input") === true &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text.includes("2.") === true);
    const cancelRun = cancelWaiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    await answer("om_cancel_answer", "取消");
    const cancelled = await running.until((state) => state.workflows?.runs.find((run) => run.runRef === cancelRun.runRef)?.status === "cancelled" &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text === "已取消之前的操作。");
    expect(cancelled.fixtureMediaOutbox).toEqual(selected.fixtureMediaOutbox);
    expect(cancelled.workflows?.runs.find((run) => run.runRef === cancelRun.runRef)?.effects).toEqual([]);
    console.log(JSON.stringify({ kind: "feishu_multi_image_cancel", commands: ["两张图片，无文字；模型选择 media.send current", "取消"], transcript: cancelled.codex.transcript, runs: cancelled.workflows?.runs, outbox: cancelled.fixtureMediaOutbox }));

  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it.each(["missing", "invalid"])("fails before opening a channel for %s startup configuration", async (kind) => {
  const directory = mkdtempSync(join(tmpdir(), "channel-invalid-"));
  const configPath = join(directory, "channel.json");
  if (kind === "invalid") writeFileSync(configPath, JSON.stringify({ ...config("feishu"), channel: "unsupported" }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEMO_MODE: "fixture", CHANNEL_CONFIG_PATH: configPath, WORKFLOW_FIXTURE_STATE_DIRECTORY: directory, WEIXIN_OTEL_ENABLED: "0" },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("invalid startup did not exit")); }, 10000);
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    expect(code).not.toBe(0);
    expect(output).toContain(kind === "missing" ? "channel_startup_configuration_unreadable" : "channel_startup_configuration_invalid");
    expect(output).not.toContain("fixture-secret");
    expect(output).not.toContain("http://127.0.0.1");
  } finally { await stop(child); rmSync(directory, { recursive: true, force: true }); }
}, 15000);

it.each(["WORKFLOW_FIXTURE_COORDINATION_RUNTIME", "WORKFLOW_FIXTURE_COMPACTION_HOLD"])("refuses to start with the fixture switch %s outside fixture mode", async (fixtureSwitch) => {
  const directory = mkdtempSync(join(tmpdir(), "channel-fixture-switch-"));
  const production = { ...process.env };
  delete production.DEMO_MODE;
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: { ...production, [fixtureSwitch]: "1", HOME: directory, CHANNEL_CONFIG_PATH: join(directory, "channel.json"), WEIXIN_OTEL_ENABLED: "0" },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("refused startup did not exit")); }, 10000);
      child.once("close", (exit) => { clearTimeout(timer); resolve(exit); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    expect(code).not.toBe(0);
    expect(output).toContain("fixture_switch_outside_fixture_mode");
    expect(output).not.toContain("http://127.0.0.1");
    expect(readdirSync(directory)).toEqual([]);
  } finally { await stop(child); rmSync(directory, { recursive: true, force: true }); }
}, 15000);

it("resumes the original Feishu file-choice workflow after restart and sends only the selected file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-file-choice-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const sendText = (id: string, text: string, modelToolCalls?: unknown[]) => running!.post("/api/fixture/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
    ...(modelToolCalls ? { modelToolCalls } : {}),
  });
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    running = await start(directory);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    expect(notes.scopes.length).toBeGreaterThan(0);
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: false })) });
    await running.close();
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("feishu")));
    running = await start(directory);
    await sendText("om_choose_files", "把 Agent 笔记原文件列出来让我选，暂时不要发送", [
      { namespace: "files", tool: "find", arguments: { query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
    ]);
    const waiting = await running.until((state) => state.workflows?.runs.some((run) => run.status === "needs_input") === true &&
      state.codex.transcript.some((entry) => entry.role === "assistant" && entry.text.includes("Agent Beta.md")));
    const pending = waiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    expect(pending.effects).toEqual([]); expect(waiting.fixtureMediaOutbox).toEqual([]);
    await running.close(); running = await start(directory);
    const restored = await running.state();
    expect(restored.workflows?.runs.find((run) => run.runRef === pending.runRef)).toEqual(pending);
    expect(restored.fixtureMediaOutbox).toEqual([]);
    await sendText("om_select_file", "2");
    const sent = await running.until((state) => state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text === "文件已发送，请查收。");
    expect(sent.workflows?.runs).toHaveLength(waiting.workflows!.runs.length);
    expect(sent.workflows?.runs.find((run) => run.runRef === pending.runRef)).toMatchObject({ status: "succeeded", effects: [{ stepId: "send#1", state: "accepted" }] });
    expect(sent.fixtureMediaOutbox).toEqual([expect.objectContaining({ chatId: "oc_private", kind: "file", fileName: "Agent Beta.md", bytesBase64: Buffer.from("# Agent Beta\n").toString("base64") })]);
    console.log(JSON.stringify({ kind: "feishu_file_choice_transcript", commands: ["把 Agent 笔记原文件列出来让我选，暂时不要发送", "2"], pending, restored: restored.workflows?.runs, transcript: sent.codex.transcript, runs: sent.workflows?.runs, outbox: sent.fixtureMediaOutbox }));
    await sendText("om_local_image", "把相册里的 holiday 图片发给我", [
      { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "Pictures" }], query: "holiday", include: ["*.png"], limit: 1 } },
      { namespace: "media", tool: "send", arguments: { kind: "image", source: "local", disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } }] } },
    ]);
    const local = await running.until((state) => state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text === "图片已发送，请查收。");
    expect(local.fixtureMediaOutbox).toHaveLength(2);
    expect(local.fixtureMediaOutbox?.[1]).toMatchObject({ chatId: "oc_private", kind: "image", fileName: "holiday.png", bytesBase64: Buffer.from("fixture image").toString("base64") });
    expect(local.workflows?.runs.filter((run) => run.workflowId === "weixin.send-local-images" && run.status === "succeeded")).toHaveLength(1);
    console.log(JSON.stringify({ kind: "feishu_local_image_transcript", command: "把相册里的 holiday 图片发给我", transcript: local.codex.transcript, runs: local.workflows?.runs, outbox: local.fixtureMediaOutbox }));
    await sendText("om_revoke_choice", "再把 Agent 笔记列出来让我选", [
      { namespace: "files", tool: "find", arguments: { query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
    ]);
    const revokeWaiting = await running.until((state) => state.workflows?.runs.some((run) => run.status === "needs_input") === true &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text.includes("Agent Beta.md") === true);
    const revokeRun = revokeWaiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    await running.close();
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    running = await start(directory);
    const granted = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: granted.revision, confirmed: true,
      scopes: granted.scopes.map((scope) => ({ scopeId: scope.scopeId, read: false, write: false })) });
    await running.close();
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("feishu")));
    running = await start(directory);
    await sendText("om_revoked_select", "2");
    const revoked = await running.until((state) => state.workflows?.runs.find((run) => run.runRef === revokeRun.runRef)?.status === "failed" &&
      state.codex.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text === "没有读取这个文件的权限，请在“本地权限”中启用后重试。");
    expect(revoked.fixtureMediaOutbox).toEqual([]);
    expect(revoked.workflows?.runs.find((run) => run.runRef === revokeRun.runRef)?.effects).toEqual([]);
    console.log(JSON.stringify({ kind: "feishu_revoked_choice", commands: ["再把 Agent 笔记列出来让我选", "停服务切回微信，撤销笔记读取权限，再切回飞书", "2"], pending: revokeRun, transcript: revoked.codex.transcript, runs: revoked.workflows?.runs, outbox: revoked.fixtureMediaOutbox }));

  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("accepts both private channels in one core and keeps ordinary replies in their source chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-dual-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...config("weixin"), channel: undefined, enabledChannels: ["weixin", "feishu"] }));
    running = await start(directory);
    await running.until((s) => s.channels?.weixin?.ready === true && s.channels?.feishu?.ready === true);
    await running.post("/api/fixture/workflow/inbound", { text: "微信独立消息" });
    await running.post("/api/fixture/feishu/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_dual", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"飞书独立消息"}' } } });
    const result = await running.until((s) => s.codex.runs.filter((run) => run.phase === "completed").length === 2);
    expect(result.codex.enabledTargets).toHaveLength(2);
    expect(result.weixinFixtureReplies?.map((item) => item.message)).toEqual(["已收到，正在处理。", "这是 fixture Codex 回复。"]);
    expect(result.feishuFixtureTextOutbox?.map((item) => item.message)).toEqual(["这是 fixture Codex 回复。"]);
    const messages = result.codex.transcript.filter((entry) => entry.role === "user");
    expect(messages.map((entry) => entry.text)).toEqual(["微信独立消息", "飞书独立消息"]);
    expect(messages[0]!.target).not.toBe(messages[1]!.target);
    console.log(JSON.stringify({ kind: "dual_channel_text", commands: messages.map(({ text, target }) => ({ text, target })), runs: result.codex.runs,
      weixinOutbox: result.weixinFixtureReplies, feishuOutbox: result.feishuFixtureTextOutbox, channels: result.channels }));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
    await running.post("/api/fixture/feishu/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_dual_image", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "image", content: '{"image_key":"img_dual"}' } },
      resources: [{ messageId: "om_dual_image", resourceKey: "img_dual", type: "image", contentType: "image/png", bytesBase64: png }],
      modelToolCalls: [{ namespace: "media", tool: "send", arguments: { kind: "image", source: "current" } }],
    });
    const fsImage = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message === "图片已发送，请查收。");
    expect(fsImage.feishuFixtureMediaOutbox).toEqual([expect.objectContaining({ chatId: "oc_private", kind: "image", bytesBase64: png })]);
    expect(fsImage.fixtureOutbox).toEqual([]);
    await running.post("/api/fixture/workflow/inbound", { text: "把相册里的 holiday 图片发给我", modelToolCalls: [
      { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "Pictures" }], query: "holiday", include: ["*.png"], limit: 1 } },
      { namespace: "media", tool: "send", arguments: { kind: "image", source: "local", disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } }] } },
    ] });
    const wxImage = await running.until((s) => s.weixinFixtureReplies?.at(-1)?.message === "图片已发送，请查收。");
    expect(wxImage.fixtureOutbox).toEqual([expect.objectContaining({ kind: "image", fileName: "holiday.png" })]);
    expect(wxImage.feishuFixtureMediaOutbox).toEqual(fsImage.feishuFixtureMediaOutbox);
    expect(wxImage.workflows?.runs).toHaveLength(result.workflows!.runs.length + 2);
    expect(wxImage.workflows?.runs.filter((run) => ["media.send-image-one-message", "weixin.send-local-images"].includes(run.workflowId))
      .map((run) => ({ workflowId: run.workflowId, status: run.status }))).toEqual(expect.arrayContaining([
        { workflowId: "media.send-image-one-message", status: "succeeded" }, { workflowId: "weixin.send-local-images", status: "succeeded" },
      ]));
    console.log(JSON.stringify({ kind: "dual_channel_media", runs: wxImage.workflows?.runs, weixinReplies: wxImage.weixinFixtureReplies,
      weixinOutbox: wxImage.fixtureOutbox, feishuOutbox: wxImage.feishuFixtureMediaOutbox }));

  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("keeps Weixin working through Feishu startup failure and later transport disconnection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-failure-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...config("weixin"), channel: undefined, enabledChannels: ["weixin", "feishu"] }));
    running = await start(directory, { WORKFLOW_FIXTURE_FEISHU_START_FAILURE: "1" });
    await running.post("/api/fixture/workflow/inbound", { text: "飞书启动失败时微信继续" });
    const first = await running.until((s) => s.weixinFixtureReplies?.at(-1)?.message === "这是 fixture Codex 回复。");
    expect(first.channels).toEqual({ weixin: { enabled: true, ready: true }, feishu: { enabled: true, ready: false } });
    expect(first.feishuFixtureTextOutbox).toEqual([]);
    await running.close();
    running = await start(directory);
    await running.until((s) => s.channels?.feishu?.ready === true);
    await running.post("/api/fixture/feishu/inbound", { connection: "unavailable" });
    await running.post("/api/fixture/workflow/inbound", { text: "飞书掉线时微信继续" });
    const disconnected = await running.until((s) => s.weixinFixtureReplies?.at(-1)?.message === "这是 fixture Codex 回复。");
    expect(disconnected.channels).toEqual({ weixin: { enabled: true, ready: true }, feishu: { enabled: true, ready: false } });
    expect(disconnected.feishuFixtureTextOutbox).toEqual([]);
    await running.post("/api/fixture/feishu/inbound", { connection: "ready" });
    await running.post("/api/fixture/feishu/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_recovered", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"飞书恢复后回复"}' } } });
    const recovered = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message === "这是 fixture Codex 回复。");
    expect(recovered.channels).toEqual({ weixin: { enabled: true, ready: true }, feishu: { enabled: true, ready: true } });
    expect(recovered.weixinFixtureReplies).toEqual(disconnected.weixinFixtureReplies);
    expect(recovered.feishuFixtureTextOutbox).toHaveLength(1);
    console.log(JSON.stringify({ kind: "dual_channel_failure_recovery", failed: first.channels, disconnected: disconnected.channels,
      recovered: recovered.channels, weixinReplies: recovered.weixinFixtureReplies, feishuOutbox: recovered.feishuFixtureTextOutbox }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("keeps Feishu available when the configured Weixin connection fails at startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-weixin-failure-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...config("weixin"), channel: undefined, enabledChannels: ["weixin", "feishu"] }));
    running = await start(directory, { WORKFLOW_FIXTURE_WEIXIN_START_FAILURE: "1" });
    await running.post("/api/fixture/feishu/inbound", { event: { app_id: "cli_0123456789abcdef",
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: "om_weixin_failed", create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: '{"text":"微信连接失败时飞书继续"}' } } });
    const result = await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    expect(result.channels).toEqual({ weixin: { enabled: true, ready: false }, feishu: { enabled: true, ready: true } });
    expect(result.feishuFixtureTextOutbox?.map((item) => item.message)).toEqual(["这是 fixture Codex 回复。"]);
    expect(result.weixinFixtureReplies).toEqual([]);
    expect(result.codex.enabledTargets).toHaveLength(1);
    console.log(JSON.stringify({ kind: "dual_weixin_startup_failure", channels: result.channels, feishuOutbox: result.feishuFixtureTextOutbox, weixinReplies: result.weixinFixtureReplies }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("shares curated memory while keeping model inputs and resumed threads separate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-memory-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const sendFeishu = (id: string, text: string) => running!.post("/api/fixture/feishu/inbound", { event: {
    app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) },
  } });
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...config("weixin"), channel: undefined, enabledChannels: ["weixin", "feishu"] }));
    running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    await running.post("/api/codex/memory/enable", { accountId: "fixture-bot" });
    await running.post("/api/fixture/workflow/inbound", { text: "WX_PRIVATE_MARKER。我喜欢低糖乌龙茶。" });
    const first = await running.until((state) => state.weixinFixtureReplies?.at(-1)?.message === "这是 fixture Codex 回复。");
    const evidence = first.codex.transcript.find((entry) => entry.role === "user" && entry.text.includes("WX_PRIVATE_MARKER"))!;
    expect(evidence.target).toBe("fixture-user@im.wechat");
    const memory = new AccountMemoryStore(join(directory, "memory"));
    const curator = new AccountMemoryToolHost(memory);
    expect(await curator.commit({ accountId: "fixture-bot", jobId: "curator-fixture", batchId: "curator-fixture",
      mutationPolicy: { mode: "free_add" }, evidenceEntryIds: [evidence.id], evidenceTexts: { [evidence.id]: evidence.text },
      evidenceOrigins: { [evidence.id]: { eventKey: evidence.id, target: evidence.target } },
    }, { batchId: "curator-fixture", basedOnRevision: memory.read("fixture-bot").revision, decisions: [
      { kind: "remember", category: "preferences", value: "喜欢低糖乌龙茶。", evidenceEntryIds: [evidence.id], confidence: 1 },
    ] })).toMatchObject({ status: "committed", receipt: { added: 1 } });
    await sendFeishu("om_memory", "FS_PRIVATE_MARKER。我的饮品偏好是什么？");
    const fsReply = await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    expect(fsReply.fixtureModelRequests).toHaveLength(2);
    const fsRequest = fsReply.fixtureModelRequests![1]!;
    expect(JSON.stringify(fsRequest.input)).toContain("喜欢低糖乌龙茶");
    expect(JSON.stringify(fsRequest.input)).toContain("FS_PRIVATE_MARKER");
    expect(JSON.stringify(fsRequest.input)).not.toContain("WX_PRIVATE_MARKER");
    await running.post("/api/fixture/workflow/inbound", { text: "WX_SECOND_MARKER。记得我的偏好吗？" });
    const wxReply = await running.until((state) => state.weixinFixtureReplies?.length === 4);
    expect(wxReply.fixtureModelRequests).toHaveLength(3);
    const wxRequest = wxReply.fixtureModelRequests![2]!;
    expect(JSON.stringify(wxRequest.input)).toContain("喜欢低糖乌龙茶");
    expect(JSON.stringify(wxRequest.input)).not.toContain("FS_PRIVATE_MARKER");
    expect(wxRequest.threadId).toBe(first.fixtureModelRequests![0]!.threadId);
    expect(wxRequest.threadId).not.toBe(fsRequest.threadId);
    await running.close(); running = await start(directory);
    const ready = await running.until((state) => state.channels?.weixin?.ready === true && state.channels?.feishu?.ready === true);
    expect(ready.codex.threadReady).toBe(true);
    expect(ready.codex.status).toBe("idle");
    await sendFeishu("om_memory_restart", "FS_AFTER_RESTART。我的饮品偏好是什么？");
    await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    await running.post("/api/fixture/workflow/inbound", { text: "WX_AFTER_RESTART。记得我的偏好吗？" });
    const restored = await running.until((state) => state.weixinFixtureReplies?.length === 2);
    expect(restored.fixtureModelRequests).toHaveLength(2);
    expect(restored.fixtureModelRequests!.map((request) => request.threadId)).toEqual([fsRequest.threadId, wxRequest.threadId]);
    expect(JSON.stringify(restored.fixtureModelRequests![0]!.input)).toContain("喜欢低糖乌龙茶");
    expect(JSON.stringify(restored.fixtureModelRequests![0]!.input)).not.toContain("WX_PRIVATE_MARKER");
    expect(JSON.stringify(restored.fixtureModelRequests![1]!.input)).not.toContain("FS_PRIVATE_MARKER");
    expect(memory.read("fixture-bot").entries).toHaveLength(1);
    console.log(JSON.stringify({ kind: "dual_memory_context", sourceEntry: evidence.id, memory: memory.read("fixture-bot").entries,
      originalThreads: [wxRequest.threadId, fsRequest.threadId], restoredRequests: restored.fixtureModelRequests }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("resumes two independent pending choices and resolves only the responding chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-dual-pending-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const tools = [
    { namespace: "files", tool: "find", arguments: { query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
    { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
      candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
  ];
  const sendFeishu = (id: string, text: string, modelToolCalls?: unknown[]) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
    ...(modelToolCalls ? { modelToolCalls } : {}),
  });
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...config("weixin"), channel: undefined, enabledChannels: ["weixin", "feishu"] }));
    running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    await running.post("/api/fixture/workflow/inbound", { text: "微信：列出 Agent 笔记让我选", modelToolCalls: tools });
    const wxWaiting = await running.until((state) => state.weixinFixtureReplies?.at(-1)?.message.includes("Agent Beta.md") === true);
    const wxRun = wxWaiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    expect(wxRun.effects).toEqual([]);
    await sendFeishu("om_pending", "飞书：列出 Agent 笔记让我选", tools);
    const bothWaiting = await running.until((state) => state.feishuFixtureTextOutbox?.at(-1)?.message.includes("Agent Beta.md") === true);
    const fsRun = bothWaiting.workflows!.runs.find((run) => run.status === "needs_input" && run.runRef !== wxRun.runRef)!;
    expect(fsRun.effects).toEqual([]);
    expect(bothWaiting.workflows!.runs.filter((run) => run.status === "needs_input")).toHaveLength(2);
    await running.close(); running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    expect((await running.state()).workflows?.runs.filter((run) => run.status === "needs_input").map((run) => run.runRef).sort())
      .toEqual([wxRun.runRef, fsRun.runRef].sort());
    await sendFeishu("om_select_pending", "2");
    const selected = await running.until((state) => state.feishuFixtureTextOutbox?.at(-1)?.message === "文件已发送，请查收。");
    expect(selected.workflows?.runs.find((run) => run.runRef === fsRun.runRef)).toMatchObject({ status: "succeeded", effects: [{ stepId: "send#1", state: "accepted" }] });
    expect(selected.workflows?.runs.find((run) => run.runRef === wxRun.runRef)).toMatchObject({ status: "needs_input", effects: [] });
    expect(selected.fixtureOutbox).toEqual([]);
    expect(selected.feishuFixtureMediaOutbox).toEqual([expect.objectContaining({ chatId: "oc_private", kind: "file", fileName: "Agent Beta.md", bytesBase64: Buffer.from("# Agent Beta\n").toString("base64") })]);
    await running.post("/api/fixture/workflow/inbound", { text: "取消" });
    const cancelled = await running.until((state) => state.weixinFixtureReplies?.at(-1)?.message === "已取消之前的操作。");
    expect(cancelled.workflows?.runs).toHaveLength(bothWaiting.workflows!.runs.length);
    expect(cancelled.workflows?.runs.find((run) => run.runRef === wxRun.runRef)).toMatchObject({ status: "cancelled", effects: [] });
    expect(cancelled.workflows?.runs.find((run) => run.runRef === fsRun.runRef)).toEqual(selected.workflows?.runs.find((run) => run.runRef === fsRun.runRef));
    expect(cancelled.fixtureOutbox).toEqual([]);
    expect(cancelled.feishuFixtureMediaOutbox).toEqual(selected.feishuFixtureMediaOutbox);
    console.log(JSON.stringify({ kind: "dual_pending_recovery", commands: ["微信：列出 Agent 笔记让我选", "飞书：列出 Agent 笔记让我选", "飞书：2", "微信：取消"],
      originalRuns: [wxRun, fsRun], finalRuns: cancelled.workflows?.runs, weixinReplies: cancelled.weixinFixtureReplies, feishuReplies: cancelled.feishuFixtureTextOutbox, outbox: cancelled.feishuFixtureMediaOutbox }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("delivers both scheduled reminders only to their creation channels and does not replay on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-dual-schedules-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const sendFeishu = (id: string, text: string, modelToolCalls?: unknown[]) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_private", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
    ...(modelToolCalls ? { modelToolCalls } : {}),
  });
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...config("weixin"), channel: undefined, enabledChannels: ["weixin", "feishu"] }));
    running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const at = new Date(Date.now() + 5000).toISOString();
    const create = (name: string, reminderText: string, sourceText: string) => [{ namespace: "schedules", tool: "create", arguments: {
      name, instruction: reminderText, reminderText, reminderMode: "verbatim", at, sourceText,
    } }];
    const wxCommand = "稍后提醒我，原文：微信独立提醒";
    const fsCommand = "稍后提醒我，原文：飞书独立提醒";
    await running.post("/api/fixture/workflow/inbound", { text: wxCommand, modelToolCalls: create("微信任务", "微信独立提醒", wxCommand) });
    await sendFeishu("om_schedule", fsCommand, create("飞书任务", "飞书独立提醒", fsCommand));
    const delivered = await running.until((state) => state.fixtureTextOutbox?.some((item) => item.message === "微信独立提醒") === true &&
      state.feishuFixtureTextOutbox?.some((item) => item.message === "飞书独立提醒") === true, 15000);
    expect(delivered.fixtureTextOutbox?.filter((item) => item.message === "微信独立提醒")).toHaveLength(1);
    expect(delivered.feishuFixtureTextOutbox?.filter((item) => item.message === "飞书独立提醒")).toHaveLength(1);
    expect(delivered.fixtureTextOutbox?.some((item) => item.message === "飞书独立提醒")).toBe(false);
    expect(delivered.feishuFixtureTextOutbox?.some((item) => item.message === "微信独立提醒")).toBe(false);
    await running.close(); running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    await running.post("/api/fixture/workflow/inbound", { text: "微信重启后继续" });
    await sendFeishu("om_schedule_restart", "飞书重启后继续");
    const restored = await running.until((state) => state.feishuFixtureTextOutbox?.some((item) => item.message === "这是 fixture Codex 回复。") === true);
    expect(restored.fixtureTextOutbox).toEqual([]);
    expect(restored.feishuFixtureTextOutbox?.map((item) => item.message)).toEqual(["这是 fixture Codex 回复。"]);
    console.log(JSON.stringify({ kind: "dual_scheduled_delivery", commands: [wxCommand, fsCommand], weixinOutbox: delivered.fixtureTextOutbox,
      feishuOutbox: delivered.feishuFixtureTextOutbox, afterRestart: { weixin: restored.fixtureTextOutbox, feishu: restored.feishuFixtureTextOutbox } }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("shares only group discussion, binds choices to the requester and delivers group reminders after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-groups-main-"));
  const business = mkdtempSync(join(tmpdir(), "channel-groups-business-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, sender: string, chat: string, text: string, mentioned = true, modelToolCalls?: unknown[]) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: chat, chat_type: "group", message_type: "text",
        mentions: mentioned ? [{ key: "@_user_1", id: { open_id: "ou_fixturebot" }, name: "Agent" }] : [],
        content: JSON.stringify({ text: mentioned ? `@_user_1 ${text}` : text }) } },
    ...(modelToolCalls ? { modelToolCalls } : {}),
  });
  const tools = [
    { namespace: "files", tool: "find", arguments: { query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
    { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
      candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
  ];
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  try {
    const configuration = config("weixin");
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...configuration, channel: undefined, enabledChannels: ["weixin", "feishu"],
      feishu: { ...configuration.feishu, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice", "ou_bob"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_alice"] }] } }));
    running = await start(directory, env);
    await running.until((s) => s.channels?.feishu?.ready === true && s.codex.enabledTargets.length === 4);
    await running.post("/api/fixture/workflow/inbound", { text: "PRIVATE_SENTINEL。我喜欢低糖乌龙茶。" });
    const privateReply = await running.until((s) => s.weixinFixtureReplies?.length === 2);
    const evidence = privateReply.codex.transcript.find((entry) => entry.role === "user" && entry.text.startsWith("PRIVATE_SENTINEL"))!;
    const memory = new AccountMemoryStore(join(directory, "memory"));
    const curator = new AccountMemoryToolHost(memory);
    expect(await curator.commit({ accountId: "fixture-bot", jobId: "group-private-seed", batchId: "group-private-seed", mutationPolicy: { mode: "free_add" },
      evidenceEntryIds: [evidence.id], evidenceTexts: { [evidence.id]: evidence.text }, evidenceOrigins: { [evidence.id]: { eventKey: evidence.id, target: evidence.target } } },
    { batchId: "group-private-seed", basedOnRevision: memory.read("fixture-bot").revision,
      decisions: [{ kind: "remember", category: "preferences", value: "PRIVATE_MEMORY_喜欢低糖乌龙茶。", evidenceEntryIds: [evidence.id], confidence: 1 }] })).toMatchObject({ status: "committed" });
    await send("om_guest_history", "ou_guest", "oc_alpha", "GUEST_DISCUSSION_MARKER", false);
    await send("om_guest_call", "ou_guest", "oc_alpha", "UNAUTHORIZED_INVOCATION");
    await send("om_foreign_call", "ou_alice", "oc_other", "FOREIGN_GROUP_MARKER");
    expect((await running.state()).fixtureModelRequests).toHaveLength(1);
    await send("om_alice_context", "ou_alice", "oc_alpha", "ALPHA_QUESTION");
    const alpha = await running.until((s) => s.feishuFixtureTextOutbox?.length === 1);
    const alphaRequest = alpha.fixtureModelRequests!.at(-1)!;
    expect(JSON.stringify(alphaRequest.input)).toContain("GUEST_DISCUSSION_MARKER");
    expect(JSON.stringify(alphaRequest.input)).toContain("ou_guest");
    expect(JSON.stringify(alphaRequest.input)).not.toContain("PRIVATE_MEMORY_");
    expect(JSON.stringify(alphaRequest.input)).not.toContain("PRIVATE_SENTINEL");
    await send("om_bob_context", "ou_bob", "oc_alpha", "BOB_CONTINUES");
    const bob = await running.until((s) => s.feishuFixtureTextOutbox?.length === 2);
    expect(bob.fixtureModelRequests!.at(-1)!.threadId).toBe(alphaRequest.threadId);
    await send("om_beta_context", "ou_alice", "oc_beta", "BETA_QUESTION");
    const beta = await running.until((s) => s.feishuFixtureTextOutbox?.length === 3);
    const betaRequest = beta.fixtureModelRequests!.at(-1)!;
    expect(betaRequest.threadId).not.toBe(alphaRequest.threadId);
    expect(JSON.stringify(betaRequest.input)).not.toContain("GUEST_DISCUSSION_MARKER");
    expect(JSON.stringify(betaRequest.input)).not.toContain("ALPHA_QUESTION");
    await send("om_empty_mention", "ou_alice", "oc_alpha", "");
    const empty = await running.until((s) => s.feishuFixtureTextOutbox?.length === 4);
    expect(empty.codex.runs.at(-1)?.phase).toBe("completed");

    await send("om_alice_files", "ou_alice", "oc_alpha", "把 Agent 笔记列出来让我选", true, tools);
    const aliceWaiting = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message.includes("Agent Beta.md") === true);
    const aliceRun = aliceWaiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    expect(aliceRun.effects).toEqual([]);
    await send("om_bob_wrong_choice", "ou_bob", "oc_alpha", "2");
    const unrelated = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message === "这是 fixture Codex 回复。");
    expect(unrelated.workflows?.runs.find((run) => run.runRef === aliceRun.runRef)).toMatchObject({ status: "needs_input", effects: [] });
    expect(unrelated.feishuFixtureMediaOutbox).toEqual([]);
    await send("om_bob_files", "ou_bob", "oc_alpha", "把 Agent 笔记列出来让我选", true, tools);
    const both = await running.until((s) => s.workflows?.runs.filter((run) => run.status === "needs_input").length === 2 && s.feishuFixtureTextOutbox?.at(-1)?.message.includes("Agent Beta.md") === true);
    const bobRun = both.workflows!.runs.find((run) => run.status === "needs_input" && run.runRef !== aliceRun.runRef)!;
    await running.close(); running = await start(directory, env);
    await running.until((s) => s.channels?.feishu?.ready === true);
    await send("om_guest_selection", "ou_guest", "oc_alpha", "1");
    expect((await running.state()).feishuFixtureMediaOutbox).toEqual([]);
    await send("om_alice_selection", "ou_alice", "oc_alpha", "2");
    const sent = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message === "文件已发送，请查收。");
    expect(sent.workflows?.runs.find((run) => run.runRef === aliceRun.runRef)).toMatchObject({ status: "succeeded", effects: [{ state: "accepted" }] });
    expect(sent.workflows?.runs.find((run) => run.runRef === bobRun.runRef)).toMatchObject({ status: "needs_input", effects: [] });
    expect(sent.feishuFixtureMediaOutbox).toEqual([expect.objectContaining({ chatId: "oc_alpha", kind: "file", fileName: "Agent Beta.md", bytesBase64: Buffer.from("# Agent Beta\n").toString("base64") })]);
    await send("om_bob_cancel", "ou_bob", "oc_alpha", "取消");
    const cancelled = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message === "已取消之前的操作。");
    expect(cancelled.workflows?.runs.find((run) => run.runRef === bobRun.runRef)).toMatchObject({ status: "cancelled", effects: [] });
    const at = new Date(Date.now() + 4000).toISOString();
    const command = "稍后提醒本群，原文：群独立提醒";
    await send("om_group_schedule", "ou_bob", "oc_alpha", command, true, [{ namespace: "schedules", tool: "create", arguments: {
      name: "群提醒", instruction: "群独立提醒", reminderText: "群独立提醒", reminderMode: "verbatim", at, sourceText: command,
    } }]);
    const delivered = await running.until((s) => s.feishuFixtureTextOutbox?.some((item) => item.message === "群独立提醒") === true);
    expect(delivered.feishuFixtureTextOutbox?.filter((item) => item.message === "群独立提醒")).toEqual([expect.objectContaining({ chatId: "oc_alpha" })]);
    expect(delivered.weixinFixtureReplies).toEqual([]);
    expect(memory.read("fixture-bot").entries).toHaveLength(1);
    await running.close(); running = await start(directory, env);
    await running.until((s) => s.channels?.feishu?.ready === true);
    await send("om_after_group_restart", "ou_bob", "oc_alpha", "RESTART_CONTEXT");
    const restored = await running.until((s) => s.feishuFixtureTextOutbox?.length === 1);
    expect(restored.fixtureModelRequests!.at(-1)!.threadId).toBe(alphaRequest.threadId);
    expect(restored.feishuFixtureTextOutbox?.map((item) => item.message)).toEqual(["这是 fixture Codex 回复。"]);
    expect(restored.feishuFixtureMediaOutbox).toEqual([]);
    console.log(JSON.stringify({ kind: "feishu_group_acceptance", commands: ["guest discussion", "guest @", "Alice @", "Bob @", "empty @", "Alice files", "Bob 2", "Bob files", "restart", "Alice 2", "Bob cancel", command],
      initialRequests: beta.fixtureModelRequests, restoredRequests: restored.fixtureModelRequests, transcript: restored.codex.transcript,
      runs: restored.codex.runs, workflows: restored.workflows?.runs, mediaOutbox: sent.feishuFixtureMediaOutbox, textOutbox: delivered.feishuFixtureTextOutbox }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 60000);


it.skipIf(process.env.DISPATCH_RESULT_SCOPE_LIVE !== "1")("reports only requested specialist goals when test execution is excluded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-result-scope-live-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory, { WORKFLOW_SIMULATOR_MODEL: "live" });
    const cases = [
      { text: "请分析 TypeScript 函数 function discount(price: number, off: number) { return price - off; }。要求结果不能为负数；请在本群回复修正代码和 3 个边界测试案例，并明确测试尚未运行。不要修改文件或运行命令。", status: "completed" },
      { text: "新任务：请实际运行 TypeScript 编译器来验证 function discount(price: number, off: number) { return Math.max(0, price - off); }，必须给出真实执行结果；不能运行就明确说明，不要把代码审阅当成执行成功。", status: "failed" },
    ];
    for (const [index, sample] of cases.entries()) {
      const before = await running.state();
      const replyCount = before.agentFixtureOutboxes?.jack?.text.length ?? 0;
      await running.post("/api/fixture/inbound", { event: { app_id: "cli_0123456789abcdef",
        sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: `om_live_result_scope_${index}`, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group",
          message_type: "text", mentions: [], content: JSON.stringify({ text: sample.text }) } } });
      const result = await running.until((state) => (state.agentDispatch?.jobs.length ?? 0) === index + 1 &&
        ["completed", "failed", "waiting", "cancelled"].includes(state.agentDispatch!.jobs[index]!.status) &&
        (state.agentFixtureOutboxes?.jack?.text.length ?? 0) >= replyCount + 2, 180000);
      const job = result.agentDispatch!.jobs[index]!;
      const reply = result.agentFixtureOutboxes!.jack!.text.at(-1)!.message;
      console.log(JSON.stringify({ kind: "dispatch_result_scope_live", command: sample.text, job, reply }));
      expect(job.agentId).toBe("jack");
      expect(job.status).toBe(sample.status);
      if (index === 0) expect(reply).toMatch(/测试.{0,8}(?:未|没有).{0,4}(?:运行|执行)/u);
    }
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 390000);


it("keeps inferred work idle until its original author confirms the proposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-proposal-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const send = (id: string, sender: string, text: string, dispatchDecision: unknown, modelToolCalls?: unknown[]) => running!.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: sender } },
        message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision, modelToolCalls,
    });
    await send("om_inferred_bill", "ou_owner", "周末可能想去附近玩玩", { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" });
    const proposed = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    expect(proposed.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["要不要请 Bill 帮你安排周末出行？请回复这条建议确认，或告诉我暂时不用。"]);
    expect(proposed.agentDispatch?.jobs[0]?.status).toBe("proposed");
    expect(proposed.fixtureModelRequests).toEqual([]);
    expect(proposed.fixtureLeaderRequests).toEqual([]);
    expect(proposed.agentFixtureOutboxes?.bill?.text).toEqual([]);
    const requestId = proposed.agentDispatch!.jobs[0]!.id;
    await send("om_other_confirmation", "ou_colleague", "确认", { kind: "confirm", agentId: null, requestId, summary: "", message: "" });
    const denied = await running.until((state) => state.fixtureTextOutbox?.length === 2);
    expect(denied.agentDispatch?.jobs[0]?.status).toBe("proposed");
    expect(denied.fixtureModelRequests).toEqual([]);
    expect(denied.fixtureLeaderRequests).toEqual([]);
    expect(denied.agentFixtureOutboxes?.bill?.text).toEqual([]);
    await send("om_proposal_supplement_one", "ou_owner", "从南京站出发，1秒后提醒我检查计划", { kind: "supplement", agentId: null, requestId, summary: "", message: "" });
    await running.until((state) => state.fixtureTextOutbox?.length === 3);
    await send("om_proposal_supplement_two", "ou_owner", "只安排一天，不要住宿", { kind: "supplement", agentId: null, requestId, summary: "", message: "" });
    await running.until((state) => state.fixtureTextOutbox?.length === 4);
    await send("om_author_confirmation", "ou_owner", "确认，预算200元，不要创建文件。", { kind: "confirm", agentId: null, requestId, summary: "", message: "" }, [
      { namespace: "schedules", tool: "create", arguments: { name: "检查计划", instruction: "检查计划", reminderText: "该检查计划了。", reminderMode: "natural", delaySeconds: 1, sourceText: "1秒后提醒我检查计划" } },
    ]);
    const completed = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    expect(completed.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual(["我安排执行者 1（能力档 1）处理：安排周末出行。完成后会在本群汇报。", "这是 fixture Codex 回复。"]);
    // Only the confirmed request reaches the Team Leader: its Brief keeps the original message and adds the author's supplements and confirmation.
    const brief = completed.fixtureLeaderRequests!.find(({ phase }) => phase === "plan")!.input.brief;
    expect(brief.message).toBe("周末可能想去附近玩玩");
    for (const fragment of ["从南京站出发", "只安排一天，不要住宿", "确认，预算200元，不要创建文件。"]) expect(brief.latest).toContain(fragment);
    expect(completed.agentDispatch?.jobs).toEqual([expect.objectContaining({ agentId: "bill", requester: "ou_owner", status: "completed" })]);
    expect(completed.fixtureModelRequests).toHaveLength(1);
    expect(JSON.stringify(completed.fixtureModelRequests![0]!.input)).toContain("周末可能想去附近玩玩");
    expect(JSON.stringify(completed.fixtureModelRequests![0]!.input)).toContain("从南京站出发");
    expect(JSON.stringify(completed.fixtureModelRequests![0]!.input)).toContain("只安排一天，不要住宿");
    expect(JSON.stringify(completed.fixtureModelRequests![0]!.input)).toContain("确认，预算200元，不要创建文件。");
    const reminded = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 3, 5000);
    expect(reminded.agentFixtureOutboxes?.bill?.text[2]).toMatchObject({ chatId: "oc_alpha", message: "该检查计划了。" });
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("does not execute guest, bot, casual or invalid coordinator decisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-admission-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const send = (id: string, sender: string, senderType: string, text: string, dispatchDecision: unknown) => running!.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: senderType, sender_id: { open_id: sender } },
        message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision,
    });
    const task = { kind: "dispatch", agentId: "alice", requestId: null, summary: "修改商品", message: "" };
    await send("om_guest_task", "ou_guest", "user", "帮我修改商品", task);
    await send("om_bot_task", "ou_owner", "bot", "帮我修改商品", task);
    await send("om_casual", "ou_owner", "user", "今天心情不错", { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" });
    await send("om_unknown_agent", "ou_owner", "user", "交给陌生角色", { ...task, agentId: "unknown-agent" });
    await send("om_sam_execution", "ou_owner", "user", "Sam 自己修改", { ...task, agentId: "sam" });
    await send("om_message_as_request", "ou_owner", "user", "整理商品文案", { ...task, requestId: "om_message_as_request" });
    await send("om_malformed_decision", "ou_owner", "user", "无效结果", { kind: "dispatch" });
    const checked = await running.until((state) => state.fixtureTextOutbox?.length === 4);
    expect(checked.fixtureTextOutbox?.map(({ message }) => message)).toEqual([
      "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。",
      "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。",
      "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。",
      "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。",
    ]);
    expect(checked.fixtureModelRequests).toEqual([]);
    expect(checked.fixtureLeaderRequests).toEqual([]);
    expect(checked.agentDispatch?.jobs).toEqual([]);
    expect(checked.agentFixtureOutboxes).toEqual({ alice: { text: [], media: [] }, bill: { text: [], media: [] }, jack: { text: [], media: [] } });
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("resolves genuine cross-application mentions and explains reassignment before one specialist executes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-mentions-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory); running = await start(directory);
    const send = (id: string, appIds: string[], decision: unknown) => running!.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
          // Sender-app-scoped bot open IDs deliberately differ from each specialist's own open ID.
          mentions: appIds.map((_, index) => ({ key: `@_user_${index}`, id: { open_id: `ou_samview${index}` }, name: index === 0 ? "Bill" : "Jack" })),
          content: JSON.stringify({ text: `${appIds.map((_, index) => `@_user_${index}`).join(" ")} 帮我修复代码` }) } },
      messageDetails: { message_id: id, chat_id: "oc_alpha", msg_type: "text", body: { content: '{"text":"帮我修复代码"}' },
        mentions: appIds.map((id, index) => ({ key: `@_user_${index}`, id, id_type: "app_id", name: index === 0 ? "Bill" : "Jack" })) },
      dispatchDecision: decision,
    });
    await send("om_bill_wrong_scope", ["cli_bbbbbbbbbbbbbbbb"], { kind: "dispatch", agentId: "jack", requestId: null, summary: "修复代码",
      message: "这属于技术开发事务。我请 Sam 重新分派给 Jack，由他独立处理。" });
    const reassigned = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 2);
    expect(reassigned.agentFixtureOutboxes?.bill?.text.map(({ message }) => message)).toEqual(["这属于技术开发事务。我请 Sam 重新分派给 Jack，由他独立处理。"]);
    expect(reassigned.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["已将这项需求转派给 Jack。"]);
    expect(reassigned.agentFixtureOutboxes?.jack?.text.map(({ message }) => message)).toEqual(["我安排执行者 1（能力档 1）处理：修复代码。完成后会在本群汇报。", "这是 fixture Codex 回复。"]);
    expect([...new Set(reassigned.fixtureLeaderRequests?.map(({ teamId }) => teamId))]).toEqual(["jack"]);
    expect(reassigned.fixtureModelRequests).toHaveLength(1);
    expect(reassigned.agentDispatch?.jobs[0]).toMatchObject({ agentId: "jack", status: "completed" });
    await send("om_multi_named", ["cli_bbbbbbbbbbbbbbbb", "cli_cccccccccccccccc"], { kind: "dispatch", agentId: "jack", requestId: null, summary: "不能直接执行", message: "" });
    const clarified = await running.until((state) => state.fixtureTextOutbox?.length === 2);
    expect(clarified.fixtureTextOutbox?.at(-1)?.message).toBe("你点名了多个 Agent。这项事务希望由谁独立负责？");
    expect(clarified.fixtureModelRequests).toHaveLength(1);
    expect(clarified.agentDispatch?.jobs).toHaveLength(1);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("keeps each specialist identity for files and scheduled reminders across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-delivery-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-artifacts-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  try {
    dispatchConfig(directory, true); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    // The reminders must fall due only after the restart. Their due time is wall-clock time in another process, so it leaves the
    // requests below a wide margin, and the case fails with a reason if they still outlast it, rather than timing out later.
    const due = Date.now() + 20_000, at = new Date(due).toISOString();
    for (const agentId of ["alice", "bill", "jack"]) {
      const text = `请保存并发回 ${agentId} 计划，稍后在本群提醒，原文：${agentId} 独立提醒`;
      await running.post("/api/fixture/feishu/inbound", {
        event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
          message: { message_id: `om_${agentId}_artifact`, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } },
        dispatchDecision: { kind: "dispatch", agentId, requestId: null, summary: `${agentId} 计划与提醒`, message: "" },
        modelToolCalls: [
          { namespace: "schedules", tool: "create", arguments: { name: `${agentId} 提醒`, instruction: `${agentId} 独立提醒`, reminderText: `${agentId} 独立提醒`, reminderMode: "verbatim", at, sourceText: text } },
          { namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: `${agentId}-plan.txt`, content: `${agentId} plan`, overwrite: false } },
          { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 1, path: ["fileRef"] } }] } },
        ],
      });
      const sent = await running.until((state) => state.agentFixtureOutboxes?.[agentId]?.text.at(-1)?.message === "文件已发送，请查收。");
      expect(sent.agentFixtureOutboxes?.[agentId]?.media).toEqual([expect.objectContaining({ chatId: "oc_alpha", fileName: `${agentId}-plan.txt`, bytesBase64: Buffer.from(`${agentId} plan`).toString("base64") })]);
      expect(sent.feishuFixtureMediaOutbox).toEqual([]);
      expect(sent.fixtureOutbox).toEqual([]);
    }
    const managementText = "把 alice 提醒改名为运营资料提醒，保存并发回修改后的名称";
    await running.post("/api/fixture/feishu/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_colleague" } },
        message: { message_id: "om_colleague_manages_alice", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text: managementText }) } },
      dispatchDecision: { kind: "dispatch", agentId: "bill", requestId: null, summary: "修改同群提醒名称", message: "" },
      modelToolCalls: [
        { namespace: "schedules", tool: "list", arguments: {} },
        { namespace: "schedules", tool: "inspect", arguments: { reference: "alice 提醒" } },
        { namespace: "schedules", tool: "edit", arguments: { reference: "alice 提醒", expectedRevision: { $fixtureToolResult: { call: 1, path: ["task", "revision"] } }, name: "运营资料提醒", sourceText: managementText } },
        { namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: "managed-reminder.txt", content: { $fixtureToolResult: { call: 2, path: ["task", "name"] } }, overwrite: false } },
        { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 3, path: ["fileRef"] } }] } },
      ],
    });
    const managed = await running.until((state) => state.agentFixtureOutboxes?.bill?.media.length === 2 && state.agentDispatch?.jobs.at(-1)?.status === "completed");
    expect(managed.agentFixtureOutboxes?.bill?.media[1]).toMatchObject({ chatId: "oc_alpha", fileName: "managed-reminder.txt", bytesBase64: Buffer.from("运营资料提醒").toString("base64") });
    expect(Date.now(), "the requests outlasted the reminders' due time, so the first process would deliver them").toBeLessThan(due - 2_000);
    await running.close(); running = await start(directory, env);
    const delivered = await running.until((state) => ["alice", "bill", "jack"].every((id) => state.agentFixtureOutboxes?.[id]?.text.length === 1),
      Math.max(0, due - Date.now()) + processWaitLimitMs);
    expect(delivered.agentFixtureOutboxes).toEqual({
      alice: { text: [expect.objectContaining({ chatId: "oc_alpha", message: "alice 独立提醒" })], media: [] },
      bill: { text: [expect.objectContaining({ chatId: "oc_alpha", message: "bill 独立提醒" })], media: [] },
      jack: { text: [expect.objectContaining({ chatId: "oc_alpha", message: "jack 独立提醒" })], media: [] },
    });
    expect(delivered.fixtureModelRequests).toEqual([]);
    expect(delivered.feishuFixtureTextOutbox).toEqual([]);
    expect(delivered.weixinFixtureReplies).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 60000);

it.each([["accepted", "2"], ["rejected", "2"], ["accepted", "取消"]] as const)("resumes a specialist file choice after restart only for its original requester (%s prompt, %s response)", async (promptOutcome, choice) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-pending-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-pending-files-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  const send = (id: string, sender: string, text: string, dispatchDecision: unknown, modelToolCalls?: unknown[]) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision, modelToolCalls,
  });
  try {
    dispatchConfig(directory, true); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: false })) });
    await running.post("/api/fixture/feishu/inbound", { applicationControl: { agentId: "alice", textOutcomes: ["accepted", promptOutcome] } });
    await send("om_alice_choice", "ou_owner", "列出 Agent 笔记让我选发哪个", { kind: "dispatch", agentId: "alice", requestId: null, summary: "选择并发送运营笔记", message: "" }, [
      { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
    ]);
    const pending = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "waiting" && state.agentFixtureOutboxes?.alice?.text.length === (promptOutcome === "accepted" ? 2 : 1));
    const run = pending.workflows!.runs.find(({ status }) => status === "needs_input")!;
    expect(run).toBeDefined();
    if (promptOutcome === "accepted") expect(pending.agentFixtureOutboxes?.alice?.text.at(-1)?.message).toContain("Agent Alpha.md");
    expect(pending.agentFixtureOutboxes?.alice?.media).toEqual([]);
    await running.close(); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    if (promptOutcome === "rejected") {
      await send("om_prompt_retry", "ou_owner", "只重发汇报", { kind: "retry_report", agentId: null, requestId: pending.agentDispatch!.jobs[0]!.id, summary: "", message: "" });
      const reported = await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 1);
      expect(reported.agentFixtureOutboxes?.alice?.text[0]?.message).toContain("Agent Alpha.md");
      expect(reported.fixtureModelRequests).toEqual([]);
    }
    await send("om_other_choice", "ou_colleague", "2", { kind: "clarify", agentId: null, requestId: null, summary: "", message: "请说明你的需求。" });
    const denied = await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    expect(denied.workflows?.runs.find(({ runRef }) => runRef === run.runRef)?.status).toBe("needs_input");
    expect(denied.agentFixtureOutboxes?.alice?.media).toEqual([]);
    await send("om_original_choice", "ou_owner", choice, { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" });
    await send("om_choice_barrier", "ou_colleague", "说明下你能做什么", { kind: "clarify", agentId: null, requestId: null, summary: "", message: "请说明想完成的事情。" });
    const sent = await running.until((state) => state.feishuFixtureTextOutbox?.length === 2);
    expect(sent.agentFixtureOutboxes?.alice?.media).toEqual(choice === "取消" ? [] : [expect.objectContaining({ chatId: "oc_alpha", fileName: "Agent Beta.md", bytesBase64: Buffer.from("# Agent Beta\n").toString("base64") })]);
    expect(sent.agentFixtureOutboxes?.bill?.media).toEqual([]);
    expect(sent.feishuFixtureMediaOutbox).toEqual([]);
    expect(sent.fixtureModelRequests).toEqual([]);
    expect(sent.workflows?.runs.find(({ runRef }) => runRef === run.runRef)).toMatchObject(choice === "取消" ? { status: "cancelled", effects: [] } : { status: "succeeded", effects: [{ state: "accepted" }] });
    expect(sent.agentDispatch?.jobs[0]?.status).toBe(choice === "取消" ? "cancelled" : "completed");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("continues a queued supplement after the requester resolves a specialist file choice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-pending-supplement-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-pending-supplement-files-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, text: string, dispatchDecision: unknown, options: Record<string, unknown> = {}) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision, ...options,
  });
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: false })) });
    await send("om_held_file_choice", "列出 Agent 笔记让我选发哪个", { kind: "dispatch", agentId: "alice", requestId: null, summary: "选择运营笔记", message: "" }, { modelHold: true, modelToolCalls: [
      { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } },
    ] });
    const busy = await running.until((state) => state.fixtureModelRequests?.length === 1);
    await send("om_file_supplement", "补充：文件发完后解释如何整理商品标签", { kind: "supplement", agentId: null, requestId: busy.agentDispatch!.jobs[0]!.id, summary: "", message: "" });
    await send("om_supplement_barrier", "另一个问题", { kind: "clarify", agentId: null, requestId: null, summary: "", message: "请说明另一个问题。" });
    await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    await running.post("/api/fixture/feishu/inbound", { modelControl: { messageId: "om_held_file_choice", action: "release" } });
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "waiting" && state.agentFixtureOutboxes?.alice?.text.length === 2);
    await send("om_file_selection", "2", { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" });
    const done = await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 5, 5000);
    expect(done.agentDispatch?.jobs[0]?.status).toBe("completed");
    expect(done.fixtureModelRequests).toHaveLength(2);
    expect(JSON.stringify(done.fixtureModelRequests![1]!.input)).toContain("用户消息：\\n补充：文件发完后解释如何整理商品标签");
    expect(done.agentFixtureOutboxes?.alice?.media).toEqual([expect.objectContaining({ chatId: "oc_alpha", fileName: "Agent Beta.md", bytesBase64: Buffer.from("# Agent Beta\n").toString("base64") })]);
    expect(done.feishuFixtureMediaOutbox).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("accepts requester-only cancel and supplements while a specialist is still running", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-busy-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, sender: string, text: string, dispatchDecision: unknown, modelHold = false) => running!.post("/api/fixture/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision, modelHold,
  });
  try {
    dispatchConfig(directory); running = await start(directory);
    await send("om_held_alice", "ou_owner", "帮我整理商品", { kind: "dispatch", agentId: "alice", requestId: null, summary: "整理商品", message: "" }, true);
    const busy = await running.until((state) => state.fixtureModelRequests?.length === 1);
    const requestId = busy.agentDispatch!.jobs[0]!.id;
    expect(busy.agentDispatch?.jobs[0]?.status).toBe("running");
    await send("om_other_cancel", "ou_colleague", "取消", { kind: "cancel", agentId: null, requestId, summary: "", message: "" });
    const denied = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    expect(denied.agentDispatch?.jobs[0]?.status).toBe("running");
    await send("om_owner_cancel", "ou_owner", "取消", { kind: "cancel", agentId: null, requestId, summary: "", message: "" });
    const cancelled = await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    expect(cancelled.agentDispatch?.jobs[0]?.status).toBe("cancelled");
    expect(cancelled.agentDispatch?.jobs[0]?.assignments).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(cancelled.agentFixtureOutboxes?.alice?.text.at(-1)?.message).toBe("已停止继续处理。已经完成的操作不会自动撤销。");
    await send("om_held_bill", "ou_owner", "安排周末出行", { kind: "dispatch", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" }, true);
    const bill = await running.until((state) => state.fixtureModelRequests?.length === 2);
    const billId = bill.agentDispatch!.jobs.find(({ agentId }) => agentId === "bill")!.id;
    await send("om_bill_extra", "ou_owner", "补充：预算 300 元", { kind: "supplement", agentId: null, requestId: billId, summary: "预算 300 元", message: "" });
    await send("om_other_extra", "ou_colleague", "改为无限预算", { kind: "supplement", agentId: null, requestId: billId, summary: "无限预算", message: "" });
    const stillBusy = await running.until((state) => state.fixtureTextOutbox?.length === 2);
    expect(stillBusy.fixtureModelRequests).toHaveLength(2);
    await running.post("/api/fixture/inbound", { modelControl: { messageId: "om_held_bill", action: "release" } });
    const done = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 4);
    expect(done.agentDispatch?.jobs.find(({ agentId }) => agentId === "bill")?.status).toBe("completed");
    expect(done.fixtureModelRequests).toHaveLength(3);
    // The promoted supplement is a new attempt: Bill re-plans it, and a new Executor runs it in its own session.
    expect(done.fixtureModelRequests![2]!.threadId).not.toBe(done.fixtureModelRequests![1]!.threadId);
    const replan = done.fixtureLeaderRequests!.filter(({ teamId, phase }) => teamId === "bill" && phase === "plan").at(-1)!.input.brief;
    expect(replan.latest).toBe("补充：预算 300 元");
    expect(JSON.stringify(done.fixtureLeaderRequests)).not.toContain("改为无限预算");
    expect(JSON.stringify(done.fixtureModelRequests![2]!.input)).toContain("补充：预算 300 元");
    // Another person's control text can be inert discussion, but never the active request.
    expect(JSON.stringify(done.fixtureModelRequests![2]!.input)).not.toContain("用户消息：\\n改为无限预算");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("clarifies ambiguous controls across two proposals and cancels only an explicitly selected request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-ambiguous-control-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, text: string, dispatchDecision: unknown) => running!.post("/api/fixture/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision,
  });
  try {
    dispatchConfig(directory); running = await start(directory);
    await send("om_propose_alice", "商品文案可能要整理一下", { kind: "propose", agentId: "alice", requestId: null, summary: "整理商品文案", message: "" });
    await send("om_propose_bill", "周末可能想出去玩", { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" });
    const proposed = await running.until((state) => state.fixtureTextOutbox?.length === 2);
    expect(proposed.agentDispatch?.jobs.map(({ agentId, status }) => ({ agentId, status })).sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual([
      { agentId: "alice", status: "proposed" }, { agentId: "bill", status: "proposed" },
    ]);
    const aliceId = proposed.agentDispatch!.jobs.find(({ agentId }) => agentId === "alice")!.id;
    for (const [index, kind, text] of [[0, "cancel", "取消"], [1, "confirm", "确认"]] as const) {
      await send(`om_ambiguous_${kind}`, text, { kind, agentId: null, requestId: null, summary: "", message: "" });
      const clarified = await running.until((state) => state.fixtureTextOutbox?.length === 3 + index);
      expect(clarified.fixtureTextOutbox?.at(-1)?.message).toBe("我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。");
      expect(clarified.agentDispatch?.jobs.map(({ agentId, status }) => ({ agentId, status })).sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual([
        { agentId: "alice", status: "proposed" }, { agentId: "bill", status: "proposed" },
      ]);
      expect(clarified.fixtureModelRequests).toEqual([]);
      expect(clarified.agentFixtureOutboxes).toEqual({ alice: { text: [], media: [] }, bill: { text: [], media: [] }, jack: { text: [], media: [] } });
      expect(clarified.workflows?.runs.map(({ workflowId }) => workflowId)).toEqual(["fixture.status-check"]);
      expect(clarified.workflows?.runs.flatMap(({ effects }) => effects)).toEqual([]);
    }
    await send("om_specific_cancel", "取消整理商品文案", { kind: "cancel", agentId: null, requestId: aliceId, summary: "", message: "" });
    const cancelled = await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 1);
    expect(cancelled.agentDispatch?.jobs.map(({ agentId, status }) => ({ agentId, status })).sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual([
      { agentId: "alice", status: "cancelled" }, { agentId: "bill", status: "proposed" },
    ]);
    expect(cancelled.agentFixtureOutboxes?.alice?.text[0]).toMatchObject({ chatId: "oc_alpha", message: "已停止继续处理。已经完成的操作不会自动撤销。" });
    expect(cancelled.agentFixtureOutboxes?.bill).toEqual({ text: [], media: [] });
    expect(cancelled.fixtureModelRequests).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it.each(["restart", "cancel"] as const)("preserves queued supplements while result delivery is pending: %s", async (action) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-supplement-delivery-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, text: string, dispatchDecision: unknown, modelHold = false) => running!.post("/api/fixture/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision, modelHold,
  });
  try {
    dispatchConfig(directory); running = await start(directory);
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["accepted", "held"] } });
    await send("om_bill_original", "安排周末出行", { kind: "dispatch", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" }, true);
    const busy = await running.until((state) => state.fixtureModelRequests?.length === 1);
    const requestId = busy.agentDispatch!.jobs[0]!.id;
    await send("om_bill_supplement", "补充：预算 300 元", { kind: "supplement", agentId: null, requestId, summary: "", message: "" });
    await send("om_intake_barrier", "另一个问题", { kind: "clarify", agentId: null, requestId: null, summary: "", message: "请说明另一个问题。" });
    await running.until((state) => state.fixtureTextOutbox?.length === 1);
    await running.post("/api/fixture/inbound", { modelControl: { messageId: "om_bill_original", action: "release" } });
    await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    if (action === "restart") {
      await running.crash(); running = await start(directory);
      const done = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
      expect(done.agentDispatch?.jobs[0]?.status).toBe("completed");
      expect(done.fixtureModelRequests).toHaveLength(1);
      expect(JSON.stringify(done.fixtureModelRequests![0]!.input)).toContain("用户消息：\\n补充：预算 300 元");
    } else {
      await send("om_cancel_supplement", "取消后续补充", { kind: "cancel", agentId: null, requestId, summary: "", message: "" });
      await send("om_cancel_barrier", "另一个问题", { kind: "clarify", agentId: null, requestId: null, summary: "", message: "取消后还有什么问题？" });
      const cancelled = await running.until((state) => state.fixtureTextOutbox?.some(({ message }) => message === "取消后还有什么问题？") === true);
      expect(cancelled.agentDispatch?.jobs[0]?.status).toBe("cancelled");
      await running.post("/api/fixture/inbound", { applicationControl: { agentId: "bill", releaseText: true } });
      await running.close(); running = await start(directory);
      expect((await running.state()).agentDispatch?.jobs[0]?.status).toBe("cancelled");
      expect((await running.state()).fixtureModelRequests).toEqual([]);
    }
  } finally { await running?.crash(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("retries failed dispatch after restart without repeating a completed edit with a fresh read hash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-retry-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-retry-files-"));
  mkdirSync(join(business, "demo-vault", ".obsidian"), { recursive: true }); writeFileSync(join(business, "demo-vault", "sample.txt"), "x\n");
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  const tools = [
    { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "sample.txt", kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
    { namespace: "files", tool: "read", arguments: { fileRef: { $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } } } },
    { namespace: "files", tool: "edit", arguments: { fileRef: { $fixtureToolResult: { call: 1, path: ["fileRef"] } }, expectedSha256: { $fixtureToolResult: { call: 1, path: ["sha256"] } }, oldText: "x", newText: "xx", replaceAll: true } },
  ];
  const send = (id: string, text: string, dispatchDecision: unknown, modelReply: string, sendFile = false) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision, modelToolCalls: [...tools, ...(sendFile ? [{ namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 2, path: ["fileRef"] } }] } }] : [])], modelReply,
  });
  try {
    dispatchConfig(directory, true); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    await send("om_jack_partial", "把 sample.txt 的 x 改为 xx，并整理报告、发回文件", { kind: "dispatch", agentId: "jack", requestId: null, summary: "修改样例并整理报告", message: "" },
      JSON.stringify({ message: "已修改样例，但报告生成失败。", results: [{ subject: "修改样例并整理报告", status: "partial" }] }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed" && state.agentFixtureOutboxes?.jack?.text.length === 2);
    expect(readFileSync(join(business, "demo-vault", "sample.txt"), "utf8")).toBe("xx\n");
    expect(failed.agentFixtureOutboxes?.jack?.text.at(-1)?.message).toContain("已确认完成 1 次本地文件修改");
    const requestId = failed.agentDispatch!.jobs[0]!.id;
    await running.close(); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    expect((await running.state()).fixtureModelRequests).toEqual([]);
    // Another member's retry is refused and starts nothing (agent-dispatch::REQ-007/AC-01): the request is not among that member's own, so the decision naming it is invalid.
    await running.post("/api/fixture/feishu/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_colleague" } },
        message: { message_id: "om_colleague_retry", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text: "重试" }) } },
      dispatchDecision: { kind: "retry", agentId: null, requestId, summary: "", message: "" } });
    const refused = await running.until((state) => state.feishuFixtureTextOutbox?.length === 1);
    expect(refused.feishuFixtureTextOutbox?.[0]?.message).toBe("我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。");
    expect(refused.agentDispatch?.jobs[0]?.status).toBe("failed");
    expect(refused.fixtureModelRequests).toEqual([]);
    await send("om_jack_retry", "重试", { kind: "retry", agentId: null, requestId, summary: "", message: "" },
      JSON.stringify({ message: "已保留修改并补齐报告。", results: [{ subject: "修改样例并整理报告", status: "completed" }] }), true);
    const completed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && state.agentFixtureOutboxes?.jack?.text.length === 2);
    expect(readFileSync(join(business, "demo-vault", "sample.txt"), "utf8")).toBe("xx\n");
    expect(completed.fixtureModelRequests).toHaveLength(1);
    expect(completed.agentFixtureOutboxes?.jack?.text.at(-1)?.message).toBe("文件已发送，请查收。");
    expect(completed.agentFixtureOutboxes?.jack?.media).toEqual([expect.objectContaining({ fileName: "sample.txt", bytesBase64: Buffer.from("xx\n").toString("base64") })]);
    // The retry reruns the same Assignment and Executor: no new plan in this process, only the retry's closing turn.
    expect(completed.agentDispatch?.jobs[0]?.assignments).toEqual([expect.objectContaining({ executor: "执行者 1", status: "completed", attempt: 1 })]);
    expect(completed.fixtureLeaderRequests?.map(({ phase }) => phase)).toEqual(["close"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("keeps group and private memory out of Executor turns, and shares memory per Executor profile across restart and permission changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-memory-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, chat: string, text: string, dispatchDecision: unknown) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: chat, chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } },
    dispatchDecision,
  });
  const dispatch = (id: string, chat: string, agentId: string, text: string) => send(id, chat, text, { kind: "dispatch", agentId, requestId: null, summary: text, message: "" });
  try {
    dispatchConfig(directory, true);
    const configuration = JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"));
    configuration.feishu.groups.push({ chatId: "oc_beta", allowedSenderIds: ["ou_owner"] });
    configuration.feishu.dispatch.groupChatIds.push("oc_beta");
    writeFileSync(join(directory, "channel.json"), JSON.stringify(configuration));
    const binding = parseChannelStartupConfiguration(configuration).entries.find((entry) => entry.channel === "feishu")!;
    running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    await running.post("/api/fixture/workflow/inbound", { text: "PRIVATE_EXECUTION_MARKER。请记住私人信息。" });
    const personal = await running.until((state) => state.weixinFixtureReplies?.length === 2);
    const personalEntry = personal.codex.transcript.find((entry) => entry.role === "user" && entry.text.startsWith("PRIVATE_EXECUTION"))!;
    await seedMemory(directory, "fixture-bot", personalEntry.target, personalEntry.id, "PRIVATE_MEMORY_SENTINEL");
    const [alphaTarget, betaTarget] = [binding.owner.groupAddress("oc_alpha")!, binding.owner.groupAddress("oc_beta")!];
    const [alphaGroup, betaGroup] = [alphaTarget, betaTarget].map(({ accountId, target }) => binding.owner.memoryScope(accountId, target));
    await seedMemory(directory, alphaGroup!, alphaTarget.target, "alpha-seed", "ALPHA_BUSINESS_FACT");
    await seedMemory(directory, betaGroup!, betaTarget.target, "beta-seed", "BETA_BUSINESS_FACT");
    await seedMemory(directory, memoryAccountId(alphaGroup!, { kind: "profile", teamId: "bill", profileId: "executor-1" }), alphaTarget.target, "bill-profile-seed", "BILL_PROFILE_FACT");
    await seedMemory(directory, memoryAccountId(alphaGroup!, { kind: "profile", teamId: "alice", profileId: "executor-1" }), alphaTarget.target, "alice-profile-seed", "ALICE_ALPHA_PROFILE_FACT");
    // Ignored discussion reaches the Coordinator with the next message, never an Executor.
    await send("om_alpha_discussion", "oc_alpha", "DISCUSSION_MARKER_X1，周末大家有空吗", { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" });
    await dispatch("om_alpha_alice", "oc_alpha", "alice", "请整理本周运营要点");
    await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    await dispatch("om_beta_alice", "oc_beta", "alice", "请整理本周运营要点");
    await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 4);
    await dispatch("om_alpha_bill", "oc_alpha", "bill", "请根据群业务事实安排出行");
    await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    await dispatch("om_alpha_jack", "oc_alpha", "jack", "请根据群业务事实给出技术建议");
    const shared = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 2);
    expect(shared.fixtureModelRequests).toHaveLength(5);
    const [privateRequest, aliceAlpha, aliceBeta, billAlpha, jackAlpha] = shared.fixtureModelRequests!;
    expect(new Set([privateRequest!.threadId, aliceAlpha!.threadId, aliceBeta!.threadId, billAlpha!.threadId, jackAlpha!.threadId]).size).toBe(5);
    for (const request of [aliceAlpha!, aliceBeta!, billAlpha!, jackAlpha!]) {
      for (const outside of ["ALPHA_BUSINESS_FACT", "BETA_BUSINESS_FACT", "PRIVATE_MEMORY_SENTINEL", "PRIVATE_EXECUTION_MARKER", "DISCUSSION_MARKER_X1"]) {
        expect(JSON.stringify(request.input)).not.toContain(outside);
      }
    }
    // Only Executors of Bill's preset in this group share its memory; Jack's preset has the same ID in another team.
    expect(JSON.stringify(billAlpha!.input)).toContain("BILL_PROFILE_FACT");
    for (const request of [aliceAlpha!, aliceBeta!, jackAlpha!]) expect(JSON.stringify(request.input)).not.toContain("BILL_PROFILE_FACT");
    // A preset's memory belongs to one group: Alice's oc_alpha Executor recalls it, her oc_beta Executor does not.
    expect(JSON.stringify(aliceAlpha!.input)).toContain("ALICE_ALPHA_PROFILE_FACT");
    for (const request of [aliceBeta!, billAlpha!, jackAlpha!]) expect(JSON.stringify(request.input)).not.toContain("ALICE_ALPHA_PROFILE_FACT");
    await running.close(); running = await start(directory);
    await running.until((state) => state.channels?.feishu?.ready === true);
    await dispatch("om_bill_resumed", "oc_alpha", "bill", "继续规划");
    const resumed = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    // Each request gets its own Executor session; a Team Leader's session reset on a revision change is covered by agent-dispatch-leader.test.ts.
    expect(resumed.fixtureModelRequests![0]!.threadId).not.toBe(billAlpha!.threadId);
    expect(JSON.stringify(resumed.fixtureModelRequests![0]!.input)).toContain("BILL_PROFILE_FACT");
    const notes = resumed.workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: false, write: false })) });
    await dispatch("om_bill_new_permissions", "oc_alpha", "bill", "按当前授权继续规划");
    const changed = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 4);
    expect(JSON.stringify(changed.fixtureModelRequests![1]!.input)).toContain("BILL_PROFILE_FACT");
    expect(JSON.stringify(changed.fixtureModelRequests![1]!.input)).not.toContain("ALPHA_BUSINESS_FACT");
    expect(new AccountMemoryStore(join(directory, "memory")).read("fixture-bot").entries.map(({ value }) => value)).toEqual(["PRIVATE_MEMORY_SENTINEL"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("retries only rejected reports without rerunning work and never retries unknown report delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-reports-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, text: string, dispatchDecision: unknown) => running!.post("/api/fixture/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text }) } }, dispatchDecision,
  });
  try {
    dispatchConfig(directory); running = await start(directory);
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "alice", textOutcomes: ["accepted", "rejected"] } });
    await send("om_report_rejected", "帮我整理商品", { kind: "dispatch", agentId: "alice", requestId: null, summary: "整理商品", message: "" });
    const finished = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    const requestId = finished.agentDispatch!.jobs[0]!.id;
    expect(finished.agentFixtureOutboxes?.alice?.text).toHaveLength(1);
    await send("om_retry_report", "只重发汇报", { kind: "retry_report", agentId: null, requestId, summary: "", message: "" });
    const reported = await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    expect(reported.fixtureModelRequests).toHaveLength(1);
    // Resending the rejected closing runs no Team Leader turn and no Executor again.
    expect(reported.fixtureLeaderRequests?.map(({ phase }) => phase)).toEqual(["plan", "close"]);
    expect(reported.agentFixtureOutboxes?.alice?.text.at(-1)?.message).toBe("这是 fixture Codex 回复。");
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["accepted", "unknown"] } });
    await send("om_report_unknown", "帮我安排出行", { kind: "dispatch", agentId: "bill", requestId: null, summary: "安排出行", message: "" });
    const unknown = await running.until((state) => state.agentDispatch?.jobs.find(({ agentId }) => agentId === "bill")?.status === "completed" && state.agentFixtureOutboxes?.bill?.text.length === 2);
    const billId = unknown.agentDispatch!.jobs.find(({ agentId }) => agentId === "bill")!.id;
    await send("om_retry_unknown", "只重发汇报", { kind: "retry_report", agentId: null, requestId: billId, summary: "", message: "" });
    const blocked = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    expect(blocked.fixtureTextOutbox?.[0]?.message).toBe("这条汇报已被接收或发送结果无法确认，不能自动重发。业务操作不会重新执行。");
    expect(blocked.fixtureModelRequests).toHaveLength(2);
    expect(blocked.agentFixtureOutboxes?.bill?.text).toHaveLength(2);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it.each(["member", "group", "application"] as const)("fails closed for an unavailable assignee and fences queued work after %s replacement", async (replacement) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-revocation-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, sender: string, agentId: string, modelHold = false, chatId = "oc_alpha") => running!.post("/api/fixture/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: chatId, chat_type: "group", message_type: "text", mentions: [], content: JSON.stringify({ text: "处理当前请求" }) } },
    dispatchDecision: { kind: "dispatch", agentId, requestId: null, summary: "处理当前请求", message: "" }, modelHold,
  });
  try {
    dispatchConfig(directory); running = await start(directory);
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "alice", connection: "unavailable" } });
    await send("om_assignee_offline", "ou_owner", "alice");
    const unavailable = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    expect(unavailable.fixtureModelRequests).toEqual([]);
    expect(unavailable.agentDispatch?.jobs[0]?.assignments).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(unavailable.fixtureTextOutbox).toEqual([]);
    expect(unavailable.agentFixtureOutboxes).toEqual({ alice: { text: [], media: [] }, bill: { text: [], media: [] }, jack: { text: [], media: [] } });
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "alice", connection: "ready" } });
    await send("om_running_before_revocation", "ou_owner", "alice", true);
    await running.until((state) => state.fixtureModelRequests?.length === 1);
    await send("om_queued_before_revocation", "ou_owner", "alice");
    const queued = await running.until((state) => state.agentDispatch?.jobs.length === 3);
    expect(queued.agentDispatch?.jobs.map(({ status }) => status)).toEqual(["failed", "running", "queued"]);
    await running.close(); running = undefined;
    const configuration = JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"));
    if (replacement === "member") configuration.feishu.groups[0].allowedSenderIds = ["ou_colleague"];
    else if (replacement === "group") {
      configuration.feishu.groups[0].chatId = "oc_beta";
      configuration.feishu.dispatch.groupChatIds = ["oc_beta"];
    } else configuration.feishu.dispatch.agents[1].appId = "cli_dddddddddddddddd";
    writeFileSync(join(directory, "channel.json"), JSON.stringify(configuration));
    running = await start(directory);
    await send("om_authorized_after_revocation", "ou_colleague", "bill", false, replacement === "group" ? "oc_beta" : "oc_alpha");
    const restored = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    expect(restored.fixtureModelRequests).toHaveLength(1);
    expect(restored.agentFixtureOutboxes?.alice?.text).toEqual([]);
    expect(restored.fixtureTextOutbox).toEqual([]);
    expect(restored.agentDispatch?.jobs[2]?.status).toBe(replacement === "application" ? "failed" : "cancelled");
    expect(restored.agentDispatch?.jobs.some(({ requester, status }) => requester === "ou_owner" && ["running", "queued"].includes(status))).toBe(false);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("reports confirmed file work after a hard interruption without automatically replaying it, and runs the request queued behind it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-crash-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-crash-files-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  try {
    dispatchConfig(directory, true); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    await running.post("/api/fixture/feishu/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_crash_write", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [],
          content: JSON.stringify({ text: "明天提醒我检查计划；先停用这个提醒。保存 crash-plan.txt，然后继续完善计划" }) } },
      dispatchDecision: { kind: "dispatch", agentId: "jack", requestId: null, summary: "保存并完善计划", message: "" }, modelHold: true,
      modelToolCalls: [
        { namespace: "schedules", tool: "create", arguments: { name: "检查计划", instruction: "检查计划", reminderText: "该检查计划了。", reminderMode: "natural", delaySeconds: 86400, sourceText: "明天提醒我检查计划" } },
        { namespace: "schedules", tool: "disable", arguments: { reference: { $fixtureToolResult: { call: 0, path: ["task", "id"] } }, expectedRevision: 1, sourceText: "先停用这个提醒" } },
        { namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: "crash-plan.txt", content: { $fixtureToolResult: { call: 1, path: ["status"] } }, overwrite: false } },
      ],
    });
    // The file content lands before the operation journal records the write as completed, and the
    // recovery report reads the journal. Crash only once the journal has the completion.
    const journal = new LocalFileOperationStore(join(directory, "local-file-operations.sqlite"));
    try {
      await running.until((state) => state.agentDispatch?.jobs[0]?.status === "running" &&
        journal.dispatchEvidence(state.agentDispatch.jobs[0].id).completed === 1);
    } finally { journal.close(); }
    // A second request for the same team in the same group waits behind the running one.
    await running.post("/api/fixture/feishu/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_crash_queued", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [],
          content: JSON.stringify({ text: "再整理一份计划说明" }) } },
      dispatchDecision: { kind: "dispatch", agentId: "jack", requestId: null, summary: "整理计划说明", message: "" },
    });
    await running.until((state) => state.agentDispatch?.jobs[1]?.status === "queued");
    await running.crash(); running = undefined;
    running = await start(directory, env);
    const recovered = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 3 && state.agentDispatch?.jobs[1]?.status === "completed");
    expect(recovered.agentDispatch?.jobs.map(({ id }) => id)).toHaveLength(2);
    expect(recovered.agentDispatch?.jobs[0]).toMatchObject({ status: "failed", assignments: [expect.objectContaining({ executor: "执行者 1", status: "interrupted" })] });
    expect(recovered.agentDispatch?.jobs[1]).toMatchObject({ status: "completed", assignments: [expect.objectContaining({ executor: "执行者 2", status: "completed" })] });
    expect(recovered.fixtureLeaderRequests?.map(({ phase, input }) => `${phase}:${input.brief.message}`)).toEqual(["plan:再整理一份计划说明", "close:再整理一份计划说明"]);
    expect(recovered.fixtureModelRequests).toHaveLength(1);
    expect(JSON.stringify(recovered.fixtureModelRequests![0]!.input)).toContain("整理计划说明");
    expect(recovered.agentFixtureOutboxes?.jack?.text.slice(1).map(({ message }) => message)).toEqual(["我安排执行者 2（能力档 1）处理：整理计划说明。完成后会在本群汇报。", "这是 fixture Codex 回复。"]);
    expect(recovered.agentFixtureOutboxes?.jack?.text[0]?.message).toContain("服务中断");
    expect(recovered.agentFixtureOutboxes?.jack?.text[0]?.message).toContain("已确认完成 1 次本地文件修改");
    expect(recovered.agentFixtureOutboxes?.jack?.text[0]?.message).toContain("已确认完成 2 次定时任务操作");
    expect(readFileSync(join(business, "demo-vault", "crash-plan.txt"), "utf8")).toBe("disabled");
    expect(recovered.agentFixtureOutboxes?.alice?.text).toEqual([]);
    expect(recovered.feishuFixtureTextOutbox).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

it("retains uncertain workflow ownership on explicit retry without starting another specialist turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-workflow-retry-"));
  const business = mkdtempSync(join(tmpdir(), "dispatch-workflow-files-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business };
  const send = (id: string, dispatchDecision: unknown) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text", mentions: [],
        content: JSON.stringify({ text: "保存并发回这个文件" }) } }, dispatchDecision,
    modelToolCalls: [
      { namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: "uncertain.txt", content: "one submission", overwrite: false } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 0, path: ["fileRef"] } }] } },
    ],
  });
  try {
    dispatchConfig(directory, true); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    await running.post("/api/fixture/feishu/inbound", { applicationControl: { agentId: "jack", mediaOutcomes: ["unknown"] } });
    await send("om_unknown_file", { kind: "dispatch", agentId: "jack", requestId: null, summary: "保存并发送文件", message: "" });
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed" && state.agentFixtureOutboxes?.jack?.text.length === 2);
    expect(failed.agentFixtureOutboxes?.jack?.media).toEqual([expect.objectContaining({ fileName: "uncertain.txt", bytesBase64: Buffer.from("one submission").toString("base64") })]);
    expect(failed.workflows?.runs.filter(({ workflowId }) => workflowId === "weixin.send-files")).toEqual([expect.objectContaining({ status: "outcome_unknown", effects: [expect.objectContaining({ state: "unknown" })] })]);
    const requestId = failed.agentDispatch!.jobs[0]!.id;
    await running.close(); running = await start(directory, env);
    await running.until((state) => state.channels?.feishu?.ready === true);
    await send("om_retry_unknown_file", { kind: "retry", agentId: null, requestId, summary: "", message: "" });
    const retried = await running.until((state) => state.agentFixtureOutboxes?.jack?.text.length === 2);
    expect(retried.fixtureModelRequests).toEqual([]);
    expect(retried.agentFixtureOutboxes?.jack?.media).toEqual([]);
    expect(retried.workflows?.runs.filter(({ workflowId }) => workflowId === "weixin.send-files")).toEqual([expect.objectContaining({ status: "outcome_unknown", effects: [expect.objectContaining({ state: "unknown" })] })]);
    expect(retried.agentFixtureOutboxes?.jack?.text.at(-1)?.message).toContain("无法确认");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);
