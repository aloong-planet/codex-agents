import type { LeaderTurnInput, TeamLeader } from "./agent-dispatch-leader.js";
import type { DispatchClassifier, DispatchExecutor } from "./agent-dispatch-types.js";

/**
 * One turn of the Coordinator, a Team Leader or an Executor: the input the dispatch engine gave it, what it returned or why it
 * failed, and when it started and ended. A classification names its message; every other turn names its request. A turn still
 * running has no end.
 *
 * The Coordinator's and a Team Leader's inputs are whole: the message with the discussion before it, the roster, the requests
 * and the group memory; the Team Leader's instructions, Brief, presets, Team Directory and own memory. Session keys and fixture
 * routing are left out, since no turn is given them. An Executor's input here is its Assignment and its prerequisites' results;
 * the triggering message, its profile's instructions and its memory are added inside its turn, and its thread rollout shows them.
 */
export type DispatchTurnRecord = {
  role: "coordinator" | "leader" | "executor";
  turn: "classify" | "assign" | "plan" | "supplement" | "close" | "run";
  messageId?: string;
  requestId?: string;
  teamId?: string;
  startedAt: number;
  endedAt?: number;
  input: unknown;
  output?: unknown;
  error?: string;
};

/**
 * Explicit fixture mode only, under the real-model seam: wraps the three dispatch seams so that a run can be judged afterwards
 * from what each turn decided (agent-dispatch Testing Decisions). Results and errors pass through unchanged. A Team Leader's
 * correction turn stays inside its plan turn, so a record shows the plan that passed validation or the refusal that ended it.
 */
export function recordDispatchTurns(seams: { classifier: DispatchClassifier; leader: TeamLeader; executor: DispatchExecutor },
  options: { now?: () => number; limit?: number } = {}): { classifier: DispatchClassifier; leader: TeamLeader; executor: DispatchExecutor; turns(): DispatchTurnRecord[] } {
  const now = options.now ?? Date.now, limit = options.limit ?? 200;
  const turns: DispatchTurnRecord[] = [];
  const recorded = async <T>(turn: Omit<DispatchTurnRecord, "startedAt">, work: () => Promise<T>): Promise<T> => {
    const record: DispatchTurnRecord = { ...structuredClone(turn), startedAt: now() };
    turns.push(record);
    if (turns.length > limit) turns.shift();
    try {
      const output = await work();
      record.output = structuredClone(output);
      return output;
    } catch (error) {
      // A refused Team Leader output carries the reason its correction turn was told.
      const reason = (error as { reason?: unknown } | null)?.reason;
      const code = error instanceof Error ? error.message : String(error);
      record.error = typeof reason === "string" ? `${code}: ${reason}` : code;
      throw error;
    } finally { record.endedAt = now(); }
  };
  const { classifier, leader, executor } = seams;
  // What a Team Leader's turn is given, whatever its phase.
  const given = ({ leader: self, profiles, brief, directory, memory, relay }: LeaderTurnInput) => ({ leader: self, profiles, brief, directory, memory, ...(relay ? { relay } : {}) });
  return {
    classifier: {
      classify: (input) => recorded({ role: "coordinator", turn: "classify", messageId: input.event.messageId, input }, () => classifier.classify(input)),
      assign: (input) => recorded({ role: "coordinator", turn: "assign", requestId: input.requestId,
        input: { coordinator: input.coordinator, message: input.message, summary: input.summary, lead: input.lead, parts: input.parts, teams: input.teams } }, () => classifier.assign(input)),
      close: () => classifier.close?.(),
    },
    leader: {
      plan: (input, existing) => recorded({ role: "leader", turn: "plan", requestId: input.requestId, teamId: input.leader.id,
        input: { ...given(input), ...(existing !== undefined ? { existing } : {}) } }, () => leader.plan(input, existing)),
      supplement: (input, assignments, supplement, total) => recorded({ role: "leader", turn: "supplement", requestId: input.requestId, teamId: input.leader.id,
        input: { ...given(input), assignments, supplement, ...(total !== undefined ? { total } : {}) } }, () => leader.supplement(input, assignments, supplement, total)),
      close: (input, assignments) => recorded({ role: "leader", turn: "close", requestId: input.requestId, teamId: input.leader.id,
        input: { ...given(input), assignments } }, () => leader.close(input, assignments)),
      dispose: () => leader.dispose?.(),
    },
    executor: {
      run: (job, assignment, signal, prerequisites) => recorded({ role: "executor", turn: "run", requestId: job.id, teamId: assignment.teamId,
        input: { assignmentId: assignment.id, executor: assignment.executor, profileId: assignment.profileId, title: assignment.title, brief: assignment.brief,
          attempt: assignment.attempt, prerequisites: prerequisites ?? [] } }, async () => executor.run(job, assignment, signal, prerequisites)),
      close: () => executor.close(),
    },
    turns: () => structuredClone(turns),
  };
}
