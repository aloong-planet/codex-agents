import type { AccountMemorySnapshot, MemoryCategory, PlanStatus } from "./account-memory-store.js";
import type { DispatchPost, DispatchRecord } from "./agent-dispatch.js";
import type { DispatchAssignment, DispatchJob } from "./agent-dispatch-types.js";
import type { TeamDefinitions } from "./team-registry.js";

/** What a group post was, from its place in the request: its start, a decision, the Coordinator's placement, a failure and so on. */
export type PostKind = "receipt" | "cross_team" | "decision" | "pending" | "failure" | "interrupted" | "closing";
/** The delivery of a request's report to its group: none yet, or the state of its latest closing (agent-console::US-004/AC-05). */
export type ReportDelivery = "none" | DispatchPost["state"];
export type TeamCounts = { running: number; waiting: number; history: number };

/** One request as the team overview and its records show it. Every text is shown as plain text (agent-console::REQ-005/AC-04). */
export type OverviewRequest = {
  id: string;
  /** The group whose conversation the request belongs to. */
  chatId: string;
  title: string;
  /** The lead team. */
  lead: string;
  requester: "owner" | "member";
  status: DispatchJob["status"];
  delivery: ReportDelivery;
  receivedAt: number;
  result: string | null;
  message: { text: string; source: "text" | "voice" | "media"; attachments: string[] };
  assignments: Array<{ id: string; teamId: string; executor: string; profile: string; title: string; brief: string; status: DispatchAssignment["status"];
    result: string | null; crossTeam: boolean }>;
  /** Parts the lead asked other teams to take, with the team the Coordinator placed each with, or null when no team took it. */
  parts: Array<{ title: string; teamId: string | null }>;
  posts: Array<{ agentId: string; kind: PostKind | null; text: string; state: DispatchPost["state"]; acceptedAt: number | null }>;
};

export type OverviewView = {
  /** False without Feishu dispatch; the page then shows no tree. */
  dispatch: boolean;
  groups: Array<{ chatId: string; name: string }>;
  /** Every agent a group or a record names: the Coordinator, the current teams and teams only older requests used. */
  agents: Record<string, { name: string; teamName: string }>;
  coordinator: { id: string; responsibility: string } | null;
  /** The current teams; `groups` are those they are bound to, and `counts` their requests per group (agent-console::US-003/AC-02). */
  teams: Array<{ id: string; responsibility: string; groups: string[]; counts: Record<string, TeamCounts> }>;
  requests: OverviewRequest[];
  /** Penny's state only; nothing of its ledger reaches the console (agent-console::REQ-003). */
  penny: { configured: boolean; ready: boolean };
};

export type ConsoleOverviewOptions = Readonly<{
  /** Every stored dispatch request; absent without Feishu dispatch. */
  records?(): readonly DispatchRecord[];
  /** The live definitions, and a stored version for the names of teams that only older requests used. */
  teams?: Readonly<{ current(): Readonly<{ definitions: TeamDefinitions }>; version(version: number): Readonly<{ definitions: TeamDefinitions }> | undefined }>;
  /** The groups the running service dispatches in. */
  groups(): readonly string[];
  names(chatIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** The group chat of a request's conversation; undefined for any other conversation. */
  chatIdOf(accountId: string, target: string): string | undefined;
  /** Whether a group message's sender is the owner. */
  owner(senderId: string): boolean;
  penny(): Readonly<{ configured: boolean; ready: boolean }>;
  /** A dispatch group's memory account, the one its Coordinator recalls; it may throw when the account cannot be read. */
  groupMemory?(chatId: string): Pick<AccountMemorySnapshot, "entries" | "events">;
}>;

/**
 * A group's memory as the console shows it, read-only (agent-console::US-005/AC-04): every entry and every event, whatever its date.
 * An event's `time` is a plan's time of day (`morning`, `afternoon`, `evening` or `HH:MM`), or null.
 */
export type GroupMemoryView = Readonly<{ readable: false }> | Readonly<{
  readable: true;
  entries: Array<{ category: MemoryCategory; value: string }>;
  events: Array<{ date: string; kind: "planned" | "observed"; plan: PlanStatus | null; retracted: boolean; fulfillsPlan: boolean; time: string | null; summary: string }>;
  /** The latest change to any entry or event, or null for an empty memory. */
  updatedAt: number | null;
}>;

const KINDS: Record<string, PostKind> = { receipt: "receipt", "cross-team": "cross_team", decision: "decision", pending: "pending", failure: "failure",
  interrupted: "interrupted", closing: "closing", result: "closing" };
const ACTIVE = new Set<string>(["queued", "running", "waiting"]);

/**
 * The console's read projection over Dispatch Requests, Assignments, Executors, group posts and their delivery outcomes, keyed by
 * group (agent-console Implementation Decisions: read projections). It is the owner's view; no agent ever receives it
 * (agent-console::REQ-001).
 */
export class ConsoleOverview {
  constructor(private readonly options: ConsoleOverviewOptions) {}

  async view(): Promise<OverviewView> {
    const groups = [...this.options.groups()];
    const names = await this.options.names(groups);
    const penny = this.options.penny();
    const base = { groups: groups.map((chatId) => ({ chatId, name: names[chatId] || chatId })), penny: { configured: penny.configured === true, ready: penny.ready === true } };
    const teams = this.options.teams;
    if (!teams || !this.options.records) return { dispatch: false, ...base, agents: {}, coordinator: null, teams: [], requests: [] };
    const { definitions } = teams.current();
    const agents: OverviewView["agents"] = { [definitions.coordinator.id]: { name: definitions.coordinator.name, teamName: definitions.coordinator.teamName } };
    for (const team of definitions.teams) agents[team.id] = { name: team.leader.name, teamName: team.teamName };
    const requests: OverviewRequest[] = [];
    for (const { job, assignments, posts } of this.options.records()) {
      const chatId = this.options.chatIdOf(job.event.accountId, job.event.target);
      if (!chatId || !groups.includes(chatId)) continue;
      const known = (id: string) => {
        if (agents[id] || job.definitionsVersion === undefined) return;
        const team = teams.version(job.definitionsVersion)?.definitions.teams.find((candidate) => candidate.id === id);
        if (team) agents[id] = { name: team.leader.name, teamName: team.teamName };
      };
      [job.agentId, ...assignments.map(({ teamId }) => teamId), ...(job.parts ?? []).flatMap(({ teamId }) => teamId ? [teamId] : [])].forEach(known);
      requests.push(project(job, chatId, assignments, posts, this.options.owner(job.event.senderId ?? "")));
    }
    return { dispatch: true, ...base, agents, coordinator: { id: definitions.coordinator.id, responsibility: definitions.coordinator.responsibility },
      teams: definitions.teams.map((team) => {
        const bound = team.bindings.filter(({ chatId, state }) => state !== "removed" && groups.includes(chatId)).map(({ chatId }) => chatId);
        return { id: team.id, responsibility: team.responsibility, groups: bound,
          counts: Object.fromEntries(bound.map((chatId) => [chatId, counts(requests.filter((request) => request.chatId === chatId), team.id)])) };
      }),
      requests };
  }

  /** A dispatch group's memory; undefined for a chat that is not a dispatch group, so no other memory is ever reachable. */
  memory(chatId: string): GroupMemoryView | undefined {
    if (!this.options.groupMemory || !this.options.groups().includes(chatId)) return undefined;
    let snapshot: Pick<AccountMemorySnapshot, "entries" | "events">;
    try { snapshot = this.options.groupMemory(chatId); } catch { return { readable: false }; }
    const times = [...snapshot.entries, ...snapshot.events].map(({ updatedAt }) => updatedAt);
    return { readable: true, entries: snapshot.entries.map(({ category, value }) => ({ category, value })),
      events: snapshot.events.map((event) => ({ date: event.localDate, kind: event.eventKind, plan: event.eventKind === "planned" ? event.planStatus ?? "pending" : null,
        retracted: event.factStatus === "retracted", fulfillsPlan: Boolean(event.fulfillsPlanId),
        time: event.eventKind !== "planned" ? null : event.timePrecision === "exact" ? event.localTime ?? null : event.timePrecision && event.timePrecision !== "date" ? event.timePrecision : null,
        summary: event.summary })),
      updatedAt: times.length ? Math.max(...times) : null };
  }
}

function project(job: DispatchJob, chatId: string, assignments: readonly DispatchAssignment[], posts: readonly DispatchPost[], owner: boolean): OverviewRequest {
  const prefix = `${job.id}:`;
  const kindOf = (id: string) => id.startsWith(prefix) ? KINDS[id.slice(prefix.length).split(":")[0]!] ?? null : null;
  // The request's own report is its lead's closing (or, before Assignments existed, its result), including a retried send of it.
  const report = new RegExp(`^${escape(job.id)}:(closing|result):\\d+(:retry:.+)?$`);
  const last = posts.filter(({ id }) => report.test(id)).at(-1);
  return {
    id: job.id, chatId, title: job.summary, lead: job.agentId, requester: owner ? "owner" : "member", status: job.status, delivery: last ? last.state : "none",
    receivedAt: job.event.receivedAt, result: job.result ?? null,
    message: { text: job.event.text, source: job.event.source, attachments: (job.event.attachments ?? []).map(({ fileName }) => fileName) },
    assignments: assignments.map((assignment) => ({ id: assignment.id, teamId: assignment.teamId, executor: assignment.executor, profile: assignment.profileName,
      title: assignment.title, brief: assignment.brief, status: assignment.status, result: assignment.result ?? null, crossTeam: assignment.teamId !== job.agentId })),
    parts: (job.parts ?? []).map(({ title, teamId }) => ({ title, teamId })),
    posts: posts.map(({ id, agentId, text, state, acceptedAt }) => ({ agentId, kind: kindOf(id), text, state, acceptedAt })),
  };
}

/**
 * A team's requests in one group, each counted once: waiting when any of its Assignments there waits for a choice, running while
 * any is unfinished, history once all have ended. A team with no Assignment there yet follows the request's own state.
 */
function counts(requests: readonly OverviewRequest[], teamId: string): TeamCounts {
  const result: TeamCounts = { running: 0, waiting: 0, history: 0 };
  for (const request of requests) {
    const own = request.assignments.filter((assignment) => assignment.teamId === teamId);
    const involved = request.lead === teamId || own.length > 0 || request.parts.some((part) => part.teamId === teamId);
    if (!involved) continue;
    const statuses = own.length ? own.map(({ status }) => status) : [request.status];
    if (statuses.some((status) => status === "waiting" || status === "proposed")) result.waiting += 1;
    else if (statuses.some((status) => ACTIVE.has(status))) result.running += 1;
    else result.history += 1;
  }
  return result;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
