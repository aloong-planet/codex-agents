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
  run(job: DispatchJob, signal: AbortSignal): Promise<DispatchExecutionResult>;
  close(): void | Promise<void>;
}
export type DispatchDelivery = (input: { accountId: string; target: string; senderAccountId: string; message: string; operationId: string; beforeSubmit(): boolean }) => Promise<SendTextResult>;
