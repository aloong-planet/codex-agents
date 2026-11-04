import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
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
describe.each(["scripted", "live"])("scheduled research fixture ingress (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("creates, edits and executes researched text independently then recovers the exact cached report", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-research-inbound-"));
    const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel")));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite"));
    const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    const clock = Date.parse("2026-10-15T02:00:00Z");
    let allowDelivery = false;
    const researchRequests: unknown[] = [];
    const tasks = new ScheduledTasks({ diagnostics, databasePath: path.join(root, "tasks.sqlite"), now: () => clock,
      readOriginalText: (ref) => files.resolveQuery(ref) ?? undefined,
      research: async ({ name, instruction, timezone, plannedAt }) => { researchRequests.push({ name, instruction, timezone, plannedAt }); return "开源工具周报：审查能力新增了可追溯的结果记录，但仍需人工核验。[1]\n\n来源：\n[1] 官方发布：https://example.com/releases"; },
      channel: { state: (destination) => ({ enabled: true, ...channel.getDeliveryContext(destination.accountId, destination.target), ...(!allowDelivery ? { contextGeneration: null } : {}) }),
        subscribe: (listener) => channel.onSnapshotChanged(listener),
        send: ({ operationId, beforeSubmit, ...input }) => channel.sendText({ ...input, scheduled: { operationId, beforeSubmit } }) },
    });
    const queries: Array<{ request: WorkflowToolRequest; result: unknown }> = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }),
      { submit: async () => { throw new Error("unexpected terminal workflow"); } }, { execute: async (request, turn) => {
        const result = await tasks.execute(request, turn); queries.push({ request: structuredClone(request), result: structuredClone(result) }); return result;
      } }, { diagnostics });
    const agent = mode === "scripted" ? new CodexConversation(() => new FixtureAppServerTransport(channel, (results) => JSON.stringify({ message: JSON.stringify(results), results: [] })), 90000, host)
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000, { webSearch: "disabled", serviceName: "scheduled_research_fixture_acceptance" });
    const codex = new WeixinCodexService(channel, agent, new CodexServiceStore(path.join(root, "codex.json")), root,
      Date.now, undefined, [], false, undefined, undefined, undefined, undefined, undefined, undefined,
      new WorkflowToolProductionControl(host, files), diagnostics);
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
      const createCommand = "每周五晚上九点整理 AI 编程工具更新，说明核心变化并附来源，名字叫 AI 编程工具周报，使用上海时区。";
      const reply = await inbound(createCommand, "create", { name: "AI 编程工具周报", template: "researched_text", instruction: "整理过去一周 AI 编程工具更新，说明核心变化并附来源", calendar: { time: "21:00", weekdays: [5] }, sourceText: createCommand }, /创建|保存|设置/u);
      const initial = await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted) as { tasks: Array<{ id: string }> };
      expect(initial.tasks).toHaveLength(1); const id = initial.tasks[0]!.id;
      expect(await inspect(id)).toMatchObject({ task: { template: "researched_text", reminderTextAvailable: false, nextExecutionAt: "2026-10-16T13:00:00.000Z" } });
      if (mode === "live") { expect(reply).toContain(id); expect(reply).toMatch(/21[:：]00/u); expect(reply).toMatch(/Asia\/Shanghai|上海/u); }
      const pause = "停用 AI 编程工具周报";
      await inbound(pause, "disable", { reference: id, expectedRevision: 1, sourceText: pause }, /停用|暂停/u);
      const edit = "把 AI 编程工具周报的研究范围改为仅开源工具，仍需说明核心变化并附来源，保持停用和原周期。";
      const editReply = await inbound(edit, "edit", { reference: id, expectedRevision: 2, sourceText: edit, instruction: "整理过去一周开源 AI 编程工具更新，说明核心变化并附来源" }, /开源/u);
      if (mode === "live") { expect(editReply).toContain(id); expect(editReply).toMatch(/2026.{0,2}10.{0,2}16/u); expect(editReply).toMatch(/21[:：]00/u); expect(editReply).toMatch(/上海|Asia\/Shanghai/u); }
      expect(await inspect(id)).toMatchObject({ task: { enabled: false, revision: 3, template: "researched_text", nextExecutionAt: "2026-10-16T13:00:00.000Z" } });
      const manual = "现在执行一次 AI 编程工具周报，保持停用。";
      await inbound(manual, "run_now", { reference: id, expectedRevision: 3, sourceText: manual }, /执行|领取|启动|开始/u);
      await tasks.tick();
      expect(researchRequests).toHaveLength(1);
      expect(researchRequests[0]).toMatchObject({ instruction: expect.stringContaining("开源"), plannedAt: "2026-10-15T02:00:00.000Z" });
      expect(await inspect(id)).toMatchObject({ task: { enabled: false }, history: [{ execution: "succeeded", delivery: "pending_inbound", stage: "research" }] });
      expect(channel.getFixtureTextOutbox()).toEqual([]);
      allowDelivery = true;
      const history = `查看任务 ${id} 的设置和执行历史`;
      const historyReply = await inbound(history, "inspect", { reference: id }, /研究|执行|历史|渠道/u);
      if (mode === "live") expect(historyReply).not.toMatch(/需.{0,20}(?:发送消息|刷新会话)|恢复[^。\n]{0,16}(?:将|会)[^。\n]{0,12}(?:推送|续发|补发)|恢复后.{0,15}(?:推送|续发|补发)/u);
      await tasks.tick(); await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(1));
      expect(channel.getFixtureTextOutbox()[0]?.message).toBe("开源工具周报：审查能力新增了可追溯的结果记录，但仍需人工核验。[1]\n\n来源：\n[1] 官方发布：https://example.com/releases");
      expect(researchRequests).toHaveLength(1);
      expect(await inspect(id)).toMatchObject({ totalOccurrences: 1, history: [{ delivery: "accepted", kind: "manual" }], task: { enabled: false } });
      const invalid = "再创建一个研究 AI 更新的定时任务，名字叫缺时间研究；我还没有决定什么时候执行。";
      await inbound(invalid, "create", { name: "缺时间研究", template: "researched_text", instruction: "研究 AI 更新", sourceText: invalid }, /时间|几点|频率|什么时候/u);
      expect(await tasks.execute({ toolId: "schedules.list", toolVersion: 1, arguments: {} }, trusted)).toMatchObject({ total: 1 });
      if (mode === "scripted") {
        const foreign = "给其他会话创建研究任务";
        expect(await inbound(foreign, "create", { name: "foreign", template: "researched_text", instruction: "研究", intervalSeconds: 60, sourceText: foreign, target: "other" }, /会话/u)).toContain('"ok":false');
      }
      const remove = "删除 AI 编程工具周报，保留历史";
      await inbound(remove, "delete", { reference: id, expectedRevision: 3, sourceText: remove }, /删除/u);
      expect(await inspect(id)).toMatchObject({ task: { lifecycle: "deleted" }, totalOccurrences: 1 });
      await tasks.tick(); expect(channel.getFixtureTextOutbox()).toHaveLength(1); expect(channel.getFixtureOutbox()).toEqual([]);
      await diagnostics.close();
      const telemetry = await readDiagnostics(path.join(root, "otel"), { maxRecords: 1000 });
      expect(telemetry.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "scheduled.research", kind: "span", attributes: expect.objectContaining({ taskRef: id, status: "cached" }) }),
        expect.objectContaining({ name: "scheduled.output.persisted", attributes: expect.objectContaining({ taskRef: id, status: "cached" }) }),
      ]));
      const evidence = { telemetry, mode, interactions, queries, researchRequests, scheduledState: await inspect(id), outbox: channel.getFixtureTextOutbox(), mediaOutbox: channel.getFixtureOutbox(), researchMode: "controlled external generator; live mode verifies main-turn semantics only" };
      console.info(JSON.stringify(evidence));
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, `ticket-04-inbound-${mode}.json`), JSON.stringify(evidence, null, 2) + "\n");
      }
    } finally {
      console.info("RESEARCH_TOOL_QUERIES", JSON.stringify({ mode, queries }));
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); await diagnostics.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});
