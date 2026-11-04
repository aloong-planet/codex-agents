import type { AccountMemoryEvent, PlanStatus } from "./account-memory-store.js";
import { normalizeMemoryValue } from "./account-memory-store.js";

export type PlannedEventResolution =
  | { status: "resolved"; targetId: string }
  | { status: "needs_clarification"; reason: "target_missing" | "target_ambiguous"; candidateIds: string[] };

export function resolvePlannedEventTarget(match: string, events: AccountMemoryEvent[], statuses: PlanStatus[] = ["pending"]): PlannedEventResolution {
  const ranked = rankPlannedEventCandidates(match, events, statuses);
  if (ranked.length === 0 || ranked[0]!.score < 0.5) {
    return { status: "needs_clarification", reason: "target_missing", candidateIds: [] };
  }
  const plausible = ranked.filter((candidate) => candidate.score >= 0.5);
  if (plausible.length > 1 && plausible[0]!.score - plausible[1]!.score < 0.15) {
    return { status: "needs_clarification", reason: "target_ambiguous", candidateIds: plausible.slice(0, 5).map((candidate) => candidate.event.id) };
  }
  return { status: "resolved", targetId: plausible[0]!.event.id };
}

export function selectPlannedEventCandidates(query: string, events: AccountMemoryEvent[], limit = 20, statuses: PlanStatus[] = ["pending"]): AccountMemoryEvent[] {
  return rankPlannedEventCandidates(query, events, statuses).slice(0, limit).map((candidate) => structuredClone(candidate.event));
}

function rankPlannedEventCandidates(queryValue: string, events: AccountMemoryEvent[], statuses: PlanStatus[]): Array<{ event: AccountMemoryEvent; score: number }> {
  const query = normalizeEventMatch(queryValue);
  if (Array.from(query).length < 2) return [];
  return events
    .filter((event) => event.eventKind === "planned" && event.planStatus !== undefined && statuses.includes(event.planStatus))
    .map((event) => ({ event, score: eventMatchScore(query, normalizeEventMatch(event.summary)) }))
    .sort((left, right) => right.score - left.score || left.event.id.localeCompare(right.event.id));
}

function normalizeEventMatch(value: string): string {
  return normalizeMemoryValue(value).replace(/(?:我|改变计划|更改计划|修改计划|更新计划|计划|准备)/gu, "");
}

function eventMatchScore(left: string, right: string): number {
  if (left === right || left.includes(right) || right.includes(left)) return 1;
  const leftPairs = characterPairs(left);
  const rightPairs = characterPairs(right);
  if (leftPairs.size === 0 || rightPairs.size === 0) return 0;
  let overlap = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1;
  return (2 * overlap) / (leftPairs.size + rightPairs.size);
}

function characterPairs(value: string): Set<string> {
  const characters = Array.from(value);
  const pairs = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) pairs.add(`${characters[index]}${characters[index + 1]}`);
  return pairs;
}
