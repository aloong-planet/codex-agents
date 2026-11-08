// The MCP Catalog at its public interface, against real local programs over stdio (docs/specs/mcp-catalog.md,
// Testing Decisions "Connection manager"). Every case starts its own test server, because starting, failing,
// retrying and restarting it is the behaviour under test.
//
// Coverage gaps:
// - The sandbox cases run only on macOS (CI runs on macos-15). The sandbox's network filter is checked only
//   through the generated rules in mcp-catalog-rules.test.ts, because a real check needs outbound network.
// - The npx case runs a local, dependency-free package packed into a tarball, so npx downloads nothing but unpacks
//   it into the server's own cache as it would a registry package. A package fetched from the npm registry with
//   registry.npmjs.org allowed is not driven: running third-party registry code is not permitted in this test
//   environment. It needs a manual check with network access.
// - The child-environment case can show only the absence of keys the parent environment held; it plants four.
// - URL servers run against local HTTP test servers (fixtures/mcp-http-test-server.ts) on loopback http, which the
//   rules allow; TLS and real third-party OAuth providers are not driven. DPoP proofs are checked by the test server's
//   own verifier (self-checked in fixtures/mcp-http-test-server.test.ts), not by a production authorization server.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import { McpCallRefused, McpCatalog, type McpServerInput } from "../src/mcp-catalog.js";
import { freePort, startAuthorizationServer, startHttpTestServer, type AuthorizationServer, type HttpTestServerOptions } from "./fixtures/mcp-http-test-server.js";
import { CLIENT_SECRET_SENTINEL, HEADER_SENTINEL, SECRET_SENTINEL, isAlive, starts, testServerArgs, testServerFiles, writeTools, type TestServerFiles } from "./fixtures/mcp-test-server-control.js";

const LOCAL_NPX_PACKAGE = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "mcp-local-npx-package");

const BROWSER = { id: "b1", label: "Chrome · macOS", authorizedAt: "2026-11-08T00:00:00.000Z", lastUsedAt: "2026-11-08T00:00:00.000Z" };
const actor = { browser: BROWSER };
const WAIT = { timeout: 10_000, interval: 50 };

const LOOKUP = { name: "lookup", title: "Lookup", description: "Finds an item.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, annotations: { readOnlyHint: true } };
const OTHER = { name: "other", description: "Does another thing.", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "string" } } } };
const NEEDS_PERSON = { name: "pay", description: "Confirms a payment.", inputSchema: { type: "object" }, _meta: { "anthropic/requiresUserInteraction": true } };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setup(options: { retryMs?: number; refreshMs?: number } = {}) {
  const work = temporary("mcp-catalog-work-");
  const state = path.join(work, "state");
  const home = path.join(work, "home");
  fs.mkdirSync(home);
  const parentEnv = { ...process.env, OPENAI_API_KEY: "sk-model-sentinel", CODEX_API_KEY: "codex-sentinel", CODEX_HOME: "/codex-home-sentinel", FEISHU_APP_SECRET: "feishu-sentinel" };
  const open = () => {
    const catalog = new McpCatalog({ stateDirectory: state, homeDirectory: home, env: parentEnv, audit: new ConsoleAudit({ directory: state }), retryMs: options.retryMs ?? 100, refreshMs: options.refreshMs ?? 0 });
    cleanup.push(() => catalog.close());
    return catalog;
  };
  return { work, state, home, open };
}

function input(name: string, files: TestServerFiles, extra: Partial<McpServerInput> & { listChanged?: boolean } = {}): McpServerInput {
  const { listChanged, ...rest } = extra;
  return { name, command: process.execPath, args: testServerArgs(files, listChanged === false ? { listChanged } : {}), env: { SECRET_TOKEN: SECRET_SENTINEL }, ...rest };
}

/** Registers with the line the confirmation card shows, as the page does. */
function register(catalog: McpCatalog, server: McpServerInput) {
  return catalog.register(server, { confirmed: catalog.preview(server).launchLine, actor });
}

async function connected(catalog: McpCatalog, name: string) {
  await vi.waitFor(() => expect(catalog.viewServer(name).state).toBe("connected"), WAIT);
  return catalog.viewServer(name);
}

async function callJson(catalog: McpCatalog, tool: string) {
  const result = await catalog.call(tool, {});
  return JSON.parse(result.text);
}

describe("registration", () => {
  it("registers nothing until the exact launch line is confirmed", async () => {
    const { work, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    writeTools(files.tools, [LOOKUP]);
    const server = input("local", files);

    expect(catalog.preview(server)).toEqual({
      launchLine: [process.execPath, ...testServerArgs(files)].join(" "),
      needsConfirmation: true,
    });
    expect(() => catalog.register(server, { confirmed: `${process.execPath} other.mjs`, actor }))
      .toThrow("请先确认将要运行的命令：确认卡片上的命令与当前填写的不一致");
    expect(catalog.view()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts(files)).toEqual([]);

    register(catalog, server);
    const view = await connected(catalog, "local");
    expect(starts(files)).toHaveLength(1);
    expect(view).toMatchObject({ name: "local", server: { name: "catalog-test-server", version: "1.4.2" }, counts: { total: 5, usable: 5, pending: 0 } });
    expect(view.protocol).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(view.connectedAt ?? "")).not.toBeNaN();
  });

  it("server names are unique and fixed after creation", async () => {
    const { work, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    register(catalog, input("fixed", files));

    expect(() => register(catalog, input("fixed", files))).toThrow("已有名为 fixed 的 MCP 服务器");
    expect(() => catalog.update("fixed", { ...input("renamed", files) }, { actor })).toThrow("名称创建后不可修改");
    expect(catalog.view().map((server) => server.name)).toEqual(["fixed"]);
  });
});

describe("connections held by the host", () => {
  it("a local program gets its own environment and the home directory, never model keys", async () => {
    const { work, home, open } = setup();
    const catalog = open();
    register(catalog, input("envcheck", testServerFiles(work)));
    await connected(catalog, "envcheck");

    const { env, cwd } = await callJson(catalog, "mcp__envcheck__env");
    expect(env.SECRET_TOKEN).toBe(SECRET_SENTINEL);
    expect(env.PATH).toBe(process.env.PATH);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "FEISHU_APP_SECRET"]) expect(env).not.toHaveProperty(key);
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(home));
  });

  it("a failing program shows its masked error and the next retry", async () => {
    const { work, open } = setup({ retryMs: 60_000 });
    const catalog = open();
    const files = testServerFiles(work);
    fs.writeFileSync(files.failFlag, "");
    const before = Date.now();
    register(catalog, input("broken", files));

    await vi.waitFor(() => expect(catalog.viewServer("broken").state).toBe("failed"), WAIT);
    const view = catalog.viewServer("broken");
    expect(view.output).toContain("fatal: could not authenticate with ***");
    expect(view.error).toContain("***");
    expect(JSON.stringify(view)).not.toContain(SECRET_SENTINEL);
    expect(Date.parse(view.retryAt ?? "")).toBeGreaterThan(before + 59_000);
    expect(view.retries).toBe(1);
  });

  it("retries a failed program automatically", async () => {
    const { work, open } = setup({ retryMs: 100 });
    const catalog = open();
    const files = testServerFiles(work);
    fs.writeFileSync(files.failFlag, "");
    register(catalog, input("flaky", files));
    await vi.waitFor(() => expect(catalog.viewServer("flaky").state).toBe("failed"), WAIT);

    fs.rmSync(files.failFlag);
    await connected(catalog, "flaky");
    expect(starts(files).length).toBeGreaterThanOrEqual(2);
  });
});

describe("reviewing tools", () => {
  it("a new or changed tool waits for review until confirmed", async () => {
    const { work, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    writeTools(files.tools, [LOOKUP, OTHER]);
    register(catalog, input("review", files));
    expect((await connected(catalog, "review")).counts).toEqual({ total: 6, usable: 6, pending: 0 });

    const shuffledOther = { inputSchema: { properties: { b: { type: "string" }, a: { type: "integer" } }, type: "object" }, description: OTHER.description, name: OTHER.name };
    writeTools(files.tools, [{ ...LOOKUP, description: "Finds an item by name." }, shuffledOther, { name: "fresh", description: "New.", inputSchema: { type: "object" } }]);
    await vi.waitFor(() => expect(catalog.viewServer("review").tools.map((tool) => tool.name)).toContain("fresh"), WAIT);

    const tools = Object.fromEntries(catalog.viewServer("review").tools.map((tool) => [tool.name, tool]));
    expect(tools.fresh).toMatchObject({ pending: "new", usable: false });
    expect(tools.lookup).toMatchObject({ pending: "changed", changed: ["text"], was: "Finds an item.", usable: false });
    expect(tools.other).toMatchObject({ usable: true });
    expect(tools.other).not.toHaveProperty("pending");
    expect(catalog.toolsFor().map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["mcp__review__fresh"]));
    expect(catalog.toolsFor().map((tool) => tool.name)).not.toContain("mcp__review__lookup");
    await expect(catalog.call("mcp__review__lookup", { q: "x" })).rejects.toThrow("该工具的定义有变化，等待复核");

    catalog.approve("review", ["fresh"], actor);
    expect(catalog.toolsFor().map((tool) => tool.name)).toContain("mcp__review__fresh");
    expect(catalog.toolsFor().map((tool) => tool.name)).not.toContain("mcp__review__lookup");
    catalog.approve("review", undefined, actor);
    expect(catalog.viewServer("review").counts).toEqual({ total: 7, usable: 7, pending: 0 });
    expect(() => catalog.approve("review", undefined, actor)).toThrow("review 没有待复核的工具");
  });

  it("refreshes a server that sends no list changes", async () => {
    const { work, open } = setup({ refreshMs: 100 });
    const catalog = open();
    const files = testServerFiles(work);
    writeTools(files.tools, [LOOKUP]);
    register(catalog, input("quiet", files, { listChanged: false }));
    expect((await connected(catalog, "quiet")).tools.map((tool) => tool.name)).not.toContain("fresh");

    writeTools(files.tools, [LOOKUP, { name: "fresh", description: "New.", inputSchema: { type: "object" } }]);
    await vi.waitFor(() => expect(catalog.viewServer("quiet").tools.find((tool) => tool.name === "fresh")).toMatchObject({ pending: "new" }), WAIT);
  });

  it("never provides a tool that needs a person", async () => {
    const { work, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    writeTools(files.tools, [NEEDS_PERSON]);
    register(catalog, input("person", files));
    await connected(catalog, "person");

    expect(catalog.viewServer("person").tools.find((tool) => tool.name === "pay")).toMatchObject({ needsUser: true, usable: false });
    expect(catalog.toolsFor().map((tool) => tool.name)).not.toContain("mcp__person__pay");
    await expect(catalog.call("mcp__person__pay", {})).rejects.toThrow("服务器要求每次调用都由人确认，不提供这类工具");

    writeTools(files.tools, [NEEDS_PERSON, { ...NEEDS_PERSON, name: "refund" }]);
    await vi.waitFor(() => expect(catalog.viewServer("person").tools.map((tool) => tool.name)).toContain("refund"), WAIT);
    catalog.approve("person", undefined, actor);
    expect(catalog.viewServer("person").tools.find((tool) => tool.name === "refund")).toMatchObject({ needsUser: true, usable: false });
    await expect(catalog.call("mcp__person__refund", {})).rejects.toThrow("服务器要求每次调用都由人确认，不提供这类工具");
  });

  it("a disabled tool or server is refused at the next call", async () => {
    const { work, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    const server = input("switch", files);
    register(catalog, server);
    await connected(catalog, "switch");
    expect((await callJson(catalog, "mcp__switch__whoami")).pid).toBe(starts(files)[0]?.pid);

    catalog.setToolEnabled("switch", "whoami", false, actor);
    expect(catalog.toolsFor().map((tool) => tool.name)).not.toContain("mcp__switch__whoami");
    await expect(catalog.call("mcp__switch__whoami", {})).rejects.toThrow(McpCallRefused);
    await expect(catalog.call("mcp__switch__whoami", {})).rejects.toThrow("该工具已停用");
    expect(JSON.parse((await catalog.call("mcp__switch__env", {})).text).cwd).toBeTruthy();

    catalog.update("switch", { ...server, enabled: false }, { actor });
    await expect(catalog.call("mcp__switch__env", {})).rejects.toThrow("MCP 服务器 switch 已停用");
    expect(catalog.viewServer("switch").state).toBe("disabled");
    const pid = starts(files)[0]!.pid;
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), WAIT);
  });
});

describe("changes and deletion", () => {
  it("a confirmed command change applies after reconnecting, and changed tools wait for review", async () => {
    const { work, open } = setup();
    const catalog = open();
    const first = testServerFiles(work, "first");
    const second = testServerFiles(work, "second");
    writeTools(first.tools, [LOOKUP]);
    writeTools(second.tools, [{ ...LOOKUP, inputSchema: { type: "object", properties: { query: { type: "string" } } } }]);
    const server = input("moving", first);
    register(catalog, server);
    await connected(catalog, "moving");
    const before = await callJson(catalog, "mcp__moving__whoami");

    const moved = { ...server, args: testServerArgs(second) };
    expect(catalog.preview(moved, "moving")).toEqual({ launchLine: [process.execPath, ...testServerArgs(second)].join(" "), needsConfirmation: true });
    expect(() => catalog.update("moving", moved, { actor })).toThrow("请先确认将要运行的命令");
    expect((await callJson(catalog, "mcp__moving__whoami")).argv).toEqual(before.argv);

    catalog.update("moving", moved, { confirmed: catalog.preview(moved, "moving").launchLine, actor });
    await vi.waitFor(async () => expect((await callJson(catalog, "mcp__moving__whoami")).pid).not.toBe(before.pid), WAIT);
    expect((await callJson(catalog, "mcp__moving__whoami")).argv).toEqual(testServerArgs(second).slice(1));
    expect(catalog.viewServer("moving").tools.find((tool) => tool.name === "lookup")).toMatchObject({ pending: "changed", changed: ["schema"] });
    expect(catalog.viewServer("moving").tools.find((tool) => tool.name === "env")).toMatchObject({ usable: true });
  });

  it("an unchanged secret field keeps its value", async () => {
    const { work, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    const server = input("keeper", files);
    register(catalog, server);
    await connected(catalog, "keeper");
    const elsewhere = temporary("mcp-catalog-cwd-");

    catalog.update("keeper", { ...server, env: { SECRET_TOKEN: "••••••" }, cwd: elsewhere, timeout: 90 }, { actor });
    await vi.waitFor(async () => expect(fs.realpathSync((await callJson(catalog, "mcp__keeper__env")).cwd)).toBe(fs.realpathSync(elsewhere)), WAIT);
    expect((await callJson(catalog, "mcp__keeper__env")).env.SECRET_TOKEN).toBe(SECRET_SENTINEL);
  });

  it("deleting an unattached server stops it and removes its secrets", async () => {
    const { work, state, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    register(catalog, input("gone", files));
    await connected(catalog, "gone");
    const stateText = () => fs.readdirSync(state).map((file) => fs.readFileSync(path.join(state, file), "utf8")).join("\n");
    expect(stateText()).toContain(SECRET_SENTINEL);

    await catalog.remove("gone", actor);
    await vi.waitFor(() => expect(isAlive(starts(files)[0]!.pid)).toBe(false), WAIT);
    expect(catalog.view()).toEqual([]);
    expect(stateText()).not.toContain(SECRET_SENTINEL);
  });

  it("after a restart enabled servers reconnect and reviews persist", async () => {
    const { work, open } = setup();
    const first = open();
    const kept = testServerFiles(work, "kept");
    const off = testServerFiles(work, "off");
    writeTools(kept.tools, [LOOKUP, OTHER]);
    register(first, input("kept", kept));
    const offServer = input("off", off);
    register(first, offServer);
    await connected(first, "kept");
    await connected(first, "off");
    writeTools(kept.tools, [{ ...LOOKUP, description: "Finds an item by name." }, OTHER]);
    await vi.waitFor(() => expect(first.viewServer("kept").counts.pending).toBe(1), WAIT);
    first.approve("kept", ["lookup"], actor);
    first.setToolEnabled("kept", "other", false, actor);
    first.update("off", { ...offServer, enabled: false }, { actor });
    await first.close();
    const offStarts = starts(off).length;
    writeTools(kept.tools, [{ ...LOOKUP, description: "Finds an item by name." }, { ...OTHER, description: "Does something else." }]);

    const second = open();
    second.start();
    const view = await connected(second, "kept");
    const tools = Object.fromEntries(view.tools.map((tool) => [tool.name, tool]));
    expect(tools.lookup).toMatchObject({ usable: true });
    expect(tools.lookup).not.toHaveProperty("pending");
    expect(tools.other).toMatchObject({ enabled: false, pending: "changed" });
    expect(second.viewServer("off").state).toBe("disabled");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts(off)).toHaveLength(offStarts);
  });

  it("every saved change is audited without secret values", async () => {
    const { work, state, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    writeTools(files.tools, [LOOKUP]);
    const server = input("audited", files);
    expect(() => catalog.register({ ...server, timeout: 0 }, { confirmed: "x", actor })).toThrow("超时应为 1–600 的整数（秒）");
    register(catalog, server);
    await connected(catalog, "audited");
    catalog.update("audited", { ...server, env: { SECRET_TOKEN: "another-secret-value" }, trusted: true }, { actor });
    catalog.setToolEnabled("audited", "lookup", false, actor);
    writeTools(files.tools, [{ ...LOOKUP, description: "Changed." }]);
    await vi.waitFor(() => expect(catalog.viewServer("audited").counts.pending).toBe(1), WAIT);
    catalog.approve("audited", undefined, actor);
    await catalog.remove("audited", actor);

    const text = fs.readFileSync(path.join(state, AUDIT_FILE), "utf8");
    const entries = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.event)).toEqual(["mcp_server_added", "mcp_server_changed", "mcp_tool_disabled", "mcp_tools_confirmed", "mcp_server_deleted"]);
    for (const entry of entries) expect(entry).toMatchObject({ by: "browser", browser: { id: "b1", label: "Chrome · macOS" }, server: "audited" });
    expect(entries[0]).toMatchObject({ envNames: ["SECRET_TOKEN"], launchLine: [process.execPath, ...testServerArgs(files)].join(" ") });
    expect(entries[1]).toMatchObject({ changed: ["trusted", "env"], envNames: ["SECRET_TOKEN"] });
    expect(entries[2]).toMatchObject({ tool: "lookup" });
    expect(entries[3]).toMatchObject({ tools: ["lookup"] });
    expect(text).not.toContain(SECRET_SENTINEL);
    expect(text).not.toContain("another-secret-value");
  });
});

describe.skipIf(process.platform !== "darwin")("sandbox (macOS)", () => {
  it("a sandboxed program reads and writes only what it is allowed", async () => {
    const { work, home, open } = setup();
    const catalog = open();
    const readable = temporary("mcp-sandbox-read-");
    const writable = temporary("mcp-sandbox-write-");
    fs.writeFileSync(path.join(readable, "in.txt"), "readable content");
    fs.writeFileSync(path.join(home, "private.txt"), "home content");
    // A file named as an argument is readable by itself; its directory and siblings are not.
    fs.mkdirSync(path.join(home, "notes"));
    fs.writeFileSync(path.join(home, "notes", "named.txt"), "named content");
    fs.writeFileSync(path.join(home, "notes", "sibling.txt"), "sibling content");
    const files = testServerFiles(work);
    register(catalog, input("boxed", files, { args: [...testServerArgs(files), "--named", path.join(home, "notes", "named.txt")], sandbox: { domains: [], read: [readable], write: [writable] } }));
    await connected(catalog, "boxed");

    const call = (tool: string, args: Record<string, unknown>) => catalog.call(`mcp__boxed__${tool}`, args);
    expect(await call("read_file", { path: path.join(readable, "in.txt") })).toEqual({ text: "readable content", isError: false });
    expect(await call("write_file", { path: path.join(writable, "out.txt"), text: "ok" })).toEqual({ text: "written", isError: false });
    expect(fs.readFileSync(path.join(writable, "out.txt"), "utf8")).toBe("ok");
    expect(await call("read_file", { path: path.join(home, "private.txt") })).toMatchObject({ isError: true, text: expect.stringMatching(/^EPERM/) });
    expect(await call("read_file", { path: path.join(home, "notes", "named.txt") })).toEqual({ text: "named content", isError: false });
    expect(await call("read_file", { path: path.join(home, "notes", "sibling.txt") })).toMatchObject({ isError: true, text: expect.stringMatching(/^EPERM/) });
    expect(await call("write_file", { path: path.join(readable, "new.txt"), text: "no" })).toMatchObject({ isError: true, text: expect.stringMatching(/^EPERM/) });
    expect(fs.existsSync(path.join(readable, "new.txt"))).toBe(false);
  });

  it("an npx server starts with the server's own npm cache, whatever the owner entered", async () => {
    const { work, home, open } = setup();
    const catalog = open();
    const ownerCache = path.join(work, "owner-npm-cache");
    const packed = temporary("mcp-npx-pack-");
    const npm = path.join(path.dirname(process.execPath), "npm");
    const tarball = path.join(packed, execFileSync(npm, ["pack", LOCAL_NPX_PACKAGE, "--pack-destination", packed, "--cache", path.join(packed, "cache")], { encoding: "utf8" }).trim().split("\n").at(-1)!);
    const server = { name: "npxbox", command: "npx", args: ["-y", `--package=${tarball}`, "mcp-local-npx-test-server"], env: { npm_config_cache: ownerCache }, sandbox: { domains: [], read: [], write: [] } };
    register(catalog, server);
    // The whole view is compared, so that a failure shows npm's error and output.
    await vi.waitFor(() => expect(catalog.viewServer("npxbox")).toMatchObject({ state: "connected" }), { timeout: 60_000, interval: 200 });

    const own = path.join(home, "Library", "Caches", "codex-weixin", "mcp", "npxbox");
    expect(JSON.parse((await catalog.call("mcp__npxbox__npm_settings", {})).text)).toEqual({ cache: path.join(own, "npm"), userconfig: path.join(own, "npmrc") });
    expect(fs.readdirSync(path.join(own, "npm")).length).toBeGreaterThan(0);
    expect(fs.statSync(own).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(own, "npmrc"), "utf8")).toBe("");
    expect(fs.existsSync(ownerCache)).toBe(false);

    await catalog.remove("npxbox", actor);
    expect(fs.existsSync(own)).toBe(false);
  }, 90_000);
});

async function httpServer(options: HttpTestServerOptions = {}) {
  const server = await startHttpTestServer(options);
  cleanup.push(server.close);
  return server;
}

async function authorizationServer(options: { dpop?: boolean } = {}): Promise<AuthorizationServer> {
  const as = await startAuthorizationServer({ clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL, ...options });
  cleanup.push(as.close);
  return as;
}

const stateText = (state: string) => fs.readdirSync(state).filter((file) => fs.statSync(path.join(state, file)).isFile()).map((file) => fs.readFileSync(path.join(state, file), "utf8")).join("\n");

describe("URL servers", () => {
  it("a URL server sends its headers on every request and masks their values in errors", async () => {
    const { open } = setup({ retryMs: 60_000 });
    const catalog = open();
    const server = await httpServer({ requireHeaders: { "X-Api-Key": HEADER_SENTINEL } });
    const refusing = await httpServer({ echoHeaders: ["X-Api-Key"] });

    register(catalog, { name: "remote", transport: "http", url: server.url, headers: { "X-Api-Key": HEADER_SENTINEL } });
    register(catalog, { name: "refused", transport: "http", url: refusing.url, headers: { "X-Api-Key": HEADER_SENTINEL } });
    expect((await connected(catalog, "remote")).server).toEqual({ name: "catalog-http-test-server", version: "2.0.1" });
    expect(await callJson(catalog, "mcp__remote__whoami")).toEqual({ scheme: "none", scope: null, headers: ["X-Api-Key"] });
    const seen = server.requests.map((request) => request.headers["X-Api-Key"]);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen)).toEqual(new Set([HEADER_SENTINEL]));

    await vi.waitFor(() => expect(catalog.viewServer("refused").state).toBe("failed"), WAIT);
    expect(refusing.forbiddenBodies.join("\n")).toContain(HEADER_SENTINEL);
    const view = catalog.viewServer("refused");
    expect(view.error).toContain("X-Api-Key=***");
    expect(JSON.stringify(view)).not.toContain(HEADER_SENTINEL);
  });

  it("OAuth client_credentials gets a token from the configured issuer and presents it", async () => {
    const { open } = setup();
    const catalog = open();
    const as = await authorizationServer();
    const server = await httpServer({ authorizationServer: as });

    register(catalog, { name: "docs", transport: "http", url: server.url, oauth: { issuer: as.issuer, clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL, scope: "docs:read" } });
    await connected(catalog, "docs");
    expect(await callJson(catalog, "mcp__docs__whoami")).toEqual({ scheme: "Bearer", scope: "docs:read", headers: [] });
    expect(as.tokenRequests).toEqual([{ clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL, scope: "docs:read", dpop: false, granted: true }]);
    const presented = server.requests.filter((request) => request.scheme !== "refused");
    expect(presented.length).toBeGreaterThanOrEqual(2);
    for (const request of presented) expect(request).toMatchObject({ scheme: "Bearer", token: as.issued[0]!.token });
  });

  it("with DPoP the token is bound to the proof key and presented as DPoP", async () => {
    const { open } = setup();
    const catalog = open();
    const as = await authorizationServer({ dpop: true });
    const server = await httpServer({ authorizationServer: as });

    register(catalog, { name: "bound", transport: "http", url: server.url, oauth: { issuer: as.issuer, clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL }, dpop: true });
    await connected(catalog, "bound");
    expect(await callJson(catalog, "mcp__bound__whoami")).toMatchObject({ scheme: "DPoP" });
    expect(as.tokenRequests).toMatchObject([{ dpop: true, granted: true }]);
    expect(as.issued).toMatchObject([{ type: "DPoP", jkt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }]);
    const presented = server.requests.filter((request) => request.scheme !== "refused");
    expect(presented.length).toBeGreaterThanOrEqual(2);
    for (const request of presented) expect(request).toMatchObject({ scheme: "DPoP", token: as.issued[0]!.token });
  });

  it("the client secret goes only to the configured issuer", async () => {
    const { open } = setup({ retryMs: 60_000 });
    const catalog = open();
    const configured = await authorizationServer();
    const decoy = await authorizationServer();
    const server = await httpServer({ authorizationServer: configured, advertiseIssuer: decoy.issuer });

    register(catalog, { name: "misled", transport: "http", url: server.url, oauth: { issuer: configured.issuer, clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL } });
    await vi.waitFor(() => expect(catalog.viewServer("misled").state).toBe("failed"), WAIT);
    expect(catalog.viewServer("misled").error).toBeTruthy();
    expect(decoy.tokenRequests).toEqual([]);
    expect(configured.tokenRequests).toEqual([]);
  });

  it("an unreachable URL fails and is retried until it answers", async () => {
    const { open } = setup({ retryMs: 200 });
    const catalog = open();
    const port = await freePort();

    register(catalog, { name: "later", transport: "http", url: `http://127.0.0.1:${port}/mcp` });
    await vi.waitFor(() => expect(catalog.viewServer("later")).toMatchObject({ state: "failed", retryAt: expect.any(String) }), WAIT);
    await httpServer({ port });
    await connected(catalog, "later");
  });

  it("changing transport or URL needs confirmation, and the other transport's secrets leave the disk", async () => {
    const { work, state, open } = setup();
    const catalog = open();
    const files = testServerFiles(work);
    const first = await httpServer({ requireHeaders: { "X-Api-Key": HEADER_SENTINEL } });
    const second = await httpServer({ requireHeaders: { "X-Api-Key": HEADER_SENTINEL } });
    register(catalog, input("moving", files));
    await connected(catalog, "moving");
    const pid = starts(files)[0]!.pid;

    const toUrl = { name: "moving", transport: "http", url: first.url, headers: { "X-Api-Key": HEADER_SENTINEL } };
    expect(catalog.preview(toUrl, "moving")).toEqual({ launchLine: first.url, needsConfirmation: true });
    expect(() => catalog.update("moving", toUrl, { actor })).toThrow("请先确认将要连接的地址：确认卡片上的地址与当前填写的不一致");
    expect((await callJson(catalog, "mcp__moving__whoami")).pid).toBe(pid);

    catalog.update("moving", toUrl, { confirmed: first.url, actor });
    await vi.waitFor(() => expect(catalog.viewServer("moving").server?.name).toBe("catalog-http-test-server"), WAIT);
    // The URL server's whoami differs from the program's, and lookup is new: both wait for review (REQ-002).
    expect(Object.fromEntries(catalog.viewServer("moving").tools.map((tool) => [tool.name, tool.pending]))).toEqual({ whoami: "changed", lookup: "new" });
    catalog.approve("moving", undefined, actor);
    expect(await callJson(catalog, "mcp__moving__whoami")).toMatchObject({ scheme: "none" });
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), WAIT);
    expect(stateText(state)).toContain(HEADER_SENTINEL);
    expect(stateText(state)).not.toContain(SECRET_SENTINEL);

    const kept = { ...toUrl, headers: { "X-Api-Key": "••••••" }, timeout: 90 };
    expect(catalog.preview(kept, "moving").needsConfirmation).toBe(false);
    catalog.update("moving", kept, { actor });
    expect(catalog.viewServer("moving")).toMatchObject({ headers: { "X-Api-Key": "••••••" }, timeout: 90 });

    const moved = { ...kept, url: second.url };
    expect(() => catalog.update("moving", moved, { actor })).toThrow("请先确认将要连接的地址");
    catalog.update("moving", moved, { confirmed: second.url, actor });
    await vi.waitFor(() => expect(second.requests.length).toBeGreaterThan(0), WAIT);
    await connected(catalog, "moving");
    expect(new Set(second.requests.map((request) => request.headers["X-Api-Key"]))).toEqual(new Set([HEADER_SENTINEL]));
  }, 20_000);

  it("after a restart a URL server reconnects with a new token, and no token is stored", async () => {
    const { state, open } = setup();
    const as = await authorizationServer();
    const server = await httpServer({ authorizationServer: as });
    const first = open();
    register(first, { name: "kept", transport: "http", url: server.url, oauth: { issuer: as.issuer, clientId: "agent-console", clientSecret: CLIENT_SECRET_SENTINEL } });
    await connected(first, "kept");
    await first.close();

    const second = open();
    second.start();
    await connected(second, "kept");
    expect(as.issued).toHaveLength(2);
    const text = stateText(state);
    for (const issued of as.issued) expect(text).not.toContain(issued.token);
    expect(fs.readFileSync(path.join(state, "mcp-secrets.json"), "utf8")).toContain(CLIENT_SECRET_SENTINEL);
    expect(fs.readFileSync(path.join(state, "mcp-catalog.json"), "utf8")).not.toContain(CLIENT_SECRET_SENTINEL);
  });
});

describe("importing from JSON", () => {
  it("importing registers exactly the confirmed servers, untrusted and unattached", async () => {
    const { work, state, open } = setup();
    const catalog = open();
    const local = testServerFiles(work, "local");
    const off = testServerFiles(work, "off");
    const remote = await httpServer();
    register(catalog, input("taken", testServerFiles(work, "taken")));
    // Claude Code's shapes: an explicit stdio type with an env object, an http type with headers; Cursor's sse entry.
    const document = JSON.stringify({
      mcpServers: {
        local: { type: "stdio", command: process.execPath, args: testServerArgs(local), env: { SECRET_TOKEN: SECRET_SENTINEL } },
        remote: { type: "http", url: remote.url, headers: { "X-Api-Key": "${input:key}", "X-Trace": HEADER_SENTINEL } },
        off: { command: process.execPath, args: testServerArgs(off), disabled: true },
        taken: { command: "npx", args: ["taken"] },
        legacy: { type: "sse", url: "http://127.0.0.1:3845/sse" },
      },
    });

    const checked = catalog.checkImport(document);
    expect(checked).toEqual([
      { name: "local", ok: true, transport: "stdio", line: [process.execPath, ...testServerArgs(local)].join(" "), fill: [], enabled: true },
      { name: "remote", ok: true, transport: "http", line: remote.url, fill: ["X-Api-Key"], enabled: true },
      { name: "off", ok: true, transport: "stdio", line: [process.execPath, ...testServerArgs(off)].join(" "), fill: [], enabled: false },
      { name: "taken", ok: false, reason: "已有同名服务器" },
      { name: "legacy", ok: false, reason: "SSE 传输，不支持" },
    ]);
    const shown = checked.flatMap((entry) => (entry.ok ? [{ name: entry.name, line: entry.line }] : []));

    expect(() => catalog.importServers(document, { confirmed: [...shown, { name: "extra", line: "npx extra" }], actor })).toThrow("要导入的服务器已有变化，请重新检查后再确认");
    expect(catalog.view().map((server) => server.name)).toEqual(["taken"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts(local)).toEqual([]);

    catalog.importServers(document, { confirmed: shown, actor });
    expect(catalog.view().map((server) => server.name)).toEqual(["taken", "local", "remote", "off"]);
    for (const name of ["local", "remote", "off"]) expect(catalog.viewServer(name)).toMatchObject({ trusted: false, attachedProfiles: [] });
    expect(await connected(catalog, "local")).toMatchObject({ env: { SECRET_TOKEN: "••••••" } });
    expect(await connected(catalog, "remote")).toMatchObject({ headers: { "X-Api-Key": "", "X-Trace": "••••••" }, dpop: false });
    expect(starts(local)).toHaveLength(1);
    expect(catalog.viewServer("off").state).toBe("disabled");
    expect(starts(off)).toEqual([]);

    const audit = fs.readFileSync(path.join(state, AUDIT_FILE), "utf8");
    const entry = audit.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    expect(entry).toMatchObject({
      event: "mcp_servers_imported",
      browser: { id: "b1" },
      servers: [
        { server: "local", transport: "stdio", launchLine: [process.execPath, ...testServerArgs(local)].join(" "), envNames: ["SECRET_TOKEN"], enabled: true },
        { server: "remote", transport: "http", launchLine: remote.url, headerNames: ["X-Api-Key", "X-Trace"], enabled: true },
        { server: "off", transport: "stdio", enabled: false },
      ],
    });
    expect(audit).not.toContain(SECRET_SENTINEL);
    expect(audit).not.toContain(HEADER_SENTINEL);
  }, 20_000);
});
