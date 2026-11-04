import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DirectMarkdownVault } from "../src/direct-markdown-vault.js";
import { NewsArchive } from "../src/news-archive.js";
import { VaultAuthorization, VaultDynamicToolHost } from "../src/vault-dynamic-tool-host.js";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-tool-host-"));
  fs.mkdirSync(path.join(root, ".obsidian"));
  const authorization = new VaultAuthorization("demo");
  const vault = new DirectMarkdownVault(root);
  return {
    root,
    authorization,
    vault,
    host: new VaultDynamicToolHost(vault, authorization, new NewsArchive(vault)),
  };
}

function outputText(result: { contentItems: Array<{ type: string; text?: string }> }): string {
  return result.contentItems[0]?.text ?? "";
}

describe("VaultDynamicToolHost", () => {
  it("advertises bounded Markdown and read-only news functions and fails writes closed", async () => {
    const { root, host } = harness();

    expect(host.definitions().map((item) => item.name)).toEqual([
      "obsidian_search_markdown",
      "obsidian_read_markdown",
      "obsidian_create_markdown",
      "obsidian_update_markdown",
      "news_search_archive",
      "news_read_archive",
    ]);
    const result = await host.execute("obsidian_create_markdown", {
      path: "微信.md",
      content: "# 微信\n",
    });

    expect(result.success).toBe(false);
    expect(outputText(result)).toContain("未启用");
    expect(outputText(result)).not.toContain(root);
    expect(fs.existsSync(path.join(root, "微信.md"))).toBe(false);
  });

  it("allows a natural news follow-up to read only the news archive", async () => {
    const { authorization, host, vault } = harness();
    await vault.create("news/2026-08-12/摘要.md", "# 2026-08-12 AI 新闻摘要\n\n## 2. Nvidia 融资风险\n\n来源：Stratechery\n");
    await vault.create("private.md", "Nvidia private note");

    authorization.beginTurn("第二条新闻的集中度和风险具体是什么？");
    const searched = await host.execute("news_search_archive", { query: "Nvidia" });
    const outside = await host.execute("news_read_archive", { path: "private.md" });
    const write = await host.execute("obsidian_create_markdown", { path: "oops.md", content: "no" });

    expect(searched.success).toBe(true);
    expect(outputText(searched)).toContain("news/2026-08-12/摘要.md");
    expect(outputText(searched)).not.toContain("private.md");
    expect(outside.success).toBe(false);
    expect(write.success).toBe(false);
  });

  it("executes real create, read and conflict-aware update only after authorization", async () => {
    const { authorization, host } = harness();
    authorization.setEnabled(true);
    expect((await host.execute("obsidian_create_markdown", {
      path: "微信.md",
      content: "# 微信\n",
    })).success).toBe(false);
    authorization.beginTurn("请在 Obsidian 里创建一篇微信.md 笔记");

    const created = await host.execute("obsidian_create_markdown", {
      path: "微信.md",
      content: "# 微信\n",
    });
    authorization.beginTurn("请读取 Obsidian 里的微信.md 笔记");
    const read = await host.execute("obsidian_read_markdown", { path: "微信.md" });
    const revision = JSON.parse(outputText(read)).sha256 as string;
    authorization.beginTurn("请修改 Obsidian 里的微信.md 笔记");
    const updated = await host.execute("obsidian_update_markdown", {
      path: "微信.md",
      content: "# 已更新\n",
      expectedSha256: revision,
    });

    expect(created.success).toBe(true);
    expect(read.success).toBe(true);
    expect(outputText(read)).toContain("# 微信");
    expect(updated.success).toBe(true);
    expect(outputText(updated)).toContain("微信.md");
    authorization.endTurn();
  });

  it("does not let a read-only request escalate into a write", async () => {
    const { authorization, host } = harness();
    authorization.setEnabled(true);
    authorization.beginTurn("请读取 Obsidian 里的计划.md");

    const result = await host.execute("obsidian_create_markdown", {
      path: "越权.md",
      content: "no\n",
    });

    expect(result.success).toBe(false);
    expect(outputText(result)).toContain("没有明确授权");
  });
});
