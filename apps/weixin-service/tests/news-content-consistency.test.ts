// Incident-shaped fixtures verify host admission, not the accuracy of arbitrary model judgments.
// Live semantic evaluation and user-operated phone acceptance are separately recorded.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { CodexHackerNewsResearcher } from "../src/codex-news-researcher.js";
import type { NewsItem } from "../src/daily-ai-news-scheduler.js";
import { NewsArticleStore } from "../src/news-article-store.js";

const incident = JSON.parse(fs.readFileSync(new URL("./fixtures/news-content-mismatch.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-17T14:00:00Z");
const window = { date: "2026-10-17", windowStart: now - 86_400_000, windowEnd: now, selection: { generalCount: 0, hackerNewsCount: 1 } };
const goodBody = { title: "Checking claims", markdown: "The article explains how independent checks detect unsupported claims before they reach readers." };
const good = { id: 2, rank: 2, title: "Why checking evidence matters", url: "https://example.test/checks", submittedAt: "2026-10-17T10:00:00Z", score: 50, comments: 2 };
const goodItem: NewsItem = { section: "hackernews", title: "核验观点", summary: "文章认为应在发布前独立核验主张，以拦截无依据的结论。", brief: "文章主张发布前独立核验，避免传播无依据的结论。", source: "研究 / Hacker News", url: good.url, publishedAt: good.submittedAt };

it("does not admit the incident's wrong-subject summary and fills from the next ranked article", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  const bad = { ...incident.candidate, id: 1, submittedAt: "2026-10-17T10:00:00Z" };
  const researcher = new CodexHackerNewsResearcher(async ({ prompt }) => prompt.includes(bad.url)
    ? JSON.stringify({ assessment: { status: "mismatched", evidence: "All ElevenLabs models are 50% off" }, items: [incident.item] })
    : JSON.stringify({ assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" }, items: [goodItem] }),
  async () => [bad, good], () => now, async (url) => url === bad.url ? incident.body : goodBody);
  try {
    const digest = await researcher.generate({ ...window, articles: store.processor("owner", () => true) });
    expect(digest.items.map((item) => item.title)).toEqual(["核验观点"]);
    expect(digest.hackerNewsTop?.map((item) => item.rank)).toEqual([2]);
    expect(() => store.body("owner", bad.url)).toThrow("article_cache_unavailable");
    expect(store.body("owner", good.url).markdown).toBe("The article explains how independent checks detect unsupported claims before they reach readers.");
  } finally { db.close(); }
});

it("refetches a rejected body on the next authorized attempt instead of retrying its cached advertisement", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let reads = 0;
  const researcher = new CodexHackerNewsResearcher(async ({ prompt }) => prompt.includes("ElevenLabs models")
    ? JSON.stringify({ assessment: { status: "mismatched", evidence: "All ElevenLabs models are 50% off" }, items: [] })
    : JSON.stringify({ assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" }, items: [goodItem] }),
  async () => [good], () => now, async () => ++reads === 1 ? incident.body : goodBody);
  try {
    const first = await researcher.generate({ ...window, articles: store.processor("owner", () => true) });
    expect(first.items).toEqual([]);
    const second = await researcher.generate({ ...window, articles: store.processor("owner", () => true) });
    expect(second.items.map((item) => item.title)).toEqual(["核验观点"]);
    expect(reads).toBe(2);
  } finally { db.close(); }
});

it.each([
  ["missing assessment", undefined],
  ["insufficient body", { status: "insufficient", evidence: "" }],
  ["unknown verdict", { status: "probably", evidence: "independent checks detect unsupported claims" }],
  ["fabricated evidence", { status: "matched", evidence: "The experiment ran on one million samples." }],
  ["metadata-only evidence", { status: "matched", evidence: "Why checking evidence matters" }],
  ["empty evidence", { status: "matched", evidence: "" }],
  ["oversized evidence", { status: "matched", evidence: "x".repeat(1001) }],
])("rejects %s without a summary rewrite or a false successful cache", async (_name, assessment) => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let calls = 0;
  const researcher = new CodexHackerNewsResearcher(async () => { calls++; return JSON.stringify({ assessment, items: [goodItem] }); },
    async () => [good], () => now, async () => goodBody);
  try {
    const digest = await researcher.generate({ ...window, articles: store.processor("owner", () => true) });
    expect(digest.items).toEqual([]);
    expect(digest.sources).toEqual({ hackernews: { status: "failed", code: "article_content_unverified" } });
    expect(() => store.body("owner", good.url)).toThrow("article_cache_unavailable");
    expect(calls).toBe(1);
  } finally { db.close(); }
});

it("accepts supported paraphrases and reuses the successful result without another read or model call", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let calls = 0, reads = 0;
  const researcher = new CodexHackerNewsResearcher(async () => { calls++; return JSON.stringify({
    assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" }, items: [goodItem],
  }); }, async () => [good], () => now, async () => { reads++; return goodBody; });
  try {
    await researcher.generate({ ...window, articles: store.processor("owner", () => true) });
    const reopened = new NewsArticleStore(db);
    const digest = await researcher.generate({ ...window, articles: reopened.processor("owner", () => true) });
    expect(digest.items).toMatchObject([{ title: "核验观点", brief: "文章主张发布前独立核验，避免传播无依据的结论。" }]);
    expect({ calls, reads }).toEqual({ calls: 1, reads: 1 });
  } finally { db.close(); }
});

it("rechecks correspondence on the one allowed brief rewrite", async () => {
  let calls = 0;
  const researcher = new CodexHackerNewsResearcher(async () => JSON.stringify(++calls === 1
    ? { assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" }, items: [{ ...goodItem, brief: "文章认为…" }] }
    : { assessment: { status: "mismatched", evidence: "" }, items: [] }), async () => [good], () => now, async () => goodBody);
  const digest = await researcher.generate(window);
  expect(digest.items).toEqual([]);
  expect(digest.sources).toEqual({ hackernews: { status: "failed", code: "article_content_mismatch" } });
  expect(calls).toBe(2);
});

it("applies the same admission rule to general-news articles using durable processing", async () => {
  const { CodexCliNewsResearcher, NEWS_DISCOVERY_SCHEMA } = await import("../src/codex-news-researcher.js");
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  const bad = { ...incident.candidate, publishedAt: "2026-10-17T10:00:00Z" };
  const researcher = new CodexCliNewsResearcher(async ({ schema, prompt }) => schema === NEWS_DISCOVERY_SCHEMA
    ? JSON.stringify({ items: [{ ...bad, source: "OpenRouter" }, { ...good, source: "研究", publishedAt: good.submittedAt }] })
    : prompt.includes(bad.url)
      ? JSON.stringify({ assessment: { status: "mismatched", evidence: "All ElevenLabs models are 50% off" }, items: [] })
      : JSON.stringify({ assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" }, items: [{ ...goodItem, section: "general" }] }),
  () => now, async (url) => url === bad.url ? incident.body : goodBody);
  try {
    const digest = await researcher.generate({ ...window, selection: { generalCount: 1, hackerNewsCount: 0 }, articles: store.processor("owner", () => true) });
    expect(digest.items).toMatchObject([{ section: "general", title: "核验观点" }]);
    expect(() => store.body("owner", bad.url)).toThrow("article_cache_unavailable");
  } finally { db.close(); }
});

it("validates an old successful mismatch once while retaining its original audit and never summarizing it again", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  const bad = { ...incident.candidate, id: 1, submittedAt: "2026-10-17T10:00:00Z" };
  let validations = 0, reads = 0;
  await store.processor("owner", () => true).process(bad.url, false, async () => incident.body, async () => incident.item);
  const researcher = new CodexHackerNewsResearcher(async ({ prompt }) => {
    validations++;
    expect(prompt).toContain("不得重新生成或改写摘要");
    return JSON.stringify({ assessment: { status: "mismatched", evidence: "All ElevenLabs models are 50% off" } });
  }, async () => [bad], () => now, async () => { reads++; return goodBody; });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const digest = await researcher.generate({ ...window, articles: new NewsArticleStore(db).processor("owner", () => true) });
      expect(digest.items).toEqual([]);
      expect(digest.sources).toEqual({ hackernews: { status: "failed", code: "article_content_mismatch" } });
    }
    expect({ validations, reads }).toEqual({ validations: 1, reads: 0 });
    expect(store.body("owner", bad.url).markdown).toContain("All ElevenLabs models are 50% off");
    const retained = await store.processor("owner", () => true).process(bad.url, false,
      async () => { throw new Error("must not fetch"); }, async () => { throw new Error("must not summarize"); });
    expect(retained?.title).toBe("ElevenLabs 模型限时五折优惠");
    expect(retained?.brief).toBe("OpenRouter 页面称，所有 ElevenLabs 模型享五折优惠，截至2026年10月19日；正文未提供候选标题所指的 DeepSeek 模型信息。");
  } finally { db.close(); }
});

it("validates a legacy match once across reopening and returns its unchanged short summary", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let validations = 0;
  try {
    await store.processor("owner", () => true).process(good.url, false, async () => goodBody, async () => goodItem);
    const researcher = new CodexHackerNewsResearcher(async () => { validations++; return JSON.stringify({ assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" } }); },
      async () => [good], () => now, async () => { throw new Error("legacy must not fetch"); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await researcher.generate({ ...window, articles: new NewsArticleStore(db).processor("owner", () => true) });
      expect(result.items).toMatchObject([{ title: "核验观点", brief: "文章主张发布前独立核验，避免传播无依据的结论。" }]);
    }
    expect(validations).toBe(1);
  } finally { db.close(); }
});

it.each(["invalid", "failure"])("does not repeat an unavailable legacy validation after %s", async (mode) => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let validations = 0;
  try {
    await store.processor("owner", () => true).process(good.url, false, async () => goodBody, async () => goodItem);
    const researcher = new CodexHackerNewsResearcher(async () => { validations++; if (mode === "failure") throw new Error("ECONNRESET"); return "{}"; },
      async () => [good], () => now, async () => { throw new Error("legacy must not fetch"); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await researcher.generate({ ...window, articles: new NewsArticleStore(db).processor("owner", () => true) });
      expect(result.items).toEqual([]);
      expect(result.sources).toEqual({ hackernews: { status: "failed", code: "article_content_unverified" } });
    }
    expect(validations).toBe(1);
    expect(store.body("owner", good.url).markdown).toBe("The article explains how independent checks detect unsupported claims before they reach readers.");
  } finally { db.close(); }
});

it("claims legacy validation once and fences a late matched result after cancellation", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db), controller = new AbortController();
  let finish!: (value: string) => void, started!: () => void, validations = 0;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  try {
    await store.processor("owner", () => true).process(good.url, false, async () => goodBody, async () => goodItem);
    const researcher = new CodexHackerNewsResearcher(async () => { validations++; started(); return new Promise<string>((resolve) => { finish = resolve; }); },
      async () => [good], () => now, async () => { throw new Error("legacy must not fetch"); });
    const pending = researcher.generate({ ...window, signal: controller.signal, articles: store.processor("owner", () => true) });
    await ready;
    const concurrent = await researcher.generate({ ...window, articles: new NewsArticleStore(db).processor("owner", () => true) });
    expect(concurrent.items).toEqual([]);
    controller.abort();
    finish(JSON.stringify({ assessment: { status: "matched", evidence: "independent checks detect unsupported claims before they reach readers" } }));
    await expect(pending).rejects.toThrow("worker_fenced");
    const reopened = await researcher.generate({ ...window, articles: new NewsArticleStore(db).processor("owner", () => true) });
    expect(reopened.items).toEqual([]);
    expect(validations).toBe(1);
    expect(store.body("owner", good.url).title).toBe("Checking claims");
  } finally { db.close(); }
});
