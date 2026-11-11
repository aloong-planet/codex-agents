import { join } from "node:path";
import { AgentDispatch } from "../../src/agent-dispatch.js";
import type { CrossTeamDecision, DispatchAgent, DispatchAssignment, DispatchExecutionResult, DispatchExecutor } from "../../src/agent-dispatch-types.js";
import type { InboundContent } from "../../src/channel-contract.js";
import { FixtureTeamLeader } from "../../src/fixture-team-leader.js";
import type { TeamDefinitions } from "../../src/team-registry.js";

// Durable dispatch records that a real AgentDispatch writes, for the console's read projection and the private conversations'
// inputs: the Team Leaders are the production fixture class and the Executors are scripted by Assignment title, so every record
// is one the dispatch lifecycle reaches. Each test file closes the dispatches it opened with closeDispatches.
export const agents: DispatchAgent[] = [{ id: "sam", name: "Sam", responsibility: "协调", senderAccountId: "cli_sam" },
  { id: "alice", name: "Alice", responsibility: "商品运营", senderAccountId: "cli_alice" }, { id: "bill", name: "Bill", responsibility: "衣食住行", senderAccountId: "cli_bill" }];
const profile = (id: string, name: string, noun: string) => ({ id, name, noun, instructions: "", hostTools: [] });
export const definitions: TeamDefinitions = {
  coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调、澄清和分派任务", appId: "cli_sam", profile: { instructions: "", hostTools: [] } },
  dispatchGroups: ["oc_alpha", "oc_beta"],
  teams: [
    { id: "alice", teamName: "运营团队", responsibility: "商品运营", leader: { name: "Alice", appId: "cli_alice", profile: { instructions: "", hostTools: [] } },
      executorProfiles: [profile("executor-1", "商品文案", "文案执行者"), profile("executor-2", "经营分析", "分析执行者")],
      bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "accepting" }] },
    { id: "bill", teamName: "生活团队", responsibility: "衣食住行", leader: { name: "Bill", appId: "cli_bill", profile: { instructions: "", hostTools: [] } },
      executorProfiles: [profile("executor-1", "行程规划", "行程执行者")], bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "removed" }] },
    // Being deleted, with its removal from oc_beta still pending.
    { id: "eve", teamName: "内容团队", responsibility: "内容创作", leader: { name: "Eve", appId: "cli_eve", profile: { instructions: "", hostTools: [] } },
      executorProfiles: [profile("executor-1", "写稿", "写稿执行者")], bindings: [{ chatId: "oc_beta", state: "draining" }], deleting: true },
  ],
};
export const teamView = (id: string) => {
  const team = definitions.teams.find((candidate) => candidate.id === id);
  return team ? { leader: { id, name: team.leader.name, teamName: team.teamName, responsibility: team.responsibility, instructions: "" },
    profiles: team.executorProfiles.map(({ id: profileId, name, noun }) => ({ id: profileId, name, noun: noun ?? "执行者", capabilities: [] })), memoryScope: { kind: "leader", teamId: id } as const } : undefined;
};
export const event = (key: string, chatId: string, extra: Partial<InboundContent> = {}): InboundContent => ({ key, accountId: "cli_sam", target: `feishu.group.${chatId}`,
  senderId: "ou_owner", conversationType: "group", messageId: `om_${key}`, source: "text", text: `${key} 的原始消息`, receivedAt: 1_700_000_000_000, ...extra });
export const one = (title: string, profileId = "executor-1") => ({ profileId, title, brief: `${title}的交办`, dependsOn: [] as number[] });

const open: AgentDispatch[] = [];
/** Closes every dispatch dispatchOn opened in this test file. */
export async function closeDispatches(): Promise<void> {
  for (const dispatch of open.splice(0)) await dispatch.close();
}

/**
 * A dispatch whose Team Leaders plan from `plans` by message and team, close with `<TEAM>_CLOSING`, and whose Coordinator places
 * parts with `placements`. A message `cancel:<request>` or `retry_report:<request>` asks that of a request and `propose:<team>`
 * proposes work for a team; any other message is a request for the team its key starts with. Deliveries listed in `rejected`
 * are refused by the platform.
 */
export function dispatchOn(path: string, executor: DispatchExecutor, options: { plans?: Record<string, unknown>; placements?: CrossTeamDecision[]; rejected?: Set<string> } = {}) {
  const leader = new FixtureTeamLeader({ leaderPlan: (messageId, teamId) => structuredClone(options.plans?.[`${messageId}:${teamId}`]), leaderSupplement: () => undefined,
    leaderClosing: (_messageId, teamId) => ({ message: `${teamId.toUpperCase()}_CLOSING` }) });
  const dispatch = new AgentDispatch(join(path, "agent-dispatch.sqlite"), {
    agents: () => agents, leader, executor, definitionsVersion: () => 1, revision: () => "r1", team: (id) => teamView(id), teams: () => ["alice", "bill"],
    roster: () => ["alice", "bill"].map((id) => ({ id, name: teamView(id)!.leader.teamName, responsibility: teamView(id)!.leader.responsibility })),
    classifier: { classify: async ({ event: inbound }) => {
      const [kind, argument] = inbound.text.split(":");
      if (kind === "cancel" || kind === "retry_report") return { kind, agentId: null, requestId: argument!, summary: "", message: "" };
      return { kind: kind === "propose" ? "propose" : "dispatch", agentId: kind === "propose" ? argument! : inbound.key.split("-")[0]!, requestId: null, summary: `${inbound.key} 的摘要`, message: "" };
    },
      assign: async () => options.placements ?? [] },
    delivery: async ({ operationId }) => options.rejected?.has(operationId) ? { ok: false, reason: "rejected", acceptedSegments: 0 } : { ok: true, acceptedSegments: 1 },
    memoryScope: { kind: "group" }, memory: { recall: () => "", capture: async () => {} },
    authorized: () => true, bindingHash: () => "binding", completedWork: () => "", presentation: () => undefined, presented: () => {}, report: () => {},
  });
  open.push(dispatch);
  return dispatch;
}
/** An Executor that answers by Assignment title: `completed` unless `outcomes` names the title; `hold` never answers until aborted. */
export function scripted(outcomes: Record<string, DispatchExecutionResult["status"] | "hold"> = {}): DispatchExecutor {
  return { run: async (_job, assignment: DispatchAssignment, signal) => {
    const outcome = outcomes[assignment.title] ?? "completed";
    if (outcome === "hold") return await new Promise<DispatchExecutionResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return { status: outcome, message: `${assignment.title}：${outcome === "completed" ? "已交付" : outcome === "waiting" ? "请选择方案" : "价格页打不开"}` };
  }, close: () => {} };
}
