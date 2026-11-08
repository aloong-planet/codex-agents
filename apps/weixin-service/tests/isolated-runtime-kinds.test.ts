import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createIsolatedRuntime, ISOLATED_RUNTIME_KINDS, isolatedConversationOptions } from "../src/isolated-runtime-kinds.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const stateDirectory = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-kinds-")); directories.push(directory); return directory; };
const environment = { PATH: "/usr/bin:/bin" };

// Roots and options as main.ts passed them at 4ec653b, before the table existed. Saved threads and sessions live under
// these roots in production, so moving one would orphan them.
it("keeps each isolated runtime kind at its existing root and with its existing options", () => {
  const state = stateDirectory();
  const media = path.join(state, "media"); fs.mkdirSync(media);
  const rootOf = (runtime: { cwd: string }) => path.dirname(runtime.cwd);
  const groups = state;
  expect(rootOf(createIsolatedRuntime("feishuGroup", { stateDirectory: state, instance: "feishu.group.probe", mediaRoot: media, environment })))
    .toBe(path.join(groups, "group-model-runtimes", "feishu.group.probe"));
  expect(rootOf(createIsolatedRuntime("dispatchCoordinator", { stateDirectory: state, environment }))).toBe(path.join(groups, "group-model-runtimes", "dispatch-coordinator"));
  const agentScope = `dispatch-${"a".repeat(64)}`;
  expect(rootOf(createIsolatedRuntime("dispatchAgent", { stateDirectory: state, instance: agentScope, mediaRoot: media, environment })))
    .toBe(path.join(groups, "group-model-runtimes", agentScope));
  expect(rootOf(createIsolatedRuntime("pendingRouter", { stateDirectory: state, environment }))).toBe(path.join(groups, "group-model-runtimes", "pending-router"));
  expect(rootOf(createIsolatedRuntime("groupMemoryCurator", { stateDirectory: state, environment }))).toBe(path.join(groups, "group-model-runtimes", "memory-curator"));
  expect(rootOf(createIsolatedRuntime("research", { stateDirectory: state, instance: "feishu.group.probe", environment })))
    .toBe(path.join(groups, "group-model-runtimes", "research-feishu.group.probe"));
  expect(rootOf(createIsolatedRuntime("penny", { stateDirectory: state, mediaRoot: media, environment }))).toBe(path.join(groups, "penny", "model-runtimes", "penny"));

  const runtime = createIsolatedRuntime("pendingRouter", { stateDirectory: state, environment });
  expect(isolatedConversationOptions("feishuGroup", runtime, { structuredOutputSupported: true }))
    .toEqual({ serviceName: "feishu_group", webSearch: "live", automaticRecovery: true, structuredOutputSupported: true, permissionProfile: "group" });
  expect(isolatedConversationOptions("dispatchCoordinator", runtime, { structuredOutputSupported: false }))
    .toEqual({ serviceName: "feishu_dispatch_coordinator", webSearch: "disabled", structuredOutputSupported: false, permissionProfile: "group" });
  expect(isolatedConversationOptions("dispatchAgent", runtime, { structuredOutputSupported: true, agentId: "alice" }))
    .toEqual({ serviceName: "feishu_agent_alice", webSearch: "live", automaticRecovery: true, structuredOutputSupported: true, permissionProfile: "group" });
  const { runtimeProfile: pending, ...pendingOptions } = isolatedConversationOptions("pendingRouter", runtime, { structuredOutputSupported: true });
  expect(pendingOptions).toEqual({ serviceName: "feishu_group_pending", webSearch: "disabled", permissionProfile: "group" });
  expect(pending?.model).toBe("gpt-5.6-luna");
  const { runtimeProfile: curator, ...curatorOptions } = isolatedConversationOptions("groupMemoryCurator", runtime, { structuredOutputSupported: true });
  expect(curatorOptions).toEqual({ serviceName: "feishu_group_memory", webSearch: "disabled", permissionProfile: "group" });
  expect(curator?.model).toBe("gpt-5.6-terra");
  // Penny needs structured output regardless of the capability probe (main.ts refuses to start it otherwise).
  expect(isolatedConversationOptions("penny", runtime, { structuredOutputSupported: false }))
    .toEqual({ serviceName: "penny", webSearch: "disabled", automaticRecovery: true, structuredOutputSupported: true, permissionProfile: "group" });
});

it("lets only the kinds that read inbound media name a media root", () => {
  const state = stateDirectory();
  const media = path.join(state, "media"); fs.mkdirSync(media);
  for (const kind of ["feishuGroup", "dispatchAgent", "penny"] as const) {
    const instance = { feishuGroup: { instance: "feishu.group.media" }, dispatchAgent: { instance: "dispatch-media" }, penny: {} }[kind];
    const runtime = createIsolatedRuntime(kind, { stateDirectory: state, ...instance, mediaRoot: media, environment });
    expect(fs.readFileSync(path.join(runtime.env.CODEX_HOME!, "config.toml"), "utf8")).toContain(`${JSON.stringify(fs.realpathSync(media))} = "read"`);
  }
  for (const kind of ["dispatchCoordinator", "pendingRouter", "groupMemoryCurator"] as const) {
    expect(() => createIsolatedRuntime(kind, { stateDirectory: state, mediaRoot: media, environment })).toThrow("isolated_runtime_media_unexpected");
  }
  expect(() => createIsolatedRuntime("research", { stateDirectory: state, instance: "feishu.group.media", mediaRoot: media, environment })).toThrow("isolated_runtime_media_unexpected");
});

// The tests drive ISOLATED_RUNTIME_KINDS; this keeps main.ts from creating an isolated runtime any other way, so the
// tested list cannot drift from the one production runs. The three owner-private App Servers run in the owner's own Codex
// home by design (ADR-0023 follow-up) and are the only other App Servers main.ts may start.
it("main.ts creates isolated runtimes only from the runtime-kind table", () => {
  const main = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main.ts"), "utf8");
  expect(main).not.toMatch(/\bcreateIsolatedModelRuntime\b/u);
  expect(main).not.toMatch(/\bISOLATED_MODEL_DISABLED_FEATURES\b/u);
  const appServers = [...main.matchAll(/\bspawnStdioAppServer\(([^)]*)\)/gu)].map((match) => match[1]!.trim());
  expect(appServers.sort()).toEqual([
    "codexExecutable, MAIN_WEIXIN_DISABLED_FEATURES",
    "codexExecutable, MEMORY_CURATOR_DISABLED_FEATURES",
    "codexExecutable, PENDING_RESPONSE_DISABLED_FEATURES",
  ]);
  const kinds = new Set([...main.matchAll(/\b(?:isolatedConversation|createIsolatedRuntime)\(\s*"(\w+)"/gu)].map((match) => match[1]));
  expect([...kinds].sort()).toEqual(Object.keys(ISOLATED_RUNTIME_KINDS).sort());
  expect(Object.keys(ISOLATED_RUNTIME_KINDS).sort()).toEqual(["dispatchAgent", "dispatchCoordinator", "feishuGroup", "groupMemoryCurator", "pendingRouter", "penny", "research"]);
});
