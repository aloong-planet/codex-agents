import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Pure rules of the MCP Catalog (docs/specs/mcp-catalog.md). Configuration shape, defaults and limits follow the
 * owner's agent-link MCP settings, which the spec names as the reference.
 */

/** Letters, digits, `_` and `-`, 1–32 characters: part of every proxy tool name (mcp-catalog::US-001/AC-02). */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** Shown for a saved secret, and sent back to mean "keep the saved value" (mcp-catalog::REQ-001). */
export const KEEP = "••••••";
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** Secrets shorter than this are not masked in program output or logs: they cannot be told from ordinary text. */
export const MIN_REDACTED_LENGTH = 6;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** The `_meta` key with which a server asks for a person to confirm every call (Claude Code's convention). */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOMAIN = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
/** The variables a local program needs to run; never a model key or a service setting (mcp-catalog::REQ-003/AC-01). */
const BASE_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TMPDIR", "NODE_EXTRA_CA_CERTS"]);

/** A refusal whose message is shown to the owner as is. */
export class McpConfigError extends Error {}

export type SandboxSettings = { domains: string[]; read: string[]; write: string[] };

/** A local program's readable configuration. Environment values are secrets and live apart from it. */
export type StdioSettings = {
  command: string;
  args: string[];
  /** Absent means the home directory. */
  cwd?: string;
  envNames: string[];
  sandbox?: SandboxSettings;
};

export type OAuthSettings = { issuer: string; clientId: string; scope?: string };

/** A URL server's readable configuration. Header values and the OAuth client secret are secrets and live apart from it. */
export type HttpSettings = {
  url: string;
  headerNames: string[];
  /** OAuth client_credentials; the token is requested from `issuer` only. */
  oauth?: OAuthSettings;
  /** Present the OAuth token with DPoP (RFC 9449); requires `oauth`. */
  dpop: boolean;
};

export type Transport = "stdio" | "http";
type Common = { name: string; timeout: number; trusted: boolean; enabled: boolean };
export type StdioServerSettings = Common & { transport: "stdio" } & StdioSettings;
export type HttpServerSettings = Common & { transport: "http" } & HttpSettings;
export type ServerSettings = StdioServerSettings | HttpServerSettings;

/** What a server runs or connects to: the part the owner confirms (mcp-catalog::US-001/AC-06, REQ-002). */
export type ServerTarget = { transport?: "stdio"; command: string; args: string[] } | { transport: "http"; url: string };

export type ToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
  _meta?: Record<string, unknown>;
};

export type PinPart = "text" | "schema" | "hints" | "meta";
export type Pin = { hash: string; parts: Record<PinPart, string>; description: string };

export function validateServerName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!SERVER_NAME.test(name)) throw new McpConfigError("名称只能包含英文字母、数字、_ 和 -，1–32 个字符");
  return name;
}

/** Empty means the default of 60 seconds; otherwise an integer from 1 to 600 (mcp-catalog::US-001/AC-05). */
export function normalizeTimeout(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEOUT_SECONDS;
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new McpConfigError("超时应为 1–600 的整数（秒）");
  return seconds;
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new McpConfigError(`${what}格式不正确`);
  return value as string[];
}

type SandboxContext = { homeDirectory: string; stateDirectory: string };

/** A directory a sandboxed program may read: never the home, `/` or an ancestor of the home, nor in or around the state directory. */
function checkSandboxDirectory(directory: string, what: string, context: SandboxContext): string {
  const resolved = path.resolve(directory);
  const home = path.resolve(context.homeDirectory);
  if (resolved === path.sep || resolved === home || home.startsWith(resolved + path.sep)) throw new McpConfigError(`${what}不能是家目录本身或它的上级：${resolved}`);
  if (insideOrAround(resolved, context.stateDirectory)) throw new McpConfigError(`${what}不能包含服务的状态目录，也不能在其中：${resolved}`);
  return resolved;
}

function insideOrAround(target: string, stateDirectory: string): boolean {
  const state = path.resolve(stateDirectory);
  return target === state || state.startsWith(target + path.sep) || target.startsWith(state + path.sep);
}

function sandboxDirectories(value: unknown, what: string, context: SandboxContext): string[] {
  const out: string[] = [];
  for (const raw of stringList(value, what).map((item) => item.trim()).filter(Boolean)) {
    if (!path.isAbsolute(raw)) throw new McpConfigError(`${what}应为绝对路径：${raw}`);
    const resolved = checkSandboxDirectory(raw, what, context);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * Validates a local program's fields (mcp-catalog::US-001/AC-03). Arguments arrive one per entry; the page splits
 * its one-per-line text and drops blank lines. Environment names are checked here, their values by `mergeSecrets`.
 */
export function normalizeStdio(
  input: { command?: unknown; args?: unknown; cwd?: unknown; envNames?: unknown; sandbox?: unknown },
  context: { homeDirectory: string; stateDirectory: string },
): StdioSettings {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new McpConfigError("请填写命令");
  const args = stringList(input.args, "参数");
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (cwd && !path.isAbsolute(cwd)) throw new McpConfigError("工作目录应为绝对路径");
  const envNames = stringList(input.envNames, "环境变量");
  for (const name of envNames) if (!ENV_NAME.test(name)) throw new McpConfigError(`环境变量名称不合法：${name}`);
  let sandbox: SandboxSettings | undefined;
  if (input.sandbox !== undefined && input.sandbox !== null && input.sandbox !== false) {
    if (typeof input.sandbox !== "object" || Array.isArray(input.sandbox)) throw new McpConfigError("沙箱设置格式不正确");
    const raw = input.sandbox as Record<string, unknown>;
    const domains = [...new Set(stringList(raw.domains, "放行的域名").map((item) => item.trim()).filter(Boolean))];
    for (const domain of domains) if (!DOMAIN.test(domain)) throw new McpConfigError(`放行的域名不合法：${domain}（如 api.github.com、*.example.com）`);
    sandbox = {
      domains,
      read: sandboxDirectories(raw.read, "可读的目录", context),
      write: sandboxDirectories(raw.write, "可读写的目录", context),
    };
  }
  // A sandboxed program can read its working directory, so it passes the same checks as a readable directory.
  if (sandbox && cwd) checkSandboxDirectory(cwd, "工作目录", context);
  return { command, args, ...(cwd ? { cwd } : {}), envNames: [...new Set(envNames)], ...(sandbox ? { sandbox } : {}) };
}

/**
 * Environment values are write-only (mcp-catalog::REQ-001): `KEEP` keeps the saved value, any other text replaces
 * it, and a name left out is removed.
 */
export function mergeSecrets(input: Record<string, unknown>, saved: Readonly<Record<string, string>> | undefined, what = "环境变量"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") throw new McpConfigError(`${what} ${name} 的值应为文本`);
    if (value === KEEP) {
      const kept = saved?.[name];
      if (kept === undefined) throw new McpConfigError(`${what} ${name} 没有已保存的值，请填写`);
      out[name] = kept;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Hosts that may use plain http: the service and the server are on this machine (RFC 8252 §7.3). */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname === "[::1]";
}

/** An https address, or http on a loopback host; header values, secrets and tokens never travel unencrypted. */
function checkAddress(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpConfigError(`${what}无效：${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new McpConfigError(`${what}应以 https:// 开头，本机地址可用 http://：${raw}`);
  if (url.username || url.password) throw new McpConfigError(`${what}不能包含用户名或密码，请改用请求头`);
  return url;
}

/** An HTTP field name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers that carry the OAuth token, which the service sets itself when OAuth is configured. */
const TOKEN_HEADERS = new Set(["authorization", "dpop"]);

/**
 * Validates a URL server's fields (mcp-catalog::US-001/AC-04). Headers may sit beside OAuth, except Authorization and
 * DPoP, which carry the OAuth token; DPoP needs OAuth. Header values are checked by `mergeSecrets`, the client secret
 * by `mergeClientSecret`.
 */
export function normalizeHttp(input: { url?: unknown; headerNames?: unknown; oauth?: unknown; dpop?: unknown }): HttpSettings {
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw) throw new McpConfigError("请填写网址");
  const url = checkAddress(raw, "网址");
  const headerNames = stringList(input.headerNames, "请求头");
  const seen = new Set<string>();
  for (const name of headerNames) {
    if (!HEADER_NAME.test(name)) throw new McpConfigError(`请求头名称不合法：${name}`);
    if (seen.has(name.toLowerCase())) throw new McpConfigError(`请求头重复：${name}`);
    seen.add(name.toLowerCase());
  }
  let oauth: OAuthSettings | undefined;
  if (input.oauth !== undefined && input.oauth !== null && input.oauth !== false) {
    if (typeof input.oauth !== "object" || Array.isArray(input.oauth)) throw new McpConfigError("OAuth 设置格式不正确");
    const fields = input.oauth as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const issuer = text(fields.issuer);
    const clientId = text(fields.clientId);
    const scope = text(fields.scope);
    if (issuer || clientId || scope) {
      if (!issuer) throw new McpConfigError("请填写 OAuth 授权服务器");
      checkAddress(issuer, "OAuth 授权服务器");
      if (!clientId) throw new McpConfigError("请填写客户端 ID");
      oauth = { issuer, clientId, ...(scope ? { scope } : {}) };
    }
  }
  if (oauth) for (const name of headerNames) if (TOKEN_HEADERS.has(name.toLowerCase())) throw new McpConfigError(`已填写 OAuth 时，请求头不能包含 ${name}：令牌由 OAuth 取得`);
  const dpop = input.dpop === true;
  if (dpop && !oauth) throw new McpConfigError("DPoP 需要配合 OAuth 使用");
  return { url: url.href, headerNames, ...(oauth ? { oauth } : {}), dpop };
}

/** The OAuth client secret is write-only (mcp-catalog::REQ-001): `KEEP` keeps the saved one, other text replaces it. */
export function mergeClientSecret(value: unknown, saved: string | undefined): string {
  if (value === KEEP) {
    if (saved === undefined) throw new McpConfigError("客户端密钥没有已保存的值，请填写");
    return saved;
  }
  if (typeof value !== "string" || !value) throw new McpConfigError("请填写客户端密钥");
  return value;
}

function shellQuote(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact program or address the owner confirms (mcp-catalog::US-001/AC-06): a local program as a POSIX shell would
 * read it, a URL server as the normalized URL it connects to.
 */
export function launchLine(target: ServerTarget): string {
  if (target.transport === "http") return target.url;
  return [target.command, ...target.args].map(shellQuote).join(" ");
}

/** A new server, or a change of what it runs or where it connects, needs the owner to confirm it (mcp-catalog::REQ-002). */
export function needsConfirmation(previous: ServerTarget | undefined, next: ServerTarget): boolean {
  return previous === undefined || (previous.transport ?? "stdio") !== (next.transport ?? "stdio") || launchLine(previous) !== launchLine(next);
}

/** How many times over JSON text may be carried as a string inside JSON text for a secret in it still to be masked. */
const JSON_NESTING_LIMIT = 4;
const JSON_SHORT_ESCAPES = new Map([['"', '"'], ["\\", "\\"], ["/", "/"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"]]);

/** A text, and where each of its characters begins and ends in the text it was read from. */
type Spelled = Readonly<{ text: string; from(at: number): number; to(at: number): number }>;

/** `spelled` with its JSON string escapes undone once; undefined when it holds none. Any other backslash stays. */
function unescaped({ text, from, to }: Spelled): Spelled | undefined {
  if (!text.includes("\\")) return undefined;
  const units: string[] = [], starts: number[] = [], ends: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    let unit = text[at]!, last = at;
    if (unit === "\\") {
      const short = JSON_SHORT_ESCAPES.get(text[at + 1] ?? "");
      const hex = text[at + 1] === "u" ? /^[0-9a-fA-F]{4}/.exec(text.slice(at + 2, at + 6))?.[0] : undefined;
      if (short !== undefined) { unit = short; last = at + 1; }
      else if (hex) { unit = String.fromCharCode(Number.parseInt(hex, 16)); last = at + 5; }
    }
    units.push(unit); starts.push(from(at)); ends.push(to(last));
    at = last;
  }
  return units.length === text.length ? undefined : { text: units.join(""), from: (at) => starts[at]!, to: (at) => ends[at]! };
}

/**
 * Masks secrets of `MIN_REDACTED_LENGTH` characters or more in program output, errors, logs and what a tool call returns
 * (mcp-catalog::REQ-001). A secret is found as it is and in every spelling JSON text gives it: any character may be written
 * as `\uXXXX`, and a quote, a backslash, a slash or a control character by its short escape. JSON text may itself be carried
 * as a string inside JSON text, so escapes are undone up to `JSON_NESTING_LIMIT` times over, and whatever then reads as a
 * secret is masked where it stands in `text`.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  const values = [...new Set(secrets)].filter((secret) => secret.length >= MIN_REDACTED_LENGTH);
  if (!values.length) return text;
  // Where a spelling of a secret begins and ends in `text`.
  const found: Array<[number, number]> = [];
  let spelled: Spelled = { text, from: (at) => at, to: (at) => at + 1 };
  for (let depth = 0; ; depth += 1) {
    for (const secret of values) {
      for (let at = spelled.text.indexOf(secret); at >= 0; at = spelled.text.indexOf(secret, at + 1)) found.push([spelled.from(at), spelled.to(at + secret.length - 1)]);
    }
    const next = depth < JSON_NESTING_LIMIT ? unescaped(spelled) : undefined;
    if (!next) break;
    spelled = next;
  }
  // Spellings that overlap are masked as one.
  const spans: Array<[number, number]> = [];
  for (const [start, end] of found.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = spans.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  let out = "", done = 0;
  for (const [start, end] of spans) { out += `${text.slice(done, start)}***`; done = end; }
  return out + text.slice(done);
}

/** `redactSecrets` over every string of a JSON value, keys included, at any depth. */
export function redactDeep(value: unknown, secrets: Iterable<string>): unknown {
  const values = [...secrets];
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactSecrets(item, values);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [redactSecrets(key, values), walk(inner)]));
    return item;
  };
  return walk(value);
}

/** Key-sorted JSON, so that a definition sent with another key order is not reported as changed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The pinned fingerprint of a tool definition (mcp-catalog::US-004/AC-03). */
export function pinOf(tool: ToolDefinition): Pin {
  const parts: Record<PinPart, string> = {
    text: digest(canonicalJson([tool.title ?? null, tool.description ?? null])),
    schema: digest(canonicalJson([tool.inputSchema ?? null, tool.outputSchema ?? null])),
    hints: digest(canonicalJson(tool.annotations ?? null)),
    meta: digest(canonicalJson(tool._meta ?? null)),
  };
  return { hash: digest(canonicalJson([tool.name, parts])), parts, description: tool.description?.trim() ?? "" };
}

/** Which parts of a pinned definition changed, and the description the owner confirmed before. */
export function pinDiff(pinned: Pin, tool: ToolDefinition): { changed: PinPart[]; was: string } {
  const now = pinOf(tool);
  return { changed: (Object.keys(now.parts) as PinPart[]).filter((part) => pinned.parts[part] !== now.parts[part]), was: pinned.description };
}

/** Delay before automatic retry number `failures + 1`: from 30 s, doubling, at most 10 minutes. */
/** A function name the model provider takes: letters, digits, `_` and `-`, at most 64 characters. */
const OFFERED_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The name a runtime is offered for a tool, from the tool's own name alone. A name the model provider takes is offered as
 * it is. Any other name is offered with every other character as `_`, cut to 55 characters, followed by `_` and the first 8
 * hex characters of the name's SHA-256. The App Server refuses a thread that is offered a tool with any other kind of
 * name. A thread keeps the names it was offered when it started, also across a restart of the server's program or of the
 * service, so the offered name must not depend on what else the server lists.
 */
export function offeredToolName(tool: string): string {
  if (OFFERED_NAME.test(tool)) return tool;
  return `${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55)}_${createHash("sha256").update(tool).digest("hex").slice(0, 8)}`;
}

const SCHEMA_MAPS = ["properties", "$defs", "definitions", "patternProperties"];
const SCHEMA_VALUES = ["items", "additionalProperties", "not", "if", "then", "else", "propertyNames", "contains"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];

/** Whether every keyword that holds a schema, a list or a type name in `schema` has that form, at any depth. */
function wellFormedSchema(schema: unknown): boolean {
  if (typeof schema === "boolean") return true;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (record.type !== undefined && typeof record.type !== "string" && !(strings(record.type) && (record.type as unknown[]).length > 0)) return false;
  if (record.required !== undefined && !strings(record.required)) return false;
  if (record.enum !== undefined && !Array.isArray(record.enum)) return false;
  for (const key of SCHEMA_MAPS) {
    const value = record[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every(wellFormedSchema))) return false;
  }
  for (const key of SCHEMA_VALUES) if (record[key] !== undefined && !wellFormedSchema(record[key])) return false;
  for (const key of SCHEMA_LISTS) if (record[key] !== undefined && !(Array.isArray(record[key]) && (record[key] as unknown[]).every(wellFormedSchema))) return false;
  return true;
}

/**
 * A tool's description and input schema as a runtime is offered them. The Codex App Server refuses a whole thread when one
 * offered tool has an input schema it cannot read; measured on it, that is a list in `items` (the older way to write a tuple)
 * and a schema whose only type is `null`. A schema with such a form, or one that is not an object, is therefore offered as an
 * open object, and the description then ends with the schema itself, so that the model can still fill the arguments in.
 */
export function offeredInput(description: string, inputSchema: unknown): { description: string; inputSchema: Record<string, unknown> } {
  const record = inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema) ? inputSchema as Record<string, unknown> : undefined;
  const onlyNull = record?.type === "null" || (Array.isArray(record?.type) && record.type.every((type) => type === "null"));
  if (record && !onlyNull && wellFormedSchema(record)) return { description, inputSchema: record };
  return { description: `${description}${description ? "\n\n" : ""}参数按这份 JSON Schema 填写：${JSON.stringify(inputSchema ?? null)}`, inputSchema: { type: "object", additionalProperties: true } };
}

export function retryDelay(failures: number, base = RETRY_BASE_MS): number {
  return Math.min(base * 2 ** failures, RETRY_MAX_MS);
}

/** A local program's environment: the base variables of the service's own environment plus its configured ones. */
export function childEnvironment(parent: Readonly<Record<string, string | undefined>>, own: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) if (value !== undefined && (BASE_ENV.has(name) || name.startsWith("LC_") || name.startsWith("XDG_"))) env[name] = value;
  return { ...env, ...own };
}

export type LaunchPlan = {
  command: string;
  args: string[];
  cwd: string;
  /** Variables the service sets for a sandboxed program; they win over owner-entered ones of the same names. */
  env: Record<string, string>;
  /** For a sandboxed program: the settings `srt` reads, to be written to `settingsFile`. */
  sandbox?: { settingsFile: string; settings: unknown };
};

/**
 * How a local program starts. Unsandboxed: as configured. Sandboxed (macOS only), through `srt` with only what the
 * owner typed plus the minimum the service supplies:
 * - reads: the Node.js prefix, each command path or absolute argument that is an existing file (the file itself,
 *   never its directory, and never one in the state directory), the working directory, the readable and writable
 *   directories, and the server's own npm cache; the home and state directories are otherwise unreadable;
 * - writes: the writable directories, the temporary directory and the server's own npm cache; readable directories
 *   and named files stay read-only even inside the temporary directory;
 * - npm uses the server's own cache and an empty user configuration, so `~/.npm` and `~/.npmrc` are never touched;
 * - network: only the allowed domains.
 * A Node.js prefix that fails the readable-directory checks refuses the start instead of widening the sandbox.
 */
export function launchPlan(
  settings: Pick<StdioServerSettings, "name" | "command" | "args" | "cwd" | "sandbox">,
  context: {
    homeDirectory: string;
    stateDirectory: string;
    platform: string;
    execPath: string;
    srtPath: string;
    tmpDirectory: string;
    /** The server's own npm cache directory, outside the state and temporary directories. */
    cacheDirectory: string;
    isFile: (file: string) => boolean;
  },
): LaunchPlan {
  const cwd = settings.cwd ?? context.homeDirectory;
  if (!settings.sandbox) return { command: settings.command, args: [...settings.args], cwd, env: {} };
  if (context.platform !== "darwin") throw new McpConfigError(`沙箱只支持 macOS，${settings.name} 设为在沙箱中运行，未启动`);
  const nodePrefix = checkSandboxDirectory(path.dirname(path.dirname(context.execPath)), "Node.js 安装目录", context);
  const files = [...new Set([settings.command, ...settings.args]
    .filter((item) => path.isAbsolute(item))
    .map((item) => path.resolve(item))
    .filter((file) => context.isFile(file) && !insideOrAround(file, context.stateDirectory)))];
  const settingsFile = path.join(context.stateDirectory, "mcp-sandbox", `${settings.name}.json`);
  const rules = {
    network: { allowedDomains: settings.sandbox.domains, deniedDomains: [] },
    filesystem: {
      denyRead: [context.homeDirectory, context.stateDirectory],
      allowRead: [...new Set([nodePrefix, ...files, ...(settings.cwd ? [settings.cwd] : []), ...settings.sandbox.read, ...settings.sandbox.write, context.cacheDirectory])],
      allowWrite: [...settings.sandbox.write, context.tmpDirectory, context.cacheDirectory],
      denyWrite: [...settings.sandbox.read.filter((directory) => !settings.sandbox!.write.includes(directory)), ...files],
    },
  };
  return {
    command: context.execPath,
    args: [context.srtPath, "--settings", settingsFile, "--", settings.command, ...settings.args],
    cwd,
    env: { npm_config_cache: path.join(context.cacheDirectory, "npm"), npm_config_userconfig: path.join(context.cacheDirectory, "npmrc") },
    sandbox: { settingsFile, settings: rules },
  };
}

export type ToolStatus = { usable: boolean; pending?: "new" | "changed"; needsUser: boolean; readOnly: boolean; mayModify: boolean };

/**
 * Whether a tool may be provided (mcp-catalog::US-004): it is enabled, its definition matches the pinned one, and
 * the server does not ask for a person on every call. Annotations count only for trusted servers.
 */
export function toolStatus(tool: ToolDefinition, server: { trusted: boolean; disabled: boolean; pin: Pin | undefined }): ToolStatus {
  const pending = !server.pin ? "new" : server.pin.hash !== pinOf(tool).hash ? "changed" : undefined;
  const needsUser = tool._meta?.[REQUIRES_USER_INTERACTION] === true;
  return {
    usable: !server.disabled && !pending && !needsUser,
    ...(pending ? { pending } : {}),
    needsUser,
    readOnly: server.trusted && tool.annotations?.readOnlyHint === true,
    mayModify: server.trusted && tool.annotations?.destructiveHint === true,
  };
}

/** A server the import would register, with its secret values; never sent to the browser. */
export type ImportedServer =
  | { transport: "stdio"; name: string; enabled: boolean; command: string; args: string[]; cwd?: string; env: Record<string, string> }
  | { transport: "http"; name: string; enabled: boolean; url: string; headers: Record<string, string> };

/** One server of an `mcpServers` document: to be imported, or skipped with the reason (mcp-catalog::US-002/AC-01). */
export type ImportEntry =
  | {
      name: string;
      ok: true;
      transport: Transport;
      /** The exact command or address the confirmation card shows. */
      line: string;
      /** Keys whose value was only a placeholder such as `${NAME}`: imported without a value, for the owner to fill in. */
      fill: string[];
      enabled: boolean;
      server: ImportedServer;
    }
  | { name: string; ok: false; reason: string };

/** A value that is only a placeholder another client would expand, such as `${GITHUB_TOKEN}` or `${input:key}`. */
const PLACEHOLDER = /^\$\{[^}]*\}$/;
const NAME_RULE = "只能包含英文字母、数字、_ 和 -，1–32 个字符";

/** Secret values as imported: placeholders become empty values, named in `fill`. */
function importedValues(value: unknown, what: string, fill: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new McpConfigError(`${what}格式不正确`);
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new McpConfigError(`${what} ${name} 的值应为文本`);
    if (PLACEHOLDER.test(item)) fill.push(name);
    out[name] = PLACEHOLDER.test(item) ? "" : item;
  }
  return out;
}

function importEntry(name: string, value: unknown, exists: (name: string) => boolean, context: SandboxContext): ImportEntry {
  if (!SERVER_NAME.test(name)) return { name, ok: false, reason: `名称不合法：${NAME_RULE}` };
  if (exists(name)) return { name, ok: false, reason: "已有同名服务器" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { name, ok: false, reason: "格式不正确" };
  const entry = value as Record<string, unknown>;
  const type = entry.type === undefined ? undefined : String(entry.type).toLowerCase();
  if (type === "sse") return { name, ok: false, reason: "SSE 传输，不支持" };
  if (type !== undefined && !["stdio", "http", "streamable-http", "streamablehttp"].includes(type)) return { name, ok: false, reason: `不支持的连接方式：${String(entry.type)}` };
  const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
  const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
  const transport: Transport | undefined = type === "stdio" ? (hasCommand ? "stdio" : undefined)
    : type !== undefined ? (hasUrl ? "http" : undefined)
    : hasCommand && hasUrl ? undefined : hasCommand ? "stdio" : hasUrl ? "http" : undefined;
  if (!transport) return { name, ok: false, reason: type === undefined && hasCommand && hasUrl ? "同时填写了命令和网址" : "缺少命令或网址" };
  const enabled = entry.disabled !== true;
  const fill: string[] = [];
  try {
    if (transport === "stdio") {
      const env = importedValues(entry.env, "环境变量", fill);
      const stdio = normalizeStdio({ command: entry.command, args: entry.args, cwd: entry.cwd, envNames: Object.keys(env) }, context);
      const server: ImportedServer = { transport, name, enabled, command: stdio.command, args: stdio.args, ...(stdio.cwd ? { cwd: stdio.cwd } : {}), env };
      return { name, ok: true, transport, line: launchLine(stdio), fill, enabled, server };
    }
    const headers = importedValues(entry.headers, "请求头", fill);
    const http = normalizeHttp({ url: entry.url, headerNames: Object.keys(headers) });
    return { name, ok: true, transport, line: http.url, fill, enabled, server: { transport, name, enabled, url: http.url, headers } };
  } catch (error) {
    if (error instanceof McpConfigError) return { name, ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Checks an `{"mcpServers": {…}}` document (mcp-catalog::US-002/AC-01). Each server is to be imported or skipped with
 * the reason; a document that is not JSON or has no `mcpServers` object is refused. Other top-level keys (Claude
 * Desktop keeps its settings beside `mcpServers`) and unknown keys of a server are ignored. Imported servers get no
 * sandbox, OAuth or timeout; `"disabled": true` imports a server switched off.
 */
export function checkImport(text: string, exists: (name: string) => boolean, context: SandboxContext): ImportEntry[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new McpConfigError("不是有效的 JSON");
  }
  const servers = document && typeof document === "object" && !Array.isArray(document) ? (document as Record<string, unknown>).mcpServers : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new McpConfigError("没有找到 mcpServers 对象");
  const entries = Object.entries(servers as Record<string, unknown>);
  if (entries.length === 0) throw new McpConfigError("mcpServers 里没有服务器");
  return entries.map(([name, value]) => importEntry(name, value, exists, context));
}
