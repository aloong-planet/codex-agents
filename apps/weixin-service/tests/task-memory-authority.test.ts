import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { CodexAccountMemoryCurator, MEMORY_CURATOR_RUNTIME_PROFILE, MEMORY_CURATOR_DISABLED_FEATURES } from "../src/codex-account-memory-curator.js";
import { AccountMemoryToolHost } from "../src/account-memory-tool-host.js";

import { CodexConversation } from "../src/codex-conversation.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../src/stdio-app-server-transport.js";
import { AccountMemorySystem } from "../src/account-memory-system.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-memory-authority-")); roots.push(root);
  const store = new AccountMemoryStore(root, () => 1000);
  store.apply("fixture-bot", { batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["old-request"]), mutations: [
    { op: "add", id: "news-scope", category: "constraints", value: "日报的 Hacker News 仅限 AI 和 LLM 内容。", evidenceEntryIds: ["old-request"], confidence: 1 },
    { op: "add", id: "answer-style", category: "preferences", value: "普通回答使用中文。", evidenceEntryIds: ["old-request"], confidence: 1 },
  ] });
  const binding = { accountId: "fixture-bot", jobId: "job", batchId: "reconcile", evidenceEntryIds: ["current-user"],
    evidenceTexts: { "current-user": "现在执行日报，另外普通回答继续使用中文。" }, mutationPolicy: { mode: "reconcile" as const },
    managedTasks: [{ id: "task-news", name: "AI 新闻日报", revision: 3, template: "daily_ai_news" }],
    candidateEntryIds: ["news-scope", "answer-style"],
  };
  const decision = { kind: "task_settings", taskId: "task-news", match: "日报的 Hacker News 仅限 AI 和 LLM 内容。", retainedValue: null, evidenceEntryIds: ["current-user"] };
  return { root, store, binding, decision, host: new AccountMemoryToolHost(store) };
}

describe("task memory authority", () => {
  it("passes host task ownership through the existing curator without granting it task mutation tools", async () => {
    const { store, host, binding, decision } = setup();
    let prompt: Record<string, unknown> = {};
    const curator = new CodexAccountMemoryCurator({
      startOrResume: async () => "fixture-curator", close: () => {},
      reply: async (_thread, text) => {
        prompt = JSON.parse(String(text)) as Record<string, unknown>;
        return JSON.stringify({ batchId: "reconcile", basedOnRevision: 1, decisions: [decision] });
      },
    }, host, "/fixture");
    const input = { jobId: "job", batchId: "reconcile", accountId: "fixture-bot", basedOnRevision: 1,
      candidateEntries: store.read("fixture-bot").entries, managedTasks: binding.managedTasks,
      trigger: "automatic" as const, mutationPolicy: { mode: "reconcile" as const },
      turns: [{ userEntry: { id: "current-user", text: "现在执行日报，另外普通回答继续使用中文。", createdAt: 1000 } }],
    };
    await expect(curator.curate(input)).resolves.toMatchObject({ status: "committed" });
    expect(prompt.managedTasks).toEqual([{ id: "task-news", name: "AI 新闻日报", revision: 3, template: "daily_ai_news" }]);
    expect(store.read("fixture-bot").entries.map((entry) => entry.id)).toEqual(["answer-style"]);
  });
  it("retires a matched task setting while preserving unrelated personal memory", async () => {
    const { store, host, binding, decision } = setup();
    await expect(host.commit(binding, { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] }))
      .resolves.toMatchObject({ status: "committed", receipt: { removed: 1, revision: 2 } });
    expect(store.read("fixture-bot").entries.map(({ id, value }) => ({ id, value })))
      .toEqual([{ id: "answer-style", value: "普通回答使用中文。" }]);
    expect(store.read("fixture-bot").markdown).not.toContain("仅限 AI");
  });
  it("replays a committed retirement after reopening without resolving the removed memory again", async () => {
    const { root, host, binding, decision } = setup();
    await host.commit(binding, { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] });
    const restored = new AccountMemoryStore(root);
    await expect(new AccountMemoryToolHost(restored).commit(binding, { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] }))
      .resolves.toMatchObject({ status: "committed", receipt: { removed: 1, revision: 2 } });
    expect(restored.read("fixture-bot").revision).toBe(2);
    expect(restored.read("fixture-bot").entries.map((entry) => entry.id)).toEqual(["answer-style"]);
  });
  it("retains the original audit value and preserves the independent part of a mixed memory", async () => {
    const { store, host, binding, decision } = setup();
    store.apply("fixture-bot", { batchId: "mixed-seed", basedOnRevision: 1, evidenceEntryIds: new Set(["mixed-user"]), mutations: [
      { op: "update", id: "news-scope", value: "日报只看人工智能；我平时喜欢简短回答。", evidenceEntryIds: ["mixed-user"], confidence: 1 },
    ] });
    await host.commit(binding, { batchId: "reconcile", basedOnRevision: 2,
      decisions: [{ ...decision, match: "日报只看人工智能；我平时喜欢简短回答。", retainedValue: "平时喜欢简短回答。" }] });
    expect(store.read("fixture-bot").entries.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: "news-scope", value: "平时喜欢简短回答。" }, { id: "answer-style", value: "普通回答使用中文。" },
    ]);
    expect(store.supersededTaskSettings("fixture-bot")).toEqual([expect.objectContaining({
      taskId: "task-news", taskRevision: 3, retainedValue: "平时喜欢简短回答。", evidenceEntryIds: ["current-user"],
      entry: expect.objectContaining({ id: "news-scope", value: "日报只看人工智能；我平时喜欢简短回答。", evidenceEntryIds: ["mixed-user"] }),
    })]);
  });

  it("does not restore a retired setting on later extraction while saving a separate preference", async () => {
    const { root, store, host, binding, decision } = setup();
    await host.commit(binding, { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] });
    const restored = new AccountMemoryStore(root);
    await new AccountMemoryToolHost(restored).commit({ ...binding, batchId: "later" }, { batchId: "later", basedOnRevision: 2, decisions: [
      { kind: "remember", category: "constraints", value: "日报的 Hacker News 仅限 AI 和 LLM 内容。", evidenceEntryIds: ["current-user"], confidence: 1 },
      { kind: "remember", category: "preferences", value: "示例优先使用 TypeScript。", evidenceEntryIds: ["current-user"], confidence: 1 },
    ] });
    expect(restored.read("fixture-bot").entries.map((entry) => entry.value)).toEqual(["普通回答使用中文。", "示例优先使用 TypeScript。"]);
    expect(restored.supersededTaskSettings("fixture-bot")).toHaveLength(1);
    expect(store.supersededTaskSettings("other-bot")).toEqual([]);
  });

  it.each(["unbound-task", "foreign-evidence", "unseen-memory", "partial-match"])("rejects %s without retiring any memory", async (failure) => {
    const { store, host, binding, decision } = setup();
    const request = { ...decision, ...(failure === "unbound-task" ? { taskId: "foreign-task" } : {}),
      ...(failure === "foreign-evidence" ? { evidenceEntryIds: ["foreign-user"] } : {}),
      ...(failure === "partial-match" ? { match: "Hacker News" } : {}) };
    const result = host.commit(failure === "unseen-memory" ? { ...binding, candidateEntryIds: [] } : binding,
      { batchId: "reconcile", basedOnRevision: 1, decisions: [request] });
    if (failure === "unbound-task" || failure === "foreign-evidence") await expect(result).rejects.toThrow(/memory_(?:task_authority|evidence)_invalid/u);
    else await expect(result).resolves.toMatchObject({ status: "needs_clarification", reason: "target_missing" });
    expect(store.read("fixture-bot").revision).toBe(1);
    expect(store.read("fixture-bot").entries).toHaveLength(2);
    expect(store.supersededTaskSettings("fixture-bot")).toEqual([]);
  });

  it("rolls back both retirement and its audit if another decision fails validation", async () => {
    const { store, host, binding, decision } = setup();
    await expect(host.commit(binding, { batchId: "reconcile", basedOnRevision: 1, decisions: [decision,
      { kind: "remember", category: "preferences", value: "", evidenceEntryIds: ["current-user"], confidence: 1 },
    ] })).rejects.toThrow("memory_value_invalid");
    expect(store.read("fixture-bot").revision).toBe(1);
    expect(store.read("fixture-bot").entries).toHaveLength(2);
    expect(store.supersededTaskSettings("fixture-bot")).toEqual([]);
    expect(store.receipt("fixture-bot", "reconcile")).toBeUndefined();
  });

  it("rejects a stale memory revision without retiring a concurrently corrected value", async () => {
    const { store, host, binding, decision } = setup();
    store.apply("fixture-bot", { batchId: "concurrent", basedOnRevision: 1, evidenceEntryIds: new Set(["concurrent-user"]), mutations: [
      { op: "update", id: "answer-style", value: "普通回答使用英文。", evidenceEntryIds: ["concurrent-user"], confidence: 1 },
    ] });
    await expect(host.commit(binding, { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] })).rejects.toThrow("memory_revision_conflict");
    expect(store.read("fixture-bot").revision).toBe(2);
    expect(store.read("fixture-bot").entries.map((entry) => entry.value)).toEqual(["日报的 Hacker News 仅限 AI 和 LLM 内容。", "普通回答使用英文。"]);
    expect(store.supersededTaskSettings("fixture-bot")).toEqual([]);
  });

  it("retires the bound task setting during an explicit memory correction", async () => {
    const { store, host, binding, decision } = setup();
    await expect(host.commit({ ...binding, mutationPolicy: { mode: "single_update", targetId: "news-scope",
      replacement: "日报 Hacker News 不限主题。", evidenceEntryId: "current-user" } },
    { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] }))
      .resolves.toMatchObject({ status: "committed", receipt: { removed: 1 } });
    expect(store.read("fixture-bot").entries.map((entry) => entry.value)).toEqual(["普通回答使用中文。"]);
  });

  it.each(["wrong-target", "wrong-evidence", "forget-policy"])("keeps correction boundaries for %s", async (failure) => {
    const { store, host, binding, decision } = setup();
    const policy = failure === "forget-policy"
      ? { mode: "single_remove" as const, targetId: "news-scope", evidenceEntryId: "current-user" }
      : { mode: "single_update" as const, targetId: failure === "wrong-target" ? "answer-style" : "news-scope",
        replacement: "日报 Hacker News 不限主题。", evidenceEntryId: failure === "wrong-evidence" ? "another-user" : "current-user" };
    await expect(host.commit({ ...binding, mutationPolicy: policy },
      { batchId: "reconcile", basedOnRevision: 1, decisions: [decision] })).rejects.toThrow(/memory_policy/u);
    expect(store.read("fixture-bot").revision).toBe(1);
    expect(store.supersededTaskSettings("fixture-bot")).toEqual([]);
  });

  it("routes original conversation ownership through automatic curation even without search", async () => {
    const { root, store, host, binding, decision } = setup();
    const scopes: unknown[] = [];
    const curator = new CodexAccountMemoryCurator({ startOrResume: async () => "fixture", close: () => {},
      reply: async (_thread, text) => {
        const input = JSON.parse(String(text));
        expect(input.candidateEntries.map((entry: { id: string }) => entry.id)).toEqual(["news-scope", "answer-style"]);
        expect(input.managedTasks).toEqual([{ id: "task-news", name: "AI 新闻日报", revision: 3, template: "daily_ai_news" }]);
        return JSON.stringify({ batchId: input.batchId, basedOnRevision: input.basedOnRevision, decisions: [decision] });
      } }, host, root);
    const system = new AccountMemorySystem({ store, curator, statePath: path.join(root, "jobs.json"),
      managedTasks: (account, targets) => { scopes.push({ account, targets }); return binding.managedTasks; } });
    try {
      system.enable("fixture-bot"); await system.start();
      await system.captureTurn({ accountId: "fixture-bot", userEntry: { id: "current-user", text: "现在执行日报。", createdAt: 1000,
        source: { target: "fixture-user@im.wechat", eventKey: "fixture-event" } } });
      await vi.waitFor(() => expect(store.read("fixture-bot").revision).toBe(2));
      expect(scopes).toEqual([{ account: "fixture-bot", targets: ["fixture-user@im.wechat"] }]);
      expect(system.recall("fixture-bot")).not.toContain("仅限 AI 和 LLM");
      expect(system.recall("fixture-bot")).toContain("普通回答使用中文。");
    } finally { system.close(); }
  });

  it.skipIf(process.env.SCHEDULED_TASK_MODEL_TEST !== "live")("classifies legacy and mixed task settings with the real curator while retaining personal preferences", async () => {
    const { root, store, host, binding } = setup();
    store.apply("fixture-bot", { batchId: "mixed", basedOnRevision: 1, evidenceEntryIds: new Set(["old-request"]), mutations: [
      { op: "add", id: "mixed-settings", category: "preferences", value: "AI 新闻日报每天八点发送；我平时喜欢简短回答。", evidenceEntryIds: ["old-request"], confidence: 1 },
    ] });
    const agent = new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), MEMORY_CURATOR_DISABLED_FEATURES),
      90000, undefined, undefined, 60000, { runtimeProfile: MEMORY_CURATOR_RUNTIME_PROFILE, webSearch: "disabled" });
    const curator = new CodexAccountMemoryCurator(agent, host, root);
    try {
      const result = await curator.curate({ jobId: "live-curator", batchId: "live-curator", accountId: "fixture-bot", basedOnRevision: 2,
        candidateEntries: store.read("fixture-bot").entries, managedTasks: binding.managedTasks,
        trigger: "automatic", mutationPolicy: { mode: "reconcile" },
        turns: [{ userEntry: { id: "current-user", createdAt: Date.parse("2026-10-17T00:00:00Z"),
          text: "AI 新闻日报的 Hacker News 改为全站热榜，不限主题；普通回答仍用中文，我平时喜欢简短回答，代码示例优先 TypeScript。" } }] });
      const current = store.read("fixture-bot"); const audit = store.supersededTaskSettings("fixture-bot");
      const evidence = { result, current, audit, note: "Synthetic account; real memory curator; no Weixin send." };
      if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, "task-authority-curator-live.json"), JSON.stringify(evidence, null, 2) + "\n");
      }
      expect(result.status).toBe("committed");
      expect(audit.map((item) => item.entry.id).sort()).toEqual(["mixed-settings", "news-scope"]);
      expect(current.markdown).not.toMatch(/Hacker News|日报|八点/u);
      expect(current.markdown).toContain("中文"); expect(current.markdown).toContain("简短"); expect(current.markdown).toContain("TypeScript");
      expect(audit.find((item) => item.entry.id === "mixed-settings")?.retainedValue).toContain("简短");
    } finally { curator.close(); }
  }, 180000);

  it("does not create a second settings memory for a known task", async () => {
    const { store, host, binding, decision } = setup();
    await expect(host.commit(binding, { batchId: "reconcile", basedOnRevision: 1,
      decisions: [{ ...decision, match: null }] })).resolves.toMatchObject({ status: "committed", receipt: { added: 0, removed: 0, revision: 1 } });
    expect(store.read("fixture-bot").entries).toHaveLength(2);
    expect(store.supersededTaskSettings("fixture-bot")).toEqual([]);
  });

});
