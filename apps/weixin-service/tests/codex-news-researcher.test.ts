import { withArticleAssessment } from "./fixtures/assessed-news-run.js";
// Deterministic fixtures verify delivery contracts, not arbitrary article fidelity.
// Real-model source/summary review is recorded in the daily-news test report.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertCompletedWebSearch,
  buildCodexNewsArgs,
  createCodexCliNewsRun,
  type CodexNewsRun,
  CodexCliNewsResearcher,
  CodexHackerNewsResearcher,
  CombinedNewsResearcher,
  fetchHackerNewsCandidates,
} from "../src/codex-news-researcher.js";
import { articleKey } from "../src/news-article-identity.js";
import { formatNewsDigest } from "../src/daily-ai-news-scheduler.js";

const detailedSummary = "团队提出新方法，并通过对照实验验证其设计。论文报告了指标变化和适用条件；结果改善了目标能力，但仍受样本范围与实验设置约束。";
const proseSummary = {
  summary: detailedSummary,
  brief: "团队的新方法在对照实验中改善了目标能力，但结果仍受样本范围与实验设置约束。",
};
const loadArticle = async () => ({
  title: "Original",
  markdown: "这是从候选 URL 抓取并清洗后的真实原文，包含背景、方法、证据、限制和足够多的上下文。",
});

describe("CodexCliNewsResearcher", () => {
  it.each(["", "。", "论证仍未结束，因为", "实验支持这一观点…", "实验支持这一观点...",
    "实验支持…但不能推广。", "实验支持...但不能推广。", "实验支持⋯但不能推广。",
    "实验支持这一观点。\n但不能推广。", "研究" + "🧠".repeat(78) + "。"])(
    "rejects an invalid brief after one bounded rewrite: %s", async (brief) => {
      let calls = 0;
      const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => {
        calls += 1;
        return JSON.stringify({ items: [{ section: "general", title: "适用边界", ...proseSummary, brief,
          source: "研究", url: "https://example.com/bounds", publishedAt: "2026-08-12T00:00:00Z" }] });
      }));
      await expect(researcher.generate({ date: "2026-08-12", windowStart: Date.parse("2026-08-11T04:00:00Z"),
        windowEnd: Date.parse("2026-08-12T04:00:00Z") })).rejects.toThrow(/短摘要/u);
      expect(calls).toBe(3);
    },
  );

  it.each(["process failure", "malformed output"])("does not rewrite after %s", async (failure) => {
    let calls = 0;
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => {
      calls += 1;
      if (calls > 1) {
        if (failure === "process failure") throw new Error("CODEX_USAGE_LIMIT");
        return "{";
      }
      return JSON.stringify({ items: [{ title: "候选", source: "研究", url: "https://example.com/bounds", publishedAt: "2026-08-12T00:00:00Z" }] });
    }));
    await expect(researcher.generate({ date: "2026-08-12", windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z") })).rejects.toThrow(failure === "process failure" ? /CODEX_USAGE_LIMIT/u : /结果格式/u);
    expect(calls).toBe(2);
  });

  it("rewrites the HN brief using the same fetched original article", async () => {
    const prompts: string[] = [];
    const researcher = new CodexHackerNewsResearcher(withArticleAssessment(async ({ prompt }) => {
      prompts.push(prompt);
      return JSON.stringify({ items: [{ section: "hackernews", title: "受限样本", ...proseSummary,
        brief: prompts.length === 1 ? "样本有限…" : "所测样本显示改进，但不能推断其他任务也有相同收益。",
        source: "研究 / Hacker News", url: "https://example.com/sample", publishedAt: "2026-08-12T00:00:00Z" }] });
    }), async () => [{ id: 1, rank: 1, title: "Sample", url: "https://example.com/sample", submittedAt: "2026-08-12T00:00:00Z", score: 1, comments: 0 }],
    () => 123, async () => ({ title: "Sample", markdown: "样本仅包含十项固定任务，不可推断其他任务也有同样收益。" }));
    const result = await researcher.generate({ date: "2026-08-12", windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z") });
    expect(result.items[0]?.brief).toBe("所测样本显示改进，但不能推断其他任务也有相同收益。");
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).toContain("样本仅包含十项固定任务，不可推断其他任务也有同样收益。");
  });

  it("rewrites an overlong short summary once instead of truncating its qualification", async () => {
    let calls = 0;
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => {
      calls += 1;
      return JSON.stringify({ items: [{ section: "general", title: "实验结果不能直接推广", source: "研究报告",
        url: "https://example.com/limited", publishedAt: "2026-08-12T00:00:00Z",
        summary: "实验发现所测系统的错误减少，但任务集有限，结果不能直接推广到其他场景。",
        brief: calls < 3 ? "研究在所测任务中发现错误减少，但样本仅包括固定的工具和数据，不能据此认定所有代理或所有场景都能得到同样改善。".repeat(3)
          : "实验中代理错误减少，但任务集有限，结果不能直接推广到其他场景。",
      }] });
    }));
    const result = await researcher.generate({ date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"), windowEnd: Date.parse("2026-08-12T04:00:00Z") });
    expect(formatNewsDigest(result)).toContain("实验中代理错误减少，但任务集有限，结果不能直接推广到其他场景。");
    expect(calls).toBe(3);
  });

  it("delivers a complete prose argument without requiring four summary sections", async () => {
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => JSON.stringify({ items: [{
      section: "general", title: "代理需要核验工具返回的证据", source: "研究报告",
      url: "https://example.com/verification", publishedAt: "2026-08-12T00:00:00Z",
      summary: "文章认为工具调用成功不能代表任务完成。研究让代理检查返回证据是否支持目标结论，缺少证据时继续检索或说明限制。实验减少了无依据的成功声明，但结果仅适用于受测任务，不能保证所有任务都能完成。",
      brief: "文章主张代理核验工具返回的证据，而非把调用成功等同于任务完成；实验减少了无依据的成功声明，但结论仅限受测任务。",
    }] })));
    const result = await researcher.generate({ date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"), windowEnd: Date.parse("2026-08-12T04:00:00Z") });
    expect(formatNewsDigest(result)).toBe("2026-08-12 AI 新闻\n\nAI 新闻\n\n1. 代理需要核验工具返回的证据\n文章主张代理核验工具返回的证据，而非把调用成功等同于任务完成；实验减少了无依据的成功声明，但结论仅限受测任务。\n来源：研究报告");
    expect(result.items[0]?.summary).toContain("缺少证据时继续检索或说明限制");
  });

  it("loads real ranked candidates from the official Hacker News API", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/topstories.json")) {
        return new Response(JSON.stringify([101, 102]));
      }
      const id = Number(url.match(/item\/(\d+)\.json/)?.[1]);
      return new Response(JSON.stringify({
        id,
        type: "story",
        title: `Story ${id}`,
        url: `https://example.com/${id}`,
        time: 1_786_500_000,
        score: id,
        descendants: id - 100,
      }));
    });

    await expect(fetchHackerNewsCandidates(fetcher, 2)).resolves.toEqual([
      expect.objectContaining({ id: 101, rank: 1, score: 101, comments: 1 }),
      expect.objectContaining({ id: 102, rank: 2, score: 102, comments: 2 }),
    ]);
    expect(fetcher).toHaveBeenCalledWith("https://hacker-news.firebaseio.com/v0/topstories.json", { signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledWith("https://hacker-news.firebaseio.com/v0/item/101.json", { signal: expect.any(AbortSignal) });
  });

  it("retries an interrupted HN read and retains the original ranked result", async () => {
    let reads = 0;
    const result = await fetchHackerNewsCandidates(async (url) => {
      if (url.endsWith("topstories.json")) {
        if (++reads === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
        return new Response("[101]");
      }
      return new Response(JSON.stringify({ id: 101, type: "story", title: "Story", time: 1786500000, url: "https://example.com/story" }));
    });
    expect(result).toMatchObject([{ id: 101, rank: 1, url: "https://example.com/story" }]);
    expect(reads).toBe(2);
  });

  it("fails explicitly when the official Hacker News API has no usable candidates", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([])));
    await expect(fetchHackerNewsCandidates(fetcher)).rejects.toThrow(/Hacker News 热榜不可用/);
  });

  it("skips unavailable Hacker News item metadata while preserving official ranks", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/topstories.json")) return new Response(JSON.stringify([101, 102, 103]));
      if (url.includes("/101.json")) {
        return new Response(JSON.stringify({
          id: 101,
          type: "story",
          title: "Story 101",
          url: "https://example.com/101",
          time: 1_786_500_000,
        }));
      }
      if (url.includes("/102.json")) throw new TypeError("fetch failed");
      return new Response("unavailable", { status: 503 });
    });

    await expect(fetchHackerNewsCandidates(fetcher, 3)).resolves.toEqual([
      expect.objectContaining({ id: 101, rank: 1 }),
    ]);
  });

  it("turns a schema-constrained live-search result into a dated digest", async () => {
    const run = vi.fn(async () => JSON.stringify({
      items: [{
        section: "general",
        title: "OpenAI 发布新研究",
        ...proseSummary,
        source: "OpenAI",
        url: "https://openai.com/news/example",
        publishedAt: "2026-08-12",
      }],
    }));
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(run), () => 1234);

    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).resolves.toEqual({
      date: "2026-08-12",
      generatedAt: 1234,
      items: [{
        section: "general",
        title: "OpenAI 发布新研究",
        summary: detailedSummary,
        brief: "团队的新方法在对照实验中改善了目标能力，但结果仍受样本范围与实验设置约束。",
        source: "OpenAI",
        url: "https://openai.com/news/example",
        publishedAt: "2026-08-12",
      }],
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/2026-08-11T04:00:00\.000Z.*2026-08-12T04:00:00\.000Z/s),
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/至少执行一次真实网页搜索.*LLM.*至少 6 条.*最多 2 条/s),
    }));
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      minimumSearches: 1,
    }));
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: expect.stringMatching(/无法读取.*自然连贯.*主旨或核心观点.*必要限定.*不能使用省略号/s),
    }));
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: expect.stringMatching(/一手来源/),
    }));
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      schema: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          items: expect.objectContaining({
            maxItems: 10,
            items: expect.objectContaining({
              properties: expect.objectContaining({
                section: expect.objectContaining({ enum: ["general", "hackernews"] }),
                summary: expect.objectContaining({ maxLength: 1000 }),
                brief: expect.objectContaining({ maxLength: 80 }),
              }),
            }),
          }),
        }),
      }),
    }));
  });

  it("accepts up to five verified general news items", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      section: "general",
      title: `技术新闻 ${index + 1}`,
      ...proseSummary,
      source: `来源 ${index + 1}`,
      url: `https://example.com/news-${index + 1}`,
      publishedAt: "2026-08-11T12:00:00Z",
    }));
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => JSON.stringify({ items })));
    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).resolves.toMatchObject({
      items: items.map((item) => ({
        section: item.section,
        title: item.title,
        summary: detailedSummary,
        brief: "团队的新方法在对照实验中改善了目标能力，但结果仍受样本范围与实验设置约束。",
        source: item.source,
        url: item.url,
        publishedAt: item.publishedAt,
      })),
    });
  });

  it("rejects an eleventh item instead of silently truncating the verified result", async () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      section: "general",
      title: `新闻 ${index + 1}`,
      ...proseSummary,
      source: "来源",
      url: `https://example.com/item-${index + 1}`,
      publishedAt: "2026-08-11T12:00:00Z",
    }));
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => JSON.stringify({ items })));
    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).rejects.toThrow(/结果格式无效/);
  });

  it("rejects missing detailed prose instead of presenting only a short summary", async () => {
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => JSON.stringify({
      items: [{
        section: "general",
        title: "英伟达 AI 芯片业务风险",
        summary: "",
        brief: "文章认为该业务可能面对风险，但没有给出能够推广到其他场景的证据。",
        source: "Example",
        url: "https://example.com/nvidia",
        publishedAt: "2026-08-11T12:00:00Z",
      }],
    })));

    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).rejects.toThrow(/结果格式无效/);
  });

  it("returns no HN items when all available candidates fail summary validation", async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      rank: index + 1,
      title: `Candidate ${index + 1}`,
      url: `https://example.com/hn-${index + 1}`,
      submittedAt: "2026-08-11T12:00:00Z",
      score: 10 - index,
      comments: 2,
    }));
    const researcher = new CodexHackerNewsResearcher(
      withArticleAssessment(async () => JSON.stringify({ items: [] })), async () => candidates, Date.now, loadArticle,
    );

    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).resolves.toMatchObject({ items: [], hackerNewsTop: [] });
  });

  it("skips failed HN stories and fills five successes from official ranks 1 through 10", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      rank: index + 1,
      title: `Candidate ${index + 1}`,
      url: `https://example.com/hn-${index + 1}`,
      submittedAt: "2026-08-11T12:00:00Z",
      score: 100 - index,
      comments: 20 - index,
    }));
    const bodyLoader = vi.fn(async (url: string) => {
      if (url.endsWith("hn-1")) throw new Error("正文请求失败");
      return loadArticle();
    });
    const run = vi.fn(async ({ prompt }: Parameters<CodexNewsRun>[0]) => {
      const candidate = candidates.find((item) => prompt.includes(item.url))!;
      if (candidate.rank === 4) return JSON.stringify({ items: [] });
      return JSON.stringify({ items: [{
        section: "hackernews",
        title: candidate.title,
        ...proseSummary,
        source: "Example · Hacker News",
        url: candidate.url,
        publishedAt: candidate.submittedAt,
      }] });
    });
    const researcher = new CodexHackerNewsResearcher(
      withArticleAssessment(run), async () => candidates, () => 123, bodyLoader,
    );

    const result = await researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    });

    expect(result.hackerNewsTop?.map((item) => item.rank)).toEqual([2, 3, 5, 6, 7]);
    expect(result.items.map((item) => item.url)).toEqual([2, 3, 5, 6, 7].map((rank) => `https://example.com/hn-${rank}`));
    expect(bodyLoader).toHaveBeenCalledTimes(7);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("returns however many HN stories succeed after checking at most ten ranks", async () => {
    const candidates = Array.from({ length: 11 }, (_, index) => ({
      id: index + 1, rank: index + 1, title: `Candidate ${index + 1}`,
      url: `https://example.com/hn-${index + 1}`,
      submittedAt: "2026-08-11T12:00:00Z", score: 100 - index, comments: 20 - index,
    }));
    const successful = new Set([2, 6, 9]);
    const bodyLoader = vi.fn(async (url: string) => {
      const rank = Number(url.match(/hn-(\d+)$/)?.[1]);
      if (!successful.has(rank)) throw new Error("unavailable");
      return loadArticle();
    });
    const run = vi.fn(async ({ prompt }: Parameters<CodexNewsRun>[0]) => {
      const candidate = candidates.find((item) => prompt.includes(item.url))!;
      return JSON.stringify({ items: [{
        section: "hackernews", title: candidate.title, ...proseSummary,
        source: "Example · Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
      }] });
    });
    const researcher = new CodexHackerNewsResearcher(
      withArticleAssessment(run), async () => candidates, Date.now, bodyLoader,
    );

    const result = await researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    });

    expect(result.hackerNewsTop?.map((item) => item.rank)).toEqual([2, 6, 9]);
    expect(bodyLoader).toHaveBeenCalledTimes(10);
    expect(bodyLoader).not.toHaveBeenCalledWith("https://example.com/hn-11");
  });

  it("continues general AI research when the whole HN adapter fails", async () => {
    const general = { generate: vi.fn(async (window) => ({
      date: window.date,
      generatedAt: 1,
      items: [{
        section: "general" as const, title: "General", summary: detailedSummary,
        brief: "团队的新方法在对照实验中改善了目标能力，但结果仍受样本范围与实验设置约束。",
        source: "General", url: "https://example.com/general", publishedAt: "2026-08-11T12:00:00Z",
      }],
    })) };
    const researcher = new CombinedNewsResearcher(
      general,
      { generate: vi.fn(async () => { throw new Error("Hacker News 热榜不可用"); }) },
      () => 123,
    );

    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).resolves.toMatchObject({
      generatedAt: 123,
      items: [{ section: "general" }],
      hackerNewsTop: [],
      sources: { hackernews: { status: "failed", code: "source_unavailable" }, general: { status: "complete" } },
    });
    expect(general.generate).toHaveBeenCalledOnce();
  });

  it("accepts an older submission that is still present in the current Hacker News top stories", async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1, rank: index + 1, title: `Candidate ${index + 1}`,
      url: index === 0 ? "https://example.com/older-hn" : `https://example.com/hn-${index + 1}`,
      submittedAt: index === 0 ? "2026-08-06T01:05:16Z" : "2026-08-11T12:00:00Z",
      score: 25 - index, comments: 22 - index,
    }));
    const researcher = new CodexHackerNewsResearcher(withArticleAssessment(async ({ prompt }) => {
      const candidate = candidates.find((item) => prompt.includes(item.url))!;
      return JSON.stringify({ items: [({
        section: "hackernews",
        title: candidate.title,
        ...proseSummary,
        source: "Example · Hacker News",
        url: candidate.url,
        publishedAt: candidate.submittedAt,
      })] });
    }), async () => candidates, Date.now, loadArticle);

    const result = await researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    });
    expect(result.items).toHaveLength(5);
    expect(result.items[0]).toMatchObject({ section: "hackernews", url: "https://example.com/older-hn" });
  });

  it("excludes Hacker News article identities before general research and merges both sections", async () => {
    const generalWindows: Array<{ excludedArticleKeys?: string[] }> = [];
    const researcher = new CombinedNewsResearcher(
      { generate: async (window) => {
        generalWindows.push(window);
        return { date: window.date, generatedAt: 1, items: [{
          section: "general", title: "General", summary: detailedSummary,
          source: "General", url: "https://example.com/general", publishedAt: "2026-08-11T12:00:00Z",
        }] };
      } },
      { generate: async (window) => {
        return { date: window.date, generatedAt: 1, items: [{
          section: "hackernews", title: "HN", summary: detailedSummary,
          source: "Hacker News", url: "https://example.com/hn", publishedAt: "2026-08-11T12:00:00Z",
        }], hackerNewsTop: [{
          rank: 1, title: "HN", source: "example.com", url: "https://example.com/hn",
          submittedAt: "2026-08-11T12:00:00Z", score: 10, comments: 2, status: "summarized",
        }] };
      } },
      () => 123,
    );
    const pending = researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    });
    await expect(pending).resolves.toMatchObject({
      generatedAt: 123,
      items: [{ section: "hackernews" }, { section: "general" }],
      hackerNewsTop: [{ rank: 1, status: "summarized" }],
    });
    expect(generalWindows[0]?.excludedArticleKeys).toContain(articleKey("https://example.com/hn"));
  });

  it("filters normalized historical identities between discovery and summary", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ items: [
        { title: "Old", source: "Example", url: "https://example.com/old?utm_source=hn", publishedAt: "2026-08-11T12:00:00Z" },
        { title: "New", source: "Example", url: "https://example.com/new", publishedAt: "2026-08-11T13:00:00Z" },
      ] }))
      .mockResolvedValueOnce(JSON.stringify({ items: [{
        section: "general", title: "New", ...proseSummary, source: "Example",
        url: "https://example.com/new", publishedAt: "2026-08-11T13:00:00Z",
      }] }));
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(run));

    const result = await researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
      excludedArticleKeys: [articleKey("https://example.com/old")],
    });

    expect(result.items.map((item) => item.title)).toEqual(["New"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].prompt).not.toContain("https://example.com/old");
  });

  it("does not regenerate historical HN summaries when only legacy success identities remain", async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1, rank: index + 1, title: `Old ${index + 1}`,
      url: `https://example.com/old-${index + 1}`,
      submittedAt: "2026-08-11T12:00:00Z", score: 100 - index, comments: 50 - index,
    }));
    const run = vi.fn(async ({ prompt }: Parameters<CodexNewsRun>[0]) => {
      const candidate = candidates.find((item) => prompt.includes(item.url))!;
      return JSON.stringify({ items: [({
        section: "hackernews", title: candidate.title, ...proseSummary,
        source: "Example · Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
      })] });
    });
    const researcher = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => candidates, Date.now, loadArticle);

    const result = await researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
      excludedArticleKeys: candidates.map((candidate) => articleKey(candidate.url)),
    });
    expect(result.items).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("summarizes every official Top 5 item and marks all five complete", async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      rank: index + 1,
      title: `Story ${index + 1}`,
      url: `https://source-${index + 1}.example/story`,
      submittedAt: "2026-08-11T12:00:00Z",
      score: 100 - index,
      comments: 20 - index,
    }));
    const run = vi.fn(async (input: Parameters<CodexNewsRun>[0]) => {
      const candidate = candidates.find((item) => input.prompt.includes(item.url))!;
      return JSON.stringify({ items: [({
        section: "hackernews", title: candidate.title, ...proseSummary,
        source: `${candidate.title} · Hacker News`, url: candidate.url,
        publishedAt: candidate.submittedAt,
      })] });
    });
    const researcher = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => candidates, () => 123, loadArticle);

    const result = await researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    });

    expect(result).toMatchObject({
      items: candidates.map((candidate) => ({ url: candidate.url })),
      hackerNewsTop: expect.arrayContaining([
        expect.objectContaining({ rank: 1, status: "summarized", source: "source-1.example" }),
        expect.objectContaining({ rank: 5, status: "summarized", source: "source-5.example" }),
      ]),
    });
    expect(result.hackerNewsTop).toHaveLength(5);
    expect(result.hackerNewsTopCapturedAt).toBe(123);
    expect(run).toHaveBeenCalledTimes(5);
    candidates.forEach((candidate, index) => {
      expect(run.mock.calls[index]?.[0].prompt).toContain(candidate.url);
    });
  });

  it("rejects a summary that introduces an article outside the discovered candidates", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ items: [{
        title: "Allowed", source: "Example", url: "https://example.com/allowed",
        publishedAt: "2026-08-11T12:00:00Z",
      }] }))
      .mockResolvedValueOnce(JSON.stringify({ items: [{
        section: "general", title: "Injected", ...proseSummary, source: "Example",
        url: "https://example.com/injected", publishedAt: "2026-08-11T12:00:00Z",
      }] }));

    await expect(new CodexCliNewsResearcher(withArticleAssessment(run)).generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).rejects.toThrow(/候选外文章/);
  });

  it("requires a completed real web search instead of trusting an empty final result", () => {
    const noSearch = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ].join("\n");
    expect(() => assertCompletedWebSearch(noSearch)).toThrow(/未执行实时网页搜索/);

    const searched = [
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "AI news" } }),
    ].join("\n");
    expect(() => assertCompletedWebSearch(searched)).not.toThrow();
  });

  it("can require broad multi-query search coverage for production news", () => {
    const trace = Array.from({ length: 6 }, (_, index) => JSON.stringify({
      type: "item.completed",
      item: { type: "web_search", query: `technical lane ${index + 1}` },
    })).join("\n");
    expect(() => assertCompletedWebSearch(trace, 7)).toThrow(/至少完成 7 次/);
    expect(() => assertCompletedWebSearch(trace, 6)).not.toThrow();
  });

  it("isolates production research from project rules, user skills, plugins and subagents", () => {
    const args = buildCodexNewsArgs("schema.json", "output.json", "prompt");
    expect(args).toEqual(expect.arrayContaining([
      "--search",
      "--disable", "skill_search",
      "--disable", "plugins",
      "--disable", "multi_agent",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
    ]));
  });

  it("detects a Codex usage-limit error emitted only through JSONL stdout", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-news-quota-test-"));
    const executable = path.join(directory, "fake-codex");
    fs.writeFileSync(executable, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"error\",\"message\":\"You have hit your usage limit\"}'",
      "exit 1",
    ].join("\n"), { mode: 0o700 });

    try {
      const run = createCodexCliNewsRun({ executable });
      await expect(run({ prompt: "test", schema: {}, minimumSearches: 1 }))
        .rejects.toThrow(/CODEX_USAGE_LIMIT/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the executable again for each news process after an application relocation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-news-relocation-"));
    const first = path.join(directory, "first-codex");
    const second = path.join(directory, "second-codex");
    fs.writeFileSync(first, "#!/bin/sh\nprintf 'usage limit' >&2\nexit 1\n", { mode: 0o700 });
    fs.writeFileSync(second, "#!/bin/sh\nprintf '429 Too Many Requests' >&2\nexit 1\n", { mode: 0o700 });
    let executable = first;
    const run = createCodexCliNewsRun({ executable: () => executable });
    try {
      await expect(run({ prompt: "test", schema: {} })).rejects.toThrow(/CODEX_USAGE_LIMIT/u);
      fs.unlinkSync(first);
      executable = second;
      await expect(run({ prompt: "test", schema: {} })).rejects.toThrow(/CODEX_RATE_LIMIT/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects a Codex rate limit from stderr without retaining its raw text", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-news-rate-test-"));
    const executable = path.join(directory, "fake-codex");
    fs.writeFileSync(executable, [
      "#!/bin/sh",
      "printf '%s\\n' '429 Too Many Requests from private endpoint' >&2",
      "exit 1",
    ].join("\n"), { mode: 0o700 });

    try {
      const run = createCodexCliNewsRun({ executable });
      await expect(run({ prompt: "test", schema: {}, minimumSearches: 1 }))
        .rejects.toThrow(/CODEX_RATE_LIMIT/u);
      await expect(run({ prompt: "test", schema: {}, minimumSearches: 1 }))
        .rejects.not.toThrow(/private endpoint/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects any interval other than an exact forward 24-hour window", async () => {
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(vi.fn()));
    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-12T04:00:00Z"),
      windowEnd: Date.parse("2026-08-11T04:00:00Z"),
    })).rejects.toThrow(/时间窗无效/);
  });

  it("rejects a result whose claimed publication time falls outside the requested window", async () => {
    const researcher = new CodexCliNewsResearcher(withArticleAssessment(async () => JSON.stringify({
      items: [{
        section: "general",
        title: "过期新闻",
      ...proseSummary,
        source: "Example",
        url: "https://example.com/old-news",
        publishedAt: "2026-08-10T03:59:59Z",
      }],
    })));
    await expect(researcher.generate({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
    })).rejects.toThrow(/发布时间超出检索时间窗/);
  });
});

it("bounds repeated HN connection resets to three attempts", async () => {
  let requests = 0;
  await expect(fetchHackerNewsCandidates(async () => {
    requests++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  })).rejects.toThrow("fetch failed");
  expect(requests).toBe(3);
});

it("does not retry permanent HN HTTP errors", async () => {
  let requests = 0;
  await expect(fetchHackerNewsCandidates(async () => { requests++; return new Response("not found", { status: 404 }); })).rejects.toThrow("热榜不可用");
  expect(requests).toBe(1);
});

it("preserves HN content when AI research fails and rejects an entirely failed collection", async () => {
  const window = { date: "2026-08-12", windowStart: Date.parse("2026-08-11T04:00:00Z"), windowEnd: Date.parse("2026-08-12T04:00:00Z") };
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(async () => JSON.stringify({ items: [{ section: "hackernews", title: "原文观点", ...proseSummary,
    source: "研究 / Hacker News", url: "https://example.com/story", publishedAt: "2026-08-11T12:00:00Z" }] })),
    async () => [{ id: 1, rank: 1, title: "Story", url: "https://example.com/story", submittedAt: "2026-08-11T12:00:00Z", score: 1, comments: 1 }], Date.now, loadArticle);
  const ai = new CodexCliNewsResearcher(withArticleAssessment(async () => { throw new Error("CODEX_USAGE_LIMIT"); }));
  const result = await new CombinedNewsResearcher(ai, hn).generate(window);
  expect(result).toMatchObject({ items: [{ title: "原文观点" }], sources: { general: { status: "failed", code: "usage_limit" }, hackernews: { status: "complete" } } });
  expect(formatNewsDigest(result)).toContain("本次未包含 AI 新闻：模型额度不足。");
  const failedHN = new CodexHackerNewsResearcher(withArticleAssessment(async () => ""), async () => { throw new Error("unavailable"); });
  await expect(new CombinedNewsResearcher(ai, failedHN).generate(window)).rejects.toThrow("all_news_sources_failed");
});

it("gives AI its own budget after HN times out and ignores late HN completion", async () => {
  let finish!: () => void, signal: AbortSignal | undefined;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(async () => ""), async (input) => { signal = input; await wait; return []; });
  const ai = new CodexCliNewsResearcher(withArticleAssessment(async () => JSON.stringify({ items: [] })));
  try {
    const result = await new CombinedNewsResearcher(ai, hn, () => 123, 15).generate({ date: "2026-08-12", windowStart: Date.parse("2026-08-11T04:00:00Z"), windowEnd: Date.parse("2026-08-12T04:00:00Z") });
    expect(signal?.aborted).toBe(true);
    expect(result.sources).toEqual({ hackernews: { status: "failed", code: "source_deadline" }, general: { status: "empty" } });
    const saved = JSON.stringify(result); finish(); await wait; await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(result)).toBe(saved);
  } finally { finish(); }
});
