import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ISOLATED_MODEL_DISABLED_FEATURES = [
  "plugins", "remote_plugin", "skill_search", "apps", "browser_use", "computer_use", "image_generation",
  "in_app_browser", "memories", "multi_agent", "multi_agent_v2", "goals", "hooks", "workspace_dependencies",
  "tool_suggest", "shell_tool", "unified_exec", "view_image", "code_mode", "in_app_local_automation",
] as const;

export type IsolatedModelRuntime = { cwd: string; env: NodeJS.ProcessEnv; permissionProfile: string; configOverrides: string[] };

/** Host configuration and auth are separate: only login credentials enter this private runtime home. */
export function createIsolatedModelRuntime(options: {
  root: string;
  scope: string;
  readableRoots?: string[];
  authHome?: string;
  environment?: NodeJS.ProcessEnv;
}): IsolatedModelRuntime {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(options.scope) || options.scope === "." || options.scope === "..") {
    throw new Error("isolated_runtime_scope_invalid");
  }
  const root = path.resolve(options.root, options.scope);
  const cwd = path.join(root, "workspace"), codexHome = path.join(root, "codex-home");
  for (const directory of [root, cwd, codexHome]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("isolated_runtime_path_invalid");
    fs.chmodSync(directory, 0o700);
  }
  const environment = options.environment ?? process.env;
  const authHome = options.authHome ?? environment.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const authPath = path.join(authHome, "auth.json");
  if (fs.existsSync(authPath)) {
    const source = fs.openSync(authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(source).isFile()) throw new Error("isolated_runtime_auth_invalid");
      fs.writeFileSync(path.join(codexHome, "auth.json"), fs.readFileSync(source), { mode: 0o600 });
      fs.chmodSync(path.join(codexHome, "auth.json"), 0o600);
    } finally { fs.closeSync(source); }
  }
  const readableRoots = [cwd, ...(options.readableRoots ?? [])].map((directory) => fs.realpathSync(directory));
  const config = [
    'default_permissions = "group"',
    'cli_auth_credentials_store = "file"',
    "project_doc_max_bytes = 0",
    '[shell_environment_policy]',
    'inherit = "none"',
    '[features]',
    'skip_host_skill_discovery = true',
    ...ISOLATED_MODEL_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    '[permissions.group.filesystem]',
    '":root" = "deny"',
    '":minimal" = "read"',
    '":tmpdir" = "deny"',
    '":slash_tmp" = "deny"',
    `${JSON.stringify(fs.realpathSync(codexHome))} = "deny"`,
    ...[...new Set(readableRoots)].map((directory) => `${JSON.stringify(directory)} = "read"`),
    '[permissions.group.network]',
    'enabled = false',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), config, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(root, "config") };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENAI_API_KEY"]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  return { cwd, env, permissionProfile: "group", configOverrides: ["features.skip_host_skill_discovery=true", "project_doc_max_bytes=0"] };
}
