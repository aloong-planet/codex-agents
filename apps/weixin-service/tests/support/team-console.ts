// The console's team API as the whole-app test files use it: the shape of the team view and the edit a save carries.
import type { start } from "./real-main.js";

type Running = Awaited<ReturnType<typeof start>>;

/** What a removal in one group still waits for (team-management::US-004). */
export type Removal = { active: number; awaitingRequester: number; closing: number; tasks: Array<{ id: string; name: string; when: string }>;
  waiting: Array<{ requestId: string; label: string; summary: string; requester: string; waitingFor: string[] }> };
export type TeamView = { id: string; teamName: string; responsibility: string; leader: { name: string; appId: string; instructions: string }; deleting: boolean;
  profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }>;
  bindings: Array<{ chatId: string; state: string; join?: { status: string; reason?: string }; removal?: Removal }>;
  announcements: Record<string, { kind: string; state: string }> };
export type View = { version: number; teams: TeamView[]; preview: Record<string, string[]> };
export type Edit = { id: string; teamName: string; responsibility: string; leader: TeamView["leader"];
  executorProfiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }>; groups: string[] };
/** The console's edit of a team as the team view shows it, changed by `change`. */
export function editOf(view: View, id: string, change: (team: Edit) => Edit = (team) => team): Edit {
  const team = view.teams.find((candidate) => candidate.id === id)!;
  return change({ id, teamName: team.teamName, responsibility: team.responsibility, leader: { ...team.leader },
    executorProfiles: team.profiles.map(({ id: profileId, name, noun, instructions, hostTools }) => ({ id: profileId, name, noun, instructions, hostTools })),
    groups: team.bindings.filter(({ state }) => state !== "draining").map(({ chatId }) => chatId) });
}

/**
 * Saves, through the console's team API, the MCP servers every Executor profile of a team attaches. A server that is newly
 * attached carries the line its confirmation card showed (team-management Implementation Decisions: MCP attachment).
 */
export async function attachMcpServers(running: Running, teamId: string, mcpServers: ReadonlyArray<{ name: string; confirmed: string }>): Promise<void> {
  const view = await running.get<View>("/api/teams");
  await running.post("/api/teams/save", { basedOn: view.version, team: editOf(view, teamId, (team) => ({ ...team, executorProfiles: team.executorProfiles.map((profile) => ({ ...profile, mcpServers })) })) });
}
