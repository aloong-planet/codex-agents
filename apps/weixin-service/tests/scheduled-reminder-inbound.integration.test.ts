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
describe.each(["scripted", "live"])("reminder wording fixture ingress (%s)", (mode) => {
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("normalizes only content writes and delivers saved recipient-facing text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reminder-wording-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite"));
    const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    let clock = Date.parse("2026-10-15T02:00:00Z");
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
      : new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MAIN_WEIXIN_DISABLED_FEATURES), 90000, host, undefined, 60000, { webSearch: "disabled", serviceName: "reminder_wording_fixture_acceptance" });
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
        if (mode === "scripted") channel.queueFixtureModelToolCall({ namespace: "schedules", tool, arguments: args });
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

      const scenarios = [
        { name: "活动提醒", command: "每分钟提醒我活动一下，只发送文字提醒，名字叫活动提醒。", instruction: "提醒用户活动一下", body: "你应该活动一下了", expected: /^你应该活动一下了[。！!]?$/u },
        { name: "回电提醒", command: "每分钟提醒我让小王给我回电话，名字叫回电提醒。", instruction: "提醒用户让小王回电话", body: "记得让小王给你回电话。", expected: /小王给你回电话/u },
        { name: "转述提醒", command: "每分钟提醒我对妈妈说“我晚点回家”，名字叫转述提醒。", instruction: "提醒用户对妈妈转述原话", body: "记得对妈妈说“我晚点回家”。", expected: /妈妈说[“「"]我晚点回家[”」"]/u },
        { name: "文件提醒", command: "每分钟提醒我不要把这两份文件发给小王，名字叫文件提醒。", instruction: "提醒用户不要发送两份文件", body: "记得不要把这两份文件发给小王。", expected: /不要.*两份文件.*小王/u },
        { name: "期限提醒", command: "每分钟提醒我在2026年10月20日17点前提交两份报告，名字叫期限提醒。", instruction: "提醒用户在指定期限前提交两份报告", body: "记得在2026年10月20日17点前提交两份报告。", expected: /2026.*10.*20.*17.*前.*两份报告/u },
        { name: "English reminder", command: "Remind me every minute to take a break. Name it English reminder. Keep the reminder in English.", instruction: "Remind the user to take a break", body: "You should take a break now.", expected: /(?:you|take|time).*break/iu },
        { name: "原样提醒", command: "每分钟原样发送下面引号内的文字，名字叫原样提醒：“  我今天不加班\n明天再说  ”", instruction: "发送指定原文", body: "  我今天不加班\n明天再说  ", expected: /^ {2}我今天不加班\n明天再说 {2}$/u, verbatim: true },
      ];
      for (const scenario of scenarios) {
        const reply = await inbound(scenario.command, "create", { name: scenario.name, instruction: scenario.instruction, reminderText: scenario.body, reminderMode: scenario.verbatim ? "verbatim" : "natural", intervalSeconds: 60, sourceText: scenario.command }, /创建|保存|设置|created|scheduled|saved/iu);
        const saved = await inspect(scenario.name) as { task: { id: string; reminderText: string } };
        expect(saved).toMatchObject({ task: { reminderMode: scenario.verbatim ? "verbatim" : "natural", schedule: { kind: "interval", everySeconds: 60 } } });
        expect(saved.task.reminderText).toMatch(scenario.expected);
        expect(saved.task.reminderText).not.toMatch(/每分钟|只发送文字|名字叫|every minute|English reminder|提醒：/iu);
        if (mode === "live") { expect(reply).toContain(saved.task.reminderText); expect(reply).toContain(saved.task.id); }
      }
      const initial = await inspect("活动提醒") as { task: { id: string; reminderText: string } };
      const id = initial.task.id;
      const rename = "把活动提醒改名为起身提醒，周期改为每两分钟，提醒正文不要改。";
      await inbound(rename, "edit", { reference: id, expectedRevision: 1, sourceText: rename, name: "起身提醒", intervalSeconds: 120 }, /修改|更新/u);
      expect(await inspect(id)).toMatchObject({ task: { name: "起身提醒", reminderText: initial.task.reminderText, revision: 2, schedule: { everySeconds: 120 } } });
      const edit = "把起身提醒的内容改为原样发送“我今天不加班”，保持现有周期。";
      const edited = await inbound(edit, "edit", { reference: id, expectedRevision: 2, sourceText: edit, instruction: "发送指定原文", reminderText: "我今天不加班", reminderMode: "verbatim" }, /我今天不加班/u);
      expect(await inspect(id)).toMatchObject({ task: { reminderText: "我今天不加班", reminderMode: "verbatim", revision: 3, schedule: { everySeconds: 120, firstAt: "2026-10-15T02:02:00.000Z" } } });
      expect(edited).toContain("我今天不加班");
      const cancel = "取消起身提醒，不要再提醒我。";
      await inbound(cancel, "disable", { reference: id, expectedRevision: 3, sourceText: cancel }, /停用|取消|删除/u);
      expect(await inspect(id)).toMatchObject({ task: { enabled: false } });
      const ambiguous = "每分钟提醒我把文件发给他，名字叫歧义提醒；这里的他是新提到的人。";
      if (mode === "live") {
        await inbound(ambiguous, "list", {}, /谁|哪[位个]|明确|具体|确认|姓名/u);
        expect(await inspect("歧义提醒")).toMatchObject({ status: "not_found" });
      }
      const extraStates: unknown[] = [];
      if (mode === "live") {
        const relative = "现在是2026年10月15日上午十点。每分钟提醒我明天下午五点前提交报告，名字叫截止提醒。";
        await inbound(relative, "list", {}, /创建|保存|设置/u);
        const deadline = await inspect("截止提醒") as { task: { reminderText: string } };
        expect(deadline.task.reminderText).toMatch(/10.*16.*(?:17|下午.*[5五]).*前.*报告/u);
        expect(deadline.task.reminderText).not.toMatch(/明天|每分钟/u);
        await inbound("停用截止提醒", "list", {}, /停用|暂停/u);
        expect(await inspect("截止提醒")).toMatchObject({ task: { enabled: false } });
        extraStates.push(await inspect("截止提醒"));
        const dynamic = "每分钟提醒我距离明天下午五点还剩多久，名字叫倒计时提醒；每次都要重新计算剩余时间。";
        await inbound(dynamic, "list", {}, /无法|不能|不支持|固定|静态|确认|改成/u);
        expect(await inspect("倒计时提醒")).toMatchObject({ status: "not_found" });
      }
      clock = Date.parse("2026-10-15T02:01:00Z"); await tasks.tick();
      await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(6));
      const first = channel.getFixtureTextOutbox().map((entry) => entry.message);
      for (const scenario of scenarios.slice(1)) expect(first.filter((body) => scenario.expected.test(body))).toHaveLength(1);
      clock = Date.parse("2026-10-15T02:02:00Z"); await tasks.tick();
      const outbox = channel.getFixtureTextOutbox(); expect(outbox).toHaveLength(12);
      // Match each literal/semantic payload independently, then verify persistence across later ticks.
      expect(outbox.slice(6).map((entry) => entry.message).sort()).toEqual([...first].sort());
      expect(channel.getFixtureOutbox()).toEqual([]);
      const states = await Promise.all(scenarios.map((scenario) => inspect(scenario.name === "活动提醒" ? id : scenario.name)));
      const evidence = { mode, interactions, queries, states, extraStates, outbox, mediaOutbox: channel.getFixtureOutbox() };
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, `ticket-03-wording-${mode}.json`), JSON.stringify(evidence, null, 2) + "\n");
      }

    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600000);
});
