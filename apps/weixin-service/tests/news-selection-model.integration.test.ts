import { expect, it } from "vitest";
import { CodexCliNewsResearcher, CodexHackerNewsResearcher, CombinedNewsResearcher, createCodexCliNewsRun } from "../src/codex-news-researcher.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";

// Opt-in sends only these synthetic research instructions to the configured model; no real account or news content.
it.skipIf(process.env.NEWS_SELECTION_MODEL_TEST !== "live")("interprets saved source counts without changing task state", async () => {
  const plan = createCodexCliNewsRun({ executable: () => resolveCodexExecutable(process.env) });
  const noItems = async () => JSON.stringify({ items: [] });
  const researcher = new CombinedNewsResearcher(new CodexCliNewsResearcher(noItems), new CodexHackerNewsResearcher(noItems, async () => []), Date.now, 360_000, plan);
  const window = { date: "2026-10-17", windowStart: Date.parse("2026-10-16T12:00:00Z"), windowEnd: Date.parse("2026-10-17T12:00:00Z") };
  for (const [instruction, selection] of [
    ["仅检索过去24小时 Hacker News 热门技术，按热度选取 Top 7；不再单独检索或发送 AI 新闻栏目。", { generalCount: 0, hackerNewsCount: 7 }],
    ["每天选取三条 AI 新闻和两条 Hacker News 热榜文章。", { generalCount: 3, hackerNewsCount: 2 }],
    ["检索过去24小时 AI 新闻，以及 Hacker News 全站热榜中的热门技术，不限主题。", { generalCount: 5, hackerNewsCount: 5 }],
  ] as const) expect((await researcher.generate({ ...window, instruction })).selection).toEqual(selection);
  await expect(researcher.generate({ ...window, instruction: "只要 Hacker News Top 11，必须十一条，不得少于十一条。" })).rejects.toThrow("news_selection_invalid");
}, 180000);
