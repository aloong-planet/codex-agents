import { scriptedTurnRunner } from "./fixtures/scripted-turn-runner.js";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexServiceStore } from "../src/codex-service-store.js";
import { DemoService, type WeixinChannel } from "../src/demo-service.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { FixturePort } from "../src/fixture-port.js";
import { createDemoServer } from "../src/http-server.js";
import { ConsoleAccess } from "../src/console-access.js";
import { exchangeLoginLink } from "../e2e/console-session.js";
import { WeixinCodexService, type CodexAgent } from "../src/weixin-codex-service.js";

// HTTP fixture ingress uses the production inbox/service/store path. Only model
// and channel are fixtures; this does not establish receipt on a real phone.
describe("reply persistence through fixture HTTP ingress", () => {
  it("completes the durable inbound once and exposes the warning after channel acceptance", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-reply-save-failure-"));
    const stateFile = path.join(directory, "codex-service.json");
    const backup = `${stateFile}.before-failure`;
    const inbox = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
    const port = new FixturePort(inbox);
    const sent: string[] = [];
    let inboundKey = "";
    const channel: Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected"> = {
      getSnapshot: () => port.getSnapshot(),
      onInboundText: (listener) => port.onInboundText((event) => {
        inboundKey = event.key;
        return listener({
          ...event,
          replyText: async (text) => {
            const result = await event.replyText(text);
            sent.push(text);
            // Fixture typing is unavailable: the first send is its acknowledgement,
            // the second is the final reply. Fail real atomic file replacement.
            if (sent.length === 2) {
              fs.renameSync(stateFile, backup);
              fs.mkdirSync(stateFile);
            }
            return result;
          },
        });
      }),
    };
    const reply = vi.fn(async () => JSON.stringify({ message: "收到", results: [] }));
    const agent: CodexAgent = {
      startOrResume: async () => "019fef94-7da4-75a2-b9fb-226af024ddcd",
      runTurn: scriptedTurnRunner(reply), close: () => {},
    };
    const store = new CodexServiceStore(stateFile);
    const codex = new WeixinCodexService(channel, agent, store, directory);
    const demo = new DemoService(port, async () => "data:image/svg+xml,fixture", codex);
    const access = new ConsoleAccess({ directory: path.join(directory, "console") });
    const server = createDemoServer(demo, { fixtureMode: true, access });
    try {
      await port.start();
      await codex.start();
      await codex.enable("fixture-bot", "fixture-user@im.wechat");
      port.activateInboundDispatch();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture server address");
      const origin = `http://127.0.0.1:${address.port}`;
      const cookie = await exchangeLoginLink(access.issueLoginLink(address.port).url);
      const response = await fetch(`${origin}/api/fixture/inbound`, {
        method: "POST", headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ text: "只回复：收到" }),
      });
      expect(response.status).toBe(200);
      const state = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
      expect(inboundKey).toMatch(/^[a-f0-9]{64}$/);
      expect(inbox.peek(inboundKey)).toMatchObject({ state: "completed", attempts: 1 });
      expect(inbox.queuedTargets("fixture-bot")).toEqual([]);
      expect(reply).toHaveBeenCalledOnce();
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain("正在处理");
      expect(sent[1]).toBe("收到");
      expect(state.codex).toMatchObject({ status: "error", notice: expect.stringContaining("本地回复记录保存失败") });
      expect(state.codex.transcript.at(-1)).toMatchObject({ text: "收到", status: "accepted", businessResult: { results: [] } });
      expect(state.codex.runs).toEqual([expect.objectContaining({ phase: "completed" })]);
      expect(state.codex.notice).not.toContain(directory);
      expect(port.getFixtureOutbox()).toEqual([]);
    } finally {
      if (fs.existsSync(backup)) { fs.rmdirSync(stateFile); fs.renameSync(backup, stateFile); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close();
      inbox.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
