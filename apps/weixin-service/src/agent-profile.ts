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
 * The shared tool host as one agent sees it: only its resolved host tools are offered, and any other call is refused
 * before the shared host. Turn bindings stay on the shared host, which keeps checking module permissions on every call.
 */
export class ProfileToolHost implements DynamicToolHost {
  private readonly allowed: ReadonlySet<string>;
  private readonly offered: WorkflowToolCatalog;

  constructor(private readonly host: DynamicToolHost, catalog: WorkflowToolCatalog, hostTools: readonly string[]) {
    this.allowed = new Set(hostTools);
    this.offered = new WorkflowToolCatalog(catalog.members().filter(({ id }) => this.allowed.has(id)));
  }

  definitions() { return this.offered.definitions(); }

  /** The offered contract; equal to the shared catalog's when every tool is allowed, so existing sessions keep their scope. */
  contractHash(): string { return this.offered.contractHash(); }

  async execute(tool: string, argumentsValue: unknown, context?: DynamicToolContext): Promise<DynamicToolResult> {
    if (!context?.namespace || !this.allowed.has(`${context.namespace}.${tool}`)) {
      return { success: false, contentItems: [{ type: "inputText",
        text: JSON.stringify({ ok: false, error: { code: "agent_profile_tool_refused", retryable: false, action: "stop" } }) }] };
    }
    return this.host.execute(tool, argumentsValue, context);
  }

  turnOwner(context: DynamicToolContext): "model" | "workflow" { return this.host.turnOwner?.(context) ?? "model"; }
}
