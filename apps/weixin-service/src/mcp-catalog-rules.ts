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

export type ServerSettings = StdioSettings & { name: string; timeout: number; trusted: boolean; enabled: boolean };

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

function sandboxDirectories(value: unknown, what: string, context: { homeDirectory: string; stateDirectory: string }): string[] {
  const out: string[] = [];
  for (const raw of stringList(value, what).map((item) => item.trim()).filter(Boolean)) {
    if (!path.isAbsolute(raw)) throw new McpConfigError(`${what}应为绝对路径：${raw}`);
    const resolved = path.resolve(raw);
    const home = path.resolve(context.homeDirectory);
    if (resolved === path.sep || resolved === home || home.startsWith(resolved + path.sep)) throw new McpConfigError(`${what}不能是家目录本身或它的上级：${resolved}`);
    const state = path.resolve(context.stateDirectory);
    if (resolved === state || state.startsWith(resolved + path.sep) || resolved.startsWith(state + path.sep)) throw new McpConfigError(`${what}不能包含服务的状态目录，也不能在其中：${resolved}`);
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
  return { command, args, ...(cwd ? { cwd } : {}), envNames: [...new Set(envNames)], ...(sandbox ? { sandbox } : {}) };
}

/**
 * Environment values are write-only (mcp-catalog::REQ-001): `KEEP` keeps the saved value, any other text replaces
 * it, and a name left out is removed.
 */
export function mergeSecrets(input: Record<string, unknown>, saved: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") throw new McpConfigError(`环境变量 ${name} 的值应为文本`);
    if (value === KEEP) {
      const kept = saved?.[name];
      if (kept === undefined) throw new McpConfigError(`环境变量 ${name} 没有已保存的值，请填写`);
      out[name] = kept;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function shellQuote(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The exact program the owner confirms, as a POSIX shell would read it (mcp-catalog::US-001/AC-06). */
export function launchLine(settings: Pick<StdioSettings, "command" | "args">): string {
  return [settings.command, ...settings.args].map(shellQuote).join(" ");
}

/** A new server, or a change of what it runs, needs the owner to confirm the exact line (mcp-catalog::REQ-002). */
export function needsConfirmation(previous: Pick<StdioSettings, "command" | "args"> | undefined, next: Pick<StdioSettings, "command" | "args">): boolean {
  return previous === undefined || launchLine(previous) !== launchLine(next);
}

/** Masks secrets of `MIN_REDACTED_LENGTH` characters or more in program output, errors and logs. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  const longestFirst = [...new Set(secrets)].filter((secret) => secret.length >= MIN_REDACTED_LENGTH).sort((a, b) => b.length - a.length);
  for (const secret of longestFirst) out = out.split(secret).join("***");
  return out;
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
  /** For a sandboxed program: the settings `srt` reads, to be written to `settingsFile`. */
  sandbox?: { settingsFile: string; settings: unknown };
};

/**
 * How a local program starts. Unsandboxed: as configured. Sandboxed (macOS only): through `srt` with its own rules —
 * network only to the allowed domains, no reads in the home or state directory except the configured directories
 * and the program's own, writes only to the writable directories and the temporary directory. Readable directories
 * stay read-only even inside the temporary directory.
 */
export function launchPlan(
  settings: Pick<ServerSettings, "name" | "command" | "args" | "cwd" | "sandbox">,
  context: { homeDirectory: string; stateDirectory: string; platform: string; execPath: string; srtPath: string; tmpDirectory: string },
): LaunchPlan {
  const cwd = settings.cwd ?? context.homeDirectory;
  if (!settings.sandbox) return { command: settings.command, args: [...settings.args], cwd };
  if (context.platform !== "darwin") throw new McpConfigError(`沙箱只支持 macOS，${settings.name} 设为在沙箱中运行，未启动`);
  const own = [settings.command, ...settings.args].filter((item) => path.isAbsolute(item)).map((item) => path.dirname(item));
  const settingsFile = path.join(context.stateDirectory, "mcp-sandbox", `${settings.name}.json`);
  const rules = {
    network: { allowedDomains: settings.sandbox.domains, deniedDomains: [] },
    filesystem: {
      denyRead: [context.homeDirectory, context.stateDirectory],
      allowRead: [...new Set([path.dirname(path.dirname(context.execPath)), ...own, ...(settings.cwd ? [settings.cwd] : []), ...settings.sandbox.read, ...settings.sandbox.write])],
      allowWrite: [...settings.sandbox.write, context.tmpDirectory],
      denyWrite: settings.sandbox.read.filter((directory) => !settings.sandbox!.write.includes(directory)),
    },
  };
  return {
    command: context.execPath,
    args: [context.srtPath, "--settings", settingsFile, "--", settings.command, ...settings.args],
    cwd,
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
