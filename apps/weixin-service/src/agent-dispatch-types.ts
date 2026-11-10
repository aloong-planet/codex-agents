import type { InboundContent } from "./channel-contract.js";
import type { SendTextResult } from "./channel-contract.js";

export type DispatchAgentDefinition = { id: string; name: string; responsibility: string };
export type DispatchAgent = DispatchAgentDefinition & { senderAccountId: string };
export type DispatchDecision = {
  kind: "ignore" | "clarify" | "dispatch" | "propose" | "confirm" | "decline" | "supplement" | "cancel" | "retry" | "retry_report";
  agentId: string | null;
  requestId: string | null;
  summary: string;
  message: string;
};
export type DispatchJob = {
  id: string;
  event: InboundContent;
  bindingHash: string;
  agentId: string;
  senderAccountId: string;
  summary: string;
  status: "proposed" | "queued" | "running" | "waiting" | "completed" | "partially_failed" | "partially_unassigned" | "failed" | "cancelled";
  result?: string;
  runRef?: string;
  attempt: number;
  cancelRequested?: boolean;
  executionEvent?: InboundContent;
  supplements?: InboundContent[];
  fixtureMessageId?: string;
  retry?: boolean;
  reportId?: string;
  /** The team definitions version the request runs under; absent only for requests stored before Assignments existed. */
  definitionsVersion?: number;
  /**
   * Decisions the Team Leaders post after the start messages of `attempt` (agent-dispatch::US-003/AC-03): `texts` are the lead's,
   * `byTeam` those of cross-team Team Leaders.
   */
  decisions?: { attempt: number; texts: string[]; byTeam?: Record<string, string[]> };
  /** The parts the lead Team Leader asked other teams to take, in the order asked (agent-dispatch::REQ-013). */
  parts?: DispatchPart[];
  /** Each cross-team Team Leader's latest closing, its report to the Coordinator, by team (agent-dispatch::REQ-013/AC-03). */
  reports?: Record<string, { attempt: number; text: string }>;
  /** Needs that cross-team Team Leaders reported, which the Coordinator relays to the lead (agent-dispatch::REQ-013/AC-01). */
  needs?: Array<{ teamId: string; title: string; brief: string }>;
  /** The attempt of an explicit retry whose earlier attempt was divided: it divides nothing again, and asks again for the parts no team took. */
  reaskAttempt?: number;
  /** The last attempt whose division was stored: a retry of a later attempt that failed before its division divides again. */
  dividedAttempt?: number;
  /**
   * The application of each cross-team Team Leader, frozen when its team first took a part, as `senderAccountId` freezes the lead's:
   * a changed application fails its work instead of sending under another identity (agent-dispatch::REQ-008/AC-04, REQ-010/AC-01).
   */
  senders?: Record<string, string>;
};
/** A part of a request the lead asked another team to take; `teamId` is the team the Coordinator placed it with, or null. */
/**
 * A part of a request the lead asked another team to take; `teamId` is the team the Coordinator placed it with, or null. `attempt`
 * is the attempt that last asked for it, and `asked` how often the Coordinator was asked (absent: once).
 */
export type DispatchPart = { title: string; brief: string; attempt: number; teamId: string | null; summary: string; asked?: number };
/** One part of a Dispatch Request, performed by exactly one Executor created from one of the team's preset profiles. */
export type DispatchAssignment = {
  id: string;
  requestId: string;
  teamId: string;
  profileId: string;
  profileName: string;
  /** The Executor's display name, from the durable Assignment sequence. */
  executor: string;
  title: string;
  brief: string;
  /** `blocked`: it never started because a prerequisite ended without completing, shown as 「未开始（前项失败）」. */
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "blocked";
  /** The request attempt this Assignment runs in; an explicit retry or an affecting supplement moves it to the new attempt. */
  attempt: number;
  result?: string;
  runRef?: string;
  /** The durable Executor sequence; absent on Assignments stored before several Assignments ran, whose turns keep the message key. */
  sequence?: number;
  /** The message its Executor's latest run received: the request's message, or the supplement that reran it. */
  input?: InboundContent;
  /** The host-known cause of its failure, as its failure post names it. */
  cause?: string;
  /** The Assignments of the same request it starts after, all completed; absent on Assignments stored before dependencies existed. */
  dependsOn?: string[];
};
/** A completed prerequisite's final result, as a dependent Assignment's Executor receives it; never its process. */
export type PrerequisiteResult = Readonly<{ position: number; title: string; executor: string; result: string }>;
export type DispatchClassificationInput = {
  event: InboundContent;
  agents: readonly DispatchAgentDefinition[];
  requests: Array<Pick<DispatchJob, "id" | "agentId" | "summary" | "status">>;
  memory: string;
};
/**
 * The Coordinator's cross-team turn (agent-dispatch::REQ-013/AC-02): the parts the lead Team Leader asked other teams to take,
 * what it reported about them, and the teams that may take one. Never any Executor's content (agent-dispatch::REQ-012/AC-04).
 */
export type CrossTeamInput = {
  requestId: string;
  /** The Coordinator's name, from the roster. */
  coordinator: string;
  message: string;
  summary: string;
  lead: DispatchAgentDefinition;
  /** `part` is the 1-based position each decision names. */
  parts: Array<{ part: number; title: string; brief: string }>;
  /** The teams accepting work in the group under the request's definitions, the lead excluded. */
  teams: DispatchAgentDefinition[];
  /** Routes a fixture turn to its injected decision; never consulted by a model turn. */
  fixtureMessageId: string;
};
/** One part's placement: the team that takes it, or `null` when no team fits, with the Coordinator's summary for that team. */
export type CrossTeamDecision = { part: number; agentId: string | null; summary: string };
export interface DispatchClassifier {
  classify(input: DispatchClassificationInput): Promise<DispatchDecision>;
  /** Places each requested part with one of the offered teams, or with none. */
  assign(input: CrossTeamInput): Promise<CrossTeamDecision[]>;
  close?(): void | Promise<void>;
}
export type DispatchPendingResult = { handled: false; cancelledRunRef?: string } | { handled: true; senderAccountId?: string; runRef?: string; result: DispatchExecutionResult };
/** `cause` is set when the host saw a tool call refused during a turn the Executor reported unfinished. */
export type DispatchExecutionResult = { status: "completed" | "waiting" | "failed" | "cancelled"; message: string; runRef?: string; cause?: "tool_refused" };
export interface DispatchExecutor {
  /** `prerequisites` holds the final results of the Assignments it depends on, bounded in size. */
  run(job: DispatchJob, assignment: DispatchAssignment, signal: AbortSignal, prerequisites?: readonly PrerequisiteResult[]): Promise<DispatchExecutionResult>;
  close(): void | Promise<void>;
}
export type DispatchDelivery = (input: { accountId: string; target: string; senderAccountId: string; message: string; operationId: string; beforeSubmit(): boolean }) => Promise<SendTextResult>;
