import { parseLeaderClosing, planWithCorrection, type LeaderAssignmentReport, type LeaderTurnInput, type TeamLeader } from "./agent-dispatch-leader.js";

/** Where fixture Team Leader outputs come from: the outputs injected with the message a turn concerns. */
export type FixtureLeaderSource = { leaderPlan(messageId: string): unknown; leaderClosing(messageId: string): unknown };
export type FixtureLeaderRequest = { phase: "plan" | "close"; teamId: string; input: unknown };

/** The default plan when a message injects none: one Assignment on the team's first preset, titled with the Coordinator's summary. */
export function fixtureDefaultPlan(input: LeaderTurnInput) {
  return { assignments: [{ profileId: input.profiles[0]?.id ?? "", title: input.brief.summary.slice(0, 120), brief: input.brief.latest ?? input.brief.message }] };
}

/**
 * Explicit fixture mode only: substitutes the Team Leader's model output with the injected, already-decoded plan or closing,
 * and still passes it through the production correction loop and parsers. The default closing repeats the Executor's result.
 */
export class FixtureTeamLeader implements TeamLeader {
  readonly requests: FixtureLeaderRequest[] = [];
  constructor(private readonly source: FixtureLeaderSource) {}

  plan(input: LeaderTurnInput) {
    return planWithCorrection(async (refusal) => {
      this.record("plan", input, refusal ? { refusal: refusal.reason } : {});
      return JSON.stringify(this.source.leaderPlan(input.fixtureMessageId) ?? fixtureDefaultPlan(input));
    }, { executorProfiles: input.profiles });
  }

  async close(input: LeaderTurnInput, assignments: readonly LeaderAssignmentReport[]) {
    this.record("close", input, { assignments });
    return parseLeaderClosing(JSON.stringify(this.source.leaderClosing(input.fixtureMessageId) ?? { message: assignments[0]?.result ?? "" }));
  }

  private record(phase: FixtureLeaderRequest["phase"], input: LeaderTurnInput, extra: Record<string, unknown>): void {
    this.requests.push({ phase, teamId: input.leader.id, input: structuredClone({ brief: input.brief, profiles: input.profiles, directory: input.directory, memory: input.memory, ...extra }) });
    if (this.requests.length > 40) this.requests.shift();
  }
}
