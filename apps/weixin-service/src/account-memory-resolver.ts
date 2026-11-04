import type { AccountMemoryEntry } from "./account-memory-store.js";

export type MemorySearchCandidate = {
  id: string;
  rank: number;
  score: number;
  source: "lexical" | "semantic";
};

export type MemoryTargetResolution =
  | { status: "resolved"; targetId: string; replacement: string; basis: "strong_lexical" | "exact_alias" }
  | { status: "needs_clarification"; reason: "target_missing" | "target_ambiguous"; candidateIds: string[] };

const CORRECTION_PREFIX = /^(?:请)?(?:帮我)?(?:把)?(?:这条记忆)?(?:更正|纠正|修改|更新|改成|改为)(?:为|成|：|:|，|,|\s)*/u;
const ACTION_WORDS = /(?:请|帮我|把|这条|记忆|更正|纠正|修改|更新|改成|改为|以后|只在|使用|统一|项目|工程)/gu;

export function resolveMemoryTarget(
  text: string,
  entries: AccountMemoryEntry[],
  rankedCandidates: MemorySearchCandidate[],
): MemoryTargetResolution {
  const replacement = extractReplacement(text);
  const anchors = extractStrongAnchors(replacement);
  const matches = entries
    .filter((entry) => anchors.some((anchor) => normalizedTechnicalTokens(entry.value).has(anchor)))
    .map((entry) => entry.id)
    .sort(compareIds);
  if (matches.length === 1) {
    return { status: "resolved", targetId: matches[0]!, replacement, basis: "strong_lexical" };
  }
  if (matches.length > 1) {
    return { status: "needs_clarification", reason: "target_ambiguous", candidateIds: matches };
  }
  const candidates = [...new Set(rankedCandidates.map((candidate) => candidate.id))].slice(0, 5);
  return { status: "needs_clarification", reason: "target_missing", candidateIds: candidates };
}

export function rankExactCosine(
  query: Float32Array,
  vectors: Float32Array,
  ids: string[],
  dimensions: number,
  limit: number,
): MemorySearchCandidate[] {
  if (query.length !== dimensions || vectors.length !== ids.length * dimensions) throw new Error("memory_embedding_dimensions_invalid");
  const queryNorm = vectorNorm(query);
  if (queryNorm === 0) return [];
  const results = ids.map((id, index) => {
    let dot = 0;
    let norm = 0;
    const offset = index * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = vectors[offset + dimension]!;
      dot += query[dimension]! * value;
      norm += value * value;
    }
    return { id, score: norm === 0 ? 0 : dot / (queryNorm * Math.sqrt(norm)) };
  });
  return results
    .sort((left, right) => right.score - left.score || compareIds(left.id, right.id))
    .slice(0, limit)
    .map((result, index) => ({ ...result, rank: index + 1, source: "semantic" as const }));
}

export function mergeReciprocalRanks(
  lexical: MemorySearchCandidate[],
  semantic: MemorySearchCandidate[],
  limit = 50,
): MemorySearchCandidate[] {
  const scores = new Map<string, number>();
  for (const list of [lexical, semantic]) {
    for (const candidate of list) scores.set(candidate.id, (scores.get(candidate.id) ?? 0) + 1 / (60 + candidate.rank));
  }
  return [...scores.entries()]
    .sort(([leftId, left], [rightId, right]) => right - left || compareIds(leftId, rightId))
    .slice(0, limit)
    .map(([id, score], index) => ({ id, score, rank: index + 1, source: "lexical" as const }));
}

export function extractStrongAnchors(text: string): string[] {
  const withoutActions = text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(ACTION_WORDS, " ");
  const quoted = [...withoutActions.matchAll(/[“"'‘]([^”"'’]{2,80})[”"'’]/gu)].map((match) => normalizeToken(match[1]!));
  const technical = withoutActions.match(/[a-z][a-z0-9]*(?:[._+/#@-][a-z0-9]+)+|[a-z][a-z0-9-]{2,}|\bv?\d+(?:\.\d+)+\b/giu) ?? [];
  return [...new Set([...quoted, ...technical.map(normalizeToken)].filter((token) => token.length >= 2))];
}

function normalizedTechnicalTokens(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const tokens = normalized.match(/[a-z][a-z0-9]*(?:[._+/#@-][a-z0-9]+)+|[a-z][a-z0-9-]{2,}|\bv?\d+(?:\.\d+)+\b/giu) ?? [];
  return new Set(tokens.map(normalizeToken));
}

function extractReplacement(text: string): string {
  const normalized = text.trim();
  const notBut = normalized.match(/不是.{1,200}?(?:而是|改为|改成)(.+)$/u);
  const replacement = (notBut?.[1] ?? normalized.replace(CORRECTION_PREFIX, "")).trim().replace(/[。！!]+$/u, "");
  return replacement || normalized;
}

function normalizeToken(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
