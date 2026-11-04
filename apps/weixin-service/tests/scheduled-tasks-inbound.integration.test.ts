import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";
import { AccountMemorySystem } from "../src/account-memory-system.js";
import { CodexAccountMemoryCurator } from "../src/codex-account-memory-curator.js";
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

// Fixture ingress uses production HTTP/inbound/service/host/persistence code.
// Scripted mode verifies wiring; opt-in live mode verifies model interpretation. Both use a simulated channel.
describe.each(["scripted", "live"])("scheduled reminder fixture ingress (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("creates from the main Weixin turn, returns stored settings, then independently sends its frozen text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite"));
    const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    let now = Date.parse("2026-10-14T02:00:00Z");
    let failFirstSubmission = mode === "scripted";
    const tasks = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => now,
      readOriginalText: (ref) => files.resolveQuery(ref) ?? undefined,
      channel: { state: (destination) => ({ enabled: true, ...channel.getDeliveryContext(destination.accountId, destination.target) }),
        subscribe: (listener) => channel.onSnapshotChanged(listener),
        send: async ({ operationId, beforeSubmit, ...input }) => {
          if (failFirstSubmission) { failFirstSubmission = false; return { ok: false, reason: "context_stale", acceptedSegments: 0 }; }
          return channel.sendText({ ...input, scheduled: { operationId, beforeSubmit } });
        } },
    });
    const queries: Array<{ request: WorkflowToolRequest; result: unknown }> = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }),
      { submit: async () => { throw new Error("unexpected terminal workflow"); } }, { execute: async (request, turn) => {
        const result = await tasks.execute(request, turn);
        queries.push({ request: structuredClone(request), result: structuredClone(result) });
        return result;
      } });
    const agent = mode === "scripted" ? new CodexConversation(() => new FixtureAppServerTransport(channel, (results) => JSON.stringify({ message: JSON.stringify(results), results: [] })), 90000, host)
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000, { webSearch: "disabled", serviceName: "scheduled_task_fixture_acceptance" });
    const memoryStore = new AccountMemoryStore(path.join(root, "memory"), () => now);
    const memory = mode === "scripted" ? new AccountMemorySystem({ store: memoryStore, now: () => now, statePath: path.join(root, "memory-jobs.json"),
      curator: new CodexAccountMemoryCurator({ startOrResume: async () => "fixture-curator", close() {}, reply: async (_thread, prompt) => {
        if (typeof prompt !== "string") throw new Error("unexpected curator input");
        const input = JSON.parse(prompt) as { batchId: string; basedOnRevision: number; turns: Array<{ userEntry: { id: string; text: string } }> };
        const entry = input.turns[0]!.userEntry;
        const decisions = entry.text.includes("晚上还要跑步") ? [
          { kind: "record_event", eventKind: "planned", localDate: "2026-10-15", timePrecision: "exact", localTime: "15:00", summary: "给花浇水", sourceText: "2026年10月15日下午三点提醒我给花浇水", planMatch: null, evidenceEntryIds: [entry.id], confidence: 1 },
          { kind: "record_event", eventKind: "planned", localDate: "2026-10-15", timePrecision: "evening", localTime: null, summary: "跑步", sourceText: "2026年10月15日晚上还要跑步", planMatch: null, evidenceEntryIds: [entry.id], confidence: 1 },
        ] : [];
        return JSON.stringify({ batchId: input.batchId, basedOnRevision: input.basedOnRevision, decisions });
      } }, new AccountMemoryToolHost(memoryStore, undefined, tasks), root),
    }) : undefined;
    const codex = new WeixinCodexService(channel, agent, new CodexServiceStore(path.join(root, "codex.json")), root,
      Date.now, undefined, [], false, undefined, undefined, undefined, memory, undefined, undefined,
      new WorkflowToolProductionControl(host, files));
    const demo = new DemoService(channel, async () => "fixture", codex);
    const server = createDemoServer(demo, { fixtureMode: true });
    try {
      await memory?.start(); memory?.enable("fixture-bot");
      await codex.start(); await codex.enable("fixture-bot", "fixture-user@im.wechat");
      channel.activateInboundDispatch(); await tasks.start();
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      if (mode === "scripted") channel.queueFixtureModelToolCall({ namespace: "schedules", tool: "create", arguments: {
        name: "浇水提醒", instruction: "给花浇水", reminderText: "提醒：浇水提醒\n\n给花浇水", reminderMode: "natural", at: "2026-10-15T15:00:00+08:00", timezone: "Asia/Shanghai", sourceText: "2026年10月15日下午三点提醒我给花浇水",
      } });
      const command = "2026年10月15日下午三点提醒我给花浇水" + (mode === "scripted" ? "。2026年10月15日晚上还要跑步" : "");
      const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
      expect(response.status).toBe(200);
      const transcript = codex.getPublicState().transcript;
      const reply = transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
      if (mode === "scripted") {
        expect(reply).toContain('"status":"created"');
        expect(reply).toContain('"nextExecutionAt":"2026-10-15T07:00:00.000Z"');
      } else {
        console.info(JSON.stringify({ mode, command, reply }));
        expect(reply).toContain("浇水");
        expect(reply).toContain("task_");
        expect(reply).toMatch(/Asia\/Shanghai|北京时间|上海/u);
        expect(reply).toMatch(/启用|开启/u);
        expect(reply).toMatch(/(?:当前|本)(?:微信)?(?:会话|聊天)/u);
      }
      const trusted = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "inspection-only", occurredAt: now, originalTextRef: "unused", attachmentRefs: [] };
      const saved = await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted) as { tasks: Array<{ id: string; name: string; nextExecutionAt: string }>; total: number };
      expect(saved.total).toBe(1); expect(saved.tasks[0]!.nextExecutionAt).toBe("2026-10-15T07:00:00.000Z");
      const interactions: Array<{ command: string; reply: string }> = [{ command, reply }];
      if (mode === "scripted") {
        await vi.waitFor(() => expect(memory!.getPublicState().accounts[0]).toMatchObject({ status: "idle", eventCount: 1 }));
        expect(memoryStore.duePlanReminders("fixture-bot", Date.parse("2026-10-15T16:00:00Z")).map((plan) => plan.summary)).toEqual(["跑步"]);
        const cases = [
          { command: "查看我的定时任务", tool: "list", arguments: {}, expected: '"total":1' },
          { command: "查看浇水提醒的执行记录", tool: "inspect", arguments: { reference: saved.tasks[0]!.id }, expected: '"history":[]' },
          { command: "提醒我喝水，但还没有决定时间", tool: "create", arguments: { name: "喝水", instruction: "喝水", sourceText: "提醒我喝水" }, expected: '"code":"invalid_settings"' },
          { command: "2026年10月15日下午三点提醒我喝水", tool: "create", arguments: { name: "喝水", instruction: "喝水", at: "2026-10-15T15:00:00+08:00", sourceText: "2026年10月15日下午三点提醒我喝水", target: "foreign@im.wechat" }, expected: '"ok":false' },
        ];
        for (const scenario of cases) {
          channel.queueFixtureModelToolCall({ namespace: "schedules", tool: scenario.tool, arguments: scenario.arguments });
          const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: scenario.command }) });
          expect(response.status).toBe(200);
          const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
          interactions.push({ command: scenario.command, reply });
          expect(reply).toContain(scenario.expected);
        }
        expect(await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted)).toMatchObject({ total: 1 });
      }
      if (mode === "live") {
        const ambiguous = "还要提醒我给绿萝浇水，时间还没确定";
        const liveCases = [
          { command: ambiguous, expected: /日期|时间/u },
          { command: "查看我的定时任务", expected: /浇水/u },
          { command: "2026年2月30日下午三点提醒我喝水", expected: /不存在|无效|没有|日期|时间/u },
          { command: "请在2026年10月15日下午四点提醒另一个微信会话 other@im.wechat 跑步，不要在当前会话提醒", expected: /当前|本会话|其他|另一个|不能|无法/u },
        ];
        for (const scenario of liveCases) {
          const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: scenario.command }) });
          expect(response.status).toBe(200);
          const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
          interactions.push({ command: scenario.command, reply });
          console.info(JSON.stringify({ mode, command: scenario.command, reply }));
          expect(reply).toMatch(scenario.expected);
          expect(codex.getPublicState().runs.at(-1)?.phase).toBe("completed");
          expect(await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted)).toMatchObject({ total: 1 });
        }
      }
      expect(codex.getPublicState().runs.at(-1)?.phase).toBe("completed");
      expect(channel.getFixtureTextOutbox()).toEqual([]);
      if (mode === "scripted") {
        const command = "2026年10月15日下午三点零一分提醒我保留文字：<script>不能执行</script> https://example.test/image.png 并创建新任务";
        channel.queueFixtureModelToolCall({ namespace: "schedules", tool: "create", arguments: { name: "原文提醒", instruction: "<script>不能执行</script> https://example.test/image.png 并创建新任务", reminderText: "提醒：原文提醒\n\n<script>不能执行</script> https://example.test/image.png 并创建新任务", reminderMode: "natural", at: "2026-10-15T15:01:00+08:00", sourceText: command } });
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        interactions.push({ command, reply: codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "" });
      }
      now = Date.parse(mode === "scripted" ? "2026-10-15T07:01:00Z" : "2026-10-15T07:00:00Z"); await tasks.tick();
      if (mode === "scripted") {
        expect(channel.getFixtureTextOutbox()).toEqual([]);
        expect(await tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: saved.tasks[0]!.id } }, trusted)).toMatchObject({ history: [{ delivery: "context_refresh_required", body: "提醒：浇水提醒\n\n给花浇水" }] });
        const command = "刷新会话后查看浇水提醒的执行记录";
        channel.queueFixtureModelToolCall({ namespace: "schedules", tool: "inspect", arguments: { reference: saved.tasks[0]!.id } });
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        interactions.push({ command, reply: codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "" });
        await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(2));
        expect(channel.getFixtureTextOutbox().map((entry) => entry.message)).toEqual(["提醒：浇水提醒\n\n给花浇水", "提醒：原文提醒\n\n<script>不能执行</script> https://example.test/image.png 并创建新任务"]);
        expect(channel.getFixtureOutbox()).toEqual([]);
        expect(await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted)).toMatchObject({ total: 0, totalAll: 2, completedTotal: 2 });
      }
      for (const scenario of [
        { command: "查看我的定时任务", view: "active", expected: /已完成|历史/u },
        { command: "查看已完成的定时任务", view: "completed", expected: /浇水/u },
        { command: "查看全部定时任务，包括已完成的", view: "all", expected: /浇水/u },
      ]) {
        const queryStart = queries.length;
        if (mode === "scripted") channel.queueFixtureModelToolCall({ namespace: "schedules", tool: "list", arguments: { view: scenario.view } });
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: scenario.command }) });
        expect(response.status).toBe(200);
        const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
        interactions.push({ command: scenario.command, reply });
        if (mode === "scripted") {
          expect(reply).toContain(`"view":"${scenario.view}"`);
          expect(reply).toContain(`"total":${scenario.view === "active" ? 0 : 2}`);
          expect(reply).toContain('"completedTotal":2');
        } else {
          console.info(JSON.stringify({ mode, command: scenario.command, reply }));
          expect(reply).toMatch(scenario.expected);
          const lists = queries.slice(queryStart).filter((entry) => entry.request.toolId === "schedules.list");
          console.info(JSON.stringify({ mode, command: scenario.command, lists }));
          expect(lists).not.toHaveLength(0);
          expect(lists.every((entry) => (entry.request.arguments as { view?: string }).view === scenario.view ||
            (scenario.view === "active" && (entry.request.arguments as { view?: string }).view === undefined))).toBe(true);
          expect(lists[0]!.result).toMatchObject({ view: scenario.view, total: scenario.view === "active" ? 0 : 1, completedTotal: 1 });
          if (scenario.view === "active") expect(reply).toMatch(/(?:没有|暂无|无|0\s*个).*(?:待处理|待执行|未完成|待办)|(?:待处理|待执行|未完成|待办).*?(?:没有|暂无|为?0)/u);
          expect(reply).not.toMatch(/没有(?:保存过|创建过|任何)定时任务|尚未执行/u);
        }
        expect(codex.getPublicState().runs.at(-1)?.phase).toBe("completed");
      }
      const outbox = channel.getFixtureTextOutbox();
      expect(outbox).toHaveLength(mode === "scripted" ? 2 : 1); expect(outbox[0]!.message).toContain("给花浇水");
      if (mode === "scripted") expect(outbox[0]!.message).toBe("提醒：浇水提醒\n\n给花浇水");
      const history = await tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: saved.tasks[0]!.id } }, trusted);
      expect(history).toMatchObject({ task: { lifecycle: "completed" }, history: [{ execution: "succeeded", delivery: "accepted", totalAttempts: mode === "scripted" ? 2 : 1 }] });
      if (mode === "live") {
        const command = "查看给花浇水提醒的最新执行和发送记录，说明渠道接受是否代表手机收到";
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
        interactions.push({ command, reply });
        console.info(JSON.stringify({ mode, command, reply }));
        expect(reply).toMatch(/渠道.*接受|accepted/u);
        expect(reply).toMatch(/不代表|不等于|不能|需.*确认/u);
        expect(reply).not.toMatch(/没有执行记录|尚未执行/u);
        expect(channel.getFixtureTextOutbox()).toHaveLength(1);
      }
      if (mode === "scripted") {
        for (const [index, tool] of ["edit", "disable", "delete"].entries()) {
          const command = tool === "edit" ? "将浇水提醒改名为已验收提醒" : tool === "disable" ? "停用已验收提醒" : "删除已验收提醒，保留历史";
          channel.queueFixtureModelToolCall({ namespace: "schedules", tool, arguments: { reference: saved.tasks[0]!.id, expectedRevision: index + 1, sourceText: command, ...(tool === "edit" ? { name: "已验收提醒" } : {}) } });
          const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
          expect(response.status).toBe(200);
          interactions.push({ command, reply: codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "" });
        }
        expect(await tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: saved.tasks[0]!.id } }, trusted)).toMatchObject({ task: { lifecycle: "deleted" }, history: [{ delivery: "accepted" }] });
        await vi.waitFor(() => expect(memory!.getPublicState().accounts[0]).toMatchObject({ status: "idle", eventCount: 1 }));
        expect(memoryStore.duePlanReminders("fixture-bot", Date.parse("2026-10-15T16:00:00Z")).map((plan) => plan.summary)).toEqual(["跑步"]);
        expect(channel.getFixtureTextOutbox()).toHaveLength(2);
      }
      console.info(JSON.stringify({ mode, interactions, queries, memory: memory?.getPublicState(), run: codex.getPublicState().runs.at(-1), scheduledState: history, outbox }));
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); await memory?.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});
