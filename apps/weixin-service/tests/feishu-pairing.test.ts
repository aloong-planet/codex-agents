// Public pairing orchestration with SDK-shaped events and real private files.
// Live credentials, Feishu permissions and OS terminal appearance require user acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runFeishuPairing, type PairingIO, type PairingTransport } from "../src/feishu-pairing.js";
import { pairingEvent, scriptedPairing } from "./support/feishu-pairing.js";
import { PrivateStateStore } from "../src/private-state-store.js";
import { AutoBindingFileStore } from "../src/auto-binding-store.js";
import { loadChannelStartupConfiguration } from "../src/channel-startup-config.js";

const appId = "cli_0123456789abcdef";
const base = () => ({ channel: "weixin", owner: { memoryAccountId: "old-bot", bindings: [
  { channel: "weixin", accountId: "old-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
] }, taskScope: { accountId: "old-bot", target: "owner@im.wechat" }, extension: { keep: true } });
const event = (code: string) => pairingEvent(code, appId);
function harness(pairedApp = appId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-pair-")); fs.chmodSync(dir, 0o700);
  const configPath = path.join(dir, "channel.json");
  fs.writeFileSync(configPath, JSON.stringify(base()), { mode: 0o600 });
  const before = fs.readFileSync(configPath, "utf8");
  const pairing = scriptedPairing(pairedApp, [pairedApp, "hidden-test-secret", "y", "y"]);
  return { dir, configPath, before, output: pairing.output, answers: pairing.answers, io: pairing.io, transport: pairing.transport,
    get closed() { return pairing.closed; }, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
it("P01 pairs via a private message and saves startup-valid configuration without resetting owner state", async () => {
  const h = harness();
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("saved");
    const config = loadChannelStartupConfiguration(h.configPath);
    expect(config.channel).toBe("feishu");
    expect(config.enabledChannels).toEqual(["feishu", "weixin"]);
    expect(config.owner.memoryAccountId).toBe("old-bot");
    expect(config.taskScope).toEqual({ accountId: "old-bot", target: "owner@im.wechat" });
    expect(config.binding).toEqual({ channel: "feishu", accountId: appId, target: "oc_private", senderId: "ou_owner" });
    expect(config.owner.admit({ accountId: appId, target: "oc_private", senderId: "ou_owner", conversationType: "private" })).toBeDefined();
    const saved = JSON.parse(fs.readFileSync(h.configPath, "utf8"));
    expect(saved.owner.bindings[0]).toEqual({ channel: "weixin", accountId: "old-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" });
    expect(saved.extension).toEqual({ keep: true });
    // A first pairing, with no Feishu configuration yet, writes only the application's credentials (channel-switching::US-003/AC-08).
    expect(saved.feishu).toEqual({ appId, appSecret: "hidden-test-secret" });
    expect(fs.statSync(h.configPath).mode & 0o777).toBe(0o600);
    expect(h.closed).toBe(true); expect(h.output.join("\n")).not.toContain("hidden-test-secret");
  } finally { h.cleanup(); }
});

it("P02 ignores unrelated, malformed, group and bot messages and freezes the first matching private candidate", async () => {
  const h = harness(); let receive!: Parameters<PairingTransport["start"]>[0]["message"];
  const originalStart = h.transport.start;
  h.transport.start = async handlers => { receive = handlers.message; await originalStart(handlers); };
  h.io.write = text => {
    h.output.push(text); if (!text.startsWith("PAIR ")) return;
    const accepted = event(text);
    const valid = { ...accepted, message: { ...accepted.message, chat_id: "oc_untrusted" } };
    const invalid = [null, { ...valid, app_id: "cli_ffffffffffffffff" },
      { ...valid, sender: { sender_type: "bot", sender_id: { open_id: "ou_intruder" } } },
      { ...valid, sender: { sender_type: "user", sender_id: { open_id: "ou_bad\u001b" } } },
      { ...valid, message: { ...valid.message, chat_type: "group" } },
      { ...valid, message: { ...valid.message, content: '{"text":"wrong"}' } },
      { ...valid, message: { ...valid.message, content: "broken" } },
      { ...valid, message: { ...valid.message, message_type: "image" } },
      { ...valid, message: { ...valid.message, content: "x".repeat(513) } }];
    for (const input of invalid) void receive(input);
    void receive(accepted);
    void receive({ ...valid, sender: { sender_type: "user", sender_id: { open_id: "ou_later" } } });
  };
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("saved");
    expect(loadChannelStartupConfiguration(h.configPath).binding.senderId).toBe("ou_owner");
    expect(loadChannelStartupConfiguration(h.configPath).binding.target).toBe("oc_private");
  } finally { h.cleanup(); }
});

it.each(["identity", "save", "replace"])("P03 declining %s leaves the original configuration unchanged", async phase => {
  const h = harness();
  if (phase === "identity") h.answers[2] = "";
  if (phase === "save") h.answers[3] = "n";
  if (phase === "replace") {
    fs.writeFileSync(h.configPath, JSON.stringify({ ...base(), owner: { ...base().owner, bindings: [...base().owner.bindings,
      { channel: "feishu", accountId: appId, target: "oc_old", senderId: "ou_old" }] } }));
    h.answers.unshift("n");
  }
  const before = fs.readFileSync(h.configPath, "utf8");
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("cancelled");
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(before);
    if (phase !== "replace") expect(h.closed).toBe(true);
  } finally { h.cleanup(); }
});

it.each(["abort-wait", "abort-confirm", "timeout-wait", "timeout-confirm", "disconnect", "start-failed"])("P03 %s closes the connection without saving or disclosing secrets", async failure => {
  const h = harness(); const stop = new AbortController();
  const originalAsk = h.io.ask;
  h.io.ask = async (prompt, options) => {
    if (prompt.startsWith("这是") && failure.endsWith("confirm")) {
      if (failure.startsWith("abort")) stop.abort();
      return new Promise<string>(() => {});
    }
    return originalAsk(prompt, options);
  };
  let receive!: Parameters<PairingTransport["start"]>[0];
  h.transport.start = async handlers => { receive = handlers; if (failure === "start-failed") throw Error("hidden-test-secret"); };
  h.io.write = text => { h.output.push(text); if (!text.startsWith("PAIR ")) return;
    if (failure === "abort-wait") stop.abort();
    else if (failure === "disconnect") receive.unavailable();
    else if (failure.endsWith("confirm")) void receive.message(event(text));
  };
  try {
    const result = await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport, signal: stop.signal, timeoutMs: 20 });
    expect(result).toBe(failure.startsWith("abort") ? "cancelled" : "failed");
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(h.before);
    expect(h.closed).toBe(true); expect(h.output.join("\n")).not.toContain("hidden-test-secret");
  } finally { h.cleanup(); }
});

it("P05 refuses changed configuration and releases its lock for the next attempt", async () => {
  const h = harness(); const ask = h.io.ask;
  const changed = JSON.stringify({ ...base(), extension: { keep: "external-edit" } });
  h.io.ask = async (prompt, options) => { if (prompt.startsWith("保存此")) fs.writeFileSync(h.configPath, changed); return ask(prompt, options); };
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("failed");
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(changed);
    expect(h.output.join("\n")).toContain("配置发生变化");
    h.answers.push(appId, "another-secret", "y", "y"); h.io.ask = ask;
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("saved");
  } finally { h.cleanup(); }
});

it.each(["accepted", "failed", "idle"] as const)("P04 imports recognized legacy %s identity through existing private stores", async status => {
  const h = harness(); fs.unlinkSync(h.configPath);
  const statePath = path.join(h.dir, "state.json");
  new PrivateStateStore(statePath).save({ version: 1, accountId: "old-bot", token: "legacy-private-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "cursor", userId: "owner@im.wechat", contextTokens: { "owner@im.wechat": "context" } });
  if (status !== "idle") new AutoBindingFileStore(path.join(h.dir, "auto-binding.json")).save({ version: 1, status, accountId: "old-bot", target: "owner@im.wechat", eventKey: "legacy:1", updatedAt: 1234 });
  const originalState = fs.readFileSync(statePath, "utf8");
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath, io: h.io, transport: () => h.transport })).toBe("saved");
    const config = loadChannelStartupConfiguration(h.configPath);
    expect(config.owner.memoryAccountId).toBe("old-bot");
    expect(config.taskScope).toEqual({ accountId: "old-bot", target: "owner@im.wechat" });
    expect(fs.readFileSync(statePath, "utf8")).toBe(originalState);
    expect(h.output.join("\n")).not.toContain("legacy-private-token");
  } finally { h.cleanup(); }
});
it.each(["missing", "ambiguous"])("P04 refuses %s legacy identity before connecting", async kind => {
  const h = harness(); fs.unlinkSync(h.configPath); const statePath = path.join(h.dir, "state.json"); let started = false;
  if (kind === "ambiguous") new PrivateStateStore(statePath).save({ version: 1, accountId: "old-bot", token: "private", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", userId: "owner@im.wechat", contextTokens: { "owner@im.wechat": "a", "other@im.wechat": "b" } });
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath, io: h.io, transport: () => { started = true; return h.transport; } })).toBe("failed");
    expect(started).toBe(false); expect(fs.existsSync(h.configPath)).toBe(false);
  } finally { h.cleanup(); }
});
it("P05 excludes a concurrent wizard without changing configuration", async () => {
  const h = harness(); const stop = new AbortController(); let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const firstIO: PairingIO = { write() {}, async ask() { entered(); return new Promise(() => {}); } };
  const first = runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: firstIO, transport: () => h.transport, signal: stop.signal });
  try {
    await waiting;
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("failed");
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(h.before);
  } finally { stop.abort(); expect(await first).toBe("cancelled"); h.cleanup(); }
});
it.each(["symlink", "permissions", "write-failed"])("P05 refuses %s without replacing the original", async condition => {
  const h = harness(); const original = path.join(h.dir, "original.json");
  if (condition === "symlink") { fs.renameSync(h.configPath, original); fs.symlinkSync(original, h.configPath); }
  if (condition === "permissions") fs.chmodSync(h.configPath, 0o644);
  const ask = h.io.ask;
  h.io.ask = async (prompt, options) => { if (condition === "write-failed" && prompt.startsWith("保存此")) fs.chmodSync(h.dir, 0o500); return ask(prompt, options); };
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("failed");
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(h.before);
  } finally { fs.chmodSync(h.dir, 0o700); h.cleanup(); }
});
it("P08 reprompts malformed credentials before saving the corrected connection", async () => {
  const h = harness();
  h.answers.splice(0, h.answers.length, "not-an-app", appId, "invalid secret", "corrected-secret", "y", "y");
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("saved");
    const config = loadChannelStartupConfiguration(h.configPath);
    expect(config.channel).toBe("feishu");
    expect(config.enabledChannels).toEqual(["feishu", "weixin"]);
    if (config.channel !== "feishu") throw Error("unexpected channel");
    expect(config.connection).toEqual({ appId: "cli_0123456789abcdef", appSecret: "corrected-secret" });
    expect(h.output.join("\n")).toContain("App ID 格式无效");
    expect(h.output.join("\n")).toContain("应用密钥格式无效");
    expect(h.output.join("\n")).not.toContain("corrected-secret");
  } finally { h.cleanup(); }
});

it.each(["legacy-weixin", "weixin", "both", "feishu"])("P09 preserves configured membership when pairing from %s", async (mode) => {
  const h = harness();
  const input = { ...base(),
    ...(mode === "legacy-weixin" ? {} : { channel: undefined, enabledChannels: mode === "both" ? ["weixin", "feishu"] : [mode] }),
    ...(mode === "both" || mode === "feishu" ? { feishu: { appId, appSecret: "previous-secret" },
      owner: { ...base().owner, bindings: [...base().owner.bindings, { channel: "feishu", accountId: appId, target: "oc_previous", senderId: "ou_previous" }] } } : {}),
  };
  fs.writeFileSync(h.configPath, JSON.stringify(input));
  if (mode === "both" || mode === "feishu") h.answers.unshift("y");
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("saved");
    const saved = loadChannelStartupConfiguration(h.configPath);
    expect(saved.enabledChannels).toEqual(mode === "feishu" ? ["feishu"] : ["feishu", "weixin"]);
    expect(saved.taskScope).toEqual({ accountId: "old-bot", target: "owner@im.wechat" });
    expect(saved.owner.memoryAccountId).toBe("old-bot");
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8")).owner.bindings[0]).toEqual({ channel: "weixin", accountId: "old-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" });
    expect(fs.statSync(h.configPath).mode & 0o777).toBe(0o600);
    expect(h.output.join("\n")).toContain(mode === "feishu" ? "下次启动渠道：飞书\n" : "下次启动渠道：飞书、微信\n");
    expect(h.output.join("\n")).not.toContain("hidden-test-secret");
    expect(h.output.join("\n")).not.toContain("previous-secret");
  } finally { h.cleanup(); }
});

// A configured service as the ops guides describe it (docs/ops/feishu-agent-dispatch.md, the service README's webhook section);
// the owner's real channel.json is production data and is not read.
const repairedApp = "cli_fedcba9876543210";
const configured = (dispatch: unknown) => ({ enabledChannels: ["feishu", "weixin"],
  owner: { memoryAccountId: "old-bot", bindings: [
    { channel: "weixin", accountId: "old-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
    { channel: "feishu", accountId: appId, target: "oc_previous", senderId: "ou_previous" }] },
  taskScope: { accountId: "old-bot", target: "owner@im.wechat" }, extension: { keep: true },
  feishu: { appId, appSecret: "previous-secret", receiveMode: "webhook",
    webhook: { port: 8443, path: "/feishu/events", verificationToken: "verify-token", encryptKey: "encrypt-key" },
    groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner", "ou_colleague"] }], dispatch, futureSetting: { kept: true } } });

it("P10 re-pairing another application replaces only its credentials and the owner's Feishu binding, keeping every other Feishu key", async () => {
  const h = harness(repairedApp);
  fs.writeFileSync(h.configPath, JSON.stringify(configured({ groupChatIds: ["oc_alpha"] })));
  h.answers.unshift("y");
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("saved");
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toEqual({ enabledChannels: ["feishu", "weixin"],
      owner: { memoryAccountId: "old-bot", bindings: [
        { channel: "weixin", accountId: "old-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
        { channel: "feishu", accountId: repairedApp, target: "oc_private", senderId: "ou_owner" }] },
      taskScope: { accountId: "old-bot", target: "owner@im.wechat" }, extension: { keep: true },
      feishu: { appId: repairedApp, appSecret: "hidden-test-secret", receiveMode: "webhook",
        webhook: { port: 8443, path: "/feishu/events", verificationToken: "verify-token", encryptKey: "encrypt-key" },
        groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner", "ou_colleague"] }], dispatch: { groupChatIds: ["oc_alpha"] }, futureSetting: { kept: true } } });
    expect(fs.statSync(h.configPath).mode & 0o777).toBe(0o600);
    expect(h.output.join("\n")).not.toMatch(/hidden-test-secret|previous-secret|verify-token|encrypt-key/);
  } finally { h.cleanup(); }
});

it("P05 refuses a re-pair whose kept dispatch roster already uses the new App ID, and releases its lock", async () => {
  const h = harness("cli_1111111111111111");
  fs.writeFileSync(h.configPath, JSON.stringify(configured({ groupChatIds: ["oc_alpha"], agents: [{ id: "sam" },
    { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
    { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" },
    { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }] })));
  const before = fs.readFileSync(h.configPath, "utf8");
  h.answers.unshift("y");
  try {
    expect(await runFeishuPairing({ configPath: h.configPath, statePath: path.join(h.dir, "state.json"), io: h.io, transport: () => h.transport })).toBe("failed");
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(before);
    expect(h.output.join("\n")).toContain("原配置未被本次配对修改。");
    expect(h.closed).toBe(true);
    expect(fs.readdirSync(h.dir).sort()).toEqual(["channel.json"]);
  } finally { h.cleanup(); }
});
