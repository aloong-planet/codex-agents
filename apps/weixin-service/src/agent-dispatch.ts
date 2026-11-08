import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundContent, SendTextResult } from "./channel-contract.js";
import type { DispatchAgent, DispatchAssignment, DispatchClassifier, DispatchDelivery, DispatchExecutionResult, DispatchExecutor, DispatchJob,
  DispatchPendingResult } from "./agent-dispatch-types.js";
import { parseDispatchDecision } from "./agent-dispatch-classifier.js";
import { ASSIGNMENT_LIMIT, exceedsLimits, LeaderOutputError, TEAM_LIMIT, trimToLimits, type LeaderPlanAssignment, type LeaderTurnInput,
  type TeamLeader } from "./agent-dispatch-leader.js";
import { COORDINATOR_ID } from "./team-registry.js";
import type { AgentMemoryScope } from "./agent-profile.js";
import type { PendingPresentation } from "./workflow-pending-response-coordinator.js";

/**
 * A group post. `requestId` ties it to the request it belongs to; `memory` marks the closing or result of a finished attempt,
 * whose acceptance captures that attempt into the group memory.
 */
type Notice = { event: InboundContent; agentId: string; senderAccountId: string; text: string; bindingHash: string; presentation?: Omit<PendingPresentation, "acceptedAt">;
  requestId?: string; memory?: { attempt: number; event: InboundContent; text: string } };
type NoticeRow = { id: string; payload: string; state: string; result: string | null };
/** The trusted part of a team a request's Team Leader works with, from the request's definitions version. */
export type DispatchTeamView = Readonly<{ leader: LeaderTurnInput["leader"]; profiles: LeaderTurnInput["profiles"]; memoryScope: AgentMemoryScope }>;
/** One turn captured into an agent's memory; `event` names the conversation and is the source of the user entry. */
export type DispatchMemoryTurn = Readonly<{ event: InboundContent; senderAccountId: string; userId: string; userText: string; assistantId: string; assistantText: string }>;
type AssignmentStatus = DispatchAssignment["status"];
const ENDED: readonly AssignmentStatus[] = ["completed", "failed", "cancelled", "interrupted"];
const UNFINISHED: readonly AssignmentStatus[] = ["queued", "running", "waiting"];
const INTERRUPTED = "服务中断，本次处理已停止。";
type PlannedAssignment = LeaderPlanAssignment & { teamId: string };

/** How an Assignment failed, as far as the host knows it. */
export type AssignmentFailure = Readonly<{ kind: "reported"; toolRefused: boolean }> | Readonly<{ kind: "error"; error: unknown }> | Readonly<{ kind: "shutdown" }>;
/** The host-known cause a failure post names; the Executor's own text reaches the group only through its Team Leader's closing. */
export function failureCause(failure: AssignmentFailure): string {
  if (failure.kind === "reported") return failure.toolRefused ? "有工具调用被拒绝" : "执行者报告无法完成";
  if (failure.kind === "shutdown") return "服务中断";
  const code = failure.error instanceof Error ? failure.error.message : "";
  if (code.includes("无进展超时")) return "执行超时";
  if (code === "dispatch_model_unavailable" || code === "dispatch_group_unbound") return "运行环境不可用";
  if (code === "dispatch_authorization_changed" || code === "dispatch_role_invalid") return "权限或可用上下文发生变化";
  if (code.startsWith("main_reply_")) return "执行者未返回有效的结果报告";
  return "执行连接中断或处理出错";
}
/** A request's outcome once none of its Assignments is unfinished (agent-dispatch::REQ-008/AC-01); cancelled ones do not count. */
export function requestOutcome(statuses: readonly AssignmentStatus[]): "completed" | "partially_failed" | "failed" | "cancelled" {
  const counted = statuses.filter((status) => status !== "cancelled");
  if (!counted.length) return "cancelled";
  if (counted.every((status) => status === "completed")) return "completed";
  return counted.includes("completed") ? "partially_failed" : "failed";
}
/** An Executor's name, from its durable sequence. */
function executorName(sequence: number): string { return `执行者 ${sequence}`; }
const executorLabel = (assignment: DispatchAssignment) => `${assignment.executor}（${assignment.profileName}）`;
/** The Team Leader's start message: which Executor handles each Assignment that starts (agent-dispatch::US-003/AC-01). */
function startMessage(assignments: readonly DispatchAssignment[]): string {
  return `我安排${assignments.map((assignment) => `${executorLabel(assignment)}处理：${assignment.title}`).join("；")}。完成后会在本群汇报。`;
}
/** The message an Assignment's Executor receives; group discussion never travels with it. */
function inputOf(event: InboundContent): InboundContent {
  const input = { ...event };
  delete input.discussion;
  return input;
}

/**
 * One durable intake and independently recorded delivery outcomes. The Coordinator routes each request to a team; its Team
 * Leader divides it into Assignments in a tool-free turn, one Executor performs each, and the Team Leader closes the request.
 * Requests stored before Assignments existed carry no definitions version and keep the handling they were stored under.
 */
export class AgentDispatch {
  private readonly database: DatabaseSync;
  private started = false;
  private closing = false;
  private readonly intake = new Map<string, Promise<void>>();
  private readonly workers = new Map<string, { operation: Promise<void>; abort: AbortController }>();

  constructor(databasePath: string, private readonly options: {
    agents: readonly DispatchAgent[];
    classifier: DispatchClassifier;
    leader: TeamLeader;
    executor: DispatchExecutor;
    /** The current team definitions version, recorded on a request when it is first planned. */
    definitionsVersion(): number;
    /** A team as its request's definitions version defines it, or undefined when that version has no such team. */
    team(teamId: string, definitionsVersion: number): DispatchTeamView | undefined;
    /** The access revision that keys Team Leader sessions. */
    revision(): string;
    /**
     * The teams accepting work in the event's group under the current definitions, in registry order. Only they are routed
     * to, receive new Assignments there and form its Team Directory (agent-dispatch::REQ-015/AC-01, AC-02).
     */
    roster(event: InboundContent): ReadonlyArray<Readonly<{ id: string; name: string; responsibility: string }>>;
    delivery: DispatchDelivery;
    authorized(event: InboundContent): boolean;
    bindingHash(event: InboundContent): string;
    /** The Coordinator's memory scope, the group memory: only its turns recall it and only finished requests are captured into it. */
    memoryScope: AgentMemoryScope;
    /** Recall and capture of one agent's own memory scope in the event's conversation (agent-dispatch::REQ-012). */
    memory: Readonly<{ recall(scope: AgentMemoryScope, event: InboundContent, query: string): string; capture(scope: AgentMemoryScope, turn: DispatchMemoryTurn): Promise<void> }>;
    /** The request's completed-effect evidence, aggregated over its Assignments. */
    completedWork(job: DispatchJob, assignments: readonly DispatchAssignment[]): string;
    presentation(event: InboundContent, runRef: string): Omit<PendingPresentation, "acceptedAt"> | undefined;
    presented(presentation: PendingPresentation): void;
    pending?(event: InboundContent): Promise<DispatchPendingResult>;
    report(code: string): void;
  }) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS dispatch_input (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, binding_hash TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_job (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_notice (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS dispatch_assignment (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    const columns = this.database.prepare("PRAGMA table_info(dispatch_notice)").all().map(({ name }) => name);
    if (!columns.includes("accepted_at")) this.database.exec("ALTER TABLE dispatch_notice ADD COLUMN accepted_at INTEGER");
    // Group posts of a request, and whether a capture into the group memory has taken them.
    if (!columns.includes("request_id")) this.database.exec("ALTER TABLE dispatch_notice ADD COLUMN request_id TEXT");
    if (!columns.includes("captured")) this.database.exec("ALTER TABLE dispatch_notice ADD COLUMN captured INTEGER");
  }

  admit(event: InboundContent): void {
    if (this.closing) throw new Error("dispatch_closed");
    if (!this.options.authorized(event) || event.conversationType !== "group") return;
    this.database.prepare("INSERT OR IGNORE INTO dispatch_input(id, target, payload, binding_hash, state) VALUES (?, ?, ?, ?, 'queued')")
      .run(event.key, event.target, JSON.stringify(event), this.options.bindingHash(event));
    setImmediate(() => this.kick());
  }

  async start(): Promise<void> {
    if (this.started || this.closing) throw new Error("dispatch_already_started");
    this.started = true;
    this.database.prepare("UPDATE dispatch_input SET state = 'queued' WHERE state = 'classifying'").run();
    this.database.prepare("UPDATE dispatch_notice SET state = 'unknown' WHERE state = 'sending'").run();
    for (const row of this.database.prepare("SELECT payload, accepted_at FROM dispatch_notice WHERE state = 'accepted' AND accepted_at IS NOT NULL ORDER BY sequence").all()) {
      this.markPresented(JSON.parse(String(row.payload)) as Notice, Number(row.accepted_at));
    }
    for (const job of this.jobs()) if (job.status === "running") this.recover(job);
    for (const row of this.database.prepare("SELECT id, payload FROM dispatch_notice WHERE state = 'queued' ORDER BY sequence").all()) {
      await this.deliverNotice(String(row.id), JSON.parse(String(row.payload)) as Notice);
    }
    this.kick();
  }

  getState() {
    return { jobs: this.jobs().map(({ id, agentId, senderAccountId, summary, status, result, attempt, runRef, event, definitionsVersion }) =>
      ({ id, agentId, senderAccountId, summary, status, result, attempt, runRef, accountId: event.accountId, target: event.target, requester: event.senderId,
        definitionsVersion: definitionsVersion ?? null,
        assignments: this.assignments(id).map(({ id: assignmentId, teamId, profileId, executor, title, status: state, attempt: run }) =>
          ({ id: assignmentId, teamId, profileId, executor, title, status: state, attempt: run })) })),
    notices: this.database.prepare("SELECT id, state FROM dispatch_notice ORDER BY sequence").all() };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const worker of this.workers.values()) worker.abort.abort();
    await Promise.allSettled([this.options.classifier.close?.(), this.options.executor.close()]);
    await Promise.allSettled([...this.intake.values(), ...[...this.workers.values()].map(({ operation }) => operation)]);
    try { this.options.leader.dispose?.(); } catch { this.failure("dispatch_leader_close_failed"); }
    this.database.close();
  }

  /**
   * A request that was running when the service stopped. A cancelled one stays cancelled. Each running Assignment becomes
   * interrupted and is reported in its own post; the request then returns to its worker, which runs what was queued and
   * closes it with its Team Leader's turn, which is tool-free and safe to repeat (agent-dispatch::REQ-008/AC-02).
   */
  private recover(job: DispatchJob): void {
    if (job.definitionsVersion === undefined) {
      // Requests stored before Assignments existed keep the handling they were stored under.
      job.status = "failed"; job.result = `服务中断，本次处理已停止。${this.options.completedWork(job, [])}已有操作不会自动重复；请核对结果后明确重试。`;
      this.recordResult(job);
      return;
    }
    if (job.cancelRequested) {
      this.cancel(job);
      this.recordResult(job, this.hasAttemptAssignments(job) ? this.closingId(job) : undefined);
      return;
    }
    this.transaction(() => {
      for (const assignment of this.assignments(job.id)) {
        if (assignment.status !== "running") continue;
        assignment.status = "interrupted"; assignment.result = INTERRUPTED; assignment.cause = failureCause({ kind: "shutdown" });
        this.saveAssignment(assignment);
        this.queueNotice(`${job.id}:interrupted:${assignment.id}:${assignment.attempt}`, { ...this.notice(job,
          `服务中断，${executorLabel(assignment)}的分工「${assignment.title}」已中断，无法确认已完成的内容，不会自动重放。`), requestId: job.id });
      }
      job.status = "queued"; this.save(job);
    });
  }

  private kick(): void {
    if (!this.started || this.closing) return;
    for (const row of this.database.prepare("SELECT DISTINCT target FROM dispatch_input WHERE state = 'queued'").all()) {
      const target = String(row.target);
      if (this.intake.has(target)) continue;
      const operation = this.processInputs(target).catch(() => this.failure("dispatch_intake_failed"))
        .finally(() => { this.intake.delete(target); });
      this.intake.set(target, operation);
    }
    for (const job of this.jobs()) {
      if (job.status !== "queued" || [...this.workers.keys()].some((id) => {
        const active = this.job(id); return active?.event.target === job.event.target && active.agentId === job.agentId;
      })) continue;
      const abort = new AbortController();
      const operation = this.execute(job, abort.signal).catch(() => this.failure("dispatch_execution_record_failed"))
        .finally(() => { this.workers.delete(job.id); this.kick(); });
      this.workers.set(job.id, { operation, abort });
    }
  }

  private async processInputs(target: string): Promise<void> {
    while (!this.closing) {
      const row = this.database.prepare("SELECT * FROM dispatch_input WHERE target = ? AND state = 'queued' ORDER BY sequence LIMIT 1").get(target);
      if (!row) return;
      const event = JSON.parse(String(row.payload)) as InboundContent, bindingHash = String(row.binding_hash);
      if (!this.eligible(event, bindingHash)) { this.finishInput(event.key); continue; }
      this.database.prepare("UPDATE dispatch_input SET state = 'classifying' WHERE id = ?").run(event.key);
      // Only teams accepting work in this group can be routed to or named; a mention of another team confers no priority.
      const accepting = new Set(this.options.roster(event).map(({ id }) => id));
      const agents = this.options.agents.filter(({ id }) => id === COORDINATOR_ID || accepting.has(id));
      const mentioned = event.mentionedAgentIds?.filter((id) => agents.some((agent) => agent.id === id));
      if ((mentioned?.length ?? 0) > 1) {
        await this.coordinate(event, bindingHash, "你点名了多个 Agent。这项事务希望由谁独立负责？");
        this.finishInput(event.key); continue;
      }
      const input = { event: mentioned ? { ...event, mentionedAgentIds: mentioned } : event, agents: agents.map(({ id, name, responsibility }) => ({ id, name, responsibility })),
        requests: this.jobs().filter((job) => job.event.target === event.target && job.event.senderId === event.senderId)
          .slice(-20).map(({ id, agentId, summary, status, overLimit }) => ({ id, agentId, summary, status, ...(overLimit ? { awaiting: "over_limit" as const } : {}) })),
        memory: this.options.memory.recall(this.options.memoryScope, event, event.text) };
      try {
        const pending = await this.options.pending?.(event);
        if (pending && !pending.handled && pending.cancelledRunRef) {
          const superseded = this.requestOfRun(pending.cancelledRunRef, event);
          if (superseded) { superseded.status = "cancelled"; this.save(superseded); }
        }
        if (pending?.handled) {
          const agent = this.options.agents.find((item) => pending.senderAccountId ? item.senderAccountId === pending.senderAccountId : item.id === COORDINATOR_ID);
          if (!agent) throw new Error("dispatch_pending_sender_unavailable");
          const original = pending.runRef ? this.requestOfRun(pending.runRef, event) : undefined;
          const waiting = original && this.assignments(original.id).find((assignment) => assignment.status === "waiting" &&
            (assignment.runRef === pending.runRef || (assignment.runRef === undefined && original.runRef === pending.runRef)));
          const several = original !== undefined && this.assignments(original.id).length > 1;
          const notice = { event, bindingHash, agentId: agent.id, senderAccountId: agent.senderAccountId, text: pending.result.message };
          if (original && waiting && (pending.result.status === "completed" || pending.result.status === "failed" || (several && pending.result.status === "cancelled"))) {
            // The resolved choice ends its Assignment; the Team Leader closes the request once nothing else is unfinished.
            waiting.status = pending.result.status; waiting.result = pending.result.message;
            if (original.status === "waiting") original.status = "queued";
            const reply = pending.result.status === "cancelled" ? { ...notice, requestId: original.id } : undefined;
            this.transaction(() => { this.saveAssignment(waiting); this.save(original); if (reply) this.queueNotice(`${event.key}:pending`, reply); });
            if (reply) await this.deliverNotice(`${event.key}:pending`, reply);
            this.finishInput(event.key); this.kick(); continue;
          }
          const presentation = pending.result.status === "waiting" && pending.runRef ? this.options.presentation(event, pending.runRef) : undefined;
          const shown = { ...notice, ...(presentation ? { presentation } : {}) };
          if (original) {
            original.status = pending.result.status; original.result = pending.result.message;
            if (waiting && pending.result.status === "cancelled") { waiting.status = "cancelled"; waiting.result = pending.result.message; this.saveAssignment(waiting); }
            this.recordResult(original, `${event.key}:pending`, shown);
          } else this.queueNotice(`${event.key}:pending`, shown);
          await this.deliverNotice(`${event.key}:pending`, shown);
          this.finishInput(event.key); this.kick(); continue;
        }
        const decision = parseDispatchDecision(await this.options.classifier.classify(input), input);
        if (!this.eligible(event, bindingHash) || this.closing) { this.finishInput(event.key); continue; }
        if (decision.kind === "dispatch" || decision.kind === "propose") {
          const agent = agents.find((candidate) => candidate.id === decision.agentId)!;
          const named = agents.find(({ id }) => id === mentioned?.[0]);
          if (decision.kind === "dispatch" && named && named.id !== COORDINATOR_ID && named.id !== agent.id) {
            const coordinator = this.options.agents.find(({ id }) => id === COORDINATOR_ID)!;
            const explanation = decision.message || `这项需求属于 ${agent.name} 的职责。我请 ${coordinator.name} 重新分派，由他独立处理。`;
            // The request's ID is its message key, so these posts belong to the request saved below.
            const informed = await this.deliverNotice(`${event.key}:scope`, { event, bindingHash, agentId: named.id, senderAccountId: named.senderAccountId, text: explanation, requestId: event.key });
            if (!informed.ok) { this.finishInput(event.key); continue; }
            const reassigned = await this.coordinate(event, bindingHash, `已将这项需求转派给 ${agent.name}。`, event.key);
            if (!reassigned.ok) { this.finishInput(event.key); continue; }
          }
          if (!this.job(event.key)) this.save({ id: event.key, event, bindingHash, agentId: agent.id, senderAccountId: agent.senderAccountId,
            summary: decision.summary, status: decision.kind === "propose" ? "proposed" : "queued", attempt: 0 });
          if (decision.kind === "propose") await this.coordinate(event, bindingHash,
            `要不要请 ${agent.name} 帮你${decision.summary}？请回复这条建议确认，或告诉我暂时不用。`, event.key);
        } else if (decision.kind === "confirm" || decision.kind === "decline" || decision.kind === "trim") {
          const job = this.job(decision.requestId!);
          const own = job && job.event.senderId === event.senderId && job.event.target === event.target && this.eligible(job.event, job.bindingHash);
          if (own && job.status === "waiting" && job.overLimit && decision.kind !== "decline") {
            // Only the original requester's choice runs a plan over the limits, as proposed or trimmed (agent-dispatch::REQ-014).
            job.overLimit.choice = decision.kind === "trim" ? "trim" : "run"; job.status = "queued"; this.save(job);
          } else if (!own || job.status !== "proposed" || decision.kind === "trim") {
            await this.coordinate(event, bindingHash, "这条建议现在无法确认，请说明要处理的事务。");
          } else {
            job.status = decision.kind === "confirm" ? "queued" : "cancelled";
            if (decision.kind === "confirm") job.executionEvent = {
              ...event, text: `${(job.executionEvent ?? job.event).text}\n确认与要求：${event.text}`,
            };
            this.save(job);
            if (decision.kind === "decline") await this.coordinate(event, bindingHash, "好的，这条建议暂不处理。");
          }
        } else if (decision.kind === "cancel" || decision.kind === "supplement") {
          const job = this.job(decision.requestId!);
          if (!job || job.event.senderId !== event.senderId || job.event.target !== event.target || !this.eligible(job.event, job.bindingHash) ||
              !["queued", "running", "waiting", "proposed"].includes(job.status)) {
            await this.coordinate(event, bindingHash, "这项请求已经结束或无法继续，请说明新的需求。");
          } else if (decision.kind === "cancel") {
            job.cancelRequested = true; job.supplements = [];
            if (job.status === "running" && this.workers.has(job.id)) { this.save(job); this.workers.get(job.id)!.abort.abort(); }
            else {
              this.cancel(job);
              const report = this.recordResult(job, `${event.key}:cancelled`);
              await this.deliverNotice(report.id, report.notice);
            }
          } else {
            if ((job.supplements?.length ?? 0) >= 20) await this.coordinate(event, bindingHash, "这项请求已有多条补充待处理，请等当前处理结束后再补充。");
            else if (job.status === "running" || job.status === "queued" || job.overLimit) { (job.supplements ??= []).push(event); this.save(job); }
            else if (job.status === "proposed") {
              job.summary = decision.summary || job.summary;
              job.executionEvent = { ...event, text: `${(job.executionEvent ?? job.event).text}\n补充要求：${event.text}` }; this.save(job);
              await this.coordinate(event, bindingHash, "已补充到建议中。请确认是否开始处理。", job.id);
            } else {
              // A request waiting for a choice: the supplement supersedes the waiting Assignments and its Team Leader decides what it affects.
              this.transaction(() => {
                for (const assignment of this.assignments(job.id)) if (assignment.status === "waiting") { assignment.status = "cancelled"; this.saveAssignment(assignment); }
                job.executionEvent = event; job.attempt++; job.status = "queued"; this.save(job);
              });
            }
          }
        } else if (decision.kind === "retry" || decision.kind === "retry_report") {
          const job = this.job(decision.requestId!);
          if (!job || job.event.target !== event.target || job.event.senderId !== event.senderId || !this.eligible(job.event, job.bindingHash)) {
            await this.coordinate(event, bindingHash, "无法继续这项请求，请说明需要处理的事务。");
          } else if (decision.kind === "retry_report") {
            const originalId = job.reportId ?? `${job.id}:result:${job.attempt}`;
            const previous = this.database.prepare("SELECT state, payload FROM dispatch_notice WHERE id = ?").get(originalId);
            const retried = this.database.prepare("SELECT state FROM dispatch_notice WHERE id GLOB ?").all(`${originalId}:retry:*`);
            if (previous?.state === "rejected" && retried.every((notice) => notice.state === "rejected")) {
              await this.deliverNotice(`${originalId}:retry:${event.key}`, JSON.parse(String(previous.payload)) as Notice);
            } else await this.coordinate(event, bindingHash, "这条汇报已被接收或发送结果无法确认，不能自动重发。业务操作不会重新执行。");
          } else if (job.status === "failed" || job.status === "partially_failed") {
            job.status = "queued"; job.attempt++; job.retry = true; job.fixtureMessageId = event.messageId;
            // A retry reruns only the failed and interrupted Assignments, each with its Executor; a request that failed before
            // its Team Leader divided it, or before it answered a supplement, is planned or answered again.
            this.transaction(() => {
              for (const assignment of this.assignments(job.id)) {
                if (assignment.status !== "failed" && assignment.status !== "interrupted") continue;
                assignment.attempt = job.attempt; assignment.status = "queued"; delete assignment.cause; this.saveAssignment(assignment);
              }
              this.save(job);
            });
          } else await this.coordinate(event, bindingHash, "这项请求没有可重试的失败处理；已完成的操作不会重新执行。");
        } else if (decision.kind !== "ignore") {
          await this.coordinate(event, bindingHash, decision.message || "你指的是哪件事，希望得到什么结果？确认后我会交给合适的 Agent。");
        }
      } catch {
        if (!this.closing && this.eligible(event, bindingHash)) await this.coordinate(event, bindingHash, "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。");
      }
      this.finishInput(event.key);
      this.kick();
    }
  }

  private async execute(job: DispatchJob, signal: AbortSignal): Promise<void> {
    if (!this.eligible(job.event, job.bindingHash)) { job.status = "cancelled"; this.save(job); return; }
    job.status = "running"; job.definitionsVersion ??= this.options.definitionsVersion(); this.save(job);
    let closing: string | undefined;
    try {
      const team = this.options.team(job.agentId, job.definitionsVersion);
      if (!team) throw new Error("dispatch_team_unavailable");
      if (!(await this.divide(job, team, signal))) return;
      job = this.job(job.id)!;
      const starting = this.assignments(job.id).filter(({ attempt, status }) => attempt === job.attempt && status === "queued");
      if (starting.length) {
        const start = await this.deliverNotice(`${job.id}:receipt:${job.attempt}`, { ...this.notice(job, startMessage(starting)), requestId: job.id });
        if (!start.ok) throw new Error("dispatch_receipt_unavailable");
        if (signal.aborted) throw new Error("dispatch_cancelled");
        this.transaction(() => { for (const assignment of starting) { assignment.status = "running"; this.saveAssignment(assignment); } });
        await this.postDecisions(job);
        await Promise.all(starting.map((assignment) => this.runAssignment(job, assignment, signal)));
      }
      // A stopped service reports the Assignments it cut off at its next start.
      if (this.closing) return;
      job = this.job(job.id)!;
      const assignments = this.assignments(job.id);
      if (!job.cancelRequested) {
        if (assignments.some(({ status }) => status === "waiting")) { job.status = "waiting"; this.save(job); return; }
        closing = await this.closeRequest(job, team, assignments);
        await this.rememberDivision(job, team, assignments, closing);
        job = this.job(job.id)!;
        job.status = requestOutcome(assignments.map(({ status }) => status));
        job.result = closing + (job.status === "completed" ? "" : this.options.completedWork(job, assignments));
      }
    } catch (error) {
      if (this.closing) return;
      job = this.job(job.id)!;
      job.status = "failed";
      job.result = error instanceof LeaderOutputError
        ? "我暂时无法形成有效分工，本次尚未开始处理。请补充需求后明确重试。"
        : error instanceof Error && error.message === "dispatch_receipt_unavailable"
          ? "接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。"
          : `${failureReason(error)}${this.options.completedWork(job, this.assignments(job.id))}已完成的操作不会自动重复，请补充信息后明确让我重试。`;
      this.transaction(() => {
        for (const assignment of this.assignments(job.id)) {
          if (assignment.attempt !== job.attempt || ENDED.includes(assignment.status)) continue;
          assignment.status = "failed"; assignment.result = job.result!; assignment.cause = failureCause({ kind: "error", error }); this.saveAssignment(assignment);
        }
      });
    }
    if (job.cancelRequested) this.cancel(job);
    // Delivery is a separate outcome: failure here must never restart completed business work.
    const report = this.recordResult(job, this.hasAttemptAssignments(job) ? this.closingId(job) : undefined);
    if (!this.closing) await this.deliverNotice(report.id, report.notice);
  }

  /**
   * Gives the attempt its Assignments: a new request's plan, the requester's choice on a plan over the limits, or a promoted
   * supplement's answer. False when the request now waits for its requester's choice on the limits.
   */
  private async divide(job: DispatchJob, team: DispatchTeamView, signal: AbortSignal): Promise<boolean> {
    const assignments = this.assignments(job.id);
    if (job.overLimit?.choice) { this.applyChoice(job, team); return true; }
    if (assignments.some(({ attempt }) => attempt === job.attempt)) return true;
    // A team that stopped accepting work in this group since admission gets no new Assignment there (agent-dispatch::REQ-015/AC-01).
    const accepting = () => { if (!this.options.roster(job.event).some(({ id }) => id === job.agentId)) throw new Error("dispatch_team_unavailable"); };
    if (!assignments.length) {
      accepting();
      const plan = await this.options.leader.plan(this.leaderInput(job, team));
      if (signal.aborted) throw new Error("dispatch_cancelled");
      const planned = plan.assignments.map((assignment) => ({ ...assignment, teamId: job.agentId }));
      if (exceedsLimits(planned)) { await this.askOverLimit(job, team, { assignments: planned, decisions: plan.decisions }); return false; }
      this.addAssignments(job, team, planned, [], plan.decisions);
      return true;
    }
    // A promoted supplement: the lead Team Leader decides which Assignments it affects (agent-dispatch::REQ-007/AC-04).
    const answer = await this.options.leader.supplement(this.leaderInput(job, team), assignments.map((assignment, index) =>
      ({ position: index + 1, executor: assignment.executor, profileName: assignment.profileName, title: assignment.title, status: assignment.status })),
    (job.executionEvent ?? job.event).text);
    if (signal.aborted) throw new Error("dispatch_cancelled");
    const added = answer.assignments.map((assignment) => ({ ...assignment, teamId: job.agentId }));
    // Only new Assignments can take the request past its limits; rerunning the ones its requester already accepted cannot.
    if (added.length) accepting();
    if (added.length && exceedsLimits([...assignments.filter(({ status }) => status !== "cancelled"), ...added])) {
      await this.askOverLimit(job, team, { assignments: added, decisions: answer.decisions, affected: answer.affected }); return false;
    }
    this.addAssignments(job, team, added, answer.affected, answer.decisions);
    return true;
  }

  /** Holds a division over the limits for the original requester's choice; the Coordinator asks in the group (agent-dispatch::REQ-011/AC-02). */
  private async askOverLimit(job: DispatchJob, team: DispatchTeamView, held: NonNullable<DispatchJob["overLimit"]>): Promise<void> {
    job = this.job(job.id)!;
    // In plan order: the request's Assignments first, then the held ones, which are the only ones not yet started.
    const existing = this.assignments(job.id).filter(({ status }) => status !== "cancelled");
    const items = [...existing, ...held.assignments.map((planned) =>
      ({ teamId: planned.teamId, title: planned.title, profileName: team.profiles.find(({ id }) => id === planned.profileId)?.name ?? planned.profileId }))];
    const teams = new Set(items.map(({ teamId }) => teamId)).size;
    const limits = `超出上限（每件事务最多 ${ASSIGNMENT_LIMIT} 项分工、${TEAM_LIMIT} 个团队），`;
    const opening = existing.length
      ? `${team.leader.name} 按补充调整后的计划共有 ${items.length} 项分工、涉及 ${teams} 个团队，${limits}新增的分工尚未开始执行：`
      : `${team.leader.name} 的计划有 ${items.length} 项分工、涉及 ${teams} 个团队，${limits}尚未开始执行：`;
    const listed = items.map(({ profileName, title }, index) => `${index + 1}. ${profileName}：${title}`).slice(existing.length);
    const sam = this.options.agents.find(({ id }) => id === COORDINATOR_ID)!;
    const id = `${job.id}:over-limit:${job.attempt}`;
    const notice: Notice = { event: job.event, bindingHash: job.bindingHash, agentId: sam.id, senderAccountId: sam.senderAccountId, requestId: job.id,
      text: `${opening}\n${listed.join("\n")}\n请回复「按计划执行」「精简到上限内」（保留负责团队和第一个协作团队，按计划顺序最多 ${ASSIGNMENT_LIMIT} 项）或「取消这项事务」。` };
    // The question is queued with the wait, so a stop between the two cannot leave a request waiting on a question never posted.
    this.transaction(() => { job.overLimit = held; job.status = "waiting"; this.save(job); this.queueNotice(id, notice); });
    await this.deliverNotice(id, notice);
  }

  /** Applies the requester's choice on a held division: as proposed, or trimmed to the lead team, the first other team and five Assignments. */
  private applyChoice(job: DispatchJob, team: DispatchTeamView): void {
    const held = job.overLimit!;
    let kept: PlannedAssignment[] = held.assignments;
    if (held.choice === "trim") {
      const existing = this.assignments(job.id).filter(({ status }) => status !== "cancelled").map(({ teamId }) => ({ teamId, planned: undefined }));
      const trimmed = trimToLimits([...existing, ...held.assignments.map((planned) => ({ teamId: planned.teamId, planned }))], job.agentId);
      kept = trimmed.flatMap(({ planned }) => planned ? [planned] : []);
    }
    delete job.overLimit;
    this.addAssignments(job, team, kept, held.affected ?? [], held.decisions);
  }

  /**
   * Gives the current attempt its Assignments: `added` become new Assignments, each with its own Executor; the Assignments at
   * the 1-based `affected` positions rerun with their own Executors on the attempt's message, the supplement.
   */
  private addAssignments(job: DispatchJob, team: DispatchTeamView, added: readonly PlannedAssignment[], affected: readonly number[], decisions: readonly string[]): void {
    const input = inputOf(job.executionEvent ?? job.event);
    this.transaction(() => {
      const existing = this.assignments(job.id);
      for (const position of affected) {
        const assignment = existing[position - 1]!;
        assignment.attempt = job.attempt; assignment.status = "queued"; assignment.input = input; delete assignment.cause;
        this.saveAssignment(assignment);
      }
      for (const [index, planned] of added.entries()) {
        const profile = team.profiles.find(({ id }) => id === planned.profileId)!;
        const id = `${job.id}:assignment:${job.attempt}:${index + 1}`;
        const sequence = Number(this.database.prepare("INSERT INTO dispatch_assignment (id, request_id, payload) VALUES (?, ?, '{}')").run(id, job.id).lastInsertRowid);
        this.saveAssignment({ id, requestId: job.id, teamId: planned.teamId, profileId: profile.id, profileName: profile.name, executor: executorName(sequence), sequence,
          title: planned.title, brief: planned.brief, status: "queued", attempt: job.attempt, input });
      }
      const current = this.job(job.id)!;
      if (decisions.length) current.decisions = { attempt: job.attempt, texts: [...decisions] }; else delete current.decisions;
      delete current.overLimit;
      this.save(current);
    });
  }

  /** The Team Leader's team-internal decisions, each its own post after the start message; a failed post never stops the work. */
  private async postDecisions(job: DispatchJob): Promise<void> {
    if (job.decisions?.attempt !== job.attempt) return;
    for (const [index, text] of job.decisions.texts.entries()) {
      if (this.closing) return;
      await this.deliverNotice(`${job.id}:decision:${job.attempt}:${index}`, { ...this.notice(job, text), requestId: job.id });
    }
  }

  /** Runs one Assignment's Executor and records its end; a failure while other Assignments are unfinished is posted at once. */
  private async runAssignment(job: DispatchJob, assignment: DispatchAssignment, signal: AbortSignal): Promise<void> {
    let result: DispatchExecutionResult | undefined, failure: Extract<AssignmentFailure, { kind: "error" }> | undefined;
    try { result = await this.options.executor.run(structuredClone(job), structuredClone(assignment), signal); }
    catch (error) { failure = { kind: "error", error }; }
    // An Executor cut off by a stop is reported as interrupted at the next start.
    if (this.closing && (failure || result!.status === "cancelled")) return;
    const ended = this.assignment(assignment.id)!;
    const current = this.job(job.id)!;
    // A cancelled request's unfinished Assignments are stopped together, and named so in its report.
    if (signal.aborted && current.cancelRequested && result?.status !== "completed") return;
    if (failure) {
      ended.status = "failed"; ended.result = `${failureReason(failure.error)}`; ended.cause = failureCause(failure);
    } else {
      ended.status = result!.status; ended.result = result!.message;
      if (result!.status === "failed") ended.cause = failureCause({ kind: "reported", toolRefused: result!.cause === "tool_refused" });
    }
    if (result?.runRef) { ended.runRef = result.runRef; current.runRef = result.runRef; }
    // The post that reports this end is queued with it, so a stop between the two cannot leave the end unreported.
    let post: { id: string; notice: Notice } | undefined;
    if (!this.closing && !current.cancelRequested) {
      if (ended.status === "waiting") {
        // A pending choice goes out verbatim under the Team Leader's identity; its resolution ends the Assignment.
        const input = ended.input ?? current.executionEvent ?? current.event;
        const presentation = ended.runRef ? this.options.presentation(input, ended.runRef) : undefined;
        post = { id: `${job.id}:pending:${ended.id}:${ended.attempt}`, notice: { ...this.notice(current, ended.result!), ...(presentation ? { presentation } : {}), requestId: job.id } };
        current.reportId = post.id;
      } else if (ended.status === "failed" && this.assignments(job.id).some(({ id, status }) => id !== ended.id && UNFINISHED.includes(status))) {
        post = { id: `${job.id}:failure:${ended.id}:${ended.attempt}`, notice: { ...this.notice(current,
          `${executorLabel(ended)}的分工「${ended.title}」未能完成：${ended.cause}。其余分工继续处理。`), requestId: job.id } };
      }
    }
    this.transaction(() => { this.saveAssignment(ended); this.save(current); if (post) this.queueNotice(post.id, post.notice); });
    if (post) await this.deliverNotice(post.id, post.notice);
  }

  /** The Team Leader's closing turn; a failed turn falls back to the Assignments' own results, so no outcome goes unreported. */
  private async closeRequest(job: DispatchJob, team: DispatchTeamView, assignments: readonly DispatchAssignment[]): Promise<string> {
    try {
      return await this.options.leader.close(this.leaderInput(job, team),
        assignments.map(({ title, executor, status, result }) => ({ title, executor, status, result: result ?? "" })));
    } catch {
      return assignments.map((assignment) => `${assignment.executor}「${assignment.title}」${assignment.status === "completed" ? "已完成"
        : assignment.status === "cancelled" ? "已停止" : "未能完成"}。${assignment.result ?? ""}`).join("\n");
    }
  }

  /** The Team Leader's own record of an attempt: the Brief it received, its division and its closing (agent-dispatch::REQ-012/AC-02). */
  private async rememberDivision(job: DispatchJob, team: DispatchTeamView, assignments: readonly DispatchAssignment[], closing: string): Promise<void> {
    const brief = this.brief(job);
    try {
      await this.options.memory.capture(team.memoryScope, { event: job.executionEvent ?? job.event, senderAccountId: job.senderAccountId,
        userId: `${job.id}:leader:user:${job.attempt}`,
        userText: `请求：${brief.message}${brief.latest ? `\n最新要求：${brief.latest}` : ""}\n协调摘要：${brief.summary}`,
        assistantId: `${job.id}:leader:assistant:${job.attempt}`,
        assistantText: `分工：${assignments.map((assignment) => `${executorLabel(assignment)}${assignment.title}`).join("；")}\n收尾：${closing}` });
    } catch { this.failure("dispatch_leader_memory_failed"); }
  }

  /** The Team Leader's Brief: the original message, the latest confirmation or supplement when it differs, and the Coordinator's summary. */
  private brief(job: DispatchJob): LeaderTurnInput["brief"] {
    const latest = job.executionEvent && job.executionEvent.text !== job.event.text ? { latest: job.executionEvent.text } : {};
    return { message: job.event.text, ...latest, summary: job.summary };
  }

  private leaderInput(job: DispatchJob, team: DispatchTeamView): LeaderTurnInput {
    return { requestId: job.id, leader: team.leader, profiles: team.profiles, brief: this.brief(job),
      // The Team Leader's own memory in this conversation; never the group memory or an Executor's (agent-dispatch::REQ-012/AC-02).
      memory: this.options.memory.recall(team.memoryScope, job.event, job.executionEvent?.text ?? job.event.text),
      directory: this.options.roster(job.event).map(({ name, responsibility }) => ({ name, responsibility })),
      session: { accountId: job.event.accountId, target: job.event.target, bindingHash: job.bindingHash, revision: this.options.revision(),
        definitionsVersion: job.definitionsVersion! },
      fixtureMessageId: job.fixtureMessageId ?? job.executionEvent?.messageId ?? job.event.messageId };
  }

  /** The requester's cancellation of the whole request: every unfinished Assignment stops; completed effects are reported, not undone. */
  private cancel(job: DispatchJob): void {
    const stopped: DispatchAssignment[] = [];
    this.transaction(() => {
      for (const assignment of this.assignments(job.id)) {
        if (!UNFINISHED.includes(assignment.status)) continue;
        assignment.status = "cancelled"; this.saveAssignment(assignment); stopped.push(assignment);
      }
    });
    const assignments = this.assignments(job.id);
    const listed = (list: readonly DispatchAssignment[]) => list.map(({ executor, title }) => `${executor}「${title}」`).join("、");
    const done = assignments.filter(({ status }) => status === "completed");
    const parts = assignments.length > 1 ? [done.length ? `已完成：${listed(done)}` : "", stopped.length ? `已停止：${listed(stopped)}` : ""].filter(Boolean).join("；") : "";
    job.status = "cancelled"; job.supplements = []; delete job.overLimit;
    job.result = `已停止继续处理。${parts ? `${parts}。` : ""}${this.options.completedWork(job, assignments)}已经完成的操作不会自动撤销。`;
  }

  private hasAttemptAssignments(job: DispatchJob): boolean { return this.assignments(job.id).some(({ attempt }) => attempt === job.attempt); }
  private closingId(job: DispatchJob): string { return `${job.id}:closing:${job.attempt}`; }
  /** The requester's request whose Assignment, or whose earlier single Executor, started the workflow run. */
  private requestOfRun(runRef: string, event: InboundContent): DispatchJob | undefined {
    return this.jobs().find((job) => job.event.target === event.target && job.event.senderId === event.senderId &&
      (job.runRef === runRef || this.assignments(job.id).some((assignment) => assignment.runRef === runRef)));
  }

  private recordResult(job: DispatchJob, id = `${job.id}:result:${job.attempt}`, notice = this.notice(job, job.result!)): { id: string; notice: Notice } {
    job.reportId = id;
    // A finished attempt is captured into the group memory once its report is accepted. A cancelled or waiting request is not:
    // withdrawn work must leave no memory-derived reminder, and a waiting one is captured with its closing.
    const finished = job.status === "completed" || job.status === "partially_failed" || job.status === "failed";
    const attemptEvent = { ...(job.executionEvent ?? job.event) };
    delete attemptEvent.discussion;
    // A confirmation or a proposal's supplement extends the request's message; a later supplement replaces the attempt's
    // message, so the request's own message goes in front of it (agent-dispatch::REQ-012/AC-01).
    const text = attemptEvent.text.startsWith(job.event.text) ? attemptEvent.text : `${job.event.text}\n补充要求：${attemptEvent.text}`;
    const report = { id: job.reportId, notice: { ...notice, requestId: job.id, ...(finished ? { memory: { attempt: job.attempt, event: attemptEvent, text } } : {}) } };
    this.transaction(() => {
      this.queueNotice(report.id, report.notice);
      if (job.status === "completed" && job.supplements?.length) {
        job.executionEvent = job.supplements.shift()!; job.attempt++; job.status = "queued";
        delete job.retry; delete job.fixtureMessageId; delete job.runRef;
      }
      this.save(job);
    });
    return report;
  }
  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { action(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** A Coordinator post; `requestId` names the request it belongs to, if any. */
  private async coordinate(event: InboundContent, bindingHash: string, text: string, requestId?: string) {
    const sam = this.options.agents.find(({ id }) => id === COORDINATOR_ID)!;
    return this.deliverNotice(`${event.key}:coordination`, { event, bindingHash, agentId: sam.id, senderAccountId: sam.senderAccountId, text,
      ...(requestId ? { requestId } : {}) });
  }
  private notice(job: DispatchJob, text: string): Notice {
    return { event: job.event, bindingHash: job.bindingHash, agentId: job.agentId, senderAccountId: job.senderAccountId, text };
  }
  private markPresented(notice: Notice, acceptedAt: number): void {
    if (!notice.presentation) return;
    try { this.options.presented({ ...notice.presentation, acceptedAt }); }
    catch { this.failure("dispatch_presentation_record_failed"); }
  }
  private queueNotice(id: string, notice: Notice) {
    this.database.prepare("INSERT OR IGNORE INTO dispatch_notice(id, payload, state, request_id) VALUES (?, ?, 'queued', ?)").run(id, JSON.stringify(notice), notice.requestId ?? null);
  }
  /**
   * Captures a finished attempt into the group memory, through the Coordinator's scope: the request message with any
   * confirmation or supplement, and every post of the request accepted since its previous capture, in posting order.
   */
  private async rememberRequest(notice: Notice): Promise<void> {
    if (!notice.requestId || !notice.memory) return;
    const requestId = notice.requestId;
    // The delivery outcome is already recorded; a memory failure never changes it.
    try {
      const job = this.job(requestId);
      if (!job) return;
      let posts: string[] = [];
      this.transaction(() => {
        posts = this.database.prepare("SELECT payload FROM dispatch_notice WHERE request_id = ? AND state = 'accepted' AND captured IS NULL ORDER BY accepted_at, sequence")
          .all(requestId).map((row) => (JSON.parse(String(row.payload)) as Notice).text);
        this.database.prepare("UPDATE dispatch_notice SET captured = 1 WHERE request_id = ? AND state = 'accepted' AND captured IS NULL").run(requestId);
      });
      // The attempt's own message: a promoted supplement may already have replaced the request's current one.
      const { attempt, event, text } = notice.memory;
      await this.options.memory.capture(this.options.memoryScope, { event, senderAccountId: job.senderAccountId,
        userId: `${job.id}:user:${attempt}`, userText: text, assistantId: `${job.id}:assistant:${attempt}`, assistantText: posts.join("\n") });
    } catch { this.failure("dispatch_group_memory_failed"); }
  }
  private async deliverNotice(id: string, notice: Notice): Promise<SendTextResult> {
    this.queueNotice(id, notice);
    const row = this.database.prepare("SELECT id, payload, state, result FROM dispatch_notice WHERE id = ?").get(id) as NoticeRow;
    if (row.state !== "queued") return row.result ? JSON.parse(row.result) as SendTextResult : { ok: false, reason: "unknown", acceptedSegments: 0 };
    notice = JSON.parse(row.payload) as Notice;
    const eligible = () => this.eligible(notice.event, notice.bindingHash) &&
      this.options.agents.some((agent) => agent.id === notice.agentId && agent.senderAccountId === notice.senderAccountId);
    if (!eligible() || this.closing) {
      this.database.prepare("UPDATE dispatch_notice SET state = 'cancelled' WHERE id = ?").run(id);
      return { ok: false, reason: "unavailable", acceptedSegments: 0 };
    }
    this.database.prepare("UPDATE dispatch_notice SET state = 'sending' WHERE id = ?").run(id);
    let result: SendTextResult;
    try { result = await this.options.delivery({ accountId: notice.event.accountId, target: notice.event.target,
      senderAccountId: notice.senderAccountId, message: notice.text, operationId: `dispatch:${id}`, beforeSubmit: eligible }); }
    catch { result = { ok: false, reason: "unknown", acceptedSegments: 0 }; }
    const state = result.ok ? "accepted" : result.reason === "unknown" || (result.acceptedSegments ?? 0) > 0 ? "unknown" : "rejected";
    const acceptedAt = result.ok ? Date.now() : null;
    this.database.prepare("UPDATE dispatch_notice SET state = ?, result = ?, accepted_at = ? WHERE id = ?").run(state, JSON.stringify(result), acceptedAt, id);
    if (acceptedAt !== null) { this.markPresented(notice, acceptedAt); await this.rememberRequest(notice); }
    return result;
  }
  private assignments(requestId: string): DispatchAssignment[] {
    return this.database.prepare("SELECT payload FROM dispatch_assignment WHERE request_id = ? ORDER BY sequence").all(requestId).map((row) => JSON.parse(String(row.payload)) as DispatchAssignment);
  }
  private assignment(id: string): DispatchAssignment | undefined {
    const row = this.database.prepare("SELECT payload FROM dispatch_assignment WHERE id = ?").get(id); return row ? JSON.parse(String(row.payload)) as DispatchAssignment : undefined;
  }
  private saveAssignment(assignment: DispatchAssignment) { this.database.prepare("UPDATE dispatch_assignment SET payload = ? WHERE id = ?").run(JSON.stringify(assignment), assignment.id); }
  private jobs(): DispatchJob[] { return this.database.prepare("SELECT payload FROM dispatch_job ORDER BY rowid").all().map((row) => JSON.parse(String(row.payload)) as DispatchJob); }
  private job(id: string): DispatchJob | undefined { const row = this.database.prepare("SELECT payload FROM dispatch_job WHERE id = ?").get(id); return row ? JSON.parse(String(row.payload)) as DispatchJob : undefined; }
  private save(job: DispatchJob) { this.database.prepare("INSERT INTO dispatch_job VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(job.id, JSON.stringify(job)); }
  private finishInput(id: string) { this.database.prepare("UPDATE dispatch_input SET state = 'completed' WHERE id = ?").run(id); }
  private eligible(event: InboundContent, bindingHash: string): boolean { return this.options.authorized(event) && this.options.bindingHash(event) === bindingHash; }
  private failure(code: string) { try { this.options.report(code); } catch { /* Diagnostics cannot change task outcomes. */ } }
}

function failureReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "dispatch_authorization_changed") return "权限或可用上下文发生变化，本次处理已停止。";
  if (code === "dispatch_model_unavailable") return "当前模型不可用，本次未能继续处理。";
  if (code === "dispatch_team_unavailable") return "负责团队当前不可用，本次未能继续处理。";
  if (code.startsWith("main_reply_")) return "模型未返回有效的结果报告，本次处理已停止。";
  return "执行连接中断或处理出错，本次未能完成。";
}
