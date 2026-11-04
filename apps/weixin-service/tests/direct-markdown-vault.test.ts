import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DirectMarkdownVault } from "../src/direct-markdown-vault.js";

function vaultHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-markdown-vault-"));
  fs.mkdirSync(path.join(root, ".obsidian"));
  return { root, vault: new DirectMarkdownVault(root) };
}

describe("DirectMarkdownVault", () => {
  it("searches only inside a validated Markdown subtree", async () => {
    const { vault } = vaultHarness();
    await vault.create("private.md", "Nvidia secret outside archive");
    await vault.create("news/2026-08-12/article.md", "Nvidia public article");

    await expect(vault.searchWithin("news", "Nvidia")).resolves.toEqual([
      "news/2026-08-12/article.md",
    ]);
    await expect(vault.searchWithin("../", "Nvidia")).rejects.toThrow(/目录/);
  });

  it("creates and reads a new Markdown note with a revision", async () => {
    const { root, vault } = vaultHarness();

    const created = await vault.create("微信/第一条.md", "# 第一条\n\n来自微信。\n");
    const read = await vault.read("微信/第一条.md");

    expect(created).toEqual({ path: "微信/第一条.md", sha256: read.sha256 });
    expect(read).toMatchObject({ path: "微信/第一条.md", content: "# 第一条\n\n来自微信。\n" });
    expect(fs.readFileSync(path.join(root, "微信/第一条.md"), "utf8")).toBe(read.content);
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("updates only the revision that was actually read", async () => {
    const { vault } = vaultHarness();
    await vault.create("计划.md", "v1\n");
    const original = await vault.read("计划.md");

    const updated = await vault.update("计划.md", "v2\n", original.sha256);

    await expect(vault.read("计划.md")).resolves.toMatchObject({
      content: "v2\n",
      sha256: updated.sha256,
    });
    await expect(vault.update("计划.md", "stale\n", original.sha256)).rejects.toThrow(
      "Markdown 已被修改",
    );
    await expect(vault.read("计划.md")).resolves.toMatchObject({ content: "v2\n" });
  });

  it("searches Markdown paths and content without entering hidden or linked directories", async () => {
    const { root, vault } = vaultHarness();
    await vault.create("公开/苹果.md", "没有关键词\n");
    await vault.create("公开/梨.md", "这里提到苹果\n");
    fs.mkdirSync(path.join(root, ".private"));
    fs.writeFileSync(path.join(root, ".private", "苹果.md"), "secret\n");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-vault-"));
    fs.writeFileSync(path.join(outside, "苹果.md"), "outside\n");
    fs.symlinkSync(outside, path.join(root, "公开", "linked"));

    await expect(vault.search("苹果")).resolves.toEqual(["公开/梨.md", "公开/苹果.md"]);
  });

  it("prioritizes title and path matches over notes that only mention the query in their body", async () => {
    const { vault } = vaultHarness();
    await vault.create("设计/Agent 工作流.md", "这篇正文没有重复标题关键词。\n");
    await vault.create("会议纪要.md", "讨论了 Agent 工作流 的迁移安排。\n");

    await expect(vault.searchForSelection("Agent 工作流")).resolves.toEqual([
      "设计/Agent 工作流.md",
    ]);
  });

  it("matches title terms across punctuation differences", async () => {
    const { vault } = vaultHarness();
    await vault.create("架构/Agent-工作流设计.md", "正文不含查询短语。\n");

    await expect(vault.searchForSelection("Agent 工作流")).resolves.toEqual([
      "架构/Agent-工作流设计.md",
    ]);
  });

  it("matches meaningful title terms when the query mixes an English term with its Chinese synonym", async () => {
    const { vault } = vaultHarness();
    await vault.create(
      "news/AI-代理让外设固件逆向从专家项目变成数小时任务-1e2ae53b.md",
      "正文不含完整查询短语。\n",
    );
    await vault.create(
      "news/AI-让外设固件逆向变成数小时任务-9f86d081.md",
      "正文不含完整查询短语。\n",
    );

    await expect(vault.searchForSelection("AI Agent 数小时任务")).resolves.toEqual([
      "news/AI-代理让外设固件逆向从专家项目变成数小时任务-1e2ae53b.md",
    ]);
  });

  it("matches multiple meaningful query terms across intervening title words", async () => {
    const { vault } = vaultHarness();
    await vault.create(
      "news/AI-代理让外设固件逆向从专家项目变成数小时任务-1e2ae53b.md",
      "正文不含完整查询短语。\n",
    );

    await expect(vault.searchForSelection("AI 数小时任务")).resolves.toEqual([
      "news/AI-代理让外设固件逆向从专家项目变成数小时任务-1e2ae53b.md",
    ]);
  });

  it("tolerates one typo in a meaningful title query", async () => {
    const { vault } = vaultHarness();
    await vault.create("架构/Agent工作流设计.md", "正文没有搜索词。\n");

    await expect(vault.searchForSelection("Agent工做流")).resolves.toEqual([
      "架构/Agent工作流设计.md",
    ]);
  });

  it("falls back to local body search only when title and path have no candidate", async () => {
    const { vault } = vaultHarness();
    await vault.create("会议纪要.md", "讨论了微信插件的目录授权。\n");
    await vault.create("周报.md", "没有相关内容。\n");

    await expect(vault.searchForSelection("目录授权")).resolves.toEqual([
      "会议纪要.md",
    ]);
  });

  it("orders exact titles before title fragments and path-only matches", async () => {
    const { vault } = vaultHarness();
    await vault.create("Agent 工作流.md", "exact\n");
    await vault.create("Agent 工作流设计.md", "title fragment\n");
    await vault.create("Agent 工作流/迁移记录.md", "path only\n");

    await expect(vault.searchForSelection("Agent 工作流")).resolves.toEqual([
      "Agent 工作流.md",
      "Agent 工作流设计.md",
      "Agent 工作流/迁移记录.md",
    ]);
  });

  it("rejects traversal, hidden paths, non-Markdown files, symlinks and overwrite", async () => {
    const { root, vault } = vaultHarness();
    const outside = path.join(path.dirname(root), "outside-note.md");
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, path.join(root, "link.md"));
    await vault.create("safe.md", "safe\n");

    await expect(vault.read("../outside-note.md")).rejects.toThrow("不允许");
    await expect(vault.read(".obsidian/config.md")).rejects.toThrow("不允许");
    await expect(vault.create("asset.png", "x")).rejects.toThrow("Markdown");
    await expect(vault.read("link.md")).rejects.toThrow("符号链接");
    await expect(vault.create("safe.md", "overwrite\n")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(vault.read("safe.md")).resolves.toMatchObject({ content: "safe\n" });
  });

  it("bounds search results", async () => {
    const { vault } = vaultHarness();
    for (let index = 0; index < 25; index += 1) {
      await vault.create(`结果-${String(index).padStart(2, "0")}.md`, "共同关键词\n");
    }

    const results = await vault.search("共同关键词");

    expect(results).toHaveLength(20);
    expect(results[0]).toBe("结果-00.md");
    expect(results.at(-1)).toBe("结果-19.md");
  });
});
