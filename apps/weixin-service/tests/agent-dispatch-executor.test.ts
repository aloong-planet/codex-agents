import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexDispatchExecutor, DISPATCH_RUNTIME_IDLE_MS, DISPATCH_RUNTIME_LIMIT, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import type { DispatchJob } from "../src/agent-dispatch-types.js";
import type { CodexConversation } from "../src/codex-conversation.js";
import { RuntimePool } from "../src/runtime-pool.js";

// Exercises the production executor with the runtime pool; only the external App Server conversation is substituted,
// as in agent-dispatch-classifier.test.ts. Its reply follows MAIN_REPLY_OUTPUT_SCHEMA.
// Gap: main.ts passes the defaults asserted below to the one dispatch pool; no fixture case fills 16 slots or lives
// 5 minutes, so that wiring is exercised only by a live run or a fixture case that fills the pool.

function conversation(threadId: string) {
  return {
    startOrResume: vi.fn<CodexConversation["startOrResume"]>().mockResolvedValue(threadId),
    runTurn: vi.fn<CodexConversation["runTurn"]>().mockResolvedValue({ owner: "model_owned", finalText: '{"message":"已整理好商品文案。","results":[]}' }),
    releaseThread: vi.fn<CodexConversation["releaseThread"]>(),
    interruptThread: vi.fn<CodexConversation["interruptThread"]>().mockResolvedValue(undefined),
    close: vi.fn<CodexConversation["close"]>().mockResolvedValue(undefined),
  };
}

function job(id: string): DispatchJob {
  return { id, bindingHash: "binding-alpha", agentId: "alice", senderAccountId: "cli_alice", summary: "整理商品文案", status: "running", attempt: 0,
    event: { key: id, accountId: "cli_sam", target: "feishu.group.oc_alpha", senderId: "ou_owner", conversationType: "group",
      messageId: `om_${id}`, source: "text", text: "帮我整理商品文案", receivedAt: 1 } };
}

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function executorWith(runtimes: RuntimePool<DispatchRuntime>, conversations: Array<ReturnType<typeof conversation>>) {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-")); directories.push(directory);
  const scopes: string[] = [];
  const executor = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
    agents: [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes,
    createRuntime: (_job, scope) => { scopes.push(scope); return { agent: conversations[scopes.length - 1]!, cwd: `/isolated/${scope}` }; },
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
  return { executor, scopes };
}

it("resumes a released specialist session from its persisted thread on a new runtime", async () => {
  vi.useFakeTimers();
  const conversations = [conversation("thread-1"), conversation("thread-2")];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 1000, close: ({ agent }) => agent.close() });
  const { executor, scopes } = executorWith(runtimes, conversations);
  try {
    await expect(executor.run(job("request-one"), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(conversations[0]!.close).toHaveBeenCalledOnce();
    await expect(executor.run(job("request-two"), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    expect(scopes).toHaveLength(2);
    expect(scopes[1]).toBe(scopes[0]);
    expect(conversations[1]!.startOrResume.mock.calls[0]![0]).toBe("thread-1");
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
    void executor.run(job("request-one"), abort.signal).then((result) => { outcome = result; }, (error: unknown) => { outcome = error; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort(new Error("dispatch_cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toEqual(new Error("dispatch_cancelled"));
    releaseSlot(); await holding;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scopes).toEqual([]);
  } finally { await executor.close(); }
});

it("defaults to 16 running runtimes and release after 5 idle minutes", () => {
  expect(DISPATCH_RUNTIME_LIMIT).toBe(16);
  expect(DISPATCH_RUNTIME_IDLE_MS).toBe(300_000);
});
