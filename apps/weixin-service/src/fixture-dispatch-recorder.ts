import type { TeamLeader } from "./agent-dispatch-leader.js";
import type { DispatchClassifier, DispatchExecutor } from "./agent-dispatch-types.js";

/**
 * One turn of the Coordinator, a Team Leader or an Executor: what it was given, what it returned or why it failed, and when it
 * started and ended. A classification names its message; every other turn names its request. A turn still running has no end.
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
  return {
    classifier: {
      classify: (input) => recorded({ role: "coordinator", turn: "classify", messageId: input.event.messageId,
        input: { text: input.event.text, mentionedAgentIds: input.event.mentionedAgentIds ?? [], agents: input.agents, requests: input.requests } }, () => classifier.classify(input)),
      assign: (input) => recorded({ role: "coordinator", turn: "assign", requestId: input.requestId, input: { lead: input.lead, parts: input.parts, teams: input.teams } },
        () => classifier.assign(input)),
      close: () => classifier.close?.(),
    },
    leader: {
      plan: (input, existing) => recorded({ role: "leader", turn: "plan", requestId: input.requestId, teamId: input.leader.id,
        input: { brief: input.brief, profiles: input.profiles, ...(input.relay ? { relay: input.relay } : {}) } }, () => leader.plan(input, existing)),
      supplement: (input, assignments, supplement, total) => recorded({ role: "leader", turn: "supplement", requestId: input.requestId, teamId: input.leader.id,
        input: { brief: input.brief, assignments, supplement, ...(input.relay ? { relay: input.relay } : {}) } }, () => leader.supplement(input, assignments, supplement, total)),
      close: (input, assignments) => recorded({ role: "leader", turn: "close", requestId: input.requestId, teamId: input.leader.id,
        input: { assignments, ...(input.relay ? { relay: input.relay } : {}) } }, () => leader.close(input, assignments)),
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
