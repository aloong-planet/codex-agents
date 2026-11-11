import path from "node:path";
import { MEMORY_CURATOR_RUNTIME_PROFILE } from "./codex-account-memory-curator.js";
import type { CodexConversationOptions } from "./codex-conversation.js";
import { createIsolatedModelRuntime, type IsolatedModelRuntime } from "./isolated-model-runtime.js";
import { PENDING_RESPONSE_RUNTIME_PROFILE } from "./workflow-pending-response-router.js";

type ConversationKind = {
  process: "app-server";
  /** Directory under the service state directory that holds this kind's runtime roots. */
  directory: string;
  /** A fixed scope, or how an instance (group target, dispatch scope) names its own. */
  scope: string | ((instance: string) => string);
  /** Whether its threads get host tools: the workflow tools, or a narrower view the caller passes (a dispatch agent's profile). */
  hostTools: boolean;
  /** Whether the caller may make one inbound-media directory readable. */
  readsMedia: boolean;
  /** Whether the host writes skills into its home: every creation then leaves exactly the skills the caller writes, or none. */
  skills: boolean;
  /** "capability" follows the App Server probe; "required" always asks for it. */
  structuredOutput?: "capability" | "required";
  serviceName: string | ((agentId: string) => string);
  conversation: Pick<CodexConversationOptions, "webSearch" | "automaticRecovery" | "runtimeProfile">;
};
type ExecKind = { process: "exec"; directory: string; scope: (instance: string) => string; readsMedia: false; skills: false };

/** Every isolated runtime the service runs (ADR-0023). main.ts creates them only from this table, and the tests drive
 * each entry, so a runtime's root and options are written down once. */
export const ISOLATED_RUNTIME_KINDS = {
  feishuGroup: { process: "app-server", directory: "group-model-runtimes", scope: (target) => target, hostTools: true, readsMedia: true, skills: false,
    structuredOutput: "capability", serviceName: "feishu_group", conversation: { webSearch: "live", automaticRecovery: true } },
  dispatchCoordinator: { process: "app-server", directory: "group-model-runtimes", scope: "dispatch-coordinator", hostTools: false, readsMedia: false, skills: false,
    structuredOutput: "capability", serviceName: "feishu_dispatch_coordinator", conversation: { webSearch: "disabled" } },
  dispatchLeader: { process: "app-server", directory: "group-model-runtimes", scope: (scope) => scope, hostTools: false, readsMedia: false, skills: false,
    structuredOutput: "capability", serviceName: "feishu_dispatch_leader", conversation: { webSearch: "disabled" } },
  // An Executor's: it loads the skills its Agent Profile selects, and no other (agent-dispatch::REQ-016/AC-04).
  dispatchAgent: { process: "app-server", directory: "group-model-runtimes", scope: (scope) => scope, hostTools: true, readsMedia: true, skills: true,
    structuredOutput: "capability", serviceName: (agentId) => `feishu_agent_${agentId}`, conversation: { webSearch: "live", automaticRecovery: true } },
  // The owner's private conversations in the console, one runtime per agent, kept apart from every group runtime (agent-console::CON-002).
  privateChat: { process: "app-server", directory: "private-chat-runtimes", scope: (agentId) => `private-chat-${agentId}`, hostTools: false, readsMedia: false, skills: false,
    structuredOutput: "capability", serviceName: "console_private_chat", conversation: { webSearch: "disabled" } },
  pendingRouter: { process: "app-server", directory: "group-model-runtimes", scope: "pending-router", hostTools: false, readsMedia: false, skills: false,
    serviceName: "feishu_group_pending", conversation: { webSearch: "disabled", runtimeProfile: PENDING_RESPONSE_RUNTIME_PROFILE } },
  groupMemoryCurator: { process: "app-server", directory: "group-model-runtimes", scope: "memory-curator", hostTools: false, readsMedia: false, skills: false,
    serviceName: "feishu_group_memory", conversation: { webSearch: "disabled", runtimeProfile: MEMORY_CURATOR_RUNTIME_PROFILE } },
  research: { process: "exec", directory: "group-model-runtimes", scope: (target) => `research-${target}`, readsMedia: false, skills: false },
  penny: { process: "app-server", directory: path.join("penny", "model-runtimes"), scope: "penny", hostTools: false, readsMedia: true, skills: false,
    structuredOutput: "required", serviceName: "penny", conversation: { webSearch: "disabled", automaticRecovery: true } },
} as const satisfies Record<string, ConversationKind | ExecKind>;

export type IsolatedRuntimeKind = keyof typeof ISOLATED_RUNTIME_KINDS;
export type IsolatedConversationKind = { [K in IsolatedRuntimeKind]: typeof ISOLATED_RUNTIME_KINDS[K] extends { process: "app-server" } ? K : never }[IsolatedRuntimeKind];

export function createIsolatedRuntime(kind: IsolatedRuntimeKind, options: {
  stateDirectory: string;
  instance?: string;
  mediaRoot?: string;
  authHome?: string;
  environment?: NodeJS.ProcessEnv;
  /** Writes the skills of the runtime's Agent Profile into the directory it is given; only for a kind that loads skills. */
  skills?: (directory: string) => void;
}): IsolatedModelRuntime {
  const entry: ConversationKind | ExecKind = ISOLATED_RUNTIME_KINDS[kind];
  if (options.mediaRoot !== undefined && !entry.readsMedia) throw new Error("isolated_runtime_media_unexpected");
  if (options.skills !== undefined && !entry.skills) throw new Error("isolated_runtime_skills_unexpected");
  if ((typeof entry.scope === "string") !== (options.instance === undefined)) throw new Error("isolated_runtime_instance_invalid");
  return createIsolatedModelRuntime({
    root: path.join(options.stateDirectory, entry.directory),
    scope: typeof entry.scope === "string" ? entry.scope : entry.scope(options.instance!),
    ...(options.mediaRoot !== undefined ? { readableRoots: [options.mediaRoot] } : {}),
    ...(options.authHome !== undefined ? { authHome: options.authHome } : {}),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    // A kind that loads skills gets its skills directory emptied at every creation, also when the caller writes none.
    ...(entry.skills ? { skills: options.skills ?? (() => {}) } : {}),
  });
}

export function isolatedConversationOptions(kind: IsolatedConversationKind, runtime: IsolatedModelRuntime,
  options: { structuredOutputSupported: boolean; agentId?: string }): CodexConversationOptions {
  const entry: ConversationKind = ISOLATED_RUNTIME_KINDS[kind];
  if ((typeof entry.serviceName === "function") !== (options.agentId !== undefined)) throw new Error("isolated_runtime_agent_invalid");
  return {
    serviceName: typeof entry.serviceName === "function" ? entry.serviceName(options.agentId!) : entry.serviceName,
    ...entry.conversation,
    ...(entry.structuredOutput === "capability" ? { structuredOutputSupported: options.structuredOutputSupported }
      : entry.structuredOutput === "required" ? { structuredOutputSupported: true } : {}),
    permissionProfile: runtime.permissionProfile,
  };
}
