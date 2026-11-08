import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authorizeLocalService } from "../e2e/console-session.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";
import { signalProcessGroup } from "./support/process-group.js";

// Full service processes and the public fixture inbound endpoint; never a Tencent send.
// Main-model tool decisions are injected for deterministic Pending setup. Opt in to
// WORKFLOW_SIMULATOR_PENDING_ROUTER=live to test real semantic responses after restart.
// D16 exercises real SIGTERM and persistence. Immediate-exit mutation of production
// main was not performed (safety denied); a separately authorized isolated build
// would be needed to verify that additional negative gate. No phone receipt here.
type State = {
  codex: { status: string; transcript: Array<{ id: string; role: string; text: string; status: string;
    businessResult?: { source: string; results: unknown[] } }> };
  workflows: { runs: Array<{
    runRef: string; workflowId: string; status: string; errorCode?: string;
    effects: Array<{ stepId: string; state: string }>;
  }> };
  fixtureOutbox: Array<{ fileName: string; kind: string; simulated: boolean }>;
  fixtureTextOutbox: Array<{ message: string; simulated: boolean }>;
  workflowModulePermissions: { modules: Array<{ moduleId: string; revision: number; scopes: Array<{ scopeId: string; read: boolean; write: boolean }> }> };
};

const cwd = fileURLToPath(new URL("../", import.meta.url));
const liveRouter = process.env.WORKFLOW_SIMULATOR_PENDING_ROUTER === "live";
const choiceCalls = [{
  namespace: "files", tool: "find",
  arguments: { query: "Agent", include: ["*.md"], sort: { field: "path", direction: "asc" }, limit: 10 },
}, {
  namespace: "weixin", tool: "send_files",
  arguments: {
    disposition: "needs_choice", allowMultiple: true,
    candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })),
  },
}];

describe.skipIf(process.env.CODEX_WEIXIN_PROCESS_TEST !== "1")("full service process restart", () => {
  it.each(["read", "edit", "snapshot"] as const)("D16 SIGTERM drains admitted %s before closing durable resources", async (operation) => {
    const fixture = await startFixture({ gate: operation });
    try {
      const state = await fixture.state();
      const notes = state.workflowModulePermissions.modules.find((module) => module.moduleId === "notes")!;
      await fixture.configurePermissions({ moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
        scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
      const file = { $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } };
      const calls = [{ namespace: "files", tool: "find", arguments: { query: "Agent Alpha.md", match: "literal", limit: 1 } },
        ...(operation === "snapshot" ? [{ namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [file] } }]
          : [{ namespace: "files", tool: "read", arguments: { fileRef: file } },
            ...(operation === "edit" ? [{ namespace: "files", tool: "edit", arguments: { fileRef: file,
              expectedSha256: { $fixtureToolResult: { call: 1, path: ["sha256"] } }, oldText: "Agent", newText: "Edited", replaceAll: true } }] : [])])];
      const inbound = fixture.submit(`停机排空测试：${operation}`, calls);
      void inbound.catch(() => {});
      await fixture.waitHeld();
      const stopping = fixture.stop();
      let stopped = false;
      void stopping.then(() => { stopped = true; }, () => { stopped = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      fixture.release();
      await stopping;
      await inbound;
      await fixture.start();
      const restored = await fixture.state();
      const businessRuns = restored.workflows.runs.filter((run) => run.workflowId !== "fixture.status-check");
      expect(restored.fixtureOutbox).toEqual([]); // Restart must not replay an accepted effect.
      if (operation === "snapshot") {
        expect(businessRuns).toEqual([expect.objectContaining({ status: "succeeded",
          effects: [{ stepId: "send#1", state: "accepted" }] })]);
        expect(reply(restored)).toBe("文件已发送，请查收。");
      } else {
        expect(businessRuns).toEqual([]);
      }
      if (operation === "edit") expect(fixture.alpha()).toContain("Edited");
      const next = await fixture.inbound("你好，请只回复收到。");
      expect(reply(next)).toBe("这是 fixture Codex 回复。"); // Explicit protocol fixture, not semantic evaluation.
    } finally { fixture.release(); await fixture.close(); }
  }, 120_000);

  it.each(["accepted", "running"] as const)("production_resolver_retirement %s notifies once and preserves normal inbound after restart", async (legacy) => {
    const fixture = await startFixture({ legacy, liveMain: true });
    try {
      // The notifier and channels start after the Codex service reports idle, so the notice arrives
      // during the rest of startup: a process wait (tests/support/process-wait.ts), bounded here by
      // the fixture start bound.
      await expect.poll(async () => (await fixture.state()).fixtureTextOutbox.filter((entry) =>
        entry.message === "之前的文件查找任务已结束。若仍需要这个文件，请重新告诉我。" ), { timeout: 20_000 }).toHaveLength(1);
      const retired = await fixture.state();
      expect(retired.workflows.runs).toEqual([expect.objectContaining({ status: "failed",
        errorCode: "workflow_file_resolver_retired", effects: [] })]);
      expect(retired.fixtureOutbox).toEqual([]);
      const received = await fixture.inbound("你好，请只回复收到。");
      expectOrdinaryAcknowledgement(received);
      expect(received.fixtureOutbox).toEqual([]);
      await fixture.restart();
      const again = await fixture.inbound("你好，请只回复收到。");
      expectOrdinaryAcknowledgement(again);
      expect(again.fixtureTextOutbox.filter((entry) => entry.message.includes("之前的文件查找任务"))).toEqual([]);
      expect(again.workflows.runs).toEqual(retired.workflows.runs);
      expect(again.fixtureOutbox).toEqual([]);
    } finally { await fixture.close(); }
  }, 240_000);
  it.skipIf(process.env.CODEX_WEIXIN_ACCESS_TEST !== "1")("production_access_rotation uses a fresh real model thread, preserves memory and rejects a revoked pending file", async () => {
    const fixture = await startFixture({ liveMain: true, seedMemory: true });
    try {
      // No injected model calls: the real main agent must find the two fixture files.
      const waiting = await fixture.inbound("把 Agent 笔记原文件发给我");
      const pending = waiting.workflows.runs.find((run) => run.status === "needs_input");
      expect(pending).toBeDefined();
      expect(reply(waiting)).toContain("Agent Alpha.md");
      expect(reply(waiting)).toContain("Agent Beta.md");
      expect(waiting.fixtureOutbox).toEqual([]);
      const before = fixture.session();
      const notes = waiting.workflowModulePermissions.modules.find((module) => module.moduleId === "notes")!;
      await fixture.configurePermissions({ moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
        scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: false, write: false })) });
      await fixture.restart();
      const after = fixture.session();
      expect(after.threadId).not.toBe(before.threadId);
      expect(after.accessContextEpoch).toBe((before.accessContextEpoch ?? 0) + 1);
      expect(after.toolContractHash).toBe(before.toolContractHash);
      expect((await fixture.state()).workflows.runs).toContainEqual(expect.objectContaining({ runRef: pending!.runRef, status: "needs_input" }));

      const refused = await fixture.inbound("第二个");
      expect(refused.workflows.runs).toHaveLength(waiting.workflows.runs.length);
      expect(refused.workflows.runs.find((run) => run.runRef === pending!.runRef)).toMatchObject({
        status: "failed", errorCode: "local_file_permission_changed", effects: [],
      });
      expect(refused.fixtureOutbox).toEqual([]);
      expect(fixture.snapshots()).toEqual([]);
      expect(reply(refused)).toBe("没有读取这个文件的权限，请在“本地权限”中启用后重试。");
      const remembered = await fixture.inbound("我之前记录的测试项目内部代号是什么？只回答代号。");
      expect(reply(remembered)).toBe("琥珀灯塔-7319");
      expect(remembered.fixtureOutbox).toEqual([]);
      expect(remembered.workflows.runs).toEqual(refused.workflows.runs);
    } finally { await fixture.close(); }
  }, 240_000);

  it("production_pending_restart_and_new_goal_workflow preserves the original Run and supersedes a new pending", async () => {
    const fixture = await startFixture();
    try {
      const waiting = await fixture.inbound("把 Agent 笔记原文件发给我", choiceCalls);
      const pending = waiting.workflows.runs.find((run) => run.status === "needs_input");
      expect(pending).toBeDefined();
      expect(reply(waiting)).toContain("Agent Alpha.md");
      expect(reply(waiting)).toContain("Agent Beta.md");
      expect(waiting.fixtureOutbox).toEqual([]);
      expect(fixture.snapshots()).toEqual([]);
      const oldPid = fixture.pid();

      await fixture.restart();
      expect(fixture.pid()).not.toBe(oldPid);
      const restored = await fixture.state();
      expect(restored.workflows.runs).toContainEqual(expect.objectContaining({ runRef: pending!.runRef, status: "needs_input" }));
      expect(restored.fixtureOutbox).toEqual([]);
      expect(reply(restored)).toBe(reply(waiting));

      const completed = await fixture.inbound("我想要第二个，第一份就不用发了");
      expect(completed.workflows.runs).toHaveLength(waiting.workflows.runs.length);
      const sent = completed.workflows.runs.find((run) => run.runRef === pending!.runRef);
      expect(sent).toMatchObject({ status: "succeeded", effects: [{ stepId: "send#1", state: "accepted" }] });
      expect(completed.fixtureOutbox).toEqual([expect.objectContaining({ fileName: "Agent Beta.md", kind: "file", simulated: true })]);
      expect(reply(completed)).toBe("文件已发送，请查收。");
      const snapshots = fixture.snapshots();
      expect(snapshots).toHaveLength(1);

      await fixture.restart();
      const settled = await fixture.inbound("你好，请只回复收到。");
      expect(settled.workflows.runs.find((run) => run.runRef === pending!.runRef)).toEqual(sent);
      expect(settled.fixtureOutbox).toEqual([]);
      expect(fixture.snapshots()).toEqual(snapshots);

      const another = await fixture.inbound("把 Agent 笔记原文件发给我", choiceCalls);
      const oldPending = another.workflows.runs.find((run) => run.status === "needs_input");
      expect(oldPending).toBeDefined();
      await fixture.restart();
      const newGoal = await fixture.inbound("不选笔记了，把相册里的 holiday 图片发给我", [{
        namespace: "files", tool: "find",
        arguments: { scopeRefs: [{ $fixtureScopeLabel: "Pictures" }], query: "holiday", include: ["*.png"], limit: 1 },
      }, {
        namespace: "media", tool: "send",
        arguments: { kind: "image", source: "local", disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } }] },
      }]);
      expect(newGoal.workflows.runs.find((run) => run.runRef === oldPending!.runRef)).toMatchObject({
        status: "cancelled", errorCode: "workflow_pending_superseded", effects: [],
      });
      expect(newGoal.workflows.runs.filter((run) => run.status === "needs_input")).toEqual([]);
      expect(newGoal.workflows.runs).toHaveLength(another.workflows.runs.length + 1);
      expect(newGoal.fixtureOutbox).toEqual([expect.objectContaining({ fileName: "holiday.png", kind: "image", simulated: true })]);
      expect(reply(newGoal)).toBe("图片已发送，请查收。");
    } finally {
      await fixture.close();
    }
  }, 180_000);
});

function lastReply(state: State) {
  return state.codex.transcript.filter((entry) => entry.role === "assistant" && entry.status !== "ack").at(-1);
}

function reply(state: State): string | undefined {
  return lastReply(state)?.text;
}

// The live main model may repeat the prompt's full stop. The reply must still be the main
// model's own ordinary answer, carrying no workflow result.
function expectOrdinaryAcknowledgement(state: State): void {
  expect(lastReply(state)).toMatchObject({ text: expect.stringMatching(/^收到。?$/u), status: "accepted",
    businessResult: { source: "main_model", results: [] } });
}

async function startFixture(options: { gate?: "read" | "edit" | "snapshot"; liveMain?: boolean; seedMemory?: boolean; legacy?: "accepted" | "running" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-process-restart-"));
  // Business files live outside the protected state directory, as in production.
  const business = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-process-restart-business-"));
  if (options.legacy === "running") await seedCrashedResolver(directory);
  if (options.legacy === "accepted") {
    // Historical accepted-before-plan boundary via the public Engine API; no SQL state injection.
    const targets = new WorkflowRunTargetStore(path.join(directory, "workflow-targets.sqlite"));
    const engine = new WorkflowEngine(path.join(directory, "workflows.sqlite"), {
      onRunAccepted: ({ runId }) => targets.bind(runId, "fixture-bot", "fixture-user@im.wechat"),
    });
    try {
      await engine.submit({ source: "weixin", triggerId: "retirement-before-plan", occurredAt: Date.now(),
        accountRef: "fixture-bot", targetRef: "fixture-user@im.wechat", requestedWorkflowId: "notes.send-file-resolved" });
    } finally { await engine.close(); targets.close(); }
  }
  if (options.seedMemory) {
    new AccountMemoryStore(path.join(directory, "memory")).apply("fixture-bot", {
      batchId: "fixture-preference", basedOnRevision: 0, evidenceEntryIds: new Set(["preference-turn"]),
      // A unique fact prevents the model's usual pnpm preference from looking
      // like successful recall when no account memory was actually injected.
      mutations: [{ op: "add", id: "project-code", category: "projects", value: "测试项目的内部代号是 琥珀灯塔-7319。", evidenceEntryIds: ["preference-turn"], confidence: 1 }],
    });
  }
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let generation = 0;
  let gateHeld = false;
  const evidence: unknown[] = [];
  // The settings API requires an authorized browser; the authorization persists across the restarts below.
  let cookie: string | undefined;
  const authorized = async () => cookie ??= await authorizeLocalService(directory);
  const state = async (): Promise<State> => {
    const response = await fetch(`${base}/api/state`, { headers: { cookie: await authorized() }, signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`fixture_state_http_${response.status}`);
    return response.json() as Promise<State>;
  };
  const stop = async () => {
    if (!child?.pid) return;
    const process = child;
    const pid = child.pid;
    const exited = once(process, "exit");
    const reap = () => {
      // Reap only this test's isolated process group, including its App Server children.
      signalProcessGroup(pid, "SIGKILL");
      child = undefined;
    };
    try {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill("SIGTERM");
        const timer = setTimeout(() => process.kill("SIGKILL"), 15_000);
        try {
          const [code, signal] = await exited;
          expect({ code, signal }, `graceful shutdown failed: ${directory}`).toEqual({ code: 0, signal: null });
        } finally { clearTimeout(timer); }
      }
    } finally {
      reap();
    }
  };
  const start = async () => {
    generation += 1;
    const log = fs.openSync(path.join(directory, `process-${generation}.log`), "a", 0o600);
    try {
      child = spawn(process.execPath, ["--import", "tsx", ...(options.gate ? ["--import", "./tests/fixtures/sandbox-transport-gate.mjs"] : []), "src/main.ts"], {
        cwd, detached: true, stdio: ["ignore", log, log, "ipc"],
        env: { ...process.env, DEMO_MODE: "fixture", PORT: String(port),
          FIXTURE_GATE_OPERATION: generation === 1 ? options.gate : undefined,
          WORKFLOW_SIMULATOR_MODEL: options.liveMain ? "live" : "fixture", WORKFLOW_SIMULATOR_PENDING_ROUTER: liveRouter ? "live" : "fixture",
          WORKFLOW_FIXTURE_STATE_DIRECTORY: directory, WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business },
      });
      child.on("message", (message) => {
        if (message && typeof message === "object" && "kind" in message && message.kind === "sandbox-held") gateHeld = true;
      });
      child.channel?.unref();
    } finally { fs.closeSync(log); }
    await expect.poll(async () => {
      if (child?.exitCode !== null) throw new Error(`fixture_process_exited: ${directory}`);
      try { return ["idle", "disabled"].includes((await state()).codex.status); } catch { return false; }
    }, { timeout: options.liveMain ? 60_000 : 20_000 }).toBe(true);
    evidence.push({ event: "started", generation, pid: child?.pid });
  };
  try { await start(); } catch (error) { await stop(); throw error; }
  return {
    state, pid: () => child?.pid,
    stop, start,
    release: () => { if (child?.connected) child.send("release-sandbox"); },
    waitHeld: () => expect.poll(() => gateHeld, { timeout: 10_000 }).toBe(true),
    alpha: () => {
      const matches = fs.readdirSync(business, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name === "Agent Alpha.md");
      expect(matches).toHaveLength(1);
      return fs.readFileSync(path.join(matches[0]!.parentPath, matches[0]!.name), "utf8");
    },
    submit: async (text: string, modelToolCalls: unknown[]) => {
      const response = await fetch(`${base}/api/fixture/workflow/inbound`, {
        method: "POST", headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ text, modelToolCalls }), signal: AbortSignal.timeout(30_000),
      });
      expect(response.ok).toBe(true);
    },
    session: () => {
      const session = new CodexServiceStore(path.join(directory, "codex-service.json")).load().targetSessions[0]!;
      evidence.push({ event: "session-observed", session });
      return session;
    },
    configurePermissions: async (selection: unknown) => {
      const response = await fetch(`${base}/api/workflows/module-permissions/configure`, {
        method: "POST", headers: { "content-type": "application/json", origin: base, cookie: await authorized() }, body: JSON.stringify(selection),
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      evidence.push({ event: "permissions-saved", selection });
    },
    // Independent filesystem-effect oracle supplements (not replaces) public Run/outbox assertions.
    snapshots: () => {
      const root = path.join(directory, "workflow-file-artifacts", "snapshots");
      return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort() : [];
    },
    restart: async () => { await stop(); await start(); },
    inbound: async (text: string, modelToolCalls?: unknown[]): Promise<State> => {
      const before = await state();
      const ids = new Set(before.codex.transcript.map((entry) => entry.id));
      const response = await fetch(`${base}/api/fixture/workflow/inbound`, {
        method: "POST", headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ text, ...(modelToolCalls ? { modelToolCalls } : {}) }),
        signal: AbortSignal.timeout(90_000),
      });
      expect(response.ok).toBe(true);
      let result = before;
      await expect.poll(async () => {
        result = await state();
        const entries = result.codex.transcript.filter((entry) => !ids.has(entry.id));
        const userIndex = entries.findIndex((entry) => entry.role === "user" && entry.text === text);
        return userIndex >= 0 && entries.slice(userIndex + 1).some((entry) => entry.role === "assistant" &&
          ["accepted", "partial", "agent_failed", "send_failed"].includes(entry.status));
      }, { timeout: 90_000 }).toBe(true);
      evidence.push({ text, reply: reply(result), runs: result.workflows.runs, outbox: result.fixtureOutbox, textOutbox: result.fixtureTextOutbox });
      return result;
    },
    close: async () => {
      await stop();
      fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.info(`Process restart evidence: ${directory}`);
    },
  };
}

async function seedCrashedResolver(directory: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/legacy-resolver-crash.ts", directory], {
    cwd, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const run = await new Promise<unknown>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`legacy_bootstrap_timeout: ${stderr}`)), 10_000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`legacy_bootstrap_exited: ${stderr}`)); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (!stdout.includes("\n")) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.split("\n")[0]!)); } catch (error) { reject(error); }
      });
    });
    expect(run).toMatchObject({ status: "running", plan: { steps: [
      expect.objectContaining({ stepId: "resolve", status: "pending", attemptCount: 1 }),
      expect.objectContaining({ stepId: "choose", status: "pending", attemptCount: 0 }),
      expect.objectContaining({ stepId: "send", status: "pending", attemptCount: 0 }),
    ] } });
    fs.writeFileSync(path.join(directory, "legacy-before-crash.json"), JSON.stringify(run, null, 2));
  } finally { child.kill("SIGKILL"); await closed; }
}
