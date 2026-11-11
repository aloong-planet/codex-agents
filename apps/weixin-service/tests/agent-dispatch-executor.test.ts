import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeDispatchRuntime, CodexDispatchExecutor, DISPATCH_RUNTIME_EXIT_WAIT_MS, DISPATCH_RUNTIME_IDLE_MS, DISPATCH_RUNTIME_LIMIT, executorEvent,
  type DispatchRuntime, type ExecutorToolHost } from "../src/agent-dispatch-executor.js";
import type { DispatchAssignment, DispatchJob } from "../src/agent-dispatch-types.js";
import type { ChannelTurnAdapter } from "../src/channel-turn-adapter.js";
import type { InboundContent } from "../src/channel-contract.js";
import { ConsoleAudit } from "../src/console-audit.js";
import { createIsolatedRuntime } from "../src/isolated-runtime-kinds.js";
import { compactRuntimeHome } from "../src/runtime-home-compaction.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { SkillLibrary } from "../src/skill-library.js";
import { conversation } from "./support/dispatch-runtime.js";
import { homeListing, keptListing, rolloutPath, seedExecutorHome } from "./support/runtime-home.js";

// Exercises the production executor with the runtime pool; only the external App Server conversation is substituted,
// as in agent-dispatch-classifier.test.ts. Its reply follows MAIN_REPLY_OUTPUT_SCHEMA.
// Gap: main.ts passes the defaults asserted below to the one dispatch pool; no fixture case fills 16 slots or lives
// 5 minutes, so that wiring is exercised only by a live run or a fixture case that fills the pool.
// Gap: home compaction's `compaction_failed` (session store unreadable) and `dispatch_executor_homes_unreadable` (runtimes
// root unreadable) diagnostics have no case; both only report and remove nothing.

function job(id: string): DispatchJob {
  return { id, bindingHash: "binding-alpha", agentId: "alice", senderAccountId: "cli_alice", summary: "整理商品文案", status: "running", attempt: 0,
    event: { key: id, accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner", conversationType: "group",
      messageId: `om_${id}`, source: "text", text: "帮我整理商品文案", receivedAt: 1 } };
}
function assignment(id: string, attempt = 0): DispatchAssignment {
  return { id, requestId: "request-one", teamId: "alice", profileId: "executor-1", profileName: "能力档 1", executor: "执行者 1",
    title: "整理商品文案", brief: "整理闲鱼商品描述", status: "running", attempt };
}

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function executorWith(runtimes: RuntimePool<DispatchRuntime>, conversations: Array<ReturnType<typeof conversation>>, contract = () => "contract-1") {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-")); directories.push(directory);
  const scopes: string[] = [];
  const executor = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
    agents: () => [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes,
    createRuntime: (_job, scope) => { scopes.push(scope); return { agent: conversations[scopes.length - 1]!, cwd: `/isolated/${scope}` }; },
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: contract,
      execute: async () => { throw new Error("tool calls are not part of this case"); } } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  return { executor, scopes };
}

it("starts a new runtime instead of resuming the old thread when the profile's tool contract changes", async () => {
  const conversations = [conversation("thread-1"), conversation("thread-2")];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 1000, close: ({ agent }) => agent.close() });
  let contract = "contract-1";
  const { executor, scopes } = executorWith(runtimes, conversations, () => contract);
  try {
    await expect(executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    contract = "contract-2";
    await expect(executor.run(job("request-one"), assignment("assignment-a", 1), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    expect(scopes).toHaveLength(2);
    expect(scopes[1]).not.toBe(scopes[0]);
    expect(conversations[1]!.startOrResume.mock.calls[0]![0]).toBeUndefined();
  } finally { await executor.close(); }
});

it("closes an Executor's runtime as soon as its Assignment's turn ends", async () => {
  vi.useFakeTimers();
  const conversations = [conversation("thread-1")];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: ({ agent }) => agent.close() });
  const { executor } = executorWith(runtimes, conversations);
  try {
    await expect(executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(conversations[0]!.close).toHaveBeenCalledOnce();
  } finally { await executor.close(); }
});

it("retries an Assignment on its own persisted thread, and gives another Assignment its own session", async () => {
  const conversations = [conversation("thread-A"), conversation("thread-A"), conversation("thread-B")];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: ({ agent }) => agent.close() });
  const { executor, scopes } = executorWith(runtimes, conversations);
  try {
    await executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal);
    await executor.run(job("request-one"), assignment("assignment-a", 1), new AbortController().signal);
    await executor.run(job("request-one"), assignment("assignment-b"), new AbortController().signal);
    expect(scopes).toHaveLength(3);
    expect(scopes[1]).toBe(scopes[0]);
    expect(scopes[2]).not.toBe(scopes[0]);
    expect(conversations.map(({ startOrResume }) => startOrResume.mock.calls[0]![0])).toEqual([undefined, "thread-A", undefined]);
  } finally { await executor.close(); }
});

it("ends the wait of a cancelled request for a pool slot without starting a runtime for it", async () => {
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 1, idleMs: 1000, close: ({ agent }) => agent.close() });
  let releaseSlot!: () => void;
  const holding = runtimes.use("other-work", () => ({ agent: conversation("other-thread"), cwd: "/isolated/other" }),
    () => new Promise<void>((resolve) => { releaseSlot = resolve; }));
  const { executor, scopes } = executorWith(runtimes, [conversation("thread-1")]);
  try {
    const abort = new AbortController();
    let outcome: unknown = "still waiting";
    void executor.run(job("request-one"), assignment("assignment-a"), abort.signal).then((result) => { outcome = result; }, (error: unknown) => { outcome = error; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort(new Error("dispatch_cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toEqual(new Error("dispatch_cancelled"));
    releaseSlot(); await holding;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scopes).toEqual([]);
  } finally { await executor.close(); }
});

// Home compaction (agent-dispatch::QR-002): each runtime seeds the file set a real App Server turn leaves in its home, and its
// process exit is a promise the case controls.
function homeExecutor(runtimes: RuntimePool<DispatchRuntime>, root: string, database: string, createRuntime: (scope: string) => DispatchRuntime, reports: string[]) {
  return new CodexDispatchExecutor(database, {
    agents: () => [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes, createRuntime: (_job, scope) => createRuntime(scope),
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: () => "contract-1",
      execute: async () => { throw new Error("tool calls are not part of this case"); } } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
    homes: { root, compact: compactRuntimeHome }, report: (code) => reports.push(code),
  });
}
const scratch = () => { const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-homes-")); directories.push(directory); return directory; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("compacts a released Executor's home once its process has exited, before a retry's runtime starts on it", async () => {
  const root = scratch(), reports: string[] = [];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: closeDispatchRuntime });
  let exit!: () => void;
  const firstExit = new Promise<void>((resolve) => { exit = resolve; });
  const atCreation: string[][] = [], conversations = [conversation("thread-A"), conversation("thread-A")];
  const executor = homeExecutor(runtimes, root, join(scratch(), "agent-sessions.sqlite"), (scope) => {
    const home = join(root, scope), index = atCreation.length;
    atCreation.push(existsSync(home) ? homeListing(home) : []);
    if (index === 0) seedExecutorHome(home, [{ threadId: "thread-A" }]);
    return { agent: conversations[index]!, cwd: join(home, "workspace"), exited: () => index === 0 ? firstExit : Promise.resolve() };
  }, reports);
  try {
    await executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal);
    const retry = executor.run(job("request-one"), assignment("assignment-a", 1), new AbortController().signal);
    await settle(); await settle();
    const home = join(root, readdirSync(root)[0]!);
    expect(atCreation).toHaveLength(1);
    expect(homeListing(home)).toContain("codex-home/state_5.sqlite-wal");
    exit();
    await expect(retry).resolves.toMatchObject({ status: "completed" });
    expect(atCreation[1]).toEqual(keptListing("thread-A"));
    expect(conversations[1]!.startOrResume.mock.calls[0]![0]).toBe("thread-A");
    expect(reports).toEqual([]);
  } finally { await executor.close(); }
});

// skill-library::REQ-002, with the real runtime creation, library and compaction; only the App Server conversation is substituted.
// Its turn reads the skills folder as the App Server would find it, and leaves the rollout a real turn leaves.
it("gives an Executor's home exactly its profile's skills in the request's versions at every runtime creation, a retry's after compaction included, and carries them on each turn", async () => {
  const state = scratch(), root = join(state, "group-model-runtimes"), reports: string[] = [];
  const library = new SkillLibrary({ directory: join(state, "skill-library"), audit: new ConsoleAudit({ directory: state }), needed: () => undefined });
  const folder = (name: string, body: string) => {
    const source = join(scratch(), name);
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 的做法\n---\n${body}\n`);
    writeFileSync(join(source, "references", "rules.md"), `${name} rules\n`);
    return source;
  };
  const tripSource = folder("trip-check", "trip-v1");
  const trip = await library.import(tripSource, (await library.read(tripSource)).fingerprint, {});
  // A second skill of the library that the profile does not select: it must never reach the home.
  const mealSource = folder("meal-plan", "meal-v1");
  await library.import(mealSource, (await library.read(mealSource)).fingerprint, {});

  const atCreation: string[][] = [], duringTurn: Array<Record<string, string>> = [], carried: unknown[][] = [];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: closeDispatchRuntime });
  const executor = new CodexDispatchExecutor(join(scratch(), "agent-sessions.sqlite"), {
    agents: () => [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes,
    createRuntime: (_job, scope, _tools, _agentId, skills) => {
      const home = join(root, scope);
      atCreation.push(existsSync(home) ? homeListing(home) : []);
      let written: ReturnType<SkillLibrary["materialize"]> = [];
      const runtime = createIsolatedRuntime("dispatchAgent", { stateDirectory: state, instance: scope, authHome: join(state, "no-auth"), environment: { PATH: "/usr/bin:/bin" },
        skills: (directory) => { written = library.materialize(skills, directory); } });
      const agent = conversation("thread-A");
      agent.runTurn.mockImplementation(async (_threadId, turn) => {
        carried.push((await (turn as ChannelTurnAdapter).prepare()).input.filter((item) => item.type !== "text"));
        const loaded = join(home, "codex-home", "skills");
        duringTurn.push(Object.fromEntries(homeListing(loaded).filter((file) => !file.endsWith("/")).map((file) => [file, readFileSync(join(loaded, file), "utf8")])));
        mkdirSync(dirname(join(home, rolloutPath("thread-A"))), { recursive: true });
        writeFileSync(join(home, rolloutPath("thread-A")), `${JSON.stringify({ type: "session_meta", payload: { id: "thread-A" } })}\n`);
        return { owner: "model_owned", finalText: '{"message":"已整理好商品文案。","results":[]}' };
      });
      return { agent, cwd: runtime.cwd, skills: written };
    },
    tools: { bind: () => ({ promptLines: [], seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" }), release: () => {} }) as never },
    // The request's definitions version names version 1 of the one skill its profile selects.
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, skills: [{ id: trip.id, version: 1 }],
      tools: { definitions: () => [], contractHash: () => "contract-1", execute: async () => { throw new Error("tool calls are not part of this case"); } } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
    homes: { root, compact: compactRuntimeHome }, report: (code) => reports.push(code),
  });
  try {
    await executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal);
    // The owner re-imports the skill before the retry: the library's current version is 2 from here on.
    writeFileSync(join(tripSource, "SKILL.md"), "---\nname: trip-check\ndescription: trip-check 的做法\n---\ntrip-v2\n");
    const state2 = await library.compare(trip.id) as { fingerprint: string };
    expect((await library.reimport(trip.id, state2.fingerprint, {})).version).toBe(2);
    await executor.run(job("request-one"), assignment("assignment-a", 1), new AbortController().signal);

    const snapshot = { [`${trip.id}/SKILL.md`]: "---\nname: trip-check\ndescription: trip-check 的做法\n---\ntrip-v1\n", [`${trip.id}/references/rules.md`]: "trip-check rules\n" };
    expect(duringTurn).toEqual([snapshot, snapshot]);
    // Each turn carries the skill as an input item naming its SKILL.md in the home, which is what puts it before the model.
    const item = { type: "skill", name: "trip-check", path: join(realpathSync(root), readdirSync(root)[0]!, "codex-home", "skills", trip.id, "SKILL.md") };
    expect(carried).toEqual([[item], [item]]);
    // The retry's runtime was created on a home compacted to its rollout: the skills were written again, not kept.
    expect(atCreation).toEqual([[], keptListing("thread-A")]);
    expect(reports).toEqual([]);
  } finally { await executor.close(); }
});

// skill-library failure mode: skills that cannot be written leave no runtime, so the Assignment fails instead of running with
// other content, and its run holds no pool slot afterwards.
it("fails an Assignment's run without starting a turn when its skills cannot be written, and leaves the slot to the next run", async () => {
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 1, idleMs: 60_000, close: ({ agent }) => agent.close() });
  const agent = conversation("thread-B");
  let creations = 0;
  const executor = new CodexDispatchExecutor(join(scratch(), "agent-sessions.sqlite"), {
    agents: () => [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes,
    // As the service's own creation does when the library no longer holds a version the request names.
    createRuntime: (_job, scope, _tools, _agentId, skills) => {
      creations++;
      if (skills.some(({ version }) => version === 7)) throw new Error("skill_version_unavailable");
      return { agent, cwd: `/isolated/${scope}` };
    },
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    profile: (_job, assigned) => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" },
      ...(assigned.id === "assignment-a" ? { skills: [{ id: "skill-aaaaaaaa", version: 7 }] } : {}),
      tools: { definitions: () => [], contractHash: () => "contract-1", execute: async () => { throw new Error("tool calls are not part of this case"); } } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  try {
    await expect(executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal)).rejects.toThrow(/^skill_version_unavailable$/u);
    expect(agent.startOrResume).not.toHaveBeenCalled();
    await expect(executor.run(job("request-one"), assignment("assignment-b"), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    expect(creations).toBe(2);
  } finally { await executor.close(); }
});

it("leaves a home whose process does not exit to the next start's sweep, which also compacts a pre-05 home", async () => {
  vi.useFakeTimers();
  const root = scratch(), database = join(scratch(), "agent-sessions.sqlite"), reports: string[] = [];
  const pre05 = join(root, `dispatch-${"0".repeat(64)}`);
  seedExecutorHome(pre05, [{ threadId: "thread-old" }]);
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 1, idleMs: 60_000, close: closeDispatchRuntime });
  const executor = homeExecutor(runtimes, root, database, (scope) => {
    seedExecutorHome(join(root, scope), [{ threadId: "thread-A" }]);
    return { agent: conversation("thread-A"), cwd: join(root, scope, "workspace"), exited: () => new Promise<void>(() => {}) };
  }, reports);
  await executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal);
  await vi.advanceTimersByTimeAsync(DISPATCH_RUNTIME_EXIT_WAIT_MS);
  const home = join(root, readdirSync(root).find((name) => join(root, name) !== pre05)!);
  expect(homeListing(home)).toContain("codex-home/state_5.sqlite-wal");
  expect(reports).toEqual([`dispatch_executor_home_deferred:process_running:${basename(home)}`]);
  // The pool slot is free again: other work starts at a limit of one.
  await expect(runtimes.use("other-work", () => ({ agent: conversation("other-thread"), cwd: "/isolated/other" }), async () => "ran")).resolves.toBe("ran");
  await executor.close();
  vi.useRealTimers();
  // The next start: a new executor on the same session database sweeps every Executor home before any work.
  const restarted = homeExecutor(new RuntimePool<DispatchRuntime>({ limit: 1, idleMs: 60_000, close: closeDispatchRuntime }), root, database,
    () => { throw new Error("no runtime starts in this case"); }, reports);
  try {
    restarted.compactHomes();
    expect(homeListing(home)).toEqual(keptListing("thread-A"));
    expect(homeListing(pre05)).toEqual(keptListing("thread-old"));
    expect(reports).toHaveLength(1);
  } finally { await restarted.close(); }
});

it("keeps a released home whole and reports it when its thread's rollout is missing", async () => {
  const root = scratch(), reports: string[] = [];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: closeDispatchRuntime });
  let before: string[] = [];
  // The home holds an older thread's rollout only, so compacting without the session's thread would remove its files.
  const executor = homeExecutor(runtimes, root, join(scratch(), "agent-sessions.sqlite"), (scope) => {
    seedExecutorHome(join(root, scope), [{ threadId: "thread-older" }]);
    before = homeListing(join(root, scope));
    return { agent: conversation("thread-A"), cwd: join(root, scope, "workspace"), exited: () => Promise.resolve() };
  }, reports);
  await executor.run(job("request-one"), assignment("assignment-a"), new AbortController().signal);
  await executor.close();
  const [name] = readdirSync(root);
  expect(homeListing(join(root, name!))).toEqual(before);
  expect(reports).toEqual([`dispatch_executor_home_kept:rollout_missing:${name}`]);
});

it("defaults to 16 running runtimes and release after 5 idle minutes", () => {
  expect(DISPATCH_RUNTIME_LIMIT).toBe(16);
  expect(DISPATCH_RUNTIME_IDLE_MS).toBe(300_000);
});

// Each Executor turn keys its side effects (workflow runs, file-query and media evidence) to its own Assignment.
it.each([
  ["a planned Assignment", {}, { sequence: 7 }, "request-one#executor-7", "帮我整理商品文案"],
  ["its retry", {}, { sequence: 7, attempt: 1 }, "request-one#executor-7", "帮我整理商品文案"],
  ["a rerun on a supplement", {}, { sequence: 7, attempt: 1, input: { ...job("om_supplement").event, text: "补充：改成下午" } }, "om_supplement#executor-7", "补充：改成下午"],
  ["an Assignment stored before several ran per request", {}, {}, "request-one", "帮我整理商品文案"],
  ["an Assignment stored before, on a promoted supplement", { executionEvent: { ...job("om_late").event, text: "补充：加一项" } }, {}, "om_late", "补充：加一项"],
] satisfies Array<[string, Partial<DispatchJob>, Partial<DispatchAssignment>, string, string]>)("keys the Executor turn of %s", (_case, request, part, key, text) => {
  const event = executorEvent({ ...job("request-one"), ...request }, { ...assignment("request-one:assignment:0:1"), ...part });
  expect({ key: event.key, text: event.text }).toEqual({ key, text });
});

it.each([
  ["names a refused tool call as the cause of a failure", true, '{"message":"编辑工具不可用，未修改。","results":[{"subject":"修改","status":"blocked"}]}', "tool_refused"],
  ["leaves the cause to the Executor's report when no call was refused", false, '{"message":"缺少商品成色。","results":[{"subject":"文案","status":"blocked"}]}', undefined],
])("%s", async (_case, refuse, reply, cause) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-refusal-")); directories.push(directory);
  const agent = conversation("thread-1", reply);
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: ({ agent: owned }) => owned.close() });
  let offered: ExecutorToolHost | undefined;
  // The runtime calls the tool host it was given during its turn, as the App Server does for a model's tool call.
  agent.runTurn.mockImplementation(async () => {
    await offered!.execute("edit", {}, { threadId: "thread-1", turnId: "turn-1", namespace: refuse ? "files" : "notes" });
    return { owner: "model_owned", finalText: reply };
  });
  const executor = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
    agents: () => [{ id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }], runtimes,
    createRuntime: (_job, scope, tools) => { offered = tools; return { agent, cwd: `/isolated/${scope}` }; },
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: () => "contract-1",
      // The refusal shape of the profile tool host for a call outside the profile's allowlist.
      execute: async (_tool, _arguments, context) => context?.namespace === "files"
        ? { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code: "agent_profile_tool_refused", retryable: false, action: "stop" } }) }] }
        : { success: true, contentItems: [{ type: "inputText", text: "{}" }] } } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  try {
    const result = await executor.run(job("request-one"), assignment("request-one:assignment:0:1"), new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(result.cause).toBe(cause);
  } finally { await executor.close(); }
});

// agent-dispatch::CON-003: what an Executor is told it may do. An Executor whose tool host grants it an MCP server is told that
// what its tools do may be done; every other Executor keeps the sentence that rules out operating a website. The host lists no
// tool in any row: a granted server may list nothing at the moment of a turn, while the Executor's thread keeps the tools it
// started with.
const PLAIN_AUTHORITY = "只能使用本轮已授权能力，不能执行终端命令或操作网站后台；无法执行的步骤必须明确标记未执行。";
it.each<[string, (() => boolean) | undefined, string]>([
  ["whose tool host knows no MCP server", undefined, PLAIN_AUTHORITY],
  ["that is granted no MCP server", () => false, PLAIN_AUTHORITY],
  ["that is granted an MCP server, also while the server lists no tool", () => true,
    "只能使用本轮已授权能力：提供给你的工具能完成的操作可以执行，除此之外不能执行终端命令或操作网站后台；无法执行的步骤必须明确标记未执行。"],
])("tells an Executor %s what it may do", async (_case, grantsMcp, sentence) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-authority-")); directories.push(directory);
  const agent = conversation("thread-1");
  const prompts: string[] = [];
  agent.runTurn.mockImplementation(async (_thread, turn) => {
    const prepared = await (turn as ChannelTurnAdapter).prepare();
    prompts.push(JSON.stringify(prepared.input)); await prepared.binding?.release();
    return { owner: "model_owned", finalText: '{"message":"已整理好商品文案。","results":[]}' };
  });
  const executor = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
    agents: () => [{ id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes: new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: ({ agent: owned }) => owned.close() }),
    createRuntime: (_job, scope) => ({ agent, cwd: `/isolated/${scope}` }),
    tools: { bind: () => ({ promptLines: [], seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" }), release: () => {} }) as never },
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "alice", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: () => "contract-1",
      execute: async () => { throw new Error("tool calls are not part of this case"); }, ...(grantsMcp ? { grantsMcp } : {}) } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  try {
    await expect(executor.run(job("request-one"), assignment("request-one:assignment:0:1"), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(sentence);
    expect(prompts[0]!.split("只能使用本轮已授权能力")).toHaveLength(2);
  } finally { await executor.close(); }
});

// agent-dispatch::REQ-010/AC-01: a cross-team Assignment runs under its own team, so what its Executor produces goes out under
// that team's Team Leader, with the application frozen when the team took its part (agent-dispatch::REQ-008/AC-04). The runtime's
// turn prepares itself as the App Server does, which binds the workflow tools to the turn's event.
it.each([
  ["runs a cross-team Assignment as its own team, whose Team Leader's application sends what it produces", "cli_bill"],
  ["refuses a cross-team Assignment whose team's application was replaced since it took its part", "cli_bill_before"],
])("%s", async (_case, frozen) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-cross-team-")); directories.push(directory);
  const agent = conversation("thread-1");
  const prompts: string[] = [], bound: InboundContent[] = [], created: string[] = [];
  agent.runTurn.mockImplementation(async (_thread, turn) => {
    const prepared = await (turn as ChannelTurnAdapter).prepare();
    prompts.push(JSON.stringify(prepared.input)); await prepared.binding?.release();
    return { owner: "model_owned", finalText: '{"message":"脚本已写好。","results":[{"subject":"脚本","status":"completed"}]}' };
  });
  const executor = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
    agents: () => [{ id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }, { id: "bill", name: "Bill", responsibility: "衣食住行", senderAccountId: "cli_bill" }],
    runtimes: new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 60_000, close: ({ agent: owned }) => owned.close() }),
    createRuntime: (_job, scope, _tools, agentId) => { created.push(agentId); return { agent, cwd: `/isolated/${scope}` }; },
    tools: { bind: (_thread, event) => { bound.push(event); return { promptLines: [], seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" }), release: () => {} } as never; } },
    profile: () => ({ instructions: "", memoryScope: { kind: "profile", teamId: "bill", profileId: "executor-1" }, tools: { definitions: () => [], contractHash: () => "contract-1",
      execute: async () => { throw new Error("tool calls are not part of this case"); } } }),
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  try {
    const run = executor.run({ ...job("request-one"), senders: { bill: frozen } }, { ...assignment("request-one:assignment:0:3"), teamId: "bill", executor: "执行者 3",
      title: "编写脚本" }, new AbortController().signal);
    if (frozen !== "cli_bill") {
      await expect(run).rejects.toThrow("dispatch_role_invalid");
      expect(created).toEqual([]);
      return;
    }
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(created).toEqual(["bill"]);
    expect(bound.map(({ agentId, senderAccountId }) => ({ agentId, senderAccountId }))).toEqual([{ agentId: "bill", senderAccountId: "cli_bill" }]);
    expect(prompts[0]).toContain("你是 Bill 团队的执行者 3");
  } finally { await executor.close(); }
});
