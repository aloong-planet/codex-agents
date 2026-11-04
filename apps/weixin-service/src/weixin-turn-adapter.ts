import type { InboundTextEvent } from "./demo-service.js";
import type { WorkflowToolTurnBinding } from "./workflow-tool-host.js";
import type { WeixinMediaToolHost } from "./weixin-media-tool-host.js";
import { ChannelTurnAdapter } from "./channel-turn-adapter.js";

export interface WorkflowTurnToolControl {
  contractHash?(): string;
  bind(threadId: string, event: InboundTextEvent): WorkflowToolTurnBinding | Promise<WorkflowToolTurnBinding>;
}

/** Legacy Weixin binding remains outside the shared turn assembler. */
export class WeixinTurnAdapter extends ChannelTurnAdapter {
  constructor(threadId: string, event: InboundTextEvent, options: {
    accountMemory: string;
    outboundRoots: string[];
    mediaTools?: Pick<WeixinMediaToolHost, "bind">;
    workflowTools?: WorkflowTurnToolControl;
    isClosing: () => boolean;
    recoveryAllowed?: () => boolean;
  }) {
    super(threadId, event, {
      accountMemory: options.accountMemory, outboundRoots: options.outboundRoots, isClosing: options.isClosing,
      ...(options.recoveryAllowed ? { recoveryAllowed: options.recoveryAllowed } : {}),
      channelLabel: "微信", outboundDelivery: true,
      ...(options.mediaTools ? { bindMedia: () => options.mediaTools!.bind(threadId, event, options.outboundRoots) } : {}),
      ...(options.workflowTools ? { workflowTools: { bind: () => options.workflowTools!.bind(threadId, event) } } : {}),
    });
  }
}
