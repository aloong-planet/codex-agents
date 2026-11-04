import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const port = 4328;
const baseUrl = `http://127.0.0.1:${port}`;
const demoCwd = path.resolve(process.cwd(), "../../apps/weixin-service");
const serverEntry = path.resolve(process.cwd(), "dist/server.mjs");

async function waitForFixture(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) return;
    } catch {
      // The fixture process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture Demo did not become ready");
}

function standardResult(value: Awaited<ReturnType<Client["callTool"]>>) {
  if ("toolResult" in value) throw new Error("unexpected task result");
  return value;
}

describe("bundled plugin against the real Demo HTTP boundary", () => {
  let demoProcess: ChildProcess;
  let transport: StdioClientTransport;
  let client: Client;

  beforeAll(async () => {
    demoProcess = spawn(process.execPath, ["dist/main.js"], {
      cwd: demoCwd,
      env: { ...process.env, DEMO_MODE: "fixture", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForFixture();

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, WEIXIN_DEMO_BASE_URL: baseUrl } as Record<string, string>,
      stderr: "pipe",
    });
    client = new Client(
      { name: "fixture-e2e", version: "0.1.0" },
      {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        } as never,
      },
    );
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close();
    if (demoProcess && !demoProcess.killed) demoProcess.kill("SIGTERM");
  });

  it("walks QR, inbound target confirmation, and fixture send through stdio MCP", async () => {
    const shown = standardResult(
      await client.callTool({ name: "show_weixin_panel", arguments: {} }),
    );
    expect(shown.structuredContent).toMatchObject({ phase: "configured" });

    await client.callTool({ name: "start_weixin_login", arguments: {} });
    let loginState = standardResult(
      await client.callTool({ name: "get_weixin_state", arguments: {} }),
    );
    for (let index = 0; index < 20 && !loginState._meta?.qrDataUrl; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      loginState = standardResult(
        await client.callTool({ name: "get_weixin_state", arguments: {} }),
      );
    }
    expect(loginState._meta?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(loginState.structuredContent)).not.toContain("fixture-browser-test");
    expect(JSON.stringify(loginState.content)).not.toContain("fixture-browser-test");

    const discovered = standardResult(
      await client.callTool({ name: "discover_weixin_targets", arguments: {} }),
    );
    expect(discovered.structuredContent?.targets).toEqual([
      expect.objectContaining({
        accountId: "fixture-bot",
        target: "fixture-user@im.wechat",
        label: "测试目标",
      }),
    ]);

    const confirmed = standardResult(
      await client.callTool({
        name: "confirm_weixin_session",
        arguments: {
          accountId: "fixture-bot",
          target: "fixture-user@im.wechat",
          inboundConfirmed: true,
        },
      }),
    );
    expect(confirmed.structuredContent).toMatchObject({ phase: "ready" });

    const sent = standardResult(
      await client.callTool({
        name: "send_weixin_test_message",
        arguments: { message: "fixture plugin test", outboundConfirmed: true },
      }),
    );
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toMatchObject({ phase: "sent" });
    expect(JSON.stringify(sent)).not.toMatch(/context_token|bot_token/i);
  }, 20_000);
});
