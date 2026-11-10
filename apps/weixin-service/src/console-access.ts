import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { ConsoleAudit } from "./console-audit.js";
import { LOGIN_CARD_CONTENT_SECURITY_POLICY, renderLoginCard, type LoginCardNotice } from "./console-login-card.js";

/**
 * Owner authorization for every page and API of the local service (agent-console::US-001, CON-001, REQ-004).
 *
 * - A login link carries a one-time token kept only in memory; it is valid for 2 minutes and deleted on any use.
 * - Exchanging it sets an HttpOnly, SameSite=Strict cookie named after the port, because 127.0.0.1 cookies are
 *   shared across ports. The store keeps only the cookie's SHA-256 hash, so a leaked store authorizes nobody.
 * - Each authorization and revocation is appended to a JSON Lines audit file. An authorization that cannot be
 *   stored and audited is refused; a revocation always applies and reports a failed audit append.
 */
export const LOGIN_LINK_LIFETIME_MS = 120_000;
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const LAST_USED_PERSIST_INTERVAL_MS = 10 * 60 * 1000;
export const PLUGIN_LABEL = "Codex 插件";
export const BROWSERS_FILE = "console-browsers.json";

export type ConsoleActor = "login-link" | "local-command" | "codex-plugin" | "browser";

export type ConsoleBrowser = {
  id: string;
  label: string;
  authorizedAt: string;
  lastUsedAt: string;
  client?: "codex-plugin";
};

type StoredBrowser = ConsoleBrowser & { hash: string };

/** What the guard knows about an authorized request; fixture routes in fixture mode carry no browser. */
export type ConsoleRequestContext = { browser?: ConsoleBrowser };
export type ConsoleHandler = (req: IncomingMessage, res: ServerResponse, context: ConsoleRequestContext) => void | Promise<void>;
type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** A refusal whose message is meant for the owner, such as an unknown browser id. */
export class ConsoleAccessError extends Error {}

export function browserLabel(userAgent: string | undefined): string {
  const agent = userAgent ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(agent) ? "Edge"
    : /Firefox\/|FxiOS\//.test(agent) ? "Firefox"
      : /(Headless)?Chrome\/|CriOS\//.test(agent) ? "Chrome"
        : /Version\/[\d.]+.*Safari\//.test(agent) ? "Safari"
          : undefined;
  if (!browser) return "浏览器";
  const system = /iPhone|iPad/.test(agent) ? "iOS"
    : /Mac OS X|Macintosh/.test(agent) ? "macOS"
      : /Windows/.test(agent) ? "Windows"
        : /Android/.test(agent) ? "Android"
          : /Linux|X11/.test(agent) ? "Linux"
            : undefined;
  return system ? `${browser} · ${system}` : browser;
}

export function consoleCookieName(port: number): string {
  return `codex_console_${port}`;
}

function hashCookie(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) return [];
    return [part.slice(separator + 1).trim()];
  });
}

function sessionCookie(port: number, value: string, maxAge: number): string {
  return `${consoleCookieName(port)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function baseHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
}

function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  req.resume();
  baseHeaders(res);
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error }));
}

function sendLoginCard(req: IncomingMessage, res: ServerResponse, notice?: LoginCardNotice): void {
  req.resume();
  baseHeaders(res);
  res.setHeader("content-security-policy", LOGIN_CARD_CONTENT_SECURITY_POLICY);
  res.statusCode = 401;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.method === "HEAD" ? undefined : renderLoginCard(notice));
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : String(error);
}

function isStoredBrowser(value: unknown): value is StoredBrowser {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.hash === "string" && /^[0-9a-f]{64}$/.test(record.hash) &&
    typeof record.label === "string" && typeof record.authorizedAt === "string" && typeof record.lastUsedAt === "string" &&
    (record.client === undefined || record.client === "codex-plugin");
}

function publicBrowser(browser: StoredBrowser): ConsoleBrowser {
  return {
    id: browser.id,
    label: browser.label,
    authorizedAt: browser.authorizedAt,
    lastUsedAt: browser.lastUsedAt,
    ...(browser.client ? { client: browser.client } : {}),
  };
}

function browserRef(browser: StoredBrowser): { id: string; label: string } {
  return { id: browser.id, label: browser.label };
}

export class ConsoleAccess {
  private readonly now: () => number;
  private readonly directory?: string;
  private readonly audit: ConsoleAudit;
  private browsers: StoredBrowser[] = [];
  private readonly loginLinks = new Map<string, number>();
  private readonly sockets = new Map<string, Set<Socket>>();
  private lastPersistAt: number;
  private lastUsedChanged = false;

  /** Without a directory nothing can be authorized; the gate then refuses every protected request. */
  constructor(options: { directory?: string; now?: () => number; audit?: ConsoleAudit } = {}) {
    this.now = options.now ?? Date.now;
    if (options.directory !== undefined) this.directory = options.directory;
    this.audit = options.audit ?? new ConsoleAudit({ ...(options.directory !== undefined ? { directory: options.directory } : {}), now: this.now });
    this.lastPersistAt = this.now();
    this.browsers = this.loadStore();
  }

  issueLoginLink(port: number): { url: string; expiresAt: number } {
    this.requireDirectory();
    const now = this.now();
    for (const [token, expiresAt] of this.loginLinks) if (now > expiresAt) this.loginLinks.delete(token);
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = now + LOGIN_LINK_LIFETIME_MS;
    this.loginLinks.set(token, expiresAt);
    return { url: `http://127.0.0.1:${port}/login?t=${token}`, expiresAt };
  }

  listBrowsers(): ConsoleBrowser[] {
    return this.browsers.map(publicBrowser);
  }

  /**
   * Revokes one browser by id, or every browser with `all`, and closes their open connections at once. From the console's
   * 本机登录 drawer, `by` is `browser` and `actor` the browser that asked, which the audit names (agent-console::REQ-004).
   */
  revoke(target: string, by: ConsoleActor, actor?: ConsoleBrowser): { revoked: number; auditFailed: boolean } {
    const removed = target === "all" ? this.browsers : this.browsers.filter((browser) => browser.id === target);
    if (target !== "all" && removed.length === 0) throw new ConsoleAccessError("没有该浏览器");
    this.browsers = this.browsers.filter((browser) => !removed.includes(browser));
    for (const browser of removed) this.disconnect(browser.id);
    let storeError: unknown;
    try {
      this.saveStore();
    } catch (error) {
      storeError = error;
    }
    const auditFailed = removed.length > 0 && !this.audit.tryAppend({ by, ...(actor ? { browser: { id: actor.id, label: actor.label } } : {}), event: "browser_revoked",
      browsers: removed.map(browserRef) });
    if (storeError) {
      process.stderr.write(`console_browsers_write_failed: ${errorCode(storeError)}\n`);
      throw new ConsoleAccessError(`已收回 ${removed.length} 个浏览器的授权并断开连接，但授权文件写入失败，服务重启后会恢复；请检查状态目录后重试`);
    }
    return { revoked: removed.length, auditFailed };
  }

  /** The Codex plugin's credential: one 「Codex 插件」 entry, replaced on every call. Returns `name=value`. */
  authorizePlugin(port: number): { cookie: string } {
    this.requireDirectory();
    const replaced = this.browsers.filter((browser) => browser.client === "codex-plugin");
    const value = this.authorize({ label: PLUGIN_LABEL, client: "codex-plugin", by: "codex-plugin", replaced });
    return { cookie: `${consoleCookieName(port)}=${value}` };
  }

  /**
   * Wraps a request handler with the Host rule, the login exchange and browser authorization. The handler receives
   * the authorized browser, so that audited changes can name it (agent-console::REQ-004).
   */
  guard(handler: ConsoleHandler, options: { fixtureMode?: boolean } = {}): Handler {
    return async (req, res) => {
      try {
        const port = req.socket.localPort;
        const host = req.headers.host;
        if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
          refuse(req, res, 403, "拒绝非本机地址的请求");
          return;
        }
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname === "/login") {
          this.exchangeLoginLink(req, res, url, port);
          return;
        }
        // Fixture routes keep their current access in fixture mode; the handler still requires same-origin JSON.
        if (options.fixtureMode && url.pathname.startsWith("/api/fixture/")) {
          await handler(req, res, {});
          return;
        }
        const presented = cookieValues(req.headers.cookie, consoleCookieName(port));
        const match = this.findBrowser(presented);
        const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
        const isRead = req.method === "GET" || req.method === "HEAD";
        if (!match) {
          if (!isApi && isRead) {
            if (presented.length > 0) res.setHeader("set-cookie", sessionCookie(port, "", 0));
            sendLoginCard(req, res, presented.length > 0 ? "revoked" : undefined);
          } else {
            refuse(req, res, 401, "需要本机授权");
          }
          return;
        }
        if (!isRead && req.headers.origin !== `http://${host}`) {
          refuse(req, res, 403, "拒绝跨来源写请求");
          return;
        }
        this.track(match.browser.id, req.socket);
        this.touch(match.browser);
        if (!isApi && req.method === "GET") res.setHeader("set-cookie", sessionCookie(port, match.value, COOKIE_MAX_AGE_SECONDS));
        await handler(req, res, { browser: publicBrowser(match.browser) });
      } catch (error) {
        process.stderr.write(`console_access_failed: ${errorCode(error)}\n`);
        if (!res.headersSent) refuse(req, res, 500, "请求失败");
        else res.destroy();
      }
    };
  }

  /** Persists the latest use times; called when the service stops. */
  close(): void {
    if (!this.lastUsedChanged) return;
    try {
      this.saveStore();
    } catch (error) {
      process.stderr.write(`console_browsers_write_failed: ${errorCode(error)}\n`);
    }
  }

  private exchangeLoginLink(req: IncomingMessage, res: ServerResponse, url: URL, port: number): void {
    if (req.method !== "GET") {
      refuse(req, res, 404, "未找到");
      return;
    }
    const token = url.searchParams.get("t") ?? "";
    const expiresAt = this.loginLinks.get(token);
    this.loginLinks.delete(token);
    if (expiresAt === undefined || this.now() > expiresAt) {
      sendLoginCard(req, res, "expired");
      return;
    }
    const current = this.findBrowser(cookieValues(req.headers.cookie, consoleCookieName(port)));
    let value: string;
    try {
      value = this.authorize({
        label: browserLabel(req.headers["user-agent"]),
        by: "login-link",
        replaced: current ? [current.browser] : [],
      });
    } catch (error) {
      process.stderr.write(`console_authorization_failed: ${errorCode(error)}\n`);
      refuse(req, res, 500, "本机授权未能保存，请检查状态目录后重新运行登录命令");
      return;
    }
    baseHeaders(res);
    res.statusCode = 302;
    res.setHeader("location", "/");
    res.setHeader("set-cookie", sessionCookie(port, value, COOKIE_MAX_AGE_SECONDS));
    res.end();
  }

  private authorize(input: {
    label: string;
    client?: "codex-plugin";
    by: ConsoleActor;
    replaced: StoredBrowser[];
  }): string {
    const value = crypto.randomBytes(32).toString("hex");
    const at = new Date(this.now()).toISOString();
    const browser: StoredBrowser = {
      id: this.newBrowserId(),
      hash: hashCookie(value),
      label: input.label,
      authorizedAt: at,
      lastUsedAt: at,
      ...(input.client ? { client: input.client } : {}),
    };
    const previous = this.browsers;
    this.browsers = [...previous.filter((item) => !input.replaced.includes(item)), browser];
    try {
      this.saveStore();
    } catch (error) {
      this.browsers = previous;
      throw error;
    }
    try {
      this.audit.append({
        by: input.by,
        event: "browser_authorized",
        browser: browserRef(browser),
        ...(input.replaced.length > 0 ? { replaced: input.replaced.map((item) => item.id) } : {}),
      });
    } catch (error) {
      this.browsers = previous;
      try {
        this.saveStore();
      } catch {
        // The new cookie was never handed out, so a stored hash for it authorizes nobody.
      }
      throw error;
    }
    // A replaced credential is refused on its next request; only revocation closes open connections, so a
    // browser logging in again keeps its other tabs' requests in flight.
    return value;
  }

  private findBrowser(values: string[]): { browser: StoredBrowser; value: string } | undefined {
    for (const value of values) {
      if (!/^[0-9a-f]{64}$/.test(value)) continue;
      const hash = hashCookie(value);
      const browser = this.browsers.find((item) => item.hash === hash);
      if (browser) return { browser, value };
    }
    return undefined;
  }

  private newBrowserId(): string {
    for (;;) {
      const id = crypto.randomBytes(4).toString("hex");
      if (!this.browsers.some((browser) => browser.id === id)) return id;
    }
  }

  private track(id: string, socket: Socket): void {
    let sockets = this.sockets.get(id);
    if (!sockets) {
      sockets = new Set();
      this.sockets.set(id, sockets);
    }
    if (sockets.has(socket)) return;
    sockets.add(socket);
    const owned = sockets;
    socket.once("close", () => {
      owned.delete(socket);
      if (owned.size === 0 && this.sockets.get(id) === owned) this.sockets.delete(id);
    });
  }

  private disconnect(id: string): void {
    const sockets = this.sockets.get(id);
    this.sockets.delete(id);
    for (const socket of sockets ?? []) socket.destroy();
  }

  private touch(browser: StoredBrowser): void {
    const now = this.now();
    browser.lastUsedAt = new Date(now).toISOString();
    this.lastUsedChanged = true;
    if (now - this.lastPersistAt < LAST_USED_PERSIST_INTERVAL_MS) return;
    try {
      this.saveStore();
    } catch (error) {
      process.stderr.write(`console_browsers_write_failed: ${errorCode(error)}\n`);
    }
  }

  private requireDirectory(): string {
    if (this.directory === undefined) throw new ConsoleAccessError("本机授权没有状态目录");
    return this.directory;
  }

  private loadStore(): StoredBrowser[] {
    if (this.directory === undefined) return [];
    const file = path.join(this.directory, BROWSERS_FILE);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") process.stderr.write(`console_browsers_unreadable: ${errorCode(error)}\n`);
      return [];
    }
    try {
      const value = JSON.parse(text) as { browsers?: unknown };
      if (!Array.isArray(value.browsers)) throw new Error("invalid");
      return value.browsers.filter(isStoredBrowser).map((browser) => ({ ...browser }));
    } catch {
      process.stderr.write("console_browsers_unreadable: invalid_format\n");
      return [];
    }
  }

  private saveStore(): void {
    const directory = this.requireDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, BROWSERS_FILE);
    const temporaryPath = path.join(directory, `.console-browsers-${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, browsers: this.browsers }), "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not exist or may already be renamed.
      }
      throw error;
    }
    this.lastPersistAt = this.now();
    this.lastUsedChanged = false;
  }
}
