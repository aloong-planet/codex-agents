import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeDispatchRuntime, CodexDispatchExecutor, DISPATCH_RUNTIME_EXIT_WAIT_MS, DISPATCH_RUNTIME_IDLE_MS, DISPATCH_RUNTIME_LIMIT,
  type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import type { DispatchAssignment, DispatchJob } from "../src/agent-dispatch-types.js";
import { compactRuntimeHome } from "../src/runtime-home-compaction.js";
import { RuntimePool } from "../src/runtime-pool.js";
import { conversation } from "./support/dispatch-runtime.js";
import { homeListing, keptListing, seedExecutorHome } from "./support/runtime-home.js";

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
    agents: [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes,
    createRuntime: (_job, scope) => { scopes.push(scope); return { agent: conversations[scopes.length - 1]!, cwd: `/isolated/${scope}` }; },
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    profile: () => ({ instructions: "", memoryScope: "group", tools: { definitions: () => [], contractHash: contract,
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
    agents: [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes, createRuntime: (_job, scope) => createRuntime(scope),
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    profile: () => ({ instructions: "", memoryScope: "group", tools: { definitions: () => [], contractHash: () => "contract-1",
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
