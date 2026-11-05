import { createHash } from "node:crypto";

export type PersonalChannel = "weixin" | "feishu";
export type PersonalChannelBinding = {
  channel: PersonalChannel;
  accountId: string;
  target: string;
  senderId: string;
};
export type PersonalOwnerConfiguration = {
  memoryAccountId: string;
  bindings: PersonalChannelBinding[];
};
export type PersonalInboundIdentity = {
  accountId: string;
  target: string;
  senderId?: string;
  conversationType?: "private" | "group";
};

export interface ConversationOwner {
  ownsAccount(accountId: string): boolean;
  ownsAddress(accountId: string, target: string): boolean;
  accepts(identity: PersonalInboundIdentity): boolean;
  contextHash(accountId: string, target: string): string;
  memoryScope(accountId: string, target?: string): string;
}

export interface ChannelConversationIdentity extends ConversationOwner {
  readonly memoryAccountId: string;
  conversationAddress(): { accountId: string; target: string };
  conversationAddresses(): Array<{ accountId: string; target: string }>;
  admit(identity: PersonalInboundIdentity): { accountId: string; target: string } | undefined;
  deliveryTarget(accountId: string, target: string): string | undefined;
}

/** Startup-only host binding. The legacy memory key is independent of transport IDs. */
export class PersonalOwnerIdentity {
  readonly memoryAccountId: string;
  private readonly binding: PersonalChannelBinding;
  private readonly address: { accountId: string; target: string };

  constructor(configuration: PersonalOwnerConfiguration, channel: PersonalChannel) {
    if (typeof configuration.memoryAccountId !== "string" || !/^[A-Za-z0-9._@-]{1,200}$/.test(configuration.memoryAccountId) ||
        configuration.bindings.length < 1 || configuration.bindings.length > 2) {
      throw new Error("owner_binding_invalid");
    }
    const channels = new Set<PersonalChannel>();
    for (const binding of configuration.bindings) {
      if (!["weixin", "feishu"].includes(binding.channel) || channels.has(binding.channel) ||
          ![binding.accountId, binding.target, binding.senderId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/\s/u.test(value) && !Array.from(value).some((character) => character.charCodeAt(0) < 32))) {
        throw new Error("owner_binding_invalid");
      }
      if (binding.channel === "weixin" && (!/^[A-Za-z0-9._@-]{1,200}$/.test(binding.accountId) ||
          !/^[A-Za-z0-9._-]+@im\.wechat$/.test(binding.target) || binding.senderId !== binding.target)) {
        throw new Error("owner_binding_invalid");
      }
      channels.add(binding.channel);
    }
    const selected = configuration.bindings.find((binding) => binding.channel === channel);
    if (!selected) throw new Error("owner_channel_unbound");
    this.binding = { ...selected };
    this.memoryAccountId = configuration.memoryAccountId;
    const scoped = (value: string) => `feishu.${createHash("sha256").update(value).digest("hex")}`;
    this.address = channel === "weixin"
      ? { accountId: selected.accountId, target: selected.target }
      : { accountId: scoped(selected.accountId), target: scoped(selected.target) };
  }

  contextHash(): string {
    return createHash("sha256").update(JSON.stringify([this.memoryAccountId, this.binding.channel, this.binding.accountId, this.binding.target, this.binding.senderId])).digest("hex");
  }

  conversationAddress(): { accountId: string; target: string } { return { ...this.address }; }
  conversationAddresses() { return [this.conversationAddress()]; }
  deliveryTarget(accountId: string, target: string): string | undefined {
    return this.ownsAddress(accountId, target) ? this.binding.target : undefined;
  }

  /** Called by a transport after decoding the authenticated platform event. */
  admit(identity: PersonalInboundIdentity): { accountId: string; target: string } | undefined {
    if (identity.accountId !== this.binding.accountId || identity.target !== this.binding.target ||
        identity.senderId !== this.binding.senderId || identity.conversationType !== "private") return undefined;
    return this.conversationAddress();
  }

  ownsAccount(accountId: string): boolean { return accountId === this.address.accountId; }

  ownsAddress(accountId: string, target: string): boolean {
    return accountId === this.address.accountId && target === this.address.target;
  }

  accepts(identity: PersonalInboundIdentity): boolean {
    return this.ownsAddress(identity.accountId, identity.target) &&
      identity.senderId === this.binding.senderId && identity.conversationType === "private";
  }

  memoryScope(accountId: string, target?: string): string {
    if (accountId !== this.address.accountId || (target !== undefined && target !== this.address.target)) throw new Error("owner_account_unbound");
    return this.memoryAccountId;
  }
}

/** One owner, multiple independently bound conversations; no duplicate mutable core. */
export class PersonalOwnerDirectory implements ConversationOwner {
  private readonly identities: readonly ChannelConversationIdentity[];

  constructor(identities: readonly ChannelConversationIdentity[]) {
    if (identities.length === 0 || new Set(identities.map((identity) => identity.memoryAccountId)).size !== 1 ||
        new Set(identities.map((identity) => identity.conversationAddress().accountId)).size !== identities.length) {
      throw new Error("owner_directory_invalid");
    }
    this.identities = [...identities];
  }

  ownsAccount(accountId: string): boolean { return this.identities.some((identity) => identity.ownsAccount(accountId)); }
  ownsAddress(accountId: string, target: string): boolean { return this.identities.some((identity) => identity.ownsAddress(accountId, target)); }
  accepts(identity: PersonalInboundIdentity): boolean { return this.identities.some((owner) => owner.accepts(identity)); }
  contextHash(accountId: string, target: string): string {
    const identity = this.identities.find((owner) => owner.ownsAddress(accountId, target));
    if (!identity) throw new Error("owner_identity_unbound");
    return identity.contextHash(accountId, target);
  }
  memoryScope(accountId: string, target?: string): string {
    const identity = this.identities.find((owner) => owner.ownsAccount(accountId));
    if (!identity) throw new Error("owner_account_unbound");
    return identity.memoryScope(accountId, target);
  }
}
