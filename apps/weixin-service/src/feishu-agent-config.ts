import type { FeishuConversationIdentity } from "./feishu-conversation-identity.js";
import type { DispatchAgentDefinition } from "./agent-dispatch-types.js";
import { COORDINATOR_ID } from "./team-registry.js";

export type FeishuDispatchAgent = DispatchAgentDefinition & { appId: string; appSecret: string };
export type FeishuDispatchConfiguration = { groupChatIds: readonly string[]; agents: readonly Readonly<FeishuDispatchAgent>[] };

const defaults: Readonly<Record<string, Omit<DispatchAgentDefinition, "id">>> = {
  [COORDINATOR_ID]: { name: "Sam", responsibility: "协调、澄清和分派任务，不执行具体业务事务。" },
  alice: { name: "Alice", responsibility: "闲鱼、淘宝等网站运营，包括商品文案、上架材料和经营分析。" },
  bill: { name: "Bill", responsibility: "日常生活事务，包括吃穿住行的规划和安排。" },
  jack: { name: "Jack", responsibility: "技术事务和开发需求，包括代码分析、补丁、测试设计和技术研究。" },
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_configuration_invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some((character) => character.charCodeAt(0) < 32)) throw new Error("agent_configuration_invalid");
  return value.trim();
}

export function parseFeishuDispatch(value: unknown, coordinator: { appId: string; appSecret: string }, owner: FeishuConversationIdentity): Readonly<FeishuDispatchConfiguration> {
  const input = record(value);
  if (Object.keys(input).some((key) => !["groupChatIds", "agents"].includes(key)) ||
      !Array.isArray(input.groupChatIds) || input.groupChatIds.length < 1 || input.groupChatIds.length > 98 ||
      input.groupChatIds.some((chatId) => typeof chatId !== "string" || !owner.groupAddress(chatId)) ||
      new Set(input.groupChatIds).size !== input.groupChatIds.length ||
      !Array.isArray(input.agents) || input.agents.length < 4 || input.agents.length > 16) throw new Error("agent_configuration_invalid");
  const agents = input.agents.map((value): Readonly<FeishuDispatchAgent> => {
    const agent = record(value), id = text(agent.id, 32);
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || Object.keys(agent).some((key) => !["id", "name", "responsibility", "appId", "appSecret"].includes(key))) throw new Error("agent_configuration_invalid");
    const name = text(agent.name ?? defaults[id]?.name, 40), responsibility = text(agent.responsibility ?? defaults[id]?.responsibility, 2000);
    if (id === COORDINATOR_ID && (agent.appId !== undefined || agent.appSecret !== undefined)) throw new Error("agent_configuration_invalid");
    const appId = id === COORDINATOR_ID ? coordinator.appId : text(agent.appId, 32);
    const appSecret = id === COORDINATOR_ID ? coordinator.appSecret : text(agent.appSecret, 512);
    if (!/^cli_[a-fA-F0-9]{16}$/.test(appId) || /\s/u.test(appSecret)) throw new Error("agent_configuration_invalid");
    return Object.freeze({ id, name, responsibility, appId, appSecret });
  });
  if (Object.keys(defaults).some((id) => !agents.some((agent) => agent.id === id)) ||
      new Set(agents.map(({ id }) => id)).size !== agents.length ||
      new Set(agents.map(({ appId }) => appId)).size !== agents.length) throw new Error("agent_configuration_invalid");
  return Object.freeze({ groupChatIds: Object.freeze([...input.groupChatIds] as string[]), agents: Object.freeze(agents) });
}
