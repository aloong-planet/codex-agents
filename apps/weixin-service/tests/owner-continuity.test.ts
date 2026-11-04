import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationService, type AccountMemoryControl, type CodexAgent } from "../src/conversation-service.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowModulePermissionSettings } from "../src/workflow-module-permission-settings.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import type { ConversationChannel, InboundMessage } from "../src/channel-contract.js";
import { PersonalOwnerIdentity, type PersonalChannel } from "../src/personal-owner-identity.js";
import { scriptedTurnRunner } from "./fixtures/scripted-turn-runner.js";

// Public conversation/persistence seam. Fixture identity data is already host-decoded;
// authenticated Feishu framing and real phone receipt require ticket 05 and live acceptance.
const directories: string[] = [];
const services: ConversationService[] = [];
const permissions: WorkflowModulePermissionStore[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of permissions.splice(0)) await store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-continuity-"));
  directories.push(root);
  return root;
}
function owner(channel: PersonalChannel, senderId = "same-person") {
  return new PersonalOwnerIdentity({ memoryAccountId: "legacy-bot", bindings: [
    { channel: "weixin", accountId: "legacy-bot", target: "owner@im.wechat", senderId: "owner@im.wechat" },
    { channel: "feishu", accountId: "new-app", target: "new-chat", senderId },
  ] }, channel);
}
function harness(root: string, selected: PersonalChannel, memory?: AccountMemoryControl, senderId = "same-person") {
  const identity = owner(selected, senderId), address = identity.conversationAddress();
  let listener: (event: InboundMessage) => Promise<void> = async () => {};
  const outbox: string[] = [], prompts: string[] = [];
  const channel: ConversationChannel = {
    maxReplyCodePoints: 8000,
    getSnapshot: () => ({ accounts: [{ accountId: address.accountId, credentialStatus: "usable" }], targets: [address] }),
    onInboundText: (next) => { listener = next; return () => { listener = async () => {}; }; },
    onInboundRejected: () => () => {},
    sendText: async (_reference, text) => { outbox.push(text); return { ok: true }; },
    startTyping: async () => undefined,
    sendProgress: async () => undefined,
  };
  const startOrResume = vi.fn(async (threadId?: string) => threadId ?? crypto.randomUUID());
  const agent: CodexAgent = {
    startOrResume, close: () => {},
    runTurn: scriptedTurnRunner(async (_threadId, input) => {
      prompts.push(JSON.stringify(input));
      return JSON.stringify({ message: "已收到。", results: [] });
    }),
  };
  const store = new CodexServiceStore(path.join(root, "state", "conversation.json"));
  const service = new ConversationService(channel, agent, store, root, Date.now, undefined, [root], true, undefined, {
    prepare: (_threadId, message, options) => ({ prepare: async () => ({ input: [{ type: "text", text: `${message.text}\n${options.accountMemory}` }] }) }),
  }, undefined, memory, undefined, undefined, undefined, undefined, identity);
  services.push(service);
  const emit = async (overrides: Partial<InboundMessage> = {}, omitIdentity = false) => {
    const message: InboundMessage = {
    ...address, senderId: selected === "weixin" ? "owner@im.wechat" : "same-person", conversationType: "private",
    deliveryRef: crypto.randomUUID(), key: crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex"),
    messageId: crypto.randomUUID(), text: "继续讨论", source: "text", receivedAt: Date.now(), ...overrides,
    };
    if (omitIdentity) delete message.senderId;
    return listener(message);
  };
  return { service, store, emit, outbox, prompts, startOrResume, address };
}

describe("personal continuity through the conversation core", () => {
  it("shares one memory scope while retaining distinct persisted histories on restart", async () => {
    const root = directory();
    const memoryRoot = path.join(root, "memory");
    const capturedScopes: string[] = [];
    const memoryStore = new AccountMemoryStore(memoryRoot);
    const memory: AccountMemoryControl = {
      start: async () => {}, enable: () => {}, disable: () => {}, close: () => {},
      recall: (account) => memoryStore.read(account).markdown,
      captureTurn: async (turn) => {
        capturedScopes.push(turn.accountId);
        const snapshot = memoryStore.read(turn.accountId);
        if (snapshot.entries.length === 0) memoryStore.apply(turn.accountId, {
          batchId: turn.userEntry.id, basedOnRevision: snapshot.revision, evidenceEntryIds: new Set([turn.userEntry.id]),
          mutations: [{ op: "add", id: "preference-language", category: "preferences", value: "偏好：中文回复", evidenceEntryIds: [turn.userEntry.id], confidence: 1 }],
        });
        return { queued: true };
      },
    };
    const first = harness(root, "weixin", memory);
    await first.service.start(); await first.service.enable(first.address.accountId, first.address.target);
    await first.emit(); await first.service.close();
    const reopenedMemoryStore = new AccountMemoryStore(memoryRoot);
    const second = harness(root, "feishu", { ...memory, recall: (account) => reopenedMemoryStore.read(account).markdown });
    await second.service.start(); await second.service.enable(second.address.accountId, second.address.target);
    await second.emit();
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain("偏好：中文回复");
    expect(capturedScopes).toEqual(["legacy-bot", "legacy-bot"]);
    expect(reopenedMemoryStore.read("legacy-bot").entries.map((entry) => entry.value)).toEqual(["偏好：中文回复"]);
    expect(second.service.getPublicState().transcript.filter((entry) => entry.role === "user").map((entry) => entry.target))
      .toEqual(["owner@im.wechat", second.address.target]);
    expect(second.outbox.at(-1)).toBe("已收到。");
    await second.service.close();
    const restored = harness(root, "weixin", memory);
    await restored.service.start();
    expect(restored.startOrResume.mock.calls[0]?.[0]).toBe(await first.startOrResume.mock.results[0]!.value);
  });

  it("preserves permission selection and invalidates both stored threads after revocation", async () => {
    const root = directory();
    const first = harness(root, "weixin");
    await first.service.start(); await first.service.enable(first.address.accountId, first.address.target);
    first.service.configurePermissions({ mode: "safe", rootIds: ["workspace"], confirmed: true });
    const savedPermissions = first.service.getPublicState().permissions;
    const moduleStore = new WorkflowModulePermissionStore(path.join(root, "permissions.db"));
    permissions.push(moduleStore);
    const definitions = [{ moduleId: "notes", name: "Notes", description: "Owner notes", scopes: [{ scopeId: "notes", label: "Notes", directory: root }] }];
    new WorkflowModulePermissionSettings(moduleStore, definitions).configure({ moduleId: "notes", expectedRevision: 0, confirmed: true, scopes: [{ scopeId: "notes", read: true, write: false }] });
    await first.service.close();
    const second = harness(root, "feishu");
    await second.service.start(); await second.service.enable(second.address.accountId, second.address.target);
    expect(second.service.getPublicState().permissions).toEqual(savedPermissions);
    const moduleSettings = new WorkflowModulePermissionSettings(moduleStore, definitions, () => second.service.narrowFileAccessContext());
    expect(moduleSettings.getPublicState().modules[0]?.scopes[0]).toMatchObject({ read: true, write: false });
    expect(() => moduleStore.assertAllowed({ moduleId: "notes", scopeId: "notes", access: "write" })).toThrow("workflow_module_permission_denied");
    expect(() => moduleStore.assertAllowed({ moduleId: "notes", scopeId: "unapproved", access: "read" })).toThrow("workflow_module_permission_denied");
    moduleSettings.configure({ moduleId: "notes", expectedRevision: 1, confirmed: true, scopes: [{ scopeId: "notes", read: false, write: false }] });
    expect(() => moduleStore.assertAllowed({ moduleId: "notes", scopeId: "notes", access: "read" })).toThrow("workflow_module_permission_denied");
    await second.emit();
    expect(second.startOrResume.mock.calls.map((call) => call[0])).toEqual([undefined, undefined]);
    await second.service.close();
    const restored = harness(root, "weixin");
    await restored.service.start();
    expect(restored.startOrResume).toHaveBeenCalledExactlyOnceWith(undefined, root, [root]);
    expect(restored.service.getPublicState().permissions).toEqual(savedPermissions);
    await restored.emit();
    expect(restored.outbox.at(-1)).toBe("已收到。");
  });

  it("does not restore a model thread after its trusted sender binding changes", async () => {
    const root = directory();
    const first = harness(root, "feishu");
    await first.service.start(); await first.service.enable(first.address.accountId, first.address.target);
    await first.emit(); await first.service.close();
    const changed = harness(root, "feishu", undefined, "new-owner-binding");
    await changed.service.start();
    expect(changed.startOrResume).toHaveBeenCalledExactlyOnceWith(undefined, root, [root]);
  });

  it("does not invoke model or send replies for foreign, group or missing identity", async () => {
    const current = harness(directory(), "feishu");
    await current.service.start(); await current.service.enable(current.address.accountId, current.address.target);
    await current.emit({ senderId: "stranger" });
    await current.emit({ conversationType: "group" });
    await current.emit({}, true);
    expect(current.prompts).toEqual([]); expect(current.outbox).toEqual([]);
    await current.emit();
    expect(current.prompts).toHaveLength(1); expect(current.outbox.at(-1)).toBe("已收到。");
    await expect(current.service.enable(current.address.accountId, "foreign")).rejects.toThrow("owner_identity_unbound");
  });
});
