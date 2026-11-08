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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import { McpCallRefused, McpCatalog, type McpServerInput } from "../src/mcp-catalog.js";
import { SECRET_SENTINEL, isAlive, starts, testServerArgs, testServerFiles, writeTools, type TestServerFiles } from "./fixtures/mcp-test-server-control.js";

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
    expect(fs.existsSync(ownerCache)).toBe(false);

    await catalog.remove("npxbox", actor);
    expect(fs.existsSync(own)).toBe(false);
  }, 90_000);
});
