import { withArticleAssessment } from "./fixtures/assessed-news-run.js";
import { expect, it } from "vitest";
import { CodexCliNewsResearcher, CodexHackerNewsResearcher, CombinedNewsResearcher, type CodexNewsRun } from "../src/codex-news-researcher.js";

const now = Date.parse("2026-10-17T14:00:00Z");
const window = { date: "2026-10-17", windowStart: now - 86_400_000, windowEnd: now,
  instruction: "仅检索过去24小时 Hacker News 热门技术，按热度选取 Top 7；不再单独检索或发送 AI 新闻栏目。" };

// The external structured-model boundary returns a plan; real researchers enforce it.
// Real HN shape: hot-list rank differs from score order; no topic-search fixture.
it("executes seven current HN articles and skips the excluded general source", async () => {
  let generalDiscovery = 0;
  const run: CodexNewsRun = async ({ schema, prompt }) => {
    if ("generalCount" in (schema as { properties: object }).properties) return JSON.stringify({ supported: true, generalCount: 0, hackerNewsCount: 7 });
    const metadata = prompt.split("\n").find((line) => line.startsWith("候选元数据："));
    if (!metadata) { generalDiscovery++; return JSON.stringify({ items: [] }); }
    const candidate = JSON.parse(metadata.slice("候选元数据：".length)) as { title: string; url: string; submittedAt: string };
    return JSON.stringify({ items: [{ section: "hackernews", title: candidate.title, source: "研究 / Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
      summary: "研究通过对照实验说明方法有所改善，但结论仅限所测任务。", brief: "对照实验显示方法有所改善，但结论仅限所测任务。" }] });
  };
  const candidates = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, rank: i + 1, title: `技术文章${i + 1}`, url: `https://example.test/article/${i + 1}`,
    submittedAt: "2026-10-17T12:00:00Z", score: i === 1 ? 1000 : 100 - i, comments: 10 }));
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => candidates, () => now, async () => ({ title: "研究", markdown: "研究提供对照实验说明方法在所测任务中有所改善，并说明不能推广到其他任务。作者公开了方法及样本范围。" }));
  const researcher = new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => now, 360_000, run);
  const digest = await researcher.generate(window);
  expect(digest.items.map((item) => item.title)).toEqual(["技术文章1", "技术文章2", "技术文章3", "技术文章4", "技术文章5", "技术文章6", "技术文章7"]);
  expect(generalDiscovery).toBe(0);
  expect(digest.sources).toEqual({ hackernews: { status: "complete", requested: 7, selected: 7 } });
});

it("delivers seven current stories after history details expire and restart by reusing stored summaries", async () => {
  const { default: fs } = await import("node:fs"), { default: os } = await import("node:os"), { default: path } = await import("node:path");
  const { ScheduledTasks } = await import("../src/scheduled-tasks.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-current-seven-"));
  const { NewsArchive } = await import("../src/news-archive.js"), { DirectMarkdownVault } = await import("../src/direct-markdown-vault.js");
  const vaultPath = path.join(directory, "vault"); fs.mkdirSync(path.join(vaultPath, ".obsidian"), { recursive: true });
  const archive = new NewsArchive(new DirectMarkdownVault(vaultPath), async () => { throw new Error("archive must reuse body"); });
  let reads = 0, summaries = 0, boards = 0, clock = now;
  const outbox: string[] = [];
  const run: CodexNewsRun = async ({ schema, prompt }) => {
    if ("generalCount" in (schema as { properties: object }).properties) return JSON.stringify({ supported: true, generalCount: 0, hackerNewsCount: 7 });
    const metadata = prompt.split("\n").find((line) => line.startsWith("候选元数据："))!;
    const candidate = JSON.parse(metadata.slice("候选元数据：".length)) as { title: string; url: string; submittedAt: string };
    summaries++;
    return JSON.stringify({ items: [{ section: "hackernews", title: candidate.title, source: "研究 / Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
      summary: "研究通过对照实验说明方法有所改善，但结论仅限所测任务。", brief: "对照实验显示方法有所改善，但结论仅限所测任务。" }] });
  };
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => { boards++; return Array.from({ length: 10 }, (_, i) => ({ id: i + 1, rank: i + 1,
    title: `技术文章${i + 1}`, url: `https://example.test/article/${i + 1}`, submittedAt: "2026-10-17T12:00:00Z", score: 100 - i, comments: 10 })); }, () => clock,
  async () => { reads++; return { title: "研究", markdown: "研究提供对照实验说明方法在所测任务中有所改善，并说明不能推广到其他任务。作者公开了方法及样本范围。" }; });
  const options = { databasePath: path.join(directory, "tasks.sqlite"), now: () => clock, readOriginalText: () => "fixture request",
    dailyNewsImport: { sourceHash: "current-seven", state: { version: 2 as const, enabledTarget: { accountId: "fixture", target: "recipient", enabledAt: clock }, runs: [], seenItemKeys: [], summarizedArticleKeys: [], preview: null } },
    historyRetention: { maxAgeMs: 1000 },
    dailyNews: { archive, researcher: new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => clock, 360_000, run) },
    channel: { state: () => ({ enabled: true, credentialStatus: "usable" as const, credentialGeneration: "b", contextGeneration: "c" }),
      send: async ({ message }: { message: string }) => { outbox.push(message); return { ok: true }; } } };
  let tasks = new ScheduledTasks(options);
  const call = (tool: string, args: Record<string, unknown>, eventKey = tool) => tasks.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args },
    { accountId: "fixture", target: "recipient", eventKey, occurredAt: clock, originalTextRef: "source", attachmentRefs: [] });
  try {
    await call("edit", { reference: "AI 新闻日报", expectedRevision: 1, instruction: window.instruction, sourceText: "fixture request" });
    await call("disable", { reference: "AI 新闻日报", expectedRevision: 2, sourceText: "fixture request" });
    await call("run_now", { reference: "AI 新闻日报", expectedRevision: 3, sourceText: "fixture request" }, "first"); await tasks.tick();
    expect(outbox).toHaveLength(1); expect(outbox[0]).toContain("7. 技术文章7");
    clock += 1000; await tasks.tick();
    expect(await call("inspect", { reference: "AI 新闻日报" })).toMatchObject({ history: [{ bodyAvailable: false, detailsClearReason: "age", news: { sources: { hackernews: { selected: 7 } } } }] });
    tasks.close(); tasks = new ScheduledTasks(options); clock += 60_000;
    await call("run_now", { reference: "AI 新闻日报", expectedRevision: 3, sourceText: "fixture request" }, "second"); await tasks.tick();
    expect(outbox).toHaveLength(2); expect(outbox[1]).toContain("7. 技术文章7");
    expect({ reads, summaries, boards }).toEqual({ reads: 7, summaries: 7, boards: 2 });
    const audits = (await archive.search("Hacker News")).filter((item) => item.title.includes("Hacker News"));
    expect(audits).toHaveLength(2);
    expect(audits.map((item) => item.title)).toEqual(["2026-10-17 Hacker News 热门 7 篇", "2026-10-17 Hacker News 热门 7 篇"]);
    expect(tasks.newsSnapshot().occurrences.map((occurrence) => [occurrence.execution, occurrence.delivery])).toEqual([["succeeded", "accepted"], ["succeeded", "accepted"]]);
    expect(await call("inspect", { reference: "AI 新闻日报" })).toMatchObject({ task: { revision: 3, enabled: false, instruction: window.instruction } });
  } finally { tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("keeps the saved time window and reports a shortfall instead of silently filling with older stories", async () => {
  const { formatNewsDigest } = await import("../src/daily-ai-news-scheduler.js");
  const run: CodexNewsRun = async ({ schema, prompt }) => {
    if ("generalCount" in (schema as { properties: object }).properties) return JSON.stringify({ supported: true, generalCount: 0, hackerNewsCount: 7 });
    const candidate = JSON.parse(prompt.split("候选元数据：")[1]!.split("\n")[0]!) as { title: string; url: string; submittedAt: string };
    return JSON.stringify({ items: [{ section: "hackernews", title: candidate.title, source: "研究 / Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
      summary: "研究结果仅适用于所测任务。", brief: "研究结果仅适用于所测任务。" }] });
  };
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => Array.from({ length: 10 }, (_, i) => ({ id: i + 1, rank: i + 1, title: `技术文章${i + 1}`,
    url: `https://example.test/article/${i + 1}`, submittedAt: i < 2 ? "2026-10-15T12:00:00Z" : i === 2 ? "2026-10-18T12:00:00Z" : "2026-10-17T12:00:00Z", score: 100 - i, comments: 10 })), () => now,
    async (url) => { if (url.endsWith("/4")) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); return { title: "研究", markdown: "研究结果仅适用于所测任务，并提供了完整的实验过程与限制。" }; });
  const digest = await new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => now, 360_000, run).generate(window);
  expect(digest.items.map((item) => item.title)).toEqual(["技术文章5", "技术文章6", "技术文章7", "技术文章8", "技术文章9", "技术文章10"]);
  expect(digest.sources).toEqual({ hackernews: { status: "degraded", code: "ECONNRESET", requested: 7, selected: 6 } });
  expect(formatNewsDigest(digest)).toContain("目标 7 条，本次 6 条");
  expect(formatNewsDigest(digest)).toContain("连接中断");
});

it("cancels a stuck selection step before starting either news source", async () => {
  let aborted = false, reads = 0;
  const run: CodexNewsRun = ({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
  });
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => { reads++; return []; });
  await expect(new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => now, 20, run).generate(window)).rejects.toThrow("news_selection_timeout");
  expect({ aborted, reads }).toEqual({ aborted: true, reads: 0 });
}, 500);

it.each([2, 10])("uses the requested HN count %i without a five-or-seven special case", async (count) => {
  const { formatNewsDigest, isValidHackerNewsSelection } = await import("../src/daily-ai-news-scheduler.js");
  const run: CodexNewsRun = async ({ schema, prompt }) => {
    if ("generalCount" in (schema as { properties: object }).properties) return JSON.stringify({ supported: true, generalCount: 0, hackerNewsCount: count });
    const candidate = JSON.parse(prompt.split("候选元数据：")[1]!.split("\n")[0]!) as { title: string; url: string; submittedAt: string };
    return JSON.stringify({ items: [{ section: "hackernews", title: candidate.title, source: "研究 / Hacker News", url: candidate.url, publishedAt: candidate.submittedAt,
      summary: "研究结果仅适用于所测任务。", brief: "研究结果仅适用于所测任务。" }] });
  };
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => Array.from({ length: 10 }, (_, i) => ({ id: i + 1, rank: i + 1, title: `技术文章${i + 1}`,
    url: `https://example.test/article/${i + 1}`, submittedAt: "2026-10-17T12:00:00Z", score: 100 - i, comments: 10 })), () => now,
    async () => ({ title: "研究", markdown: "研究结果仅适用于所测任务，并提供了完整的实验过程与限制。" }));
  const digest = await new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => now, 360_000, run).generate({ ...window, instruction: `只要 Hacker News Top ${count}` });
  expect(digest.items).toHaveLength(count); expect(digest.items.at(-1)?.title).toBe(`技术文章${count}`);
  expect(isValidHackerNewsSelection(digest)).toBe(true);
  expect(Array.from(formatNewsDigest(digest)).length).toBeLessThanOrEqual(1500);
});

it.each([
  "not-json", "null", '{"supported":true,"generalCount":0,"hackerNewsCount":11}',
  '{"supported":true,"generalCount":4,"hackerNewsCount":7}', '{"supported":true,"generalCount":0,"hackerNewsCount":0}',
  '{"supported":true,"generalCount":-1,"hackerNewsCount":7}', '{"supported":true,"generalCount":0,"hackerNewsCount":2.5}',
  '{"supported":false,"generalCount":0,"hackerNewsCount":7}', '{"supported":true,"generalCount":0,"hackerNewsCount":7,"recipient":"foreign"}',
])("rejects invalid selection without silently falling back: %s", async (output) => {
  let discovery = 0;
  const read = async () => { discovery++; return JSON.stringify({ items: [] }); };
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(read), async () => { discovery++; return []; });
  await expect(new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(read)), hn, () => now, 360_000, async () => output).generate(window)).rejects.toThrow("news_selection_invalid");
  expect(discovery).toBe(0);
});

it("does not call HN for an AI-only plan and explains a zero-candidate shortfall", async () => {
  const { formatNewsDigest } = await import("../src/daily-ai-news-scheduler.js");
  let hnReads = 0;
  const progress: Array<Record<string, unknown>> = [];
  const run: CodexNewsRun = async ({ schema }) => JSON.stringify("generalCount" in (schema as { properties: object }).properties
    ? { supported: true, generalCount: 3, hackerNewsCount: 0 } : { items: [] });
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => { hnReads++; return []; });
  const digest = await new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => now, 360_000, run).generate({ ...window, instruction: "只要三条 AI 新闻", observe: (event, attributes) => { if (event === "source.end") progress.push(attributes); } });
  expect(hnReads).toBe(0);
  expect(progress).toEqual([{ source: "general", status: "empty", code: "insufficient_candidates", requested: 3, selected: 0, items: 0 }]);
  expect(digest.sources).toEqual({ general: { status: "empty", code: "insufficient_candidates", requested: 3, selected: 0 } });
  expect(formatNewsDigest(digest)).toContain("目标 3 条，本次 0 条");
});

it("fails if its only requested source fails instead of publishing a successful empty report", async () => {
  const run: CodexNewsRun = async () => JSON.stringify({ supported: true, generalCount: 0, hackerNewsCount: 7 });
  const hn = new CodexHackerNewsResearcher(withArticleAssessment(run), async () => { throw new Error("unavailable"); });
  await expect(new CombinedNewsResearcher(new CodexCliNewsResearcher(withArticleAssessment(run)), hn, () => now, 360_000, run).generate(window)).rejects.toThrow("all_news_sources_failed");
});
