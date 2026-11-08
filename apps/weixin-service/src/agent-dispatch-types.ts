import type { InboundContent } from "./channel-contract.js";
import type { SendTextResult } from "./channel-contract.js";

export type DispatchAgentDefinition = { id: string; name: string; responsibility: string };
export type DispatchAgent = DispatchAgentDefinition & { senderAccountId: string };
export type DispatchDecision = {
  kind: "ignore" | "clarify" | "dispatch" | "propose" | "confirm" | "decline" | "supplement" | "cancel" | "retry" | "retry_report" | "trim";
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
  /**
   * A plan, or a supplement's new Assignments with the positions it affects, that would exceed the request's limits; it waits
   * for the original requester's choice (agent-dispatch::REQ-011/AC-02). `choice` is set once the requester answers.
   */
  overLimit?: { assignments: Array<{ teamId: string; profileId: string; title: string; brief: string }>; decisions: string[]; affected?: number[];
    choice?: "run" | "trim" };
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
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
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
};
export type DispatchClassificationInput = {
  event: InboundContent;
  agents: readonly DispatchAgentDefinition[];
  /** `awaiting` marks a request waiting for its requester's choice on a plan over the limits. */
  requests: Array<Pick<DispatchJob, "id" | "agentId" | "summary" | "status"> & { awaiting?: "over_limit" }>;
  memory: string;
};
export interface DispatchClassifier { classify(input: DispatchClassificationInput): Promise<DispatchDecision>; close?(): void | Promise<void>; }
export type DispatchPendingResult = { handled: false; cancelledRunRef?: string } | { handled: true; senderAccountId?: string; runRef?: string; result: DispatchExecutionResult };
/** `cause` is set when the host saw a tool call refused during a turn the Executor reported unfinished. */
export type DispatchExecutionResult = { status: "completed" | "waiting" | "failed" | "cancelled"; message: string; runRef?: string; cause?: "tool_refused" };
export interface DispatchExecutor {
  run(job: DispatchJob, assignment: DispatchAssignment, signal: AbortSignal): Promise<DispatchExecutionResult>;
  close(): void | Promise<void>;
}
export type DispatchDelivery = (input: { accountId: string; target: string; senderAccountId: string; message: string; operationId: string; beforeSubmit(): boolean }) => Promise<SendTextResult>;
