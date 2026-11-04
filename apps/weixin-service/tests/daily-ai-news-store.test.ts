import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";
import { articleKey } from "../src/news-article-identity.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("DailyAiNewsFileStore", () => {
  it("atomically round-trips a private non-secret delivery ledger", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    const file = path.join(dir, "daily-ai-news.json");
    const store = new DailyAiNewsFileStore(file);
    const initial = store.load();
    expect(initial).toMatchObject({ version: 2, enabledTarget: null, runs: [] });

    store.save({
      ...initial,
      enabledTarget: { accountId: "bot-a", target: "user@im.wechat", enabledAt: 1 },
    });

    expect(store.load().enabledTarget).toEqual({
      accountId: "bot-a",
      target: "user@im.wechat",
      enabledAt: 1,
    });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });

  it("persists a safe same-day retry plan across service restarts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    const store = new DailyAiNewsFileStore(path.join(dir, "daily-ai-news.json"));
    const state = store.load();

    store.save({
      ...state,
      runs: [{
        runKey: "2026-08-15",
        accountId: "bot-a",
        target: "user@im.wechat",
        status: "failed",
        createdAt: 100,
        updatedAt: 200,
        attempt: 2,
        failureStage: "research",
        failureCode: "codex_process",
        nextRetryAt: 300,
        lastFailure: {
          stage: "research",
          code: "codex_usage_limit",
          attempt: 1,
          at: 150,
        },
        error: "AI 新闻研究失败",
        failureNotice: {
          status: "pending_inbound",
          updatedAt: 210,
          message: "安全失败通知",
        },
      }],
    });

    expect(store.load()).toMatchObject({
      version: 2,
      runs: [{
        attempt: 2,
        failureStage: "research",
        failureCode: "codex_process",
        nextRetryAt: 300,
        lastFailure: {
          stage: "research",
          code: "codex_usage_limit",
          attempt: 1,
          at: 150,
        },
        failureNotice: {
          status: "pending_inbound",
          updatedAt: 210,
          message: "安全失败通知",
        },
      }],
    });
  });

  it("rejects an unknown persisted last-failure code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "daily-ai-news.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      enabledTarget: null,
      runs: [{
        runKey: "2026-08-20",
        accountId: "bot-a",
        target: "user@im.wechat",
        status: "accepted",
        createdAt: 100,
        updatedAt: 200,
        lastFailure: {
          stage: "research",
          code: "private_raw_error",
          attempt: 1,
          at: 150,
        },
      }],
      seenItemKeys: [],
      summarizedArticleKeys: [],
      preview: null,
    }), { mode: 0o600 });

    expect(() => new DailyAiNewsFileStore(file).load()).toThrow(/状态格式无效/u);
  });

  it("migrates only the two known v1 background failures into retryable runs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "daily-ai-news.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      enabledTarget: { accountId: "bot-a", target: "user@im.wechat", enabledAt: 1 },
      runs: [{
        runKey: "2026-08-15",
        accountId: "bot-a",
        target: "user@im.wechat",
        status: "failed",
        createdAt: 100,
        updatedAt: 200,
        error: "AI 新闻研究失败",
      }, {
        runKey: "2026-08-14",
        accountId: "bot-a",
        target: "user@im.wechat",
        status: "failed",
        createdAt: 50,
        updatedAt: 60,
        error: "日报在发送前已被停用或切换目标",
      }],
      seenItemKeys: [],
      summarizedArticleKeys: [],
      preview: null,
    }), { mode: 0o600 });

    const state = new DailyAiNewsFileStore(file).load();

    expect(state.runs[0]).toMatchObject({
      attempt: 1,
      failureStage: "research",
      failureCode: "research_unknown",
      nextRetryAt: 200,
    });
    expect(state.runs[1]).not.toHaveProperty("failureStage");
    expect(state.runs[1]).not.toHaveProperty("nextRetryAt");
  });

  it("backfills normalized summarized article identities from an older preview", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "daily-ai-news.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      enabledTarget: null,
      runs: [],
      seenItemKeys: [],
      preview: {
        date: "2026-08-12",
        generatedAt: 1,
        items: [{
          title: "Article",
          summary: "Summary",
          source: "Example",
          url: "https://example.com/story?utm_source=old",
          publishedAt: "2026-08-12",
        }],
      },
    }), { mode: 0o600 });

    const state = new DailyAiNewsFileStore(file).load();

    expect(state.summarizedArticleKeys).toEqual([articleKey("https://example.com/story")]);
  });

  it("round-trips the fixed Hacker News Top 10 audit snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    const file = path.join(dir, "daily-ai-news.json");
    const store = new DailyAiNewsFileStore(file);
    const initial = store.load();
    store.save({
      ...initial,
      preview: {
        date: "2026-08-12",
        generatedAt: 1,
        items: [],
        hackerNewsTop: [{
          rank: 1,
          title: "Top story",
          source: "example.com",
          url: "https://example.com/top-story",
          submittedAt: "2026-08-12T00:00:00Z",
          score: 321,
          comments: 45,
          status: "not_selected",
        }],
        hackerNewsTopCapturedAt: 1_723_438_800_000,
      },
    });

    expect(store.load().preview?.hackerNewsTop).toEqual([expect.objectContaining({
      rank: 1,
      score: 321,
      status: "not_selected",
    })]);
    expect(store.load().preview?.hackerNewsTopCapturedAt).toBe(1_723_438_800_000);
  });

  it("keeps migrated summarized history within its durable bound", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-news-store-"));
    dirs.push(dir);
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "daily-ai-news.json");
    const summarizedArticleKeys = Array.from(
      { length: 100_000 },
      (_, index) => index.toString(16).padStart(64, "0"),
    );
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      enabledTarget: null,
      runs: [],
      seenItemKeys: [],
      summarizedArticleKeys,
      preview: {
        date: "2026-08-12",
        generatedAt: 1,
        items: [{
          title: "Newest",
          summary: "Summary",
          source: "Example",
          url: "https://example.com/newest",
          publishedAt: "2026-08-12",
        }],
      },
    }), { mode: 0o600 });

    const state = new DailyAiNewsFileStore(file).load();

    expect(state.summarizedArticleKeys).toHaveLength(100_000);
    expect(state.summarizedArticleKeys).toContain(articleKey("https://example.com/newest"));
    expect(state.summarizedArticleKeys).not.toContain(summarizedArticleKeys[0]);
  });
});
