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
  status: "proposed" | "queued" | "running" | "waiting" | "completed" | "partially_failed" | "failed" | "cancelled";
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
  /** Decisions the Team Leader posts after the start message of `attempt` (agent-dispatch::US-003/AC-03). */
  decisions?: { attempt: number; texts: string[] };
};
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
export interface DispatchClassifier { classify(input: DispatchClassificationInput): Promise<DispatchDecision>; close?(): void | Promise<void>; }
export type DispatchPendingResult = { handled: false; cancelledRunRef?: string } | { handled: true; senderAccountId?: string; runRef?: string; result: DispatchExecutionResult };
/** `cause` is set when the host saw a tool call refused during a turn the Executor reported unfinished. */
export type DispatchExecutionResult = { status: "completed" | "waiting" | "failed" | "cancelled"; message: string; runRef?: string; cause?: "tool_refused" };
export interface DispatchExecutor {
  /** `prerequisites` holds the final results of the Assignments it depends on, bounded in size. */
  run(job: DispatchJob, assignment: DispatchAssignment, signal: AbortSignal, prerequisites?: readonly PrerequisiteResult[]): Promise<DispatchExecutionResult>;
  close(): void | Promise<void>;
}
export type DispatchDelivery = (input: { accountId: string; target: string; senderAccountId: string; message: string; operationId: string; beforeSubmit(): boolean }) => Promise<SendTextResult>;
