// Executor home compaction (agent-dispatch::QR-002) on the installed Codex App Server, with its model requests routed to the
// loopback fake endpoint of tests/fixtures/isolated-runtime-probe.ts. The executor, the pool and the runtime are built by a
// copy of main.ts's construction (the production close, createIsolatedRuntime, spawnIsolatedAppServer and each spawned
// transport's `exited`). Opt-in (CODEX_ISOLATED_RUNTIME_TEST=1, `pnpm test:isolated-runtime`) because CI has no Codex
// executable; rerun after every Codex upgrade, since what a retry needs from the home is the App Server's behavior.
// Gap: main.ts's own exit wiring for Executors (collecting each spawned transport's `exited` and returning it as the runtime's
// `exited`) is driven by no case: real-main cases run Executors on the fixture App Server, which has no process, and this
// file uses its copy. Retest: a live dispatch run, or the owner's acceptance, checks that a released Executor's home holds
// only its rollout and that no `dispatch_executor_home_deferred` line appears.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDispatchRuntime, CodexDispatchExecutor, type DispatchRuntime, type ExecutorToolHost } from "../src/agent-dispatch-executor.js";
import type { DispatchAssignment, DispatchJob } from "../src/agent-dispatch-types.js";
import { CodexConversation } from "../src/codex-conversation.js";
import { spawnIsolatedAppServer } from "../src/isolated-model-runtime.js";
import { createIsolatedRuntime, isolatedConversationOptions } from "../src/isolated-runtime-kinds.js";
import { compactRuntimeHome } from "../src/runtime-home-compaction.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { assistantMessage, FakeResponsesEndpoint, modelInputText, runsInstalledAppServer } from "./fixtures/isolated-runtime-probe.js";
import { homeListing } from "./support/runtime-home.js";

describe.skipIf(!runsInstalledAppServer)("Executor home compaction on the installed Codex App Server", () => {
  let work: string, environment: NodeJS.ProcessEnv, model: FakeResponsesEndpoint;
  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-runtime-compaction-"));
    const hostCodexHome = path.join(work, "host-codex-home"); fs.mkdirSync(hostCodexHome);
    fs.writeFileSync(path.join(hostCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic-ticket27" }));
    environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(work, "host-home"), CODEX_HOME: hostCodexHome };
    model = await FakeResponsesEndpoint.start();
  });
  afterAll(async () => { await model?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const rolloutsIn = (home: string) => homeListing(home).filter((entry) => /^codex-home\/sessions\/.+\/rollout-[^/]+\.jsonl$/u.test(entry));
  /** The listing of a home compacted to `rollout`: the rollout and the directories leading to it. */
  const keptFor = (rollout: string) => [...rollout.split("/").slice(0, -1).map((_part, index, parts) => `${parts.slice(0, index + 1).join("/")}/`), rollout].sort();
  const hostCatalog = createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true, delivery: true, schedules: true });
  const tools: ExecutorToolHost = { definitions: () => hostCatalog.definitions(), contractHash: () => "contract-1",
    execute: async () => ({ contentItems: [{ type: "inputText", text: "TOOL-OUTPUT-MARKER" }], success: true }) };
  const job = (attempt = 0): DispatchJob => ({ id: "om_compaction", bindingHash: "binding-alpha", agentId: "alice", senderAccountId: "cli_alice",
    summary: "整理商品文案", status: "running", attempt, ...(attempt > 0 ? { retry: true } : {}),
    event: { key: "om_compaction", accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner", conversationType: "group",
      messageId: "om_compaction", source: "text", text: "帮我整理闲鱼商品描述", receivedAt: 1 } });
  const assignment = (attempt = 0): DispatchAssignment => ({ id: "om_compaction:assignment:0", requestId: "om_compaction", teamId: "alice", profileId: "executor-1",
    profileName: "能力档 1", executor: "执行者 1", title: "整理商品文案", brief: "整理闲鱼商品描述", status: "running", attempt });

  /** An executor as main.ts builds it, over the installed App Server; records each runtime's home at creation and at process exit. */
  function executorOn(stateDirectory: string, memory: () => string) {
    const homesAtCreation: Array<{ home: string; listing: string[] }> = [], homesAtExit: Array<{ listing: string[]; rollouts: Record<string, string> }> = [];
    const threads: Array<{ saved: string | undefined; started: string }> = [], reports: string[] = [];
    const media = path.join(stateDirectory, "media"); fs.mkdirSync(media, { recursive: true });
    const executor = new CodexDispatchExecutor(path.join(stateDirectory, "agent-sessions.sqlite"), {
      agents: [{ id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
      runtimes: new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: closeDispatchRuntime }),
      createRuntime: (created, scope, profileTools) => {
        const home = path.join(stateDirectory, "group-model-runtimes", scope);
        homesAtCreation.push({ home, listing: fs.existsSync(home) ? homeListing(home) : [] });
        const runtime = createIsolatedRuntime("dispatchAgent", { stateDirectory, instance: scope, mediaRoot: media, environment });
        const exits: Array<Promise<void>> = [];
        const conversation = new CodexConversation(() => {
          const transport = spawnIsolatedAppServer(resolveCodexExecutable(process.env), model.route(runtime, "gpt-5.6-terra"));
          exits.push(transport.exited);
          return transport;
        }, 60_000, profileTools, undefined, 60_000, isolatedConversationOptions("dispatchAgent", runtime, { structuredOutputSupported: true, agentId: created.agentId }));
        return {
          agent: { runTurn: (...input: Parameters<CodexConversation["runTurn"]>) => conversation.runTurn(...input),
            startOrResume: async (saved: string | undefined, ...rest: [string, string[]?]) => {
              const started = await conversation.startOrResume(saved, ...rest); threads.push({ saved, started }); return started;
            },
            releaseThread: (threadId: string) => conversation.releaseThread(threadId), interruptThread: (threadId: string) => conversation.interruptThread(threadId),
            close: () => conversation.close() },
          cwd: runtime.cwd,
          exited: async () => {
            await Promise.all(exits);
            homesAtExit.push({ listing: homeListing(home), rollouts: Object.fromEntries(rolloutsIn(home).map((entry) => [entry, sha256(path.join(home, entry))])) });
          },
        };
      },
      tools: { bind: () => ({ snapshot: () => ({ owner: "model" }), seal: () => {}, drain: async () => {}, release: async () => {} }) },
      profile: () => ({ instructions: "", memoryScope: "group", tools }),
      contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "gpt-5.6-terra", effort: "low" }),
      memory, capture: async () => {}, existingResult: () => undefined,
      homes: { root: path.join(stateDirectory, "group-model-runtimes"), compact: compactRuntimeHome }, report: (code) => reports.push(code),
    });
    return { executor, homesAtCreation, homesAtExit, threads, reports };
  }
  const answer = (message: string, status: string) => assistantMessage(JSON.stringify({ message, results: [{ subject: "整理商品文案", status }] }));

  it("keeps only the rollout, byte for byte, once a released Executor's App Server has exited", async () => {
    const run = executorOn(fs.mkdtempSync(path.join(work, "state-")), () => "");
    model.respondWith(() => [answer("商品文案已整理好。", "completed")]);
    try {
      await expect(run.executor.run(job(), assignment(), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    } finally { await run.executor.close(); }
    const { home } = run.homesAtCreation[0]!;
    const [atExit] = run.homesAtExit;
    const [rollout] = Object.keys(atExit!.rollouts);
    expect(atExit!.listing).toEqual(expect.arrayContaining(["codex-home/state_5.sqlite-wal", "codex-home/config.toml", "workspace/", rollout!]));
    expect(homeListing(home)).toEqual(keptFor(rollout!));
    expect(sha256(path.join(home, rollout!))).toBe(atExit!.rollouts[rollout!]);
    expect(run.reports).toEqual([]);
  }, 90_000);

  it("resumes a compacted failed Assignment's own thread on retry, with the first attempt's process in the model input", async () => {
    let memoryReads = 0;
    // Recalled memory differs between the attempts, so turn 1's user text can reach the retry only through the thread's history.
    const run = executorOn(fs.mkdtempSync(path.join(work, "state-")), () => memoryReads++ === 0 ? "TURN1-USER-MARKER" : "");
    const first = hostCatalog.definitions()[0]!;
    const call = first.type === "namespace" ? { name: first.tools[0]!.name, namespace: first.name } : { name: first.name };
    let served = 0;
    model.respondWith(() => served++ === 0
      ? [{ type: "function_call", call_id: "host-call-1", name: call.name, arguments: "{}", ...("namespace" in call ? { namespace: call.namespace } : {}) }]
      : served === 2 ? [answer("TURN1-ANSWER-MARKER 缺少商品照片，未能完成。", "failed")] : [answer("商品文案已整理好。", "completed")]);
    try {
      await expect(run.executor.run(job(), assignment(), new AbortController().signal)).resolves.toMatchObject({ status: "failed" });
      const from = model.requests.length;
      // The retry starts at once; the pool starts its runtime only after the failed attempt's close, compaction included, has settled.
      await expect(run.executor.run(job(1), assignment(1), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
      const [rollout] = Object.keys(run.homesAtExit[0]!.rollouts);
      expect(run.homesAtCreation.map(({ listing }) => listing)).toEqual([[], keptFor(rollout!)]);
      expect(run.threads).toEqual([{ saved: undefined, started: run.threads[0]!.started }, { saved: run.threads[0]!.started, started: run.threads[0]!.started }]);
      const retryInput = modelInputText(model.modelRequestsSince(from)[0]!);
      for (const marker of ["TURN1-USER-MARKER", "TOOL-OUTPUT-MARKER", "TURN1-ANSWER-MARKER"]) expect(retryInput, marker).toContain(marker);
    } finally { await run.executor.close(); }
    const { home } = run.homesAtCreation[0]!;
    expect(rolloutsIn(home)).toHaveLength(1);
    expect(homeListing(home)).toEqual(keptFor(rolloutsIn(home)[0]!));
    expect(run.reports).toEqual([]);
  }, 120_000);
});
