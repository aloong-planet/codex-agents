// Bootstrap configuration boundary; actual OS denial is verified by the separate real-runtime acceptance probe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createIsolatedModelRuntime } from "../src/isolated-model-runtime.js";

it("creates separate model homes without importing host settings, skills or unrelated credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-model-test-"));
  try {
    const host = path.join(root, "host"); fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, "auth.json"), '{"OPENAI_API_KEY":"synthetic-login"}');
    fs.writeFileSync(path.join(host, "config.toml"), 'developer_instructions="PRIVATE_SENTINEL"');
    fs.mkdirSync(path.join(host, "skills"));
    const environment = { PATH: "/usr/bin:/bin", CODEX_HOME: host, FEISHU_APP_SECRET: "synthetic-app-secret", NODE_OPTIONS: "--inspect", CODEX_THREAD_ID: "private-thread" };
    const alpha = createIsolatedModelRuntime({ root: path.join(root, "groups"), scope: "alpha", environment });
    const beta = createIsolatedModelRuntime({ root: path.join(root, "groups"), scope: "beta", environment });
    expect(alpha.cwd).not.toBe(beta.cwd); expect(alpha.env.CODEX_HOME).not.toBe(beta.env.CODEX_HOME);
    expect(alpha.env).toEqual({ PATH: "/usr/bin:/bin", CODEX_HOME: path.join(root, "groups/alpha/codex-home"), XDG_CONFIG_HOME: path.join(root, "groups/alpha/config") });
    expect(fs.readdirSync(alpha.env.CODEX_HOME!).sort()).toEqual(["auth.json", "config.toml"]);
    expect(fs.readFileSync(path.join(alpha.env.CODEX_HOME!, "auth.json"), "utf8")).toBe('{"OPENAI_API_KEY":"synthetic-login"}');
    expect(fs.statSync(path.join(alpha.env.CODEX_HOME!, "auth.json")).mode & 0o777).toBe(0o600);
    const config = fs.readFileSync(path.join(alpha.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(config).not.toContain("PRIVATE_SENTINEL");
    expect(config).toContain('skip_host_skill_discovery = true');
    expect(config).toContain('default_permissions = "group"');
    expect(config).toContain('":root" = "deny"');
    expect(config).toContain('":tmpdir" = "deny"');
    expect(config).toContain('":slash_tmp" = "deny"');
    expect(config).toContain(`"${fs.realpathSync(alpha.env.CODEX_HOME!)}" = "deny"`);
    expect(config).toContain(`"${fs.realpathSync(alpha.cwd)}" = "read"`);
    expect(config).not.toContain(beta.cwd);
    expect(config).not.toContain(host);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
