import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { ConsoleAudit } from "./console-audit.js";
import type { ConsoleBrowser } from "./console-access.js";
import {
  KEEP,
  McpConfigError,
  childEnvironment,
  launchLine,
  launchPlan,
  mergeSecrets,
  needsConfirmation,
  normalizeStdio,
  normalizeTimeout,
  pinDiff,
  pinOf,
  redactSecrets,
  retryDelay,
  toolStatus,
  validateServerName,
  type Pin,
  type PinPart,
  type ServerSettings,
  type ToolDefinition,
} from "./mcp-catalog-rules.js";

/**
 * The MCP Catalog (docs/specs/mcp-catalog.md, ADR-0027, ADR-0028): the local programs the owner registered, and the
 * host-side connections to them. The service holds every connection and every credential; agents only ever reach
 * a server through `toolsFor` and `call`, which re-check the current configuration.
 *
 * - `mcp-catalog.json` holds the readable configuration, disabled tools and pinned definitions; `mcp-secrets.json`
 *   holds environment values. Both are owner-only and replaced atomically, so a deleted server's secrets leave the
 *   disk with the rewrite.
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

export type McpServerView = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  launchLine: string;
  /** Saved environment values, always shown as the placeholder (mcp-catalog::REQ-001). */
  env: Record<string, string>;
  sandbox?: { domains: string[]; read: string[]; write: string[] };
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
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  sandbox?: unknown;
  timeout?: unknown;
  trusted?: unknown;
  enabled?: unknown;
};

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
  platform?: string;
  now?: () => number;
};

const proxyName = (server: string, tool: string) => `mcp__${server}__${tool}`;

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
  private servers: StoredServer[] = [];
  private secrets: Record<string, Record<string, string>> = {};
  private readonly connections = new Map<string, Connection>();
  private closed = false;

  constructor(options: McpCatalogOptions) {
    this.options = options;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    const stored = readJson(path.join(options.stateDirectory, CATALOG_FILE)) as { servers?: StoredServer[] } | undefined;
    this.servers = Array.isArray(stored?.servers) ? stored.servers.filter((server) => typeof server?.name === "string") : [];
    const secrets = readJson(path.join(options.stateDirectory, SECRETS_FILE)) as { env?: Record<string, Record<string, string>> } | undefined;
    this.secrets = secrets?.env && typeof secrets.env === "object" ? secrets.env : {};
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
    return { launchLine: launchLine(settings), needsConfirmation: needsConfirmation(previous, settings) };
  }

  /** Registers a server once the owner confirmed its exact launch line; nothing is stored or started before. */
  register(input: McpServerInput, confirmation: { confirmed?: unknown; actor: McpActor }): McpServerView {
    const name = validateServerName(input.name);
    if (this.find(name)) throw new McpConfigError(`已有名为 ${name} 的 MCP 服务器`);
    const settings = this.normalize(input, undefined);
    const env = mergeSecrets(this.envInput(input.env), undefined);
    this.requireConfirmation(settings, confirmation.confirmed);
    const server: StoredServer = { ...settings, disabledTools: [], updatedAt: this.nowIso() };
    this.commit([...this.servers, server], { ...this.secrets, ...(Object.keys(env).length ? { [name]: env } : {}) }, {
      browser: confirmation.actor.browser,
      event: "mcp_server_added",
      server: name,
      launchLine: launchLine(settings),
      envNames: Object.keys(env),
      ...(settings.cwd ? { cwd: settings.cwd } : {}),
      ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
      timeout: settings.timeout,
      trusted: settings.trusted,
      enabled: settings.enabled,
    });
    if (server.enabled) void this.connect(name).catch(() => {});
    return this.viewOf(server);
  }

  /** Saves a server's changes; a new launch line needs confirming and applies after reconnecting (REQ-002). */
  update(name: string, input: McpServerInput, confirmation: { confirmed?: unknown; actor: McpActor }): McpServerView {
    const previous = this.require(name);
    if (input.name !== undefined && input.name !== name) throw new McpConfigError("名称创建后不可修改");
    const settings = this.normalize({ ...input, name }, previous);
    const env = mergeSecrets(this.envInput(input.env), this.secrets[name]);
    if (needsConfirmation(previous, settings)) this.requireConfirmation(settings, confirmation.confirmed);
    const next: StoredServer = { ...settings, disabledTools: previous.disabledTools, ...(previous.pins ? { pins: previous.pins } : {}), updatedAt: this.nowIso() };
    const changed = (["command", "args", "cwd", "sandbox", "timeout", "trusted", "enabled"] as const)
      .filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
    const savedEnv = this.secrets[name] ?? {};
    const envChanged = JSON.stringify(Object.entries(savedEnv).sort()) !== JSON.stringify(Object.entries(env).sort());
    const secrets = { ...this.secrets };
    if (Object.keys(env).length) secrets[name] = env; else delete secrets[name];
    this.commit(this.servers.map((server) => (server === previous ? next : server)), secrets, {
      browser: confirmation.actor.browser,
      event: "mcp_server_changed",
      server: name,
      changed: [...changed, ...(envChanged ? ["env"] : [])],
      ...(changed.includes("command") || changed.includes("args") ? { launchLine: launchLine(settings) } : {}),
      envNames: Object.keys(env),
    });
    const reconnect = envChanged || changed.some((field) => ["command", "args", "cwd", "sandbox", "enabled"].includes(field));
    if (reconnect) {
      if (next.enabled) void this.connect(name).catch(() => {});
      else void this.disconnect(name, "disabled");
    }
    return this.viewOf(next);
  }

  /** Deletes an unattached server: its connection stops and its secrets leave the disk (mcp-catalog::US-005/AC-02). */
  async remove(name: string, actor: McpActor): Promise<void> {
    const server = this.require(name);
    const secrets = { ...this.secrets };
    delete secrets[name];
    this.commit(this.servers.filter((item) => item !== server), secrets, { browser: actor.browser, event: "mcp_server_deleted", server: name });
    await this.disconnect(name);
    this.connections.delete(name);
    fs.rmSync(path.join(this.options.stateDirectory, "mcp-sandbox", `${name}.json`), { force: true });
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
    const secrets = Object.values(this.secrets[server.name] ?? {});
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
    return {
      name: server.name,
      transport: "stdio",
      command: server.command,
      args: server.args,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      launchLine: launchLine(server),
      env: Object.fromEntries(server.envNames.map((envName) => [envName, KEEP])),
      ...(server.sandbox ? { sandbox: server.sandbox } : {}),
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

  private normalize(input: McpServerInput, previous: StoredServer | undefined): ServerSettings {
    const name = previous?.name ?? validateServerName(input.name);
    const env = this.envInput(input.env);
    const stdio = normalizeStdio({ command: input.command, args: input.args, cwd: input.cwd, envNames: Object.keys(env), sandbox: input.sandbox }, {
      homeDirectory: this.homeDirectory,
      stateDirectory: this.options.stateDirectory,
    });
    return { ...stdio, name, timeout: normalizeTimeout(input.timeout), trusted: input.trusted === true, enabled: input.enabled !== false };
  }

  private envInput(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new McpConfigError("环境变量格式不正确");
    return value as Record<string, unknown>;
  }

  private requireConfirmation(settings: ServerSettings, confirmed: unknown): void {
    if (confirmed !== launchLine(settings)) throw new McpConfigError("请先确认将要运行的命令：确认卡片上的命令与当前填写的不一致");
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
  private commit(servers: StoredServer[], secrets: Record<string, Record<string, string>>, entry: Record<string, unknown> & { browser?: ConsoleBrowser | undefined }): void {
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

  private write(servers: StoredServer[], secrets: Record<string, Record<string, string>>): void {
    writeOwnerOnly(this.options.stateDirectory, SECRETS_FILE, { version: 1, env: secrets });
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
    const secrets = Object.values(this.secrets[name] ?? {});
    const run = async () => {
      const client = new Client(
        { name: "codex-weixin", version: "1.0.0" },
        { listChanged: { tools: { onChanged: (error, tools) => { if (!error && tools) this.applyTools(name, generation, tools as ToolDefinition[]); } } } },
      );
      try {
        const plan = launchPlan(server, {
          homeDirectory: this.homeDirectory,
          stateDirectory: this.options.stateDirectory,
          platform: this.options.platform ?? process.platform,
          execPath: process.execPath,
          srtPath: server.sandbox ? srtPath() : "",
          tmpDirectory: os.tmpdir(),
        });
        if (plan.sandbox) {
          fs.mkdirSync(path.dirname(plan.sandbox.settingsFile), { recursive: true, mode: 0o700 });
          fs.writeFileSync(plan.sandbox.settingsFile, JSON.stringify(plan.sandbox.settings, null, 2), { mode: 0o600 });
        }
        const transport = new StdioClientTransport({
          command: plan.command,
          args: plan.args,
          cwd: plan.cwd,
          env: childEnvironment(this.options.env ?? process.env, this.secrets[name] ?? {}),
          stderr: "pipe",
        });
        transport.stderr?.on("data", (chunk: Buffer) => {
          if (connection.generation === generation) connection.output = (connection.output + chunk.toString()).slice(-OUTPUT_TAIL);
        });
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
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
