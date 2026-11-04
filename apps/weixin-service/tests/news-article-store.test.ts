import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { NewsArticleStore } from "../src/news-article-store.js";

const url = "https://example.com/article";
const body = { title: "Original", markdown: "This is the complete original source text with its conditions and limitations." };
const item = { title: "研究", source: "Source", url, publishedAt: "2026-10-16T00:00:00Z", summary: "SOURCE_SUMMARY", brief: "结果仅适用于所测任务。" };

it("admits one processor per identity and never regenerates a successful result", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let release!: () => void, summaries = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = store.processor("owner", () => true).process(url, false, async () => body, async () => { summaries++; await pending; return item; });
    await expect(store.processor("owner", () => true).process(`${url}?utm_source=second`, false, async () => body, async () => { summaries++; return item; })).rejects.toThrow("article_cache_unavailable");
    release(); await first;
    await expect(store.processor("owner", () => true).process(url, true, async () => { throw new Error("must not fetch"); }, async () => { throw new Error("must not summarize"); }))
      .resolves.toMatchObject({ summary: "SOURCE_SUMMARY", brief: "结果仅适用于所测任务。" });
    expect(summaries).toBe(1);
  } finally { release(); db.close(); }
});

it("fences late model completion after cancellation and does not silently repeat an uncertain attempt", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db), controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const first = store.processor("owner", () => true, controller.signal).process(url, false, async () => body, async () => { entered(); await pending; return item; });
    await started; controller.abort(); release(); await expect(first).rejects.toThrow("worker_fenced");
    await expect(store.processor("owner", () => true).process(url, false, async () => { throw new Error("must not fetch"); }, async () => item)).rejects.toThrow("article_cache_unavailable");
  } finally { release(); db.close(); }
});

it("detects damaged stored content after reopening without treating it as a cache miss", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "news-cache-damage-")), file = path.join(root, "cache.sqlite");
  let db = new DatabaseSync(file);
  try {
    await new NewsArticleStore(db).processor("owner", () => true).process(url, false, async () => body, async () => item);
    db.close();
    const bytes = fs.readFileSync(file), offset = bytes.indexOf(Buffer.from("SOURCE_SUMMARY"));
    expect(offset).toBeGreaterThan(0);
    Buffer.from("BROKEN_SUMMARY").copy(bytes, offset); fs.writeFileSync(file, bytes);
    db = new DatabaseSync(file);
    await expect(new NewsArticleStore(db).processor("owner", () => true).process(url, false,
      async () => { throw new Error("must not fetch"); }, async () => item)).rejects.toThrow("article_cache_unavailable");
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("refuses new model work at reserved capacity while leaving successful articles readable", async () => {
  const db = new DatabaseSync(":memory:"), store = new NewsArticleStore(db);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const pending: Array<Promise<unknown>> = [];
  try {
    await store.processor("owner", () => true).process(url, false, async () => body, async () => item);
    for (let index = 0; index < 252; index++) {
      const next = `https://example.com/reserved-${index}`;
      pending.push(store.processor("owner", () => true).process(next, false, async () => body,
        async () => { await waiting; return { ...item, url: next }; }));
    }
    await expect(store.processor("owner", () => true).process("https://example.com/overflow", false,
      async () => { throw new Error("must not fetch beyond capacity"); }, async () => item)).rejects.toThrow("article_capacity");
    expect(await store.processor("owner", () => true).process(url, true, async () => body,
      async () => { throw new Error("must not summarize again"); })).toMatchObject({ summary: "SOURCE_SUMMARY" });
  } finally { release(); await Promise.all(pending); db.close(); }
});
