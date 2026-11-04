import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DirectMarkdownVault } from "../src/direct-markdown-vault.js";
import { NewsArchive, extractReadableMarkdown, fetchReadableArticle } from "../src/news-archive.js";
import type { NewsDigest } from "../src/daily-ai-news-scheduler.js";

function harness(loadBody = vi.fn(async (url: string) => ({
  title: url.endsWith("two") ? "第二篇原题" : "第一篇原题",
  markdown: "## 正文\n\n这是清洗后的完整文章正文，包含足够多的事实与上下文。文章继续列出关键数字、实现步骤、已知限制和潜在风险，足以支持后续问答。",
}))) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "news-archive-"));
  fs.mkdirSync(path.join(root, ".obsidian"));
  const vault = new DirectMarkdownVault(root);
  return {
    root,
    vault,
    loadBody,
    archive: new NewsArchive(vault, loadBody, () => Date.parse("2026-08-12T05:00:00Z")),
  };
}

function digest(): NewsDigest {
  return {
    date: "2026-08-12",
    generatedAt: Date.parse("2026-08-12T04:00:00Z"),
    items: [
      {
        section: "hackernews",
        title: "推理轨迹研究：模型之间可转录",
        summary: "研究展示了跨模型转录的路径与风险。",
        source: "研究论文 / Hacker News",
        url: "https://example.com/one",
        publishedAt: "2026-08-12T00:00:00Z",
      },
      {
        section: "general",
        title: "Nvidia 数据中心融资风险",
        summary: "集中度与残值担保提高了资金链风险。",
        source: "Stratechery",
        url: "https://example.com/two",
        publishedAt: "2026-08-12T01:00:00Z",
      },
    ],
  };
}

function completeHackerNewsTop5Digest(): NewsDigest {
  const items = Array.from({ length: 5 }, (_, index) => ({
    section: "hackernews" as const,
    title: `HN Story ${index + 1}`,
    summary: `第 ${index + 1} 条 Hacker News 的完整结构化摘要。`,
    source: `source-${index + 1}.example · Hacker News`,
    url: `https://source-${index + 1}.example/hn-${index + 1}`,
    publishedAt: "2026-08-12T00:00:00Z",
  }));
  return {
    date: "2026-08-12",
    generatedAt: Date.parse("2026-08-12T08:30:00Z"),
    items,
    hackerNewsTopCapturedAt: Date.parse("2026-08-12T08:15:00Z"),
    hackerNewsTop: items.map((item, index) => ({
      rank: index + 1,
      title: item.title,
      source: `source-${index + 1}.example`,
      url: item.url,
      submittedAt: item.publishedAt,
      score: 500 - index,
      comments: 100 - index,
      status: "summarized" as const,
    })),
  };
}

describe("NewsArchive", () => {
  it("keeps detailed prose in the archive while retaining the separate delivery brief", async () => {
    const { archive, vault } = harness();
    const input = digest();
    input.items[0]!.summary = "研究展示了跨模型转录的路径与风险。实验只覆盖所列模型，不能证明其他模型同样受影响。";
    input.items[0]!.brief = "研究展示跨模型转录风险，但结果仅限受测模型。";
    const result = await archive.archive(input);
    const saved = await vault.read(result.summaryPath);
    expect(saved.content).toContain("研究展示了跨模型转录的路径与风险。实验只覆盖所列模型，不能证明其他模型同样受影响。");
    expect(saved.content).not.toContain("研究展示跨模型转录风险，但结果仅限受测模型。");
    expect(result.digest.items[0]?.brief).toBe("研究展示跨模型转录风险，但结果仅限受测模型。");
  });

  it("archives cleaned bodies under the date and publishes the summary last", async () => {
    const { root, archive, loadBody } = harness();

    const result = await archive.archive(digest());

    expect(loadBody).toHaveBeenCalledTimes(2);
    expect(result.summaryPath).toBe("news/2026-08-12/摘要.md");
    expect(result.archived).toHaveLength(2);
    const files = fs.readdirSync(path.join(root, "news", "2026-08-12")).sort();
    expect(files).toHaveLength(3);
    const summary = fs.readFileSync(path.join(root, "news", "2026-08-12", "摘要.md"), "utf8");
    expect(summary).toContain("1. 推理轨迹研究：模型之间可转录");
    expect(summary).toContain("[[news/2026-08-12/");
    expect(summary).toContain("来源：Stratechery");
    const firstBody = fs.readFileSync(path.join(root, result.archived[0]!.path), "utf8");
    expect(firstBody).toContain("原始地址：https://example.com/one");
    expect(firstBody).toContain("这是清洗后的完整文章正文");
  });

  it("persists all five Hacker News summaries and original bodies", async () => {
    const { root, archive } = harness();
    const input = completeHackerNewsTop5Digest();

    const result = await archive.archive(input);

    expect(result.hackerNewsTopPath).toBe("news/2026-08-12/Hacker News 热门 5 篇.md");
    expect(result.archived).toHaveLength(5);
    const top5 = fs.readFileSync(
      path.join(root, "news", "2026-08-12", "Hacker News 热门 5 篇.md"),
      "utf8",
    );
    expect(top5.match(/^## \d+\./gm)).toHaveLength(5);
    expect(top5).toContain("## 1. HN Story 1");
    expect(top5).toContain("## 5. HN Story 5");
    expect(top5).toContain("抓取时间：2026-08-12T08:15:00.000Z");
    expect(top5).toContain("分数：500 · 评论：100");
    expect(top5.match(/处理状态：已进入日报深读摘要/g)).toHaveLength(5);
    expect(top5.match(/Hacker News 的完整结构化摘要/g)).toHaveLength(5);
    expect(top5.match(/正文：\[\[news\/2026-08-12\//g)).toHaveLength(5);
    const summary = fs.readFileSync(path.join(root, "news", "2026-08-12", "摘要.md"), "utf8");
    expect(summary.match(/^## \d+\./gm)).toHaveLength(5);
    for (const item of result.archived) {
      expect(fs.readFileSync(path.join(root, item.path), "utf8")).toContain("## 正文");
    }

    const topItems = input.hackerNewsTop!;
    topItems[0] = { ...topItems[0]!, score: 777 };
    await archive.archive(input);
    expect(fs.readFileSync(
      path.join(root, "news", "2026-08-12", "Hacker News 热门 5 篇.md"),
      "utf8",
    )).toContain("分数：777 · 评论：100");
  });

  it("preserves the complete HN digest when an archive body is unavailable", async () => {
    const loadBody = vi.fn(async (url: string) => {
      if (url.endsWith("hn-3")) throw new Error("unavailable");
      return { title: "article", markdown: "这是可读取的完整正文，包含背景、证据、实现步骤、限制和风险，足以支持后续基于原文的本地问答。" };
    });
    const { root, archive } = harness(loadBody);

    const result = await archive.archive(completeHackerNewsTop5Digest());

    expect(result.digest.items).toHaveLength(5);
    expect(result.digest.hackerNewsTop?.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.hackerNewsTopPath).toBe("news/2026-08-12/Hacker News 热门 5 篇.md");
    const summary = fs.readFileSync(path.join(root, "news", "2026-08-12", "摘要.md"), "utf8");
    expect(summary).toContain("HN Story 3");
    expect(result.skipped).toEqual([{ title: "HN Story 3", reason: "正文无法取得" }]);
    expect(fs.existsSync(path.join(root, "news", "2026-08-12", "Hacker News 热门 5 篇.md"))).toBe(true);
  });

  it("preserves the legacy Top 10 audit format when backfilling an old preview", async () => {
    const { root, archive } = harness();
    const input = digest();
    input.hackerNewsTop = Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      title: `Legacy HN ${index + 1}`,
      source: "example.com",
      url: index === 0 ? input.items[0]!.url : `https://example.com/legacy-${index + 1}`,
      submittedAt: "2026-08-12T00:00:00Z",
      score: 100 - index,
      comments: index,
      status: index === 0 ? "summarized" as const : "not_selected" as const,
    }));

    const result = await archive.archive(input);

    expect(result.digest).toEqual(input);
    expect(result.hackerNewsTopPath).toBe("news/2026-08-12/Hacker News Top 10.md");
    const audit = fs.readFileSync(
      path.join(root, "news", "2026-08-12", "Hacker News Top 10.md"),
      "utf8",
    );
    expect(audit).toContain("旧版 Hacker News 官方 topstories 候选审计快照");
    expect(audit).toContain("## 10. Legacy HN 10");
  });

  it("rejects a Top 5 snapshot whose article identities differ from its summaries", async () => {
    const { root, archive } = harness();
    const input = completeHackerNewsTop5Digest();
    input.hackerNewsTop![4] = {
      ...input.hackerNewsTop![4]!,
      url: "https://source-5.example/different-story",
    };

    await expect(archive.archive(input)).rejects.toThrow(/摘要与榜单不一致/);
    expect(fs.existsSync(path.join(root, "news", "2026-08-12", "Hacker News Top 5.md"))).toBe(false);
  });

  it("skips one unavailable body, marks the summary, and keeps the day usable", async () => {
    const loadBody = vi.fn(async (url: string) => {
      if (url.endsWith("one")) throw new Error("paywall");
      return { title: "第二篇", markdown: "这是可读取的第二篇完整正文，信息足够用于本地问答。文章继续列出关键数字、实现步骤、已知限制和潜在风险，确保不是短摘要。" };
    });
    const { root, archive } = harness(loadBody);

    const result = await archive.archive(digest());

    expect(result.archived).toHaveLength(1);
    expect(result.skipped).toEqual([{ title: "推理轨迹研究：模型之间可转录", reason: "正文无法取得" }]);
    const summary = fs.readFileSync(path.join(root, "news", "2026-08-12", "摘要.md"), "utf8");
    expect(summary).toContain("正文未归档");
    expect(summary).not.toContain("paywall");
  });

  it("treats an oversized article as one unavailable body instead of failing the day", async () => {
    const loadBody = vi.fn(async (url: string) => ({
      title: "article",
      markdown: url.endsWith("one") ? "x".repeat(110_000) : "可归档正文".repeat(20),
    }));
    const { archive } = harness(loadBody);

    const result = await archive.archive(digest());

    expect(result.archived).toHaveLength(1);
    expect(result.skipped).toEqual([{ title: "推理轨迹研究：模型之间可转录", reason: "正文无法取得" }]);
  });

  it("reuses existing article files on a same-day rerun and refreshes the summary", async () => {
    const { archive, loadBody, vault } = harness();
    const first = await archive.archive(digest());
    const changed = digest();
    changed.items[0]!.summary = "更新后的摘要。";

    await archive.archive(changed);

    expect(loadBody).toHaveBeenCalledTimes(2);
    await expect(vault.read(first.archived[0]!.path)).resolves.toMatchObject({
      content: expect.stringContaining("这是清洗后的完整文章正文"),
    });
    await expect(vault.read("news/2026-08-12/摘要.md")).resolves.toMatchObject({
      content: expect.stringContaining("更新后的摘要。"),
    });
  });

  it("searches and reads only the news namespace", async () => {
    const { archive, vault } = harness();
    await vault.create("秘密.md", "Nvidia private note");
    await archive.archive(digest());

    const matches = await archive.search("Nvidia");
    expect(matches.every((item) => item.path.startsWith("news/"))).toBe(true);
    await expect(archive.read("秘密.md")).rejects.toThrow(/news/);
  });

  it("returns the newest daily summaries first for ordinal follow-ups", async () => {
    const { archive, vault } = harness();
    for (let day = 1; day <= 22; day += 1) {
      const date = `2026-07-${String(day).padStart(2, "0")}`;
      await vault.create(`news/${date}/摘要.md`, `# ${date} AI 新闻摘要\n`);
    }

    const matches = await archive.search("摘要");

    expect(matches[0]?.path).toBe("news/2026-07-22/摘要.md");
    expect(matches).toHaveLength(20);
  });
});

describe("fetchReadableArticle", () => {
  it("rejects local addresses before making a request", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await expect(fetchReadableArticle("http://127.0.0.1/private")).rejects.toThrow(/不可访问/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("checks a redirect target before following it", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/secret" },
    }));
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await expect(fetchReadableArticle("https://93.184.216.34/story")).rejects.toThrow(/不可访问/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to an isolated rendered DOM when static HTML has no readable body", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response(
      "<!doctype html><html><head><title>Dynamic shell</title></head><body><div id=\"app\"></div></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ));
    const loadRenderedHtml = vi.fn(async () => ({
      finalUrl: "https://93.184.216.34/story",
      html: `<!doctype html><html><head><title>动态项目正文</title></head><body><main>
        <h1>动态项目正文</h1><p>这是 JavaScript 渲染后的完整正文，包含足够长度的技术背景、实现步骤、实验结果、限制和风险。</p>
        <p>第二段继续给出可核查事实，确保 Readability 可以稳定提取内容。</p>
      </main></body></html>`,
    }));
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const result = await fetchReadableArticle("https://93.184.216.34/story", loadRenderedHtml);

      expect(result.title).toBe("动态项目正文");
      expect(result.markdown).toContain("JavaScript 渲染后的完整正文");
      expect(loadRenderedHtml).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not start browser rendering for an HTTP failure", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const loadRenderedHtml = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await expect(fetchReadableArticle(
        "https://93.184.216.34/story",
        loadRenderedHtml,
      )).rejects.toThrow(/正文请求失败/);
      expect(loadRenderedHtml).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the static fast path when the original HTML is readable", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response(
      `<!doctype html><html><head><title>静态正文</title></head><body><article>
        <h1>静态正文</h1><p>这是无需浏览器渲染的完整文章正文，包含足够长度的事实、背景、实现方式、限制和风险。</p>
        <p>第二段继续提供可以被 Readability 稳定提取的有效内容。</p>
      </article></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    ));
    const loadRenderedHtml = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await expect(fetchReadableArticle(
        "https://93.184.216.34/story",
        loadRenderedHtml,
      )).resolves.toMatchObject({ title: "静态正文" });
      expect(loadRenderedHtml).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("extractReadableMarkdown", () => {
  it("keeps article content and removes navigation and scripts", () => {
    const html = `<!doctype html><html><head><title>AI 芯片分析</title></head><body>
      <nav>首页 登录</nav><article><h1>AI 芯片分析</h1><p>这是文章主体，包含足够长度的集中度事实与风险分析。</p><p>第二段继续解释融资和残值担保。</p></article>
      <script>globalThis.secret = true</script></body></html>`;

    const result = extractReadableMarkdown(html, "https://example.com/story");

    expect(result.title).toBe("AI 芯片分析");
    expect(result.markdown).toContain("集中度事实与风险分析");
    expect(result.markdown).not.toContain("首页 登录");
    expect(result.markdown).not.toContain("globalThis.secret");
  });
});

it("repairs an interrupted snapshot file from saved content and keeps newer snapshots intact", async () => {
  const { root, vault, archive, loadBody } = harness();
  const input = digest();
  const context = { snapshotId: "first", active: () => true, signal: new AbortController().signal,
    loadBody: async () => ({ title: "Saved original", markdown: "Saved immutable article body and all of its original qualifications, evidence, and limitations." }) };
  try {
    const first = await archive.archive(input, context);
    const note = await archive.read(first.archived[0]!.path);
    await vault.update(note.path, "interrupted partial bytes", note.sha256);
    const newer = { ...input, generatedAt: input.generatedAt + 1, items: input.items.map((item) => ({ ...item, summary: "New snapshot viewpoint." })) };
    const second = await archive.archive(newer, { ...context, snapshotId: "second" });
    await archive.archive(input, context);
    expect((await archive.read(first.archived[0]!.path)).content).toContain("Saved immutable article body and all of its original qualifications");
    expect((await archive.read(second.summaryPath)).content).toContain("New snapshot viewpoint.");
    expect((await archive.search("摘要"))[0]?.path).toBe(second.summaryPath);
    expect(loadBody).not.toHaveBeenCalled();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
