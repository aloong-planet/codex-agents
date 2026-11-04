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
import { MAIN_WEIXIN_DISABLED_FEATURES, WorkflowToolProductionControl } from "../src/workflow-tool-production.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { FixtureAppServerTransport } from "../src/fixture-app-server-transport.js";
import { FixturePort } from "../src/fixture-port.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { WeixinCodexService } from "../src/weixin-codex-service.js";
import { DemoService } from "../src/demo-service.js";
import { createDemoServer } from "../src/http-server.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemorySystem } from "../src/account-memory-system.js";
import type { DailyAiNewsState } from "../src/daily-ai-news-scheduler.js";

// The real-model mode is the semantic check; scripted mode establishes only ingress/tool/storage wiring.
// All accounts, memory, research and channel effects are synthetic. No production state or Weixin connection is used.
describe.each(["scripted", "live"])("task configuration authority (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("keeps current settings across conflicting history and memory while allowing explicitly requested edits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-authority-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite")); const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    const clock = Date.parse("2026-10-17T00:00:00Z");
    const legacy: DailyAiNewsState = { version: 2,
      enabledTarget: { accountId: "fixture-bot", target: "fixture-user@im.wechat", enabledAt: clock },
      runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null };
    const generatedInstructions: Array<string | undefined> = [];
    const tasks = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => clock,
      readOriginalText: (ref) => files.resolveQuery(ref) ?? undefined, dailyNewsImport: { state: legacy, sourceHash: "synthetic-authority" },
      dailyNews: { researcher: { generate: async ({ date, instruction }) => { generatedInstructions.push(instruction); return { date, generatedAt: clock, items: [] }; } } },
      channel: { state: (destination) => ({ enabled: true, ...channel.getDeliveryContext(destination.accountId, destination.target) }),
        subscribe: (listener) => channel.onSnapshotChanged(listener),
        send: ({ operationId, beforeSubmit, ...input }) => channel.sendText({ ...input, scheduled: { operationId, beforeSubmit } }) } });
    const memoryStore = new AccountMemoryStore(path.join(root, "memory"));
    memoryStore.apply("fixture-bot", { batchId: "old-preference", basedOnRevision: 0, evidenceEntryIds: new Set(["old-user"]), mutations: [
      { op: "add", id: "old-news-scope", category: "constraints", value: "每日报告及 Hacker News 热门技术仅检索 AI 和 LLM 相关内容，最多 10 条；每条摘要限制在 150 字以内。", evidenceEntryIds: ["old-user"], confidence: 1 },
    ] });
    // Deliberately retain unclassified legacy memory throughout this test; retirement has separate integration tests.
    const memory = new AccountMemorySystem({ store: memoryStore, statePath: path.join(root, "memory-jobs.json"),
      curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      managedTasks: (accountId, targets) => tasks.memoryContext(accountId, targets) });
    const queries: Array<{ request: WorkflowToolRequest; result: unknown }> = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }),
      { submit: async () => { throw new Error("unexpected terminal workflow"); } }, { execute: async (request, turn) => {
        const result = await tasks.execute(request, turn); queries.push({ request: structuredClone(request), result: structuredClone(result) }); return result;
      } });
    const agent = mode === "scripted" ? new CodexConversation(() => new FixtureAppServerTransport(channel, (results) => JSON.stringify({ message: JSON.stringify(results), results: [] })), 90000, host)
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000,
        { webSearch: "disabled", serviceName: "scheduled_authority_fixture" });
    const codex = new WeixinCodexService(channel, agent, new CodexServiceStore(path.join(root, "codex.json")), root,
      Date.now, undefined, [], false, undefined, undefined, undefined, memory, undefined, undefined,
      new WorkflowToolProductionControl(host, files));
    const demo = new DemoService(channel, async () => "fixture", codex); const server = createDemoServer(demo, { fixtureMode: true });
    const interactions: Array<{ command: string; reply: string; run: unknown; tools: unknown; settings: unknown }> = [];
    const trusted = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "inspection-only", occurredAt: clock, originalTextRef: "unused", attachmentRefs: [] };
    const inspect = async (offset = 0) => await tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "AI 新闻日报", offset, limit: 5 } }, trusted) as {
      task: { id: string; instruction: string; revision: number; enabled: boolean; schedule: unknown; timezone: string; nextExecutionAt: string | null };
      history: Array<{ id: string; kind: string; revision: number; execution: string; delivery: string }>; totalOccurrences: number; nextOffset?: number;
    };
    const allHistory = async () => {
      const history: Awaited<ReturnType<typeof inspect>>["history"] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) { const page = await inspect(offset); history.push(...page.history); offset = page.nextOffset; }
      return history;
    };
    const occurrence = async (result: unknown) => {
      const id = (result as { occurrenceId?: string }).occurrenceId;
      expect(typeof id).toBe("string");
      return (await allHistory()).find((item) => item.id === id);
    };
    try {
      await codex.start(); await codex.enable("fixture-bot", "fixture-user@im.wechat"); channel.activateInboundDispatch(); await tasks.start();
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      const inbound = async (command: string, calls: Array<{ tool: string; arguments: Record<string, unknown> }>) => {
        const before = queries.length;
        if (mode === "scripted") for (const call of calls) channel.queueFixtureModelToolCall({ namespace: "schedules", ...call });
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
        const run = codex.getPublicState().runs.at(-1);
        interactions.push({ command, reply, run, tools: queries.slice(before), settings: (await inspect()).task });
        expect(run?.phase).toBe("completed");
        expect(reply).not.toBe("");
        return queries.slice(before).filter((item) => !["schedules.inspect", "schedules.list", "schedules.read_text"].includes(item.request.toolId));
      };
      const oldRequest = "把 AI 新闻日报里的 Hacker News 热门技术限定为 AI 或 LLM 相关内容，其余设置保持原样，不要执行。";
      await inbound(oldRequest, [{ tool: "edit", arguments: { reference: "AI 新闻日报", expectedRevision: 1, instruction: "检索 AI 新闻及仅限 AI 或 LLM 的 Hacker News 热门技术。", sourceText: oldRequest } }]);
      const oldTask = (await inspect()).task; expect(oldTask.revision).toBe(2);
      expect(oldTask.instruction).toMatch(/AI|LLM/u);
      // A separate authorised management surface changed configuration, matching the reported incident.
      const external = "取消日报 Hacker News 的 AI/LLM 限制，使用全站热榜，不限主题。";
      const externalRef = files.captureQuery("fixture-external-setting", external).handle;
      const unrestricted = "检索过去24小时 AI 新闻，以及 Hacker News 全站热榜中的热门技术（不限主题）；核验来源、生成完整中文摘要并写入本地归档。";
      expect(await tasks.execute({ toolId: "schedules.edit", toolVersion: 1, arguments: { reference: oldTask.id, expectedRevision: 2, sourceText: external, instruction: unrestricted } },
        { ...trusted, eventKey: "fixture-external-setting", originalTextRef: externalRef })).toMatchObject({ status: "updated" });
      const pause = "停用日报，之后仅在我明确要求时执行。";
      const pauseRef = files.captureQuery("fixture-external-pause", pause).handle;
      expect(await tasks.execute({ toolId: "schedules.disable", toolVersion: 1, arguments: { reference: oldTask.id, expectedRevision: 3, sourceText: pause } },
        { ...trusted, eventKey: "fixture-external-pause", originalTextRef: pauseRef })).toMatchObject({ status: "disabled" });
      const settings = (await inspect()).task;
      expect(settings).toMatchObject({ revision: 4, enabled: false, instruction: unrestricted });
      for (const command of ["现在执行一次AI新闻日报", "按现在的设置再跑一遍 AI 新闻日报", "不要改设置，现在执行一次 AI 新闻日报", "之前说过‘Hacker News 只看 AI/LLM’，那是旧设置，不要恢复它；按当前设置执行一次日报。"]) {
        const effects = await inbound(command, [{ tool: "run_now", arguments: { reference: settings.id, expectedRevision: 4, sourceText: command } }]);
        expect(effects.map((item) => item.request.toolId)).toEqual(["schedules.run_now"]);
        await tasks.tick();
        const current = await inspect();
        for (const field of ["id", "instruction", "revision", "enabled", "schedule", "timezone", "nextExecutionAt"] as const) expect(current.task[field]).toEqual(settings[field]);
        expect(await occurrence(effects[0]!.result)).toMatchObject({ kind: "manual", revision: 4, execution: "succeeded", delivery: "accepted" });
      }
      expect(generatedInstructions).toEqual([unrestricted, unrestricted, unrestricted, unrestricted]);
      const query = "查看 AI 新闻日报当前设置和执行历史。";
      expect(await inbound(query, [{ tool: "inspect", arguments: { reference: settings.id } }])).toEqual([]);
      expect((await inspect()).task.revision).toBe(4);
      const combined = "把 AI 新闻日报改成每天九点，并立即执行一次，内容范围和停用状态保持原样。";
      const effects = await inbound(combined, [
        { tool: "edit", arguments: { reference: settings.id, expectedRevision: 4, calendar: { time: "09:00" }, sourceText: combined } },
        { tool: "run_now", arguments: { reference: settings.id, expectedRevision: 5, sourceText: combined } },
      ]);
      expect(effects.map((item) => item.request.toolId)).toEqual(["schedules.edit", "schedules.run_now"]);
      await tasks.tick(); await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(5));
      expect(await inspect()).toMatchObject({ task: { instruction: unrestricted, revision: 5, enabled: false,
        schedule: { kind: "calendar", time: "09:00" }, timezone: "Asia/Shanghai" }, totalOccurrences: 5 });
      expect(generatedInstructions).toEqual([unrestricted, unrestricted, unrestricted, unrestricted, unrestricted]);
      const scopeEdit = "把 AI 新闻日报的 Hacker News 范围改为开源技术，并立即执行一次；AI 新闻及其他研究要求、时间和停用状态都保持原样。";
      const scopeEffects = await inbound(scopeEdit, [
        { tool: "edit", arguments: { reference: settings.id, expectedRevision: 5,
          instruction: "检索过去24小时 AI 新闻，以及 Hacker News 全站热榜中的开源技术；核验来源、生成完整中文摘要并写入本地归档。", sourceText: scopeEdit } },
        { tool: "run_now", arguments: { reference: settings.id, expectedRevision: 6, sourceText: scopeEdit } },
      ]);
      expect(scopeEffects.map((item) => item.request.toolId)).toEqual(["schedules.edit", "schedules.run_now"]);
      expect(Object.keys(scopeEffects[0]!.request.arguments as Record<string, unknown>).sort()).toEqual(["expectedRevision", "instruction", "reference", "sourceText"]);
      await tasks.tick(); await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(6));
      const edited = await inspect();
      expect(edited.task).toMatchObject({ revision: 6, enabled: false, timezone: "Asia/Shanghai", schedule: { kind: "calendar", time: "09:00" } });
      expect(edited.task.instruction).toContain("开源"); expect(edited.task.instruction).toContain("AI 新闻");
      expect(edited.totalOccurrences).toBe(6);
      expect(await occurrence(scopeEffects[1]!.result)).toMatchObject({ kind: "manual", revision: 6, execution: "succeeded", delivery: "accepted" });
      expect(generatedInstructions).toHaveLength(6); expect(generatedInstructions[5]).toBe(edited.task.instruction);
      expect(channel.getFixtureOutbox()).toEqual([]);
      expect(memory.recall("fixture-bot")).toContain("仅检索 AI 和 LLM");
      expect(tasks.memoryContext("foreign-bot", ["fixture-user@im.wechat"])).toEqual([]);
      expect(tasks.memoryContext("fixture-bot", ["foreign-user@im.wechat"])).toEqual([]);
      expect(tasks.memoryContext("fixture-bot", [])).toEqual([]);
    } finally {
      const evidence = { mode, interactions, queries, generatedInstructions, state: await inspect(), completeHistory: await allHistory(), outbox: channel.getFixtureTextOutbox(), mediaOutbox: channel.getFixtureOutbox(),
        memory: memoryStore.read("fixture-bot").markdown, note: "Fixture channel acceptance only; no real Weixin send." };
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, `task-authority-${mode}.json`), JSON.stringify(evidence, null, 2) + "\n");
      }
      console.info(JSON.stringify({ mode, turns: interactions.length, simulatedDeliveries: evidence.outbox.length }));
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600000);
});
