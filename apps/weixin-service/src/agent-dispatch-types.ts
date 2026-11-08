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
  status: "proposed" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
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
  /** The request attempt this Assignment runs in; an explicit retry moves it to the new attempt. */
  attempt: number;
  result?: string;
  runRef?: string;
};
export type DispatchClassificationInput = {
  event: InboundContent;
  agents: readonly DispatchAgentDefinition[];
  requests: Array<Pick<DispatchJob, "id" | "agentId" | "summary" | "status">>;
  memory: string;
};
export interface DispatchClassifier { classify(input: DispatchClassificationInput): Promise<DispatchDecision>; close?(): void | Promise<void>; }
export type DispatchPendingResult = { handled: false; cancelledRunRef?: string } | { handled: true; senderAccountId?: string; runRef?: string; result: DispatchExecutionResult };
export type DispatchExecutionResult = { status: "completed" | "waiting" | "failed" | "cancelled"; message: string; runRef?: string };
export interface DispatchExecutor {
  run(job: DispatchJob, assignment: DispatchAssignment, signal: AbortSignal): Promise<DispatchExecutionResult>;
  close(): void | Promise<void>;
}
export type DispatchDelivery = (input: { accountId: string; target: string; senderAccountId: string; message: string; operationId: string; beforeSubmit(): boolean }) => Promise<SendTextResult>;
