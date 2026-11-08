import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnStdioAppServer, type StdioAppServerTransport } from "./stdio-app-server-transport.js";

export const ISOLATED_MODEL_DISABLED_FEATURES = [
  "plugins", "remote_plugin", "skill_search", "apps", "browser_use", "computer_use", "image_generation",
  "in_app_browser", "memories", "multi_agent", "multi_agent_v2", "goals", "hooks", "workspace_dependencies",
  "tool_suggest", "shell_tool", "unified_exec", "view_image", "code_mode", "in_app_local_automation",
] as const;

export type IsolatedModelRuntime = { cwd: string; env: NodeJS.ProcessEnv; permissionProfile: string; configOverrides: string[] };

const MODEL_CATALOG_FILE = "direct-model-catalog.json";

/** Host configuration, HOME and auth are separate: only login credentials enter this private runtime home, and the
 * runtime gets its own HOME, so the App Server finds no owner skills there; bundled system skills stay off. The runtime
 * offers its model only what the host grants (ADR-0029): a direct-mode model catalog in its own home removes `exec`,
 * `wait` and `apply_patch`, and user input and sub-agents are switched off. */
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
  const cwd = path.join(root, "workspace"), codexHome = path.join(root, "codex-home"), home = path.join(root, "home");
  for (const directory of [root, cwd, codexHome, home]) {
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
  const catalog = path.join(fs.realpathSync(codexHome), MODEL_CATALOG_FILE);
  const config = [
    'default_permissions = "group"',
    'cli_auth_credentials_store = "file"',
    "project_doc_max_bytes = 0",
    `model_catalog_json = ${JSON.stringify(catalog)}`,
    '[shell_environment_policy]',
    'inherit = "none"',
    '[features]',
    'skip_host_skill_discovery = true',
    ...ISOLATED_MODEL_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    '[skills.bundled]',
    'enabled = false',
    '[tools.experimental_request_user_input]',
    'enabled = false',
    '[agents]',
    'enabled = false',
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
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, HOME: home, XDG_CONFIG_HOME: path.join(root, "config") };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENAI_API_KEY"]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  return { cwd, env, permissionProfile: "group", configOverrides: ["features.skip_host_skill_discovery=true", "skills.bundled.enabled=false", "project_doc_max_bytes=0",
    `model_catalog_json=${JSON.stringify(catalog)}`, "tools.experimental_request_user_input.enabled=false", "agents.enabled=false"] };
}

const derivedCatalogs = new Map<string, string>();

/** The binary's bundled model catalog with every model set to direct tool mode and no apply_patch tool, derived once per
 * binary (path, size and modification time, so an application update derives again). */
function directModelCatalog(executable: string): string {
  try {
    const binary = fs.statSync(executable);
    const key = [fs.realpathSync(executable), binary.size, binary.mtimeMs].join("\0");
    const known = derivedCatalogs.get(key);
    if (known !== undefined) return known;
    // An empty home, so the dump reads neither the owner's configuration nor any credential.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
    try {
      const dump = spawnSync(executable, ["debug", "models", "--bundled"],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home } });
      if (dump.status !== 0) throw new Error("catalog_dump_failed");
      const catalog = JSON.parse(dump.stdout) as { models?: unknown };
      if (!Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("catalog_shape_unexpected");
      for (const model of catalog.models) {
        if (!model || typeof model !== "object" || typeof (model as { slug?: unknown }).slug !== "string") throw new Error("catalog_shape_unexpected");
        Object.assign(model, { tool_mode: "direct", apply_patch_tool_type: null });
      }
      const derived = JSON.stringify(catalog);
      derivedCatalogs.set(key, derived);
      return derived;
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } catch { throw new Error("isolated_runtime_catalog_unavailable"); }
}

/** Writes the direct-mode catalog the runtime's configuration names. Without it the runtime must not start: an App Server
 * whose `model_catalog_json` is missing exits, and every caller starts the runtime only after this succeeds. */
export function installDirectModelCatalog(runtime: IsolatedModelRuntime, executable: string): void {
  const catalog = directModelCatalog(executable);
  const target = path.join(runtime.env.CODEX_HOME!, MODEL_CATALOG_FILE);
  const staged = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(staged, catalog, { mode: 0o600 });
  fs.renameSync(staged, target);
}

/** Starts the App Server of an isolated runtime. Every isolated App Server starts here (main.ts may not spawn one itself),
 * and it does not start when the direct-mode catalog cannot be derived. */
export function spawnIsolatedAppServer(executable: string, runtime: IsolatedModelRuntime): StdioAppServerTransport {
  installDirectModelCatalog(runtime, executable);
  return spawnStdioAppServer(executable, ISOLATED_MODEL_DISABLED_FEATURES, runtime);
}
