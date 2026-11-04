import { CombinedNewsResearcher } from "../src/codex-news-researcher.js";
import { NewsArchive } from "../src/news-archive.js";
import { DirectMarkdownVault } from "../src/direct-markdown-vault.js";
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

import { DailyAiNewsScheduler } from "../src/daily-ai-news-scheduler.js";
import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";

// HTTP fixture ingress, main turn, tool host and SQLite are production code; live mode uses the real model.
// Research output and channel submission stay controlled. Production cutover, real credentials and phone receipt
// require a separately deployed candidate and user-operated acceptance; this test cannot establish them.
describe.each(["scripted", "live", "degraded"])("managed daily news fixture ingress (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("manages migrated news and refreshes its original cached body without regeneration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-news-inbound-"));
    const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel"), { maxQueuedRecords: 2048 }));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite")); const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    const clock = Date.parse("2026-10-16T02:00:00Z");
    const store = new DailyAiNewsFileStore(path.join(root, "news.json"));
    const legacy = new DailyAiNewsScheduler({ store, now: () => clock, setTimer: () => 0, clearTimer: () => {},
      researcher: { generate: async ({ date }) => ({ date, generatedAt: clock, items: [] }) },
      channel: { getSnapshot: () => ({ accounts: [{ accountId: "fixture-bot", credentialStatus: "usable" }], targets: [{ accountId: "fixture-bot", target: "fixture-user@im.wechat" }] }),
        sendText: async () => ({ ok: false, reason: "context_missing", acceptedSegments: 0 }) } });
    await legacy.enable("fixture-bot", "fixture-user@im.wechat"); await legacy.close();
    let allowDelivery = false, generations = 0;
    const vaultRoot = path.join(root, "vault"); fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
    const archive = new NewsArchive(new DirectMarkdownVault(vaultRoot));
    if (mode === "degraded") fs.writeFileSync(path.join(vaultRoot, "news"), "fixture archive obstruction");
    const tasks = new ScheduledTasks({ diagnostics, databasePath: path.join(root, "tasks.sqlite"), now: () => clock,
      readOriginalText: (ref) => files.resolveQuery(ref) ?? undefined, dailyNewsImport: { state: store.load(), sourceHash: "fixture-legacy-store" },
      dailyNews: { researcher: mode === "degraded" ? new CombinedNewsResearcher(
        { generate: async ({ date }) => { generations++; return { date, generatedAt: clock, items: [{ title: "工具核验", summary: "研究要求核验工具返回的证据。", brief: "研究要求核验工具返回的证据。", source: "研究", url: "https://example.com/news", publishedAt: "2026-10-16T00:00:00Z" }] }; } },
        { generate: async () => { throw Object.assign(new Error("read reset"), { code: "ECONNRESET" }); } }, () => clock, 360_000, async () => JSON.stringify({ supported: true, generalCount: 5, hackerNewsCount: 5 }))
        : { generate: async ({ date }) => { generations++; return { date, generatedAt: clock, items: [] }; } }, ...(mode === "degraded" ? { archive } : {}) },
      channel: { state: (destination) => ({ enabled: true, ...channel.getDeliveryContext(destination.accountId, destination.target), ...(!allowDelivery ? { contextGeneration: null } : {}) }),
        subscribe: (listener) => channel.onSnapshotChanged(listener),
        send: ({ operationId, beforeSubmit, ...input }) => channel.sendText({ ...input, scheduled: { operationId, beforeSubmit } }) } });
    const queries: Array<{ request: WorkflowToolRequest; result: unknown }> = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }),
      { submit: async () => { throw new Error("unexpected terminal workflow"); } }, { execute: async (request, turn) => {
        const result = await tasks.execute(request, turn); queries.push({ request: structuredClone(request), result: structuredClone(result) }); return result;
      } }, { diagnostics });
    const agent = mode !== "live" ? new CodexConversation(() => new FixtureAppServerTransport(channel, (results) => JSON.stringify({ message: JSON.stringify(results), results: [] })), 90000, host)
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000, { webSearch: "disabled", serviceName: "scheduled_news_fixture_acceptance" });
    const codex = new WeixinCodexService(channel, agent, new CodexServiceStore(path.join(root, "codex.json")), root,
      Date.now, undefined, [], false, undefined, undefined, undefined, undefined, undefined, undefined,
      new WorkflowToolProductionControl(host, files), diagnostics);
    const demo = new DemoService(channel, async () => "fixture", codex); const server = createDemoServer(demo, { fixtureMode: true });
    const interactions: Array<{ command: string; reply: string; run: unknown }> = [];
    try {
      await codex.start(); await codex.enable("fixture-bot", "fixture-user@im.wechat"); channel.activateInboundDispatch(); await tasks.start();
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      const inbound = async (command: string, tool: string, args: Record<string, unknown>, expected: RegExp) => {
        if (mode !== "live") channel.queueFixtureModelToolCall({ namespace: "schedules", tool, arguments: args });
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
        const run = codex.getPublicState().runs.at(-1); interactions.push({ command, reply, run });
        expect(run?.phase).toBe("completed"); if (mode === "live") expect(reply).toMatch(expected); return reply;
      };
      const trusted = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "inspection-only", occurredAt: Date.now(), originalTextRef: "unused", attachmentRefs: [] };
      const inspect = () => tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "AI 新闻日报" } }, trusted);
      await inbound("查看 AI 新闻日报的设置和补发队列", "inspect", { reference: "AI 新闻日报" }, /08[:：]30|8[:：]30/u);
      const pause = "停用 AI 新闻日报";
      await inbound(pause, "disable", { reference: "AI 新闻日报", expectedRevision: 1, sourceText: pause }, /停用|暂停/u);
      expect(await inspect()).toMatchObject({ task: { enabled: false }, totalOccurrences: 1 });
      const resume = "启用 AI 新闻日报";
      await inbound(resume, "enable", { reference: "AI 新闻日报", expectedRevision: 2, sourceText: resume }, /启用|恢复/u);
      expect(channel.getFixtureTextOutbox()).toEqual([]); allowDelivery = true;
      const refresh = await inbound("刷新日报会话", "inspect", { reference: "AI 新闻日报" }, /刷新|会话|渠道|缓存|接受/u);
      await tasks.tick(); await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(1));
      expect(channel.getFixtureTextOutbox()[0]?.message).toBe("2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。");
      expect(generations).toBe(0);
      if (mode === "live") expect(refresh).not.toMatch(/请.{0,12}(?:再发|发送消息|刷新会话)/u);
      const edit = "把 AI 新闻日报改为每天晚上九点，只分析开源模型，使用上海时区。";
      await inbound(edit, "edit", { reference: "AI 新闻日报", expectedRevision: 3, instruction: "只分析开源模型", calendar: { time: "21:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, sourceText: edit }, /21[:：]00|九点/u);
      expect(await inspect()).toMatchObject({ task: { revision: 4, enabled: true, nextExecutionAt: "2026-10-16T13:00:00.000Z" } });
      const manual = "现在执行一次 AI 新闻日报，保留每天晚上九点的计划。";
      await inbound(manual, "run_now", { reference: "AI 新闻日报", expectedRevision: 4, sourceText: manual }, /执行|启动|开始|领取/u);
      await tasks.tick(); expect(generations).toBe(1);
      if (mode === "degraded") {
        await inbound("查看 AI 新闻日报本次执行结果", "inspect", { reference: "AI 新闻日报" }, /./u);
        expect(await inspect()).toMatchObject({ history: expect.arrayContaining([expect.objectContaining({ execution: "succeeded", delivery: "accepted",
          news: expect.objectContaining({ sources: { general: { status: "degraded", code: "insufficient_candidates", requested: 5, selected: 1 }, hackernews: { status: "failed", code: "ECONNRESET", requested: 5, selected: 0 } }, archiveWork: expect.objectContaining({ status: "pending", attempts: 1 }) }) })]) });
        expect(channel.getFixtureTextOutbox()[1]?.message).toBe("2026-10-16 AI 新闻\n\nAI 新闻\n\n1. 工具核验\n研究要求核验工具返回的证据。\n来源：研究\n\nHacker News：目标 5 条，本次 0 条；获取时连接中断，有限重试后仍未恢复。\n\nAI 新闻：目标 5 条，本次 1 条；当前候选中符合时间和内容要求且可核验的文章不足。");
      }
      const remove = "删除 AI 新闻日报，保留历史";
      await inbound(remove, "delete", { reference: "AI 新闻日报", expectedRevision: 4, sourceText: remove }, /删除/u);
      expect(await inspect()).toMatchObject({ task: { lifecycle: "deleted" }, totalOccurrences: 2 });
      expect(channel.getFixtureTextOutbox()).toHaveLength(2); expect(channel.getFixtureOutbox()).toEqual([]);
      await diagnostics.close(); const telemetry = await readDiagnostics(path.join(root, "otel"), { maxRecords: 1000 });
      expect(telemetry.records.filter((record) => record.name.startsWith("scheduled."))).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "scheduled.daily_news", kind: "span", attributes: expect.objectContaining({ status: "cached" }) }),
        expect.objectContaining({ name: "scheduled.output.persisted", attributes: expect.objectContaining({ status: "cached" }) }),
      ]));
      const evidence = { mode, interactions, queries, telemetry, scheduledState: await inspect(), outbox: channel.getFixtureTextOutbox(), mediaOutbox: channel.getFixtureOutbox(), generations };
      console.info(JSON.stringify({ mode, interactions, generations, outbox: evidence.outbox }));
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, `ticket-05-inbound-${mode}.json`), JSON.stringify(evidence, null, 2) + "\n");
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); await diagnostics.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});
