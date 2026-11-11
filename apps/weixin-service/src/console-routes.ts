import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConsoleAccessError, type ConsoleAccess, type ConsoleRequestContext } from "./console-access.js";
import type { ConsoleOverview } from "./console-overview.js";
import { DispatchGroupRefusal, type DispatchGroupSettings } from "./dispatch-group-settings.js";
import { McpCatalog } from "./mcp-catalog.js";
import { McpConfigError } from "./mcp-catalog-rules.js";
import { CHAT_REFUSAL, PrivateChatError, type PrivateConversations } from "./private-conversations.js";
import { type SkillLibrary, SkillRefusal, type SkillRefusalKind } from "./skill-library.js";
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
 * - `/api/teams/qr`: QR creation of a team's application (team-management::US-002). GET with `team=<ID>` is the QR code that
 *   waits for its scan, as an SVG image, or 404 when none waits; POST asks for a new code, as 「刷新二维码」 does.
 * - `/api/teams/test-message`: the test message, sent only with `confirmed: true`.
 * - `/api/teams/dispatch-groups`: the dispatch-group form (agent-console::US-009), with or without dispatch. A save writes the
 *   channel configuration file and applies at the next start; a refusal answers 409 with its kind and leaves the file unchanged.
 * - `/console` and its assets: the 团队总览 page, the console's home (agent-console::US-003 to US-005).
 * - `/api/overview`: its read projection; `/api/overview/memory?group=<chat ID>` a dispatch group's memory, read-only. No route
 *   changes or deletes memory (agent-console::US-005/AC-04).
 * - `/api/private-chats/<agent ID>`: the owner's private conversation with Sam or a Team Leader (agent-console::US-006), and
 *   `/api/private-chats/<agent ID>/messages` a message to it, answered later by the agent's reply turn. Any other ID, an Executor's
 *   or Penny's included, is refused with 404; without dispatch every one is.
 * - `/console/skills` and its assets: the Skill 管理 page (skill-library spec).
 * - `/api/skills/...`: the Skill Library. `/api/skills/read` reads a folder path and `/api/skills/import` imports it once the
 *   read is confirmed; `/api/skills/<id>/reimport` and `/api/skills/<id>/delete` act on one skill. A request names a folder
 *   and what was confirmed, never skill content (skill-library::REQ-001), and every change is audited.
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
  "/console/chat-markdown.js": { file: "chat-markdown.js", type: "text/javascript; charset=utf-8" },
  "/console/mcp": { file: "mcp.html", type: "text/html; charset=utf-8" },
  "/console/teams": { file: "team.html", type: "text/html; charset=utf-8" },
  "/console/console.css": { file: "console.css", type: "text/css; charset=utf-8" },
  "/console/console-shell.js": { file: "console-shell.js", type: "text/javascript; charset=utf-8" },
  "/console/mcp.css": { file: "mcp.css", type: "text/css; charset=utf-8" },
  "/console/mcp.js": { file: "mcp.js", type: "text/javascript; charset=utf-8" },
  "/console/team.css": { file: "team.css", type: "text/css; charset=utf-8" },
  "/console/team.js": { file: "team.js", type: "text/javascript; charset=utf-8" },
  "/console/team-onboarding-view.js": { file: "team-onboarding-view.js", type: "text/javascript; charset=utf-8" },
  "/console/skills": { file: "skills.html", type: "text/html; charset=utf-8" },
  "/console/skills.css": { file: "skills.css", type: "text/css; charset=utf-8" },
  "/console/skills.js": { file: "skills.js", type: "text/javascript; charset=utf-8" },
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

/**
 * Why the Skill Library refused, as the page shows it, with the status of the answer. A re-import has its own words for a
 * name another skill has and for a source that changed after it was compared.
 */
function skillRefusal(refusal: SkillRefusalKind, reimport: boolean): [number, string] {
  switch (refusal.kind) {
    case "folder": return [400, "找不到或读不了这个文件夹，无法导入。请确认填的是 skill 的根目录。"];
    case "skill_md": return [400, "这个文件夹里没有 SKILL.md，无法导入。请确认选的是 skill 的根目录。"];
    case "front_matter": return [400, "SKILL.md 里缺少 name 或 description，无法导入。请确认选的是 skill 的根目录。"];
    case "bom": return [400, "SKILL.md 开头有字节顺序标记（BOM），Codex 读不了它，无法导入。请另存为不带 BOM 的 UTF-8 后重新读取。"];
    case "name_length": return [400, "SKILL.md 里的 name 超过 64 个字符，Codex 读不了它，无法导入。请改短后重新读取。"];
    case "links": return [400, `这个文件夹里有 ${refusal.links.length} 个符号链接，无法导入：${refusal.links.join("；")}。符号链接可能指向文件夹以外的文件。请换成实际文件后重新读取。`];
    case "duplicate": return [409, reimport ? `来源里的 SKILL.md 现在叫「${refusal.name}」，与已有的 skill 同名，没有重新导入。`
      : `已有同名 skill「${refusal.name}」。要更新它，请在它的详情里重新导入；或换一个文件夹。`];
    case "changed": return [409, reimport ? "文件夹在核对之后有变化，没有重新导入。请重新检查后再确认。" : "文件夹在读取之后有变化，没有导入。请重新读取后再确认。"];
    case "in_use": return [409, `被 ${refusal.uses} 个能力档使用。先在团队管理解绑，才能删除。`];
    case "uses_unknown": return [409, "读不了已保存的团队配置，无法确认是否还有能力档在使用它，暂时不能删除。"];
    case "unknown": return [404, "这个 skill 已不存在，请刷新页面。"];
  }
}

export function createConsoleRoutes(options: { catalog: McpCatalog; teams?: TeamManagement; dispatchGroups?: DispatchGroupSettings; overview?: ConsoleOverview;
  access?: ConsoleAccess; skills?: SkillLibrary; chats?: PrivateConversations }): ConsoleRoutes {
  const { catalog, teams, dispatchGroups, overview, access, skills, chats } = options;

  async function skillsApi(req: IncomingMessage, res: ServerResponse, pathname: string, context: ConsoleRequestContext): Promise<void> {
    if (!skills) throw new RequestError(404, "未找到");
    const actor = context.browser ? { browser: context.browser } : {};
    if (pathname === "/api/skills" && req.method === "GET") { json(res, 200, { skills: await skills.view() }); return; }
    if (req.method !== "POST") throw new RequestError(404, "未找到");
    const one = /^\/api\/skills\/(skill-[0-9a-f]{8})\/(reimport|delete)$/u.exec(pathname);
    if (!one && pathname !== "/api/skills/read" && pathname !== "/api/skills/import") throw new RequestError(404, "未找到");
    const input = await body(req);
    // A skill enters the library only from a folder on this computer: the request names its path and the confirmed read.
    const folder = () => { if (typeof input.folder !== "string" || !input.folder.trim() || input.folder.length > 4096) throw new RequestError(400, "文件夹路径无效"); return input.folder; };
    const confirmed = () => { if (typeof input.confirmed !== "string" || !/^[0-9a-f]{64}$/u.test(input.confirmed)) throw new RequestError(400, "需要先读取并确认"); return input.confirmed; };
    try {
      if (pathname === "/api/skills/read") json(res, 200, { preview: await skills.read(folder()) });
      else if (pathname === "/api/skills/import") {
        const { id } = await skills.import(folder(), confirmed(), actor);
        json(res, 200, { id, skills: await skills.view() });
      } else if (one![2] === "reimport") {
        await skills.reimport(one![1]!, confirmed(), actor);
        json(res, 200, { id: one![1], skills: await skills.view() });
      } else {
        skills.remove(one![1]!, actor);
        json(res, 200, { deleted: one![1], skills: await skills.view() });
      }
    } catch (error) {
      if (!(error instanceof SkillRefusal)) throw error;
      const [status, message] = skillRefusal(error.refusal, one?.[2] === "reimport");
      json(res, status, { error: message, refusal: error.refusal });
    }
  }

  async function chatsApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const match = /^\/api\/private-chats\/([^/]+)(\/messages)?$/.exec(pathname);
    if (!match || req.method !== (match[2] ? "POST" : "GET")) throw new RequestError(404, "未找到");
    let agentId: string;
    try { agentId = decodeURIComponent(match[1]!); } catch { throw new RequestError(404, CHAT_REFUSAL); }
    if (!chats) throw new RequestError(404, CHAT_REFUSAL);
    if (!match[2]) {
      const view = chats.view(agentId);
      if (!view) throw new RequestError(404, CHAT_REFUSAL);
      json(res, 200, view);
      return;
    }
    const input = await body(req);
    try {
      json(res, 200, chats.send(agentId, { text: input.text, requestId: input.requestId }));
    } catch (error) {
      if (error instanceof PrivateChatError) throw new RequestError(error.status, error.message);
      throw error;
    }
  }

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

  async function teamsApi(req: IncomingMessage, res: ServerResponse, url: URL, context: ConsoleRequestContext): Promise<void> {
    const actor = context.browser ? { browser: context.browser } : {};
    const { pathname } = url;
    if (pathname === "/api/teams" && req.method === "GET") {
      json(res, 200, teams ? await teams.view() : { configured: false });
      return;
    }
    if (pathname === "/api/teams/qr" && req.method === "GET") {
      const code = await teams?.creationCode(url.searchParams.get("team") ?? "");
      if (!code) throw new RequestError(404, "没有等待扫码的二维码");
      headers(res);
      res.statusCode = 200;
      res.setHeader("content-type", "image/svg+xml; charset=utf-8");
      res.end(code);
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
      } else if (pathname === "/api/teams/qr") {
        await teams.refreshCreation(input.teamId, actor);
        json(res, 200, { view: await teams.view() });
      } else if (pathname === "/api/teams/test-message") {
        await teams.sendTestMessage(input.teamId, input.confirmed, actor);
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
      const skill = url.pathname === "/api/skills" || url.pathname.startsWith("/api/skills/");
      const chat = url.pathname.startsWith("/api/private-chats/");
      if (!team && !board && !browsers && !skill && !chat && url.pathname !== "/api/mcp" && !url.pathname.startsWith("/api/mcp/")) return false;
      try {
        if (board) await overviewApi(req, res, url);
        else if (chat) await chatsApi(req, res, url.pathname);
        else if (browsers) await browsersApi(req, res, url.pathname, context);
        else if (skill) await skillsApi(req, res, url.pathname, context);
        else if (team) await teamsApi(req, res, url, context);
        else await mcpApi(req, res, url.pathname, context);
      } catch (error) {
        if (error instanceof RequestError) json(res, error.status, { error: error.message });
        else if (error instanceof McpConfigError) json(res, 400, { error: error.message });
        else {
          const area = team ? "team" : board ? "overview" : browsers ? "browsers" : skill ? "skills" : chat ? "chat" : "mcp";
          process.stderr.write(`console_${area}_request_failed: ${error instanceof Error ? error.name : "error"}\n`);
          json(res, 500, { error: "请求失败" });
        }
      }
      return true;
    },
  };
}
