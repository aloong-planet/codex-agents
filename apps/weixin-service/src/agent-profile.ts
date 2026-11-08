import type { DynamicToolContext, DynamicToolHost, DynamicToolResult } from "./dynamic-tool-host.js";
import type { TeamDefinitions } from "./team-registry.js";
import { WorkflowToolCatalog } from "./workflow-tool-catalog.js";

/** The agent whose profile a dispatch turn uses. Team Leader turns join with ticket 05. */
export type AgentRef = Readonly<{ role: "coordinator" }> | Readonly<{ role: "executor"; teamId: string; profileId: string }>;
/** Everything a dispatch turn may take from its Agent Profile (agent-dispatch Implementation Decisions: Profile resolution). */
export type ResolvedAgentProfile = Readonly<{
  /** The profile's own instructions; shared code adds only domain-neutral rules around them. */
  instructions: string;
  /** Host tools offered to the turn: the profile allowlist ∩ the catalog. Module permissions still gate every call. */
  hostTools: readonly string[];
  /** Until per-agent visibility scopes arrive, every dispatch agent recalls and captures the group memory. */
  memoryScope: "group";
}>;

/** The one resolution point for a dispatch agent's instructions, host tools and memory scope in a definitions version. */
export function resolveAgentProfile(definitions: TeamDefinitions, agent: AgentRef, catalogToolIds: readonly string[]): ResolvedAgentProfile {
  // The Coordinator's session never receives business tools, whatever its profile lists (agent-dispatch::CON-003).
  if (agent.role === "coordinator") return { instructions: definitions.coordinator.profile.instructions, hostTools: [], memoryScope: "group" };
  const profile = definitions.teams.find(({ id }) => id === agent.teamId)?.executorProfiles.find(({ id }) => id === agent.profileId);
  if (!profile) throw new Error("agent_profile_unknown");
  const allowed = new Set(profile.hostTools);
  return { instructions: profile.instructions, hostTools: catalogToolIds.filter((id) => allowed.has(id)), memoryScope: "group" };
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
