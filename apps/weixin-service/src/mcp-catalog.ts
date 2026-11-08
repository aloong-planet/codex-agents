import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { Client, ClientCredentialsProvider, DpopSession, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { ConsoleAudit } from "./console-audit.js";
import type { ConsoleBrowser } from "./console-access.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  KEEP,
  McpConfigError,
  checkImport,
  childEnvironment,
  launchLine,
  launchPlan,
  mergeClientSecret,
  mergeSecrets,
  needsConfirmation,
  normalizeHttp,
  normalizeStdio,
  normalizeTimeout,
  pinDiff,
  pinOf,
  redactSecrets,
  retryDelay,
  toolStatus,
  validateServerName,
  type ImportEntry,
  type Pin,
  type PinPart,
  type SandboxSettings,
  type ServerSettings,
  type ServerTarget,
  type ToolDefinition,
  type Transport,
} from "./mcp-catalog-rules.js";

/**
 * The MCP Catalog (docs/specs/mcp-catalog.md, ADR-0027, ADR-0028): the local programs and URL servers the owner
 * registered or imported, and the host-side connections to them. The service holds every connection and every
 * credential; agents only ever reach a server through `toolsFor` and `call`, which re-check the current configuration.
 *
 * - `mcp-catalog.json` holds the readable configuration, disabled tools and pinned definitions; `mcp-secrets.json`
 *   holds environment values, header values and OAuth client secrets. Both are owner-only and replaced atomically;
 *   after a deletion, or a change of transport, no state file holds the dropped secrets.
 * - OAuth access tokens and DPoP keys live in memory only, one set per connection: a reconnection or a restart
 *   requests a new token. The client secret is sent only to the configured issuer (the SDK's `expectedIssuer`).
 * - A server's first tool listing is pinned. Later new or changed definitions wait for the owner's review.
 * - After a failure the host retries from 30 seconds, doubling up to 10 minutes. Servers that do not announce
 *   tool-list changes are listed again every 10 minutes.
 */
export const CATALOG_FILE = "mcp-catalog.json";
export const SECRETS_FILE = "mcp-secrets.json";
const CONNECT_TIMEOUT_MS = 30_000;
const REFRESH_MS = 10 * 60_000;
const OUTPUT_TAIL = 4_000;
/** The sandbox-runtime command line (`srt`), next to the package's entry point. */
const srtPath = () => path.join(path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")), "cli.js");

export type ConnectionState = "disabled" | "connecting" | "connected" | "disconnected" | "failed";

type StoredServer = ServerSettings & {
  disabledTools: string[];
  /** Absent until the server's first tool listing, which is pinned as a whole. */
  pins?: Record<string, Pin>;
  updatedAt: string;
};

type Connection = {
  state: ConnectionState;
  generation: number;
  client?: Client;
  tools: ToolDefinition[];
  error?: string;
  output: string;
  server?: { name: string; version: string };
  protocol?: string;
  connectedAt?: string;
  failures: number;
  retryAt?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setInterval>;
  pending?: Promise<void>;
};

export type McpToolView = {
  name: string;
  title?: string;
  description: string;
  enabled: boolean;
  usable: boolean;
  pending?: "new" | "changed";
  changed?: PinPart[];
  was?: string;
  needsUser: boolean;
  readOnly: boolean;
  mayModify: boolean;
};

/** Saved secret values as the console shows them: `••••••`, or empty for a value imported without one. */
type MaskedValues = Record<string, string>;

export type McpServerView = ({
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  /** Saved environment values (mcp-catalog::REQ-001). */
  env: MaskedValues;
  sandbox?: SandboxSettings;
} | {
  transport: "http";
  url: string;
  /** Saved header values (mcp-catalog::REQ-001). */
  headers: MaskedValues;
  /** The client secret always shows as `••••••`. */
  oauth?: { issuer: string; clientId: string; scope?: string; clientSecret: string };
  dpop: boolean;
}) & {
  name: string;
  /** The exact command line or address the owner confirmed. */
  launchLine: string;
  timeout: number;
  trusted: boolean;
  enabled: boolean;
  state: ConnectionState;
  error?: string;
  retryAt?: string;
  retries: number;
  server?: { name: string; version: string };
  protocol?: string;
  connectedAt?: string;
  output?: string;
  tools: McpToolView[];
  counts: { total: number; usable: number; pending: number };
  /** Profiles that attach this server. Profiles gain MCP attachment in ticket 16; until then none does. */
  attachedProfiles: Array<{ team: string; profile: string }>;
};

export type McpServerInput = {
  name?: unknown;
  /** `stdio` (the default) or `http`. */
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  sandbox?: unknown;
  url?: unknown;
  headers?: unknown;
  /** `{ issuer, clientId, clientSecret, scope }`; the secret is write-only. */
  oauth?: unknown;
  dpop?: unknown;
  timeout?: unknown;
  trusted?: unknown;
  enabled?: unknown;
};

/** An entry of the import check as the console shows it: never a secret value. */
export type McpImportView = { name: string; ok: true; transport: Transport; line: string; fill: string[]; enabled: boolean } | { name: string; ok: false; reason: string };

/** Secret values, per server; stored apart from the readable configuration. */
type Secrets = {
  env: Record<string, Record<string, string>>;
  headers: Record<string, Record<string, string>>;
  clientSecrets: Record<string, string>;
};

/** One server's secrets. */
type ServerSecrets = { env: Record<string, string>; headers: Record<string, string>; clientSecret?: string };

export type McpActor = { browser?: ConsoleBrowser };

/** A tool call the catalog refuses; the message is the reason. */
export class McpCallRefused extends Error {}

export type McpCatalogOptions = {
  stateDirectory: string;
  audit: ConsoleAudit;
  homeDirectory?: string;
  /** The environment local programs pick their base variables from; defaults to the service's own. */
  env?: Readonly<Record<string, string | undefined>>;
  /** First automatic retry after a failure, in milliseconds; 0 disables retries. */
  retryMs?: number;
  /** Tool-list refresh for servers without change notifications, in milliseconds; 0 disables it. */
  refreshMs?: number;
  /**
   * Where each sandboxed server gets its own npm cache, outside the state and temporary directories; defaults to
   * `~/Library/Caches/codex-weixin/mcp`.
   */
  cacheDirectory?: string;
  now?: () => number;
};

const proxyName = (server: string, tool: string) => `mcp__${server}__${tool}`;

const targetOf = (settings: ServerSettings): ServerTarget =>
  settings.transport === "http" ? { transport: "http", url: settings.url } : { command: settings.command, args: settings.args };

/** The OAuth client_credentials provider, presenting its token with DPoP when configured; tokens stay in memory. */
class HostClientCredentials extends ClientCredentialsProvider {
  private session?: Promise<DpopSession>;
  constructor(options: { clientId: string; clientSecret: string; scope?: string; expectedIssuer: string }, private readonly withDpop: boolean) {
    super({ ...options, clientName: "codex-weixin" });
  }
  dpop(): Promise<DpopSession> | undefined {
    if (!this.withDpop) return undefined;
    this.session ??= DpopSession.create();
    return this.session;
  }
}

/** A stored server's secrets taken out of `secrets`, or all of them replaced by `own`. */
function withServerSecrets(secrets: Secrets, name: string, own: ServerSecrets | undefined): Secrets {
  const next: Secrets = { env: { ...secrets.env }, headers: { ...secrets.headers }, clientSecrets: { ...secrets.clientSecrets } };
  delete next.env[name];
  delete next.headers[name];
  delete next.clientSecrets[name];
  if (own && Object.keys(own.env).length) next.env[name] = own.env;
  if (own && Object.keys(own.headers).length) next.headers[name] = own.headers;
  if (own?.clientSecret !== undefined) next.clientSecrets[name] = own.clientSecret;
  return next;
}

const masked = (names: string[], saved: Readonly<Record<string, string>> | undefined): MaskedValues =>
  Object.fromEntries(names.map((name) => [name, saved?.[name] === "" ? "" : KEEP]));

/** What an audit entry records of a server's settings: names of secrets, never their values. */
function describe(settings: ServerSettings): Record<string, unknown> {
  if (settings.transport === "http") {
    return { transport: "http", launchLine: settings.url, headerNames: settings.headerNames, ...(settings.oauth ? { oauth: settings.oauth } : {}), dpop: settings.dpop };
  }
  return { transport: "stdio", launchLine: launchLine(settings), envNames: settings.envNames, ...(settings.cwd ? { cwd: settings.cwd } : {}), ...(settings.sandbox ? { sandbox: settings.sandbox } : {}) };
}

function transportOf(value: unknown): Transport {
  if (value === undefined || value === null || value === "stdio") return "stdio";
  if (value === "http") return "http";
  throw new McpConfigError("连接方式只能是本机程序（stdio）或网址（Streamable HTTP）");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeOwnerOnly(directory: string, file: string, value: unknown): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, file);
  const temporary = path.join(directory, `.${file}-${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") process.stderr.write(`mcp_catalog_unreadable: ${path.basename(file)}\n`);
    return undefined;
  }
}

export class McpCatalog {
  private readonly options: McpCatalogOptions;
  private readonly homeDirectory: string;
  private readonly cacheDirectory: string;
  private servers: StoredServer[] = [];
  private secrets: Secrets = { env: {}, headers: {}, clientSecrets: {} };
  private readonly connections = new Map<string, Connection>();
  private closed = false;

  constructor(options: McpCatalogOptions) {
    this.options = options;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.cacheDirectory = options.cacheDirectory ?? path.join(this.homeDirectory, "Library", "Caches", "codex-weixin", "mcp");
    const stored = readJson(path.join(options.stateDirectory, CATALOG_FILE)) as { servers?: StoredServer[] } | undefined;
    // Servers saved before URL servers existed carry no transport: they are local programs.
    this.servers = Array.isArray(stored?.servers)
      ? stored.servers.filter((server) => typeof server?.name === "string").map((server) => ({ ...server, transport: server.transport ?? "stdio" }) as StoredServer)
      : [];
    const secrets = readJson(path.join(options.stateDirectory, SECRETS_FILE)) as Partial<Secrets> | undefined;
    const record = <T>(value: unknown): Record<string, T> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, T> : {});
    this.secrets = { env: record(secrets?.env), headers: record(secrets?.headers), clientSecrets: record(secrets?.clientSecrets) };
  }

  /** Connects every enabled server; called once the service is up. */
  start(): void {
    for (const server of this.servers) if (server.enabled) void this.connect(server.name).catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  /** What the confirmation card shows for a draft, and whether it needs confirming (mcp-catalog::US-001/AC-06, REQ-002). */
  preview(input: McpServerInput, existing?: string): { launchLine: string; needsConfirmation: boolean } {
    const previous = existing === undefined ? undefined : this.require(existing);
    const settings = this.normalize(input, previous);
    return { launchLine: launchLine(targetOf(settings)), needsConfirmation: needsConfirmation(previous && targetOf(previous), targetOf(settings)) };
  }

  /** Registers a server once the owner confirmed its exact command or address; nothing is stored or started before. */
  register(input: McpServerInput, confirmation: { confirmed?: unknown; actor: McpActor }): McpServerView {
    const name = validateServerName(input.name);
    if (this.find(name)) throw new McpConfigError(`已有名为 ${name} 的 MCP 服务器`);
    const settings = this.normalize(input, undefined);
    const own = this.secretsOf(input, settings, undefined);
    this.requireConfirmation(settings, confirmation.confirmed);
    const server: StoredServer = { ...settings, disabledTools: [], updatedAt: this.nowIso() };
    this.commit([...this.servers, server], withServerSecrets(this.secrets, name, own), {
      browser: confirmation.actor.browser,
      event: "mcp_server_added",
      server: name,
      ...describe(settings),
      timeout: settings.timeout,
      trusted: settings.trusted,
      enabled: settings.enabled,
    });
    if (server.enabled) void this.connect(name).catch(() => {});
    return this.viewOf(server);
  }

  /** Saves a server's changes; a new command or address needs confirming and applies after reconnecting (REQ-002). */
  update(name: string, input: McpServerInput, confirmation: { confirmed?: unknown; actor: McpActor }): McpServerView {
    const previous = this.require(name);
    if (input.name !== undefined && input.name !== name) throw new McpConfigError("名称创建后不可修改");
    const settings = this.normalize({ ...input, name }, previous);
    const own = this.secretsOf(input, settings, previous);
    if (needsConfirmation(targetOf(previous), targetOf(settings))) this.requireConfirmation(settings, confirmation.confirmed);
    const next: StoredServer = { ...settings, disabledTools: previous.disabledTools, ...(previous.pins ? { pins: previous.pins } : {}), updatedAt: this.nowIso() };
    const field = (server: StoredServer, key: string) => JSON.stringify((server as Record<string, unknown>)[key]);
    const changed = ["transport", "command", "args", "cwd", "sandbox", "url", "oauth", "dpop", "timeout", "trusted", "enabled"]
      .filter((key) => field(previous, key) !== field(next, key));
    const saved = this.ownSecrets(name);
    const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const secretsChanged = [
      ...(same(saved.env, own.env) ? [] : ["env"]),
      ...(same(saved.headers, own.headers) ? [] : ["headers"]),
      ...(saved.clientSecret === own.clientSecret ? [] : ["clientSecret"]),
    ];
    this.commit(this.servers.map((server) => (server === previous ? next : server)), withServerSecrets(this.secrets, name, own), {
      browser: confirmation.actor.browser,
      event: "mcp_server_changed",
      server: name,
      changed: [...changed, ...secretsChanged],
      ...(changed.some((key) => ["transport", "command", "args", "url"].includes(key)) ? { launchLine: launchLine(targetOf(settings)) } : {}),
      ...(settings.transport === "http" ? { headerNames: settings.headerNames } : { envNames: settings.envNames }),
    });
    const reconnect = secretsChanged.length > 0 || changed.some((key) => ["transport", "command", "args", "cwd", "sandbox", "url", "oauth", "dpop", "enabled"].includes(key));
    if (reconnect) {
      if (next.enabled) void this.connect(name).catch(() => {});
      else void this.disconnect(name, "disabled");
    }
    return this.viewOf(next);
  }

  /** Deletes an unattached server: its connection stops and its secrets leave the disk (mcp-catalog::US-005/AC-02). */
  async remove(name: string, actor: McpActor): Promise<void> {
    const server = this.require(name);
    this.commit(this.servers.filter((item) => item !== server), withServerSecrets(this.secrets, name, undefined), { browser: actor.browser, event: "mcp_server_deleted", server: name });
    await this.disconnect(name);
    this.connections.delete(name);
    fs.rmSync(path.join(this.options.stateDirectory, "mcp-sandbox", `${name}.json`), { force: true });
    // A later server of the same name must not inherit what this one left in its npm cache.
    fs.rmSync(path.join(this.cacheDirectory, name), { recursive: true, force: true });
  }

  /**
   * Checks an `mcpServers` document (mcp-catalog::US-002/AC-01): each server to be imported, with the exact command
   * or address and the keys still to fill in, or skipped with the reason. Nothing is stored.
   */
  checkImport(text: unknown): McpImportView[] {
    return this.planImport(text).map((entry) => (entry.ok
      ? { name: entry.name, ok: true, transport: entry.transport, line: entry.line, fill: entry.fill, enabled: entry.enabled }
      : entry));
  }

  /**
   * Imports the servers the owner confirmed (mcp-catalog::US-002/AC-02, AC-03): `confirmed` must list exactly the
   * names and lines a check of the same document returns now, or nothing is imported. Imported servers are untrusted,
   * attached to no profile, unsandboxed, with the default timeout; all of them are stored in one change.
   */
  importServers(text: unknown, confirmation: { confirmed?: unknown; actor: McpActor }): McpServerView[] {
    const entries = this.planImport(text).filter((entry): entry is Extract<ImportEntry, { ok: true }> => entry.ok);
    if (entries.length === 0) throw new McpConfigError("没有可导入的服务器");
    const expected = entries.map((entry) => ({ name: entry.name, line: entry.line }));
    const confirmed = Array.isArray(confirmation.confirmed)
      ? confirmation.confirmed.map((item) => (item && typeof item === "object" ? { name: (item as Record<string, unknown>).name, line: (item as Record<string, unknown>).line } : item))
      : undefined;
    if (JSON.stringify(confirmed) !== JSON.stringify(expected)) throw new McpConfigError("要导入的服务器已有变化，请重新检查后再确认");
    let secrets = this.secrets;
    const now = this.nowIso();
    const added: StoredServer[] = entries.map(({ server }) => {
      const common = { name: server.name, timeout: DEFAULT_TIMEOUT_SECONDS, trusted: false, enabled: server.enabled, disabledTools: [], updatedAt: now };
      if (server.transport === "http") {
        secrets = withServerSecrets(secrets, server.name, { env: {}, headers: server.headers });
        return { ...common, transport: "http", url: server.url, headerNames: Object.keys(server.headers), dpop: false };
      }
      secrets = withServerSecrets(secrets, server.name, { env: server.env, headers: {} });
      return { ...common, transport: "stdio", command: server.command, args: server.args, ...(server.cwd ? { cwd: server.cwd } : {}), envNames: Object.keys(server.env) };
    });
    this.commit([...this.servers, ...added], secrets, {
      browser: confirmation.actor.browser,
      event: "mcp_servers_imported",
      servers: added.map((server) => ({ server: server.name, ...describe(server), enabled: server.enabled })),
    });
    for (const server of added) if (server.enabled) void this.connect(server.name).catch(() => {});
    return added.map((server) => this.viewOf(server));
  }

  /** Unchecking a tool disables it from the next call on (mcp-catalog::US-004/AC-01). */
  setToolEnabled(name: string, tool: string, enabled: boolean, actor: McpActor): McpServerView {
    const server = this.require(name);
    const known = (this.connections.get(name)?.tools ?? []).some((item) => item.name === tool) || server.disabledTools.includes(tool);
    if (!known) throw new McpConfigError(`${name} 没有名为 ${tool} 的工具`);
    const disabled = new Set(server.disabledTools);
    if (enabled) disabled.delete(tool); else disabled.add(tool);
    const next: StoredServer = { ...server, disabledTools: [...disabled], updatedAt: this.nowIso() };
    this.commit(this.servers.map((item) => (item === server ? next : item)), this.secrets, {
      browser: actor.browser,
      event: enabled ? "mcp_tool_enabled" : "mcp_tool_disabled",
      server: name,
      tool,
    });
    return this.viewOf(next);
  }

  /** Confirms new or changed tools, all waiting ones when `tools` is absent (mcp-catalog::US-004/AC-03). */
  approve(name: string, tools: string[] | undefined, actor: McpActor): McpServerView {
    const server = this.require(name);
    const pins = server.pins ?? {};
    const waiting = (this.connections.get(name)?.tools ?? [])
      .filter((tool) => toolStatus(tool, { trusted: server.trusted, disabled: false, pin: pins[tool.name] }).pending)
      .filter((tool) => tools === undefined || tools.includes(tool.name));
    if (waiting.length === 0) throw new McpConfigError(`${name} 没有待复核的工具`);
    const next: StoredServer = { ...server, pins: { ...pins, ...Object.fromEntries(waiting.map((tool) => [tool.name, pinOf(tool)])) }, updatedAt: this.nowIso() };
    this.commit(this.servers.map((item) => (item === server ? next : item)), this.secrets, {
      browser: actor.browser,
      event: "mcp_tools_confirmed",
      server: name,
      tools: waiting.map((tool) => tool.name),
    });
    return this.viewOf(next);
  }

  /** The drawer's reconnect action (mcp-catalog::US-003/AC-02). */
  reconnect(name: string): void {
    const server = this.require(name);
    if (!server.enabled) throw new McpConfigError(`${name} 已停用，请先启用`);
    void this.connect(name).catch(() => {});
  }

  view(): McpServerView[] {
    return this.servers.map((server) => this.viewOf(server));
  }

  viewServer(name: string): McpServerView {
    return this.viewOf(this.require(name));
  }

  /** The proxy tools that may be provided now: enabled servers' enabled, reviewed tools that need no person. */
  toolsFor(): Array<{ name: string; server: string; tool: string; description: string; inputSchema: unknown }> {
    return this.servers.filter((server) => server.enabled).flatMap((server) =>
      (this.connections.get(server.name)?.tools ?? [])
        .filter((tool) => this.statusOf(server, tool).usable)
        .map((tool) => ({ name: proxyName(server.name, tool.name), server: server.name, tool: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? { type: "object" } })));
  }

  /**
   * Calls a tool through the host, re-checking the current configuration on every call: a disabled server or tool,
   * an unreviewed definition or a tool that needs a person is refused (mcp-catalog::US-004/AC-01, AC-03, AC-04).
   */
  async call(full: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const server = this.servers.find((item) => full.startsWith(`mcp__${item.name}__`));
    if (!server) throw new McpCallRefused(`没有可用的 MCP 工具 ${full}`);
    const toolName = full.slice(`mcp__${server.name}__`.length);
    if (!server.enabled) throw new McpCallRefused(`MCP 服务器 ${server.name} 已停用`);
    if (server.disabledTools.includes(toolName)) throw new McpCallRefused("该工具已停用");
    let connection = this.connections.get(server.name);
    if (connection?.state === "connecting" && connection.pending) await connection.pending.catch(() => {});
    else if (!connection?.client) await this.connect(server.name).catch(() => {});
    connection = this.connections.get(server.name);
    if (!connection?.client) throw new McpCallRefused(`MCP 服务器 ${server.name} 无法连接：${connection?.error ?? "未连接"}`);
    const tool = connection.tools.find((item) => item.name === toolName);
    if (!tool) throw new McpCallRefused("服务器当前的工具列表中没有它");
    const status = this.statusOf(server, tool);
    if (status.needsUser) throw new McpCallRefused("服务器要求每次调用都由人确认，不提供这类工具");
    if (status.pending) throw new McpCallRefused(`该工具${status.pending === "new" ? "是新增的" : "的定义有变化"}，等待复核`);
    const result = await connection.client.callTool({ name: toolName, arguments: args }, { timeout: server.timeout * 1000 });
    const text = (result.content ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
    return { text, isError: result.isError === true };
  }

  private statusOf(server: StoredServer, tool: ToolDefinition) {
    return toolStatus(tool, { trusted: server.trusted, disabled: server.disabledTools.includes(tool.name), pin: server.pins?.[tool.name] });
  }

  private viewOf(server: StoredServer): McpServerView {
    const connection = this.connections.get(server.name);
    const state: ConnectionState = !server.enabled ? "disabled" : connection?.state ?? "connecting";
    const secrets = this.secretValues(server.name);
    const tools = (connection?.tools ?? []).map((tool): McpToolView => {
      const status = this.statusOf(server, tool);
      const pin = server.pins?.[tool.name];
      return {
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description?.trim() ?? "",
        enabled: !server.disabledTools.includes(tool.name),
        usable: status.usable,
        ...(status.pending ? { pending: status.pending } : {}),
        ...(status.pending === "changed" && pin ? pinDiff(pin, tool) : {}),
        needsUser: status.needsUser,
        readOnly: status.readOnly,
        mayModify: status.mayModify,
      };
    });
    const own = this.ownSecrets(server.name);
    return {
      name: server.name,
      ...(server.transport === "http"
        ? {
          transport: "http" as const,
          url: server.url,
          headers: masked(server.headerNames, own.headers),
          ...(server.oauth ? { oauth: { ...server.oauth, clientSecret: KEEP } } : {}),
          dpop: server.dpop,
        }
        : {
          transport: "stdio" as const,
          command: server.command,
          args: server.args,
          ...(server.cwd ? { cwd: server.cwd } : {}),
          env: masked(server.envNames, own.env),
          ...(server.sandbox ? { sandbox: server.sandbox } : {}),
        }),
      launchLine: launchLine(targetOf(server)),
      timeout: server.timeout,
      trusted: server.trusted,
      enabled: server.enabled,
      state,
      ...(connection?.error && state !== "connected" ? { error: redactSecrets(connection.error, secrets) } : {}),
      ...(connection?.retryAt && state === "failed" ? { retryAt: new Date(connection.retryAt).toISOString() } : {}),
      retries: connection?.failures ?? 0,
      ...(connection?.server ? { server: connection.server } : {}),
      ...(connection?.protocol && state === "connected" ? { protocol: connection.protocol } : {}),
      ...(connection?.connectedAt && state === "connected" ? { connectedAt: connection.connectedAt } : {}),
      ...(connection?.output.trim() ? { output: redactSecrets(connection.output.trim(), secrets) } : {}),
      tools,
      counts: { total: tools.length, usable: tools.filter((tool) => tool.usable).length, pending: tools.filter((tool) => tool.pending).length },
      attachedProfiles: [],
    };
  }

  /** The readable settings of a draft; secret values are checked by `secretsOf`. */
  private normalize(input: McpServerInput, previous: StoredServer | undefined): ServerSettings {
    const name = previous?.name ?? validateServerName(input.name);
    const common = { name, timeout: normalizeTimeout(input.timeout), trusted: input.trusted === true, enabled: input.enabled !== false };
    const transport = transportOf(input.transport);
    if (transport === "http") {
      const headers = this.valuesInput(input.headers, "请求头");
      return { ...common, transport, ...normalizeHttp({ url: input.url, headerNames: Object.keys(headers), oauth: input.oauth, dpop: input.dpop }) };
    }
    const env = this.valuesInput(input.env, "环境变量");
    const stdio = normalizeStdio({ command: input.command, args: input.args, cwd: input.cwd, envNames: Object.keys(env), sandbox: input.sandbox }, {
      homeDirectory: this.homeDirectory,
      stateDirectory: this.options.stateDirectory,
    });
    return { ...common, transport, ...stdio };
  }

  /**
   * A draft's secret values (mcp-catalog::REQ-001). `KEEP` keeps a saved value of the same transport; a change of
   * transport drops the other transport's secrets. The saved client secret is kept only for the same issuer, so a
   * secret never goes to an authorization server the owner did not enter it for.
   */
  private secretsOf(input: McpServerInput, settings: ServerSettings, previous: StoredServer | undefined): ServerSecrets {
    const saved = previous?.transport === settings.transport ? this.ownSecrets(settings.name) : { env: {}, headers: {} };
    if (settings.transport === "stdio") return { env: mergeSecrets(this.valuesInput(input.env, "环境变量"), saved.env), headers: {} };
    const headers = mergeSecrets(this.valuesInput(input.headers, "请求头"), saved.headers, "请求头");
    if (!settings.oauth) return { env: {}, headers };
    const sameIssuer = previous?.transport === "http" && previous.oauth?.issuer === settings.oauth.issuer;
    const secretInput = input.oauth && typeof input.oauth === "object" ? (input.oauth as Record<string, unknown>).clientSecret : undefined;
    if (secretInput === KEEP && saved.clientSecret !== undefined && !sameIssuer) throw new McpConfigError("更换授权服务器后，请重新填写客户端密钥");
    return { env: {}, headers, clientSecret: mergeClientSecret(secretInput, saved.clientSecret) };
  }

  private ownSecrets(name: string): ServerSecrets {
    const clientSecret = this.secrets.clientSecrets[name];
    return { env: this.secrets.env[name] ?? {}, headers: this.secrets.headers[name] ?? {}, ...(clientSecret !== undefined ? { clientSecret } : {}) };
  }

  /** Every secret value of a server, for masking its errors and output. */
  private secretValues(name: string): string[] {
    const own = this.ownSecrets(name);
    return [...Object.values(own.env), ...Object.values(own.headers), ...(own.clientSecret !== undefined ? [own.clientSecret] : [])];
  }

  private valuesInput(value: unknown, what: string): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new McpConfigError(`${what}格式不正确`);
    return value as Record<string, unknown>;
  }

  private planImport(text: unknown): ImportEntry[] {
    if (typeof text !== "string") throw new McpConfigError("请粘贴 mcpServers 配置");
    return checkImport(text, (name) => this.find(name) !== undefined, { homeDirectory: this.homeDirectory, stateDirectory: this.options.stateDirectory });
  }

  private requireConfirmation(settings: ServerSettings, confirmed: unknown): void {
    if (confirmed === launchLine(targetOf(settings))) return;
    throw new McpConfigError(settings.transport === "http"
      ? "请先确认将要连接的地址：确认卡片上的地址与当前填写的不一致"
      : "请先确认将要运行的命令：确认卡片上的命令与当前填写的不一致");
  }

  private require(name: string): StoredServer {
    const server = this.find(name);
    if (!server) throw new McpConfigError(`没有名为 ${name} 的 MCP 服务器`);
    return server;
  }

  private find(name: string): StoredServer | undefined {
    return this.servers.find((server) => server.name === name);
  }

  private nowIso(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }

  /**
   * Persists a change and audits it (agent-console::REQ-004). A change that cannot be audited is rolled back and
   * refused, before any connection is started or stopped.
   */
  private commit(servers: StoredServer[], secrets: Secrets, entry: Record<string, unknown> & { browser?: ConsoleBrowser | undefined }): void {
    const previous = { servers: this.servers, secrets: this.secrets };
    const { browser, ...rest } = entry;
    this.write(servers, secrets);
    try {
      this.options.audit.append({ by: "browser", ...(browser ? { browser: { id: browser.id, label: browser.label } } : {}), ...rest });
    } catch (error) {
      this.write(previous.servers, previous.secrets);
      throw new McpConfigError(`配置审计写入失败，更改未保存（${errorText(error)}）`);
    }
    this.servers = servers;
    this.secrets = secrets;
  }

  private write(servers: StoredServer[], secrets: Secrets): void {
    writeOwnerOnly(this.options.stateDirectory, SECRETS_FILE, { version: 1, ...secrets });
    writeOwnerOnly(this.options.stateDirectory, CATALOG_FILE, { version: 1, servers });
  }

  private persistPins(name: string, pins: Record<string, Pin>): void {
    this.servers = this.servers.map((server) => (server.name === name ? { ...server, pins } : server));
    try {
      this.write(this.servers, this.secrets);
    } catch (error) {
      process.stderr.write(`mcp_catalog_write_failed: ${errorText(error)}\n`);
    }
  }

  private connectionFor(name: string): Connection {
    let connection = this.connections.get(name);
    if (!connection) {
      connection = { state: "connecting", generation: 0, tools: [], output: "", failures: 0 };
      this.connections.set(name, connection);
    }
    return connection;
  }

  private stopTimers(connection: Connection): void {
    clearTimeout(connection.retryTimer);
    clearInterval(connection.refreshTimer);
    delete connection.retryTimer;
    delete connection.refreshTimer;
    delete connection.retryAt;
  }

  private async disconnect(name: string, state: ConnectionState = "disconnected"): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    connection.generation++;
    this.stopTimers(connection);
    const client = connection.client;
    delete connection.client;
    connection.state = state;
    if (state === "disabled") connection.tools = [];
    await client?.close().catch(() => {});
  }

  /** (Re)connects a server: starts the program, lists its tools and reviews them; a failure schedules a retry. */
  private connect(name: string, retry = false): Promise<void> {
    const server = this.require(name);
    const connection = this.connectionFor(name);
    const generation = ++connection.generation;
    this.stopTimers(connection);
    if (!retry) connection.failures = 0;
    const old = connection.client;
    delete connection.client;
    void old?.close().catch(() => {});
    if (!server.enabled || this.closed) {
      connection.state = "disabled";
      connection.tools = [];
      return Promise.resolve();
    }
    connection.state = "connecting";
    delete connection.error;
    connection.output = "";
    const secrets = this.secretValues(name);
    const run = async () => {
      const client = new Client(
        { name: "codex-weixin", version: "1.0.0" },
        { listChanged: { tools: { onChanged: (error, tools) => { if (!error && tools) this.applyTools(name, generation, tools as ToolDefinition[]); } } } },
      );
      try {
        await client.connect(this.transportFor(server, connection, generation), { timeout: CONNECT_TIMEOUT_MS });
        const tools = (await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS })).tools as ToolDefinition[];
        if (connection.generation !== generation) {
          void client.close().catch(() => {});
          return;
        }
        connection.client = client;
        connection.tools = tools;
        connection.state = "connected";
        connection.failures = 0;
        connection.connectedAt = this.nowIso();
        const negotiated = client.getNegotiatedProtocolVersion();
        if (negotiated) connection.protocol = negotiated; else delete connection.protocol;
        const info = client.getServerVersion();
        if (info) connection.server = { name: info.name, version: info.version }; else delete connection.server;
        client.onclose = () => {
          if (connection.generation !== generation || this.closed) return;
          clearInterval(connection.refreshTimer);
          delete connection.client;
          connection.state = "disconnected";
          connection.error = "连接已断开，将在下次调用时重新连接";
        };
        this.pinFirstListing(name, tools);
        const every = this.options.refreshMs ?? REFRESH_MS;
        if (every > 0 && !client.getServerCapabilities()?.tools?.listChanged) {
          connection.refreshTimer = setInterval(() => void this.refresh(name, generation), every);
          connection.refreshTimer.unref();
        }
      } catch (error) {
        void client.close().catch(() => {});
        if (connection.generation !== generation) return;
        const tail = connection.output.trim().split(/\r?\n/).filter(Boolean).at(-1);
        const raw = errorText(error);
        connection.state = "failed";
        connection.error = redactSecrets(`${raw}${tail && !raw.includes(tail) ? `（程序输出：${tail}）` : ""}`, secrets);
        connection.tools = [];
        const base = this.options.retryMs ?? undefined;
        const wait = base === 0 ? 0 : retryDelay(connection.failures, base);
        if (wait > 0 && !this.closed) {
          connection.failures++;
          connection.retryAt = (this.options.now ?? Date.now)() + wait;
          connection.retryTimer = setTimeout(() => {
            if (connection.generation !== generation || this.closed || !this.find(name)?.enabled) return;
            void this.connect(name, true).catch(() => {});
          }, wait);
          connection.retryTimer.unref();
        }
        process.stderr.write(`mcp_connect_failed: ${name}\n`);
        throw new Error(connection.error);
      } finally {
        if (connection.generation === generation) delete connection.pending;
      }
    };
    connection.pending = run();
    return connection.pending;
  }

  /** A local program started as its launch plan says, or a URL server with its headers and OAuth provider. */
  private transportFor(server: StoredServer, connection: Connection, generation: number): StdioClientTransport | StreamableHTTPClientTransport {
    const name = server.name;
    const own = this.ownSecrets(name);
    if (server.transport === "http") {
      const provider = server.oauth && own.clientSecret !== undefined
        ? new HostClientCredentials({ clientId: server.oauth.clientId, clientSecret: own.clientSecret, ...(server.oauth.scope ? { scope: server.oauth.scope } : {}), expectedIssuer: server.oauth.issuer }, server.dpop)
        : undefined;
      // A client_credentials client cannot widen its scope by asking again, so a scope challenge is an error.
      return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: own.headers }, ...(provider ? { authProvider: provider } : {}), onInsufficientScope: "throw" });
    }
    const plan = launchPlan(server, {
      homeDirectory: this.homeDirectory,
      stateDirectory: this.options.stateDirectory,
      platform: process.platform,
      execPath: process.execPath,
      srtPath: server.sandbox ? srtPath() : "",
      tmpDirectory: os.tmpdir(),
      cacheDirectory: path.join(this.cacheDirectory, name),
      isFile: (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } },
    });
    if (plan.sandbox) {
      fs.mkdirSync(path.dirname(plan.sandbox.settingsFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(plan.sandbox.settingsFile, JSON.stringify(plan.sandbox.settings, null, 2), { mode: 0o600 });
      const cache = path.join(this.cacheDirectory, name);
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      fs.chmodSync(cache, 0o700);
      // An empty user configuration, so that npm never reads the owner's ~/.npmrc.
      fs.writeFileSync(path.join(cache, "npmrc"), "", { mode: 0o600 });
    }
    const transport = new StdioClientTransport({
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      env: childEnvironment(this.options.env ?? process.env, { ...own.env, ...plan.env }),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      if (connection.generation === generation) connection.output = (connection.output + chunk.toString()).slice(-OUTPUT_TAIL);
    });
    return transport;
  }

  private async refresh(name: string, generation: number): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection?.client || connection.generation !== generation) return;
    const listed = await connection.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }).catch(() => undefined);
    if (listed) this.applyTools(name, generation, listed.tools as ToolDefinition[]);
  }

  private applyTools(name: string, generation: number, tools: ToolDefinition[]): void {
    const connection = this.connections.get(name);
    if (!connection || connection.generation !== generation) return;
    connection.tools = tools;
  }

  /** A server's first tool listing is pinned as a whole; later listings are compared with it. */
  private pinFirstListing(name: string, tools: ToolDefinition[]): void {
    const server = this.find(name);
    if (!server || server.pins) return;
    this.persistPins(name, Object.fromEntries(tools.map((tool) => [tool.name, pinOf(tool)])));
  }
}
