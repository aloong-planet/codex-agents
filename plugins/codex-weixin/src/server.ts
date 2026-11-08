import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { defaultStateDirectory, sharedPluginCredentials } from "./console-control-client.js";
import { DemoHttpClient } from "./demo-http-client.js";
import { createWeixinMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const client = new DemoHttpClient(
    process.env.WEIXIN_DEMO_BASE_URL ?? "http://127.0.0.1:4317",
    fetch,
    sharedPluginCredentials(defaultStateDirectory(process.env)),
  );
  const server = createWeixinMcpServer(client);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知错误";
  process.stderr.write(`微信直连 MCP Server 启动失败：${message}\n`);
  process.exitCode = 1;
});
