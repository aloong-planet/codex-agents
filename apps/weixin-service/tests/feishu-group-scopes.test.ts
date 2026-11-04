// Public configuration/scheduler/memory boundaries. Full main ingress and live model/device acceptance are separate checks.
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import type { NotificationDestination } from "../src/notification-channel.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";
import { PlanFollowUpMonitor } from "../src/plan-follow-up-monitor.js";
import { AccountMemorySystem, type MemoryCurationInput } from "../src/account-memory-system.js";
import { ConversationService, type CodexAgent } from "../src/conversation-service.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { ChannelTurnAdapter } from "../src/channel-turn-adapter.js";
import type { ConversationChannel, InboundMessage } from "../src/channel-contract.js";
import { scriptedTurnRunner } from "./fixtures/scripted-turn-runner.js";

const configuration = () => parseChannelStartupConfiguration({ channel: "feishu",
  owner: { memoryAccountId: "personal", bindings: [{ channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" }] },
  taskScope: { accountId: "personal", target: "owner@im.wechat" },
  feishu: { appId: "cli_0123456789abcdef", appSecret: "fixture-secret", groups: [
    { chatId: "oc_alpha", allowedSenderIds: ["ou_alice", "ou_bob"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_bob"] },
  ] },
});

it("shares task management within a group and keeps all-channel queries and delivery inside its scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-task-scope-"));
  const config = configuration();
  let now = Date.parse("2026-11-05T00:00:00Z");
  const alpha = config.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_alice", conversationType: "group" })!;
  const beta = config.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_beta", senderId: "ou_bob", conversationType: "group" })!;
  const privateAddress = config.owner.conversationAddress();
  const outbox: Array<NotificationDestination & { message: string }> = [];
  let originalText = "";
  const open = () => new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => now,
    readOriginalText: () => originalText, notificationRoute: config.notificationRoute,
    dailyNewsActive: () => false,
    research: async ({ destination }) => {
      expect(destination).toEqual(alpha);
      return "Group-only public research report.";
    }, channel: {
      state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "ready", contextGeneration: "ready" }),
      send: async ({ accountId, target, channel, message, beforeSubmit }) => {
        if (!beforeSubmit()) throw new Error("unexpected disabled delivery");
        outbox.push({ accountId, target, ...(channel ? { channel } : {}), message }); return { ok: true };
      },
    } });
  let service = open();
  let sequence = 0;
  const call = (address: { accountId: string; target: string }, tool: string, args: Record<string, unknown>) => {
    originalText = typeof args.sourceText === "string" ? args.sourceText : "";
    const trusted: TrustedWorkflowTurn = { ...address, eventKey: `event-${sequence++}`, occurredAt: now, originalTextRef: "source", attachmentRefs: [] };
    return service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, trusted);
  };
  const create = async (address: { accountId: string; target: string }, name: string) => {
    const result = await call(address, "create", { name, instruction: name, reminderText: name, reminderMode: "verbatim", sourceText: `每小时提醒${name}`, intervalSeconds: 3600 });
    expect(result).toMatchObject({ status: "created", task: { name } });
    return (result as { task: { id: string } }).task.id;
  };
  try {
    const privateId = await create(privateAddress, "private sentinel");
    const alphaId = await create(alpha, "alpha sentinel");
    const betaId = await create(beta, "beta sentinel");
    expect(await call(alpha, "list", { scope: "all_channels", view: "all" })).toMatchObject({ total: 1, totalAll: 1, tasks: [{ id: alphaId }] });
    expect(await call(alpha, "list", { scope: "all_channels" })).not.toHaveProperty("reconciliation");
    expect(await call(privateAddress, "list", { scope: "all_channels" })).toMatchObject({ total: 1, tasks: [{ id: privateId }] });
    expect(await call(privateAddress, "list", {})).toMatchObject({ reconciliation: { code: "daily_news_reconciliation_pending" } });
    for (const id of [privateId, betaId]) {
      expect(await call(alpha, "inspect", { reference: id })).toMatchObject({ status: "not_found" });
      expect(await call(alpha, "read_text", { reference: id, field: "instruction" })).toMatchObject({ status: "not_found" });
      expect(await call(alpha, "delete", { reference: id, expectedRevision: 1, sourceText: "每小时提醒喝水" })).toMatchObject({ status: "not_found" });
    }
    const bob = config.owner.admit({ accountId: "cli_0123456789abcdef", target: "oc_alpha", senderId: "ou_bob", conversationType: "group" })!;
    expect(await call(bob, "edit", { reference: alphaId, expectedRevision: 1, sourceText: "每小时提醒喝水", name: "alpha edited" })).toMatchObject({ status: "updated" });
    service.close(); service = open();
    now += 3_600_000; await service.tick();
    expect(outbox).toHaveLength(3);
    expect(outbox.find((item) => item.target === alpha.target)).toMatchObject({ channel: "feishu", message: "alpha sentinel" });
    expect(outbox.find((item) => item.target === beta.target)).toMatchObject({ channel: "feishu", message: "beta sentinel" });
    expect(outbox.find((item) => item.target === privateAddress.target)).toMatchObject({ channel: "feishu", message: "private sentinel" });
    expect(await call(alpha, "inspect", { reference: alphaId })).toMatchObject({ task: { name: "alpha edited" }, totalOccurrences: 1 });
    expect(service.memoryContext(config.owner.memoryScope(alpha.accountId, alpha.target), [alpha.target])).toMatchObject([{ id: alphaId }]);
    expect(service.memoryContext(config.owner.memoryScope(alpha.accountId, alpha.target), [beta.target])).toEqual([]);
    expect(await call(alpha, "create", { name: "group research", template: "researched_text", instruction: "Research public TypeScript releases", sourceText: "Research public TypeScript releases", at: new Date(now + 1000).toISOString() })).toMatchObject({ status: "created" });
    now += 1000; await service.tick();
    expect(outbox.filter((item) => item.message === "Group-only public research report.")).toEqual([{ ...alpha, channel: "feishu", message: "Group-only public research report." }]);
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("curates and delivers group plans without reading or migrating private plan memory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-memory-scope-"));
  const config = configuration();
  const now = Date.parse("2026-11-05T12:05:00+08:00");
  const store = new AccountMemoryStore(root, () => now);
  const host = new AccountMemoryToolHost(store, undefined, undefined, config.notificationRoute);
  const sends: Array<NotificationDestination & { message: string }> = [];
  const addresses = config.owner.conversationAddresses();
  const summaries = ["私人计划", "甲群计划", "乙群计划"];
  const monitor = new PlanFollowUpMonitor({ store, notificationRoute: config.notificationRoute, now: () => now,
    sender: async (input) => { sends.push(input); return { ok: true }; } });
  try {
    for (const [index, address] of addresses.entries()) {
      const accountId = config.owner.memoryScope(address.accountId, address.target);
      const summary = summaries[index]!;
      store.confirmNotificationTarget(accountId, address.target);
      expect(await host.commit({ accountId, jobId: `job-${index}`, batchId: `batch-${index}`, mutationPolicy: { mode: "reconcile" },
        evidenceEntryIds: ["source"], evidenceTexts: { source: `今天中午12点${summary}` }, evidenceLocalDates: { source: "2026-11-05" },
        evidenceOrigins: { source: { eventKey: `event-${index}`, target: address.target } },
      }, { batchId: `batch-${index}`, basedOnRevision: 0, decisions: [{ kind: "record_event", eventKind: "planned", localDate: "2026-11-05",
        timePrecision: "exact", localTime: "12:00", summary, sourceText: `今天中午12点${summary}`, planMatch: null, evidenceEntryIds: ["source"], confidence: 1 }] }))
        .toMatchObject({ status: "committed", receipt: { eventsAdded: 1 } });
    }
    const memoryScopes = addresses.map((item) => config.owner.memoryScope(item.accountId, item.target));
    await monitor.runNow([...memoryScopes, "unbound-memory"]);
    expect(sends).toHaveLength(3);
    for (const [index, address] of addresses.entries()) {
      const delivered = sends.find((item) => item.target === address.target)!;
      expect(delivered).toBeDefined(); expect(delivered.channel).toBe("feishu");
      expect(delivered.message).toContain(summaries[index]);
      for (const [otherIndex, summary] of summaries.entries()) if (otherIndex !== index) expect(delivered.message).not.toContain(summary);
      expect(store.read(memoryScopes[index]!).events).toHaveLength(1);
      expect(store.latestReminderContext(memoryScopes[index]!, address.target)?.plans).toHaveLength(1);
      expect(config.notificationRoute.captureMemory(memoryScopes[index]!, addresses[(index + 1) % 3]!.target)).toBeUndefined();
    }
    await monitor.close();
    const reopened = new PlanFollowUpMonitor({ store: new AccountMemoryStore(root, () => now), notificationRoute: config.notificationRoute, now: () => now,
      sender: async (input) => { sends.push(input); return { ok: true }; } });
    try { await reopened.runNow(memoryScopes); expect(sends).toHaveLength(3); } finally { await reopened.close(); }
  } finally { await monitor.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("shares a group thread across members and isolates recalled and captured memory after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-conversation-scope-"));
  const config = configuration();
  const [privateAddress, alpha, beta] = config.owner.conversationAddresses();
  const addresses = [privateAddress!, alpha!, beta!];
  const sentinels = ["private-memory-sentinel", "alpha-memory-sentinel", "beta-memory-sentinel"];
  const store = new AccountMemoryStore(path.join(root, "memory"));
  for (const [index, address] of addresses.entries()) store.apply(config.owner.memoryScope(address.accountId, address.target), {
    batchId: `seed-${index}`, basedOnRevision: 0, evidenceEntryIds: new Set(["source"]),
    mutations: [{ op: "add", id: `preference-${index}`, category: "preferences", value: sentinels[index]!, evidenceEntryIds: ["source"], confidence: 1 }],
  });
  const curated: MemoryCurationInput[] = [];
  const prompts: Array<{ thread: string; text: string }> = [];
  const outbox: string[] = [];
  const open = () => {
    let inbound: (event: InboundMessage) => Promise<void> = async () => {};
    const channel: ConversationChannel = {
      maxReplyCodePoints: 8000, acknowledgementFallback: "none",
      getSnapshot: () => ({ accounts: [{ accountId: privateAddress!.accountId, credentialStatus: "usable" }], targets: addresses }),
      onInboundText: (listener) => { inbound = listener; return () => {}; }, onInboundRejected: () => () => {},
      sendText: async (_address, text) => { outbox.push(text); return { ok: true }; },
      startTyping: async () => undefined, sendProgress: async () => undefined,
    };
    const memory = new AccountMemorySystem({ store, statePath: path.join(root, "memory-state.json"), curator: {
      curate: async (input) => { curated.push(input); return { status: "noop" }; }, close: () => {},
    } });
    const agent: CodexAgent = { startOrResume: async (id) => id ?? crypto.randomUUID(), close: () => {},
      runTurn: scriptedTurnRunner(async (thread, input) => {
        prompts.push({ thread, text: JSON.stringify(input) }); return JSON.stringify({ message: "群讨论已收到。", results: [] });
      }),
    };
    const service = new ConversationService(channel, agent, new CodexServiceStore(path.join(root, "conversation.json")), root,
      Date.now, undefined, [], false, undefined, {
        prepare: (thread, event, options) => new ChannelTurnAdapter(thread, event, { ...options, channelLabel: "飞书", outboundDelivery: false }),
      }, undefined, memory, undefined, undefined, undefined, undefined, config.owner,
      () => ({ agent, cwd: root, runtimeWorkspaceRoots: [] }));
    const emit = (index: number, senderId: string, text: string, discussion?: InboundMessage["discussion"]) => inbound({
      ...addresses[index]!, key: crypto.randomBytes(32).toString("hex"), deliveryRef: crypto.randomUUID(), messageId: crypto.randomUUID(),
      conversationType: index === 0 ? "private" : "group", senderId, text, source: "text", receivedAt: Date.now(),
      ...(discussion ? { discussion } : {}),
    });
    return { service, emit };
  };
  let active = open();
  try {
    await active.service.start();
    for (const address of addresses) await active.service.enable(address.accountId, address.target);
    await active.emit(0, "ou_owner", "继续私人讨论");
    await active.emit(1, "ou_alice", "开始甲群讨论", [{ key: "guest", senderId: "ou_guest", text: "ambient-only-sentinel", receivedAt: 1 }]);
    await active.emit(1, "ou_bob", "继续甲群讨论");
    await active.emit(2, "ou_bob", "开始乙群讨论");
    await vi.waitFor(() => expect(curated).toHaveLength(4));
    expect(prompts).toHaveLength(4);
    expect(outbox).toEqual(["群讨论已收到。", "群讨论已收到。", "群讨论已收到。", "群讨论已收到。"]);
    expect(prompts[1]!.thread).toBe(prompts[2]!.thread);
    expect(new Set([prompts[0]!.thread, prompts[1]!.thread, prompts[3]!.thread]).size).toBe(3);
    expect(prompts[1]!.text).toContain("ou_alice");
    expect(prompts[1]!.text).toContain("ou_guest");
    expect(prompts[1]!.text).toContain("ambient-only-sentinel");
    for (const [promptIndex, memoryIndex] of [0, 1, 1, 2].entries()) {
      expect(prompts[promptIndex]!.text).toContain(sentinels[memoryIndex]);
      for (const [other, sentinel] of sentinels.entries()) if (other !== memoryIndex) expect(prompts[promptIndex]!.text).not.toContain(sentinel);
      expect(curated[promptIndex]!.accountId).toBe(config.owner.memoryScope(addresses[memoryIndex]!.accountId, addresses[memoryIndex]!.target));
    }
    expect(curated.flatMap((input) => input.turns.map((turn) => turn.userEntry.text)))
      .toEqual(["继续私人讨论", "开始甲群讨论", "继续甲群讨论", "开始乙群讨论"]);
    await active.service.close(); active = open(); await active.service.start();
    await active.emit(1, "ou_alice", "重启后继续甲群讨论");
    expect(prompts[4]!.thread).toBe(prompts[1]!.thread);
    expect(prompts[4]!.text).toContain("alpha-memory-sentinel");
    expect(prompts[4]!.text).not.toContain("private-memory-sentinel");
  } finally { await active.service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
