import { DailyNewsPersistenceError, type NewsArticleProcessor } from "./news-article-store.js";
export { DailyNewsPersistenceError } from "./news-article-store.js";
import { classifyResearchFailure, formatNewsDigest, removeSeenItems,
  type NewsResearchWindow, type AiNewsResearcher, type DailyAiNewsState, type DailyAiNewsFailureCode, type NewsDigest, type NewsDigestArchive, type PublicDailyAiNewsState,
} from "./daily-ai-news-scheduler.js";

export class DailyNewsExecutionError extends Error {
  constructor(readonly stage: "research" | "archive" | "configuration", readonly code: DailyAiNewsFailureCode) { super(code); }
}

export async function generateDailyNews(input: {
  researcher: AiNewsResearcher; archive?: NewsDigestArchive; state: DailyAiNewsState & { previewInstruction?: string };
  articles?: NewsArticleProcessor;
  observe?: NewsResearchWindow["observe"];
  instruction: string; signal?: AbortSignal; deferArchive?: boolean;
  date: string; now: number; previewOnly?: boolean; cachedDigest?: NewsDigest;
  saveDigest(generated: NewsDigest, selected: NewsDigest): void;
}): Promise<{ body: string; digest: NewsDigest; archive?: PublicDailyAiNewsState["archive"] }> {
  let digest: NewsDigest;
  try {
    if (input.signal?.aborted) throw new Error("research_cancelled");
    if (input.cachedDigest) digest = input.cachedDigest;
    else {
      const generated = await input.researcher.generate({ date: input.date, windowStart: input.now - 86_400_000,
          windowEnd: input.now, ...(input.observe ? { observe: input.observe } : {}), ...(input.articles ? { articles: input.articles } : {}), instruction: input.instruction, ...(input.signal ? { signal: input.signal } : {}), excludedArticleKeys: input.state.summarizedArticleKeys });
      if (input.signal?.aborted) throw new Error("research_cancelled");
      digest = input.previewOnly ? generated : removeSeenItems(generated, new Set(input.state.seenItemKeys));
      formatNewsDigest(digest);
      input.saveDigest(generated, digest);
    }
  } catch (error) {
    // Persistence errors must stop advancement, not masquerade as research failures.
    if (error instanceof DailyNewsPersistenceError) throw error;
    throw new DailyNewsExecutionError("research", input.signal?.aborted ? "target_changed" : classifyResearchFailure(error));
  }
  if (input.deferArchive) return { body: formatNewsDigest(digest), digest };
  try {
    const result = await input.archive?.archive(digest);
    if (result && typeof result === "object" && "digest" in result && result.digest && typeof result.digest === "object") digest = result.digest as NewsDigest;
    if (input.signal?.aborted) throw new DailyNewsExecutionError("research", "target_changed");
    const metadata = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
    const archive = metadata && typeof metadata.summaryPath === "string" && Array.isArray(metadata.archived) && Array.isArray(metadata.skipped)
      ? { summaryPath: metadata.summaryPath, hackerNewsTopPath: typeof metadata.hackerNewsTopPath === "string" ? metadata.hackerNewsTopPath : null,
          archivedCount: metadata.archived.length, skippedCount: metadata.skipped.length, totalCount: digest.items.length } : undefined;
    return { body: formatNewsDigest(digest), digest, ...(archive ? { archive } : {}) };
  } catch (error) { if (error instanceof DailyNewsExecutionError) throw error; throw new DailyNewsExecutionError("archive", "archive_unavailable"); }
}
