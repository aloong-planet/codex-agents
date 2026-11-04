import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWeixinMcpServer } from "../src/mcp-server.js";

const qrDataUrl = "data:image/png;base64,private-qr";

function fakeDemoClient() {
  return {
    getState: async () => ({
      modelState: {
        phase: "awaiting_scan",
        notice: "真实二维码已生成",
        accounts: [],
        targets: [],
      },
      privateUi: { qrDataUrl, permissionCandidates: [] },
    }),
  };
}

describe("Weixin MCP Apps server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("renders a private QR panel while keeping QR bytes out of model-visible content", async () => {
    const server = createWeixinMcpServer(fakeDemoClient());
    const client = new Client(
      { name: "test-client", version: "0.1.0" },
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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    const showTool = tools.tools.find((tool) => tool.name === "show_weixin_panel");
    expect(showTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://codex-weixin/panel.html" },
    });

    const result = await client.callTool({ name: "show_weixin_panel", arguments: {} });
    expect(result.structuredContent).toMatchObject({ phase: "awaiting_scan" });
    expect(JSON.stringify(result.content)).not.toContain("private-qr");
    expect(JSON.stringify(result.structuredContent)).not.toContain("private-qr");
    expect(result._meta).toEqual({ qrDataUrl });

    const resource = await client.readResource({ uri: "ui://codex-weixin/panel.html" });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
    });
    const panel = resource.contents[0];
    expect(panel && "text" in panel ? panel.text : "").toContain("微信直连助手");
    expect(panel && "text" in panel ? panel.text : "").toContain("增强受控");
    expect(panel && "text" in panel ? panel.text : "").toContain("permissionForm");
    expect(panel && "text" in panel ? panel.text : "").not.toContain("允许本地文件写入");
    expect(panel && "text" in panel ? panel.text : "").not.toContain("fetch(");
  });

  it("opens the selected private task through an app-only tool without returning its thread ID", async () => {
    const openCodexDesktop = vi.fn(async () => fakeDemoClient().getState());
    const server = createWeixinMcpServer({ ...fakeDemoClient(), openCodexDesktop });
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(() => client.close(), () => server.close());

    const result = await client.callTool({
      name: "open_weixin_codex_desktop_thread",
      arguments: { accountId: "bot-a", target: "user@im.wechat" },
    });

    expect(openCodexDesktop).toHaveBeenCalledWith("bot-a", "user@im.wechat");
    expect(JSON.stringify(result)).not.toContain("019fef94");
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("已请求 Codex Desktop") }),
    ]);
  });
});
