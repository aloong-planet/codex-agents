import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("plugin package", () => {
  it("starts the bundled MCP server relative to the installed plugin root", () => {
    const config = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { args?: string[]; cwd?: string }>;
    };

    expect(config.mcpServers["codex-weixin"]).toMatchObject({
      args: ["dist/server.mjs"],
      cwd: ".",
    });
  });
});
