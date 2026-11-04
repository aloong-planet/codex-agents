import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NewsItem, NewsResearchWindow } from "./daily-ai-news-scheduler.js";
import type { ArticleBody } from "./news-archive.js";
import { articleKey } from "./news-article-identity.js";
import { parseNewsBrief } from "./news-summary.js";

export class DailyNewsPersistenceError extends Error {}
export class NewsArticleContentError extends Error {}
export type NewsContentAssessment = { version: 1; status: "matched" | "mismatched" | "insufficient"; evidence: string; candidateTitle: string };
export type AssessedNewsArticle = { item: NewsItem; contentAssessment: NewsContentAssessment };
export type NewsArticleProcessor = {
  process(url: string, previouslyProcessed: boolean, load: () => Promise<ArticleBody>, summarize: (body: ArticleBody) => Promise<NewsItem | AssessedNewsArticle>, processingSignal?: AbortSignal, verifyCached?: (body: ArticleBody, item: NewsItem) => Promise<NewsContentAssessment>): Promise<NewsItem | undefined>;
};
type ArticleRecord = { status: "running" | "failed" | "unknown" | "succeeded"; token: string; body?: ArticleBody; bodyRejected?: boolean; item?: NewsItem; contentAssessment?: NewsContentAssessment; verification?: "running" | "unavailable" };
type Row = { json: string; sha256: string; bytes: number };
const MAX_RECORD_BYTES = 2 * 1024 * 1024 + 32_768;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const checksum = (json: string) => crypto.createHash("sha256").update(json).digest("hex");

/** Uses the scheduled owner's database and fencing; no independent lease or timer. */
export class NewsArticleStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS scheduled_news_article (
      scope TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(scope, key));`);
  }

  private read(scope: string, key: string): ArticleRecord | undefined {
    const row = this.database.prepare("SELECT json, sha256 FROM scheduled_news_article WHERE scope = ? AND key = ?").get(scope, key) as Row | undefined;
    if (!row) return;
    if (checksum(row.json) !== row.sha256) throw new Error("article_cache_unavailable");
    let record: ArticleRecord;
    try { record = JSON.parse(row.json) as ArticleRecord; } catch { throw new Error("article_cache_unavailable"); }
    if (!record || !["running", "failed", "unknown", "succeeded"].includes(record.status) || typeof record.token !== "string") throw new Error("article_cache_unavailable");
    if (record.body && (typeof record.body.title !== "string" || typeof record.body.markdown !== "string")) throw new Error("article_cache_unavailable");
    if (record.contentAssessment && (record.contentAssessment.version !== 1 || !["matched", "mismatched", "insufficient"].includes(record.contentAssessment.status) || typeof record.contentAssessment.evidence !== "string" || typeof record.contentAssessment.candidateTitle !== "string")) throw new Error("article_cache_unavailable");
    if (record.verification !== undefined && !["running", "unavailable"].includes(record.verification)) throw new Error("article_cache_unavailable");
    if (record.status === "succeeded") {
      if (!record.body?.markdown.trim() || !record.item?.summary.trim() || articleKey(record.item.url) !== key) throw new Error("article_cache_unavailable");
      try { parseNewsBrief(record.item.brief); } catch { throw new Error("article_cache_unavailable"); }
    }
    return record;
  }

  body(scope: string, url: string): ArticleBody {
    const record = this.read(scope, articleKey(url));
    if (record?.status !== "succeeded" || !record.body) throw new Error("article_cache_unavailable");
    return record.body;
  }

  processor(scope: string, active: () => boolean, signal?: AbortSignal, observe?: NewsResearchWindow["observe"]): NewsArticleProcessor {
    return { process: async (url, previouslyProcessed, load, summarize, processingSignal, verifyCached) => {
      const operationSignal = processingSignal && signal ? AbortSignal.any([processingSignal, signal]) : processingSignal ?? signal;
      const key = articleKey(url), token = crypto.randomUUID();
      const record = this.transaction(() => {
        if (!active() || operationSignal?.aborted) throw new DailyNewsPersistenceError("worker_fenced");
        const current = this.read(scope, key);
        if (current?.status === "succeeded") {
          if (!verifyCached || current.contentAssessment || current.verification) return current;
          // Claim the single legacy validation before making an external call. Never rewrite its body/item.
          const claimed: ArticleRecord = { ...current, token, verification: "running" };
          this.reserve(scope, key, true);
          this.save(scope, key, claimed, MAX_RECORD_BYTES);
          return claimed;
        }
        if (current?.status === "running" || current?.status === "unknown" || (!current && previouslyProcessed)) throw new Error("article_cache_unavailable");
        this.reserve(scope, key, !!current);
        const claimed: ArticleRecord = { status: "running", token, ...(current?.body && !current.bodyRejected ? { body: current.body } : {}) };
        this.save(scope, key, claimed, MAX_RECORD_BYTES); return claimed;
      });
      if (!record) return;
      const save = (next: ArticleRecord, reserved: boolean) => this.transaction(() => {
        if (!active() || operationSignal?.aborted || this.read(scope, key)?.token !== token) throw new DailyNewsPersistenceError("worker_fenced");
        this.save(scope, key, next, reserved ? MAX_RECORD_BYTES : undefined);
      });
      if (record.status === "succeeded") {
        if (verifyCached && !record.contentAssessment && record.verification === "running" && record.token === token) {
          observe?.("article.verification_started", { articleRef: key });
          try {
            const contentAssessment = await verifyCached(record.body!, record.item!);
            const settled = { ...record, contentAssessment };
            delete settled.verification;
            save(settled, false);
            record.contentAssessment = contentAssessment;
            observe?.("article.verification_settled", { articleRef: key, status: contentAssessment.status });
          } catch (error) {
            // Keep an interruption or external failure non-retryable without destroying the historic success.
            if (active()) this.transaction(() => {
              if (active() && this.read(scope, key)?.token === token) this.save(scope, key, { ...record, verification: "unavailable" });
            });
            if (error instanceof DailyNewsPersistenceError) throw error;
            throw new NewsArticleContentError("article_content_unverified");
          }
        }
        if (verifyCached) {
          if (record.contentAssessment?.status === "mismatched") throw new NewsArticleContentError("article_content_mismatch");
          if (record.contentAssessment?.status !== "matched") throw new NewsArticleContentError("article_content_unverified");
        }
        observe?.("article.reused", { articleRef: key, status: "succeeded" });
        return record.item;
      }
      observe?.("article.claimed", { articleRef: key, status: "running" });
      try {
        record.body ??= await load();
        if (!record.body.markdown.trim()) throw new Error("article_body_invalid");
        save(record, true);
        observe?.("article.body_saved", { articleRef: key, status: "saved" });
        const result = await summarize(record.body);
        const item = "item" in result ? result.item : result;
        const contentAssessment = "contentAssessment" in result ? result.contentAssessment : undefined;
        if (!item.summary.trim() || articleKey(item.url) !== key) throw new Error("article_summary_invalid");
        parseNewsBrief(item.brief);
        save({ ...record, item, ...(contentAssessment ? { contentAssessment } : {}), status: "succeeded" }, false);
        observe?.("article.persisted", { articleRef: key, status: "succeeded" });
        return item;
      } catch (error) {
        // Interrupted claims remain non-retryable. A later owner cannot assume the model did no work.
        if (active() && operationSignal?.aborted) this.transaction(() => {
          if (active() && this.read(scope, key)?.token === token) this.save(scope, key, { ...record, status: "unknown" });
        });
        else if (!(error instanceof DailyNewsPersistenceError) && active()) save({ ...record, status: "failed", ...(error instanceof NewsArticleContentError ? { bodyRejected: true } : {}) }, false);
        throw error;
      }
    } };
  }

  private reserve(scope: string, key: string, exists: boolean): void {
    const usage = this.database.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM scheduled_news_article").get()!;
    const old = this.database.prepare("SELECT bytes FROM scheduled_news_article WHERE scope = ? AND key = ?").get(scope, key);
    if (Number(usage.bytes) - Number(old?.bytes ?? 0) + MAX_RECORD_BYTES > MAX_STORE_BYTES || (!exists && Number(usage.count) >= 100_000)) throw new DailyNewsPersistenceError("article_capacity");
  }

  private save(scope: string, key: string, record: ArticleRecord, reservation?: number): void {
    const json = JSON.stringify(record), bytes = Buffer.byteLength(json, "utf8");
    if (bytes > MAX_RECORD_BYTES) throw new DailyNewsPersistenceError("article_too_large");
    this.database.prepare("INSERT INTO scheduled_news_article VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET json = excluded.json, sha256 = excluded.sha256, bytes = excluded.bytes")
      .run(scope, key, json, checksum(json), reservation ?? bytes);
  }

  private transaction<T>(action: () => T): T {
    let begun = false;
    try { this.database.exec("BEGIN IMMEDIATE"); begun = true; const result = action(); this.database.exec("COMMIT"); return result; }
    catch (error) {
      if (begun) this.database.exec("ROLLBACK");
      if (error instanceof DailyNewsPersistenceError || (error instanceof Error && error.message === "article_cache_unavailable")) throw error;
      throw new DailyNewsPersistenceError(error instanceof Error ? error.message : "article_store_failed");
    }
  }
}
