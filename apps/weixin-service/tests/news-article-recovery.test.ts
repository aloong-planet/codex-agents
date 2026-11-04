import { withArticleAssessment } from "./fixtures/assessed-news-run.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ScheduledTasks } from "../src/scheduled-tasks.js";
import { CodexHackerNewsResearcher } from "../src/codex-news-researcher.js";

it("reuses a persisted HN body and both summaries after restart on a different day", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-article-reuse-"));
  let clock = Date.parse("2026-10-16T00:00:00Z"), reads = 0, summaries = 0;
  const options = { databasePath: path.join(directory, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
    dailyNewsImport: { sourceHash: "reuse", state: { version: 2 as const, enabledTarget: null, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null } },
    dailyNews: { researcher: new CodexHackerNewsResearcher(withArticleAssessment(async () => {
      summaries++;
      return JSON.stringify({ items: [{ section: "hackernews", title: "实验的适用范围", source: "研究 / Hacker News",
        url: "https://example.com/article", publishedAt: "2026-10-15T00:00:00Z",
        summary: "实验结果只适用于所测任务，不能推断其他任务具有相同收益。", brief: "实验显示所测任务有所改善，但不能推广到其他任务。" }] });
    }), async () => [{ id: 1, rank: clock === Date.parse("2026-10-16T00:00:00Z") ? 1 : 3, title: "Original",
      url: "https://example.com/article?utm_source=hn", submittedAt: "2026-10-15T00:00:00Z", score: 20, comments: 3 }], () => clock,
    async () => { reads++; return { title: "Original", markdown: "实验结果只适用于所测任务，不能推断其他任务具有相同收益。实验提供了对照设置和明确的适用范围。" }; }) } };
  let tasks = new ScheduledTasks(options);
  try {
    await tasks.previewDailyNews(); tasks.close(); clock += 86_400_000;
    tasks = new ScheduledTasks(options); await tasks.previewDailyNews();
    expect(tasks.newsSnapshot().owner?.state.preview).toMatchObject({ date: "2026-10-17", items: [{
      summary: "实验结果只适用于所测任务，不能推断其他任务具有相同收益。", brief: "实验显示所测任务有所改善，但不能推广到其他任务。",
    }], hackerNewsTop: [{ rank: 3 }] });
    expect({ reads, summaries }).toEqual({ reads: 1, summaries: 1 });
  } finally { tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("retries only unfinished general articles and reuses their saved body on a same-day run", async () => {
  const { CodexCliNewsResearcher, NEWS_DISCOVERY_SCHEMA } = await import("../src/codex-news-researcher.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-general-reuse-"));
  const reads: string[] = [], summaries: string[] = [];
  const candidates = ["a", "b", "c", "d"].map((id) => ({ title: id, source: "研究", url: `https://example.com/${id}`, publishedAt: "2026-10-16T00:00:00Z" }));
  const researcher = new CodexCliNewsResearcher(withArticleAssessment(async ({ schema, prompt }) => {
    if (schema === NEWS_DISCOVERY_SCHEMA) return JSON.stringify({ items: candidates });
    const candidate = candidates.find((item) => prompt.includes(item.url))!;
    summaries.push(candidate.title);
    if (candidate.title === "d" && summaries.filter((id) => id === "d").length === 1) throw new Error("model failed");
    return JSON.stringify({ items: [{ ...candidate, section: "general", summary: `文章 ${candidate.title} 说明实验只适用于所测任务。`, brief: "实验结果仅适用于所测任务。" }] });
  }), () => Date.parse("2026-10-16T01:00:00Z"), async (url) => { reads.push(url); return { title: "Original", markdown: "原文提供了完整的对照实验、适用范围和限制。这一结果仅适用于所测任务，不能推广到其他任务。" }; });
  const tasks = new ScheduledTasks({ databasePath: path.join(directory, "tasks.sqlite"), now: () => Date.parse("2026-10-16T01:00:00Z"), readOriginalText: () => "查看日报",
    dailyNewsImport: { sourceHash: "general", state: { version: 2, enabledTarget: null, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null } }, dailyNews: { researcher } });
  try {
    await tasks.previewDailyNews(); expect(tasks.newsSnapshot().owner?.state.preview?.items).toHaveLength(3);
    await tasks.previewDailyNews(); expect(tasks.newsSnapshot().owner?.state.preview?.items).toHaveLength(4);
    expect(summaries).toEqual(["a", "b", "c", "d", "d"]);
    expect(reads).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d"]);
  } finally { tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("delivers through a real archive failure and repairs the archive from saved content without another send", async () => {
  const { DirectMarkdownVault } = await import("../src/direct-markdown-vault.js");
  const { NewsArchive } = await import("../src/news-archive.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-archive-repair-"));
  const vaultPath = path.join(directory, "vault"); fs.mkdirSync(path.join(vaultPath, ".obsidian"), { recursive: true });
  const archive = new NewsArchive(new DirectMarkdownVault(vaultPath), async () => { throw new Error("archive must not fetch"); });
  fs.writeFileSync(path.join(vaultPath, "news"), "temporary filesystem obstruction");
  let clock = Date.parse("2026-10-16T00:30:00Z"), summaries = 0, reads = 0;
  const outbox: string[] = [];
  const tasks = new ScheduledTasks({ databasePath: path.join(directory, "tasks.sqlite"), now: () => clock, readOriginalText: () => "查看日报",
    dailyNewsImport: { sourceHash: "archive", state: { version: 2, enabledTarget: { accountId: "fixture", target: "recipient", enabledAt: clock }, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null } },
    dailyNews: { archive, researcher: new CodexHackerNewsResearcher(withArticleAssessment(async () => { summaries++; return JSON.stringify({ items: [{ section: "hackernews", title: "有限实验", source: "研究 / Hacker News",
      url: "https://example.com/article", publishedAt: "2026-10-15T00:00:00Z", summary: "这份研究仅验证所测任务的结果，不支持推广到所有系统。", brief: "研究结果仅限所测任务，不能推广到所有系统。" }] }); }),
    async () => [{ id: 1, rank: 1, title: "Original", url: "https://example.com/article", submittedAt: "2026-10-15T00:00:00Z", score: 10, comments: 3 }], () => clock,
    async () => { reads++; return { title: "Original", markdown: "这是不可重新抓取的已保存正文。研究仅验证所测任务的结果，不支持推广到所有系统。文中完整说明了实验范围与限制。" }; }) },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }), send: async ({ message }) => { outbox.push(message); return { ok: true }; } } });
  try {
    await tasks.tick();
    expect(tasks.newsSnapshot().occurrences[0]).toMatchObject({ execution: "succeeded", delivery: "accepted", news: { archiveWork: { status: "pending", attempts: 1 } } });
    fs.unlinkSync(path.join(vaultPath, "news")); clock += 600_000; await tasks.tick();
    expect(tasks.newsSnapshot().occurrences[0]).toMatchObject({ delivery: "accepted", news: { attempt: 1, archiveWork: { status: "succeeded", attempts: 2 } } });
    const matches = await archive.search("有限实验");
    expect(matches.length).toBeGreaterThan(0);
    expect((await Promise.all(matches.map((item) => archive.read(item.path)))).some((note) => note.content.includes("这是不可重新抓取的已保存正文。"))).toBe(true);
    expect({ reads, summaries, sends: outbox.length }).toEqual({ reads: 1, summaries: 1, sends: 1 });
    expect(outbox[0]).toContain("研究结果仅限所测任务，不能推广到所有系统。");
  } finally { tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("does not publish a late HN summary after its source deadline while AI is still running", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { NewsArticleStore } = await import("../src/news-article-store.js");
  const { CombinedNewsResearcher, CodexCliNewsResearcher } = await import("../src/codex-news-researcher.js");
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let finishHN!: () => void, finishAI!: () => void, enteredAI!: () => void;
  const hnWait = new Promise<void>((resolve) => { finishHN = resolve; }), aiWait = new Promise<void>((resolve) => { finishAI = resolve; }), aiStarted = new Promise<void>((resolve) => { enteredAI = resolve; });
  const item = { section: "hackernews", title: "观点", source: "研究", url: "https://example.com/late", publishedAt: "2026-10-15T00:00:00Z", summary: "结果只适用于所测任务。", brief: "结果只适用于所测任务。" };
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(async () => { await hnWait; return JSON.stringify({ items: [item] }); }),
    async () => [{ id: 1, rank: 1, title: "Late", url: item.url, submittedAt: item.publishedAt, score: 1, comments: 0 }], Date.now,
    async () => ({ title: "Original", markdown: "完整原文明确说明该结果只适用于所测任务，不支持推广。" }));
  const ai = new CodexCliNewsResearcher(withArticleAssessment(async () => { enteredAI(); await aiWait; return JSON.stringify({ items: [] }); }));
  const pending = new CombinedNewsResearcher(ai, hn, Date.now, 50).generate({ date: "2026-10-16", windowStart: Date.parse("2026-10-15T01:00:00Z"), windowEnd: Date.parse("2026-10-16T01:00:00Z"), articles: store.processor("owner", () => true) });
  try {
    await aiStarted; finishHN(); await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(store.processor("owner", () => true).process(item.url, false,
      async () => { throw new Error("must not fetch"); }, async () => { throw new Error("must not summarize"); })).rejects.toThrow("article_cache_unavailable");
  } finally { finishHN(); finishAI(); await pending; db.close(); }
});
