import type { InboundTextEvent } from "./demo-service.js";
import { ConversationWorkflowTriggerAdapter } from "./conversation-workflow-trigger-adapter.js";
export { type ConversationWorkflowTriggerAdapterOptions as WeixinWorkflowTriggerAdapterOptions,
  type WorkflowSignalEnginePort, type WorkflowIntentPlannerPort, type WorkflowGatewayPort,
  type WorkflowShadowObserver, renderWorkflowRun, shortSignalReference,
} from "./conversation-workflow-trigger-adapter.js";

/** Compatibility boundary for callers still carrying live Weixin reply bindings. */
export class WeixinWorkflowTriggerAdapter extends ConversationWorkflowTriggerAdapter {
  override tryHandle(event: InboundTextEvent) { return super.tryHandle(event); }
  override tryHandlePending(event: InboundTextEvent) { return super.tryHandlePending(event); }
}
