import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationChannelRouter } from "../src/conversation-channel-router.js";
import { ConversationService, type AccountMemoryControl, type CodexAgent } from "../src/conversation-service.js";
import { PersonalOwnerDirectory, PersonalOwnerIdentity, type PersonalChannel } from "../src/personal-owner-identity.js";
import type { ConversationChannel, ConversationTurnFactory, DeliveryReference, InboundMessage, RejectedInboundMessage } from "../src/channel-contract.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowModulePermissionSettings } from "../src/workflow-module-permission-settings.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { scriptedTurnRunner, type ScriptedModelReply } from "./fixtures/scripted-turn-runner.js";
import { CodexConversation } from "../src/codex-conversation.js";
import { FixtureAppServerTransport } from "../src/fixture-app-server-transport.js";
import type { AppServerMessage } from "../src/codex-app-server-client.js";

// Public neutral ingress/core seam. Authenticated platform framing, production dual
// startup and phone receipt remain separate adapter/integration acceptance (ticket 12).
// Cheap in-memory channels and writable per-case stores; no live model or child process.
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function route(selected: PersonalChannel) {
  const owner = new PersonalOwnerIdentity({ memoryAccountId: "legacy-bot", bindings: [
    { channel: "weixin", accountId: "legacy-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
    { channel: "feishu", accountId: "app", target: "chat", senderId: "person" },
  ] }, selected);
  const address = owner.conversationAddress();
  let listener: (message: InboundMessage) => Promise<void> = async () => {};
  let rejected: (message: RejectedInboundMessage) => Promise<void> = async () => {};
  const outbox: Array<{ key: string; text: string }> = [];
  const stopTyping = vi.fn(async () => {});
  let typing = false;
  const channel: ConversationChannel = {
    maxReplyCodePoints: selected === "weixin" ? 6 : 80,
    acknowledgementFallback: selected === "weixin" ? "text" : "none",
    getSnapshot: () => ({ accounts: [{ accountId: address.accountId, credentialStatus: "usable" }], targets: [address] }),
    onInboundText: (next) => { listener = next; return () => { listener = async () => {}; }; },
    onInboundRejected: (next) => { rejected = next; return () => { rejected = async () => {}; }; },
    sendText: async (reference, text) => { outbox.push({ key: reference.key, text }); return { ok: true }; },
    startTyping: async () => ({ active: typing, stop: stopTyping }),
    sendProgress: async () => undefined,
  };
  const prepared: InboundMessage[] = [];
  const turns: ConversationTurnFactory = {
    prepare: (_thread, message, options) => {
      prepared.push(message);
      return { prepare: async () => ({ input: [{ type: "text", text: `${message.text}\n${options.accountMemory}` }] }) };
    },
  };
  function message(text: string): InboundMessage {
    return { ...address, senderId: selected === "weixin" ? "owner@im.wechat" : "person", conversationType: "private",
      deliveryRef: "adapter-local-ref", key: crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex"), messageId: crypto.randomUUID(), text, source: "text", receivedAt: Date.now() };
  }
  return { owner, address, channel, turns, outbox, prepared, stopTyping, message,
    nativeTyping: (enabled: boolean) => { typing = enabled; },
    emit: (event: InboundMessage) => listener(event), reject: (event: RejectedInboundMessage) => rejected(event) };
}
function harness(answer: ScriptedModelReply, root?: string, memory?: AccountMemoryControl, realAgent?: CodexAgent) {
  if (!root) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-conversations-"));
    const savedRoot = root;
    cleanup.push(() => fs.rmSync(savedRoot, { recursive: true, force: true }));
  }
  const weixin = route("weixin"), feishu = route("feishu");
  const router = new ConversationChannelRouter([weixin, feishu]);
  const startOrResume = vi.fn(async (threadId?: string) => threadId ?? crypto.randomUUID());
  const close = vi.fn();
  const agent: CodexAgent = realAgent ?? { startOrResume, close, runTurn: scriptedTurnRunner(answer) };
  const service = new ConversationService(router, agent, new CodexServiceStore(path.join(root, "conversation.json")), root,
    Date.now, undefined, [root], true, undefined, router, undefined, memory, undefined, undefined, undefined, undefined,
    new PersonalOwnerDirectory([weixin.owner, feishu.owner]));
  cleanup.push(() => service.close());
  const start = async () => {
    await service.start();
    for (const entry of [weixin, feishu]) await service.enable(entry.address.accountId, entry.address.target);
  };
  return { root, service, router, weixin, feishu, start, startOrResume, close };
}

describe("simultaneous bound conversations", () => {
  it("continues both interrupted original messages through one replacement connection", async () => {
    const peers: Array<{ sent: AppServerMessage[]; exit: () => void }> = [];
    let submitted = 0;
    let bothStarted!: () => void;
    const started = new Promise<void>(resolve => { bothStarted = resolve; });
    const agent = new CodexConversation(() => {
      const index = peers.length;
      const sent: AppServerMessage[] = [];
      const peer = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => undefined },
        () => JSON.stringify({ message: "自动恢复正常", results: [] }),
        () => { if (index === 0 && ++submitted === 2) bothStarted(); }, `dual-recovery-${index}`);
      let exited: (error?: Error) => void = () => {};
      peers.push({ sent, exit: () => { peer.close(); exited(new Error("shared model exit")); } });
      return {
        send: message => { sent.push(structuredClone(message)); peer.send(message); },
        onMessage: listener => peer.onMessage(message => {
          if (index === 0 && (message.method === "turn/completed" ||
              (message.params?.item as { type?: string } | undefined)?.type === "agentMessage")) return;
          listener(message);
        }),
        onExit: listener => { exited = listener; return peer.onExit(listener); },
        close: () => peer.close(),
      };
    }, 600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    const live = harness(async () => { throw new Error("protocol peer required"); }, undefined, undefined, agent);
    await live.start(); live.weixin.nativeTyping(true);
    const wx = live.weixin.message("微信请求"), fs = live.feishu.message("飞书请求");
    const pending = Promise.all([live.weixin.emit(wx), live.feishu.emit(fs)]);
    await started; peers[0]!.exit(); await pending;
    expect(peers).toHaveLength(2);
    expect(live.weixin.outbox).toEqual([{ key: wx.key, text: "自动恢复正常" }]);
    expect(live.feishu.outbox).toEqual([{ key: fs.key, text: "自动恢复正常" }]);
    const before = peers[0]!.sent.filter(message => message.method === "turn/start");
    const after = peers[1]!.sent.filter(message => message.method === "turn/start");
    expect(before).toHaveLength(2); expect(after).toHaveLength(2);
    expect(before[0]!.params!.threadId).not.toBe(before[1]!.params!.threadId);
    for (const text of ["微信请求", "飞书请求"]) {
      const original = before.find(m => JSON.stringify(m.params!.input).includes(text));
      const recovered = after.find(m => JSON.stringify(m.params!.input).includes(text));
      expect(original).toBeDefined(); expect(recovered).toBeDefined();
      expect(recovered!.params!.threadId).toBe(original!.params!.threadId);
    }
    expect(live.service.getPublicState().runs.map(run => run.phase)).toEqual(["completed", "completed"]);
  });
  it("recovers both existing conversations after an idle App Server exit without mixing or replaying messages", async () => {
    const peers: Array<{ sent: AppServerMessage[]; exit: () => void }> = [];
    const agent = new CodexConversation(() => {
      const transport = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => undefined },
        () => JSON.stringify({ message: "恢复正常", results: [] }));
      let exit: (error?: Error) => void = () => {};
      const sent: AppServerMessage[] = [];
      peers.push({ sent, exit: () => { transport.close(); exit(new Error("Codex App Server 已退出（code=1, signal=null）")); } });
      return {
        send: (message) => { sent.push(structuredClone(message)); transport.send(message); },
        onMessage: (listener) => transport.onMessage(listener),
        onExit: (listener) => { exit = listener; return () => {}; },
        close: () => transport.close(),
      };
    });
    const live = harness(async () => { throw new Error("real protocol peer required"); }, undefined, undefined, agent);
    await live.start();
    live.weixin.nativeTyping(true);
    await live.weixin.emit(live.weixin.message("微信断线前"));
    await live.feishu.emit(live.feishu.message("飞书断线前"));
    const before = peers[0]!.sent.filter((message) => message.method === "turn/start");
    expect(before).toHaveLength(2);
    expect(before[0]!.params!.threadId).not.toBe(before[1]!.params!.threadId);
    peers[0]!.exit();
    const readinessDuringOutage = live.service.getPublicState().threadReady;
    const wx = live.weixin.message("微信恢复后");
    const fs = live.feishu.message("帮我研究下这个开源skill lemon opuscar");
    await Promise.all([live.weixin.emit(wx), live.feishu.emit(fs)]);
    expect(live.weixin.outbox).toContainEqual({ key: wx.key, text: "恢复正常" });
    expect(live.feishu.outbox).toContainEqual({ key: fs.key, text: "恢复正常" });
    expect(readinessDuringOutage).toBe(false);
    expect(live.service.getPublicState().threadReady).toBe(true);
    expect(peers).toHaveLength(2);
    const resumed = peers[1]!.sent.filter((message) => message.method === "thread/resume");
    expect(resumed.map((message) => message.params!.threadId).sort())
      .toEqual(before.map((message) => message.params!.threadId).sort());
    const after = peers[1]!.sent.filter((message) => message.method === "turn/start");
    expect(after).toHaveLength(2);
    for (const [text, threadId] of [["微信恢复后", before[0]!.params!.threadId], ["lemon opuscar", before[1]!.params!.threadId]]) {
      const submitted = after.find((message) => JSON.stringify(message.params!.input).includes(String(text)));
      expect(submitted?.params!.threadId).toBe(threadId);
    }
    expect(live.weixin.outbox).toHaveLength(2);
    expect(live.feishu.outbox).toHaveLength(2);
    expect(live.service.getPublicState().runs.map((run) => run.phase)).toEqual(["completed", "completed"]);
  });
  it("routes JSON reply references to original adapters, rejects tampering and releases success/failure bindings", async () => {
    const wx = route("weixin"), feishu = route("feishu");
    const router = new ConversationChannelRouter([wx, feishu]);
    const release = deferred(), entered = deferred();
    const refs: DeliveryReference[] = [];
    router.onInboundText(async (event) => {
      refs.push(structuredClone(event));
      if (event.text === "hold") { entered.resolve(); await release.promise; }
      expect(() => router.sendText({ ...event, target: "foreign" }, "wrong")).toThrow("conversation_delivery_reference_unavailable");
      expect(() => router.sendText({ ...event, senderId: "foreign" }, "wrong")).toThrow("conversation_delivery_reference_unavailable");
      router.prepare("thread", event, { accountMemory: "", outboundRoots: [], isClosing: () => false });
      await router.sendText(JSON.parse(JSON.stringify(event)) as DeliveryReference, event.text);
      if (event.text === "fail") throw new Error("handler_failed");
    });
    const first = wx.message("hold");
    const pending = wx.emit(first);
    await entered.promise;
    const second = feishu.message("done");
    await feishu.emit(second);
    expect(feishu.outbox.map((item) => item.text)).toEqual(["done"]);
    expect(wx.outbox).toEqual([]);
    release.resolve(); await pending;
    expect(wx.outbox.map((item) => item.text)).toEqual(["hold"]);
    expect(wx.prepared[0]).toBe(first); expect(feishu.prepared[0]).toBe(second);
    await expect(feishu.emit(feishu.message("fail"))).rejects.toThrow("handler_failed");
    expect(refs).toHaveLength(3);
    expect(new Set(refs.map((ref) => ref.deliveryRef)).size).toBe(3);
    for (const ref of refs) expect(() => router.sendText(ref, "late")).toThrow("conversation_delivery_reference_unavailable");
    const foreign = wx.message("foreign"); foreign.senderId = "foreign";
    await wx.emit(foreign);
    expect(refs).toHaveLength(3);
    router.onInboundRejected(async (event) => { await router.sendText(event, "rejected voice"); });
    const rejected: RejectedInboundMessage = { ...wx.message(""), source: "voice", reason: "voice_transcript_missing" };
    await wx.reject(rejected);
    expect(wx.outbox.map((item) => item.text)).toEqual(["hold", "rejected voice"]);
  });
  it("admits the other chat during a held turn, preserves ordering and shares only curated memory", async () => {
    const entered = deferred(), release = deferred();
    const feishuEntered = deferred(), feishuRelease = deferred();
    const inputs: Array<{ thread: string; text: string }> = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-memory-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const memoryStore = new AccountMemoryStore(path.join(root, "memory"));
    const scopes: string[] = [];
    const memory: AccountMemoryControl = {
      start: vi.fn(async () => {}), close: vi.fn(), enable: () => {}, disable: () => {},
      recall: (account) => memoryStore.read(account).markdown,
      captureTurn: async (turn) => {
        scopes.push(turn.accountId);
        if (turn.userEntry.text === "FS_RAW_1") {
          const before = memoryStore.read(turn.accountId);
          memoryStore.apply(turn.accountId, { batchId: turn.userEntry.id, basedOnRevision: before.revision,
            evidenceEntryIds: new Set([turn.userEntry.id]), mutations: [{ op: "add", id: "language", category: "preferences",
              value: "CURATED: prefers Chinese", evidenceEntryIds: [turn.userEntry.id], confidence: 1 }] });
        }
        return { queued: true };
      },
    };
    const live = harness(async (thread, input) => {
      const text = JSON.stringify(input); inputs.push({ thread, text });
      if (text.includes("WX_RAW_1")) { entered.resolve(); await release.promise; }
      if (text.includes("FS_RAW_1")) { feishuEntered.resolve(); await feishuRelease.promise; }
      return JSON.stringify({ message: text.includes("WX_RAW") ? "微信回答一二三四五" : "飞书完整回答一二三四五", results: [] });
    }, root, memory);
    await live.start();
    const wx1 = live.weixin.emit(live.weixin.message("WX_RAW_1"));
    await entered.promise;
    const wx2 = live.weixin.emit(live.weixin.message("WX_RAW_2"));
    const fs1 = live.feishu.emit(live.feishu.message("FS_RAW_1"));
    await feishuEntered.promise;
    const fs2 = live.feishu.emit(live.feishu.message("FS_RAW_2"));
    expect(inputs).toHaveLength(2);
    feishuRelease.resolve(); await Promise.all([fs1, fs2]);
    expect(inputs).toHaveLength(3);
    expect(inputs[2]!.text).toContain("FS_RAW_2");
    expect(inputs[2]!.text).not.toContain("WX_RAW");
    expect(inputs[2]!.thread).toBe(inputs[1]!.thread);
    expect(inputs[1]!.text).toContain("FS_RAW_1");
    expect(inputs[1]!.text).not.toContain("WX_RAW");
    expect(live.feishu.outbox.map((item) => item.text)).toEqual(["飞书完整回答一二三四五", "飞书完整回答一二三四五"]);
    expect(live.weixin.outbox.map((item) => item.text)).toEqual(["已收到，正在处理。"]);
    release.resolve(); await Promise.all([wx1, wx2]);
    expect(inputs).toHaveLength(4);
    expect(inputs[3]!.text).toContain("WX_RAW_2");
    expect(inputs[3]!.text).toContain("CURATED: prefers Chinese");
    expect(inputs[3]!.text).not.toContain("FS_RAW");
    expect(inputs[0]!.thread).toBe(inputs[3]!.thread);
    expect(inputs[0]!.thread).not.toBe(inputs[1]!.thread);
    expect(live.weixin.outbox.map((item) => item.text)).toEqual(["已收到，正在处理。", "微信回答一二", "已收到，正在处理。", "微信回答一二"]);
    expect(scopes).toEqual(["legacy-bot", "legacy-bot", "legacy-bot", "legacy-bot"]);
    const users = live.service.getPublicState().transcript.filter((entry) => entry.role === "user");
    expect(users.map((entry) => entry.text)).toEqual(["WX_RAW_1", "WX_RAW_2", "FS_RAW_1", "FS_RAW_2"]);
    await live.service.close();
    expect(memory.start).toHaveBeenCalledTimes(1); expect(memory.close).toHaveBeenCalledTimes(1);
    expect(live.close).toHaveBeenCalledTimes(1);
    const reopened = harness(async () => JSON.stringify({ message: "after restart", results: [] }), root, memory);
    await reopened.start();
    expect(reopened.startOrResume.mock.calls.map((call) => call[0]).sort()).toEqual([inputs[0]!.thread, inputs[1]!.thread].sort());
    expect(reopened.service.getPublicState().transcript.filter((entry) => entry.role === "user").map((entry) => entry.text))
      .toEqual(["WX_RAW_1", "WX_RAW_2", "FS_RAW_1", "FS_RAW_2"]);
  });

  it("invalidates both recoverable threads through shared permission settings without widening grants", async () => {
    const reply = async () => JSON.stringify({ message: "ok", results: [] });
    const live = harness(reply);
    await live.start();
    live.service.configurePermissions({ mode: "safe", rootIds: ["workspace"], confirmed: true });
    const saved = live.service.getPublicState().permissions;
    const permissionStore = new WorkflowModulePermissionStore(path.join(live.root, "permissions.db"));
    cleanup.push(() => permissionStore.close());
    const settings = new WorkflowModulePermissionSettings(permissionStore,
      [{ moduleId: "notes", name: "Notes", description: "Notes", scopes: [{ scopeId: "notes", label: "Notes", directory: live.root }] }],
      () => live.service.narrowFileAccessContext());
    settings.configure({ moduleId: "notes", expectedRevision: 0, confirmed: true, scopes: [{ scopeId: "notes", read: true, write: false }] });
    await live.weixin.emit(live.weixin.message("WX_BEFORE"));
    await live.feishu.emit(live.feishu.message("FS_BEFORE"));
    const oldThreads = await Promise.all(live.startOrResume.mock.results.map((result) => result.value));
    expect(() => permissionStore.assertAllowed({ moduleId: "notes", scopeId: "notes", access: "write" })).toThrow("workflow_module_permission_denied");
    expect(() => permissionStore.assertAllowed({ moduleId: "notes", scopeId: "unapproved", access: "read" })).toThrow("workflow_module_permission_denied");
    settings.configure({ moduleId: "notes", expectedRevision: 1, confirmed: true, scopes: [{ scopeId: "notes", read: false, write: false }] });
    expect(() => permissionStore.assertAllowed({ moduleId: "notes", scopeId: "notes", access: "read" })).toThrow("workflow_module_permission_denied");
    await Promise.all([live.weixin.emit(live.weixin.message("WX_AFTER")), live.feishu.emit(live.feishu.message("FS_AFTER"))]);
    expect(live.startOrResume.mock.calls.map((call) => call[0])).toEqual([undefined, undefined, undefined, undefined]);
    const renewed = await Promise.all(live.startOrResume.mock.results.slice(-2).map((result) => result.value));
    expect(renewed.every((thread) => !oldThreads.includes(thread))).toBe(true);
    expect(new Set(renewed).size).toBe(2);
    await live.service.close();
    const reopened = harness(reply, live.root);
    await reopened.start();
    expect(reopened.startOrResume.mock.calls.map((call) => call[0]).sort()).toEqual(renewed.sort());
    expect(reopened.service.getPublicState().permissions).toEqual(saved);
  });

  it("keeps native typing and failures source-bound and rejects non-owner or group turns", async () => {
    const answer = vi.fn(async (_thread: string, input: Parameters<ScriptedModelReply>[1]) => {
      if (JSON.stringify(input).includes("FAIL")) throw new Error("model failed");
      return JSON.stringify({ message: "done", results: [] });
    });
    const live = harness(answer); await live.start();
    live.weixin.nativeTyping(true);
    await live.weixin.emit(live.weixin.message("hello"));
    expect(live.weixin.outbox.map((item) => item.text)).toEqual(["done"]);
    expect(live.weixin.stopTyping).toHaveBeenCalledTimes(1);
    await live.feishu.emit({ ...live.feishu.message("foreign"), senderId: "someone-else" });
    await live.feishu.emit({ ...live.feishu.message("group"), conversationType: "group" });
    expect(answer).toHaveBeenCalledTimes(1);
    await live.feishu.emit(live.feishu.message("FAIL"));
    expect(live.feishu.outbox.map((item) => item.text)).toEqual(["我暂时无法处理这条消息，请稍后再发一条新消息。"]);
    expect(live.weixin.outbox.map((item) => item.text)).toEqual(["done"]);
  });

});
