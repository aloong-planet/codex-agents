import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AccountMemorySearchIndex, Qwen3MemoryEmbeddingProfile } from "../src/account-memory-search-index.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";

describe("AccountMemorySearchIndex", () => {
  it("persists entry embeddings in SQLite and exact-ranks semantic candidates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-index-"));
    const store = new AccountMemoryStore(root);
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "add", id: "package-manager", category: "preferences", value: "前端依赖统一由 pnpm 管理。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "add", id: "editor", category: "preferences", value: "Markdown 笔记使用 Obsidian。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });
    const embed = vi.fn(async (text: string) => text.includes("依赖") || text.includes("包管理")
      ? new Float32Array([1, 0])
      : new Float32Array([0, 1]));
    const index = new AccountMemorySearchIndex(root, {
      contract: fixtureContract("fixture"),
      embedQuery: embed,
      embedDocuments: async (texts) => Promise.all(texts.map(async (text) => ({ vector: await embed(text), truncated: false }))),
    });

    const first = await index.search("bot-a@im.bot", "更换前端包管理工具");
    const callsAfterFirst = embed.mock.calls.length;
    store.apply("bot-a@im.bot", {
      batchId: "update-editor", basedOnRevision: 1, evidenceEntryIds: new Set(["update"]),
      mutations: [{ op: "update", id: "editor", value: "Markdown 笔记改用 Zed。", evidenceEntryIds: ["update"], confidence: 1 }],
    });
    const second = await index.search("bot-a@im.bot", "更换前端包管理工具");

    expect(first[0]?.id).toBe("package-manager");
    expect(second[0]?.id).toBe("package-manager");
    expect(callsAfterFirst).toBe(3);
    expect(embed.mock.calls.length).toBe(5);
    expect(embed.mock.calls.filter(([text]) => text === "前端依赖统一由 pnpm 管理。")).toHaveLength(1);
  });

  it("keeps rollback and candidate profile vectors side by side", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-index-profiles-"));
    const store = new AccountMemoryStore(root);
    store.apply("bot-a@im.bot", {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [
        { op: "add", id: "package-manager", category: "preferences", value: "前端依赖统一由 pnpm 管理。", evidenceEntryIds: ["seed"], confidence: 1 },
        { op: "add", id: "editor", category: "preferences", value: "Markdown 笔记使用 Obsidian。", evidenceEntryIds: ["seed"], confidence: 1 },
      ],
    });
    const legacyEmbed = vi.fn(async (text: string) => text.includes("依赖")
      ? new Float32Array([1, 0])
      : new Float32Array([0, 1]));
    const candidateEmbed = vi.fn(async (text: string) => text.includes("依赖")
      ? new Float32Array([1, 0])
      : new Float32Array([0, 1]));
    const legacy = new AccountMemorySearchIndex(root, {
      contract: fixtureContract("legacy"),
      embedQuery: legacyEmbed,
      embedDocuments: async (texts) => Promise.all(texts.map(async (text) => ({ vector: await legacyEmbed(text), truncated: false }))),
    });
    const candidate = new AccountMemorySearchIndex(root, {
      contract: fixtureContract("candidate"),
      embedQuery: candidateEmbed,
      embedDocuments: async (texts) => Promise.all(texts.map(async (text) => ({ vector: await candidateEmbed(text), truncated: false }))),
    });

    await legacy.search("bot-a@im.bot", "包管理");
    await candidate.search("bot-a@im.bot", "包管理");
    await legacy.search("bot-a@im.bot", "包管理");

    expect(legacyEmbed).toHaveBeenCalledTimes(4);
    expect(candidateEmbed).toHaveBeenCalledTimes(3);
  });

  it("uses the pinned Qwen query/document contract and reports 512-token truncation", async () => {
    const extract = vi.fn(async () => ({ data: Float32Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0) }));
    const profile = new Qwen3MemoryEmbeddingProfile(async () => ({
      extract,
      countTokens: (text) => text === "一条过长的记忆" ? 513 : 12,
    }));

    const query = await profile.embedQuery("用户的包管理偏好");
    const [document] = await profile.embedDocuments(["一条过长的记忆"]);

    expect(profile.contract).toMatchObject({
      model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
      revision: "c25a394dd583836952667c12f008335071b3f43d",
      dtype: "q8",
      dimensions: 1024,
      pooling: "last_token",
      normalized: true,
      maxLength: 512,
    });
    expect(extract).toHaveBeenNthCalledWith(1,
      "Instruct: Given a personal-memory query, retrieve relevant memory passages that answer the query\nQuery:用户的包管理偏好",
      { pooling: "last_token", normalize: true, truncation: true, max_length: 512 },
    );
    expect(extract).toHaveBeenNthCalledWith(2, "一条过长的记忆",
      { pooling: "last_token", normalize: true, truncation: true, max_length: 512 },
    );
    expect(query).toHaveLength(1024);
    expect(document).toMatchObject({ truncated: true });
    expect(document?.vector).toHaveLength(1024);
  });

  it("builds the candidate in background, atomically activates it, and rolls back without rebuilding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-index-migration-"));
    const accountId = "bot-a@im.bot";
    const store = new AccountMemoryStore(root);
    store.apply(accountId, {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "add", id: "package-manager", category: "preferences", value: "前端依赖统一由 pnpm 管理。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const legacy = fixtureProfile("legacy");
    const candidate = fixtureProfile("qwen");
    const index = new AccountMemorySearchIndex(root, legacy.profile, { candidate: candidate.profile });

    await index.prepare(accountId);

    expect(index.getStatus(accountId)).toMatchObject({
      state: "active",
      activeModel: "qwen",
      rollbackModel: "legacy",
      indexedEntries: 1,
      totalEntries: 1,
      generation: 1,
    });
    await index.prepare(accountId);
    expect(index.getStatus(accountId)).toMatchObject({ activeModel: "qwen", generation: 1 });
    await index.search(accountId, "包管理");
    expect(candidate.query).toHaveBeenCalledOnce();
    expect(index.rollback(accountId)).toBe(true);
    expect(index.getStatus(accountId)).toMatchObject({ state: "active", activeModel: "legacy", rollbackModel: "qwen", generation: 2 });
    await index.prepare(accountId);
    expect(index.getStatus(accountId)).toMatchObject({ activeModel: "legacy", generation: 2 });
    await index.search(accountId, "包管理");
    expect(legacy.query).toHaveBeenCalledOnce();
    expect(legacy.documents).toHaveBeenCalledOnce();
  });

  it("keeps the rollback profile active when the candidate build fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-index-failure-"));
    const accountId = "bot-a@im.bot";
    const store = new AccountMemoryStore(root);
    store.apply(accountId, {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "add", id: "package-manager", category: "preferences", value: "默认使用 pnpm。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const legacy = fixtureProfile("legacy");
    const candidate = fixtureProfile("qwen");
    candidate.documents.mockRejectedValueOnce(new Error("sensitive provider detail"));
    const index = new AccountMemorySearchIndex(root, legacy.profile, { candidate: candidate.profile });

    await expect(index.prepare(accountId)).rejects.toThrow("sensitive provider detail");

    expect(index.getStatus(accountId)).toMatchObject({
      state: "failed",
      activeModel: "legacy",
      lastError: "memory_embedding_build_failed",
    });
    expect(JSON.stringify(index.getStatus(accountId))).not.toContain("sensitive provider detail");
    await index.search(accountId, "pnpm");
    expect(legacy.query).toHaveBeenCalledOnce();
  });

  it("does not retrieve a stale vector while background maintenance catches up", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-index-stale-"));
    const accountId = "bot-a@im.bot";
    const store = new AccountMemoryStore(root);
    store.apply(accountId, {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "add", id: "package-manager", category: "preferences", value: "默认使用 pnpm。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const legacy = fixtureProfile("legacy");
    const candidate = fixtureProfile("qwen");
    const index = new AccountMemorySearchIndex(root, legacy.profile, { candidate: candidate.profile });
    await index.prepare(accountId);
    store.apply(accountId, {
      batchId: "replace", basedOnRevision: 1, evidenceEntryIds: new Set(["replace"]),
      mutations: [{ op: "update", id: "package-manager", value: "喜欢蓝色主题。", evidenceEntryIds: ["replace"], confidence: 1 }],
    });

    await expect(index.search(accountId, "包管理器")).resolves.toEqual([]);
  });

  it("reruns maintenance requested while a candidate build is still running", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-memory-index-rerun-"));
    const accountId = "bot-a@im.bot";
    const store = new AccountMemoryStore(root);
    store.apply(accountId, {
      batchId: "seed", basedOnRevision: 0, evidenceEntryIds: new Set(["seed"]),
      mutations: [{ op: "add", id: "package-manager", category: "preferences", value: "默认使用 pnpm。", evidenceEntryIds: ["seed"], confidence: 1 }],
    });
    const legacy = fixtureProfile("legacy");
    const candidate = fixtureProfile("qwen");
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    candidate.documents.mockImplementationOnce(async (texts) => {
      await firstBlocked;
      return texts.map(() => ({ vector: new Float32Array([1, 0]), truncated: false }));
    });
    const index = new AccountMemorySearchIndex(root, legacy.profile, { candidate: candidate.profile });

    const first = index.prepare(accountId);
    await vi.waitFor(() => expect(candidate.documents).toHaveBeenCalledOnce());
    store.apply(accountId, {
      batchId: "replace", basedOnRevision: 1, evidenceEntryIds: new Set(["replace"]),
      mutations: [{ op: "update", id: "package-manager", value: "只在 Node.js 项目使用 pnpm。", evidenceEntryIds: ["replace"], confidence: 1 }],
    });
    const second = index.prepare(accountId);
    releaseFirst();
    await Promise.all([first, second]);

    expect(candidate.documents).toHaveBeenCalledTimes(2);
    expect(index.getStatus(accountId)).toMatchObject({ state: "active", activeModel: "qwen", indexedEntries: 1, totalEntries: 1 });
  });
});

function fixtureContract(model: string) {
  return {
    model,
    revision: "1",
    dtype: "fixture",
    dimensions: 2,
    pooling: "mean" as const,
    normalized: true as const,
    queryTemplateVersion: "raw-v1",
    documentTemplateVersion: "raw-v1",
    maxLength: 512,
    runtimeVersion: "fixture",
  };
}

function fixtureProfile(model: string) {
  const query = vi.fn(async () => new Float32Array([1, 0]));
  const documents = vi.fn(async (texts: readonly string[]) => texts.map(() => ({
    vector: new Float32Array([1, 0]), truncated: false,
  })));
  return {
    query,
    documents,
    profile: { contract: fixtureContract(model), embedQuery: query, embedDocuments: documents },
  };
}
