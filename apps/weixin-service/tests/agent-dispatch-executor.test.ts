import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexDispatchExecutor, type DispatchRuntime } from "../src/agent-dispatch-executor.js";
import type { DispatchJob } from "../src/agent-dispatch-types.js";
import type { CodexConversation } from "../src/codex-conversation.js";
import { RuntimePool } from "../src/runtime-pool.js";

// Exercises the production executor with the runtime pool; only the external App Server conversation is substituted,
// as in agent-dispatch-classifier.test.ts. Its reply follows MAIN_REPLY_OUTPUT_SCHEMA.

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

it("resumes a released specialist session from its persisted thread on a new runtime", async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "dispatch-executor-")); directories.push(directory);
  const conversations = [conversation("thread-1"), conversation("thread-2")];
  const scopes: string[] = [];
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: 2, idleMs: 1000, close: ({ agent }) => agent.close() });
  const executor = new CodexDispatchExecutor(join(directory, "agent-sessions.sqlite"), {
    agents: [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
      { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }],
    runtimes,
    createRuntime: (_job, scope) => { scopes.push(scope); return { agent: conversations[scopes.length - 1]!, cwd: `/isolated/${scope}` }; },
    tools: { bind: () => { throw new Error("tool binding is not part of this case"); } },
    contextRevision: () => "revision-1", authorized: () => true, model: () => ({ model: "fixture-model", effort: "low" }),
    memory: () => "", capture: async () => {}, existingResult: () => undefined,
  });
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
