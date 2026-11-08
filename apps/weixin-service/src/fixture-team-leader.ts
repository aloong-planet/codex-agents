import { parseLeaderClosing, planWithCorrection, supplementWithCorrection, type LeaderAssignmentReport, type LeaderAssignmentView, type LeaderTurnInput,
  type TeamLeader } from "./agent-dispatch-leader.js";

/** Where fixture Team Leader outputs come from: the outputs injected with the message a turn concerns. */
export type FixtureLeaderSource = { leaderPlan(messageId: string): unknown; leaderSupplement(messageId: string): unknown; leaderClosing(messageId: string): unknown };
export type FixtureLeaderRequest = { phase: "plan" | "supplement" | "close"; teamId: string; input: unknown };

/** The default plan when a message injects none: one Assignment on the team's first preset, titled with the Coordinator's summary. */
export function fixtureDefaultPlan(input: LeaderTurnInput) {
  return { assignments: [{ profileId: input.profiles[0]?.id ?? "", title: input.brief.summary.slice(0, 120), brief: input.brief.latest ?? input.brief.message, dependsOn: [] }],
    decisions: [] };
}
/**
 * Fixture mode only: an injected plan or supplement answer whose Assignments leave out `dependsOn` gets an empty one, so
 * injected outputs written before dependencies existed stay valid. The production schema and parser still require it.
 */
export function withFixtureDependencies(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { assignments?: unknown }).assignments)) return value;
  const output = value as { assignments: unknown[] };
  return { ...output, assignments: output.assignments.map((assignment) => assignment && typeof assignment === "object" && !("dependsOn" in assignment)
    ? { ...assignment, dependsOn: [] } : assignment) };
}
/** The default supplement answer when its message injects none: every Assignment of the request is affected. */
export function fixtureDefaultSupplement(assignments: readonly LeaderAssignmentView[]) {
  return { affected: assignments.map(({ position }) => position), assignments: [], decisions: [] };
}
/** The default closing when a message injects none: every Executor's result, in the request's order. */
export function fixtureDefaultClosing(assignments: readonly LeaderAssignmentReport[]) {
  return { message: assignments.map(({ result }) => result).join("\n") };
}

/**
 * Explicit fixture mode only: substitutes the Team Leader's model output with the injected, already-decoded plan, supplement
 * answer or closing, and still passes it through the production correction loop and parsers.
 */
export class FixtureTeamLeader implements TeamLeader {
  readonly requests: FixtureLeaderRequest[] = [];
  constructor(private readonly source: FixtureLeaderSource) {}

  plan(input: LeaderTurnInput) {
    return planWithCorrection(async (refusal) => {
      this.record("plan", input, refusal ? { refusal: refusal.reason } : {});
      return JSON.stringify(withFixtureDependencies(this.source.leaderPlan(input.fixtureMessageId)) ?? fixtureDefaultPlan(input));
    }, { executorProfiles: input.profiles });
  }

  supplement(input: LeaderTurnInput, assignments: readonly LeaderAssignmentView[], supplement: string) {
    return supplementWithCorrection(async (refusal) => {
      this.record("supplement", input, { assignments, supplement, ...(refusal ? { refusal: refusal.reason } : {}) });
      return JSON.stringify(withFixtureDependencies(this.source.leaderSupplement(input.fixtureMessageId)) ?? fixtureDefaultSupplement(assignments));
    }, { executorProfiles: input.profiles }, assignments.length);
  }

  async close(input: LeaderTurnInput, assignments: readonly LeaderAssignmentReport[]) {
    this.record("close", input, { assignments });
    return parseLeaderClosing(JSON.stringify(this.source.leaderClosing(input.fixtureMessageId) ?? fixtureDefaultClosing(assignments)));
  }

  private record(phase: FixtureLeaderRequest["phase"], input: LeaderTurnInput, extra: Record<string, unknown>): void {
    this.requests.push({ phase, teamId: input.leader.id, input: structuredClone({ brief: input.brief, profiles: input.profiles, directory: input.directory, memory: input.memory, ...extra }) });
    if (this.requests.length > 40) this.requests.shift();
  }
}
