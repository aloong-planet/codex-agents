import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { FixtureAppServerTransport } from "../src/fixture-app-server-transport.js";
import { FixturePort } from "../src/fixture-port.js";
import { WeixinCodexService } from "../src/weixin-codex-service.js";

// Uses the fixture Weixin entry and production conversation/turn adapter. The
// peer Error follows the real transport exit callback; it does not establish
// the cause of the 2026-11-03 process exit or prove real-model/phone delivery.
// All resources are cheap, per-case mutable stores/peers; no model or server boot.
describe("conversation recovery through fixture Weixin ingress", () => {
  it("automatically continues the original fixture message after a model disconnect", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-recovery-"));
    const port = new FixturePort();
    let connections = 0;
    const submitted: string[] = [];
    const agent = new CodexConversation(() => {
      const attempt = ++connections;
      return new FixtureAppServerTransport({ takeFixtureModelToolCall: () => undefined },
        () => attempt === 1 ? new Error("process disconnected") : JSON.stringify({ message: "自动恢复731", results: [] }),
        (turn) => submitted.push(turn.threadId));
    }, 600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    const service = new WeixinCodexService(port, agent, new CodexServiceStore(path.join(root, "state.json")), root);
    try {
      await port.start(); await service.start(); await service.enable("fixture-bot", "fixture-user@im.wechat");
      await port.emitFixtureInbound("只回复：自动恢复731");
      expect(port.getFixtureReplies().map((entry) => entry.message)).toEqual(["已收到，正在处理。", "自动恢复731"]);
      expect(connections).toBe(2);
      expect(submitted).toHaveLength(2);
      expect(submitted[0]).toBe(submitted[1]);
      expect(service.getPublicState().runs.map((run) => run.phase)).toEqual(["completed"]);
    } finally { await service.close(); await port.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("stops automatic continuation if file authorization changed during the interrupted request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-authorization-"));
    const port = new FixturePort(); let submissions = 0;
    const agent = new CodexConversation(() => new FixtureAppServerTransport({ takeFixtureModelToolCall: () => undefined },
      () => { service.narrowFileAccessContext(); return new Error("process disconnected"); }, () => { submissions++; }),
      600_000, undefined, undefined, 300_000, { automaticRecovery: true });
    const service = new WeixinCodexService(port, agent, new CodexServiceStore(path.join(root, "state.json")), root);
    try {
      await port.start(); await service.start(); await service.enable("fixture-bot", "fixture-user@im.wechat");
      await port.emitFixtureInbound("读取已授权文件");
      expect(submissions).toBe(1);
      expect(port.getFixtureReplies().map(entry => entry.message)).toEqual(["已收到，正在处理。",
        "模型连接中断，自动恢复未能完成，本次请求已停止。请稍后再发一条新消息。"]);
      expect(service.getPublicState().runs.map(run => run.phase)).toEqual(["failed"]);
    } finally { await service.close(); await port.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("preserves the exit reason without allowing an observer failure to block recovery (throw=%s)", async (throws) => {
    let fail = true;
    const failures: string[] = [];
    const agent = new CodexConversation(() => new FixtureAppServerTransport(
      { takeFixtureModelToolCall: () => undefined },
      () => fail ? new Error("Codex App Server 已退出（code=null, signal=SIGTERM）") : "recovered",
    ), 600_000, undefined, undefined, 300_000, {
      onConnectionFailure: (error) => { failures.push(error.message); if (throws) throw new Error("observer unavailable"); },
    });
    try {
      const threadId = await agent.startOrResume(undefined, "/tmp");
      await expect(agent.runTurn(threadId, "first message")).rejects.toThrow("signal=SIGTERM");
      expect(failures).toEqual(["Codex App Server 已退出（code=null, signal=SIGTERM）"]);
      expect(agent.isThreadReady(threadId)).toBe(false);
      fail = false;
      expect(await agent.startOrResume(threadId, "/tmp")).toBe(threadId);
      await expect(agent.runTurn(threadId, "new message")).resolves.toEqual({ owner: "model_owned", finalText: "recovered" });
    } finally { await agent.close(); }
  });
  it("does not replay an interrupted message and resumes its thread for the next message", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-recovery-"));
    const port = new FixturePort();
    const observed: Array<{ threadId: string; input: unknown }> = [];
    let fail = true;
    const agent = new CodexConversation(() => new FixtureAppServerTransport(
      { takeFixtureModelToolCall: () => undefined },
      () => fail ? new Error("Codex App Server 已退出（code=1, signal=null）") : JSON.stringify({ message: "连接恢复正常", results: [] }),
      (turn) => observed.push(turn),
    ));
    const service = new WeixinCodexService(port, agent, new CodexServiceStore(path.join(root, "state.json")), root);
    try {
      await port.start();
      await service.start();
      await service.enable("fixture-bot", "fixture-user@im.wechat");
      await port.emitFixtureInbound("帮我研究下这个开源skill lemon opuscar");
      const failed = service.getPublicState();
      expect(failed.runs.map((run) => run.phase)).toEqual(["failed"]);
      expect(failed.threadReady).toBe(false);
      expect(port.getFixtureReplies().map((entry) => entry.message)).toEqual([
        "已收到，正在处理。", "我暂时无法处理这条消息，请稍后再发一条新消息。",
      ]);
      fail = false;
      await port.emitFixtureInbound("只回复：连接恢复正常");
      expect(port.getFixtureReplies().map((entry) => entry.message)).toEqual([
        "已收到，正在处理。", "我暂时无法处理这条消息，请稍后再发一条新消息。",
        "已收到，正在处理。", "连接恢复正常",
      ]);
      expect(observed).toHaveLength(2);
      expect(observed[0]!.threadId).toBe(observed[1]!.threadId);
      expect(JSON.stringify(observed[0]!.input)).toContain("lemon opuscar");
      expect(JSON.stringify(observed[1]!.input)).toContain("只回复：连接恢复正常");
      expect(service.getPublicState().runs.map((run) => run.phase)).toEqual(["completed"]);
      expect(service.getPublicState().threadReady).toBe(true);
      console.log(JSON.stringify({ kind: "connection_recovery_fixture_transcript",
        commands: ["帮我研究下这个开源skill lemon opuscar", "只回复：连接恢复正常"],
        replies: port.getFixtureReplies(), firstRun: failed.runs, finalRun: service.getPublicState().runs,
        modelSubmissions: observed.length, workflowEffects: "not applicable: ordinary text replies", outbox: port.getFixtureOutbox(),
      }));
    } finally {
      await service.close(); await port.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
