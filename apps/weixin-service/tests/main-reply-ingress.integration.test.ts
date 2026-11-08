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

// Inject model output at the external model boundary; do not inject semantic
// decisions into the service. These cases do not claim real-phone delivery.
describe("main reply protocol through HTTP fixture ingress", () => {
  it.each([
    { name: "malformed JSON", raw: "private-output-json", code: "main_reply_invalid_json" },
    { name: "invalid schema", raw: '{"message":"private-output-schema","results":[{"subject":"secret"}]}', code: "main_reply_invalid_schema" },
    { name: "oversized output", raw: "private-output-".repeat(7000), code: "main_reply_too_large" },
  ])("isolates $name from delivery and the next inbound turn", async ({ raw, code }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-results-ingress-"));
    const inbox = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
    const port = new FixturePort(inbox);
    const sent: string[] = [];
    const keys: string[] = [];
    const channel: Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected"> = {
      getSnapshot: () => port.getSnapshot(),
      onInboundText: (listener) => port.onInboundText((event) => {
        keys.push(event.key);
        return listener({ ...event, replyText: async (message) => {
          sent.push(message);
          return event.replyText(message);
        } });
      }),
    };
    const reply = vi.fn(async () => JSON.stringify({ message: "收到", results: [] })).mockResolvedValueOnce(raw);
    const agent: CodexAgent = {
      startOrResume: async () => "019fef94-7da4-75a2-b9fb-226af024ddcd", runTurn: scriptedTurnRunner(reply), close: () => {},
    };
    const store = new CodexServiceStore(path.join(directory, "codex-service.json"));
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
      if (!address || typeof address === "string") throw new Error("missing fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      const cookie = await exchangeLoginLink(access.issueLoginLink(address.port).url);
      const send = () => fetch(`${origin}/api/fixture/inbound`, {
        method: "POST", headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ text: "只回复：收到" }),
      });
      expect((await send()).status).toBe(200);
      const failed = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
      expect(sent).toHaveLength(2); // Unavailable fixture typing sends one acknowledgement.
      expect(sent[1]).toBe("我暂时无法处理这条消息，请稍后再发一条新消息。");
      expect(reply).toHaveBeenCalledOnce();
      expect(failed.codex.transcript.at(-1)).toMatchObject({ status: "agent_failed", replyFailure: code });
      expect(failed.codex.transcript.at(-1)).not.toHaveProperty("businessResult");
      expect(failed.codex.runs[0].phase).toBe("failed");
      expect(JSON.stringify(failed)).not.toContain("private-output");
      expect(store.load().transcript.at(-1)?.replyFailure).toBe(code);

      expect((await send()).status).toBe(200);
      const recovered = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
      expect(sent).toHaveLength(4);
      expect(sent[3]).toBe("收到");
      expect(reply).toHaveBeenCalledTimes(2);
      expect(recovered.codex.transcript.at(-1)).toMatchObject({ text: "收到", status: "accepted", businessResult: { results: [] } });
      expect(recovered.codex.transcript.at(-1)).not.toHaveProperty("replyFailure");
      expect(recovered.codex.runs[0].phase).toBe("completed");
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) expect(inbox.peek(key)).toMatchObject({ state: "completed", attempts: 1 });
      expect(inbox.queuedTargets("fixture-bot")).toEqual([]);
      expect(port.getFixtureOutbox()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close();
      inbox.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
