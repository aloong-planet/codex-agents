import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConsoleAccessError, type ConsoleAccess, type ConsoleRequestContext } from "./console-access.js";
import type { ConsoleOverview } from "./console-overview.js";
import { DispatchGroupRefusal, type DispatchGroupSettings } from "./dispatch-group-settings.js";
import { McpCatalog } from "./mcp-catalog.js";
import { McpConfigError } from "./mcp-catalog-rules.js";
import { TeamDefinitionError, TeamInputError, type TeamManagement, TeamTaskBusyError } from "./team-management.js";

/**
 * The console's pages and APIs, mounted by both local servers (the settings demo server and the Feishu status
 * server) inside the authorization guard (agent-console::CON-001). Each console page adds its routes here.
 *
 * - `/console/mcp` and its assets: the MCP 管理 page (mcp-catalog::US-001 to US-005).
 * - `/api/mcp/...`: the catalog API, including `/api/mcp/import/check` and `/api/mcp/import` for an `mcpServers`
 *   document. No response carries a secret value (mcp-catalog::REQ-001); every change is audited with the authorized
 *   browser (agent-console::REQ-004).
 * - `/console/teams` and its assets: the 团队管理 page (team-management spec).
 * - `/api/teams/...`: team management. Without Feishu dispatch the view says so and team saves are refused.
 *   No response carries an App Secret (team-management::CON-001); every change is audited. `/api/teams/delete` starts deleting a
 *   team, and `/api/teams/tasks/move` and `/api/teams/tasks/delete` handle a scheduled task one of its removals lists
 *   (team-management::US-004).
 * - `/api/teams/dispatch-groups`: the dispatch-group form (agent-console::US-009), with or without dispatch. A save writes the
 *   channel configuration file and applies at the next start; a refusal answers 409 with its kind and leaves the file unchanged.
 * - `/console` and its assets: the 团队总览 page, the console's home (agent-console::US-003 to US-005).
 * - `/api/overview`: its read projection; `/api/overview/memory?group=<chat ID>` a dispatch group's memory, read-only. No route
 *   changes or deletes memory (agent-console::US-005/AC-04).
 * - `/api/console/sidebar`: the sidebar's browser count and Penny's state on every page.
 * - `/api/console/browsers`: the 本机登录 drawer's list, and `/api/console/browsers/revoke` its revocation, audited with the browser
 *   that asked (agent-console::US-001/AC-03).
 */
const CONSOLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "console");
const MAX_BODY_BYTES = 64 * 1024;
const ASSETS: Record<string, { file: string; type: string }> = {
  "/console": { file: "overview.html", type: "text/html; charset=utf-8" },
  "/console/overview.css": { file: "overview.css", type: "text/css; charset=utf-8" },
  "/console/overview.js": { file: "overview.js", type: "text/javascript; charset=utf-8" },
  "/console/mcp": { file: "mcp.html", type: "text/html; charset=utf-8" },
  "/console/teams": { file: "team.html", type: "text/html; charset=utf-8" },
  "/console/console.css": { file: "console.css", type: "text/css; charset=utf-8" },
  "/console/console-shell.js": { file: "console-shell.js", type: "text/javascript; charset=utf-8" },
  "/console/mcp.css": { file: "mcp.css", type: "text/css; charset=utf-8" },
  "/console/mcp.js": { file: "mcp.js", type: "text/javascript; charset=utf-8" },
  "/console/team.css": { file: "team.css", type: "text/css; charset=utf-8" },
  "/console/team.js": { file: "team.js", type: "text/javascript; charset=utf-8" },
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

/** Registry refusals the owner can act on, by code. */
const TEAM_REFUSALS: Record<string, [number, string]> = {
  team_registry_version_stale: [409, "这个团队已在其他页面保存过新版本；为避免覆盖，本次保存没有生效。"],
  team_registry_coordinator_fixed: [400, "Sam 只能修改职责与提示词"],
  team_registry_team_unknown: [404, "团队不存在"],
  team_registry_team_deleting: [409, "这个团队正在删除，本次保存没有生效。"],
  team_registry_group_unknown: [400, "所属群不在派单群里"],
};

export function createConsoleRoutes(options: { catalog: McpCatalog; teams?: TeamManagement; dispatchGroups?: DispatchGroupSettings; overview?: ConsoleOverview;
  access?: ConsoleAccess }): ConsoleRoutes {
  const { catalog, teams, dispatchGroups, overview, access } = options;

  async function overviewApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!overview || req.method !== "GET") throw new RequestError(404, "未找到");
    if (url.pathname === "/api/overview") { json(res, 200, await overview.view()); return; }
    if (url.pathname !== "/api/overview/memory") throw new RequestError(404, "未找到");
    const memory = overview.memory(url.searchParams.get("group") ?? "");
    if (!memory) throw new RequestError(404, "不是派单群");
    json(res, 200, memory);
  }

  async function browsersApi(req: IncomingMessage, res: ServerResponse, pathname: string, context: ConsoleRequestContext): Promise<void> {
    if (!access) throw new RequestError(404, "未找到");
    // The sidebar's counts on every page: the 本机登录 entry's browsers and Penny's state (agent-console::US-001/AC-03, REQ-003).
    if (pathname === "/api/console/sidebar" && req.method === "GET") {
      json(res, 200, { browsers: access.listBrowsers().length, penny: overview?.penny() ?? { configured: false, ready: false } });
      return;
    }
    if (pathname === "/api/console/browsers" && req.method === "GET") {
      json(res, 200, { browsers: access.listBrowsers().map((browser) => ({ ...browser, current: browser.id === context.browser?.id })) });
      return;
    }
    if (pathname !== "/api/console/browsers/revoke" || req.method !== "POST") throw new RequestError(404, "未找到");
    const input = await body(req);
    if (typeof input.target !== "string" || !input.target) throw new RequestError(400, "要收回的浏览器无效");
    if (input.target !== "all" && !access.listBrowsers().some(({ id }) => id === input.target)) throw new RequestError(404, "没有该浏览器");
    try {
      json(res, 200, access.revoke(input.target, "browser", context.browser));
    } catch (error) {
      // The revocation applied, but its file could not be written; the message says so.
      if (error instanceof ConsoleAccessError) throw new RequestError(500, error.message);
      throw error;
    }
  }

  async function teamsApi(req: IncomingMessage, res: ServerResponse, pathname: string, context: ConsoleRequestContext): Promise<void> {
    const actor = context.browser ? { browser: context.browser } : {};
    if (pathname === "/api/teams" && req.method === "GET") {
      json(res, 200, teams ? await teams.view() : { configured: false });
      return;
    }
    if (pathname === "/api/teams/dispatch-groups" && dispatchGroups) {
      if (req.method === "GET") { json(res, 200, await dispatchGroups.view()); return; }
      if (req.method !== "POST") throw new RequestError(404, "未找到");
      const input = await body(req);
      try {
        json(res, 200, await dispatchGroups.save({ groups: input.groups, basedOn: input.basedOn }, actor));
      } catch (error) {
        if (!(error instanceof DispatchGroupRefusal)) throw error;
        json(res, error.refusal.kind === "invalid" ? 400 : 409, { error: "无法保存", refusal: error.refusal });
      }
      return;
    }
    if (req.method !== "POST") throw new RequestError(404, "未找到");
    const input = await body(req);
    if (!teams) throw new RequestError(409, "尚未配置派单群");
    try {
      if (pathname === "/api/teams/save") {
        const teamId = teams.saveTeam(input.team, { basedOn: input.basedOn, actor });
        json(res, 200, { teamId, view: await teams.view() });
      } else if (pathname === "/api/teams/coordinator") {
        teams.saveCoordinator(input.coordinator, { basedOn: input.basedOn, actor });
        json(res, 200, { view: await teams.view() });
      } else if (pathname === "/api/teams/recheck") {
        await teams.recheck(input.teamId, actor);
        json(res, 200, { view: await teams.view() });
      } else if (pathname === "/api/teams/delete") {
        teams.deleteTeam(input.teamId, actor);
        json(res, 200, { view: await teams.view() });
      } else if (pathname === "/api/teams/tasks/move") {
        teams.moveTask(input.teamId, input.taskId, input.to, actor);
        json(res, 200, { view: await teams.view() });
      } else if (pathname === "/api/teams/tasks/delete") {
        teams.deleteTask(input.teamId, input.taskId, actor);
        json(res, 200, { view: await teams.view() });
      } else throw new RequestError(404, "未找到");
    } catch (error) {
      if (error instanceof TeamDefinitionError) { json(res, 400, { error: "无法保存", reasons: error.reasons }); return; }
      if (error instanceof TeamInputError) throw new RequestError(400, error.message);
      if (error instanceof TeamTaskBusyError) throw new RequestError(409, "这项定时任务正在执行或发送，稍后再试。");
      const refusal = error instanceof Error ? TEAM_REFUSALS[error.message] : undefined;
      if (refusal) { json(res, refusal[0], { error: refusal[1], ...(refusal[0] === 409 ? { stale: true } : {}) }); return; }
      throw error;
    }
  }

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
      const team = url.pathname === "/api/teams" || url.pathname.startsWith("/api/teams/");
      const board = url.pathname === "/api/overview" || url.pathname.startsWith("/api/overview/");
      const browsers = url.pathname === "/api/console/sidebar" || url.pathname === "/api/console/browsers" || url.pathname.startsWith("/api/console/browsers/");
      if (!team && !board && !browsers && url.pathname !== "/api/mcp" && !url.pathname.startsWith("/api/mcp/")) return false;
      try {
        if (board) await overviewApi(req, res, url);
        else if (browsers) await browsersApi(req, res, url.pathname, context);
        else await (team ? teamsApi : mcpApi)(req, res, url.pathname, context);
      } catch (error) {
        if (error instanceof RequestError) json(res, error.status, { error: error.message });
        else if (error instanceof McpConfigError) json(res, 400, { error: error.message });
        else {
          const area = team ? "team" : board ? "overview" : browsers ? "browsers" : "mcp";
          process.stderr.write(`console_${area}_request_failed: ${error instanceof Error ? error.name : "error"}\n`);
          json(res, 500, { error: "请求失败" });
        }
      }
      return true;
    },
  };
}
