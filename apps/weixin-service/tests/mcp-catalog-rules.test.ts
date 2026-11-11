// Pure rules of the MCP Catalog (docs/specs/mcp-catalog.md). Expected values are literals from the spec, from the
// owner's agent-link MCP settings (the spec's reference), or written by hand.
import { describe, expect, it } from "vitest";

import {
  checkImport,
  childEnvironment,
  launchLine,
  launchPlan,
  mergeSecrets,
  needsConfirmation,
  normalizeHttp,
  normalizeStdio,
  normalizeTimeout,
  offeredInput,
  offeredToolNames,
  pinDiff,
  pinOf,
  redactDeep,
  redactSecrets,
  retryDelay,
  toolStatus,
  validateServerName,
  type ToolDefinition,
} from "../src/mcp-catalog-rules.js";

const context = { homeDirectory: "/h/owner", stateDirectory: "/h/owner/.state/weixin" };

describe("server name (mcp-catalog::US-001/AC-02)", () => {
  it.each(["a", "A_b-9", "a".repeat(32)])("accepts %s", (name) => {
    expect(validateServerName(name)).toBe(name);
  });
  it.each(["", "has space", "a".repeat(33), "名称", "a.b"])("refuses %j", (name) => {
    expect(() => validateServerName(name)).toThrow("名称只能包含英文字母、数字、_ 和 -，1–32 个字符");
  });
});

describe("timeout (mcp-catalog::US-001/AC-05)", () => {
  it.each([[undefined, 60], ["", 60], [1, 1], [600, 600], ["90", 90]])("%j becomes %d seconds", (value, seconds) => {
    expect(normalizeTimeout(value)).toBe(seconds);
  });
  it.each([0, 601, 1.5, "abc"])("refuses %j", (value) => {
    expect(() => normalizeTimeout(value)).toThrow("超时应为 1–600 的整数（秒）");
  });
});

describe("local program fields (mcp-catalog::US-001/AC-03)", () => {
  it("checks the working directory only when the program is sandboxed", () => {
    expect(normalizeStdio({ command: "node", cwd: "/h/owner" }, context)).toEqual({ command: "node", args: [], cwd: "/h/owner", envNames: [] });
    expect(normalizeStdio({ command: "node", cwd: "/h/owner/work", sandbox: {} }, context)).toMatchObject({ cwd: "/h/owner/work" });
  });

  it("keeps arguments as entered, defaults the working directory and normalizes the sandbox", () => {
    expect(normalizeStdio({
      command: " node ",
      args: ["/opt/a b.js", "--flag"],
      cwd: "",
      envNames: ["TOKEN", "TOKEN"],
      sandbox: { domains: ["*.example.com", "api.github.com", "api.github.com"], read: ["/h/owner/ref/../ref"], write: ["/data/out"] },
    }, context)).toEqual({
      command: "node",
      args: ["/opt/a b.js", "--flag"],
      envNames: ["TOKEN"],
      sandbox: { domains: ["*.example.com", "api.github.com"], read: ["/h/owner/ref"], write: ["/data/out"] },
    });
  });

  it.each([
    [{ command: "" }, "请填写命令"],
    [{ command: "node", cwd: "relative/dir" }, "工作目录应为绝对路径"],
    [{ command: "node", envNames: ["1BAD"] }, "环境变量名称不合法：1BAD"],
    [{ command: "node", sandbox: { domains: ["bad_domain!"] } }, "放行的域名不合法：bad_domain!"],
    [{ command: "node", sandbox: { read: ["relative"] } }, "可读的目录应为绝对路径：relative"],
    [{ command: "node", sandbox: { write: ["/h/owner"] } }, "可读写的目录不能是家目录本身或它的上级：/h/owner"],
    [{ command: "node", sandbox: { read: ["/h"] } }, "可读的目录不能是家目录本身或它的上级：/h"],
    [{ command: "node", sandbox: { write: ["/h/owner/.state"] } }, "可读写的目录不能包含服务的状态目录，也不能在其中：/h/owner/.state"],
    [{ command: "node", sandbox: { read: ["/h/owner/.state/weixin/mcp"] } }, "可读的目录不能包含服务的状态目录，也不能在其中：/h/owner/.state/weixin/mcp"],
    [{ command: "node", sandbox: { read: ["/"] } }, "可读的目录不能是家目录本身或它的上级：/"],
    [{ command: "node", sandbox: { write: ["/"] } }, "可读写的目录不能是家目录本身或它的上级：/"],
    [{ command: "node", sandbox: { read: ["/h/owner/.state/weixin"] } }, "可读的目录不能包含服务的状态目录，也不能在其中：/h/owner/.state/weixin"],
    [{ command: "node", sandbox: { write: ["/h/owner/.state/weixin"] } }, "可读写的目录不能包含服务的状态目录，也不能在其中：/h/owner/.state/weixin"],
    [{ command: "node", cwd: "/h/owner", sandbox: {} }, "工作目录不能是家目录本身或它的上级：/h/owner"],
    [{ command: "node", cwd: "/", sandbox: {} }, "工作目录不能是家目录本身或它的上级：/"],
    [{ command: "node", cwd: "/h/owner/.state/weixin", sandbox: {} }, "工作目录不能包含服务的状态目录，也不能在其中：/h/owner/.state/weixin"],
    [{ command: "node", cwd: "/h/owner/.state/weixin/mcp", sandbox: {} }, "工作目录不能包含服务的状态目录，也不能在其中：/h/owner/.state/weixin/mcp"],
  ])("refuses %j", (input, message) => {
    expect(() => normalizeStdio(input, context)).toThrow(message);
  });
});

describe("URL server fields (mcp-catalog::US-001/AC-04)", () => {
  it.each([
    ["https", { url: "https://h.example/mcp" }, { url: "https://h.example/mcp", headerNames: [], dpop: false }],
    ["a bare origin gets its path", { url: " https://h.example " }, { url: "https://h.example/", headerNames: [], dpop: false }],
    ["http on localhost", { url: "http://localhost:9/mcp" }, { url: "http://localhost:9/mcp", headerNames: [], dpop: false }],
    ["http on 127.0.0.2", { url: "http://127.0.0.2/x" }, { url: "http://127.0.0.2/x", headerNames: [], dpop: false }],
    ["http on ::1", { url: "http://[::1]/x" }, { url: "http://[::1]/x", headerNames: [], dpop: false }],
    ["headers beside OAuth with DPoP", { url: "https://h.example/mcp", headerNames: ["X-Api-Key"], oauth: { issuer: " https://auth.example ", clientId: "agent", scope: "docs:read" }, dpop: true },
      { url: "https://h.example/mcp", headerNames: ["X-Api-Key"], oauth: { issuer: "https://auth.example", clientId: "agent", scope: "docs:read" }, dpop: true }],
    ["OAuth without a scope", { url: "https://h.example/mcp", oauth: { issuer: "https://auth.example", clientId: "agent", scope: "" } },
      { url: "https://h.example/mcp", headerNames: [], oauth: { issuer: "https://auth.example", clientId: "agent" }, dpop: false }],
    ["empty OAuth fields are no OAuth", { url: "https://h.example/mcp", headerNames: ["Authorization"], oauth: { issuer: "", clientId: "", scope: "" } },
      { url: "https://h.example/mcp", headerNames: ["Authorization"], dpop: false }],
  ])("accepts %s", (_case, input, expected) => {
    expect(normalizeHttp(input)).toEqual(expected);
  });
  it.each([
    [{ url: "" }, "请填写网址"],
    [{ url: "not a url" }, "网址无效：not a url"],
    [{ url: "http://h.example/mcp" }, "网址应以 https:// 开头，本机地址可用 http://：http://h.example/mcp"],
    [{ url: "ftp://h.example/x" }, "网址应以 https:// 开头，本机地址可用 http://：ftp://h.example/x"],
    [{ url: "https://user:pass@h.example/x" }, "网址不能包含用户名或密码，请改用请求头"],
    [{ url: "https://h.example/x", headerNames: ["bad name"] }, "请求头名称不合法：bad name"],
    [{ url: "https://h.example/x", headerNames: ["X-Key", "x-key"] }, "请求头重复：x-key"],
    [{ url: "https://h.example/x", headerNames: ["Authorization"], oauth: { issuer: "https://auth.example", clientId: "a" } }, "已填写 OAuth 时，请求头不能包含 Authorization：令牌由 OAuth 取得"],
    [{ url: "https://h.example/x", headerNames: ["dpop"], oauth: { issuer: "https://auth.example", clientId: "a" } }, "已填写 OAuth 时，请求头不能包含 dpop：令牌由 OAuth 取得"],
    [{ url: "https://h.example/x", dpop: true }, "DPoP 需要配合 OAuth 使用"],
    [{ url: "https://h.example/x", oauth: { issuer: "https://auth.example" } }, "请填写客户端 ID"],
    [{ url: "https://h.example/x", oauth: { clientId: "a" } }, "请填写 OAuth 授权服务器"],
    [{ url: "https://h.example/x", oauth: { issuer: "http://auth.example", clientId: "a" } }, "OAuth 授权服务器应以 https:// 开头，本机地址可用 http://：http://auth.example"],
  ])("refuses %j", (input, message) => {
    expect(() => normalizeHttp(input)).toThrow(message);
  });
});

describe("write-only environment values (mcp-catalog::REQ-001)", () => {
  const saved = { TOKEN: "saved-token-value" };
  it.each([
    ["the placeholder keeps the saved value", { TOKEN: "••••••" }, { TOKEN: "saved-token-value" }],
    ["new text replaces it", { TOKEN: "new-value" }, { TOKEN: "new-value" }],
    ["a name left out is removed", {}, {}],
  ])("%s", (_case, input, expected) => {
    expect(mergeSecrets(input, saved)).toEqual(expected);
  });
  it.each([
    [undefined, "环境变量 OTHER 没有已保存的值，请填写"],
    ["请求头", "请求头 OTHER 没有已保存的值，请填写"],
  ])("refuses the placeholder for a value that was never saved (%s)", (what, message) => {
    expect(() => mergeSecrets({ OTHER: "••••••" }, saved, what)).toThrow(message);
  });
});

describe("the exact launch line (mcp-catalog::US-001/AC-06, REQ-002)", () => {
  it("quotes arguments the way a POSIX shell reads them", () => {
    expect(launchLine({ command: "node", args: ["/tmp/a b.js", "it's", "", "--port=8080"] })).toBe(`node '/tmp/a b.js' 'it'\\''s' '' --port=8080`);
  });
  it("shows a URL server's address as it connects to it", () => {
    expect(launchLine({ transport: "http", url: "https://h.example/a b?x=1" })).toBe("https://h.example/a b?x=1");
  });
  it.each([
    ["a new server", undefined, { command: "node", args: ["a.js"] }, true],
    ["a changed command", { command: "node", args: ["a.js"] }, { command: "bun", args: ["a.js"] }, true],
    ["changed arguments", { command: "node", args: ["a.js"] }, { command: "node", args: ["b.js"] }, true],
    ["the same program", { command: "node", args: ["a.js"] }, { command: "node", args: ["a.js"] }, false],
    ["a new URL server", undefined, { transport: "http" as const, url: "https://h.example/mcp" }, true],
    ["a changed URL", { transport: "http" as const, url: "https://h.example/mcp" }, { transport: "http" as const, url: "https://h.example/v2" }, true],
    ["the same URL", { transport: "http" as const, url: "https://h.example/mcp" }, { transport: "http" as const, url: "https://h.example/mcp" }, false],
    ["a program becoming a URL with the same text", { command: "https://h.example/mcp", args: [] }, { transport: "http" as const, url: "https://h.example/mcp" }, true],
  ])("%s needs confirmation: %s", (_case, previous, next, expected) => {
    expect(needsConfirmation(previous, next)).toBe(expected);
  });
});

describe("masking in program output (mcp-catalog::REQ-001)", () => {
  it.each([
    ["a secret of 6 characters", "token abcdef rejected", ["abcdef"], "token *** rejected"],
    ["a secret appearing twice", "abcdef and abcdef", ["abcdef"], "*** and ***"],
    ["a secret inside a longer token", "Bearer xabcdefx", ["abcdef"], "Bearer x***x"],
    ["a longer secret before its own prefix", "key abcdef123", ["abcdef", "abcdef123"], "key ***"],
    ["a secret of 5 characters stays (the spec's boundary)", "pin abcde", ["abcde"], "pin abcde"],
  ])("%s", (_case, text, secrets, expected) => {
    expect(redactSecrets(text, secrets)).toBe(expected);
  });
});

describe("pinned definitions (mcp-catalog::US-004/AC-03)", () => {
  const base: ToolDefinition = {
    name: "lookup",
    title: "Lookup",
    description: "Finds an item.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } }, required: ["q"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { readOnlyHint: true },
    _meta: { "anthropic/requiresUserInteraction": false },
  };
  it.each([
    ["text", { ...base, description: "Finds an item by name." }],
    ["text", { ...base, title: "Find" }],
    ["schema", { ...base, outputSchema: { type: "object", properties: { id: { type: "integer" } } } }],
    ["schema", { ...base, inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    ["hints", { ...base, annotations: { readOnlyHint: false } }],
    ["meta", { ...base, _meta: { "anthropic/requiresUserInteraction": true } }],
  ])("a %s change is reported with the old description", (part, changed) => {
    expect(pinDiff(pinOf(base), changed)).toEqual({ changed: [part], was: "Finds an item." });
  });
  it("another key order is not a change", () => {
    const shuffled: ToolDefinition = {
      _meta: { "anthropic/requiresUserInteraction": false },
      annotations: { readOnlyHint: true },
      inputSchema: { required: ["q"], properties: { n: { type: "integer" }, q: { type: "string" } }, type: "object" },
      outputSchema: { properties: { id: { type: "string" } }, type: "object" },
      description: "Finds an item.",
      title: "Lookup",
      name: "lookup",
    };
    expect(pinDiff(pinOf(base), shuffled).changed).toEqual([]);
  });
});

describe("automatic retry (mcp-catalog::REQ-003/AC-04)", () => {
  it("starts at 30 seconds, doubles and stops at 10 minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((failures) => retryDelay(failures))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});

describe("a local program's environment (mcp-catalog::REQ-003/AC-01)", () => {
  it("gets only the base variables and its own, never model keys or service settings", () => {
    const parent = {
      PATH: "/usr/bin", HOME: "/h/owner", LANG: "zh_CN.UTF-8", XDG_CONFIG_HOME: "/h/owner/.config",
      OPENAI_API_KEY: "sk-model", CODEX_API_KEY: "codex-key", CODEX_HOME: "/h/owner/.codex",
      FEISHU_APP_SECRET: "feishu-secret", WEIXIN_DEMO_STATE_DIR: "/h/owner/.state",
    };
    expect(childEnvironment(parent, { SECRET_TOKEN: "tok" })).toEqual({
      PATH: "/usr/bin", HOME: "/h/owner", LANG: "zh_CN.UTF-8", XDG_CONFIG_HOME: "/h/owner/.config", SECRET_TOKEN: "tok",
    });
  });
});

describe("launch plan (mcp-catalog::US-001/AC-03 sandbox)", () => {
  const existing = new Set(["/opt/tools/server", "/data/in/file.txt", "/h/owner/.state/weixin/leak.txt"]);
  const launch = {
    ...context, platform: "darwin", execPath: "/opt/node/bin/node", srtPath: "/srt/cli.js", tmpDirectory: "/tmp",
    cacheDirectory: "/h/owner/Library/Caches/codex-weixin/mcp/boxed", isFile: (file: string) => existing.has(file),
  };
  it("runs an unsandboxed program as configured, in the home directory by default", () => {
    expect(launchPlan({ name: "plain", command: "node", args: ["a.js"] }, launch)).toEqual({ command: "node", args: ["a.js"], cwd: "/h/owner", env: {} });
  });
  it("lets a sandboxed program read only what the owner named, each named file alone, and its own npm cache", () => {
    expect(launchPlan({
      name: "boxed", command: "/opt/tools/server", args: ["--root", "/data/in/file.txt", "/data/in", "/missing/file.txt", "/h/owner/.state/weixin/leak.txt"], cwd: "/data/work",
      sandbox: { domains: ["registry.npmjs.org"], read: ["/h/owner/ref", "/data/out"], write: ["/data/out"] },
    }, launch)).toEqual({
      command: "/opt/node/bin/node",
      args: ["/srt/cli.js", "--settings", "/h/owner/.state/weixin/mcp-sandbox/boxed.json", "--", "/opt/tools/server", "--root", "/data/in/file.txt", "/data/in", "/missing/file.txt", "/h/owner/.state/weixin/leak.txt"],
      cwd: "/data/work",
      env: {
        npm_config_cache: "/h/owner/Library/Caches/codex-weixin/mcp/boxed/npm",
        npm_config_userconfig: "/h/owner/Library/Caches/codex-weixin/mcp/boxed/npmrc",
      },
      sandbox: {
        settingsFile: "/h/owner/.state/weixin/mcp-sandbox/boxed.json",
        settings: {
          network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [] },
          filesystem: {
            denyRead: ["/h/owner", "/h/owner/.state/weixin"],
            allowRead: ["/opt/node", "/opt/tools/server", "/data/in/file.txt", "/data/work", "/h/owner/ref", "/data/out", "/h/owner/Library/Caches/codex-weixin/mcp/boxed"],
            allowWrite: ["/data/out", "/tmp", "/h/owner/Library/Caches/codex-weixin/mcp/boxed"],
            denyWrite: ["/h/owner/ref", "/opt/tools/server", "/data/in/file.txt"],
          },
        },
      },
    });
  });
  it.each([
    [[], []],
    [["api.example.com"], ["api.example.com"]],
  ])("never adds a domain the owner did not list (%j)", (domains, expected) => {
    const plan = launchPlan({ name: "boxed", command: "npx", args: ["-y", "some-server"], sandbox: { domains: [...domains], read: [], write: [] } }, launch);
    expect((plan.sandbox?.settings as { network: { allowedDomains: string[] } }).network.allowedDomains).toEqual(expected);
  });
  it.each([
    ["the Node.js installation is in the home directory", { execPath: "/h/owner/bin/node" }, "Node.js 安装目录不能是家目录本身或它的上级：/h/owner"],
    ["the Node.js installation is in the state directory", { execPath: "/h/owner/.state/weixin/node/bin/node" }, "Node.js 安装目录不能包含服务的状态目录，也不能在其中：/h/owner/.state/weixin/node"],
    ["the system is not macOS", { platform: "linux" }, "沙箱只支持 macOS，boxed 设为在沙箱中运行，未启动"],
  ])("refuses to start a sandboxed program when %s, instead of widening or dropping the sandbox", (_case, override, message) => {
    expect(() => launchPlan({ name: "boxed", command: "node", args: [], sandbox: { domains: [], read: [], write: [] } }, { ...launch, ...override })).toThrow(message);
  });
});

describe("which tools are provided (mcp-catalog::US-004)", () => {
  const tool: ToolDefinition = { name: "edit", description: "Edits.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } };
  const pinned = pinOf(tool);
  const needsPerson: ToolDefinition = { ...tool, _meta: { "anthropic/requiresUserInteraction": true } };
  it.each([
    ["pinned and enabled", tool, { trusted: false, disabled: false, pin: pinned }, { usable: true, needsUser: false, readOnly: false, mayModify: false }],
    ["disabled", tool, { trusted: false, disabled: true, pin: pinned }, { usable: false, needsUser: false, readOnly: false, mayModify: false }],
    ["new", tool, { trusted: false, disabled: false, pin: undefined }, { usable: false, pending: "new", needsUser: false, readOnly: false, mayModify: false }],
    ["changed", { ...tool, description: "Edits more." }, { trusted: false, disabled: false, pin: pinned }, { usable: false, pending: "changed", needsUser: false, readOnly: false, mayModify: false }],
    ["asking for a person", needsPerson, { trusted: false, disabled: false, pin: pinOf(needsPerson) }, { usable: false, needsUser: true, readOnly: false, mayModify: false }],
    ["on a trusted server", tool, { trusted: true, disabled: false, pin: pinned }, { usable: true, needsUser: false, readOnly: true, mayModify: true }],
  ])("%s", (_case, definition, server, expected) => {
    expect(toolStatus(definition, server)).toEqual(expected);
  });
});

describe("import check (mcp-catalog::US-002/AC-01)", () => {
  // The shapes follow real configurations: Claude Desktop keeps settings beside mcpServers; Claude Code writes
  // `type: "stdio"` with an empty env object and `type: "http"`; Cursor writes `type: "sse"` with a loopback URL.
  const document = JSON.stringify({
    globalShortcut: "",
    preferences: { quickEntry: true },
    mcpServers: {
      taken: { command: "npx", args: ["-y", "taken"] },
      notes: { type: "sse", url: "http://127.0.0.1:3845/sse" },
      socket: { type: "websocket", url: "wss://h.example/ws" },
      "my notes": { command: "npx" },
      empty: {},
      both: { command: "npx", url: "https://h.example/mcp" },
      typed: { type: "stdio", command: "npx", args: ["-y", "@scope/server", "/tmp/a b"], env: {} },
      plain: { command: "/usr/local/bin/tool", args: ["--flag"], cwd: "/srv/tool", env: { TOKEN: "${GITHUB_TOKEN}", MODE: "fast" } },
      remote: { type: "http", url: "https://h.example/mcp", headers: { "X-Api-Key": "${input:key}", Authorization: "Bearer ${X}" } },
      streamable: { type: "streamable-http", url: "https://h.example/s" },
      untyped: { url: "http://localhost:7/mcp" },
      off: { command: "npx", args: ["off"], disabled: true },
      insecure: { url: "http://h.example/mcp" },
      badcwd: { command: "npx", cwd: "relative" },
    },
  });

  it("lists each server as to be imported or skipped with the reason", () => {
    const entries = checkImport(document, (name) => name === "taken", context);
    expect(entries.map((entry) => (entry.ok ? { name: entry.name, transport: entry.transport, line: entry.line, fill: entry.fill, enabled: entry.enabled } : entry))).toEqual([
      { name: "taken", ok: false, reason: "已有同名服务器" },
      { name: "notes", ok: false, reason: "SSE 传输，不支持" },
      { name: "socket", ok: false, reason: "不支持的连接方式：websocket" },
      { name: "my notes", ok: false, reason: "名称不合法：只能包含英文字母、数字、_ 和 -，1–32 个字符" },
      { name: "empty", ok: false, reason: "缺少命令或网址" },
      { name: "both", ok: false, reason: "同时填写了命令和网址" },
      { name: "typed", transport: "stdio", line: "npx -y @scope/server '/tmp/a b'", fill: [], enabled: true },
      { name: "plain", transport: "stdio", line: "/usr/local/bin/tool --flag", fill: ["TOKEN"], enabled: true },
      { name: "remote", transport: "http", line: "https://h.example/mcp", fill: ["X-Api-Key"], enabled: true },
      { name: "streamable", transport: "http", line: "https://h.example/s", fill: [], enabled: true },
      { name: "untyped", transport: "http", line: "http://localhost:7/mcp", fill: [], enabled: true },
      { name: "off", transport: "stdio", line: "npx off", fill: [], enabled: false },
      { name: "insecure", ok: false, reason: "网址应以 https:// 开头，本机地址可用 http://：http://h.example/mcp" },
      { name: "badcwd", ok: false, reason: "工作目录应为绝对路径" },
    ]);
  });

  it("imports a placeholder value as empty and keeps other values literally", () => {
    const entries = Object.fromEntries(checkImport(document, () => false, context).filter((entry) => entry.ok).map((entry) => [entry.name, entry.ok ? entry.server : undefined]));
    expect(entries.plain).toEqual({ transport: "stdio", name: "plain", enabled: true, command: "/usr/local/bin/tool", args: ["--flag"], cwd: "/srv/tool", env: { TOKEN: "", MODE: "fast" } });
    expect(entries.remote).toEqual({ transport: "http", name: "remote", enabled: true, url: "https://h.example/mcp", headers: { "X-Api-Key": "", Authorization: "Bearer ${X}" } });
  });

  it.each([
    ['{"mcpServers": ', "不是有效的 JSON"],
    ["[]", "没有找到 mcpServers 对象"],
    ['{"servers": {}}', "没有找到 mcpServers 对象"],
    ['{"mcpServers": []}', "没有找到 mcpServers 对象"],
    ['{"mcpServers": {}}', "mcpServers 里没有服务器"],
  ])("refuses %s", (text, message) => {
    expect(() => checkImport(text, () => false, context)).toThrow(message);
  });
});

// The name a runtime is offered for each tool of one server: the tool's own name when the Responses API takes it (letters,
// digits, `_` and `-`, at most 64 characters), measured on the installed App Server, which refuses a thread whose tool has any
// other name. Hash suffixes are the first 8 hex characters of the name's SHA-256, computed by hand with `shasum -a 256`.
describe("offered tool names", () => {
  it.each([
    ["names the API takes stay as they are", ["lookup", "Create-Issue_2", "a".repeat(64)], ["lookup", "Create-Issue_2", "a".repeat(64)]],
    ["other characters become _", ["admin.tools.list", "查询 天气"], ["admin_tools_list", "_____"]],
    ["a name that would then repeat another gets a hash of its own name", ["a.b", "a_b", "a b"], ["a_b_2e7336dc", "a_b", "a_b_c8687a08"]],
    ["a name past 64 characters is cut and gets its hash", ["t".repeat(70)], [`${"t".repeat(55)}_a75c6749`]],
  ])("%s", (_case, tools, offered) => {
    expect([...offeredToolNames(tools)]).toEqual(tools.map((tool, index) => [tool, offered[index]]));
  });
});

// That the installed App Server refuses a tuple written as a list in `items`, and takes the open object offered instead, is the
// opt-in case "an Executor runtime is offered an attached MCP server's tools …" in isolated-runtime-tools.test.ts. The other rows
// are forms it took or refused when measured by hand on codex-cli 0.167.0-alpha.3.2 (2026-11-11).
describe("the input schema a runtime is offered", () => {
  const point = { type: "array", items: [{ type: "number" }, { type: "number" }] };
  it.each([
    ["an object with typed properties", { type: "object", properties: { q: { type: "string" } }, required: ["q"] }],
    ["references, unions, type lists and unknown keywords", { type: "object", properties: { item: { $ref: "#/$defs/item" }, v: { anyOf: [{ type: "string" }, { type: ["number", "null"] }] }, any: true },
      $defs: { item: { type: "object", additionalProperties: { type: "string" } } }, "x-custom": 1 }],
    ["an empty schema", {}],
  ])("offers %s as the server gave it", (_case, schema) => {
    expect(offeredInput("Finds an item.", schema)).toEqual({ description: "Finds an item.", inputSchema: schema });
  });

  it.each([
    ["a tuple written as a list in items", { type: "object", properties: { from: point } }],
    ["such a tuple inside a union inside a definition", { type: "object", $defs: { target: { oneOf: [{ type: "string" }, point] } } }],
    ["a schema whose only type is null", { type: "null" }],
    ["a required that is not a list of names", { type: "object", required: "q" }],
    ["no schema at all", undefined],
    ["a schema that is a list", [{ type: "object" }]],
  ])("offers %s as an open object and puts the schema in the description", (_case, schema) => {
    expect(offeredInput("Drags.", schema)).toEqual({ description: `Drags.\n\n参数按这份 JSON Schema 填写：${JSON.stringify(schema ?? null)}`, inputSchema: { type: "object", additionalProperties: true } });
  });

  it("puts only the schema in the description of a tool that has none", () => {
    expect(offeredInput("", { type: "null" }).description).toBe('参数按这份 JSON Schema 填写：{"type":"null"}');
  });
});

// mcp-catalog::REQ-003/AC-01: no agent sees a server's saved secrets; a call's result is masked by REQ-001's rule.
describe("masking every string of a call's structured result", () => {
  it("masks secrets of 6 characters or more in values and keys at any depth, and leaves other values as they are", () => {
    expect(redactDeep({ token: "tok-123456", rows: [{ note: "uses tok-123456 twice: tok-123456", n: 7, ok: true, none: null }], "tok-123456": "short abc" }, ["tok-123456", "abc"]))
      .toEqual({ token: "***", rows: [{ note: "uses *** twice: ***", n: 7, ok: true, none: null }], "***": "short abc" });
  });
});
