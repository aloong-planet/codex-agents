import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsoleRequestContext } from "./console-access.js";
import { McpCatalog } from "./mcp-catalog.js";
import { McpConfigError } from "./mcp-catalog-rules.js";

/**
 * The console's pages and APIs, mounted by both local servers (the settings demo server and the Feishu status
 * server) inside the authorization guard (agent-console::CON-001). Each console page adds its routes here.
 *
 * - `/console/mcp` and its assets: the MCP 管理 page (mcp-catalog::US-001 to US-005).
 * - `/api/mcp/...`: the catalog API, including `/api/mcp/import/check` and `/api/mcp/import` for an `mcpServers`
 *   document. No response carries a secret value (mcp-catalog::REQ-001); every change is audited with the authorized
 *   browser (agent-console::REQ-004).
 */
const CONSOLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "console");
const MAX_BODY_BYTES = 64 * 1024;
const ASSETS: Record<string, { file: string; type: string }> = {
  "/console/mcp": { file: "mcp.html", type: "text/html; charset=utf-8" },
  "/console/console.css": { file: "console.css", type: "text/css; charset=utf-8" },
  "/console/console-shell.js": { file: "console-shell.js", type: "text/javascript; charset=utf-8" },
  "/console/mcp.css": { file: "mcp.css", type: "text/css; charset=utf-8" },
  "/console/mcp.js": { file: "mcp.js", type: "text/javascript; charset=utf-8" },
};

export type ConsoleRoutes = {
  /** Serves the request if it is a console route; returns false for every other path. */
  handle(req: IncomingMessage, res: ServerResponse, context: ConsoleRequestContext): Promise<boolean>;
};

function headers(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  headers(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new RequestError(415, "只接受 JSON 请求");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "请求体过大");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new RequestError(400, "JSON 格式无效");
  }
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, `${what}格式无效`);
  return value as Record<string, unknown>;
}

export function createConsoleRoutes(options: { catalog: McpCatalog }): ConsoleRoutes {
  const { catalog } = options;

  async function mcpApi(req: IncomingMessage, res: ServerResponse, pathname: string, context: ConsoleRequestContext): Promise<void> {
    const actor = context.browser ? { browser: context.browser } : {};
    if (pathname === "/api/mcp/servers" && req.method === "GET") {
      json(res, 200, { servers: catalog.view() });
      return;
    }
    if (req.method !== "POST") throw new RequestError(404, "未找到");
    const input = await body(req);
    if (pathname === "/api/mcp/preview") {
      const existing = typeof input.existing === "string" ? input.existing : undefined;
      json(res, 200, catalog.preview(object(input.server, "服务器配置"), existing));
      return;
    }
    if (pathname === "/api/mcp/servers") {
      json(res, 200, { server: catalog.register(object(input.server, "服务器配置"), { confirmed: input.confirmed, actor }) });
      return;
    }
    if (pathname === "/api/mcp/import/check") {
      json(res, 200, { entries: catalog.checkImport(input.text) });
      return;
    }
    if (pathname === "/api/mcp/import") {
      json(res, 200, { servers: catalog.importServers(input.text, { confirmed: input.confirmed, actor }) });
      return;
    }
    const match = /^\/api\/mcp\/servers\/([^/]+)(?:\/(delete|reconnect|tools|approve))?$/.exec(pathname);
    if (!match) throw new RequestError(404, "未找到");
    let name: string;
    try {
      name = decodeURIComponent(match[1]!);
    } catch {
      throw new RequestError(400, "服务器名称无效");
    }
    switch (match[2]) {
      case undefined:
        json(res, 200, { server: catalog.update(name, object(input.server, "服务器配置"), { confirmed: input.confirmed, actor }) });
        return;
      case "delete":
        await catalog.remove(name, actor);
        json(res, 200, { deleted: name });
        return;
      case "reconnect":
        catalog.reconnect(name);
        json(res, 200, { server: catalog.viewServer(name) });
        return;
      case "tools":
        if (typeof input.tool !== "string" || typeof input.enabled !== "boolean") throw new RequestError(400, "工具开关格式无效");
        json(res, 200, { server: catalog.setToolEnabled(name, input.tool, input.enabled, actor) });
        return;
      case "approve": {
        const tools = input.tools === undefined ? undefined : Array.isArray(input.tools) && input.tools.every((tool) => typeof tool === "string") ? input.tools as string[] : null;
        if (tools === null) throw new RequestError(400, "待确认的工具格式无效");
        json(res, 200, { server: catalog.approve(name, tools, actor) });
        return;
      }
    }
  }

  return {
    async handle(req, res, context) {
      const url = new URL(req.url ?? "/", "http://console.local");
      const asset = ASSETS[url.pathname];
      if (asset && (req.method === "GET" || req.method === "HEAD")) {
        headers(res);
        res.statusCode = 200;
        res.setHeader("content-type", asset.type);
        res.end(req.method === "HEAD" ? undefined : fs.readFileSync(path.join(CONSOLE_DIR, asset.file)));
        return true;
      }
      if (url.pathname !== "/api/mcp" && !url.pathname.startsWith("/api/mcp/")) return false;
      try {
        await mcpApi(req, res, url.pathname, context);
      } catch (error) {
        if (error instanceof RequestError) json(res, error.status, { error: error.message });
        else if (error instanceof McpConfigError) json(res, 400, { error: error.message });
        else {
          process.stderr.write(`console_mcp_request_failed: ${error instanceof Error ? error.name : "error"}\n`);
          json(res, 500, { error: "请求失败" });
        }
      }
      return true;
    },
  };
}
