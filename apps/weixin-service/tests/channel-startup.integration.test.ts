import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";
import type { PublicCodexServiceState } from "../src/conversation-service.js";

// Real main composition and durable processing; external model/Feishu/Weixin peers are fixtures.
// Live app permissions, delivery and phone receipt require separately authorized user-observed acceptance.
// Cancel uses a canned fixture Router decision; this verifies host effects, not live-model semantics.
type State = { fixtureModelRequests?: Array<{ threadId: string; input: unknown }>; fixtureOutbox?: { kind: string; fileName: string }[]; feishuFixtureMediaOutbox?: { chatId: string; kind: string; bytesBase64: string }[]; weixinFixtureReplies?: { accountId: string; target: string; message: string }[]; channels?: Record<string, { enabled: boolean; ready: boolean }>; feishuFixtureTextOutbox?: { message: string }[]; channel?: string; ready?: boolean; accounts: { accountId: string }[]; codex: PublicCodexServiceState;
  fixtureMediaOutbox?: { chatId: string; kind: string; bytesBase64: string; fileName: string }[];
  workflows?: { runs: { runRef: string; workflowId: string; status: string; steps: unknown[]; effects: unknown[] }[] };
  workflowModulePermissions?: { modules: { moduleId: string; revision: number; scopes: { scopeId: string }[] }[] };
  fixtureTextOutbox?: { message: string }[] };
const config = (channel: "weixin" | "feishu") => ({ channel,
  owner: { memoryAccountId: "fixture-bot", bindings: [
    { channel: "weixin", accountId: "fixture-bot", target: "fixture-user@im.wechat", senderId: "fixture-user@im.wechat" },
    { channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" },
  ] }, taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
  feishu: { appId: "cli_0123456789abcdef", appSecret: "fixture-secret" },
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no_port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const until = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(25);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}
async function start(directory: string, extraEnv: Record<string, string> = {}) {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEMO_MODE: "fixture", PORT: String(port), CHANNEL_CONFIG_PATH: join(directory, "channel.json"),
      WORKFLOW_FIXTURE_STATE_DIRECTORY: directory, WORKFLOW_SIMULATOR_MODEL: "fixture", WORKFLOW_SIMULATOR_PENDING_ROUTER: "fixture", WEIXIN_OTEL_ENABLED: "0", ...extraEnv },
  });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  async function state(): Promise<State> { return await (await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) })).json() as State; }
  async function until(predicate: (value: State) => boolean, timeout = 15000): Promise<State> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture exited: ${output}`);
      try { const value = await state(); if (predicate(value)) return value; } catch { /* bounded startup/readiness */ }
      await delay(30);
    }
    throw new Error(`fixture condition timed out: ${JSON.stringify(await state())}\n${output}`);
  }
  try { await until((value) => value.channel === "feishu" ? value.ready === true : value.codex?.enabledTargets.length > 0); }
  catch (error) { await stop(child); throw error; }
  return { state, until, close: async () => { await stop(child); expect(child.exitCode, output).toBe(0); },
    async post(route: string, body: unknown) {
      const response = await fetch(`${url}${route}`, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status, await response.clone().text()).toBe(200);
    } };
}

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
