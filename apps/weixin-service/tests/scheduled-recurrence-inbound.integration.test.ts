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
// Real credentials/phone delivery remain unverified until the user runs the reported commands after deployment.
describe.each(["scripted", "live"])("scheduled recurrence fixture ingress (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("creates and maintains interval and calendar reminders through the trusted main turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-recurrence-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite"));
    const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    let clock = Date.parse("2026-10-14T02:15:00Z");
    const tasks = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => clock,
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
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000, { webSearch: "disabled", serviceName: "scheduled_recurrence_fixture_acceptance" });
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
          if ((tool === "create" || tool === "edit") && args.instruction !== undefined) args = { ...args, reminderText: `提醒：${args.name ?? "活动提醒"}\n\n${args.instruction}`, reminderMode: "natural" };
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
      const createCommand = "创建一个名为活动提醒的定时任务，每两小时提醒我活动一下，只发送文字提醒。";
      await inbound(createCommand, "create", { name: "活动提醒", instruction: "活动一下", intervalSeconds: 7200, sourceText: createCommand }, /创建|保存|设置/u);
      const initial = await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted) as { tasks: Array<{ id: string }> };
      expect(initial.tasks).toHaveLength(1); const id = initial.tasks[0]!.id;
      expect(await inspect(id)).toMatchObject({ task: { name: "活动提醒", revision: 1, enabled: true, nextExecutionAt: "2026-10-14T04:15:00.000Z", schedule: { kind: "interval", everySeconds: 7200 } } });
      const weekly = "创建一个名为周报提醒的定时任务，每周五晚上九点提醒我整理周报，使用上海时区，只发送文字提醒。";
      await inbound(weekly, "create", { name: "周报提醒", instruction: "整理周报", calendar: { time: "21:00", weekdays: [5] }, sourceText: weekly }, /周五|星期五|五/u);
      expect(await inspect("周报提醒")).toMatchObject({ task: { nextExecutionAt: "2026-10-16T13:00:00.000Z", timezone: "Asia/Shanghai", schedule: { kind: "calendar", time: "21:00", weekdays: [5] } } });
      const pause = "停用活动提醒";
      await inbound(pause, "disable", { reference: id, expectedRevision: 1, sourceText: pause }, /停用|暂停/u);
      expect(await inspect(id)).toMatchObject({ task: { enabled: false, revision: 2 } });
      const edit = "把活动提醒改为每小时一次，内容改为站起来活动，保持停用，不指定开始时间。";
      const editedReply = await inbound(edit, "edit", { reference: id, expectedRevision: 2, sourceText: edit, intervalSeconds: 3600, instruction: "站起来活动" }, /停用|暂停/u);
      if (mode === "live") { expect(editedReply).toMatch(/11[:：]15/u); expect(editedReply).toMatch(/Asia\/Shanghai|上海/u); }
      expect(await inspect(id)).toMatchObject({ task: { enabled: false, revision: 3, reminderText: expect.stringContaining("站起来活动"), nextExecutionAt: "2026-10-14T03:15:00.000Z", schedule: { everySeconds: 3600 } } });
      const runNow = "现在执行一次活动提醒，保持停用并保留原周期。";
      await inbound(runNow, "run_now", { reference: id, expectedRevision: 3, sourceText: runNow }, /执行|领取|触发/u);
      await tasks.tick(); await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(1));
      const savedText = (await inspect(id) as { task: { reminderText: string } }).task.reminderText;
      expect(savedText).toContain("站起来活动");
      if (mode === "live") expect(savedText).not.toMatch(/提醒：|每小时|执行时间/u);
      expect(channel.getFixtureTextOutbox().map((entry) => entry.message)).toEqual([savedText]);
      expect(await inspect(id)).toMatchObject({ task: { enabled: false, nextExecutionAt: "2026-10-14T03:15:00.000Z" }, totalOccurrences: 1, history: [{ kind: "manual", delivery: "accepted" }] });
      clock = Date.parse("2026-10-14T06:00:00Z");
      const enable = "启用活动提醒";
      await inbound(enable, "enable", { reference: id, expectedRevision: 3, sourceText: enable }, /启用|开启/u);
      expect(await inspect(id)).toMatchObject({ task: { enabled: true, nextExecutionAt: "2026-10-14T06:15:00.000Z" }, totalOccurrences: 1 });
      clock = Date.parse("2026-10-14T06:15:00Z"); await tasks.tick();
      expect(channel.getFixtureTextOutbox().map((entry) => entry.message)).toEqual([savedText, savedText]);
      expect(await inspect(id)).toMatchObject({ task: { nextExecutionAt: "2026-10-14T07:15:00.000Z", lifecycle: "scheduled" }, totalOccurrences: 2 });
      const history = `查看任务 ${id} 的设置和执行历史`;
      await inbound(history, "inspect", { reference: id }, /执行|历史|渠道/u);
      const invalid = "创建一个每零秒提醒喝水的任务，名字叫无效提醒。";
      await inbound(invalid, "create", { name: "无效提醒", instruction: "喝水", intervalSeconds: 0, sourceText: invalid }, /60|至少|无效|不能|不支持|有效|大于|正/u);
      expect(await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted)).toMatchObject({ total: 2 });
      const remove = "删除活动提醒，保留历史";
      await inbound(remove, "delete", { reference: id, expectedRevision: 4, sourceText: remove }, /删除/u);
      expect(await inspect(id)).toMatchObject({ task: { lifecycle: "deleted", nextExecutionAt: null }, totalOccurrences: 2 });
      if (mode === "scripted") {
        const conflicting = "把周报提醒改为每天九点，同时每两小时一次";
        expect(await inbound(conflicting, "edit", { reference: "周报提醒", expectedRevision: 1, sourceText: conflicting, calendar: { time: "09:00" }, intervalSeconds: 7200 }, /无效/u)).toContain('"status":"error"');
        const foreign = "把另一个会话的周报提醒改成每天九点";
        expect(await inbound(foreign, "edit", { reference: "周报提醒", expectedRevision: 1, sourceText: foreign, calendar: { time: "09:00" }, target: "foreign" }, /会话/u)).toContain('"ok":false');
        expect(await inspect("周报提醒")).toMatchObject({ task: { revision: 1, nextExecutionAt: "2026-10-16T13:00:00.000Z" } });
      }
      await tasks.tick(); expect(channel.getFixtureTextOutbox()).toHaveLength(2); expect(channel.getFixtureOutbox()).toEqual([]);
      const evidence = { mode, interactions, queries, scheduledState: await inspect(id), calendarState: await inspect("周报提醒"), outbox: channel.getFixtureTextOutbox(), mediaOutbox: channel.getFixtureOutbox() };
      console.info(JSON.stringify(evidence));
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, `ticket-03-inbound-${mode}.json`), JSON.stringify(evidence, null, 2) + "\n");
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});
