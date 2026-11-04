import type { PersonalOwnerIdentity } from "./personal-owner-identity.js";
import { ConversationService, type CodexAgent, type VaultCapabilityControl, type AccountMemoryControl,
  type InboundWorkflowControl as CoreInboundWorkflowControl, type CompletedInboundObserver as CoreCompletedInboundObserver } from "./conversation-service.js";
import type { InboundTextEvent, WeixinChannel } from "./demo-service.js";
import type { CodexServiceStore } from "./codex-service-store.js";
import type { CodexDesktopNavigator } from "./codex-desktop.js";
import type { LocalDiagnostics } from "./local-diagnostics.js";
import type { WeixinMediaToolHost } from "./weixin-media-tool-host.js";
import { WeixinConversationChannel } from "./weixin-conversation-channel.js";
import { WeixinTurnAdapter, type WorkflowTurnToolControl } from "./weixin-turn-adapter.js";

export type { CodexAgent, VaultCapabilityControl, AccountMemoryControl, PermissionSelection, PublicCodexServiceState } from "./conversation-service.js";
export interface InboundWorkflowControl {
  tryHandlePending?(event: InboundTextEvent): ReturnType<NonNullable<CoreInboundWorkflowControl["tryHandlePending"]>>;
  tryHandle(event: InboundTextEvent): ReturnType<CoreInboundWorkflowControl["tryHandle"]>;
}
export interface CompletedInboundObserver { observe(event: InboundTextEvent): void }

/** Compatibility composition for the existing Weixin entry points and stored identities. */
export class WeixinCodexService extends ConversationService {
  constructor(
    channel: Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected">,
    agent: CodexAgent,
    store: CodexServiceStore,
    cwd: string,
    now: () => number = Date.now,
    vault?: VaultCapabilityControl,
    runtimeWorkspaceRoots: string[] = [cwd],
    restrictedReadSupported = false,
    mediaReadRoot?: string,
    mediaTools?: WeixinMediaToolHost,
    desktop?: CodexDesktopNavigator,
    memory?: AccountMemoryControl,
    inboundWorkflows?: InboundWorkflowControl,
    completedInboundObserver?: CompletedInboundObserver,
    workflowTools?: WorkflowTurnToolControl,
    diagnostics?: LocalDiagnostics,
    owner?: PersonalOwnerIdentity,
  ) {
    const adapter = new WeixinConversationChannel(channel);
    const workflows: CoreInboundWorkflowControl | undefined = inboundWorkflows ? {
      tryHandle: (message) => inboundWorkflows.tryHandle(adapter.legacy(message)),
      ...(inboundWorkflows.tryHandlePending ? {
        tryHandlePending: (message: Parameters<CoreInboundWorkflowControl["tryHandle"]>[0]) => inboundWorkflows.tryHandlePending!(adapter.legacy(message)),
      } : {}),
    } : undefined;
    const observer: CoreCompletedInboundObserver | undefined = completedInboundObserver ? {
      observe: (message) => completedInboundObserver.observe(adapter.legacy(message)),
    } : undefined;
    super(adapter, agent, store, cwd, now, vault, runtimeWorkspaceRoots, restrictedReadSupported, mediaReadRoot, {
      prepare: (threadId, message, options) => new WeixinTurnAdapter(threadId, adapter.legacy(message), {
        ...options, ...(mediaTools ? { mediaTools } : {}), ...(workflowTools ? { workflowTools } : {}),
      }),
    }, desktop, memory, workflows, observer, workflowTools, diagnostics, owner);
  }
}
