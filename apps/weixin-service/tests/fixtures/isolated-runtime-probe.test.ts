// Self-checks of the isolated-runtime probe: it must report host and bundled skills when they are reachable, and play
// scripted output back. Opt-in like its users (CODEX_ISOLATED_RUNTIME_TEST=1); CI has no Codex executable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexConversation } from "../../src/codex-conversation.js";
import { createIsolatedModelRuntime, ISOLATED_MODEL_DISABLED_FEATURES } from "../../src/isolated-model-runtime.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../../src/stdio-app-server-transport.js";
import { AppServerSession, assistantMessage, FakeResponsesEndpoint, modelInputText, plantSkill, runsInstalledAppServer, sampleBundledSkill,
  skillCatalog } from "./isolated-runtime-probe.js";

describe.skipIf(!runsInstalledAppServer)("isolated runtime probe", () => {
  let work: string, hostHome: string, environment: NodeJS.ProcessEnv, model: FakeResponsesEndpoint;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-runtime-probe-"));
    hostHome = path.join(work, "host-home");
    plantSkill(path.join(hostHome, ".agents", "skills"), "host-probe", "HOST-AGENTS-BODY-5B3F");
    plantSkill(path.join(work, "other-repository", "skills"), "linked-probe", "HOST-LINKED-BODY-8C4A");
    fs.symlinkSync(path.join(work, "other-repository", "skills", "linked-probe"), path.join(hostHome, ".agents", "skills", "linked-probe"));
    const hostCodexHome = path.join(work, "host-codex-home"); fs.mkdirSync(hostCodexHome);
    fs.writeFileSync(path.join(hostCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic-probe" }));
    environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: hostHome, CODEX_HOME: hostCodexHome };
    model = await FakeResponsesEndpoint.start();
  });
  afterAll(async () => { await model?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  it("detects host and bundled skills when a runtime is left on the host HOME", async () => {
    const isolated = createIsolatedModelRuntime({ root: path.join(work, "runtimes"), scope: "leaky", environment });
    // The regression this probe guards against: the host HOME passed through and bundled skills switched back on.
    const leaky = { ...isolated, env: { ...isolated.env, HOME: hostHome }, configOverrides: [...isolated.configOverrides, "skills.bundled.enabled=true"] };
    const session = await AppServerSession.open(model.route(leaky));
    try {
      const listed = await session.listSkills(leaky.cwd);
      expect(listed.map((skill) => skill.name)).toEqual(expect.arrayContaining(["host-probe", "linked-probe"]));
      expect(listed.some((skill) => skill.scope === "system")).toBe(true);
      const bundled = await sampleBundledSkill(session, leaky.cwd);
      const thread = await session.request("thread/start", { cwd: leaky.cwd, approvalPolicy: "never" }) as { thread: { id: string } };
      const from = model.requests.length;
      expect(await session.turn(thread.thread.id, [{ type: "text", text: `$host-probe $${bundled.name} please` }])).toBe("completed");
      const request = model.modelRequestsSince(from).at(-1)!;
      expect(skillCatalog(request)).toEqual(expect.arrayContaining(["host-probe", "linked-probe"]));
      expect(modelInputText(request)).toContain("HOST-AGENTS-BODY-5B3F");
      // Positive control for the bundled-skill absence checks: with bundled skills on, naming one injects its body.
      expect(modelInputText(request)).toContain(bundled.bodyLine);
    } finally { session.close(); }
  }, 60_000);

  it("plays scripted output items back to the runtime", async () => {
    const runtime = createIsolatedModelRuntime({ root: path.join(work, "runtimes"), scope: "scripted", environment });
    model.respondWith(() => [assistantMessage("SCRIPTED-REPLY-5E1F")]);
    const conversation = new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), ISOLATED_MODEL_DISABLED_FEATURES, model.route(runtime)),
      60_000, undefined, undefined, 60_000, { permissionProfile: runtime.permissionProfile, webSearch: "disabled" });
    try {
      const threadId = await conversation.startOrResume(undefined, runtime.cwd);
      await expect(conversation.reply(threadId, "hello")).resolves.toBe("SCRIPTED-REPLY-5E1F");
    } finally { await conversation.close(); }
  }, 60_000);
});
