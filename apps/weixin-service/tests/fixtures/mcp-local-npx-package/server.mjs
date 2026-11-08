#!/usr/bin/env node
// A dependency-free stdio MCP server for the MCP catalog's sandbox test: npx runs it from this local folder, so no
// package is downloaded. It answers the 2025 handshake, lists one tool and reports the npm settings it received;
// any other request gets "method not found", which makes the client fall back to that handshake.
import process from "node:process";
import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const TOOL = { name: "npm_settings", description: "Returns the npm settings this process received.", inputSchema: { type: "object", properties: {} } };

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local-npx-test-server", version: "1.0.0" } } });
      return;
    case "tools/list":
      send({ id: message.id, result: { tools: [TOOL] } });
      return;
    case "tools/call":
      send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ cache: process.env.npm_config_cache ?? null, userconfig: process.env.npm_config_userconfig ?? null }) }] } });
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
