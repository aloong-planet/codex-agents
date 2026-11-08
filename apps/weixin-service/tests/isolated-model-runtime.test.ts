// Bootstrap configuration boundary; actual OS denial is verified by the separate real-runtime acceptance probe.
// The "installed Codex App Server" cases run the real executable against a loopback fake model and are opt-in
// (CODEX_ISOLATED_RUNTIME_TEST=1, `pnpm test:isolated-runtime`): CI has no Codex executable, so rerun them after every
// Codex upgrade. Gap: only the API-key form of auth.json is exercised; the ChatGPT-token form needs a real login.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_CURATOR_RUNTIME_PROFILE } from "../src/codex-account-memory-curator.js";
import { CodexConversation, type CodexConversationOptions } from "../src/codex-conversation.js";
import { createIsolatedModelRuntime, ISOLATED_MODEL_DISABLED_FEATURES } from "../src/isolated-model-runtime.js";
import { createScheduledResearch } from "../src/scheduled-research.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../src/stdio-app-server-transport.js";
import { PENDING_RESPONSE_RUNTIME_PROFILE } from "../src/workflow-pending-response-router.js";
import { AppServerSession, assistantMessage, FakeResponsesEndpoint, modelInputText, plantSkill, runsInstalledAppServer, skillCatalog } from "./fixtures/isolated-runtime-probe.js";

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

describe.skipIf(!runsInstalledAppServer)("isolated runtimes on the installed Codex App Server", () => {
  const syntheticKey = "sk-synthetic-ticket22";
  const marker = { own: "OWN-CODEX-HOME-BODY-7A1C", ownHome: "OWN-HOME-BODY-2D9E", host: "HOST-AGENTS-BODY-5B3F",
    linked: "HOST-LINKED-BODY-8C4A", hostCodex: "HOST-CODEX-HOME-BODY-1E6D" } as const;
  let work: string, environment: NodeJS.ProcessEnv, hostSkill: string, model: FakeResponsesEndpoint;

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
  });
  afterAll(async () => { await model?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  /** A runtime created as main.ts creates it, with two skills of its own planted the way a profile's skills would be. */
  function runtimeWithOwnSkills(root: string, scope: string, readableRoots: string[] = []) {
    const runtime = createIsolatedModelRuntime({ root: path.join(work, root), scope, readableRoots, environment });
    const runtimeRoot = path.join(work, root, scope);
    // Planted at the runtime's own paths, not at whatever HOME the runtime reports, so a host HOME cannot receive them.
    const own = plantSkill(path.join(runtimeRoot, "codex-home", "skills"), "own-probe", marker.own);
    plantSkill(path.join(runtimeRoot, "home", ".agents", "skills"), "own-home-probe", marker.ownHome);
    return { runtime, own, runtimeRoot };
  }
  const media = (name: string) => { const directory = path.join(work, "media", name); fs.mkdirSync(directory, { recursive: true }); return [directory]; };
  const expectOnlyOwnSkills = (input: string) => {
    expect(input).toContain(marker.own);
    expect(input).toContain(marker.ownHome);
    for (const hostMarker of [marker.host, marker.linked, marker.hostCodex]) expect(input).not.toContain(hostMarker);
  };

  // Scopes, roots, readable roots and conversation options as main.ts passes them for each runtime.
  it.each<[string, string, string, () => string[], CodexConversationOptions]>([
    ["Feishu group", "group-model-runtimes", "feishu.group.probe", () => media("group"),
      { serviceName: "feishu_group", webSearch: "live", structuredOutputSupported: true, automaticRecovery: true }],
    ["dispatch coordinator", "group-model-runtimes", "dispatch-coordinator", () => [],
      { serviceName: "feishu_dispatch_coordinator", webSearch: "disabled", structuredOutputSupported: true }],
    ["specialist", "group-model-runtimes", `dispatch-${"a".repeat(64)}`, () => media("specialist"),
      { serviceName: "feishu_agent_alice", webSearch: "live", structuredOutputSupported: true, automaticRecovery: true }],
    ["pending router", "group-model-runtimes", "pending-router", () => [],
      { serviceName: "feishu_group_pending", webSearch: "disabled", runtimeProfile: PENDING_RESPONSE_RUNTIME_PROFILE }],
    ["group memory curator", "group-model-runtimes", "memory-curator", () => [],
      { serviceName: "feishu_group_memory", webSearch: "disabled", runtimeProfile: MEMORY_CURATOR_RUNTIME_PROFILE }],
    ["Penny", "penny/model-runtimes", "penny", () => media("penny"),
      { serviceName: "penny", structuredOutputSupported: true, automaticRecovery: true, webSearch: "disabled" }],
  ])("%s runtime offers only skills from its own home", async (_kind, root, scope, readableRoots, options) => {
    const { runtime, runtimeRoot } = runtimeWithOwnSkills(root, scope, readableRoots());
    const session = await AppServerSession.open(model.route(runtime));
    try {
      const listed = await session.listSkills(runtime.cwd);
      expect(listed.map((skill) => skill.name).sort()).toEqual(["own-home-probe", "own-probe"]);
      const ownSources = [["codex-home", "skills"], ["home", ".agents", "skills"]].map((parts) => fs.realpathSync(path.join(runtimeRoot, ...parts)) + path.sep);
      for (const skill of listed) expect(ownSources.some((source) => fs.realpathSync(skill.path).startsWith(source)), skill.path).toBe(true);
      expect(listed.filter((skill) => skill.scope === "system")).toEqual([]);
    } finally { session.close(); }

    model.respondWith(() => [assistantMessage("fake-model-reply")]);
    const conversation = new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), ISOLATED_MODEL_DISABLED_FEATURES, model.route(runtime)),
      60_000, undefined, undefined, 60_000, { ...options, permissionProfile: runtime.permissionProfile });
    try {
      const threadId = await conversation.startOrResume(undefined, runtime.cwd);
      const from = model.requests.length;
      await conversation.reply(threadId, "$host-probe $linked-probe $host-codex-probe $own-probe $own-home-probe please");
      const request = model.modelRequestsSince(from).at(-1)!;
      expect(skillCatalog(request)?.sort()).toEqual(["own-home-probe", "own-probe"]);
      expectOnlyOwnSkills(modelInputText(request));
      expect(request.authorization).toBe(`Bearer ${syntheticKey}`);
    } finally { await conversation.close(); }
  }, 60_000);

  it("a skill input item cannot load a host skill", async () => {
    const { runtime, own } = runtimeWithOwnSkills("group-model-runtimes", "feishu.group.skill-item", media("skill-item"));
    model.respondWith(() => [assistantMessage("fake-model-reply")]);
    const session = await AppServerSession.open(model.route(runtime));
    try {
      const thread = await session.request("thread/start", { cwd: runtime.cwd, approvalPolicy: "never", permissions: runtime.permissionProfile,
        selectedCapabilityRoots: [] }) as { thread: { id: string } };
      const from = model.requests.length;
      // The App Server matches a skill item by the exact path skills/list reports (the real path); an alias is ignored.
      expect(await session.turn(thread.thread.id, [{ type: "text", text: "use these" },
        { type: "skill", name: "host-probe", path: fs.realpathSync(hostSkill) }, { type: "skill", name: "own-probe", path: fs.realpathSync(own) }])).toBe("completed");
      const input = modelInputText(model.modelRequestsSince(from).at(-1)!);
      expect(input).toContain(marker.own);
      expect(input).not.toContain(marker.host);
    } finally { session.close(); }
  }, 60_000);

  it("group research through codex exec offers only its own skills", async () => {
    const { runtime } = runtimeWithOwnSkills("group-model-runtimes", "research-feishu.group.probe");
    model.respondWith(() => [assistantMessage(JSON.stringify({ body: "Fake report.", sources: [{ title: "Example", url: "https://example.com/" }] }))]);
    const research = createScheduledResearch({ executable: resolveCodexExecutable(process.env), timeoutMs: 60_000, groupRuntime: () => model.route(runtime) });
    const from = model.requests.length;
    // The fake model performs no web search, so the research step refuses the report; the request it sent is the subject.
    await expect(research({ signal: new AbortController().signal, destination: { accountId: "feishu.bot.probe", target: "feishu.group.probe" }, name: "Probe research",
      instruction: "$host-probe $linked-probe $host-codex-probe $own-probe $own-home-probe", plannedAt: "2026-11-08T09:00:00.000Z", timezone: "Asia/Shanghai" }))
      .rejects.toThrow("research_search_missing");
    const request = model.modelRequestsSince(from).at(-1)!;
    expect(skillCatalog(request)?.sort()).toEqual(["own-home-probe", "own-probe"]);
    expectOnlyOwnSkills(modelInputText(request));
    expect(request.authorization).toBe(`Bearer ${syntheticKey}`);
  }, 60_000);
});
