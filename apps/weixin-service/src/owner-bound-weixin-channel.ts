import type { WeixinChannel } from "./demo-service.js";
import type { PersonalOwnerIdentity } from "./personal-owner-identity.js";

/** Restricts the legacy panel and command hooks as well as the conversation boundary. */
export function bindWeixinOwner(channel: WeixinChannel, owner: PersonalOwnerIdentity): WeixinChannel {
  const owns = (input: { accountId: string; target: string }) => owner.ownsAddress(input.accountId, input.target);
  const snapshot = () => {
    const value = channel.getSnapshot();
    return { accounts: value.accounts.filter((account) => account.accountId === owner.conversationAddress().accountId),
      targets: value.targets.filter(owns) };
  };
  return {
    getSnapshot: snapshot,
    onSnapshotChanged: (listener) => channel.onSnapshotChanged(() => listener(snapshot())),
    start: async () => {
      if (!snapshot().accounts.some((account) => account.credentialStatus === "usable")) throw new Error("weixin_owner_credentials_unavailable");
      await channel.start();
      if (!snapshot().accounts.some((account) => account.credentialStatus === "usable")) throw new Error("weixin_owner_credentials_unavailable");
    },
    activateInboundDispatch: () => channel.activateInboundDispatch?.(),
    pauseInboundDispatch: () => channel.pauseInboundDispatch?.(),
    close: () => channel.close(),
    startLogin: (onEvent, onExit) => channel.startLogin(onEvent, onExit),
    updateLocalLabels: (input) => {
      if (input.accountId !== owner.conversationAddress().accountId || (input.target !== undefined && !owns({ accountId: input.accountId, target: input.target }))) {
        throw new Error("owner_identity_unbound");
      }
      channel.updateLocalLabels(input);
    },
    sendText: (input) => owns(input) ? channel.sendText(input) : Promise.resolve({ ok: false, reason: "unavailable", acceptedSegments: 0 }),
    ...(channel.getDeliveryContext ? { getDeliveryContext: (accountId: string, target: string) => owns({ accountId, target })
      ? channel.getDeliveryContext!(accountId, target) : { credentialGeneration: "unbound", contextGeneration: null, credentialStatus: "stale" as const } } : {}),
    ...(channel.onInboundText ? { onInboundText: (listener) => channel.onInboundText!((event) => owns(event) ? listener(event) : undefined) } : {}),
    ...(channel.onInboundRejected ? { onInboundRejected: (listener) => channel.onInboundRejected!((event) => owns(event) ? listener(event) : undefined) } : {}),
    ...(channel.onInboundCommand ? { onInboundCommand: (handler) => channel.onInboundCommand!((event) => owns(event) ? handler(event) : false) } : {}),
  };
}
