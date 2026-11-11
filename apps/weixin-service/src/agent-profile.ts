import { createHash } from "node:crypto";
import type { DynamicToolContext, DynamicToolHost, DynamicToolResult } from "./dynamic-tool-host.js";
import type { TeamDefinitions } from "./team-registry.js";
import { WorkflowToolCatalog } from "./workflow-tool-catalog.js";

/** The agent whose profile a dispatch turn uses. */
export type AgentRef = Readonly<{ role: "coordinator" }> | Readonly<{ role: "leader"; teamId: string }> | Readonly<{ role: "executor"; teamId: string; profileId: string }>;
/**
 * Whose memory a dispatch turn recalls and captures (agent-dispatch::REQ-012): the Coordinator the group memory, a Team Leader
 * its own per conversation, and Executors the memory shared by one Agent Profile in one conversation.
 */
export type AgentMemoryScope = Readonly<{ kind: "group" }> | Readonly<{ kind: "leader"; teamId: string }> | Readonly<{ kind: "profile"; teamId: string; profileId: string }>;
/** Everything a dispatch turn may take from its Agent Profile (agent-dispatch Implementation Decisions: Profile resolution). */
export type ResolvedAgentProfile = Readonly<{
  /** The profile's own instructions; shared code adds only domain-neutral rules around them. */
  instructions: string;
  /** Host tools offered to the turn: the profile allowlist ∩ the catalog. Module permissions still gate every call. */
  hostTools: readonly string[];
  memoryScope: AgentMemoryScope;
}>;

/** Accounts of Team Leader and Executor memories; they are curated without notification routes, so they never create reminders. */
export const DISPATCH_MEMORY_ACCOUNT_PREFIX = "feishu.dispatch.";
/**
 * The memory account of `scope` in the conversation whose group memory account is `groupAccount`. Derived accounts are stable
 * across access revisions and definitions versions, and distinct per group, per leader and per team and profile.
 */
export function memoryAccountId(groupAccount: string, scope: AgentMemoryScope): string {
  if (scope.kind === "group") return groupAccount;
  const key = scope.kind === "leader" ? ["leader", groupAccount, scope.teamId] : ["executor", groupAccount, scope.teamId, scope.profileId];
  return `${DISPATCH_MEMORY_ACCOUNT_PREFIX}${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
}

/** The one resolution point for a dispatch agent's instructions, host tools and memory scope in a definitions version. */
export function resolveAgentProfile(definitions: TeamDefinitions, agent: AgentRef, catalogToolIds: readonly string[]): ResolvedAgentProfile {
  // The Coordinator's session never receives business tools, whatever its profile lists (agent-dispatch::CON-003).
  if (agent.role === "coordinator") return { instructions: definitions.coordinator.profile.instructions, hostTools: [], memoryScope: { kind: "group" } };
  // A Team Leader plans and summarizes; it holds no side-effecting tools, whatever its profile lists (agent-dispatch::REQ-002/AC-05).
  if (agent.role === "leader") {
    const team = definitions.teams.find(({ id }) => id === agent.teamId);
    if (!team) throw new Error("agent_profile_unknown");
    return { instructions: team.leader.profile.instructions, hostTools: [], memoryScope: { kind: "leader", teamId: team.id } };
  }
  const profile = definitions.teams.find(({ id }) => id === agent.teamId)?.executorProfiles.find(({ id }) => id === agent.profileId);
  if (!profile) throw new Error("agent_profile_unknown");
  const allowed = new Set(profile.hostTools);
  return { instructions: profile.instructions, hostTools: catalogToolIds.filter((id) => allowed.has(id)),
    memoryScope: { kind: "profile", teamId: agent.teamId, profileId: profile.id } };
}

/**
 * The module permission each host tool needs before its gate lets a call through: read or write on some saved scope, or read
 * and write on one scope (files.edit). media.send's own images and the schedule tools have no module gate. Taken from the gates
 * in the local file tools and the file-send artifact store.
 */
const HOST_TOOL_PERMISSIONS: Readonly<Record<string, "read" | "write" | "read_write" | null>> = {
  "files.find": "read", "files.grep": "read", "files.read": "read", "weixin.send_files": "read",
  "files.write": "write", "files.edit": "read_write", "media.send": null,
  "schedules.create": null, "schedules.delete": null, "schedules.disable": null, "schedules.edit": null, "schedules.enable": null,
  "schedules.inspect": null, "schedules.list": null, "schedules.read_text": null, "schedules.retry_news": null, "schedules.run_now": null,
};

/**
 * A profile's effective host tools (team-management::US-003/AC-02): the checked tools whose module permission is granted by the
 * current scopes. A checked tool with no known gate counts as not granted.
 */
export function effectiveHostTools(checked: readonly string[], scopes: ReadonlyArray<Readonly<{ read: boolean; write: boolean }>>):
  Readonly<{ offered: string[]; ungranted: string[] }> {
  const granted = (tool: string) => {
    const need = HOST_TOOL_PERMISSIONS[tool];
    if (need === undefined) return false;
    return need === null || scopes.some((scope) => need === "read_write" ? scope.read && scope.write : scope[need]);
  };
  return { offered: checked.filter(granted), ungranted: checked.filter((tool) => !granted(tool)) };
}

/** What each host tool lets an Executor do, in the words its Team Leader is told and in the order they are listed. */
const HOST_TOOL_WORDS: ReadonlyArray<readonly [tool: string, words: string]> = [
  ["files.find", "按名称查找授权目录里的文件"], ["files.grep", "搜索授权目录里文件的内容"], ["files.read", "读取授权目录里的文件"],
  ["files.write", "在授权目录里保存新文件或覆盖已有文件"], ["files.edit", "修改授权目录里已有的文件"],
  ["weixin.send_files", "把授权目录里的文件发到本群"], ["media.send", "把图片发到本群"],
  ["schedules.list", "查看定时任务列表"], ["schedules.inspect", "查看定时任务详情"], ["schedules.read_text", "读取定时任务正文"],
  ["schedules.create", "创建定时任务"], ["schedules.edit", "修改定时任务"], ["schedules.enable", "启用定时任务"], ["schedules.disable", "停用定时任务"],
  ["schedules.run_now", "立即执行定时任务"], ["schedules.retry_news", "重试日报任务"], ["schedules.delete", "删除定时任务"],
];

/**
 * What an Executor created from a preset can do now, in plain words (agent-dispatch::REQ-011/AC-01). `hostTools` is the preset's
 * resolved view in the request's definitions version. A tool is named when the preset still allows it (`stillAllowed`, undefined
 * once the preset is gone; agent-dispatch::REQ-017/AC-02) and the current module permissions grant it
 * (agent-dispatch::REQ-016/AC-02). Web search follows the Executor's runtime. A granted tool with no words is named by its ID.
 */
export function executorCapabilities(hostTools: readonly string[], stillAllowed: readonly string[] | undefined,
  scopes: ReadonlyArray<Readonly<{ read: boolean; write: boolean }>>, webSearch: boolean): string[] {
  const kept = new Set(stillAllowed ?? []);
  const { offered } = effectiveHostTools(hostTools.filter((tool) => kept.has(tool)), scopes);
  const worded = new Set(HOST_TOOL_WORDS.map(([tool]) => tool));
  return [...HOST_TOOL_WORDS.filter(([tool]) => offered.includes(tool)).map(([, words]) => words), ...offered.filter((tool) => !worded.has(tool)),
    ...(webSearch ? ["联网搜索"] : [])];
}

/**
 * The shared tool host as one agent sees it: only its resolved host tools are offered, and any other call is refused
 * before the shared host. Turn bindings stay on the shared host, which keeps checking module permissions on every call.
 */
const PROFILE_TOOL_REFUSED = "agent_profile_tool_refused";
/** Whether a tool result is the profile tool host's refusal of a call outside the profile's allowlist. */
export function isProfileToolRefusal(result: DynamicToolResult): boolean {
  return !result.success && result.contentItems.some((item) => item.type === "inputText" && item.text.includes(PROFILE_TOOL_REFUSED));
}

export class ProfileToolHost implements DynamicToolHost {
  private readonly allowed: ReadonlySet<string>;
  private readonly offered: WorkflowToolCatalog;

  /**
   * `hostTools` is the resolved view of the request's definitions version. `revocation.current` gives the profile's allowlist
   * in the current definitions, or undefined once the profile is gone: a call passes only when its tool is in both, so a removal
   * applies at the next call of a running request (agent-dispatch::REQ-017/AC-02). Every refused call is reported to `refused`.
   */
  constructor(private readonly host: DynamicToolHost, catalog: WorkflowToolCatalog, hostTools: readonly string[],
    private readonly revocation: Readonly<{ current?: () => readonly string[] | undefined; refused?: (tool: string) => void }> = {}) {
    this.allowed = new Set(hostTools);
    this.offered = new WorkflowToolCatalog(catalog.members().filter(({ id }) => this.allowed.has(id)));
  }

  definitions() { return this.offered.definitions(); }

  /** The offered contract; equal to the shared catalog's when every tool is allowed, so existing sessions keep their scope. */
  contractHash(): string { return this.offered.contractHash(); }

  async execute(tool: string, argumentsValue: unknown, context?: DynamicToolContext): Promise<DynamicToolResult> {
    const id = `${context?.namespace}.${tool}`;
    const current = this.revocation.current ? this.revocation.current() : [...this.allowed];
    if (!context?.namespace || !this.allowed.has(id) || !current?.includes(id)) {
      try { this.revocation.refused?.(id); } catch { /* Reporting cannot turn a refusal into a call. */ }
      return { success: false, contentItems: [{ type: "inputText",
        text: JSON.stringify({ ok: false, error: { code: PROFILE_TOOL_REFUSED, retryable: false, action: "stop" } }) }] };
    }
    return this.host.execute(tool, argumentsValue, context);
  }

  turnOwner(context: DynamicToolContext): "model" | "workflow" { return this.host.turnOwner?.(context) ?? "model"; }
}
