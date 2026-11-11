// A real stdio MCP server for the MCP Catalog tests, built on the official server SDK so that the wire format
// does not come from our own implementation.
//
// Usage: node mcp-test-server.mjs --tools <file> [--marker <file>] [--fail-flag <file>] [--no-list-changed]
//
// - --tools: a JSON array of extra tool definitions (MCP Tool objects), re-read when the file changes. Unless
//   --no-list-changed is given, the server declares tools.listChanged and notifies the client on every change.
// - --marker: on start, the server appends one JSON line { pid, argv, cwd, secretToken } to this file; secretToken is
//   the SECRET_TOKEN it received, or null.
// - --fail-flag: while this file exists, the server prints its SECRET_TOKEN to stderr, ending with a line that holds
//   the token and a piece of HTML, and exits with code 1.
//
// Fixed tools: `env` (the process environment and working directory), `whoami` (pid and argv), `read_file` and
// `write_file` (for the sandbox case).
//
// An extra tool answers `called <name>`, unless its `_meta` asks for more: `test/answer` is the text it answers instead;
// `test/delayMs` waits that long first; `test/image` answers with an image block before the text;
// `test/structuredToken` also returns the SECRET_TOKEN in structured content, as a value, inside a list and as a key;
// `test/failWithToken` fails the request with a message that holds the SECRET_TOKEN.
import fs from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const toolsFile = option("--tools");
const marker = option("--marker");
const failFlag = option("--fail-flag");
const listChanged = !process.argv.includes("--no-list-changed");

if (marker) fs.appendFileSync(marker, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), secretToken: process.env.SECRET_TOKEN ?? null })}\n`);
if (failFlag && fs.existsSync(failFlag)) {
  process.stderr.write(`starting with token ${process.env.SECRET_TOKEN ?? "(none)"}\n`);
  process.stderr.write(`fatal: could not authenticate with ${process.env.SECRET_TOKEN ?? "(none)"} <a href="https://evil.example/login">重新登录</a><img src="x">\n`);
  process.exit(1);
}

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required });
const FIXED = [
  { name: "env", description: "Returns the environment and working directory of this process.", inputSchema: objectSchema() },
  { name: "whoami", description: "Returns the process id and arguments of this process.", inputSchema: objectSchema() },
  { name: "read_file", description: "Reads a UTF-8 file.", inputSchema: objectSchema({ path: { type: "string" } }, ["path"]) },
  { name: "write_file", description: "Writes a UTF-8 file.", inputSchema: objectSchema({ path: { type: "string" }, text: { type: "string" } }, ["path", "text"]) },
];

function extraTools() {
  if (!toolsFile) return [];
  try {
    return JSON.parse(fs.readFileSync(toolsFile, "utf8"));
  } catch {
    return [];
  }
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

const server = new Server(
  { name: "catalog-test-server", version: "1.4.2" },
  { capabilities: { tools: listChanged ? { listChanged: true } : {} } },
);
server.setRequestHandler("tools/list", async () => ({ tools: [...FIXED, ...extraTools()] }));
server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "env":
        return text({ env: process.env, cwd: process.cwd() });
      case "whoami":
        return text({ pid: process.pid, argv: process.argv.slice(2) });
      case "read_file":
        return text(fs.readFileSync(args.path, "utf8"));
      case "write_file":
        fs.writeFileSync(args.path, args.text);
        return text("written");
      default: {
        const meta = extraTools().find((tool) => tool.name === name)?._meta ?? {};
        const token = process.env.SECRET_TOKEN ?? "(none)";
        if (meta["test/delayMs"]) await delay(meta["test/delayMs"]);
        if (meta["test/failWithToken"]) throw Object.assign(new Error(`upstream refused the token ${token}`), { rpc: true });
        if (meta["test/structuredToken"]) return { ...text(`token ${token}`), structuredContent: { token, nested: { headers: [`Bearer ${token}`], count: 2 }, [token]: "by key" } };
        if (meta["test/image"]) return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: `called ${name}` }] };
        return text(typeof meta["test/answer"] === "string" ? meta["test/answer"] : `called ${name}`);
      }
    }
  } catch (error) {
    if (error.rpc) throw error;
    return { isError: true, content: [{ type: "text", text: `${error.code ?? "error"}: ${error.message}` }] };
  }
});

await server.connect(new StdioServerTransport());

if (toolsFile && listChanged) {
  let last = JSON.stringify(extraTools());
  fs.watchFile(toolsFile, { interval: 50 }, () => {
    const now = JSON.stringify(extraTools());
    if (now === last) return;
    last = now;
    void server.sendToolListChanged().catch(() => {});
  });
}
