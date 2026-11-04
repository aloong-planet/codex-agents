import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemoryToolHost, accountMemoryDecisionOutputSchema } from "../src/account-memory-tool-host.js";
import {
  CodexAccountMemoryCurator,
  MEMORY_CURATOR_DISABLED_FEATURES,
  MEMORY_CURATOR_RUNTIME_PROFILE,
} from "../src/codex-account-memory-curator.js";

describe("CodexAccountMemoryCurator", () => {
  it("commits a dated plan as an event instead of misreporting an event-only receipt as noop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-curator-event-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const tools = new AccountMemoryToolHost(store);
    let capturedPrompt = "";
    const agent = {
      startOrResume: vi.fn(async () => "curator-event-thread"),
      reply: vi.fn(async (_threadId: string, prompt: unknown) => {
        capturedPrompt = String(prompt);
        return JSON.stringify({
          basedOnRevision: 0, batchId: "event-batch",
          decisions: [{
            kind: "record_event", eventKind: "planned", localDate: "2026-08-17",
            summary: "准备去吃肉蟹煲。", evidenceEntryIds: ["event-user"], confidence: 1,
          }],
        });
      }),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    await expect(curator.curate({
      jobId: "event-job", batchId: "event-batch", accountId: "bot-a@im.bot", basedOnRevision: 0,
      candidateEntries: [],
      trigger: "automatic", mutationPolicy: { mode: "reconcile" },
      turns: [{ userEntry: {
        id: "event-user", text: "明天准备去吃肉蟹煲",
        createdAt: Date.parse("2026-08-16T12:00:00+08:00"),
      } }],
    })).resolves.toMatchObject({ status: "committed", receipt: { eventsAdded: 1 } });
    expect(MEMORY_CURATOR_RUNTIME_PROFILE).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
    });
    expect(MEMORY_CURATOR_RUNTIME_PROFILE).not.toHaveProperty("developerInstructions");
    expect(MEMORY_CURATOR_DISABLED_FEATURES).toEqual(expect.arrayContaining([
      "plugins", "skill_search", "shell_tool", "unified_exec", "multi_agent",
    ]));
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("未来计划使用 record_event");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("改变已有计划");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("关联并完成唯一匹配的计划");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("提醒结果回复统一使用 resolve_reminder");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("必须用 match 描述它对应的原计划");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("分别完成一项计划并修改另一项计划");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("改期或修改内容仍使用 revise_event");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("只返回符合 outputSchema 的 JSON");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.outputSchema).toEqual(accountMemoryDecisionOutputSchema());
    expect(capturedPrompt).not.toContain("你是 Memory Curator");
    expect(JSON.parse(capturedPrompt)).toMatchObject({
      schemaVersion: 2,
      batchId: "event-batch",
      basedOnRevision: 0,
      entryLocalDates: { "event-user": "2026-08-16" },
      turns: [{ userEntry: { id: "event-user", text: "明天准备去吃肉蟹煲" } }],
      candidateEvents: [],
    });
  });

  it("uses a fresh thread and commits only its validated structured output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-curator-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const tools = new AccountMemoryToolHost(store);
    let nextThread = 0;
    const agent = {
      startOrResume: vi.fn(async () => `curator-thread-${++nextThread}`),
      reply: vi.fn(async (_threadId: string, prompt: unknown) => {
        const payload = JSON.parse(String(prompt)) as { basedOnRevision: number; batchId: string };
        return JSON.stringify({
          basedOnRevision: store.read("bot-a@im.bot").revision,
          batchId: payload.batchId,
          decisions: [{
            kind: "remember",
            category: "projects",
            value: `项目 ${nextThread}`,
            evidenceEntryIds: [`user-${nextThread}`],
            confidence: 1,
          }],
        });
      }),
      releaseThread: vi.fn(),
      close: vi.fn(),
    };
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    for (const index of [1, 2]) {
      await expect(curator.curate({
        jobId: `job-${index}`,
        batchId: `batch-${index}`,
        accountId: "bot-a@im.bot",
        basedOnRevision: index - 1,
        candidateEntries: store.read("bot-a@im.bot").entries,
        trigger: "explicit_remember",
        mutationPolicy: { mode: "free_add" },
        turns: [{ userEntry: { id: `user-${index}`, text: `记住项目 ${index}`, createdAt: index } }],
      })).resolves.toMatchObject({ status: "committed" });
    }

    expect(agent.startOrResume).toHaveBeenNthCalledWith(1, undefined, "/workspace", []);
    expect(agent.startOrResume).toHaveBeenNthCalledWith(2, undefined, "/workspace", []);
    expect(agent.reply).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      revision: 0,
      approvalPolicy: "never",
      permissions: ":read-only",
    });
    const payload = JSON.parse(String(agent.reply.mock.calls[0]?.[1]));
    expect(payload).toMatchObject({
      schemaVersion: 2,
      mutationPolicy: { mode: "free_add" },
      batchId: "batch-1",
      basedOnRevision: 0,
    });
    expect(payload).not.toHaveProperty("memoryMarkdown");
    expect(payload.candidateEntries).toEqual([]);
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("普通 turn 也必须判断是否包含值得长期保留的信息");
    expect(MEMORY_CURATOR_RUNTIME_PROFILE.baseInstructions).toContain("revise 必须提供 match（旧事实匹配线索）和 value（新值）");
    expect(agent.releaseThread).toHaveBeenCalledTimes(2);
    expect(store.read("bot-a@im.bot").entries).toHaveLength(2);
  });

  it("returns a terminal clarification from the trusted reconcile tool", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-curator-clarification-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "add", id: "pnpm-global", category: "preferences", value: "所有项目使用 pnpm。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "add", id: "pnpm-demo", category: "projects", value: "Demo 项目使用 pnpm。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });
    const tools = new AccountMemoryToolHost(store);
    const agent = {
      startOrResume: vi.fn(async () => "curator-thread"),
      reply: vi.fn(async () => JSON.stringify({
          basedOnRevision: 1, batchId: "batch-1",
          decisions: [{ kind: "revise", match: "使用 pnpm", value: "只在 Node.js 项目使用 pnpm", evidenceEntryIds: ["user-1"], confidence: 1 }],
        })),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    await expect(curator.curate({
      jobId: "job-1", batchId: "batch-1", accountId: "bot-a@im.bot", basedOnRevision: 1,
      candidateEntries: store.read("bot-a@im.bot").entries,
      trigger: "automatic", mutationPolicy: { mode: "reconcile" },
      turns: [{ userEntry: { id: "user-1", text: "只在 Node.js 项目使用 pnpm", createdAt: 1 } }],
    })).resolves.toEqual({
      status: "needs_clarification",
      reason: "target_ambiguous",
      candidateIds: ["pnpm-demo", "pnpm-global"],
    });
    expect(store.read("bot-a@im.bot").revision).toBe(1);
  });

  it("repairs invalid structured output once on the same thread", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-curator-invalid-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const tools = new AccountMemoryToolHost(store);
    const agent = {
      startOrResume: vi.fn(async () => "curator-thread"),
      reply: vi.fn()
        .mockResolvedValueOnce("not-json")
        .mockResolvedValueOnce(JSON.stringify({
          basedOnRevision: 0,
          batchId: "batch-1",
          decisions: [{
            kind: "remember",
            category: "preferences",
            value: "Node.js 项目默认使用 pnpm。",
            evidenceEntryIds: ["user-1"],
            confidence: 1,
          }],
        })),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    await expect(curator.curate({
      jobId: "job-1", batchId: "batch-1", accountId: "bot-a@im.bot", basedOnRevision: 0,
      candidateEntries: [], trigger: "automatic", mutationPolicy: { mode: "reconcile" },
      turns: [{ userEntry: { id: "user-1", text: "以后都使用 pnpm", createdAt: 1 } }],
    })).resolves.toMatchObject({ status: "committed", receipt: { added: 1 } });
    expect(agent.startOrResume).toHaveBeenCalledTimes(1);
    expect(agent.reply).toHaveBeenCalledTimes(2);
    expect(agent.reply.mock.calls[0]?.[0]).toBe("curator-thread");
    expect(agent.reply.mock.calls[1]?.[0]).toBe("curator-thread");
    const repairPrompt = JSON.parse(String(agent.reply.mock.calls[1]?.[1]));
    expect(repairPrompt).toEqual({
      task: "repair_output_contract",
      errorCode: "curator_output_invalid",
      batchId: "batch-1",
      basedOnRevision: 0,
      allowedEvidenceEntryIds: ["user-1"],
    });
    expect(String(agent.reply.mock.calls[1]?.[1])).not.toContain("not-json");
    expect(store.read("bot-a@im.bot").revision).toBe(1);
  });

  it("stops after one invalid-output repair attempt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-curator-invalid-twice-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const tools = new AccountMemoryToolHost(store);
    const agent = {
      startOrResume: vi.fn(async () => "curator-thread"),
      reply: vi.fn(async () => "not-json"),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    await expect(curator.curate({
      jobId: "job-1", batchId: "batch-1", accountId: "bot-a@im.bot", basedOnRevision: 0,
      candidateEntries: [], trigger: "automatic", mutationPolicy: { mode: "reconcile" },
      turns: [{ userEntry: { id: "user-1", text: "以后都使用 pnpm", createdAt: 1 } }],
    })).rejects.toThrow("curator_output_invalid");
    expect(agent.reply).toHaveBeenCalledTimes(2);
    expect(agent.releaseThread).toHaveBeenCalledTimes(1);
    expect(store.read("bot-a@im.bot").revision).toBe(0);
  });

  it("does not treat a semantic date mismatch as a repairable output error", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "curator-thread"),
      reply: vi.fn(async () => JSON.stringify({
        basedOnRevision: 0,
        batchId: "batch-1",
        decisions: [],
      })),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const tools = {
      commit: vi.fn(async () => { throw new Error("memory_event_date_mismatch"); }),
    } as unknown as AccountMemoryToolHost;
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    await expect(curator.curate({
      jobId: "job-1", batchId: "batch-1", accountId: "bot-a@im.bot", basedOnRevision: 0,
      candidateEntries: [], trigger: "automatic", mutationPolicy: { mode: "reconcile" },
      turns: [{ userEntry: { id: "user-1", text: "明晚去吃肉蟹煲", createdAt: 1 } }],
    })).rejects.toThrow("memory_event_date_mismatch");
    expect(agent.reply).toHaveBeenCalledTimes(1);
    expect(tools.commit).toHaveBeenCalledTimes(1);
  });

  it("returns noop when the structured decision list is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-curator-noop-"));
    const store = new AccountMemoryStore(path.join(root, "memory"));
    const tools = new AccountMemoryToolHost(store);
    const agent = {
      startOrResume: vi.fn(async () => "curator-thread"),
      reply: vi.fn(async () => JSON.stringify({
        basedOnRevision: 0, batchId: "batch-1", decisions: [],
      })),
      releaseThread: vi.fn(), close: vi.fn(),
    };
    const curator = new CodexAccountMemoryCurator(agent, tools, "/workspace");

    await expect(curator.curate({
      jobId: "job-1", batchId: "batch-1", accountId: "bot-a@im.bot", basedOnRevision: 0,
      candidateEntries: [], trigger: "automatic", mutationPolicy: { mode: "reconcile" },
      turns: [{ userEntry: { id: "user-1", text: "今天下雨", createdAt: 1 } }],
    })).resolves.toEqual({ status: "noop" });
    expect(store.read("bot-a@im.bot").revision).toBe(0);
  });
});
