// Pure rules of the MCP Catalog (docs/specs/mcp-catalog.md). Expected values are literals from the spec, from the
// owner's agent-link MCP settings (the spec's reference), or written by hand.
import { describe, expect, it } from "vitest";

import {
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

describe("write-only environment values (mcp-catalog::REQ-001)", () => {
  const saved = { TOKEN: "saved-token-value" };
  it.each([
    ["the placeholder keeps the saved value", { TOKEN: "••••••" }, { TOKEN: "saved-token-value" }],
    ["new text replaces it", { TOKEN: "new-value" }, { TOKEN: "new-value" }],
    ["a name left out is removed", {}, {}],
  ])("%s", (_case, input, expected) => {
    expect(mergeSecrets(input, saved)).toEqual(expected);
  });
  it("refuses the placeholder for a value that was never saved", () => {
    expect(() => mergeSecrets({ OTHER: "••••••" }, saved)).toThrow("环境变量 OTHER 没有已保存的值，请填写");
  });
});

describe("the exact launch line (mcp-catalog::US-001/AC-06, REQ-002)", () => {
  it("quotes arguments the way a POSIX shell reads them", () => {
    expect(launchLine({ command: "node", args: ["/tmp/a b.js", "it's", "", "--port=8080"] })).toBe(`node '/tmp/a b.js' 'it'\\''s' '' --port=8080`);
  });
  it.each([
    ["a new server", undefined, { command: "node", args: ["a.js"] }, true],
    ["a changed command", { command: "node", args: ["a.js"] }, { command: "bun", args: ["a.js"] }, true],
    ["changed arguments", { command: "node", args: ["a.js"] }, { command: "node", args: ["b.js"] }, true],
    ["the same program", { command: "node", args: ["a.js"] }, { command: "node", args: ["a.js"] }, false],
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
  it.each([[[]], [["api.example.com"]]])("never adds a domain the owner did not list (%j)", (domains) => {
    const plan = launchPlan({ name: "boxed", command: "npx", args: ["-y", "some-server"], sandbox: { domains, read: [], write: [] } }, launch);
    expect((plan.sandbox?.settings as { network: { allowedDomains: string[] } }).network.allowedDomains).toEqual(domains);
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
