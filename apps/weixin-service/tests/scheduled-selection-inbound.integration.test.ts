import { withArticleAssessment } from "./fixtures/assessed-news-run.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
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
import type { DailyAiNewsState } from "../src/daily-ai-news-scheduler.js";

import { CodexCliNewsResearcher, CodexHackerNewsResearcher, CombinedNewsResearcher, type CodexNewsRun } from "../src/codex-news-researcher.js";

// Production fixture ingress, real tools/SQLite/researchers; only external model/web/channel are substituted.
// Scripted replies prove wiring, not natural-language interpretation. Live mode is explicitly opt-in.
describe.each(["scripted", "live", "content"])("current HN and retained history (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("queries, runs twice, and queries the latest result without changing settings", async () => {
    const fixtureStartedAt = performance.now();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-selection-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite")), channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    let clock = Date.parse("2026-10-17T10:00:00Z"), summaries = 0, reads = 0;
    const instruction = "仅检索过去24小时 Hacker News 热门技术，按热度选取 Top 7；不再单独检索或发送 AI 新闻栏目。核验来源，生成中文摘要并写入本地归档。";
    const legacy: DailyAiNewsState = { version: 2, enabledTarget: { accountId: "fixture-bot", target: "fixture-user@im.wechat", enabledAt: clock }, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null };
    const run: CodexNewsRun = async ({ schema, prompt }) => {
      if ("generalCount" in (schema as { properties: object }).properties) return JSON.stringify({ supported: true, generalCount: 0, hackerNewsCount: 7 });
      const candidate = JSON.parse(prompt.split("候选元数据：")[1]!.split("\n")[0]!) as { title: string; url: string; submittedAt: string };
      summaries++;
      if (mode === "content" && candidate.url.endsWith("/1")) return JSON.stringify({ assessment: { status: "mismatched", evidence: "广告主题与候选不符" }, items: [] });
      return JSON.stringify({ ...(mode === "content" ? { assessment: { status: "matched", evidence: "研究结果仅适用于所测任务，并提供了完整的实验过程与限制。" } } : {}), items: [{ section: "hackernews", title: candidate.title, source: "研究 / Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
        summary: "研究通过对照实验说明方法有所改善，但结论仅限所测任务。", brief: "对照实验显示方法有所改善，但结论仅限所测任务。" }] });
    };
    const hn = new CodexHackerNewsResearcher(mode === "content" ? run : withArticleAssessment(run), async () => Array.from({ length: mode === "content" ? 2 : 10 }, (_, i) => ({ id: i + 1, rank: i + 1, title: `技术文章${i + 1}`,
      url: `https://example.test/article/${i + 1}`, submittedAt: "2026-10-17T09:00:00Z", score: 100 - i, comments: 10 })), () => clock,
      async (url) => { reads++; if (mode === "content" && url.endsWith("/1")) return { title: "技术文章1", markdown: "广告页面只介绍另一个产品的限时折扣，没有候选技术文章的正文或观点。" }; return { title: "研究", markdown: "研究结果仅适用于所测任务，并提供了完整的实验过程与限制。" }; });
    const tasks = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), now: () => clock, readOriginalText: (ref) => files.resolveQuery(ref) ?? undefined,
      dailyNewsImport: { state: legacy, sourceHash: "synthetic-current-hn" }, dailyNews: { researcher: new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => clock, 360_000, run) },
      channel: { state: (destination) => ({ enabled: true, ...channel.getDeliveryContext(destination.accountId, destination.target) }), subscribe: (listener) => channel.onSnapshotChanged(listener),
        send: ({ operationId, beforeSubmit, ...input }) => channel.sendText({ ...input, scheduled: { operationId, beforeSubmit } }) } });
    const queries: Array<{ request: WorkflowToolRequest; result: unknown }> = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }),
      { submit: async () => { throw new Error("unexpected workflow"); } }, { execute: async (request, turn) => {
        const result = await tasks.execute(request, turn); queries.push({ request: structuredClone(request), result: structuredClone(result) }); return result;
      } });
    const agent = mode !== "live" ? new CodexConversation(() => new FixtureAppServerTransport(channel, (results) => JSON.stringify({ message: JSON.stringify(results), results: [] })), 90000, host)
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000,
        { webSearch: "disabled", serviceName: "scheduled_selection_fixture" });
    const codex = new WeixinCodexService(channel, agent, new CodexServiceStore(path.join(root, "codex.json")), root,
      Date.now, undefined, [], false, undefined, undefined, undefined, undefined, undefined, undefined, new WorkflowToolProductionControl(host, files));
    const demo = new DemoService(channel, async () => "fixture", codex), server = createDemoServer(demo, { fixtureMode: true });
    const trusted = { accountId: "fixture-bot", target: "fixture-user@im.wechat", eventKey: "setup", occurredAt: clock, originalTextRef: "unused", attachmentRefs: [] };
    const inspect = async () => await tasks.execute({ toolId: "schedules.inspect", toolVersion: 1, arguments: { reference: "AI 新闻日报" } }, trusted) as {
      task: { id: string; revision: number; instruction: string; enabled: boolean }; totalOccurrences: number; history: Array<{ id: string; execution: string; delivery: string }> };
    const interactions: Array<{ command: string; reply: string; run: unknown; tools: unknown }> = [];
    try {
      await codex.start(); await codex.enable("fixture-bot", "fixture-user@im.wechat"); channel.activateInboundDispatch();
      const source = "将测试日报设为 HN Top 7 并停用";
      const ref = files.captureQuery("setup", source).handle;
      for (const [tool, args] of [["edit", { expectedRevision: 1, instruction }], ["disable", { expectedRevision: 2 }]] as const) {
        await tasks.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: { reference: "AI 新闻日报", ...args, sourceText: source } }, { ...trusted, originalTextRef: ref });
      }
      // Fill the public retained history, not the database, before reproducing the three-step user flow.
      const seeded = mode === "content" ? 0 : 31;
      for (let i = 0; i < seeded; i++) {
        clock += 60_000;
        await tasks.execute({ toolId: "schedules.run_now", toolVersion: 1, arguments: { reference: "AI 新闻日报", expectedRevision: 3, sourceText: source } },
          { ...trusted, eventKey: `seed-${i}`, originalTextRef: ref, occurredAt: clock });
        await tasks.tick();
      }
      const settings = (await inspect()).task;
      expect((await inspect()).totalOccurrences).toBe(seeded);
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      console.info(`history-selection fixture mode=${mode} builds=1 setupMs=${Math.round(performance.now() - fixtureStartedAt)}`);
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      const inbound = async (command: string, call: { tool: string; arguments: Record<string, unknown> }) => {
        const before = queries.length;
        if (mode !== "live") channel.queueFixtureModelToolCall({ namespace: "schedules", ...call });
        const response = await fetch(`${origin}/api/fixture/inbound`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: command }) });
        expect(response.status).toBe(200);
        const reply = codex.getPublicState().transcript.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "";
        const currentRun = codex.getPublicState().runs.at(-1);
        const tools = queries.slice(before);
        interactions.push({ command, reply, run: currentRun, tools });
        expect(currentRun?.phase).toBe("completed"); expect(reply).not.toBe("");
        return tools;
      };
      await inbound("查看 AI 新闻日报的设置和执行历史。", { tool: "inspect", arguments: { reference: settings.id } });
      let expectedCount = seeded;
      for (const command of ["现在执行一次 AI 新闻日报，保持设置不变。", "再执行一次 AI 新闻日报，Top 7 允许再次展示旧文章，保持设置不变。"] ) {
        clock += 60_000;
        const effects = await inbound(command, { tool: "run_now", arguments: { reference: settings.id, expectedRevision: 3, sourceText: command } });
        expect(effects.filter((item) => !["schedules.inspect", "schedules.list", "schedules.read_text"].includes(item.request.toolId)).map((item) => item.request.toolId)).toEqual(["schedules.run_now"]);
        const started = effects.find((item) => item.request.toolId === "schedules.run_now")!.result as { occurrenceId: string };
        await tasks.tick();
        const state = await inspect();
        expect(state).toMatchObject({ totalOccurrences: ++expectedCount, executionCount: expectedCount, executionCountKind: "known_minimum", historyCountKind: "retained" });
        expect(state.history[0]).toMatchObject({ id: started.occurrenceId, execution: "succeeded", delivery: "accepted" });
        if (mode === "content") expect(state.task).toMatchObject({ id: settings.id, revision: 3, enabled: false, instruction,
          schedule: { kind: "calendar", time: "08:30" } });
        else expect(state.task).toEqual(settings);
        await inbound("查看 AI 新闻日报刚才这次执行的记录和当前保留记录数量。", { tool: "inspect", arguments: { reference: settings.id, occurrenceId: started.occurrenceId } });
        const message = channel.getFixtureTextOutbox().at(-1)?.message;
        if (mode === "content") {
          expect(message).toContain("1. 技术文章2");
          expect(message).not.toContain("技术文章1");
          expect(message).toContain("Hacker News：目标 7 条，本次 1 条；部分候选标题与正文不一致，已跳过。");
          expect(state.history[0]).toMatchObject({ news: { sources: { hackernews: { status: "degraded", code: "article_content_mismatch", requested: 7, selected: 1 } } } });
        } else expect(message).toContain("7. 技术文章7");
      }
      expect({ reads, summaries }).toEqual(mode === "content" ? { reads: 3, summaries: 3 } : { reads: 7, summaries: 7 });
      expect(channel.getFixtureTextOutbox()).toHaveLength(seeded + 2);
      expect(channel.getFixtureOutbox()).toEqual([]);
    } finally {
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, `history-selection-${mode}.json`), JSON.stringify({ mode, interactions, state: await inspect(), reads, summaries,
          outbox: channel.getFixtureTextOutbox().slice(-2), mediaOutbox: channel.getFixtureOutbox(), note: "Synthetic fixture channel only; no real Weixin send." }, null, 2) + "\n");
      }
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600000);
});
