// Persisted scheduler/public tool seam. No real Feishu credentials or phone delivery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import { OwnerNotificationRoute, type NotificationChannel, type NotificationDestination } from "../src/notification-channel.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const scope = { accountId: "legacy-bot", target: "owner@im.wechat" };
const feishu = { accountId: "feishu.app", target: "feishu.owner", channel: "feishu" as const };
const trusted: TrustedWorkflowTurn = { ...scope, eventKey: "create-1", occurredAt: 0, originalTextRef: "source", attachmentRefs: [] };
function call(service: ScheduledTasks, tool: string, args: Record<string, unknown>, turn = trusted) {
  return service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, turn);
}

describe("scheduled channel routing", () => {
  it("keeps creation destinations while both conversations manage shared tasks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-dual-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let now = Date.parse("2026-10-30T00:00:00Z");
    const outbox: Array<NotificationDestination & { message: string }> = [];
    const route = new OwnerNotificationRoute({ memoryAccountId: scope.accountId, scope, selected: feishu,
      destinations: [{ ...scope, channel: "weixin" }, feishu] });
    const open = () => {
      const service = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => now,
        notificationRoute: route, readOriginalText: () => "每小时提醒喝水", channel: {
          state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "ready", contextGeneration: "ready" }),
          send: async ({ accountId, target, channel, message, beforeSubmit }) => {
            expect(beforeSubmit()).toBe(true); outbox.push({ accountId, target, ...(channel ? { channel } : {}), message }); return { ok: true };
          },
        } });
      cleanup.push(() => service.close()); return service;
    };
    let service = open();
    const args = { name: "喝水", instruction: "喝水", reminderText: "喝水", reminderMode: "verbatim",
      sourceText: "每小时提醒喝水", intervalSeconds: 3600 };
    const wx = await call(service, "create", args) as { task: { id: string } };
    const fsTask = await call(service, "create", args, { ...trusted, ...feishu, eventKey: "fs-create" }) as { task: { id: string } };
    expect(wx).toHaveProperty("task.id"); expect(fsTask).toHaveProperty("task.id");
    expect(wx.task.id).not.toBe(fsTask.task.id);
    expect(await call(service, "list", {})).toMatchObject({ total: 1, totalAll: 1, tasks: [{ id: wx.task.id }] });
    expect(await call(service, "list", {}, { ...trusted, ...feishu })).toMatchObject({ total: 1, tasks: [{ id: fsTask.task.id }] });
    expect(await call(service, "list", { scope: "all_channels", limit: 1 })).toMatchObject({ total: 2, totalAll: 2, nextOffset: 1 });
    const all = await call(service, "list", { scope: "all_channels" }) as { tasks: Array<{ id: string }> };
    expect(all.tasks.map((task) => task.id).sort()).toEqual([wx.task.id, fsTask.task.id].sort());

    expect(await call(service, "edit", { reference: wx.task.id, expectedRevision: 1, sourceText: "每小时提醒喝水", name: "水杯" },
      { ...trusted, ...feishu, eventKey: "fs-edit" })).toMatchObject({ status: "updated" });
    service.close(); service = open();
    now += 3_600_000; await service.tick();
    expect(outbox).toHaveLength(2);
    expect(outbox).toEqual(expect.arrayContaining([
      { accountId: "legacy-bot", target: "owner@im.wechat", message: "喝水" },
      { accountId: "feishu.app", target: "feishu.owner", channel: "feishu", message: "喝水" },
    ]));
    expect(await call(service, "inspect", { reference: wx.task.id }, { ...trusted, ...feishu })).toMatchObject({
      task: { id: wx.task.id, name: "水杯", notificationDestination: { channel: "weixin", accountId: "legacy-bot", target: "owner@im.wechat" } },
    });
    expect(await call(service, "inspect", { reference: fsTask.task.id })).toMatchObject({
      task: { id: fsTask.task.id, notificationDestination: { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" } },
    });
    expect(await call(service, "create", args, { ...trusted, target: "foreign" })).toEqual({ status: "error", code: "target_disabled" });
  });
  it("isolates unavailable destinations and returns research failure notices to their creation chat", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-dual-failure-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let now = Date.parse("2026-10-30T00:00:00Z"), feishuEnabled = true;
    const outbox: Array<{ accountId: string; message: string }> = [];
    const service = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => now,
      notificationRoute: new OwnerNotificationRoute({ memoryAccountId: scope.accountId, scope, selected: feishu,
        destinations: [{ ...scope, channel: "weixin" }, feishu] }),
      research: async () => { throw new Error("network unavailable"); }, readOriginalText: () => "每小时提醒喝水", channel: {
        state: (address) => ({ enabled: address.accountId === "legacy-bot" || feishuEnabled,
          credentialStatus: "usable", credentialGeneration: "ready", contextGeneration: "ready" }),
        send: async ({ accountId, message, beforeSubmit }) => { expect(beforeSubmit()).toBe(true); outbox.push({ accountId, message }); return { ok: true }; },
      } });
    cleanup.push(() => service.close());
    const common = { name: "喝水", instruction: "喝水", sourceText: "每小时提醒喝水", intervalSeconds: 3600 };
    expect(await call(service, "create", { ...common, reminderText: "喝水", reminderMode: "verbatim" })).toMatchObject({ status: "created" });
    const created = await call(service, "create", { ...common, template: "researched_text" },
      { ...trusted, ...feishu, eventKey: "fs-research" }) as { task: { id: string } };
    expect(created).toHaveProperty("task.id");
    feishuEnabled = false; now += 3_600_000; await service.tick();
    expect(outbox).toEqual([{ accountId: "legacy-bot", message: "喝水" }]);
    expect(await call(service, "inspect", { reference: created.task.id })).toMatchObject({ totalOccurrences: 0, task: { currentBlocker: { code: "target_disabled" } } });
    feishuEnabled = true; await service.tick();
    expect(outbox).toHaveLength(2);
    expect(outbox[1]).toMatchObject({ accountId: "feishu.app", message: expect.stringContaining("定时任务需要处理：喝水") });
    expect(await call(service, "inspect", { reference: created.task.id })).toMatchObject({
      history: [{ execution: "failed", deliveryDestination: { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" } }],
      notifications: [{ stage: "research", delivery: "accepted" }],
    });
  });
  it.each(["reminder", "researched_text"] as const)("preserves %s task identity across restart", async (template) => {
    await checkRestart(template, "accepted");
  });
  it.each(["unknown", "pending"] as const)("does not replay a legacy %s receipt on the selected channel", async (outcome) => {
    await checkRestart("reminder", outcome);
  });
  it.each(["accepted", "unknown", "pending"] as const)("migrates only future preferences and preserves legacy %s history twice", async (outcome) => {
    await checkRestart("reminder", outcome, true);
  });
  async function checkRestart(template: "reminder" | "researched_text", outcome: "accepted" | "unknown" | "pending", dual = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-route-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let now = Date.parse("2026-10-30T00:00:00Z");
    const outbox: Array<NotificationDestination & { message: string }> = [];
    let switched = false;
    const channel: NotificationChannel = {
      state: (address) => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "ready", contextGeneration: address.accountId === "legacy-bot" && outcome === "pending" ? null : "ready" }),
      send: async ({ accountId, target, channel, message, beforeSubmit }) => { expect(beforeSubmit()).toBe(true); outbox.push({ accountId, target, ...(channel ? { channel } : {}), message }); return !switched && outcome === "unknown" ? { ok: false, reason: "unknown" } : { ok: true }; },
    };
    const create = (route?: OwnerNotificationRoute) => {
      const service = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => now, channel,
        research: async () => "喝水", readOriginalText: () => "每小时提醒喝水", ...(route ? { notificationRoute: route } : {}) });
      cleanup.push(() => service.close()); return service;
    };
    const legacy = create();
    const created = await call(legacy, "create", { template, name: "喝水", instruction: "喝水", ...(template === "reminder" ? { reminderText: "喝水", reminderMode: "verbatim" } : {}),
      timezone: "Asia/Shanghai", sourceText: "每小时提醒喝水", intervalSeconds: 3600 }) as { task: { id: string } };
    expect(created).toHaveProperty("task.id");
    now += 3_600_000; await legacy.tick();
    expect(outbox).toEqual(outcome === "pending" ? [] : [{ accountId: "legacy-bot", target: "owner@im.wechat", message: "喝水" }]);
    legacy.close(); switched = true;
    const routing = new OwnerNotificationRoute({ memoryAccountId: scope.accountId, scope, selected: feishu,
      ...(dual ? { destinations: [{ ...scope, channel: "weixin" as const }, feishu] } : {}) });
    if (dual) {
      expect(() => create(new OwnerNotificationRoute({ memoryAccountId: scope.accountId, scope,
        selected: { ...scope, channel: "weixin" }, destinations: [{ ...scope, channel: "weixin" }] })))
        .toThrow("notification_migration_feishu_binding_required");
      const first = create(routing);
      expect(await call(first, "inspect", { reference: created.task.id })).toMatchObject({ task: {
        id: created.task.id, revision: 1, notificationDestination: { channel: "feishu", accountId: "feishu.app", target: "feishu.owner" },
      } });
      expect(await call(first, "list", {})).toMatchObject({ tasks: [], total: 0, totalAll: 0, completedTotal: 0 });
      expect(await call(first, "list", {}, { ...trusted, ...feishu })).toMatchObject({ total: 1, tasks: [{ id: created.task.id }] });
      expect(await call(first, "list", { scope: "all_channels" })).toMatchObject({ total: 1, tasks: [{ id: created.task.id }] });
      first.close();
    }
    const current = create(routing);
    const currentTurn = { ...trusted, ...feishu, eventKey: "inspect-new" };
    expect(await call(current, "list", {}, currentTurn)).toMatchObject({ total: 1, tasks: [{ id: created.task.id }] });
    await current.tick(); expect(outbox).toHaveLength(outcome === "pending" ? 0 : 1);
    now += 3_600_000; await current.tick();
    expect(outbox).toEqual([...(outcome === "pending" ? [] : [{ accountId: "legacy-bot", target: "owner@im.wechat", message: "喝水" }]), { accountId: "feishu.app", target: "feishu.owner", channel: "feishu", message: "喝水" }]);
    const detail = await call(current, "inspect", { reference: created.task.id }, currentTurn);
    expect(detail).toMatchObject({ task: { id: created.task.id, destination: { accountId: "legacy-bot", target: "owner@im.wechat" } }, history: [
      { destination: { accountId: "legacy-bot", target: "owner@im.wechat" }, deliveryDestination: { accountId: "feishu.app", target: "feishu.owner", channel: "feishu" }, delivery: "accepted" },
      { destination: { accountId: "legacy-bot", target: "owner@im.wechat" }, delivery: outcome === "pending" ? "pending_inbound" : outcome },
    ] });
    expect((detail as { history: unknown[] }).history[1]).not.toHaveProperty("deliveryDestination");
    expect(await call(current, "list", {}, { ...currentTurn, target: "foreign" })).toEqual({ status: "error", code: "target_disabled" });
    expect(current.memoryContext(scope.accountId, [feishu.target])).toEqual([{ id: created.task.id, name: "喝水", revision: 1, template }]);
  }
  it("keeps a selected conversation intent owned by its existing scheduled task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-owner-route-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const service = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), readOriginalText: () => "每小时提醒喝水",
      notificationRoute: new OwnerNotificationRoute({ memoryAccountId: scope.accountId, scope, selected: feishu }) });
    cleanup.push(() => service.close());
    const result = await call(service, "create", { name: "喝水", instruction: "喝水", reminderText: "喝水", reminderMode: "verbatim",
      timezone: "Asia/Shanghai", sourceText: "每小时提醒喝水", intervalSeconds: 3600 }, { ...trusted, ...feishu });
    expect(result).toMatchObject({ status: "created" });
    const admission = service.memoryAdmission([{ accountId: scope.accountId, target: feishu.target, eventKey: trusted.eventKey,
      originalText: "每小时提醒喝水", sourceText: "每小时提醒喝水", owner: "plan-water" }]);
    expect(admission.reserve("plan-water")).toBe(false);
  });

});
