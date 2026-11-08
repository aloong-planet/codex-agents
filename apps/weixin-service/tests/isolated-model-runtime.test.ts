// Bootstrap configuration boundary; actual OS denial is verified by the separate real-runtime acceptance probe.
// The "installed Codex App Server" cases run the real executable against a loopback fake model and are opt-in
// (CODEX_ISOLATED_RUNTIME_TEST=1, `pnpm test:isolated-runtime`): CI has no Codex executable, so rerun them after every
// Codex upgrade. Gap: only the API-key form of auth.json is exercised; the ChatGPT-token form needs a real login.
// Each kind's root, scope and options come from ISOLATED_RUNTIME_KINDS, the table main.ts creates its isolated runtimes
// from (isolated-runtime-kinds.test.ts keeps main.ts to it), and runtimes start through spawnIsolatedAppServer as in
// production. Gap: no automated case starts the whole application with its isolated runtimes routed to a fake model (main.ts's
// fixture mode uses fixture transports), so what main.ts passes as each instance (group target, dispatch scope, media root)
// is covered only by its fixture-entry cases and the owner's real-channel acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { createIsolatedModelRuntime, installDirectModelCatalog, type IsolatedModelRuntime, spawnIsolatedAppServer } from "../src/isolated-model-runtime.js";
import { createIsolatedRuntime, type IsolatedConversationKind, isolatedConversationOptions, type IsolatedRuntimeKind } from "../src/isolated-runtime-kinds.js";
import { createScheduledResearch } from "../src/scheduled-research.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";
import { AppServerSession, assistantMessage, type BundledSkillSample, FakeResponsesEndpoint, isolatedConversationPlacements, type IsolatedPlacement,
  modelInputText, plantSkill, runsInstalledAppServer, sampleBundledSkill, skillCatalog } from "./fixtures/isolated-runtime-probe.js";

it("creates separate model homes without importing host settings, skills or unrelated credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-model-test-"));
  try {
    const host = path.join(root, "host"); fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, "auth.json"), '{"OPENAI_API_KEY":"synthetic-login"}');
    fs.writeFileSync(path.join(host, "config.toml"), 'developer_instructions="PRIVATE_SENTINEL"');
    fs.mkdirSync(path.join(host, "skills"));
    const hostHome = path.join(root, "host-home"); fs.mkdirSync(path.join(hostHome, ".agents", "skills"), { recursive: true });
    const environment = { PATH: "/usr/bin:/bin", HOME: hostHome, CODEX_HOME: host, FEISHU_APP_SECRET: "synthetic-app-secret", NODE_OPTIONS: "--inspect", CODEX_THREAD_ID: "private-thread" };
    const alpha = createIsolatedModelRuntime({ root: path.join(root, "groups"), scope: "alpha", environment });
    const beta = createIsolatedModelRuntime({ root: path.join(root, "groups"), scope: "beta", environment });
    expect(alpha.cwd).not.toBe(beta.cwd); expect(alpha.env.CODEX_HOME).not.toBe(beta.env.CODEX_HOME); expect(alpha.env.HOME).not.toBe(beta.env.HOME);
    expect(alpha.env).toEqual({ PATH: "/usr/bin:/bin", CODEX_HOME: path.join(root, "groups/alpha/codex-home"), HOME: path.join(root, "groups/alpha/home"),
      XDG_CONFIG_HOME: path.join(root, "groups/alpha/config") });
    expect(fs.readdirSync(alpha.env.HOME!)).toEqual([]);
    expect(fs.statSync(alpha.env.HOME!).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(alpha.env.CODEX_HOME!).sort()).toEqual(["auth.json", "config.toml"]);
    expect(fs.readFileSync(path.join(alpha.env.CODEX_HOME!, "auth.json"), "utf8")).toBe('{"OPENAI_API_KEY":"synthetic-login"}');
    expect(fs.statSync(path.join(alpha.env.CODEX_HOME!, "auth.json")).mode & 0o777).toBe(0o600);
    const config = fs.readFileSync(path.join(alpha.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(config).not.toContain("PRIVATE_SENTINEL");
    expect(config).toContain('skip_host_skill_discovery = true');
    expect(config).toContain("[skills.bundled]\nenabled = false\n");
    expect(alpha.configOverrides).toContain("skills.bundled.enabled=false");
    expect(config).toContain('default_permissions = "group"');
    expect(config).toContain('":root" = "deny"');
    expect(config).toContain('":tmpdir" = "deny"');
    expect(config).toContain('":slash_tmp" = "deny"');
    expect(config).toContain(`"${fs.realpathSync(alpha.env.CODEX_HOME!)}" = "deny"`);
    expect(config).toContain(`"${fs.realpathSync(alpha.cwd)}" = "read"`);
    expect(config).not.toContain(beta.cwd);
    expect(config).not.toContain(host);
    expect(config).not.toContain(hostHome);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const scratch: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const scratchDirectory = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-tools-test-")); scratch.push(directory); return directory; };
const syntheticRuntime = (root: string) => createIsolatedModelRuntime({ root: path.join(root, "runtimes"), scope: "alpha", authHome: path.join(root, "no-auth"),
  environment: { PATH: "/usr/bin:/bin", HOME: path.join(root, "host-home"), CODEX_HOME: path.join(root, "host-codex"), OPENAI_API_KEY: "sk-host-sentinel" } });
/** A stand-in for the Codex binary: runs `script` (Node) and logs each invocation's arguments and environment. */
function fakeCodex(root: string, script: string) {
  const file = path.join(root, "codex"), log = path.join(root, "invocations.jsonl");
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.HOME, codexHome: process.env.CODEX_HOME, key: process.env.OPENAI_API_KEY }) + "\\n");\n${script}`, { mode: 0o700 });
  return { file, invocations: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; home?: string; codexHome?: string; key?: string }) : [] };
}
// The shape of `codex debug models --bundled` (codex-cli 0.167.0-alpha.3.2), trimmed: nested objects and arrays, and a model
// whose tool_mode is null.
const bundledCatalog = { models: [
  { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", multi_agent_version: "v1",
    use_responses_lite: true, supported_reasoning_levels: [{ effort: "low", description: "Fast responses with lighter reasoning" }],
    truncation_policy: { mode: "tokens", limit: 10000 }, model_messages: { instructions_template: "Be brief." }, experimental_supported_tools: [] },
  { slug: "gpt-5.5", tool_mode: null, apply_patch_tool_type: "freeform", multi_agent_version: null, use_responses_lite: false, input_modalities: ["text", "image"] },
] };

it("keeps the runtime-supplied tools switched off in a runtime's configuration", () => {
  const root = scratchDirectory();
  const runtime = syntheticRuntime(root);
  const catalog = path.join(fs.realpathSync(path.join(root, "runtimes", "alpha", "codex-home")), "direct-model-catalog.json");
  const config = fs.readFileSync(path.join(runtime.env.CODEX_HOME!, "config.toml"), "utf8");
  // A top-level key: before the first table header, or TOML would read it as part of that table.
  expect(config.indexOf(`model_catalog_json = ${JSON.stringify(catalog)}\n`)).toBeGreaterThan(-1);
  expect(config.indexOf(`model_catalog_json = ${JSON.stringify(catalog)}\n`)).toBeLessThan(config.indexOf("\n["));
  expect(config).toContain("\n[tools.experimental_request_user_input]\nenabled = false\n");
  expect(config).toContain("\n[agents]\nenabled = false\n");
  expect(runtime.configOverrides).toEqual(expect.arrayContaining([`model_catalog_json=${JSON.stringify(catalog)}`,
    "tools.experimental_request_user_input.enabled=false", "agents.enabled=false"]));
});

it("installs a direct-mode copy of the binary's bundled catalog in the runtime's own home", () => {
  const root = scratchDirectory();
  const runtime = syntheticRuntime(root);
  const codex = fakeCodex(root, `process.stdout.write(${JSON.stringify(JSON.stringify(bundledCatalog))});`);
  // The service's own environment, which a dump without its own environment would inherit, points at the owner's homes and key.
  vi.stubEnv("HOME", path.join(root, "owner-home"));
  vi.stubEnv("CODEX_HOME", path.join(root, "owner-codex-home"));
  vi.stubEnv("OPENAI_API_KEY", "sk-owner-sentinel");
  installDirectModelCatalog(runtime, codex.file);
  const installed = path.join(runtime.env.CODEX_HOME!, "direct-model-catalog.json");
  expect(fs.statSync(installed).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(installed, "utf8"))).toEqual({ models: [
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", tool_mode: "direct", apply_patch_tool_type: null, multi_agent_version: "v1",
      use_responses_lite: true, supported_reasoning_levels: [{ effort: "low", description: "Fast responses with lighter reasoning" }],
      truncation_policy: { mode: "tokens", limit: 10000 }, model_messages: { instructions_template: "Be brief." }, experimental_supported_tools: [] },
    { slug: "gpt-5.5", tool_mode: "direct", apply_patch_tool_type: null, multi_agent_version: null, use_responses_lite: false, input_modalities: ["text", "image"] },
  ] });
  const [invocation, ...others] = codex.invocations();
  expect(others).toEqual([]);
  expect(invocation!.args).toEqual(["debug", "models", "--bundled"]);
  // The dump runs in a home of its own, so it reads neither the owner's Codex home nor their credentials.
  expect(invocation!.codexHome).not.toBe(path.join(root, "owner-codex-home"));
  expect(invocation!.home).not.toBe(path.join(root, "owner-home"));
  expect(invocation!.key).toBeUndefined();
});

it.each([
  ["exits with an error", "process.exit(1);"],
  ["prints something other than JSON", "process.stdout.write('catalog unavailable');"],
  ["lists no model", "process.stdout.write(JSON.stringify({ models: [] }));"],
  ["changes its top-level shape", `process.stdout.write(JSON.stringify({ data: ${JSON.stringify(bundledCatalog.models)} }));`],
])("does not start an isolated App Server when the binary's catalog %s", (_case, script) => {
  const root = scratchDirectory();
  const runtime = syntheticRuntime(root);
  const codex = fakeCodex(root, `if (args[0] === "debug") { ${script} } else { process.stdin.resume(); }`);
  expect(() => spawnIsolatedAppServer(codex.file, runtime)).toThrow("isolated_runtime_catalog_unavailable");
  expect(codex.invocations().map((invocation) => invocation.args[0])).toEqual(["debug"]);
  expect(fs.existsSync(path.join(runtime.env.CODEX_HOME!, "direct-model-catalog.json"))).toBe(false);
});

describe.skipIf(!runsInstalledAppServer)("isolated runtimes on the installed Codex App Server", () => {
  const syntheticKey = "sk-synthetic-ticket22";
  const marker = { own: "OWN-CODEX-HOME-BODY-7A1C", ownHome: "OWN-HOME-BODY-2D9E", host: "HOST-AGENTS-BODY-5B3F",
    linked: "HOST-LINKED-BODY-8C4A", hostCodex: "HOST-CODEX-HOME-BODY-1E6D" } as const;
  let work: string, environment: NodeJS.ProcessEnv, hostSkill: string, model: FakeResponsesEndpoint, bundled: BundledSkillSample;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-runtime-skills-"));
    const hostHome = path.join(work, "host-home"), hostCodexHome = path.join(work, "host-codex-home");
    hostSkill = plantSkill(path.join(hostHome, ".agents", "skills"), "host-probe", marker.host);
    // Like the owner's real ~/.agents/skills, one entry is a symlink to a skill kept in another repository.
    plantSkill(path.join(work, "other-repository", "skills"), "linked-probe", marker.linked);
    fs.symlinkSync(path.join(work, "other-repository", "skills", "linked-probe"), path.join(hostHome, ".agents", "skills", "linked-probe"));
    plantSkill(path.join(hostCodexHome, "skills"), "host-codex-probe", marker.hostCodex);
    fs.writeFileSync(path.join(hostCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: syntheticKey }));
    environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: hostHome, CODEX_HOME: hostCodexHome };
    model = await FakeResponsesEndpoint.start();
    // One of the bundled skills this binary ships, read from a runtime that has bundled skills switched back on.
    const sampler = createIsolatedModelRuntime({ root: path.join(work, "bundled-sample"), scope: "sampler", environment });
    const session = await AppServerSession.open(model.route({ ...sampler, configOverrides: [...sampler.configOverrides, "skills.bundled.enabled=true"] }));
    try { bundled = await sampleBundledSkill(session, sampler.cwd); } finally { session.close(); }
  });
  afterAll(async () => { await model?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  /** A runtime created as main.ts creates it, with two skills of its own planted the way a profile's skills would be. */
  function runtimeWithOwnSkills(kind: IsolatedRuntimeKind, location: Omit<IsolatedPlacement, "agentId"> = {}) {
    const runtime = createIsolatedRuntime(kind, { stateDirectory: work, ...location, environment });
    const runtimeRoot = path.dirname(runtime.cwd);
    // Planted at the runtime's own paths, not at whatever HOME the runtime reports, so a host HOME cannot receive them.
    const own = plantSkill(path.join(runtimeRoot, "codex-home", "skills"), "own-probe", marker.own);
    plantSkill(path.join(runtimeRoot, "home", ".agents", "skills"), "own-home-probe", marker.ownHome);
    return { runtime, own, runtimeRoot };
  }
  /** Starts a runtime once with the configuration used before the fix (bundled skills on). Like every runtime root that
   * ran before the fix, its own codex-home then holds the bundled skills. Returns the real path of that copy. */
  async function runAsBeforeTheFix(runtime: IsolatedModelRuntime, runtimeRoot: string): Promise<string> {
    const session = await AppServerSession.open(model.route({ ...runtime, configOverrides: [...runtime.configOverrides, "skills.bundled.enabled=true"] }));
    try { await session.listSkills(runtime.cwd); } finally { session.close(); }
    const installed = path.join(runtimeRoot, "codex-home", "skills", ".system", bundled.name, "SKILL.md");
    expect(fs.existsSync(installed), installed).toBe(true);
    return fs.realpathSync(installed);
  }
  const media = (name: string) => { const directory = path.join(work, "media", name); fs.mkdirSync(directory, { recursive: true }); return directory; };
  const expectOnlyOwnSkills = (input: string) => {
    expect(input).toContain(marker.own);
    expect(input).toContain(marker.ownHome);
    for (const hostMarker of [marker.host, marker.linked, marker.hostCodex]) expect(input).not.toContain(hostMarker);
    expect(input).not.toContain(bundled.bodyLine);
  };

  // Every App Server kind of the table, placed as main.ts places it.
  it.each(Object.entries(isolatedConversationPlacements(media)) as Array<[IsolatedConversationKind, () => IsolatedPlacement]>)(
    "%s runtime offers only skills from its own home", async (kind, placement) => {
    const { agentId, ...location } = placement();
    const { runtime, runtimeRoot } = runtimeWithOwnSkills(kind, location);
    await runAsBeforeTheFix(runtime, runtimeRoot);
    const session = await AppServerSession.open(model.route(runtime));
    try {
      const listed = await session.listSkills(runtime.cwd);
      expect(listed.map((skill) => skill.name).sort()).toEqual(["own-home-probe", "own-probe"]);
      const ownSources = [["codex-home", "skills"], ["home", ".agents", "skills"]].map((parts) => path.join(fs.realpathSync(runtimeRoot), ...parts) + path.sep);
      for (const skill of listed) expect(ownSources.some((source) => fs.realpathSync(skill.path).startsWith(source)), skill.path).toBe(true);
      expect(listed.filter((skill) => skill.scope === "system")).toEqual([]);
    } finally { session.close(); }

    model.respondWith(() => [assistantMessage("fake-model-reply")]);
    const conversation = new CodexConversation(() => spawnIsolatedAppServer(resolveCodexExecutable(process.env), model.route(runtime)),
      60_000, undefined, undefined, 60_000, isolatedConversationOptions(kind, runtime, { structuredOutputSupported: true,
        ...(agentId !== undefined ? { agentId } : {}) }));
    try {
      const threadId = await conversation.startOrResume(undefined, runtime.cwd);
      const from = model.requests.length;
      await conversation.reply(threadId, `$host-probe $linked-probe $host-codex-probe $${bundled.name} $own-probe $own-home-probe please`);
      const request = model.modelRequestsSince(from).at(-1)!;
      expect(skillCatalog(request)?.sort()).toEqual(["own-home-probe", "own-probe"]);
      expectOnlyOwnSkills(modelInputText(request));
      expect(request.authorization).toBe(`Bearer ${syntheticKey}`);
    } finally { await conversation.close(); }
  }, 60_000);

  it("a skill input item cannot load a host or bundled skill", async () => {
    const { runtime, own, runtimeRoot } = runtimeWithOwnSkills("feishuGroup", { instance: "feishu.group.skill-item", mediaRoot: media("skill-item") });
    const ownBundled = await runAsBeforeTheFix(runtime, runtimeRoot);
    model.respondWith(() => [assistantMessage("fake-model-reply")]);
    const session = await AppServerSession.open(model.route(runtime));
    try {
      const thread = await session.request("thread/start", { cwd: runtime.cwd, approvalPolicy: "never", permissions: runtime.permissionProfile,
        selectedCapabilityRoots: [] }) as { thread: { id: string } };
      const from = model.requests.length;
      // The App Server matches a skill item by the exact path skills/list reports (the real path); an alias is ignored.
      expect(await session.turn(thread.thread.id, [{ type: "text", text: "use these" },
        { type: "skill", name: "host-probe", path: fs.realpathSync(hostSkill) }, { type: "skill", name: bundled.name, path: ownBundled },
        { type: "skill", name: "own-probe", path: fs.realpathSync(own) }])).toBe("completed");
      const input = modelInputText(model.modelRequestsSince(from).at(-1)!);
      expect(input).toContain(marker.own);
      expect(input).not.toContain(marker.host);
      expect(input).not.toContain(bundled.bodyLine);
    } finally { session.close(); }
  }, 60_000);

  it("group research through codex exec offers only its own skills", async () => {
    const { runtime, runtimeRoot } = runtimeWithOwnSkills("research", { instance: "feishu.group.probe" });
    await runAsBeforeTheFix(runtime, runtimeRoot);
    model.respondWith(() => [assistantMessage(JSON.stringify({ body: "Fake report.", sources: [{ title: "Example", url: "https://example.com/" }] }))]);
    const research = createScheduledResearch({ executable: resolveCodexExecutable(process.env), timeoutMs: 60_000, groupRuntime: () => model.route(runtime) });
    const from = model.requests.length;
    // The fake model performs no web search, so the research step refuses the report; the request it sent is the subject.
    await expect(research({ signal: new AbortController().signal, destination: { accountId: "feishu.bot.probe", target: "feishu.group.probe" }, name: "Probe research",
      instruction: `$host-probe $linked-probe $host-codex-probe $${bundled.name} $own-probe $own-home-probe`, plannedAt: "2026-11-08T09:00:00.000Z", timezone: "Asia/Shanghai" }))
      .rejects.toThrow("research_search_missing");
    const request = model.modelRequestsSince(from).at(-1)!;
    expect(skillCatalog(request)?.sort()).toEqual(["own-home-probe", "own-probe"]);
    expectOnlyOwnSkills(modelInputText(request));
    expect(request.authorization).toBe(`Bearer ${syntheticKey}`);
  }, 60_000);
});
