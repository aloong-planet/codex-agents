import { describe, expect, it } from "vitest";

import type { AccountMemoryEntry } from "../src/account-memory-store.js";
import {
  resolveMemoryTarget,
  rankExactCosine,
  type MemorySearchCandidate,
} from "../src/account-memory-resolver.js";

function entry(id: string, value: string): AccountMemoryEntry {
  return { id, category: "preferences", value, evidenceEntryIds: ["seed"], confidence: 1, updatedAt: 1 };
}

describe("account memory target resolution", () => {
  it("binds a unique strong technical anchor to the existing stable id", () => {
    const entries = [
      entry("js-package-manager-pnpm", "所有 JavaScript 项目统一使用 pnpm。"),
      entry("editor-obsidian", "Markdown 笔记使用 Obsidian。"),
    ];

    expect(resolveMemoryTarget("改成只在 Node.js 项目使用 pnpm", entries, [])).toEqual({
      status: "resolved",
      targetId: "js-package-manager-pnpm",
      replacement: "只在 Node.js 项目使用 pnpm",
      basis: "strong_lexical",
    });
  });

  it("does not authorize a write from a semantic-only match", () => {
    const entries = [entry("package-manager", "前端依赖统一由 pnpm 管理。")];
    const semantic: MemorySearchCandidate[] = [{ id: "package-manager", rank: 1, score: 0.96, source: "semantic" }];

    expect(resolveMemoryTarget("改成只在 Node.js 工程使用包管理工具", entries, semantic)).toEqual({
      status: "needs_clarification",
      reason: "target_missing",
      candidateIds: ["package-manager"],
    });
  });

  it("refuses to guess when a strong anchor occurs in multiple entries", () => {
    const entries = [
      entry("pnpm-js", "JavaScript 项目使用 pnpm。"),
      entry("pnpm-docs", "pnpm 文档归档到 Obsidian。"),
    ];

    expect(resolveMemoryTarget("改成只在 Node.js 项目使用 pnpm", entries, [])).toMatchObject({
      status: "needs_clarification",
      reason: "target_ambiguous",
      candidateIds: ["pnpm-docs", "pnpm-js"],
    });
  });

  it("performs deterministic exact cosine ranking over a contiguous vector buffer", () => {
    const vectors = new Float32Array([1, 0, 0, 1, 0.8, 0.2]);
    expect(rankExactCosine(new Float32Array([1, 0]), vectors, ["a", "b", "c"], 2, 2))
      .toEqual([
        { id: "a", rank: 1, score: 1, source: "semantic" },
        { id: "c", rank: 2, score: expect.closeTo(0.9701425, 6), source: "semantic" },
      ]);
  });
});
