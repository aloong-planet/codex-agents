import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import { WorkflowToolHost, type WorkflowToolRequest } from "../src/workflow-tool-host.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { CodexConversation } from "../src/codex-conversation.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../src/stdio-app-server-transport.js";
import { MAIN_WEIXIN_DISABLED_FEATURES } from "../src/workflow-tool-production.js";
import { WorkflowToolProductionControl } from "../src/workflow-tool-production.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { FixtureAppServerTransport } from "../src/fixture-app-server-transport.js";
import { FixturePort } from "../src/fixture-port.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { WeixinCodexService } from "../src/weixin-codex-service.js";
import { DemoService } from "../src/demo-service.js";
import { createDemoServer } from "../src/http-server.js";

// Only the model and external channel vary; HTTP ingress, main turn, host and SQLite are production code.
describe.each(["scripted", "live"])("scheduled lifecycle fixture ingress (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("maintains one reminder through edit, pause, manual execution and retained deletion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-lifecycle-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite"));
    const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    const tasks = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => Date.parse("2026-10-14T02:00:00Z"),
      readOriginalText: (ref) => files.resolveQuery(ref) ?? undefined,
      channel: { state: (destination) => ({ enabled: true, ...channel.getDeliveryContext(destination.accountId, destination.target) }),
        subscribe: (listener) => channel.onSnapshotChanged(listener),
        send: ({ operationId, beforeSubmit, ...input }) => channel.sendText({ ...input, scheduled: { operationId, beforeSubmit } }) },
    });
    const queries: Array<{ request: WorkflowToolRequest; result: unknown }> = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }),
      { submit: async () => { throw new Error("unexpected terminal workflow"); } }, { execute: async (request, turn) => {
        const result = await tasks.execute(request, turn); queries.push({ request: structuredClone(request), result: structuredClone(result) }); return result;
      } });
    const agent = mode === "scripted" ? new CodexConversation(() => new FixtureAppServerTransport(channel, (results) => JSON.stringify({ message: JSON.stringify(results), results: [] })), 90000, host)
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000, { webSearch: "disabled", serviceName: "scheduled_lifecycle_fixture_acceptance" });
    const codex = new WeixinCodexService(channel, agent, new CodexServiceStore(path.join(root, "codex.json")), root,
      Date.now, undefined, [], false, undefined, undefined, undefined, undefined, undefined, undefined,
      new WorkflowToolProductionControl(host, files));
    const demo = new DemoService(channel, async () => "fixture", codex);
    const server = createDemoServer(demo, { fixtureMode: true });
    try {
      await codex.start(); await codex.enable("fixture-bot", "fixture-user@im.wechat"); channel.activateInboundDispatch(); await tasks.start();
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      const interactions: Array<{ command: string; reply: string; run: unknown }> = [];
      const inbound = async (command: string, tool: string, args: Record<string, unknown>, expected: RegExp) => {
        if (mode === "scripted") {
          if ((tool === "create" || tool === "edit") && args.instruction !== undefined) args = { ...args, reminderText: `提醒：${args.name ?? "兰花提醒"}\n\n${args.instruction}`, reminderMode: "natural" };
          channel.queueFixtureModelToolCall({ namespace: "schedules", tool, arguments: args });
        }
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
        const run = codex.getPublicState().runs.at(-1);
        interactions.push({ command, reply, run }); console.info(JSON.stringify({ mode, command, reply }));
        expect(run?.phase).toBe("completed");
        if (mode === "live") expect(reply).toMatch(expected);
        return reply;
      };
      const trusted = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "inspection-only", occurredAt: Date.now(), originalTextRef: "unused", attachmentRefs: [] };
      const inspect = async (reference: string) => tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference } }, trusted);
      const createCommand = "创建一个名为生命周期验收的定时任务：2026年10月20日下午三点提醒我给花浇水。只发送文字提醒。";
      await inbound(createCommand, "create", { name: "生命周期验收", instruction: "给花浇水", at: "2026-10-20T15:00:00+08:00", sourceText: createCommand }, /创建|保存|设置/u);
      const initial = await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted) as { tasks: Array<{ id: string }> };
      expect(initial.tasks).toHaveLength(1); const id = initial.tasks[0]!.id;
      expect(await inspect(id)).toMatchObject({ task: { name: "生命周期验收", revision: 1, enabled: true, nextExecutionAt: "2026-10-20T07:00:00.000Z" } });
      const pause = "停用生命周期验收";
      await inbound(pause, "disable", { reference: id, expectedRevision: 1, sourceText: pause }, /停用|暂停/u);
      expect(await inspect(id)).toMatchObject({ task: { enabled: false, revision: 2, pauseGeneration: 1 } });
      const edit = "把生命周期验收改名为兰花提醒，提醒内容改为给兰花浇水，执行时间改到2026年10月20日下午四点，继续保持停用。";
      await inbound(edit, "edit", { reference: id, expectedRevision: 2, sourceText: edit, name: "兰花提醒", instruction: "给兰花浇水", at: "2026-10-20T16:00:00+08:00" }, /兰花/u);
      expect(await inspect(id)).toMatchObject({ task: { name: "兰花提醒", reminderText: expect.stringContaining("给兰花浇水"), enabled: false, nextExecutionAt: "2026-10-20T08:00:00.000Z" }, totalOccurrences: 0 });
      const current = await inspect(id) as { task: { revision: number } };
      const runNow = "现在执行一次兰花提醒，原定时间和停用状态都保持不变。";
      await inbound(runNow, "run_now", { reference: id, expectedRevision: current.task.revision, sourceText: runNow }, /执行|领取|触发/u);
      await tasks.tick(); await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(1));
      const savedText = (await inspect(id) as { task: { reminderText: string } }).task.reminderText;
      expect(savedText).toContain("给兰花浇水");
      if (mode === "live") expect(savedText).not.toMatch(/提醒：|每小时|执行时间/u);
      expect(channel.getFixtureTextOutbox().map((entry) => entry.message)).toEqual([savedText]);
      expect(await inspect(id)).toMatchObject({ task: { enabled: false, nextExecutionAt: "2026-10-20T08:00:00.000Z" }, totalOccurrences: 1, history: [{ kind: "manual", delivery: "accepted" }] });
      const enable = "启用兰花提醒";
      await inbound(enable, "enable", { reference: id, expectedRevision: current.task.revision, sourceText: enable }, /启用|开启/u);
      const enabled = await inspect(id) as { task: { revision: number } };
      expect(enabled).toMatchObject({ task: { enabled: true, nextExecutionAt: "2026-10-20T08:00:00.000Z" } });
      const remove = "删除兰花提醒，并保留执行历史";
      await inbound(remove, "delete", { reference: id, expectedRevision: enabled.task.revision, sourceText: remove }, /删除/u);
      expect(await inspect(id)).toMatchObject({ task: { lifecycle: "deleted", enabled: false, nextExecutionAt: null }, history: [{ delivery: "accepted", totalAttempts: 1 }] });
      const history = `查看任务 ${id} 的执行历史，已删除也要查看。`;
      await inbound(history, "inspect", { reference: id }, /执行|历史|渠道/u);
      await tasks.tick(); expect(channel.getFixtureTextOutbox()).toHaveLength(1); expect(channel.getFixtureOutbox()).toEqual([]);
      if (mode === "scripted") {
        for (const hour of [17, 18]) {
          const command = `创建另一个名为重名提醒的任务，2026年10月20日${hour}点提醒喝水`;
          await inbound(command, "create", { name: "重名提醒", instruction: "喝水", at: `2026-10-20T${hour}:00:00+08:00`, sourceText: command }, /创建/u);
        }
        const active = await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted) as { tasks: Array<{ id: string }> };
        expect(active.tasks).toHaveLength(2); const reference = active.tasks[0]!.id;
        const ambiguous = "停用重名提醒";
        expect(await inbound(ambiguous, "disable", { reference: "重名提醒", expectedRevision: 1, sourceText: ambiguous }, /选择/u)).toContain('"status":"needs_choice"');
        const invalid = `把 ${reference} 改到2026年2月30日`;
        expect(await inbound(invalid, "edit", { reference, expectedRevision: 1, sourceText: invalid, at: "2026-02-30T08:00:00Z", name: "must not change" }, /日期/u)).toContain('"code":"invalid_settings"');
        const foreign = "停用另一个微信会话的重名提醒";
        expect(await inbound(foreign, "disable", { reference, expectedRevision: 1, sourceText: foreign, target: "foreign" }, /会话/u)).toContain('"ok":false');
        expect(await inspect(reference)).toMatchObject({ task: { enabled: true, revision: 1, name: "重名提醒" }, totalOccurrences: 0 });
        expect(channel.getFixtureTextOutbox()).toHaveLength(1);
      }
      console.info(JSON.stringify({ mode, interactions, queries, scheduledState: await inspect(id), outbox: channel.getFixtureTextOutbox(), mediaOutbox: channel.getFixtureOutbox() }));
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});
