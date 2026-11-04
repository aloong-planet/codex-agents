import { describe, expect, it, vi } from "vitest";

import {
  DailyAiNewsScheduler,
  formatNewsDigest,
  type DailyAiNewsState,
  type DailyAiNewsStore,
  type NewsDigest,
  type NewsResearchWindow,
} from "../src/daily-ai-news-scheduler.js";
import type {
  ChannelSnapshot,
  InboundTextEvent,
  SendTextResult,
} from "../src/demo-service.js";
import { articleKey } from "../src/news-article-identity.js";
import { segmentWeixinText } from "../src/weixin-text-segmenter.js";

class MemoryStore implements DailyAiNewsStore {
  state: DailyAiNewsState = {
    version: 2,
    enabledTarget: null,
    runs: [],
    seenItemKeys: [],
    summarizedArticleKeys: [],
    preview: null,
  };
  load(): DailyAiNewsState { return structuredClone(this.state); }
  save(state: DailyAiNewsState): void { this.state = structuredClone(state); }
}

class FakeChannel {
  sent: Array<{ accountId: string; target: string; message: string }> = [];
  sendResult: SendTextResult = { ok: true, messageId: "accepted-1" };
  sendError: Error | null = null;
  inbound: ((event: InboundTextEvent) => void) | undefined;
  command: ((event: InboundTextEvent) => boolean) | undefined;
  snapshot: ChannelSnapshot = {
    accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
    targets: [{ accountId: "bot-a", target: "user@im.wechat" }],
  };
  getSnapshot(): ChannelSnapshot { return structuredClone(this.snapshot); }
  onInboundText(listener: (event: InboundTextEvent) => void): () => void {
    this.inbound = listener;
    return () => { this.inbound = undefined; };
  }
  onInboundCommand(handler: (event: InboundTextEvent) => boolean): () => void {
    this.command = handler;
    return () => { this.command = undefined; };
  }
  async sendText(input: { accountId: string; target: string; message: string }) {
    this.sent.push(input);
    if (this.sendError) throw this.sendError;
    return this.sendResult;
  }
}

function digest(date = "2026-08-12"): NewsDigest {
  return {
    date,
    generatedAt: Date.parse("2026-08-12T04:00:00Z"),
    items: [{
      title: "OpenAI 发布新研究",
      summary: "介绍一项可核查的模型进展。",
      source: "OpenAI",
      url: "https://openai.com/news/example",
      publishedAt: "2026-08-12",
    }],
  };
}

describe("DailyAiNewsScheduler", () => {
  it("keeps all ten maximum-size briefs intact with long Unicode metadata in one message", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      section: index < 5 ? "hackernews" as const : "general" as const,
      title: "🧠".repeat(100), source: "🧪".repeat(60),
      summary: "详细摘要保存在本地，不替代微信短版。", brief: "研究" + "🚀".repeat(77) + "。",
      url: `https://example.com/budget-${index}`, publishedAt: "2026-08-12T00:00:00Z",
    }));
    const message = formatNewsDigest({ ...digest(), items });
    const blocks = message.split("\n\n").filter((part) => /^\d+\. /u.test(part));
    expect(blocks).toHaveLength(10);
    for (const block of blocks) {
      expect(Array.from(block).length).toBeLessThanOrEqual(280);
      expect(block.split("\n")[1]).toBe("研究" + "🚀".repeat(77) + "。");
    }
    expect(Array.from(message).length).toBeLessThanOrEqual(1500);
    expect(segmentWeixinText(message).segments).toHaveLength(1);
  });

  it("reserves room for source warnings without truncating any maximum-size brief", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      section: index < 5 ? "hackernews" as const : "general" as const,
      title: "🧠".repeat(100), source: "🧪".repeat(60),
      summary: "详细摘要保存在本地，不替代微信短版。", brief: "研究" + "🚀".repeat(77) + "。",
      url: `https://example.com/budget-${index}`, publishedAt: "2026-08-12T00:00:00Z",
    }));
    const message = formatNewsDigest({ ...digest(), items, sources: { hackernews: { status: "degraded", code: "ECONNRESET" }, general: { status: "degraded", code: "article_cache_unavailable" } } });
    expect(message).toContain("本次未完整包含 Hacker News");
    const blocks = message.split("\n\n").filter((part) => /^\d+\. /u.test(part));
    expect(blocks).toHaveLength(10);
    for (const block of blocks) {
      expect(Array.from(block).length).toBeLessThanOrEqual(280);
      expect(block.split("\n")[1]).toBe("研究" + "🚀".repeat(77) + "。");
    }
    expect(Array.from(message).length).toBeLessThanOrEqual(1500);
    expect(segmentWeixinText(message).segments).toHaveLength(1);
  });

  it("does not cut legacy long summaries into incomplete viewpoints", () => {
    const message = formatNewsDigest({ ...digest(), items: [{ ...digest().items[0]!, summary: "原文核心论证及限制".repeat(100) }] });
    expect(message).toContain("旧版摘要未提供完整短版，可查看本地详细归档。");
    expect(message).not.toContain("…");
    expect(message).not.toContain("原文核心论证及限制");
  });

  it("rejects invalid prepared brief text instead of cutting or silently substituting it", () => {
    expect(() => formatNewsDigest({ ...digest(), items: [{ ...digest().items[0]!, brief: "不能直接推出所有任务都能成功，因为…" }] }))
      .toThrow(/短摘要/u);
  });

  it("preserves a conclusion and multiline article points in the WeChat digest", () => {
    const message = formatNewsDigest({
      date: "2026-08-12",
      generatedAt: 1,
      items: [{
        section: "hackernews",
        title: "模型推理轨迹提取研究",
        summary: "结论：加密推理块可被同供应商弱模型转录。\n- 先取得强模型返回的加密块，再跨模型注入。\n- 弱模型逐 token 输出内容，攻击不需要越狱强模型。\n- 公开样本中还发现个人信息和凭据泄漏。",
        source: "arXiv",
        url: "https://example.com/paper",
        publishedAt: "2026-08-12T00:00:00Z",
      }],
    });

    expect(message).toContain("结论：加密推理块可被同供应商弱模型转录。");
    expect(message).toContain("- 先取得强模型返回的加密块，再跨模型注入。");
    expect(message).toContain("- 弱模型逐 token 输出内容，攻击不需要越狱强模型。");
    expect(message).toContain("来源：arXiv");
    expect(message).toContain("Hacker News 热门技术");
    expect(message).not.toContain("https://example.com/paper");
  });

  it("formats as many as ten compact items with source names but no concrete links", () => {
    const tenItems = Array.from({ length: 10 }, (_, index) => ({
      section: index < 3 ? "hackernews" as const : "general" as const,
      title: `LLM 技术更新 ${index + 1}`,
      summary: "模型推理能力获得可核查改进。",
      source: `研究机构 ${index + 1}`,
      url: `https://example.com/research-${index + 1}`,
      publishedAt: "2026-08-12T00:00:00Z",
    }));
    const message = formatNewsDigest({ ...digest(), items: tenItems });

    expect(message).toContain("10. LLM 技术更新 10");
    expect(message).toContain("来源：研究机构 10");
    expect(message).toContain("Hacker News 热门技术");
    expect(message).not.toContain("https://");
    expect(Array.from(message).length).toBeLessThanOrEqual(1_500);
  });

  it("keeps five long articles in one Weixin message", () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      section: "hackernews" as const,
      title: `长摘要新闻 ${index + 1}`,
      summary: [
        `背景：${"背景细节".repeat(45)}`,
        `进展：${"实现步骤".repeat(45)}`,
        "证据：",
        `- ${"关键数字".repeat(45)}`,
        `影响：${"影响限制".repeat(45)}`,
      ].join("\n"),
      source: `来源 ${index + 1}`,
      url: `https://example.com/long-${index + 1}`,
      publishedAt: "2026-08-12T00:00:00Z",
    }));

    const message = formatNewsDigest({ ...digest(), items });

    expect(Array.from(message).length).toBeLessThanOrEqual(1_500);
    expect(segmentWeixinText(message).segments).toHaveLength(1);
    for (let index = 1; index <= 5; index += 1) {
      expect(message).toContain(`${index}. 长摘要新闻 ${index}`);
      expect(message).toContain(`来源：来源 ${index}`);
    }
  });

  it("caps each visible item at 280 code points while preserving the complete short argument", () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      section: "hackernews" as const,
      title: `结构化新闻 ${index + 1}`,
      brief: "实验支持该方法改善所测任务，但未证明它能推广到其他场景。",
      summary: [
        `背景：${"问题背景".repeat(35)}`,
        `进展：${"核心做法".repeat(35)}`,
        "证据：",
        `- ${"关键证据".repeat(35)}`,
        `影响：${"实际影响".repeat(35)}`,
      ].join("\n"),
      source: `研究来源 ${index + 1}`,
      url: `https://example.com/structured-${index + 1}`,
      publishedAt: "2026-08-12T00:00:00Z",
    }));

    const blocks = formatNewsDigest({ ...digest(), items })
      .split("\n\n")
      .filter((part) => /^\d+\. /u.test(part));

    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      expect(Array.from(block).length).toBeLessThanOrEqual(280);
      expect(block).toContain("实验支持该方法改善所测任务，但未证明它能推广到其他场景。");
      expect(block).not.toMatch(/背景：|进展：|证据：|影响：|…/u);
      expect(block).toContain("来源：");
    }
  });

  it("truncates emoji-heavy news fields only at Unicode code-point boundaries", () => {
    const message = formatNewsDigest({
      ...digest(),
      items: Array.from({ length: 5 }, (_, index) => ({
        section: "general" as const,
        title: `模型进展 ${index + 1} ${"🧠".repeat(80)}`,
        summary: `背景：${"🚀".repeat(180)}\n进展：${"🔬".repeat(180)}\n证据：\n- ${"📊".repeat(180)}\n影响：${"🌏".repeat(180)}`,
        source: `实验室 ${"🧪".repeat(80)}`,
        url: `https://example.com/emoji-${index + 1}`,
        publishedAt: "2026-08-12T00:00:00Z",
      })),
    });

    expect(Array.from(message).length).toBeLessThanOrEqual(1_500);
    expect(message).toContain("…");
    expect(Array.from(message).every((point) => {
      if (point.length !== 1) return true;
      const code = point.charCodeAt(0);
      return code < 0xD800 || code > 0xDFFF;
    })).toBe(true);
  });

  it("rejects a duplicate manual preview while research is already running", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let release!: (value: NewsDigest) => void;
    const gate = new Promise<NewsDigest>((resolve) => { release = resolve; });
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: () => gate },
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    const first = scheduler.preview();
    await expect(scheduler.preview()).rejects.toThrow(/正在执行/);
    expect(scheduler.getPublicState().status).toBe("researching");
    release(digest());
    await first;
  });

  it("archives a manual preview before exposing it as ready", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const archive = { archive: vi.fn(async () => ({
      summaryPath: "news/2026-08-12/摘要.md",
      hackerNewsTopPath: "news/2026-08-12/Hacker News Top 5.md",
      archived: [{ title: "OpenAI 发布新研究", path: "news/2026-08-12/openai.md" }],
      skipped: [],
    })) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      archive,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.preview();

    expect(archive.archive).toHaveBeenCalledWith(digest());
    expect(scheduler.getPublicState()).toMatchObject({
      status: "ready",
      archive: {
        summaryPath: "news/2026-08-12/摘要.md",
        hackerNewsTopPath: "news/2026-08-12/Hacker News Top 5.md",
        archivedCount: 1,
        skippedCount: 0,
        totalCount: 1,
      },
    });
    expect(channel.sent).toHaveLength(0);
  });

  it("backfills a persisted preview into the archive on service start without sending", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    store.state.preview = digest();
    const archive = { archive: vi.fn(async () => ({ summaryPath: "news/2026-08-12/摘要.md" })) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      archive,
      researcher: { generate: vi.fn(async () => digest()) },
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();

    expect(archive.archive).toHaveBeenCalledWith(digest());
    expect(store.state.summarizedArticleKeys).toHaveLength(1);
    expect(channel.sent).toHaveLength(0);
  });

  it("reports a Vault archive failure without sending the digest", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      archive: { archive: vi.fn(async () => { throw new Error("Vault unavailable"); }) },
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message).toContain("阶段：本地归档");
    expect(channel.sent[0]?.message).toContain("原因：本地 Vault 归档不可用");
    expect(channel.sent[0]?.message).not.toContain("OpenAI 发布新研究");
    expect(store.state.runs[0]).toMatchObject({ status: "failed", error: "AI 新闻归档失败" });
  });

  it("sends only the final HN items that the Vault archive kept", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const original: NewsDigest = {
      date: "2026-08-12",
      generatedAt: Date.parse("2026-08-12T04:00:00Z"),
      items: [1, 2].map((rank) => ({
        section: "hackernews" as const,
        title: rank === 1 ? "归档失败的 HN" : "成功归档的 HN",
        summary: "完整摘要内容。",
        source: "Hacker News",
        url: `https://example.com/hn-${rank}`,
        publishedAt: "2026-08-12T00:00:00Z",
      })),
      hackerNewsTop: [1, 2].map((rank) => ({
        rank,
        title: `HN ${rank}`,
        source: "example.com",
        url: `https://example.com/hn-${rank}`,
        submittedAt: "2026-08-12T00:00:00Z",
        score: 10,
        comments: 2,
        status: "summarized" as const,
      })),
    };
    const finalDigest: NewsDigest = {
      ...original,
      items: original.items.slice(1),
      hackerNewsTop: original.hackerNewsTop!.slice(1),
    };
    const archive = { archive: vi.fn(async () => ({
      digest: finalDigest,
      summaryPath: "news/2026-08-12/摘要.md",
      hackerNewsTopPath: "news/2026-08-12/Hacker News 热门 1 篇.md",
      archived: [{ title: "成功归档的 HN", path: "news/2026-08-12/hn-2.md" }],
      skipped: [{ title: "归档失败的 HN", reason: "正文无法取得" }],
    })) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      archive,
      researcher: { generate: async () => original },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(channel.sent[0]?.message).toContain("成功归档的 HN");
    expect(channel.sent[0]?.message).not.toContain("归档失败的 HN");
    expect(scheduler.getPublicState().preview?.items.map((item) => item.title)).toEqual(["成功归档的 HN"]);
  });

  it("schedules 08:30 Shanghai without sending early", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const setTimer = vi.fn(() => 1);
    const researcher = { generate: vi.fn(async () => digest()) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T00:00:00Z"), // 上海 08:00
      setTimer,
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(researcher.generate).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
    expect(scheduler.getPublicState().nextRunAt).toBe(Date.parse("2026-08-12T00:30:00Z"));
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 30 * 60 * 1000);
  });

  it("catches up immediately when enabled after 08:30 and sends only today's run once", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const researcher = { generate: vi.fn(async () => digest()) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T04:00:00Z"), // 上海 12:00
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    await scheduler.start();

    expect(researcher.generate).toHaveBeenCalledTimes(1);
    expect(researcher.generate).toHaveBeenCalledWith({
      date: "2026-08-12",
      windowStart: Date.parse("2026-08-11T04:00:00Z"),
      windowEnd: Date.parse("2026-08-12T04:00:00Z"),
      excludedArticleKeys: [],
    });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message).toContain("2026-08-12 AI 新闻");
    expect(store.state.runs).toMatchObject([{ runKey: "2026-08-12", status: "accepted" }]);
  });

  it("retries a failed background research run after ten minutes without a preview click", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    let scheduled: (() => void) | undefined;
    const setTimer = vi.fn((callback: () => void) => {
      scheduled = callback;
      return 1;
    });
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1)"))
        .mockResolvedValueOnce(digest()),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer,
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(researcher.generate).toHaveBeenCalledTimes(1);
    expect(channel.sent).toHaveLength(1);
    expect(store.state.runs[0]).toMatchObject({ status: "failed" });
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 10 * 60 * 1000);

    now += 10 * 60 * 1000;
    scheduled?.();
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));

    expect(researcher.generate).toHaveBeenCalledTimes(2);
    expect(channel.sent).toHaveLength(2);
    scheduler.close();
  });

  it("retains the last safe quota diagnosis after a later retry succeeds", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-20T00:30:00Z");
    let scheduled: (() => void) | undefined;
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1): CODEX_USAGE_LIMIT"))
        .mockResolvedValueOnce(digest("2026-08-20")),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer: vi.fn((callback: () => void) => {
        scheduled = callback;
        return 1;
      }),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    now += 10 * 60 * 1000;
    scheduled?.();
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));

    expect(store.state.runs[0]).toMatchObject({
      status: "accepted",
      attempt: 2,
      lastFailure: {
        stage: "research",
        code: "codex_usage_limit",
        attempt: 1,
        at: Date.parse("2026-08-20T00:30:00Z"),
      },
    });
    expect(store.state.runs[0]).not.toHaveProperty("failureCode");
    expect(scheduler.getPublicState().lastRun?.lastFailure).toMatchObject({
      code: "codex_usage_limit",
      attempt: 1,
    });
    expect(JSON.stringify(store.state.runs[0])).not.toContain("usage limit");
    scheduler.close();
  });

  it("backs off failed background research by 10, 30, 60 and then 60 minutes", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    let scheduled: (() => void) | undefined;
    const setTimer = vi.fn((callback: () => void) => {
      scheduled = callback;
      return 1;
    });
    const researcher = { generate: vi.fn(async () => { throw new Error("Codex 新闻检索失败 (1)"); }) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer,
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 10 * 60 * 1000);

    for (const expectedDelay of [30, 60, 60]) {
      const retryAt = store.state.runs[0]?.nextRetryAt;
      expect(retryAt).toBeTypeOf("number");
      now = retryAt!;
      scheduled?.();
      await vi.waitFor(() => expect(store.state.runs[0]?.attempt).toBe(researcher.generate.mock.calls.length));
      expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), expectedDelay * 60 * 1000);
    }

    expect(researcher.generate).toHaveBeenCalledTimes(4);
    expect(channel.sent).toHaveLength(4);
    scheduler.close();
  });

  it("restores a persisted retry deadline after restart", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    const first = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => { throw new Error("Codex 新闻检索失败 (1)"); }) },
      now: () => now,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await first.start();
    await first.enable("bot-a", "user@im.wechat");
    first.close();

    now += 5 * 60 * 1000;
    let scheduled: (() => void) | undefined;
    const setTimer = vi.fn((callback: () => void) => {
      scheduled = callback;
      return 2;
    });
    const researcher = { generate: vi.fn(async () => digest()) };
    const restored = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer,
      clearTimer: vi.fn(),
    });

    await restored.start();
    expect(researcher.generate).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 5 * 60 * 1000);
    expect(restored.getPublicState().notice).toMatch(/后台.*重试/);

    now += 5 * 60 * 1000;
    scheduled?.();
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));
    expect(researcher.generate).toHaveBeenCalledTimes(1);
    restored.close();
  });

  it("does not carry a late failed retry into the next Shanghai day", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const now = Date.parse("2026-08-12T15:50:00Z"); // 上海 23:50
    const setTimer = vi.fn(() => 1);
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => { throw new Error("Codex 新闻检索失败 (1)"); }) },
      now: () => now,
      setTimer,
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(store.state.runs[0]).toMatchObject({ status: "failed", attempt: 1 });
    expect(store.state.runs[0]).not.toHaveProperty("nextRetryAt");
    expect(scheduler.getPublicState().nextRunAt).toBe(Date.parse("2026-08-13T00:30:00Z"));
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 8 * 60 * 60 * 1000 + 40 * 60 * 1000);
    scheduler.close();
  });

  it("reuses today's cached digest when retrying a failed Vault archive", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    let scheduled: (() => void) | undefined;
    const researcher = { generate: vi.fn(async () => digest()) };
    const archive = {
      archive: vi.fn()
        .mockRejectedValueOnce(new Error("Vault unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      archive,
      now: () => now,
      setTimer: vi.fn((callback: () => void) => {
        scheduled = callback;
        return 1;
      }),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    expect(store.state.runs[0]).toMatchObject({ status: "failed", failureStage: "archive" });

    now += 10 * 60 * 1000;
    scheduled?.();
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));

    expect(researcher.generate).toHaveBeenCalledTimes(1);
    expect(archive.archive).toHaveBeenCalledTimes(2);
    expect(channel.sent).toHaveLength(2);
    scheduler.close();
  });

  it("publishes only a safe classified research failure", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => { throw new Error("Codex 新闻检索未执行实时网页搜索: private details"); }) },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(scheduler.getPublicState().lastRun).toMatchObject({
      attempt: 1,
      failureStage: "research",
      failureCode: "insufficient_search",
      nextRetryAt: Date.parse("2026-08-12T04:10:00Z"),
    });
    expect(JSON.stringify(scheduler.getPublicState())).not.toContain("private details");
  });

  it("immediately reports a classified background research failure to Weixin", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: {
        generate: vi.fn(async () => {
          throw new TypeError("fetch failed: ENOTFOUND private-news-host");
        }),
      },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message).toBe([
      "AI 新闻日报执行失败",
      "阶段：新闻研究",
      "原因：新闻源或网络暂时不可用",
      "尝试：第 1 次",
      "失败时间：2026-08-12 12:00:00",
      "下次自动重试：2026-08-12 12:10:00",
      "如需立即重试，请回复：立即重试日报",
    ].join("\n"));
    expect(channel.sent[0]?.message).not.toContain("private-news-host");
    expect(scheduler.getPublicState().lastRun?.failureNoticeStatus).toBe("accepted");
    expect(JSON.stringify(scheduler.getPublicState())).not.toContain("如需立即重试");
  });

  it("tells the Weixin user when Codex usage is exhausted", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: {
        generate: vi.fn(async () => {
          throw new Error(
            "Codex 新闻检索失败 (1): You've hit your usage limit. Try again later.",
          );
        }),
      },
      now: () => Date.parse("2026-08-20T00:30:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message).toContain("原因：Codex 使用额度已耗尽，等待额度恢复");
    expect(channel.sent[0]?.message).not.toContain("usage limit");
    expect(store.state.runs[0]).toMatchObject({
      status: "failed",
      failureStage: "research",
      failureCode: "codex_usage_limit",
    });
  });

  it("distinguishes a temporary Codex rate limit from exhausted usage", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: {
        generate: vi.fn(async () => {
          throw new Error("Codex 新闻检索失败 (1): CODEX_RATE_LIMIT");
        }),
      },
      now: () => Date.parse("2026-08-20T00:30:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(channel.sent[0]?.message).toContain("原因：Codex 请求频率受限，等待限流解除");
    expect(store.state.runs[0]?.failureCode).toBe("codex_rate_limit");
  });

  it("retries one context-stale failure notice after the same target sends inbound", async () => {
    const channel = new FakeChannel();
    channel.sendResult = {
      ok: false, reason: "context_stale", error: "stale", providerRet: -2,
    };
    const store = new MemoryStore();
    const notifyLocal = vi.fn();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => { throw new Error("Codex 新闻检索失败 (1)"); }) },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      notifyLocal,
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    expect(store.state.runs[0]?.failureNotice?.status).toBe("context_refresh_required");
    expect(store.state.runs[0]).toMatchObject({
      sendFailureReason: "context_stale",
      providerRet: -2,
    });
    expect(notifyLocal).toHaveBeenCalledWith(
      "Codex 微信日报未发送",
      expect.stringMatching(/刷新.*-2/u),
    );

    channel.sendResult = { ok: true, messageId: "notice-after-inbound" };
    const inbound = {
      key: "c".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "fresh-context",
      source: "text" as const,
      text: "普通消息",
      receivedAt: Date.parse("2026-08-12T04:01:00Z"),
      replyText: async () => ({ ok: true }),
    };
    await channel.inbound?.(inbound);
    await vi.waitFor(() => expect(store.state.runs[0]?.failureNotice?.status).toBe("accepted"));
    expect(channel.sent).toHaveLength(2);
    expect(store.state.runs[0]).not.toHaveProperty("sendFailureReason");
    expect(store.state.runs[0]).not.toHaveProperty("providerRet");

    await channel.inbound?.({ ...inbound, key: "d".repeat(64), messageId: "later-context" });
    await Promise.resolve();
    expect(channel.sent).toHaveLength(2);
  });

  it("restores a persisted rejected failure notice and retries it after inbound", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const now = Date.parse("2026-08-12T04:00:00Z");
    store.state.enabledTarget = {
      accountId: "bot-a", target: "user@im.wechat", enabledAt: now - 60_000,
    };
    store.state.runs = [{
      runKey: "2026-08-12",
      accountId: "bot-a",
      target: "user@im.wechat",
      status: "failed",
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      attempt: 1,
      failureStage: "research",
      failureCode: "research_timeout",
      nextRetryAt: now + 10 * 60_000,
      failureNotice: {
        status: "pending_inbound",
        updatedAt: now - 60_000,
        message: "安全失败通知",
      },
    }];
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => digest()) },
      now: () => now,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    expect(channel.sent).toHaveLength(0);
    await channel.inbound?.({
      key: "8".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "post-restart-context",
      source: "text",
      text: "普通消息",
      receivedAt: now,
      replyText: async () => ({ ok: true }),
    });

    await vi.waitFor(() => expect(store.state.runs[0]?.failureNotice?.status).toBe("accepted"));
    expect(channel.sent).toEqual([{
      accountId: "bot-a", target: "user@im.wechat", message: "安全失败通知",
    }]);
  });

  it("never retries a failure notice whose send result is unknown", async () => {
    const channel = new FakeChannel();
    channel.sendResult = { ok: false, reason: "unknown", error: "timeout" };
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => { throw new Error("Codex 新闻检索失败 (1)"); }) },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(store.state.runs[0]?.failureNotice?.status).toBe("unknown");
    channel.sendResult = { ok: true, messageId: "must-not-send" };
    await channel.inbound?.({
      key: "e".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "fresh-context",
      source: "text",
      text: "普通消息",
      receivedAt: Date.parse("2026-08-12T04:01:00Z"),
      replyText: async () => ({ ok: true }),
    });
    await Promise.resolve();

    expect(channel.sent).toHaveLength(1);
  });

  it("consumes the fixed Chinese command, retries immediately, and cancels the planned retry on success", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    let scheduled: (() => void) | undefined;
    const clearTimer = vi.fn();
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1)"))
        .mockResolvedValueOnce(digest()),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer: vi.fn((callback: () => void) => {
        scheduled = callback;
        return 1;
      }),
      clearTimer,
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    const replyText = vi.fn(async () => ({ ok: true, messageId: "retry-ack" }));
    now += 60_000;

    const consumed = await channel.command?.({
      key: "f".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "retry-now",
      source: "text",
      text: " 立即重试日报 ",
      receivedAt: now,
      replyText,
    });

    expect(consumed).toBe(true);
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));
    expect(replyText).toHaveBeenCalledWith(
      "已收到，正在立即重试日报。若仍失败，原定自动重试时间 2026-08-12 12:10:00 保持不变。",
    );
    expect(researcher.generate).toHaveBeenCalledTimes(2);
    expect(store.state.runs[0]).not.toHaveProperty("nextRetryAt");
    expect(scheduler.getPublicState().nextRunAt).toBe(Date.parse("2026-08-13T00:30:00Z"));
    expect(clearTimer).toHaveBeenCalled();
    scheduled?.();
    await Promise.resolve();
    expect(researcher.generate).toHaveBeenCalledTimes(2);
    expect(await channel.command?.({
      key: "0".repeat(64), accountId: "bot-a", target: "user@im.wechat", messageId: "slash",
      source: "text", text: "/retry-news", receivedAt: now, replyText,
    })).toBe(false);
  });

  it("retries the current failed daily run through local control and cancels the planned retry on success", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1)"))
        .mockResolvedValueOnce(digest()),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    now += 60_000;

    await scheduler.retryNow();

    expect(researcher.generate).toHaveBeenCalledTimes(2);
    expect(store.state.runs[0]).toMatchObject({ attempt: 2, status: "accepted" });
    expect(store.state.runs[0]).not.toHaveProperty("nextRetryAt");
    expect(scheduler.getPublicState().nextRunAt).toBe(Date.parse("2026-08-13T00:30:00Z"));
  });

  it("keeps the original retry deadline when an immediate retry fails", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let now = Date.parse("2026-08-12T04:00:00Z");
    let scheduled: (() => void) | undefined;
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1)"))
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (2)"))
        .mockResolvedValueOnce(digest()),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer: vi.fn((callback: () => void) => {
        scheduled = callback;
        return 1;
      }),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    const originalRetryAt = store.state.runs[0]!.nextRetryAt!;
    now += 60_000;

    expect(await channel.command?.({
      key: "1".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "retry-now-fails",
      source: "text",
      text: "立即重试日报",
      receivedAt: now,
      replyText: async () => ({ ok: true }),
    })).toBe(true);
    await vi.waitFor(() => expect(store.state.runs[0]).toMatchObject({ attempt: 2, status: "failed" }));

    expect(store.state.runs[0]).toMatchObject({
      status: "failed",
      nextRetryAt: originalRetryAt,
    });
    expect(scheduler.getPublicState().nextRunAt).toBe(originalRetryAt);

    now = originalRetryAt;
    scheduled?.();
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));
    expect(researcher.generate).toHaveBeenCalledTimes(3);
  });

  it("does not invent a retry deadline when a stored failure had no automatic retry", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const now = Date.parse("2026-08-12T04:00:00Z");
    store.state.enabledTarget = {
      accountId: "bot-a", target: "user@im.wechat", enabledAt: now - 60_000,
    };
    store.state.runs = [{
      runKey: "2026-08-12",
      accountId: "bot-a",
      target: "user@im.wechat",
      status: "failed",
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      attempt: 1,
      failureStage: "research",
      failureCode: "research_timeout",
    }];
    const researcher = {
      generate: vi.fn().mockRejectedValue(new Error("Codex 新闻检索失败")),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => now,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    expect(store.state.runs[0]).not.toHaveProperty("nextRetryAt");

    expect(await channel.command?.({
      key: "9".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "late-retry",
      source: "text",
      text: "立即重试日报",
      receivedAt: now,
      replyText: async () => ({ ok: true }),
    })).toBe(true);
    await vi.waitFor(() => expect(store.state.runs[0]?.attempt).toBe(2));

    expect(store.state.runs[0]).not.toHaveProperty("nextRetryAt");
    expect(scheduler.getPublicState().nextRunAt).toBe(Date.parse("2026-08-13T00:30:00Z"));
  });

  it("consumes a duplicate immediate-retry command without starting a second run", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1)"))
        .mockResolvedValueOnce(digest()),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    const firstReply = vi.fn(async () => {
      await ackGate;
      return { ok: true };
    });
    const secondReply = vi.fn(async () => ({ ok: true }));
    const base = {
      accountId: "bot-a",
      target: "user@im.wechat",
      source: "text" as const,
      text: "立即重试日报",
      receivedAt: Date.parse("2026-08-12T04:01:00Z"),
    };

    const firstCommand = channel.command?.({
      ...base, key: "2".repeat(64), messageId: "first-retry", replyText: firstReply,
    });
    expect(await channel.command?.({
      ...base, key: "3".repeat(64), messageId: "second-retry", replyText: secondReply,
    })).toBe(true);
    expect(secondReply).toHaveBeenCalledWith("日报任务正在运行，请稍后查看结果。");
    expect(researcher.generate).toHaveBeenCalledTimes(2);

    releaseAck();
    await expect(firstCommand).resolves.toBe(true);
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));
    expect(researcher.generate).toHaveBeenCalledTimes(2);
  });

  it("starts an immediate retry without waiting for its acknowledgement send", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const researcher = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Codex 新闻检索失败 (1)"))
        .mockResolvedValueOnce(digest()),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    const command = channel.command?.({
      key: "7".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "nonblocking-ack",
      source: "text",
      text: "立即重试日报",
      receivedAt: Date.parse("2026-08-12T04:01:00Z"),
      replyText: async () => {
        await ackGate;
        return { ok: true };
      },
    });

    await vi.waitFor(() => expect(researcher.generate).toHaveBeenCalledTimes(2));
    releaseAck();
    await expect(command).resolves.toBe(true);
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));
  });

  it("classifies an unavailable runtime resolver as a news process failure", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel, store,
      researcher: { generate: async () => { throw new Error("找不到本机 Codex 可执行文件"); } },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    expect(scheduler.getPublicState().lastRun?.failureCode).toBe("codex_process");
    expect(channel.sent[0]?.message).toContain("原因：新闻研究进程启动或执行失败");
    scheduler.close();
  });

  it("classifies a transient fetch failure without publishing its details", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => { throw new TypeError("fetch failed: ENOTFOUND private-host"); }) },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(scheduler.getPublicState().lastRun?.failureCode).toBe("network_unavailable");
    expect(JSON.stringify(scheduler.getPublicState())).not.toContain("private-host");
  });

  it("does not send a researched digest when the schedule was disabled before sending", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    let release!: (value: NewsDigest) => void;
    const gate = new Promise<NewsDigest>((resolve) => { release = resolve; });
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: () => gate },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    const enabling = scheduler.enable("bot-a", "user@im.wechat");
    await vi.waitFor(() => expect(scheduler.getPublicState().status).toBe("researching"));
    scheduler.disable();
    release(digest());
    await enabling;

    expect(channel.sent).toHaveLength(0);
    expect(store.state.runs[0]?.status).toBe("failed");
  });

  it("does not retry a generic rejected digest after a later inbound", async () => {
    const channel = new FakeChannel();
    channel.sendResult = { ok: false, reason: "rejected", error: "rejected" };
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    expect(store.state.runs[0]).toMatchObject({
      status: "rejected",
      sendFailureReason: "rejected",
    });

    channel.sendResult = { ok: true, messageId: "accepted-after-inbound" };
    await channel.inbound?.({
      key: "a".repeat(64),
      accountId: "bot-a",
      target: "other@im.wechat",
      messageId: "wrong-target",
      source: "text",
      text: "hi",
      receivedAt: Date.parse("2026-08-12T04:01:00Z"),
      replyText: async () => ({ ok: true }),
    });
    await Promise.resolve();
    expect(channel.sent).toHaveLength(1);

    await channel.inbound?.({
      key: "b".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "fresh-context",
      source: "text",
      text: "hi",
      receivedAt: Date.parse("2026-08-12T04:02:00Z"),
      replyText: async () => ({ ok: true }),
    });
    await Promise.resolve();
    expect(store.state.runs[0]?.status).toBe("rejected");
    expect(channel.sent).toHaveLength(1);

    await channel.inbound?.({
      key: "c".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "another-context",
      source: "text",
      text: "again",
      receivedAt: Date.parse("2026-08-12T04:03:00Z"),
      replyText: async () => ({ ok: true }),
    });
    await Promise.resolve();
    expect(channel.sent).toHaveLength(1);
  });

  it("retries a ret -2 digest once after matching inbound and clears stale failure fields", async () => {
    const channel = new FakeChannel();
    channel.sendResult = {
      ok: false,
      reason: "context_stale",
      error: "微信发送上下文已失效",
      providerRet: -2,
      providerErrcode: -2,
    };
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(store.state.runs[0]).toMatchObject({
      status: "context_refresh_required",
      error: "微信发送上下文已失效",
      sendFailureReason: "context_stale",
      providerRet: -2,
      providerErrcode: -2,
    });

    channel.sendResult = { ok: true, acceptedSegments: 1 };
    await channel.inbound?.({
      key: "e".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "fresh-context",
      source: "text",
      text: "刷新",
      receivedAt: Date.parse("2026-08-12T04:02:00Z"),
      replyText: async () => ({ ok: true }),
    });
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe("accepted"));

    expect(store.state.runs[0]).not.toHaveProperty("error");
    expect(store.state.runs[0]).not.toHaveProperty("sendFailureReason");
    expect(store.state.runs[0]).not.toHaveProperty("providerRet");
    expect(store.state.runs[0]).not.toHaveProperty("providerErrcode");
    expect(channel.sent).toHaveLength(2);
  });

  it("classifies stale bot credentials separately and waits until the account is usable", async () => {
    const channel = new FakeChannel();
    channel.sendResult = { ok: false, reason: "auth_stale", providerRet: -14 };
    const store = new MemoryStore();
    const notifyLocal = vi.fn();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      notifyLocal,
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(store.state.runs[0]).toMatchObject({
      status: "auth_relogin_required",
      sendFailureReason: "auth_stale",
      providerRet: -14,
    });
    expect(notifyLocal).toHaveBeenCalledWith(
      "Codex 微信日报未发送",
      expect.stringMatching(/重新绑定.*-14/u),
    );
    channel.snapshot.accounts[0]!.credentialStatus = "stale";
    await channel.inbound?.({
      key: "f".repeat(64), accountId: "bot-a", target: "user@im.wechat",
      messageId: "new-context", source: "text", text: "刷新", receivedAt: 1,
      replyText: async () => ({ ok: true }),
    });
    await Promise.resolve();
    expect(channel.sent).toHaveLength(1);
  });

  it("never retries an unknown send result after later inbound messages", async () => {
    const channel = new FakeChannel();
    channel.sendResult = { ok: false, reason: "unknown", error: "timeout" };
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");
    expect(store.state.runs[0]?.status).toBe("unknown");

    await channel.inbound?.({
      key: "d".repeat(64),
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "fresh-context",
      source: "text",
      text: "hi",
      receivedAt: Date.parse("2026-08-12T04:02:00Z"),
      replyText: async () => ({ ok: true }),
    });
    await Promise.resolve();

    expect(channel.sent).toHaveLength(1);
    expect(store.state.runs[0]?.status).toBe("unknown");
  });

  it("classifies a thrown send transport error as unknown instead of research failure", async () => {
    const channel = new FakeChannel();
    channel.sendError = new Error("socket closed after write");
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(store.state.runs[0]?.status).toBe("unknown");
    expect(scheduler.getPublicState().notice).toMatch(/结果未知/);
  });

  it("recovers an interrupted sending record as unknown without sending again", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    store.state = {
      ...store.state,
      enabledTarget: {
        accountId: "bot-a",
        target: "user@im.wechat",
        enabledAt: Date.parse("2026-08-11T00:00:00Z"),
      },
      runs: [{
        runKey: "2026-08-12",
        accountId: "bot-a",
        target: "user@im.wechat",
        status: "sending",
        createdAt: Date.parse("2026-08-12T00:31:00Z"),
        updatedAt: Date.parse("2026-08-12T00:31:10Z"),
        message: "maybe already sent",
        digest: digest(),
      }],
    };

    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: vi.fn(async () => digest()) },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    expect(store.state.runs[0]?.status).toBe("unknown");
    expect(channel.sent).toHaveLength(0);
    expect(scheduler.getPublicState().notice).toMatch(/结果未知/);
  });

  it("reruns today's research after a crash before sending began", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    store.state = {
      ...store.state,
      enabledTarget: {
        accountId: "bot-a",
        target: "user@im.wechat",
        enabledAt: Date.parse("2026-08-11T00:00:00Z"),
      },
      runs: [{
        runKey: "2026-08-12",
        accountId: "bot-a",
        target: "user@im.wechat",
        status: "researching",
        createdAt: Date.parse("2026-08-12T00:31:00Z"),
        updatedAt: Date.parse("2026-08-12T00:31:10Z"),
      }],
    };
    const researcher = { generate: vi.fn(async () => digest()) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    expect(researcher.generate).toHaveBeenCalledTimes(1);
    expect(store.state.runs[0]?.status).toBe("accepted");
  });

  it("previews without sending and sends only after an explicit preview-send call", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    await scheduler.preview();
    expect(channel.sent).toHaveLength(0);
    expect(scheduler.getPublicState().status).toBe("ready");
    expect(scheduler.getPublicState().previewMessage).toContain("OpenAI 发布新研究");
    expect(JSON.stringify(scheduler.getPublicState().preview)).not.toContain("https://");
    expect(store.state.preview?.items[0]?.url).toBe("https://openai.com/news/example");

    await scheduler.sendPreview("bot-a", "user@im.wechat");
    expect(channel.sent).toHaveLength(1);
    expect(scheduler.getPublicState().lastRun?.runKey).toMatch(/^manual-/);
    expect(scheduler.getPublicState().lastRun?.status).toBe("accepted");
  });

  it("records partial preview delivery without scheduling a whole-message resend", async () => {
    const channel = new FakeChannel();
    channel.sendResult = {
      ok: false,
      messageIds: ["accepted-1"],
      totalSegments: 2,
      acceptedSegments: 1,
      truncated: false,
      retriedSegments: 1,
      duplicatePossible: false,
      reason: "rejected",
      error: "第二段被拒绝",
    };
    const store = new MemoryStore();
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest() },
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();
    await scheduler.preview();

    await expect(scheduler.sendPreview("bot-a", "user@im.wechat")).rejects.toThrow(/1\/2/);

    expect(store.state.runs.at(-1)?.status).toBe("partial");
    expect(scheduler.getPublicState().notice).toMatch(/已接受 1\/2 段/);
  });

  it("reuses the same-day preview without generating its summaries again", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const researcher = { generate: vi.fn(async () => digest()) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    await scheduler.preview();
    await scheduler.preview();

    expect(researcher.generate).toHaveBeenCalledTimes(1);
    expect(store.state.summarizedArticleKeys).toHaveLength(1);
    expect(scheduler.getPublicState().notice).toContain("复用今天生成");
  });

  it("does not reuse a same-day legacy Top 10 preview after the Top 5 upgrade", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    store.state.preview = {
      ...digest(),
      hackerNewsTop: Array.from({ length: 10 }, (_, index) => ({
        rank: index + 1,
        title: `Legacy ${index + 1}`,
        source: "example.com",
        url: `https://example.com/legacy-${index + 1}`,
        submittedAt: "2026-08-12T00:00:00Z",
        score: 10 - index,
        comments: 0,
        status: index === 0 ? "summarized" as const : "not_selected" as const,
      })),
    };
    const researcher = { generate: vi.fn(async () => digest()) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    await scheduler.preview();

    expect(researcher.generate).toHaveBeenCalledOnce();
  });

  it("reuses a valid same-day partial HN selection", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    store.state.preview = {
      date: "2026-08-12",
      generatedAt: Date.parse("2026-08-12T00:00:00Z"),
      items: [{
        section: "hackernews",
        title: "仅成功的一篇",
        summary: "完整摘要内容。",
        source: "Hacker News",
        url: "https://example.com/hn-6",
        publishedAt: "2026-08-12T00:00:00Z",
      }],
      hackerNewsTop: [{
        rank: 6,
        title: "仅成功的一篇",
        source: "example.com",
        url: "https://example.com/hn-6",
        submittedAt: "2026-08-12T00:00:00Z",
        score: 10,
        comments: 2,
        status: "summarized",
      }],
    };
    const researcher = { generate: vi.fn(async () => digest()) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      now: () => Date.parse("2026-08-12T01:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await scheduler.start();

    await scheduler.preview();

    expect(researcher.generate).not.toHaveBeenCalled();
    expect(scheduler.getPublicState().notice).toContain("复用今天生成");
  });

  it("retries a failed same-day archive from the cached summary without researching again", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const researcher = { generate: vi.fn(async () => digest()) };
    const archive = {
      archive: vi.fn()
        .mockRejectedValueOnce(new Error("Vault unavailable"))
        .mockResolvedValueOnce({ summaryPath: "news/2026-08-12/摘要.md" }),
    };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      researcher,
      archive,
      now: () => Date.parse("2026-08-12T00:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await expect(scheduler.preview()).rejects.toThrow(/生成失败/);
    await scheduler.preview();

    expect(researcher.generate).toHaveBeenCalledTimes(1);
    expect(archive.archive).toHaveBeenCalledTimes(2);
    expect(store.state.summarizedArticleKeys).toHaveLength(1);
  });

  it("does not repeat an already delivered item in a later automatic digest", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const first = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: { generate: async () => digest("2026-08-11") },
      now: () => Date.parse("2026-08-11T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await first.start();
    await first.enable("bot-a", "user@im.wechat");
    first.close();

    const secondResearcher = {
      generate: vi.fn(async (window: NewsResearchWindow) => {
        void window;
        return digest("2026-08-12");
      }),
    };
    const second = new DailyAiNewsScheduler({
      channel,
      store,
      researcher: secondResearcher,
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });
    await second.start();

    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]?.message).toContain("今日暂无值得汇总的重大更新");
    expect(store.state.runs.at(-1)?.digest?.items).toEqual([]);
    expect(secondResearcher.generate.mock.calls[0]?.[0].excludedArticleKeys).toEqual(
      store.state.summarizedArticleKeys,
    );
  });

  it("removes the matching HN audit entry when delivery history filters an article", async () => {
    const channel = new FakeChannel();
    const store = new MemoryStore();
    const priorUrl = "https://example.com/hn-prior";
    const freshUrl = "https://example.com/hn-fresh";
    store.state.seenItemKeys = [articleKey(priorUrl)];
    const generated: NewsDigest = {
      date: "2026-08-12",
      generatedAt: Date.parse("2026-08-12T04:00:00Z"),
      items: [priorUrl, freshUrl].map((url, index) => ({
        section: "hackernews" as const,
        title: index === 0 ? "已发送的 HN" : "新 HN",
        summary: "完整摘要内容。",
        source: "Hacker News",
        url,
        publishedAt: "2026-08-12T00:00:00Z",
      })),
      hackerNewsTop: [priorUrl, freshUrl].map((url, index) => ({
        rank: index + 1,
        title: index === 0 ? "已发送的 HN" : "新 HN",
        source: "example.com",
        url,
        submittedAt: "2026-08-12T00:00:00Z",
        score: 10 - index,
        comments: 2,
        status: "summarized" as const,
      })),
    };
    const archive = { archive: vi.fn(async (value: NewsDigest) => ({
      digest: value,
      summaryPath: "news/2026-08-12/摘要.md",
      archived: [],
      skipped: [],
    })) };
    const scheduler = new DailyAiNewsScheduler({
      channel,
      store,
      archive,
      researcher: { generate: async () => generated },
      now: () => Date.parse("2026-08-12T04:00:00Z"),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
    });

    await scheduler.start();
    await scheduler.enable("bot-a", "user@im.wechat");

    expect(archive.archive).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ url: freshUrl })],
      hackerNewsTop: [expect.objectContaining({ url: freshUrl, rank: 2 })],
    }));
    expect(channel.sent[0]?.message).toContain("新 HN");
    expect(channel.sent[0]?.message).not.toContain("已发送的 HN");
  });
});
