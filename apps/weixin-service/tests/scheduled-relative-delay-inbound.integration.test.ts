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
  it.skipIf(mode === "live" && process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("keeps relative delays one-time while retaining explicit recurrence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relative-delay-inbound-"));
    const inbox = new DurableInboundStore(path.join(root, "inbox.sqlite"));
    const channel = new FixturePort(inbox);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
    let clock = Date.now();
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

      const cases = [
        { command: "两分钟后提醒我微信验收731", body: "微信验收731", delay: 120 },
        { command: "3分钟后提醒我：飞书提醒验收842", body: "飞书提醒验收842", delay: 180 },
      ];
      const ids: string[] = [];
      for (const item of cases) {
        const before = queries.length;
        await inbound(item.command, "create", { name: item.body, instruction: item.body,
          reminderText: item.body, reminderMode: "verbatim", delaySeconds: item.delay, sourceText: item.command }, /731|842/u);
        const creates = queries.slice(before).filter((entry) => entry.request.toolId === "schedules.create");
        expect(creates).toHaveLength(1);
        const receipt = creates[0]!.result as { task: { id: string; nextExecutionAt: string } };
        expect(receipt).toMatchObject({ status: "created", task: { schedule: { kind: "once" } } });
        expect(Date.parse(receipt.task.nextExecutionAt) - clock).toBe(item.delay * 1000);
        ids.push(receipt.task.id);
      }
      const command = "每两分钟提醒我站起来，持续循环，名字叫循环对照";
      const before = queries.length;
      await inbound(command, "create", { name: "循环对照", instruction: "站起来", reminderText: "站起来", reminderMode: "natural", intervalSeconds: 120, sourceText: command }, /站|循环|两分钟|2.*分钟/u);
      const recurrent = queries.slice(before).filter((entry) => entry.request.toolId === "schedules.create");
      expect(recurrent).toHaveLength(1);
      expect(recurrent[0]!.result).toMatchObject({ status: "created", task: { schedule: { kind: "interval", everySeconds: 120 } } });
      clock += 180_000; await tasks.tick();
      for (const id of ids) expect(await inspect(id)).toMatchObject({ task: { lifecycle: "completed", nextExecutionAt: null }, totalOccurrences: 1 });
      clock += 180_000; await tasks.tick();
      for (const id of ids) expect(await inspect(id)).toMatchObject({ totalOccurrences: 1 });
      const outbox = channel.getFixtureTextOutbox();
      expect(outbox.filter((entry) => entry.message.includes("731"))).toHaveLength(1);
      expect(outbox.filter((entry) => entry.message.includes("842"))).toHaveLength(1);
      console.info(JSON.stringify({ mode, interactions, queries, outbox, final: await Promise.all(ids.map(inspect)) }));
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close(); tasks.close(); permissions.close(); inbox.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});
