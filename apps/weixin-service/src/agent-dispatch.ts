import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundContent, SendTextResult } from "./channel-contract.js";
import type { CrossTeamDecision, DispatchAgent, DispatchAssignment, DispatchClassifier, DispatchDelivery, DispatchExecutionResult, DispatchExecutor, DispatchJob,
  DispatchPart, DispatchPendingResult, PrerequisiteResult } from "./agent-dispatch-types.js";
import { parseCrossTeamDecision, parseDispatchDecision } from "./agent-dispatch-classifier.js";
import { LeaderOutputError, type LeaderHelp, type LeaderPlanAssignment, type LeaderRelay, type LeaderSessionKey, type LeaderTurnInput, type TeamLeader } from "./agent-dispatch-leader.js";
import { COORDINATOR_ID, DEFAULT_EXECUTOR_NOUN } from "./team-registry.js";
import { SkillsNotLoaded } from "./agent-dispatch-executor.js";
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
/**
 * A team as a request's definitions version has it. A profile's noun names its Executors (`<noun> <n>`); without one they are 执行者.
 * Its capabilities say, in plain words, what an Executor created from it can do when the view is taken.
 */
export type DispatchTeamView = Readonly<{ leader: LeaderTurnInput["leader"];
  profiles: ReadonlyArray<Readonly<{ id: string; name: string; noun?: string; capabilities: readonly string[] }>>; memoryScope: AgentMemoryScope }>;
/**
 * One group post of a request and its delivery: `queued` or `sending` until the platform answers, then `accepted`, `rejected` or
 * `unknown`; `cancelled` when it was never sent. `acceptedAt` is set only for an accepted post.
 */
export type DispatchPost = Readonly<{ id: string; agentId: string; text: string; state: "queued" | "sending" | "accepted" | "rejected" | "unknown" | "cancelled"; acceptedAt: number | null }>;
/** A stored request as the console's records read it. */
export type DispatchRecord = Readonly<{ job: DispatchJob; assignments: readonly DispatchAssignment[]; posts: readonly DispatchPost[] }>;
/** One turn captured into an agent's memory; `event` names the conversation and is the source of the user entry. */
export type DispatchMemoryTurn = Readonly<{ event: InboundContent; senderAccountId: string; userId: string; userText: string; assistantId: string; assistantText: string }>;
type AssignmentStatus = DispatchAssignment["status"];
const ENDED: readonly AssignmentStatus[] = ["completed", "failed", "cancelled", "interrupted", "blocked"];
const UNFINISHED: readonly AssignmentStatus[] = ["queued", "running", "waiting"];
const INTERRUPTED = "服务中断，本次处理已停止。";
const UNDETERMINED = "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。";
/**
 * The Coordinator's reply to a control of a request that is no longer active, to an answer to a cancelled request's choice, and to
 * an answer to a superseded choice of a request that has ended.
 */
const REQUEST_ENDED = "这项请求已经结束或无法继续，请说明新的需求。";
/** The Coordinator's reply to an answer to a choice that a supplement superseded, while the request goes on with the supplement. */
const CHOICE_SUPERSEDED = "这次选择已被你的补充取代，不再生效；这项请求会按补充后的要求继续处理。";

/** Whether the request still goes on: it is queued, running or waiting, and its requester has not cancelled it. */
const goesOn = (job: Pick<DispatchJob, "status" | "cancelRequested">) => !job.cancelRequested && ["queued", "running", "waiting"].includes(job.status);

/**
 * What a host reports for a message its workflow handled while a choice of the requester was open, from the handling's outcome
 * and reply and from the choice's run afterwards. A choice the message left open still waits, whatever the outcome: unless the
 * workflow asked again itself, the requester is asked to answer that choice (agent-dispatch Implementation Decisions: Executor).
 */
export function pendingChoiceResult(handled: Readonly<{ outcome: "succeeded" | "needs_input" | "failed"; reply: string }>,
  run: Readonly<{ cancelled: boolean; open: boolean }>): Pick<DispatchExecutionResult, "status" | "message"> {
  if (run.cancelled) return { status: "cancelled", message: handled.reply };
  if (handled.outcome === "needs_input") return { status: "waiting", message: handled.reply };
  if (run.open) return { status: "waiting", message: "这条选择对应的选项已经结束；这项请求仍在等你选择，请按最新提示回复。" };
  return { status: handled.outcome === "succeeded" ? "completed" : "failed", message: handled.reply };
}

/**
 * How an unfinished request involves a team: how many of its own Assignments are queued or running, how many of its own wait for the
 * requester, and the titles of the Assignments it waits with, or null when it waits with none.
 */
export type TeamInvolvement = Readonly<{ active: number; awaitingRequester: number; waitingFor: readonly string[] | null }>;
/** A request, or a group post still to be sent, that keeps a team's removal from its group pending (team-management::US-004). */
export type TeamWork = TeamInvolvement & Readonly<{ requestId: string; summary: string; accountId: string; target: string; requester: string }>;
/**
 * Whether an unfinished request still involves `teamId`, and how (team-management::US-004/AC-02, AC-04). The lead team is
 * involved until the request ends, because it closes it. Another team is involved from the attempt that gives it work until its
 * Team Leader has closed its Assignments in that attempt. A proposal has no Assignment and involves no team. The lead waits
 * with every waiting Assignment of the request, another team only with its own.
 */
export function teamInvolvement(job: Pick<DispatchJob, "agentId" | "status" | "attempt" | "reports">,
  assignments: ReadonlyArray<Pick<DispatchAssignment, "teamId" | "status" | "attempt" | "title">>, teamId: string): TeamInvolvement | undefined {
  if (job.status !== "queued" && job.status !== "running" && job.status !== "waiting") return undefined;
  const lead = job.agentId === teamId;
  const own = assignments.filter((assignment) => assignment.teamId === teamId);
  if (!lead) {
    if (!own.some(({ attempt }) => attempt === job.attempt)) return undefined;
    if (!own.some(({ status }) => UNFINISHED.includes(status)) && job.reports?.[teamId]?.attempt === job.attempt) return undefined;
  }
  const waiting = (lead ? assignments : own).filter(({ status }) => status === "waiting");
  return { active: own.filter(({ status }) => status === "queued" || status === "running").length,
    awaitingRequester: own.filter(({ status }) => status === "waiting").length,
    waitingFor: waiting.length ? waiting.map(({ title }) => title) : null };
}

/** How an Assignment failed, as far as the host knows it. */
export type AssignmentFailure = Readonly<{ kind: "reported"; toolRefused: boolean }> | Readonly<{ kind: "error"; error: unknown }> | Readonly<{ kind: "shutdown" }>;
/** The host-known cause a failure post names; the Executor's own text reaches the group only through its Team Leader's closing. */
export function failureCause(failure: AssignmentFailure): string {
  if (failure.kind === "reported") return failure.toolRefused ? "有工具调用被拒绝" : "执行者报告无法完成";
  if (failure.kind === "shutdown") return "服务中断";
  if (failure.error instanceof SkillsNotLoaded) return notLoaded(failure.error);
  const code = failure.error instanceof Error ? failure.error.message : "";
  if (code.includes("无进展超时")) return "执行超时";
  if (code === "dispatch_model_unavailable" || code === "dispatch_group_unbound") return "运行环境不可用";
  if (code === "dispatch_authorization_changed" || code === "dispatch_role_invalid") return "权限或可用上下文发生变化";
  if (code.startsWith("main_reply_")) return "执行者未返回有效的结果报告";
  return "执行连接中断或处理出错";
}
/**
 * A request's outcome once none of its Assignments is unfinished (agent-dispatch::REQ-008/AC-01); cancelled ones do not count,
 * and one not started because a prerequisite failed counts as not completed. A failure outranks a part no team took, which a
 * retry may help as well; with every Assignment completed, a part no team took leaves the request partially unassigned
 * (agent-dispatch::REQ-013/AC-05).
 */
export function requestOutcome(statuses: readonly AssignmentStatus[], untaken = false): "completed" | "partially_failed" | "partially_unassigned" | "failed" | "cancelled" {
  const counted = statuses.filter((status) => status !== "cancelled");
  if (!counted.length) return "cancelled";
  if (counted.every((status) => status === "completed")) return untaken ? "partially_unassigned" : "completed";
  return counted.includes("completed") ? "partially_failed" : "failed";
}
/** The closing's line for the parts no team took; after a retry asked again, they still have none (agent-dispatch::REQ-013/AC-02). */
function untakenLine(parts: readonly DispatchPart[]): string {
  const untaken = parts.filter(({ teamId }) => teamId === null);
  if (!untaken.length) return "";
  return `${untaken.map(({ title }) => title).join("、")}${untaken.some(({ asked }) => (asked ?? 1) > 1) ? "仍" : ""}没有团队承接，本次未处理；有团队可以承接后，可以明确要求重试。`;
}
/** The positions, in `view`, of an Assignment's prerequisites. */
function dependencyPositions(view: readonly DispatchAssignment[], assignment: DispatchAssignment): number[] {
  return view.flatMap(({ id }, index) => (assignment.dependsOn ?? []).includes(id) ? [index + 1] : []);
}
/** A Team Leader's `view` as a supplement turn shows it, numbered from 1. */
const shown = (view: readonly DispatchAssignment[]) => view.map((assignment, index) =>
  ({ position: index + 1, executor: assignment.executor, profileName: assignment.profileName, title: assignment.title, status: assignment.status,
    dependsOn: dependencyPositions(view, assignment) }));
/** A Team Leader's `view` as its closing turn sees it, numbered from 1. */
const reports = (view: readonly DispatchAssignment[]) => view.map((assignment, index) => ({ position: index + 1, title: assignment.title,
  executor: assignment.executor, status: assignment.status, result: assignment.result ?? "", dependsOn: dependencyPositions(view, assignment) }));
/**
 * An Assignment a Team Leader's turn planned, not yet stored. `after` holds what it depends on: an Assignment the Team Leader
 * was shown, by ID, or an earlier Assignment of the same turn.
 */
type PlannedAssignment = Omit<LeaderPlanAssignment, "dependsOn"> & { teamId: string; after: ReadonlyArray<string | PlannedAssignment> };
/**
 * A turn's Assignments for `teamId`, their `dependsOn` positions resolved: the first `view.length` positions number the
 * Assignments the Team Leader was shown, the rest the turn's own, so a dependency never reaches another team's Assignment.
 */
function toPlanned(assignments: readonly LeaderPlanAssignment[], teamId: string, view: readonly DispatchAssignment[] = []): PlannedAssignment[] {
  const items: PlannedAssignment[] = [];
  for (const { dependsOn, ...assignment } of assignments) {
    items.push({ ...assignment, teamId, after: dependsOn.map((position) => position <= view.length ? view[position - 1]!.id : items[position - view.length - 1]!) });
  }
  return items;
}
/** An Executor's name, from its durable sequence. */
/** An Executor's name in the group: its profile's noun, or 执行者 for a profile without one, and its number. */
function executorName(profile: Readonly<{ noun?: string }>, sequence: number): string { return `${profile.noun || DEFAULT_EXECUTOR_NOUN} ${sequence}`; }
const executorLabel = (assignment: DispatchAssignment) => `${assignment.executor}（${assignment.profileName}）`;
/** The positions, as the Team Leader is shown them, of the Assignments `ids` names, joined for a group post. */
function positionsText(view: readonly DispatchAssignment[], ids: readonly string[]): string {
  return view.flatMap(({ id }, index) => ids.includes(id) ? [String(index + 1)] : []).join("、");
}
/**
 * A Team Leader's start message: which Executor handles each Assignment that starts (agent-dispatch::US-003/AC-01), and for the
 * lead, one line per part the Coordinator placed with another team. Several items go one per line, as every group post with
 * several items does. An Assignment that waits for others names the positions, in its Team Leader's `view`, of its prerequisites
 * not yet completed; it gets no post of its own when it starts later. A cross-team Team Leader's last line says where its
 * results go (agent-dispatch::REQ-013/AC-04).
 */
function startMessage(starting: readonly DispatchAssignment[], view: readonly DispatchAssignment[], help?: Readonly<{ parts: readonly string[]; coordinator: string }>,
  last = "完成后会在本群汇报。"): string {
  const parts = help?.parts ?? [];
  const items = [...starting.map((assignment) => {
    const waits = (assignment.dependsOn ?? []).filter((id) => view.find((other) => other.id === id)?.status !== "completed");
    return `${executorLabel(assignment)}处理：${assignment.title}${waits.length ? `（等 ${positionsText(view, waits)} 完成后开始）` : ""}`;
  }), ...parts.map((part) => `${part}需要其他团队支持，已请 ${help!.coordinator} 协调。`)];
  return items.length === 1 && !parts.length ? `我安排${items[0]}。${last}` : `我安排：\n${items.join("\n")}\n${last}`;
}
/** The Coordinator's announcement of the parts it placed: which team takes which part, at whose request (agent-dispatch::US-003/AC-04). */
function crossTeamAnnouncement(coordinator: string, lead: string, placed: ReadonlyArray<{ part: string; leader: string }>): string {
  const ending = `完成后经 ${coordinator} 交回 ${lead} 汇总。`;
  return placed.length === 1 ? `应 ${lead} 请求，${placed[0]!.part}交给 ${placed[0]!.leader} 队；${ending}`
    : `应 ${lead} 请求：\n${placed.map(({ part, leader }) => `${part}交给 ${leader} 队`).join("\n")}\n${ending}`;
}
/**
 * The Coordinator's sentence for a rejected lead start message: it names the lead's team and nothing of the request or the team's
 * work. Like the lead's own report it speaks of the attempt (本次), because an earlier attempt of the request may have done work.
 */
function receiptRejected(lead: string): string {
  return `${lead} 队的接单通知未能发出，本次尚未开始处理。请检查 ${lead} 是否可在本群发言后明确重试。`;
}
/** Each of a Team Leader's Assignments, `view`, with its own result, one per line: the closing when its closing turn fails. */
function resultLines(view: readonly DispatchAssignment[]): string[] {
  return view.map((assignment) => assignment.status === "blocked" ? `${assignment.executor}「${assignment.title}」${assignment.result ?? ""}`
    : `${assignment.executor}「${assignment.title}」${assignment.status === "completed" ? "已完成" : assignment.status === "cancelled" ? "已停止" : "未能完成"}。${assignment.result ?? ""}`);
}
/** With Assignments not started, the fallback closing's last line gives the order a retry follows, in positions of `view`. */
function retryLine(view: readonly DispatchAssignment[]): string[] {
  const ids = (statuses: readonly AssignmentStatus[]) => view.filter(({ status }) => statuses.includes(status)).map(({ id }) => id);
  const redone = ids(["failed", "interrupted"]), started = ids(["blocked"]);
  return redone.length && started.length ? [`需要时请明确要求重试，会先重做第 ${positionsText(view, redone)} 项，再开始第 ${positionsText(view, started)} 项。`] : [];
}
/** Bounds on the prerequisite results a dependent Executor receives: each, and all of them together, in characters. */
export const PREREQUISITE_RESULT_LIMIT = 4_000;
export const PREREQUISITE_RESULTS_LIMIT = 12_000;
const TRUNCATED = "…（结果过长，以下已截断）";
/** Bounds a dependent's prerequisite results: each to its own limit, then all together, in plan order, with a truncation mark. */
export function boundedPrerequisites(prerequisites: readonly PrerequisiteResult[]): PrerequisiteResult[] {
  let remaining = PREREQUISITE_RESULTS_LIMIT;
  return prerequisites.map((prerequisite) => {
    const kept = Math.min(prerequisite.result.length, PREREQUISITE_RESULT_LIMIT, remaining);
    remaining -= kept;
    return { ...prerequisite, result: kept < prerequisite.result.length ? `${prerequisite.result.slice(0, kept)}${TRUNCATED}` : prerequisite.result };
  });
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
  /**
   * The groups whose messages are being taken in: from the start of a pass over a group's queued messages until that pass has
   * asked about replaced choices and found none. Meanwhile only that pass changes a waiting request of the group.
   */
  private readonly taking = new Set<string>();
  private readonly workers = new Map<string, { operation: Promise<void>; abort: AbortController }>();
  /** Cross-team closings in progress, by request, team and attempt, so concurrent ends close a team's part once. */
  private readonly closingTeams = new Set<string>();

  constructor(databasePath: string, private readonly options: {
    /**
     * The Coordinator and every Team Leader with a sending application, as the current definitions have them. Read on each
     * use, so a team saved or onboarded while the service runs is routed to, mentioned and posts without a restart.
     */
    agents(): readonly DispatchAgent[];
    classifier: DispatchClassifier;
    leader: TeamLeader;
    executor: DispatchExecutor;
    /** The current team definitions version, recorded on a request when it is first planned. */
    definitionsVersion(): number;
    /** A team as its request's definitions version defines it, or undefined when that version has no such team. */
    team(teamId: string, definitionsVersion: number): DispatchTeamView | undefined;
    /** The IDs of every team a definitions version defines. */
    teams(definitionsVersion: number): readonly string[];
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
    /**
     * Has the host take a message that an open choice of its requester may be waiting for. `held` names a run whose choice takes no
     * answer any more. The host asks it before it acts on the message: for such a run it resumes, cancels and replaces nothing, and
     * reports a message addressed to that choice as held.
     */
    pending?(event: InboundContent, held: (runRef: string) => boolean): Promise<DispatchPendingResult>;
    /** Called when work that may have involved a team has ended: after startup, the queued messages of a conversation, a request's worker and a cross-team closing. */
    workChanged?(): void;
    /**
     * Closes every choice the request's Executors left open, so that no later answer resumes work its requester cancelled or
     * superseded with a supplement. `assignments` are the request's own; a request stored before Assignments existed has none.
     */
    closeChoices?(job: DispatchJob, assignments: readonly DispatchAssignment[]): Promise<void>;
    /**
     * Whether the choice of `runRef` was closed because a newer workflow of its requester in the group replaced it. Such a choice
     * takes no answer any more, and nothing tells the dispatch when it happens.
     */
    choiceReplaced?(runRef: string): boolean;
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
    // Every request is recovered before anything is awaited, so no message is taken in while one is still as the stop left it.
    const cancelled: DispatchJob[] = [];
    for (const job of this.jobs()) if (job.status === "running" && this.recover(job)) cancelled.push(job);
    // A choice replaced before the stop, or while the service was stopped; its post goes out with the queued ones below.
    this.endReplaced();
    for (const job of cancelled) await this.closeChoices(job);
    for (const row of this.database.prepare("SELECT id, payload FROM dispatch_notice WHERE state = 'queued' ORDER BY sequence").all()) {
      await this.deliverNotice(String(row.id), JSON.parse(String(row.payload)) as Notice);
    }
    this.changed();
    this.kick();
  }

  getState() {
    return { jobs: this.jobs().map(({ id, agentId, senderAccountId, summary, status, result, attempt, runRef, event, definitionsVersion, parts }) =>
      ({ id, agentId, senderAccountId, summary, status, result, attempt, runRef, accountId: event.accountId, target: event.target, requester: event.senderId,
        definitionsVersion: definitionsVersion ?? null,
        assignments: this.assignments(id).map(({ id: assignmentId, teamId, profileId, executor, title, status: state, attempt: run, dependsOn }) =>
          ({ id: assignmentId, teamId, profileId, executor, title, status: state, attempt: run, dependsOn: dependsOn ?? [] })),
        parts: (parts ?? []).map((part) => ({ title: part.title, teamId: part.teamId, attempt: part.attempt })) })),
    notices: this.database.prepare("SELECT id, state FROM dispatch_notice ORDER BY sequence").all() };
  }

  /**
   * Every stored request with its Assignments and its group posts, in posting order, for the console's records
   * (agent-console Implementation Decisions: read projections). It only reads; the console's view is never any agent's input.
   */
  records(): DispatchRecord[] {
    const byRequest = new Map<string, DispatchPost[]>();
    for (const row of this.database.prepare("SELECT id, payload, state, accepted_at, request_id FROM dispatch_notice WHERE request_id IS NOT NULL ORDER BY sequence").all()) {
      const notice = JSON.parse(String(row.payload)) as Notice;
      const list = byRequest.get(String(row.request_id)) ?? [];
      list.push({ id: String(row.id), agentId: notice.agentId, text: notice.text, state: String(row.state) as DispatchPost["state"],
        acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at) });
      byRequest.set(String(row.request_id), list);
    }
    return this.jobs().map((job) => ({ job, assignments: this.assignments(job.id), posts: byRequest.get(job.id) ?? [] }));
  }

  /**
   * What still involves `teamId`, one entry per request: each unfinished request under `teamInvolvement`, and each request with
   * a group post under the team's identity that is recorded but not yet sent. The second keeps a team's identity until its last
   * closing has gone out: a post is cancelled once its sender left the definitions.
   */
  involving(teamId: string): TeamWork[] {
    const work = new Map<string, TeamWork>();
    for (const job of this.jobs()) {
      const involvement = teamInvolvement(job, this.assignments(job.id), teamId);
      if (involvement) work.set(job.id, { requestId: job.id, summary: job.summary, accountId: job.event.accountId, target: job.event.target, requester: job.event.senderId ?? "", ...involvement });
    }
    for (const row of this.database.prepare("SELECT id, payload, request_id FROM dispatch_notice WHERE state IN ('queued', 'sending') ORDER BY sequence").all()) {
      const notice = JSON.parse(String(row.payload)) as Notice;
      const requestId = String(row.request_id ?? row.id);
      if (notice.agentId !== teamId || work.has(requestId)) continue;
      work.set(requestId, { requestId, summary: this.job(requestId)?.summary ?? "", accountId: notice.event.accountId, target: notice.event.target,
        requester: notice.event.senderId ?? "", active: 0, awaitingRequester: 0, waitingFor: null });
    }
    return [...work.values()];
  }

  /**
   * The Team Leader sessions a stored request can still use; their runtime homes stay whole (agent-dispatch::QR-003/AC-02). A
   * request counts while it is queued, running or waiting, or when its definitions version is the current one, whose sessions
   * later requests resume. It counts for every team of its version, in its conversation and binding: a later plan, supplement
   * or retry may place a part with any of them. Every session is keyed by the current access revision, the one a turn uses.
   * A request that never ran has no definitions version and no session.
   */
  leaderSessions(): LeaderSessionKey[] {
    const revision = this.options.revision(), current = this.options.definitionsVersion();
    const conversations = new Map<string, LeaderTurnInput["session"]>();
    for (const { event: { accountId, target }, bindingHash, definitionsVersion, status } of this.jobs()) {
      if (definitionsVersion === undefined || (definitionsVersion !== current && !["queued", "running", "waiting"].includes(status))) continue;
      conversations.set(JSON.stringify([accountId, target, bindingHash, definitionsVersion]), { accountId, target, bindingHash, revision, definitionsVersion });
    }
    return [...conversations.values()].flatMap((session) => this.options.teams(session.definitionsVersion).map((leaderId) => ({ leaderId, ...session })));
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
   * Returns whether the request was cancelled, so that its choices are closed once every request is recovered.
   */
  private recover(job: DispatchJob): boolean {
    if (job.definitionsVersion === undefined) {
      // Requests stored before Assignments existed keep the handling they were stored under.
      job.status = "failed"; job.result = `服务中断，本次处理已停止。${this.options.completedWork(job, [])}已有操作不会自动重复；请核对结果后明确重试。`;
      this.recordResult(job);
      return false;
    }
    if (job.cancelRequested) {
      this.cancel(job);
      this.recordResult(job, this.hasAttemptAssignments(job) ? this.closingId(job) : undefined);
      return true;
    }
    this.transaction(() => {
      for (const assignment of this.assignments(job.id)) {
        if (assignment.status !== "running") continue;
        assignment.status = "interrupted"; assignment.result = INTERRUPTED; assignment.cause = failureCause({ kind: "shutdown" });
        this.saveAssignment(assignment);
        // Each post goes out under the Team Leader of the Assignment's own team (agent-dispatch::REQ-013/AC-04).
        this.queueNotice(`${job.id}:interrupted:${assignment.id}:${assignment.attempt}`, { ...this.teamNotice(job, assignment.teamId,
          `服务中断，${executorLabel(assignment)}的分工「${assignment.title}」已中断，无法确认已完成的内容，不会自动重放。`), requestId: job.id });
      }
      this.blockDependents(job.id);
      job.status = "queued"; this.save(job);
    });
    return false;
  }

  private kick(): void {
    if (!this.started || this.closing) return;
    for (const row of this.database.prepare("SELECT DISTINCT target FROM dispatch_input WHERE state = 'queued'").all()) {
      const target = String(row.target);
      if (this.intake.has(target)) continue;
      const operation = this.processInputs(target).catch(() => this.failure("dispatch_intake_failed"))
        .finally(() => { this.intake.delete(target); this.taking.delete(target); this.changed(); });
      this.intake.set(target, operation);
    }
    for (const job of this.jobs()) {
      if (job.status !== "queued" || [...this.workers.keys()].some((id) => {
        const active = this.job(id); return active?.event.target === job.event.target && active.agentId === job.agentId;
      })) continue;
      const abort = new AbortController();
      const operation = this.execute(job, abort.signal).catch(() => this.failure("dispatch_execution_record_failed"))
        .finally(() => { this.workers.delete(job.id); this.changed(); this.kick(); });
      this.workers.set(job.id, { operation, abort });
    }
  }

  private async processInputs(target: string): Promise<void> {
    this.taking.add(target);
    // The run of a choice that the message just dealt with replaced by a new goal.
    let goal: { runRef: string; event: InboundContent } | undefined;
    while (!this.closing) {
      // The Assignment that waited on that choice ends now, if it still waits: the message may itself have been a supplement or a
      // cancel of its request, which found the request waiting, as it was. Nothing is posted for it.
      if (goal) { this.endReplacedByGoal(goal.runRef, goal.event); goal = undefined; }
      const row = this.database.prepare("SELECT * FROM dispatch_input WHERE target = ? AND state = 'queued' ORDER BY sequence LIMIT 1").get(target);
      if (!row) {
        // The group's messages are dealt with. Replaced choices are asked about now, also for the Executors that ended meanwhile,
        // and the group is free again in the step that finds none.
        const posts = this.endReplaced(target);
        if (!posts.length) { this.taking.delete(target); return; }
        await this.tellReplaced(posts);
        continue;
      }
      const event = JSON.parse(String(row.payload)) as InboundContent, bindingHash = String(row.binding_hash);
      if (!this.eligible(event, bindingHash)) { this.finishInput(event.key); continue; }
      this.database.prepare("UPDATE dispatch_input SET state = 'classifying' WHERE id = ?").run(event.key);
      // Only teams accepting work in this group can be routed to or named; a mention of another team confers no priority.
      const accepting = new Set(this.options.roster(event).map(({ id }) => id));
      let agents = this.options.agents().filter(({ id }) => id === COORDINATOR_ID || accepting.has(id));
      let mentioned = event.mentionedAgentIds?.filter((id) => agents.some((agent) => agent.id === id));
      if ((mentioned?.length ?? 0) > 1) {
        await this.coordinate(event, bindingHash, "你点名了多个 Agent。这项事务希望由谁独立负责？");
        this.finishInput(event.key); continue;
      }
      const offer = () => ({ event: mentioned ? { ...event, mentionedAgentIds: mentioned } : event, agents: agents.map(({ id, name, responsibility }) => ({ id, name, responsibility })) });
      let input = { ...offer(),
        requests: this.jobs().filter((job) => job.event.target === event.target && job.event.senderId === event.senderId)
          .slice(-20).map(({ id, agentId, summary, status }) => ({ id, agentId, summary, status })),
        memory: this.options.memory.recall(this.options.memoryScope, event, event.text) };
      try {
        const pending = await this.options.pending?.(event, (runRef) => this.heldRequest(runRef, event) !== undefined);
        if (pending && !pending.handled && pending.cancelledRunRef && !this.heldRequest(pending.cancelledRunRef, event)) {
          // The requester's new goal replaced an open choice, and the message itself goes on to the Coordinator. A request stored
          // before Assignments existed waits on its own run, and is cancelled with it. For any other, only the Assignment that
          // waited on the choice ends, once this message is dealt with.
          const superseded = this.requestOfRun(pending.cancelledRunRef, event);
          if (superseded && !this.assignments(superseded.id).length) { superseded.status = "cancelled"; this.save(superseded); }
          else goal = { runRef: pending.cancelledRunRef, event };
        }
        if (pending?.handled) {
          const held = pending.runRef ? this.heldRequest(pending.runRef, event) : undefined;
          if (held || "held" in pending) {
            // An answer to a choice that a supplement superseded, or to one of a request that is cancelled or being cancelled, changes
            // nothing in the request or its Assignments and starts nothing, whatever the host made of it. The choice is closed again,
            // and the requester is told once, in a post of its own.
            if (held) await this.closeChoices(held);
            await this.coordinate(event, bindingHash, held !== undefined && goesOn(held) ? CHOICE_SUPERSEDED : REQUEST_ENDED);
            this.finishInput(event.key); continue;
          }
          const agent = this.options.agents().find((item) => pending.senderAccountId ? item.senderAccountId === pending.senderAccountId : item.id === COORDINATOR_ID);
          if (!agent) throw new Error("dispatch_pending_sender_unavailable");
          const original = pending.runRef ? this.requestOfRun(pending.runRef, event) : undefined;
          // An answer settles the Assignment that keeps the choice's run. One that asked back without a workflow run keeps none: it
          // is settled only by the reply to its own question, which the Coordinator takes as a supplement.
          const waiting = original && this.assignments(original.id).find((assignment) => assignment.status === "waiting" && assignment.runRef === pending.runRef);
          const several = original !== undefined && this.assignments(original.id).length > 1;
          const notice = { event, bindingHash, agentId: agent.id, senderAccountId: agent.senderAccountId, text: pending.result.message };
          if (original && waiting && (pending.result.status === "completed" || pending.result.status === "failed" || (several && pending.result.status === "cancelled"))) {
            // The resolved choice ends its Assignment; the Team Leader closes the request once nothing else is unfinished.
            waiting.status = pending.result.status; waiting.result = pending.result.message;
            if (original.status === "waiting") original.status = "queued";
            const reply = pending.result.status === "cancelled" ? { ...notice, requestId: original.id } : undefined;
            this.transaction(() => {
              this.saveAssignment(waiting); this.blockDependents(original.id); this.save(original);
              if (reply) this.queueNotice(`${event.key}:pending`, reply);
            });
            if (reply) await this.deliverNotice(`${event.key}:pending`, reply);
            this.finishInput(event.key); this.kick(); continue;
          }
          const presentation = pending.result.status === "waiting" && pending.runRef ? this.options.presentation(event, pending.runRef) : undefined;
          const shown = { ...notice, ...(presentation ? { presentation } : {}) };
          if (original) {
            // A request with Assignments takes its status from them. A choice that is asked again leaves its Assignment waiting, and
            // the request running while another of them runs, so that a cancel still stops that one's Executor and the request's
            // worker reports it once. An answer to a choice whose Assignment no longer waits on it changes no Assignment, and so no
            // status. A cancelled choice of the request's only Assignment cancels both. Only a request stored before Assignments
            // existed takes the answer's status.
            if (waiting && pending.result.status === "cancelled") {
              waiting.status = "cancelled"; waiting.result = pending.result.message; this.saveAssignment(waiting); original.status = "cancelled";
            } else if (!this.assignments(original.id).length) original.status = pending.result.status;
            original.result = pending.result.message;
            this.recordResult(original, `${event.key}:pending`, shown);
          } else this.queueNotice(`${event.key}:pending`, shown);
          await this.deliverNotice(`${event.key}:pending`, shown);
          this.finishInput(event.key); this.kick(); continue;
        }
        let decision = parseDispatchDecision(await this.options.classifier.classify(input), input);
        // A team that stopped accepting work in the group while the message was being classified is offered no longer, and a
        // mention of it confers no priority: the message is classified again among the teams still accepting, as one arriving
        // now would be (agent-dispatch::REQ-015/AC-01). The offer only shrinks, so this ends.
        while (!this.closing && this.eligible(event, bindingHash)) {
          const still = new Set(this.options.roster(event).map(({ id }) => id));
          if (agents.every(({ id }) => id === COORDINATOR_ID || still.has(id))) break;
          agents = agents.filter(({ id }) => id === COORDINATOR_ID || still.has(id));
          mentioned = mentioned?.filter((id) => agents.some((agent) => agent.id === id));
          input = { ...input, ...offer() };
          decision = parseDispatchDecision(await this.options.classifier.classify(input), input);
        }
        if (!this.eligible(event, bindingHash) || this.closing) { this.finishInput(event.key); continue; }
        if (decision.kind === "dispatch" || decision.kind === "propose") {
          const agent = agents.find((candidate) => candidate.id === decision.agentId)!;
          const named = agents.find(({ id }) => id === mentioned?.[0]);
          if (decision.kind === "dispatch" && named && named.id !== COORDINATOR_ID && named.id !== agent.id) {
            const coordinator = this.options.agents().find(({ id }) => id === COORDINATOR_ID)!;
            const explanation = decision.message || `这项需求属于 ${agent.name} 的职责。我请 ${coordinator.name} 重新分派，由他独立处理。`;
            // The request's ID is its message key, so these posts belong to the request saved below.
            const informed = await this.deliverNotice(`${event.key}:scope`, { event, bindingHash, agentId: named.id, senderAccountId: named.senderAccountId, text: explanation, requestId: event.key });
            if (!informed.ok) { this.finishInput(event.key); continue; }
            // The explanation took time. A team that stopped accepting work in the group meanwhile takes no request: the
            // Coordinator announces no reassignment and asks what is wanted instead.
            const left = () => !this.options.roster(event).some(({ id }) => id === agent.id);
            if (left()) { await this.coordinate(event, bindingHash, UNDETERMINED); this.finishInput(event.key); continue; }
            const reassigned = await this.coordinate(event, bindingHash, `已将这项需求转派给 ${agent.name}。`, event.key);
            if (!reassigned.ok) { this.finishInput(event.key); continue; }
            // So did that notice, the Coordinator's one reply to this message: for a team that left during it, the
            // Coordinator asks in a post of its own.
            if (left()) {
              await this.deliverNotice(`${event.key}:scope:unavailable`, { event, bindingHash, agentId: coordinator.id, senderAccountId: coordinator.senderAccountId, text: UNDETERMINED });
              this.finishInput(event.key); continue;
            }
          }
          if (!this.job(event.key)) this.save({ id: event.key, event, bindingHash, agentId: agent.id, senderAccountId: agent.senderAccountId,
            summary: decision.summary, status: decision.kind === "propose" ? "proposed" : "queued", attempt: 0 });
          if (decision.kind === "propose") await this.coordinate(event, bindingHash,
            `要不要请 ${agent.name} 帮你${decision.summary}？请回复这条建议确认，或告诉我暂时不用。`, event.key);
        } else if (decision.kind === "confirm" || decision.kind === "decline") {
          const job = this.job(decision.requestId!);
          // A proposal is confirmed only for a team that still accepts work in the group; declining it needs no team.
          const available = decision.kind === "decline" || (job !== undefined && this.options.roster(job.event).some(({ id }) => id === job.agentId));
          if (!job || job.status !== "proposed" || job.event.senderId !== event.senderId || job.event.target !== event.target || !this.eligible(job.event, job.bindingHash) || !available) {
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
              !["queued", "running", "waiting", "proposed"].includes(job.status) || (decision.kind === "supplement" && this.onlyClosing(job))) {
            await this.coordinate(event, bindingHash, REQUEST_ENDED);
          } else if (decision.kind === "cancel") {
            job.cancelRequested = true; job.supplements = [];
            if (job.status === "running" && this.workers.has(job.id)) {
              this.save(job); this.workers.get(job.id)!.abort.abort();
              // A choice that is already open is closed now; one an Executor raises while it stops is closed when that Executor ends.
              await this.closeChoices(job);
            } else {
              // A waiting request has no worker and nothing starts one, so nothing else changes it while its choice is closed. The choice
              // is closed before the cancel is recorded: a stop between the two leaves a request that takes the cancel again, not a
              // cancelled one whose choice is open. Any other request here can be started at any moment, so its cancel is recorded first.
              const waiting = job.status === "waiting";
              if (waiting) await this.closeChoices(job);
              this.cancel(job);
              const report = this.recordResult(job, `${event.key}:cancelled`);
              if (!waiting) await this.closeChoices(job);
              await this.deliverNotice(report.id, report.notice);
            }
          } else {
            if ((job.supplements?.length ?? 0) >= 20) await this.coordinate(event, bindingHash, "这项请求已有多条补充待处理，请等当前处理结束后再补充。");
            else if (job.status === "running" || job.status === "queued") { (job.supplements ??= []).push(event); this.save(job); }
            else if (job.status === "proposed") {
              job.summary = decision.summary || job.summary;
              job.executionEvent = { ...event, text: `${(job.executionEvent ?? job.event).text}\n补充要求：${event.text}` }; this.save(job);
              await this.coordinate(event, bindingHash, "已补充到建议中。请确认是否开始处理。", job.id);
            } else {
              // A request waiting for a choice: the supplement supersedes the waiting Assignments and its Team Leader decides what it affects.
              // Their choices are closed first, so that no answer to one resumes work the supplement replaced; like a waiting request's
              // cancel, nothing else changes the request meanwhile, and a stop in between leaves the supplement to be taken in again.
              await this.closeChoices(job);
              this.transaction(() => {
                // The superseded runs stay with the request: a choice that could not be closed is still open, and its Assignment
                // may get a run of its own when it reruns for the supplement. A waiting Assignment was superseded on the run it
                // keeps, and on none if it keeps none: the request's run may then be another Assignment's, which goes on. Only a
                // request stored before Assignments existed waits on its own run.
                const assignments = this.assignments(job.id), superseded = new Set(job.supersededRuns);
                const waitedOn = assignments.length ? assignments.filter(({ status }) => status === "waiting").map(({ runRef }) => runRef) : [job.runRef];
                for (const runRef of waitedOn) if (runRef) superseded.add(runRef);
                for (const assignment of assignments) if (assignment.status === "waiting") { assignment.status = "cancelled"; this.saveAssignment(assignment); }
                this.blockDependents(job.id);
                if (superseded.size) job.supersededRuns = [...superseded];
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
          } else if ((job.status === "failed" || job.status === "partially_failed" || job.status === "partially_unassigned") && !this.retryable(job)) {
            await this.coordinate(event, bindingHash, "无法继续这项请求，请说明需要处理的事务。");
          } else if (job.status === "failed" || job.status === "partially_failed" || job.status === "partially_unassigned") {
            // A retry reruns the failed and interrupted Assignments of every team, each with its Executor, and then the dependents
            // they left not started, in dependency order, and asks the Coordinator again for the parts no team took. A request that
            // failed before its Team Leader divided it, or before it answered a supplement, is planned or answered again.
            const divided = job.dividedAttempt === job.attempt || job.reaskAttempt === job.attempt;
            job.status = "queued"; job.attempt++; job.retry = true; job.fixtureMessageId = event.messageId;
            if (divided) job.reaskAttempt = job.attempt; else delete job.reaskAttempt;
            this.transaction(() => {
              for (const assignment of this.assignments(job.id)) {
                if (assignment.status !== "failed" && assignment.status !== "interrupted" && assignment.status !== "blocked") continue;
                assignment.attempt = job.attempt; assignment.status = "queued"; delete assignment.cause; this.saveAssignment(assignment);
              }
              // A dependent whose prerequisite was cancelled stays not started.
              this.blockDependents(job.id);
              this.save(job);
            });
          } else await this.coordinate(event, bindingHash, "这项请求没有可重试的失败处理；已完成的操作不会重新执行。");
        } else if (decision.kind !== "ignore") {
          await this.coordinate(event, bindingHash, decision.message || "你指的是哪件事，希望得到什么结果？确认后我会交给合适的 Agent。");
        }
      } catch {
        if (!this.closing && this.eligible(event, bindingHash)) await this.coordinate(event, bindingHash, UNDETERMINED);
      }
      this.finishInput(event.key);
      this.kick();
    }
  }

  /**
   * Whether a retry of the request may run: its lead team, which plans or answers again and closes it, and every team whose
   * Assignment the retry would rerun must still accept work in the request's group. A team that stopped accepting work there
   * is draining or was removed, and takes no work back (agent-dispatch::REQ-015/AC-01, team-management::US-004/AC-01).
   */
  private retryable(job: DispatchJob): boolean {
    const accepting = new Set(this.options.roster(job.event).map(({ id }) => id));
    return [job.agentId, ...this.assignments(job.id).filter(({ status }) => status === "failed" || status === "interrupted" || status === "blocked").map(({ teamId }) => teamId)]
      .every((id) => accepting.has(id));
  }

  private async execute(job: DispatchJob, signal: AbortSignal): Promise<void> {
    if (!this.eligible(job.event, job.bindingHash)) { job.status = "cancelled"; this.save(job); return; }
    job.status = "running"; job.definitionsVersion ??= this.options.definitionsVersion(); this.save(job);
    let closing: string | undefined;
    try {
      const team = this.options.team(job.agentId, job.definitionsVersion);
      if (!team) throw new Error("dispatch_team_unavailable");
      await this.divide(job, team, signal);
      job = this.job(job.id)!;
      const starting = this.assignments(job.id).filter(({ attempt, status }) => attempt === job.attempt && status === "queued");
      if (starting.length) {
        await this.announce(job, starting, signal);
        const ready = this.markReady(job);
        await this.postDecisions(job);
        await this.runReady(job, ready, signal);
      }
      // A stopped service reports the Assignments it cut off at its next start.
      if (this.closing) return;
      job = this.job(job.id)!;
      const assignments = this.assignments(job.id);
      if (!job.cancelRequested) {
        if (assignments.some(({ status }) => status === "waiting")) { job.status = "waiting"; this.save(job); return; }
        // A cross-team part cut off before its closing, by a restart or a pending choice, closes before the request does.
        for (const teamId of new Set(assignments.map(({ teamId: id }) => id))) if (teamId !== job.agentId) await this.closeTeam(job.id, teamId);
        if (this.closing) return;
        job = this.job(job.id)!;
        const own = this.leaderView(job.id, job.agentId);
        closing = await this.closeRequest(job, team, own);
        await this.rememberDivision(job, team, own, closing);
        job = this.job(job.id)!;
        const parts = job.parts ?? [];
        job.status = requestOutcome(assignments.map(({ status }) => status), parts.some(({ teamId }) => teamId === null));
        const untaken = untakenLine(parts);
        job.result = closing + (job.status === "completed" ? "" : this.options.completedWork(job, assignments)) + (untaken ? `\n${untaken}` : "");
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
   * Gives the attempt its Assignments: a new request's plan or a promoted supplement's answer, with the cross-team parts the
   * Coordinator placed and their teams' plans. Every turn ends before anything is stored, so a division that a ceiling or an
   * invalid plan refuses leaves no Assignment and no Executor (agent-dispatch::REQ-011/AC-02, REQ-008/AC-05).
   */
  private async divide(job: DispatchJob, team: DispatchTeamView, signal: AbortSignal): Promise<void> {
    const assignments = this.assignments(job.id);
    const views = new Map([[job.agentId, team]]);
    if (assignments.length && (job.reaskAttempt === job.attempt || assignments.some(({ attempt }) => attempt === job.attempt))) {
      if (job.reaskAttempt === job.attempt) await this.reask(job, assignments.length, views, signal);
      return;
    }
    // A team that stopped accepting work in this group since admission gets no new Assignment there (agent-dispatch::REQ-015/AC-01).
    const accepting = (teamId: string) => { if (!this.options.roster(job.event).some(({ id }) => id === teamId)) throw new Error("dispatch_team_unavailable"); };
    const cancelled = () => { if (signal.aborted) throw new Error("dispatch_cancelled"); };
    if (!assignments.length) {
      accepting(job.agentId);
      const plan = await this.options.leader.plan(this.leaderInput(job, team), 0);
      cancelled();
      // The request holds its lead's removal, but a lead that stopped accepting work during its plan turn, or while the parts it
      // asked for were placed, gets no new Assignment either.
      accepting(job.agentId);
      const added = toPlanned(plan.assignments, job.agentId);
      const placed = await this.place(job, plan.help, added.length, views, signal);
      accepting(job.agentId);
      this.addAssignments(job, views, { added: [...added, ...placed.added], affected: [], decisions: { texts: plan.decisions, byTeam: placed.decisions },
        parts: placed.parts, needs: placed.needs });
      return;
    }
    // A promoted supplement: the lead decides which of its own Assignments and requested parts it affects; the Coordinator
    // relays it to the Team Leader of each affected part, who decides for its own Assignments (agent-dispatch::REQ-007/AC-04).
    const text = (job.executionEvent ?? job.event).text;
    const own = this.leaderView(job.id, job.agentId);
    const answer = await this.options.leader.supplement(this.leaderInput(job, team, this.leadRelay(job)), shown(own), text, assignments.length);
    cancelled();
    const added = toPlanned(answer.assignments, job.agentId, own);
    if (added.length) accepting(job.agentId);
    const affected = answer.affected.map((position) => own[position - 1]!.id);
    const byTeam: Record<string, string[]> = {}, needs: NonNullable<DispatchJob["needs"]> = [];
    const relayed = [...new Set(answer.parts.map((position) => job.parts![position - 1]!.teamId).filter((id): id is string => id !== null))];
    for (const teamId of relayed) {
      const view = this.options.team(teamId, job.definitionsVersion!);
      if (!view) throw new Error("dispatch_team_unavailable");
      // A team that stopped accepting work in the group answers no supplement, and the answer of one that stopped during its
      // turn is not used, whether it adds Assignments or only reruns some: the attempt fails, and so does a retry of it.
      accepting(teamId);
      const theirs = this.leaderView(job.id, teamId);
      const reply = await this.options.leader.supplement(this.leaderInput(job, view, this.crossRelay(job, teamId)), shown(theirs), text, assignments.length + added.length);
      cancelled();
      accepting(teamId);
      affected.push(...reply.affected.map((position) => theirs[position - 1]!.id));
      added.push(...toPlanned(reply.assignments, teamId, theirs));
      byTeam[teamId] = reply.decisions;
      needs.push(...reply.help.map((help) => ({ teamId, ...help })));
      views.set(teamId, view);
    }
    const placed = await this.place(job, answer.help, assignments.length + added.length, views, signal);
    // A relayed team's Assignments are of an earlier attempt until this division is stored, so they did not hold its removal
    // through the turns that followed its own.
    for (const teamId of relayed) accepting(teamId);
    // Nor does the lead get the Assignments its answer adds, if it stopped accepting work during those turns.
    if (answer.assignments.length) accepting(job.agentId);
    for (const [teamId, texts] of Object.entries(placed.decisions)) byTeam[teamId] = [...(byTeam[teamId] ?? []), ...texts];
    this.addAssignments(job, views, { added: [...added, ...placed.added], affected, decisions: { texts: answer.decisions, byTeam },
      parts: [...(job.parts ?? []), ...placed.parts], needs: [...(job.needs ?? []), ...needs, ...placed.needs] });
  }

  /**
   * Places the parts the lead asked other teams to take (agent-dispatch::REQ-013/AC-02): the Coordinator chooses among the
   * teams accepting work in the group, and each chosen team's Team Leader plans its part. `planned` counts the request's
   * Assignments so far, for the ceiling. A part the Coordinator places with no team, or whose decision is invalid, or whose team
   * stops accepting work in the group before its plan is returned, is not taken.
   * A cross-team Team Leader's own help requests are not placed; they are kept as needs for the lead (agent-dispatch::REQ-013/AC-01).
   */
  private async place(job: DispatchJob, help: readonly LeaderHelp[], planned: number, views: Map<string, DispatchTeamView>, signal: AbortSignal) {
    const placed = { added: [] as PlannedAssignment[], decisions: {} as Record<string, string[]>, parts: [] as DispatchPart[], needs: [] as NonNullable<DispatchJob["needs"]> };
    if (!help.length) return placed;
    const offered = this.offeredTeams(job);
    let decisions: CrossTeamDecision[] = help.map((_part, index) => ({ part: index + 1, agentId: null, summary: "" }));
    if (offered.length) {
      const lead = this.options.agents().find(({ id }) => id === job.agentId)!, brief = this.brief(job);
      const input = { requestId: job.id, coordinator: this.coordinator().name, message: brief.latest ? `${brief.message}\n最新要求：${brief.latest}` : brief.message,
        summary: job.summary, lead: { id: lead.id, name: lead.name, responsibility: lead.responsibility }, parts: help.map((part, index) => ({ part: index + 1, ...part })),
        teams: offered.map(({ id, name, responsibility }) => ({ id, name, responsibility })), fixtureMessageId: this.fixtureMessageId(job) };
      try {
        // The host checks the decision itself, whatever produced it (agent-dispatch::REQ-008/AC-05).
        decisions = parseCrossTeamDecision({ assignments: await this.options.classifier.assign(input) }, input);
      } catch (error) {
        if (this.closing) throw error;
        this.failure("dispatch_cross_team_decision_failed");
      }
      if (signal.aborted) throw new Error("dispatch_cancelled");
    }
    placed.parts = help.map((part, index) => ({ ...part, attempt: job.attempt, teamId: decisions[index]!.agentId, summary: decisions[index]!.summary }));
    const chosen = [...new Set(placed.parts.map(({ teamId: id }) => id).filter((id): id is string => id !== null))];
    // Until its plan is stored, a chosen team has no Assignment of the request, and nothing holds its removal from the group.
    const accepts = (teamId: string) => this.options.roster(job.event).some(({ id }) => id === teamId);
    const left = new Set<string>();
    for (const teamId of chosen) {
      // One that stopped accepting work there since it was offered plans nothing, and has left even if it accepts work again later.
      if (!accepts(teamId)) { left.add(teamId); continue; }
      const view = this.options.team(teamId, job.definitionsVersion!)!;
      const plan = await this.options.leader.plan(this.leaderInput(job, view, this.crossRelay(job, teamId, placed.parts)), planned + placed.added.length);
      if (signal.aborted) throw new Error("dispatch_cancelled");
      placed.added.push(...toPlanned(plan.assignments, teamId));
      placed.decisions[teamId] = plan.decisions;
      placed.needs.push(...plan.help.map((need) => ({ teamId, ...need })));
      views.set(teamId, view);
    }
    // One that stopped during a plan turn, its own or a later team's, has its plan dropped. Either way its parts are not taken.
    for (const teamId of chosen) if (!accepts(teamId)) left.add(teamId);
    if (!left.size) return placed;
    for (const teamId of left) delete placed.decisions[teamId];
    return { ...placed, added: placed.added.filter(({ teamId }) => !left.has(teamId)), needs: placed.needs.filter(({ teamId }) => !left.has(teamId)),
      parts: placed.parts.map((part) => part.teamId !== null && left.has(part.teamId) ? { ...part, teamId: null, summary: "" } : part) };
  }

  /**
   * An explicit retry asks the Coordinator again for every part no team took, since a team may accept it now; a part placed
   * now is planned by its team's Team Leader (agent-dispatch::REQ-013/AC-02). Each part is asked once per attempt.
   */
  private async reask(job: DispatchJob, planned: number, views: Map<string, DispatchTeamView>, signal: AbortSignal): Promise<void> {
    const untaken = (job.parts ?? []).flatMap((part, index) => part.teamId === null && part.attempt < job.attempt ? [index] : []);
    if (!untaken.length) return;
    const placed = await this.place(job, untaken.map((index) => ({ title: job.parts![index]!.title, brief: job.parts![index]!.brief })), planned, views, signal);
    const parts = [...job.parts!];
    for (const [position, index] of untaken.entries()) parts[index] = { ...placed.parts[position]!, asked: (parts[index]!.asked ?? 1) + 1 };
    this.addAssignments(job, views, { added: placed.added, affected: [], decisions: { texts: [], byTeam: placed.decisions }, parts, needs: [...(job.needs ?? []), ...placed.needs] });
  }

  /**
   * The teams a part may be placed with: those accepting work in the group, under the current roster, that the request's
   * definitions version knows; never the lead or the Coordinator (agent-dispatch::REQ-015/AC-01, REQ-017).
   */
  private offeredTeams(job: DispatchJob): DispatchAgent[] {
    const roster = new Set(this.options.roster(job.event).map(({ id }) => id));
    return this.options.agents().filter(({ id }) => id !== COORDINATOR_ID && id !== job.agentId && roster.has(id) && this.options.team(id, job.definitionsVersion!) !== undefined);
  }

  /**
   * Stores a division as the attempt's Assignments: `added` become new Assignments, each with its own Executor from its team's
   * presets; the `affected` Assignments, and the Assignments downstream of them, rerun with their own Executors on the attempt's
   * message, the supplement (agent-dispatch::REQ-007/AC-04).
   */
  private addAssignments(job: DispatchJob, views: ReadonlyMap<string, DispatchTeamView>, division: Readonly<{ added: readonly PlannedAssignment[]; affected: readonly string[];
    decisions: NonNullable<DispatchJob["decisions"]> extends infer D ? Omit<D, "attempt"> : never; parts: DispatchPart[]; needs: NonNullable<DispatchJob["needs"]> }>): void {
    const input = inputOf(job.executionEvent ?? job.event);
    this.transaction(() => {
      // The affected Assignments rerun, and so does every Assignment downstream of them that was not cancelled, so it works from
      // their new results; a cancelled one stays cancelled, because the requester stopped it, and nothing reruns through it.
      const existing = this.assignments(job.id), rerun = new Set(division.affected);
      for (let grown = true; grown;) {
        grown = false;
        for (const assignment of existing) {
          if (rerun.has(assignment.id) || assignment.status === "cancelled" || !(assignment.dependsOn ?? []).some((id) => rerun.has(id))) continue;
          rerun.add(assignment.id); grown = true;
        }
      }
      for (const assignment of existing) {
        if (!rerun.has(assignment.id)) continue;
        assignment.attempt = job.attempt; assignment.status = "queued"; assignment.input = input; delete assignment.cause;
        this.saveAssignment(assignment);
      }
      const ids = new Map<PlannedAssignment, string>();
      for (const [index, planned] of division.added.entries()) {
        const profile = views.get(planned.teamId)!.profiles.find(({ id }) => id === planned.profileId)!;
        const id = `${job.id}:assignment:${job.attempt}:${index + 1}`;
        const sequence = Number(this.database.prepare("INSERT INTO dispatch_assignment (id, request_id, payload) VALUES (?, ?, '{}')").run(id, job.id).lastInsertRowid);
        this.saveAssignment({ id, requestId: job.id, teamId: planned.teamId, profileId: profile.id, profileName: profile.name, executor: executorName(profile, sequence), sequence,
          title: planned.title, brief: planned.brief, status: "queued", attempt: job.attempt, input,
          ...(planned.after.length ? { dependsOn: planned.after.map((after) => typeof after === "string" ? after : ids.get(after)!) } : {}) });
        ids.set(planned, id);
      }
      const current = this.job(job.id)!;
      const { texts } = division.decisions, byTeam = Object.fromEntries(Object.entries(division.decisions.byTeam ?? {}).filter(([, list]) => list.length));
      if (texts.length || Object.keys(byTeam).length) current.decisions = { attempt: job.attempt, texts: [...texts], ...(Object.keys(byTeam).length ? { byTeam } : {}) };
      else delete current.decisions;
      if (division.parts.length) current.parts = division.parts;
      if (division.needs.length) current.needs = division.needs;
      // A cross-team Team Leader's application is frozen when its team first takes a part.
      for (const { teamId } of division.added) {
        if (teamId === job.agentId || current.senders?.[teamId]) continue;
        const sender = this.options.agents().find(({ id }) => id === teamId)?.senderAccountId;
        if (sender) (current.senders ??= {})[teamId] = sender;
      }
      current.dividedAttempt = job.attempt;
      this.save(current);
    });
  }

  /**
   * The start posts of an attempt, each confirmed before any Executor starts: the lead's, naming the parts the Coordinator
   * placed this attempt; the Coordinator's announcement of those parts, whose delivery holds nothing up; then each cross-team
   * Team Leader's (agent-dispatch::US-003/AC-01, US-003/AC-04, REQ-013/AC-04).
   */
  private async announce(job: DispatchJob, starting: readonly DispatchAssignment[], signal: AbortSignal): Promise<void> {
    const coordinator = this.coordinator().name, lead = this.agentName(job.agentId);
    const placed = (job.parts ?? []).filter(({ attempt, teamId }) => attempt === job.attempt && teamId !== null);
    const own = starting.filter(({ teamId }) => teamId === job.agentId);
    if (own.length) {
      const receipt = `${job.id}:receipt:${job.attempt}`;
      const start = await this.deliverNotice(receipt, { ...this.notice(job,
        startMessage(own, this.leaderView(job.id, job.agentId), placed.length ? { parts: placed.map(({ title }) => title), coordinator } : undefined)), requestId: job.id });
      if (!start.ok) {
        await this.reportRejectedReceipt(job, receipt, lead);
        throw new Error("dispatch_receipt_unavailable");
      }
    }
    if (placed.length) {
      await this.deliverNotice(`${job.id}:cross-team:${job.attempt}`, { ...this.coordinatorNotice(job,
        crossTeamAnnouncement(coordinator, lead, placed.map(({ title, teamId }) => ({ part: title, leader: this.agentName(teamId!) })))), requestId: job.id });
    }
    for (const teamId of [...new Set(starting.map(({ teamId: id }) => id))].filter((id) => id !== job.agentId)) {
      const start = await this.deliverNotice(`${job.id}:receipt:${job.attempt}:${teamId}`, { ...this.teamNotice(job, teamId,
        startMessage(starting.filter((assignment) => assignment.teamId === teamId), this.leaderView(job.id, teamId), undefined, `完成后经 ${coordinator} 交回 ${lead} 汇总。`)),
        requestId: job.id });
      if (!start.ok) throw new Error("dispatch_receipt_unavailable");
    }
    if (signal.aborted) throw new Error("dispatch_cancelled");
  }

  /**
   * The one post another identity makes for a team (agent-dispatch::REQ-008/AC-04): when the lead's start message is recorded as
   * rejected, its failure report would go through the same application, so the Coordinator tells the request's group that the
   * attempt has not started. An uncertain start message may have arrived, and one never submitted did not fail at the platform,
   * so neither gets the sentence. It is stored once per attempt, with its own delivery state. A stopping service stores nothing,
   * because a post stored then is cancelled: the next start finds the rejected start message again and posts the sentence. A
   * request whose cancel was taken in meanwhile gets none: it ends cancelled, and the retry the sentence suggests would be refused.
   */
  private async reportRejectedReceipt(job: DispatchJob, receipt: string, lead: string): Promise<void> {
    if (this.closing || this.job(job.id)?.cancelRequested) return;
    if (this.database.prepare("SELECT state FROM dispatch_notice WHERE id = ?").get(receipt)?.state !== "rejected") return;
    await this.deliverNotice(`${job.id}:receipt-rejected:${job.attempt}`, { ...this.coordinatorNotice(job, receiptRejected(lead)), requestId: job.id });
  }

  /** Each Team Leader's team-internal decisions, each its own post after the start posts; a failed post never stops the work. */
  private async postDecisions(job: DispatchJob): Promise<void> {
    if (job.decisions?.attempt !== job.attempt) return;
    for (const [index, text] of job.decisions.texts.entries()) {
      if (this.closing) return;
      await this.deliverNotice(`${job.id}:decision:${job.attempt}:${index}`, { ...this.notice(job, text), requestId: job.id });
    }
    for (const [teamId, texts] of Object.entries(job.decisions.byTeam ?? {})) {
      for (const [index, text] of texts.entries()) {
        if (this.closing) return;
        await this.deliverNotice(`${job.id}:decision:${job.attempt}:${teamId}:${index}`, { ...this.teamNotice(job, teamId, text), requestId: job.id });
      }
    }
  }

  /**
   * Marks running, in one step, every queued Assignment of the attempt whose prerequisites have all completed, and returns them.
   * Dependents waiting for a prerequisite take no pool slot.
   */
  private markReady(job: DispatchJob): DispatchAssignment[] {
    const ready: DispatchAssignment[] = [];
    this.transaction(() => {
      this.blockDependents(job.id);
      const assignments = this.assignments(job.id);
      for (const assignment of assignments) {
        if (assignment.attempt !== job.attempt || assignment.status !== "queued" ||
          !(assignment.dependsOn ?? []).every((id) => assignments.find((other) => other.id === id)?.status === "completed")) continue;
        assignment.status = "running"; this.saveAssignment(assignment); ready.push(assignment);
      }
    });
    return ready;
  }

  /**
   * Runs the attempt's Assignments: independent ones at once, each dependent once all its prerequisites have completed. No
   * post goes out when a waiting Assignment starts. A cancel or stop starts nothing further.
   */
  private async runReady(job: DispatchJob, first: readonly DispatchAssignment[], signal: AbortSignal): Promise<void> {
    const running = new Map<string, Promise<void>>();
    const launch = (assignments: readonly DispatchAssignment[]) => {
      for (const assignment of assignments) running.set(assignment.id, this.runAssignment(job, assignment, signal).finally(() => { running.delete(assignment.id); }));
    };
    launch(first);
    while (running.size) {
      await Promise.race(running.values());
      if (!this.closing && !signal.aborted && !this.job(job.id)?.cancelRequested) launch(this.markReady(job));
    }
  }

  /**
   * Leaves not started, transitively, every queued Assignment with a prerequisite that ended without completing (failed,
   * interrupted, cancelled while the request goes on, or itself not started). Callers run it in the transaction that records the end.
   */
  private blockDependents(requestId: string): void {
    const assignments = this.assignments(requestId);
    const view = (teamId: string) => assignments.filter((assignment) => assignment.teamId === teamId);
    const unmet = (assignment: DispatchAssignment) => (assignment.dependsOn ?? []).filter((id) => {
      const status = assignments.find((other) => other.id === id)?.status;
      return status !== undefined && status !== "completed" && ENDED.includes(status);
    });
    for (let grown = true; grown;) {
      grown = false;
      for (const assignment of assignments) {
        const failed = assignment.status === "queued" ? unmet(assignment) : [];
        if (!failed.length) continue;
        assignment.status = "blocked"; assignment.result = `未开始：它等待的第 ${positionsText(view(assignment.teamId), failed)} 项未能完成。`; delete assignment.cause;
        this.saveAssignment(assignment); grown = true;
      }
    }
  }

  /** The final results of an Assignment's prerequisites, bounded, as its Executor receives them. */
  private prerequisitesOf(assignment: DispatchAssignment): PrerequisiteResult[] {
    const view = this.leaderView(assignment.requestId, assignment.teamId);
    return boundedPrerequisites(view.flatMap((prerequisite, index) => (assignment.dependsOn ?? []).includes(prerequisite.id)
      ? [{ position: index + 1, title: prerequisite.title, executor: prerequisite.executor, result: prerequisite.result ?? "" }] : []));
  }

  /** Runs one Assignment's Executor and records its end; a failure while other Assignments are unfinished is posted at once. */
  private async runAssignment(job: DispatchJob, assignment: DispatchAssignment, signal: AbortSignal): Promise<void> {
    let result: DispatchExecutionResult | undefined, failure: Extract<AssignmentFailure, { kind: "error" }> | undefined;
    try { result = await this.options.executor.run(structuredClone(job), structuredClone(assignment), signal, this.prerequisitesOf(assignment)); }
    catch (error) { failure = { kind: "error", error }; }
    // An Executor cut off by a stop is reported as interrupted at the next start.
    if (this.closing && (failure || result!.status === "cancelled")) return;
    // Its workflow may have replaced an open choice of its requester in the group. While the group's messages are being taken
    // in, that is left to the intake, which asks once they are dealt with.
    const replaced = this.taking.has(job.event.target) ? [] : this.endReplaced(job.event.target);
    const ended = this.assignment(assignment.id)!;
    const current = this.job(job.id)!;
    // A cancelled request's unfinished Assignments are stopped together, and named so in its report.
    if (signal.aborted && current.cancelRequested && result?.status !== "completed") {
      // A choice it raised while it stopped is the request's, so its run is kept and the choice is closed at once: nothing waits for its answer.
      if (result?.status === "waiting" && result.runRef) { ended.runRef = result.runRef; this.saveAssignment(ended); await this.closeChoices(current); }
      await this.tellReplaced(replaced);
      return;
    }
    if (failure) {
      ended.status = "failed"; ended.result = `${failureReason(failure.error)}`; ended.cause = failureCause(failure);
    } else {
      ended.status = result!.status; ended.result = result!.message;
      if (result!.status === "failed") ended.cause = failureCause({ kind: "reported", toolRefused: result!.cause === "tool_refused" });
    }
    if (result?.runRef) { ended.runRef = result.runRef; current.runRef = result.runRef; }
    // An Assignment keeps the run of its Executor's latest result, and none when that result names none: a run of an earlier
    // attempt is not the one it waits on.
    else if (result) delete ended.runRef;
    // The post that reports this end is queued with it, so a stop between the two cannot leave the end unreported.
    let post: { id: string; notice: Notice } | undefined;
    const reporting = !this.closing && !current.cancelRequested;
    if (reporting && ended.status === "waiting" && ended.runRef !== undefined && this.choiceReplaced(ended.runRef)) {
      // Its own choice was replaced before it ended, by a workflow that started after its own or by its requester's new goal,
      // which found no Assignment waiting on the run yet. The prompt takes no answer, so it is not posted, and the Assignment
      // ends as for any replaced choice.
      ended.status = "cancelled"; delete ended.result; post = this.replacedPost(current, ended);
    }
    if (reporting && ended.status === "waiting") {
      // A pending choice goes out verbatim under the Team Leader's identity; its resolution ends the Assignment.
      const input = ended.input ?? current.executionEvent ?? current.event;
      const presentation = ended.runRef ? this.options.presentation(input, ended.runRef) : undefined;
      post = { id: `${job.id}:pending:${ended.id}:${ended.attempt}`, notice: { ...this.teamNotice(current, ended.teamId, ended.result!), ...(presentation ? { presentation } : {}),
        requestId: job.id } };
      current.reportId = post.id;
    }
    this.transaction(() => {
      this.saveAssignment(ended);
      // Its dependents are left not started in the same step; a failure that leaves nothing else unfinished is named by the closing.
      this.blockDependents(job.id);
      if (reporting && ended.status === "failed" && this.assignments(job.id).some(({ id, status }) => id !== ended.id && UNFINISHED.includes(status))) {
        post = { id: `${job.id}:failure:${ended.id}:${ended.attempt}`, notice: { ...this.teamNotice(current, ended.teamId,
          `${executorLabel(ended)}的分工「${ended.title}」未能完成：${ended.cause}。其余分工继续处理。`), requestId: job.id } };
      }
      this.save(current); if (post) this.queueNotice(post.id, post.notice);
    });
    // The requester is told of a replaced choice before this Executor's own post, which may be the prompt that replaced it. If
    // the service is asked to stop meanwhile, that post stays queued for the next start, where one sent now would be cancelled.
    await this.tellReplaced(replaced);
    if (post && !this.closing) await this.deliverNotice(post.id, post.notice);
    // A failed closing here must not end the attempt while other Executors run: the request's own close tries it again.
    if (!this.closing && !current.cancelRequested && ended.teamId !== current.agentId) {
      await this.closeTeam(job.id, ended.teamId).catch(() => this.failure("dispatch_team_closing_failed"));
    }
  }

  /**
   * A cross-team Team Leader's closing, once all of its team's Assignments in the attempt have ended (agent-dispatch::US-003/AC-02):
   * posted under its identity, and kept as its report, which the Coordinator relays to the lead (agent-dispatch::REQ-013/AC-03).
   * If its closing turn fails, each Assignment's own result takes its place.
   */
  private async closeTeam(requestId: string, teamId: string): Promise<void> {
    let job = this.job(requestId)!;
    const own = this.leaderView(requestId, teamId);
    const key = `${requestId}:${teamId}:${job.attempt}`;
    if (this.closingTeams.has(key) || job.reports?.[teamId]?.attempt === job.attempt || !own.some(({ attempt }) => attempt === job.attempt) ||
        own.some(({ status }) => UNFINISHED.includes(status))) return;
    const view = this.options.team(teamId, job.definitionsVersion!);
    if (!view) return;
    this.closingTeams.add(key);
    try {
      let text: string;
      try {
        text = await this.options.leader.close(this.leaderInput(job, view, this.crossRelay(job, teamId)), reports(own));
      } catch { text = [...resultLines(own), ...retryLine(own)].join("\n"); }
      await this.rememberDivision(job, view, own, text, this.crossRelay(job, teamId));
      if (this.closing) return;
      job = this.job(requestId)!;
      if (job.cancelRequested) return;
      const post = { id: `${requestId}:closing:${job.attempt}:${teamId}`, notice: { ...this.teamNotice(job, teamId,
        `${text}\n结果经 ${this.coordinator().name} 交回 ${this.agentName(job.agentId)} 汇总。`), requestId } };
      this.transaction(() => { (job.reports ??= {})[teamId] = { attempt: job.attempt, text }; this.save(job); this.queueNotice(post.id, post.notice); });
      await this.deliverNotice(post.id, post.notice);
    } finally { this.closingTeams.delete(key); this.changed(); }
  }

  /**
   * The lead Team Leader's closing turn, over its own Assignments and the reports the Coordinator relays from other teams
   * (agent-dispatch::REQ-013/AC-03). A failed turn falls back to its Assignments' own results and each relayed report, so no
   * outcome goes unreported and no other team's Executor result reaches the lead's post.
   */
  private async closeRequest(job: DispatchJob, team: DispatchTeamView, assignments: readonly DispatchAssignment[]): Promise<string> {
    const relay = this.leadRelay(job);
    try {
      return await this.options.leader.close(this.leaderInput(job, team, relay), reports(assignments));
    } catch {
      return [...resultLines(assignments), ...(job.parts ?? []).flatMap(({ title, teamId }) => teamId === null ? []
        : [`${title}（${this.agentName(teamId)} 队，经 ${this.coordinator().name} 转交）：${job.reports?.[teamId]?.text ?? "暂无汇报"}`]), ...retryLine(assignments)].join("\n");
    }
  }

  /** The Team Leader's own record of an attempt: the Brief it received, its division and its closing (agent-dispatch::REQ-012/AC-02). */
  private async rememberDivision(job: DispatchJob, team: DispatchTeamView, assignments: readonly DispatchAssignment[], closing: string, relay?: LeaderRelay): Promise<void> {
    const brief = this.brief(job);
    // A cross-team Team Leader's Brief from the Coordinator also names who asked and the parts it took (agent-dispatch::REQ-012/AC-02).
    const parts = relay?.requestedBy ? `\n应 ${relay.requestedBy} 请求承接：${relay.parts.map(({ title, summary }) => `${title}（${summary}）`).join("；")}` : "";
    try {
      await this.options.memory.capture(team.memoryScope, { event: job.executionEvent ?? job.event,
        senderAccountId: team.leader.id === job.agentId ? job.senderAccountId : job.senders?.[team.leader.id] ?? job.senderAccountId,
        userId: `${job.id}:leader:user:${job.attempt}`,
        userText: `请求：${brief.message}${brief.latest ? `\n最新要求：${brief.latest}` : ""}\n协调摘要：${brief.summary}${parts}`,
        assistantId: `${job.id}:leader:assistant:${job.attempt}`,
        assistantText: `分工：${assignments.map((assignment) => `${executorLabel(assignment)}${assignment.title}`).join("；")}\n收尾：${closing}` });
    } catch { this.failure("dispatch_leader_memory_failed"); }
  }

  /** The Team Leader's Brief: the original message, the latest confirmation or supplement when it differs, and the Coordinator's summary. */
  private brief(job: DispatchJob): LeaderTurnInput["brief"] {
    const latest = job.executionEvent && job.executionEvent.text !== job.event.text ? { latest: job.executionEvent.text } : {};
    return { message: job.event.text, ...latest, summary: job.summary };
  }

  /** What the Coordinator relays to the lead: the parts it asked for, each with its team and that team's report, and the needs reported. */
  private leadRelay(job: DispatchJob): LeaderRelay | undefined {
    const parts = (job.parts ?? []).map(({ title, teamId }) => ({ title, team: teamId === null ? null : this.teamName(job, teamId),
      ...(teamId !== null && job.reports?.[teamId] ? { report: job.reports[teamId].text } : {}) }));
    const needs = (job.needs ?? []).map(({ teamId, title, brief }) => ({ team: this.teamName(job, teamId), title, brief }));
    return parts.length || needs.length ? { parts, ...(needs.length ? { needs } : {}) } : undefined;
  }
  /** What the Coordinator relays to a cross-team Team Leader: whose request it serves and the parts placed with its team. */
  private crossRelay(job: DispatchJob, teamId: string, parts = job.parts ?? []): LeaderRelay {
    return { requestedBy: this.agentName(job.agentId), parts: parts.filter((part) => part.teamId === teamId).map(({ title, brief, summary }) => ({ title, brief, summary })) };
  }
  private teamName(job: DispatchJob, teamId: string): string { return this.options.team(teamId, job.definitionsVersion!)?.leader.teamName ?? teamId; }

  private leaderInput(job: DispatchJob, team: DispatchTeamView, relay?: LeaderRelay): LeaderTurnInput {
    // The Team Leader chooses profiles by ID, name and what their Executors can do; the noun only names the Executors in the group.
    return { requestId: job.id, leader: team.leader, profiles: team.profiles.map(({ id, name, capabilities }) => ({ id, name, capabilities })), brief: this.brief(job),
      ...(relay ? { relay } : {}),
      // The Team Leader's own memory in this conversation; never the group memory or an Executor's (agent-dispatch::REQ-012/AC-02).
      memory: this.options.memory.recall(team.memoryScope, job.event, job.executionEvent?.text ?? job.event.text),
      directory: this.options.roster(job.event).map(({ name, responsibility }) => ({ name, responsibility })),
      session: { accountId: job.event.accountId, target: job.event.target, bindingHash: job.bindingHash, revision: this.options.revision(),
        definitionsVersion: job.definitionsVersion! },
      fixtureMessageId: this.fixtureMessageId(job) };
  }
  private fixtureMessageId(job: DispatchJob): string { return job.fixtureMessageId ?? job.executionEvent?.messageId ?? job.event.messageId; }

  /**
   * Has the host close the choices the request's Executors left open (agent-dispatch::REQ-007/AC-03). A choice that cannot be
   * closed stops nothing: the failure is reported. Where pending answers are taken in, the run of a superseded choice, and of a
   * choice of a request that is cancelled or being cancelled, is named to the host before it acts, so nothing of it is resumed.
   */
  private async closeChoices(job: DispatchJob): Promise<void> {
    try { await this.options.closeChoices?.(job, this.assignments(job.id)); }
    catch { this.failure("dispatch_choice_close_failed"); }
  }

  /**
   * Ends every waiting Assignment whose choice a newer workflow of its requester replaced: in the group `target`, or everywhere
   * at a start. Nothing tells the dispatch of a replaced choice, so it asks the host when an Executor ends, since that Executor's
   * workflow may have replaced one, once a group's queued messages are dealt with, and at a start. It changes waiting requests,
   * and a cancel or a supplement of a waiting request relies on nothing else changing that request while its choices are closed.
   * So an Executor's end asks only while the group's messages are not being taken in (`taking`), and otherwise leaves it to the
   * pass that takes them in. Returns the queued posts, which `tellReplaced` delivers; a start delivers them with its other queued
   * posts.
   */
  private endReplaced(target?: string): Array<{ id: string; notice: Notice }> {
    const posts: Array<{ id: string; notice: Notice }> = [];
    if (!this.options.choiceReplaced) return posts;
    for (const job of this.jobs()) {
      if ((target !== undefined && job.event.target !== target) || !goesOn(job)) continue;
      posts.push(...this.endUnanswered(job, this.assignments(job.id).filter(({ status, runRef }) => status === "waiting" && runRef !== undefined && this.choiceReplaced(runRef)), true));
    }
    return posts;
  }

  /** The host's word on whether a newer workflow replaced the choice of `runRef`. When the host cannot say, the choice counts as not replaced and the failure is reported. */
  private choiceReplaced(runRef: string): boolean {
    try { return this.options.choiceReplaced?.(runRef) ?? false; }
    catch { this.failure("dispatch_choice_state_failed"); return false; }
  }

  /**
   * Ends the Assignment that waits on a choice its requester's new goal replaced, if it still waits on it. Nothing is posted for
   * it. An Assignment whose Executor has not ended keeps no run yet, so nothing ends here: its own end finds the run replaced.
   */
  private endReplacedByGoal(runRef: string, event: InboundContent): void {
    const request = this.requestOfRun(runRef, event);
    if (!request || !goesOn(request)) return;
    this.endUnanswered(request, this.assignments(request.id).filter((assignment) => assignment.status === "waiting" && assignment.runRef === runRef), false);
    this.kick();
  }

  /**
   * Whether the request is only being closed with nothing left that a supplement could change: its attempt has Assignments and
   * every Assignment of the request was stopped, so it ends cancelled. A request whose attempt has none yet is being divided for a
   * supplement, and goes on.
   */
  private onlyClosing(job: DispatchJob): boolean {
    const assignments = this.assignments(job.id);
    return assignments.some(({ attempt }) => attempt === job.attempt) && assignments.every(({ status }) => status === "cancelled");
  }

  /** The post that tells the requester of an Assignment whose choice a newer workflow replaced, under the Team Leader of the Assignment's own team (agent-dispatch::REQ-013/AC-04). */
  private replacedPost(job: DispatchJob, assignment: DispatchAssignment): { id: string; notice: Notice } {
    return { id: `${job.id}:replaced:${assignment.id}:${assignment.attempt}`, notice: { ...this.teamNotice(job, assignment.teamId,
      `${executorLabel(assignment)}的分工「${assignment.title}」等待的选择已被新的操作取代，这项分工已停止。`), requestId: job.id } };
  }

  /**
   * Delivers the posts that tell requesters of replaced choices, then starts the requests that waited on those choices, so that
   * a post normally goes out before its request's closing. A stopping service leaves the posts queued for the next start: a post
   * sent while it stops would be cancelled.
   */
  private async tellReplaced(posts: ReadonlyArray<{ id: string; notice: Notice }>): Promise<void> {
    for (const post of posts) if (!this.closing) await this.deliverNotice(post.id, post.notice);
    if (posts.length) this.kick();
  }

  /**
   * Ends the waiting Assignments `unanswered` of `job`, whose choices were closed without an answer and take none any more. Each
   * ends cancelled and keeps no prompt. Their dependents are left not started in the same step, and a request that waited returns
   * to its worker, which closes it once nothing else is unfinished. With `told`, the post that tells the requester of each is
   * queued in that step too; the posts are returned for delivery.
   */
  private endUnanswered(job: DispatchJob, unanswered: readonly DispatchAssignment[], told: boolean): Array<{ id: string; notice: Notice }> {
    const posts: Array<{ id: string; notice: Notice }> = [];
    if (!unanswered.length) return posts;
    this.transaction(() => {
      for (const assignment of unanswered) {
        assignment.status = "cancelled"; delete assignment.result; this.saveAssignment(assignment);
        if (!told) continue;
        const post = this.replacedPost(job, assignment);
        this.queueNotice(post.id, post.notice); posts.push(post);
      }
      this.blockDependents(job.id);
      if (job.status === "waiting") { job.status = "queued"; this.save(job); }
    });
    return posts;
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
    const evidence = `${this.options.completedWork(job, assignments)}已经完成的操作不会自动撤销。`;
    job.status = "cancelled"; job.supplements = [];
    if (assignments.length <= 1) { job.result = `已停止继续处理。${evidence}`; return; }
    // One line per Assignment, as every group post with several items.
    const outcome = (assignment: DispatchAssignment) => assignment.status === "completed" ? "已完成"
      : assignment.status === "failed" || assignment.status === "interrupted" ? "未能完成" : assignment.status === "blocked" ? "未开始" : "已停止";
    job.result = `已停止继续处理：\n${assignments.map((assignment) => `${assignment.executor}「${assignment.title}」${outcome(assignment)}`).join("\n")}\n${evidence}`;
  }

  /**
   * A team's Assignments in the request as its Team Leader is shown them, in position order: position n is element n - 1. Every
   * 1-based position a Team Leader writes or reads (a supplement's `affected`, `dependsOn`, the start message, the closing and a
   * not-started Assignment's text) numbers this list, so a position never names another team's Assignment.
   */
  private leaderView(requestId: string, teamId: string): DispatchAssignment[] { return this.assignments(requestId).filter((assignment) => assignment.teamId === teamId); }
  private hasAttemptAssignments(job: DispatchJob): boolean { return this.assignments(job.id).some(({ attempt }) => attempt === job.attempt); }
  private closingId(job: DispatchJob): string { return `${job.id}:closing:${job.attempt}`; }
  /** The requester's request whose Assignment, or whose earlier single Executor, started the workflow run. */
  private requestOfRun(runRef: string, event: InboundContent): DispatchJob | undefined {
    return this.jobs().find((job) => job.event.target === event.target && job.event.senderId === event.senderId &&
      (job.runRef === runRef || this.assignments(job.id).some((assignment) => assignment.runRef === runRef)));
  }

  /**
   * The requester's request on whose behalf the choice of `runRef` takes no answer any more: one that keeps `runRef` among the runs
   * a supplement superseded, or one that is cancelled, or is being cancelled, whose Assignment, or earlier single Executor, started it.
   */
  private heldRequest(runRef: string, event: InboundContent): DispatchJob | undefined {
    return this.jobs().find((job) => job.event.target === event.target && job.event.senderId === event.senderId && (job.supersededRuns?.includes(runRef) ||
      ((job.cancelRequested || job.status === "cancelled") && (job.runRef === runRef || this.assignments(job.id).some((assignment) => assignment.runRef === runRef)))));
  }

  private recordResult(job: DispatchJob, id = `${job.id}:result:${job.attempt}`, notice = this.notice(job, job.result!)): { id: string; notice: Notice } {
    job.reportId = id;
    // A finished attempt is captured into the group memory once its report is accepted. A cancelled or waiting request is not:
    // withdrawn work must leave no memory-derived reminder, and a waiting one is captured with its closing.
    const finished = job.status === "completed" || job.status === "partially_failed" || job.status === "partially_unassigned" || job.status === "failed";
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
    const sam = this.options.agents().find(({ id }) => id === COORDINATOR_ID)!;
    return this.deliverNotice(`${event.key}:coordination`, { event, bindingHash, agentId: sam.id, senderAccountId: sam.senderAccountId, text,
      ...(requestId ? { requestId } : {}) });
  }
  private notice(job: DispatchJob, text: string): Notice {
    return { event: job.event, bindingHash: job.bindingHash, agentId: job.agentId, senderAccountId: job.senderAccountId, text };
  }
  /** A post under the Team Leader of `teamId`: the lead's own identity, or a cross-team Team Leader's (agent-dispatch::REQ-013/AC-04). */
  private teamNotice(job: DispatchJob, teamId: string, text: string): Notice {
    if (teamId === job.agentId) return this.notice(job, text);
    return { event: job.event, bindingHash: job.bindingHash, agentId: teamId, senderAccountId: job.senders?.[teamId] ?? "", text };
  }
  private coordinatorNotice(job: DispatchJob, text: string): Notice {
    const coordinator = this.coordinator();
    return { event: job.event, bindingHash: job.bindingHash, agentId: coordinator.id, senderAccountId: coordinator.senderAccountId, text };
  }
  private coordinator(): DispatchAgent { return this.options.agents().find(({ id }) => id === COORDINATOR_ID)!; }
  private agentName(id: string): string { return this.options.agents().find((agent) => agent.id === id)?.name ?? id; }
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
      this.options.agents().some((agent) => agent.id === notice.agentId && agent.senderAccountId === notice.senderAccountId);
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
  private changed() { if (this.closing) return; try { this.options.workChanged?.(); } catch { this.failure("dispatch_work_change_failed"); } }
  private failure(code: string) { try { this.options.report(code); } catch { /* Diagnostics cannot change task outcomes. */ } }
}

/** The skills an Assignment's runtime did not load, as group posts name them (skill-library::REQ-002). */
const notLoaded = ({ names }: SkillsNotLoaded) => `Codex 没有加载技能${names.map((name) => `「${name}」`).join("")}`;
function failureReason(error: unknown): string {
  if (error instanceof SkillsNotLoaded) return `${notLoaded(error)}，这项分工没有执行。`;
  const code = error instanceof Error ? error.message : "";
  if (code === "dispatch_authorization_changed") return "权限或可用上下文发生变化，本次处理已停止。";
  if (code === "dispatch_model_unavailable") return "当前模型不可用，本次未能继续处理。";
  if (code === "dispatch_team_unavailable") return "负责团队当前不可用，本次未能继续处理。";
  if (code.startsWith("main_reply_")) return "模型未返回有效的结果报告，本次处理已停止。";
  return "执行连接中断或处理出错，本次未能完成。";
}
