import { retryNewsRead, NewsHttpError } from "./news-read-retry.js";
import dns from "node:dns";
import net from "node:net";

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { chromium } from "playwright";
import TurndownService from "turndown";

import {
  type HackerNewsTopItem,
  type NewsDigest,
  type NewsDigestArchive,
  type NewsItem,
  type NewsResearchWindow,
} from "./daily-ai-news-scheduler.js";
import type { DirectMarkdownVault, VaultNote } from "./direct-markdown-vault.js";
import { articleKey } from "./news-article-identity.js";

const MAX_ARTICLE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_ARTICLE_TEXT_LENGTH = 40;
const MAX_REDIRECTS = 5;
const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
const BROWSER_RENDER_TIMEOUT_MS = 7_000;

export type ArticleBody = { title: string; markdown: string };
export type ArticleBodyLoader = (url: string, signal?: AbortSignal, observe?: NewsResearchWindow["observe"]) => Promise<ArticleBody>;
export type RenderedHtml = { html: string; finalUrl: string };
export type RenderedHtmlLoader = (url: string, signal?: AbortSignal) => Promise<RenderedHtml>;

export type ArchivedNewsItem = { title: string; path: string };
export type NewsArchiveResult = {
  digest: NewsDigest;
  summaryPath: string;
  hackerNewsTopPath?: string;
  archived: ArchivedNewsItem[];
  skipped: Array<{ title: string; reason: "正文无法取得" }>;
};

const HN_STATUS_LABELS: Record<HackerNewsTopItem["status"], string> = {
  summarized: "已进入日报深读摘要",
  historical_duplicate: "历史已摘要，本次去重",
  unreadable_or_unverified: "已尝试深读，但正文不可读取或无法核验",
  not_selected: "旧版记录：未进入深读名额",
};

export type NewsArchiveMatch = { path: string; title: string; source: string };

function cleanLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function articlePath(date: string, item: NewsItem): string {
  const slug = item.title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#[\]^]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "article";
  const hash = articleKey(item.url).slice(0, 8);
  return `news/${date}/${slug}-${hash}.md`;
}

function articleMarkdown(item: NewsItem, body: ArticleBody, fetchedAt: number): string {
  return [
    `# ${cleanLine(item.title)}`,
    "",
    `来源：${cleanLine(item.source)}`,
    `发布日期：${cleanLine(item.publishedAt)}`,
    `原始地址：${item.url}`,
    `抓取时间：${new Date(fetchedAt).toISOString()}`,
    ...(cleanLine(body.title) && cleanLine(body.title) !== cleanLine(item.title)
      ? [`原文标题：${cleanLine(body.title)}`]
      : []),
    "",
    "## 正文",
    "",
    body.markdown.trim(),
    "",
  ].join("\n");
}

function summaryMarkdown(
  digest: NewsDigest,
  archivedByUrl: Map<string, string>,
): string {
  const lines = [
    `# ${digest.date} AI 新闻摘要`,
    "",
    `生成时间：${new Date(digest.generatedAt).toISOString()}`,
    "",
  ];
  digest.items.forEach((item, index) => {
    const path = archivedByUrl.get(item.url);
    lines.push(
      `## ${index + 1}. ${cleanLine(item.title)}`,
      "",
      item.summary.trim(),
      "",
      `来源：${cleanLine(item.source)}`,
      `发布日期：${cleanLine(item.publishedAt)}`,
      path ? `正文：[[${path.replace(/\.md$/, "")}]]` : "正文：正文未归档",
      "",
    );
  });
  return lines.join("\n");
}

function hackerNewsTopMarkdown(
  digest: NewsDigest,
  archivedByUrl: Map<string, string>,
  modernSelection: boolean,
): string {
  const items = digest.hackerNewsTop ?? [];
  const summariesByUrl = new Map(
    digest.items
      .filter((item) => item.section === "hackernews")
      .map((item) => [articleKey(item.url), item] as const),
  );
  return [
    modernSelection
      ? `# ${digest.date} Hacker News 热门 ${items.length} 篇`
      : `# ${digest.date} Hacker News Top 10`,
    "",
    `抓取时间：${new Date(digest.hackerNewsTopCapturedAt ?? digest.generatedAt).toISOString()}`,
    "",
    modernSelection
      ? "这是 Hacker News 官方 topstories 前 10 名中成功深读的文章，保留原始排名。"
      : "这是旧版 Hacker News 官方 topstories 候选审计快照。",
    "",
    ...items.flatMap((item) => {
      const summary = summariesByUrl.get(articleKey(item.url));
      const bodyPath = summary ? archivedByUrl.get(summary.url) : undefined;
      return [
        `## ${item.rank}. ${cleanLine(item.title)}`,
        "",
        ...(summary ? [summary.summary.trim(), ""] : []),
        `来源：${cleanLine(item.source)}`,
        `分数：${item.score} · 评论：${item.comments}`,
        `提交时间：${cleanLine(item.submittedAt)}`,
        `处理状态：${HN_STATUS_LABELS[item.status]}`,
        bodyPath ? `正文：[[${bodyPath.replace(/\.md$/, "")}]]` : "正文：正文未归档",
        `原始地址：${item.url}`,
        "",
      ];
    }),
  ].join("\n");
}

function parseMatch(note: VaultNote): NewsArchiveMatch {
  const title = note.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? note.path.split("/").at(-1) ?? note.path;
  const source = note.content.match(/^来源：(.+)$/m)?.[1]?.trim() ?? "未知来源";
  return { path: note.path, title, source };
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

export class NewsArchive {
  constructor(
    private readonly vault: DirectMarkdownVault,
    private readonly loadBody: ArticleBodyLoader = (url, signal) => fetchReadableArticle(url, undefined, signal),
    private readonly now: () => number = Date.now,
  ) {}

  async archive(digest: NewsDigest, context?: Parameters<NewsDigestArchive["archive"]>[1]): Promise<NewsArchiveResult> {
    const check = () => { context?.signal.throwIfAborted(); if (context && !context.active()) throw new Error("archive_owner_changed"); };
    const prefix = context ? `${String(digest.generatedAt).padStart(16, "0")}-${articleKey(`https://archive.invalid/${encodeURIComponent(context.snapshotId)}`).slice(0, 20)}/` : "";
    const archivePath = (relative: string) => relative.replace(`news/${digest.date}/`, `news/${digest.date}/${prefix}`);
    check();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(digest.date)) throw new Error("新闻归档日期无效");
    const hackerNewsItems = digest.items.filter((item) => item.section === "hackernews");
    const hackerNewsTop = digest.hackerNewsTop;
    const modernHackerNewsSelection = hackerNewsTop !== undefined &&
      hackerNewsTop.length <= (digest.selection?.hackerNewsCount ?? 5) &&
      hackerNewsTop.every((item) => item.status === "summarized");
    if (modernHackerNewsSelection && hackerNewsTop) {
      const itemKeys = new Set(hackerNewsItems.map((item) => articleKey(item.url)));
      const auditKeys = new Set(hackerNewsTop.map((item) => articleKey(item.url)));
      if (itemKeys.size !== hackerNewsItems.length || auditKeys.size !== hackerNewsTop.length ||
        itemKeys.size !== auditKeys.size || [...itemKeys].some((key) => !auditKeys.has(key))
      ) throw new Error("Hacker News 摘要与榜单不一致");
    }
    const archived: ArchivedNewsItem[] = [];
    const skipped: NewsArchiveResult["skipped"] = [];
    const archivedByUrl = new Map<string, string>();

    for (const item of digest.items) {
      check();
      const path = archivePath(articlePath(digest.date, item));
      const existing = await this.vault.read(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
        throw error;
      });
      if (context && existing) {
        const body = await context.loadBody(item.url, context.signal);
        const expected = articleMarkdown(item, body, digest.generatedAt);
        if (existing.content !== expected) { check(); await this.vault.update(path, expected, existing.sha256); }
      }
      if (!existing) {
        let body: ArticleBody;
        try {
          const loaded = await (context?.loadBody ?? this.loadBody)(item.url, context?.signal);
          if (loaded.markdown.trim().length < MIN_ARTICLE_TEXT_LENGTH) {
            throw new Error("正文过短");
          }
          body = loaded;
        } catch {
          skipped.push({ title: item.title, reason: "正文无法取得" });
          continue;
        }
        try {
          check();
          await this.vault.create(path, articleMarkdown(item, body, context ? digest.generatedAt : this.now()));
        } catch (error) {
          if (error instanceof Error && error.message === "Markdown 内容过大") {
            skipped.push({ title: item.title, reason: "正文无法取得" });
            continue;
          }
          if (!isAlreadyExists(error)) throw error;
        }
      }
      archived.push({ title: item.title, path });
      archivedByUrl.set(item.url, path);
    }

    const finalDigest = digest;

    let hackerNewsTopPath: string | undefined;
    if (finalDigest.hackerNewsTop && finalDigest.hackerNewsTop.length > 0) {
      hackerNewsTopPath = modernHackerNewsSelection
        ? `news/${digest.date}/Hacker News 热门 ${finalDigest.hackerNewsTop.length} 篇.md`
        : `news/${digest.date}/Hacker News Top 10.md`;
      hackerNewsTopPath = archivePath(hackerNewsTopPath);
      const content = hackerNewsTopMarkdown(finalDigest, archivedByUrl, modernHackerNewsSelection);
      const existing = await this.vault.read(hackerNewsTopPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
        throw error;
      });
      check();
      if (existing) {
        await this.vault.update(hackerNewsTopPath, content, existing.sha256);
      } else {
        await this.vault.create(hackerNewsTopPath, content);
      }
    }

    const summaryPath = archivePath(`news/${digest.date}/摘要.md`);
    const content = summaryMarkdown(finalDigest, archivedByUrl);
    const existingSummary = await this.vault.read(summaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      throw error;
    });
    check();
    if (existingSummary) {
      await this.vault.update(summaryPath, content, existingSummary.sha256);
    } else {
      await this.vault.create(summaryPath, content);
    }
    return {
      digest: finalDigest,
      summaryPath,
      ...(hackerNewsTopPath ? { hackerNewsTopPath } : {}),
      archived,
      skipped,
    };
  }

  async search(query: string): Promise<NewsArchiveMatch[]> {
    const paths = await this.vault.searchWithin("news", query, query.trim() === "摘要").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(paths.map(async (path) => parseMatch(await this.vault.read(path))));
  }

  async read(path: string): Promise<VaultNote> {
    if (!path.startsWith("news/") || path.includes("\\")) {
      throw new Error("只能读取 news/ 新闻归档");
    }
    return this.vault.read(path);
  }
}

export function extractReadableMarkdown(html: string, url: string): ArticleBody {
  const { document } = parseHTML(html);
  const base = document.createElement("base");
  base.setAttribute("href", new URL(url).toString());
  document.head?.prepend(base);
  const article = new Readability(document as unknown as Document, { charThreshold: 20 }).parse();
  if (!article?.content || !article.title) throw new Error("页面没有可读取正文");
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  turndown.remove(["script", "style", "nav", "form", "button", "noscript"]);
  const markdown = turndown
    .turndown(article.content)
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (markdown.replace(/\s/g, "").length < MIN_ARTICLE_TEXT_LENGTH) {
    throw new Error("页面正文过短");
  }
  return { title: article.title.trim(), markdown };
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) || a! >= 224;
  }
  const normalized = address.toLowerCase().split("%")[0]!;
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.");
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("正文地址协议无效");
  if (url.username || url.password || url.hostname === "localhost") throw new Error("正文地址不可访问");
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.promises.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("正文地址不可访问");
  }
}

function isReadableExtractionFailure(error: unknown): boolean {
  return error instanceof Error &&
    (error.message === "页面没有可读取正文" || error.message === "页面正文过短");
}

export async function renderArticleHtml(input: string, signal?: AbortSignal): Promise<RenderedHtml> {
  const initialUrl = new URL(input);
  await assertPublicUrl(initialUrl);
  signal?.throwIfAborted();
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 15_000 });
  const abort = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const validatedHosts = new Map<string, Promise<void>>();
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "GET" || ["font", "image", "media"].includes(request.resourceType())) {
        await route.abort();
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        await route.abort();
        return;
      }
      const hostKey = `${url.protocol}//${url.host}`;
      const validation = validatedHosts.get(hostKey) ?? assertPublicUrl(url);
      validatedHosts.set(hostKey, validation);
      try {
        await validation;
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.on("popup", (popup) => void popup.close());
    await page.goto(initialUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForFunction(
      (minimum) => (document.body?.innerText ?? "").replace(/\s/g, "").length >= minimum,
      MIN_ARTICLE_TEXT_LENGTH,
      { timeout: BROWSER_RENDER_TIMEOUT_MS },
    );
    const finalUrl = new URL(page.url());
    await assertPublicUrl(finalUrl);
    const html = await page.content();
    if (Buffer.byteLength(html, "utf8") > MAX_ARTICLE_RESPONSE_BYTES) {
      throw new Error("正文响应过大");
    }
    return { html, finalUrl: finalUrl.toString() };
  } finally {
    signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => {});
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARTICLE_RESPONSE_BYTES) throw new Error("正文响应过大");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ARTICLE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("正文响应过大");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function fetchReadableArticle(
  input: string,
  loadRenderedHtml: RenderedHtmlLoader = renderArticleHtml,
  signal?: AbortSignal,
  observe?: NewsResearchWindow["observe"],
): Promise<ArticleBody> {
  dns.setDefaultResultOrder("ipv4first");
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    signal?.throwIfAborted();
    await assertPublicUrl(current);
    signal?.throwIfAborted();
    const loaded = await retryNewsRead(async () => {
      const response = await fetch(current, {
        redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) throw new Error("正文重定向无效");
        return { location };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new NewsHttpError(response.status, response.headers.get("retry-after"), "正文请求失败");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        await response.body?.cancel(); throw new Error("正文不是 HTML");
      }
      return { html: await readBoundedBody(response) };
    }, signal, observe);
    if (loaded.location) { current = new URL(loaded.location, current); continue; }
    const html = loaded.html!;
    signal?.throwIfAborted();
    try {
      return extractReadableMarkdown(html, current.toString());
    } catch (error) {
      if (!isReadableExtractionFailure(error)) throw error;
      const rendered = await loadRenderedHtml(current.toString(), signal);
      return extractReadableMarkdown(rendered.html, rendered.finalUrl);
    }
  }
  throw new Error("正文重定向过多");
}
