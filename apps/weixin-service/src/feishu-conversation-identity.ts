import { createHash } from "node:crypto";
import type { ChannelConversationIdentity, PersonalInboundIdentity, PersonalOwnerIdentity } from "./personal-owner-identity.js";

export type FeishuGroupConfiguration = { chatId: string; allowedSenderIds: readonly string[] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Startup-only group authority; the transport account is shared, the conversation scope is not. */
export class FeishuConversationIdentity implements ChannelConversationIdentity {
  readonly memoryAccountId: string;
  private readonly groups: Array<FeishuGroupConfiguration & { target: string; memoryScope: string; bindingHash: string }>;

  constructor(private readonly personal: PersonalOwnerIdentity, private readonly appId: string, input: unknown) {
    this.memoryAccountId = personal.memoryAccountId;
    if (!Array.isArray(input) || input.length > 98) throw new Error("feishu_groups_invalid");
    const seen = new Set<string>();
    const address = personal.conversationAddress();
    const privateChat = personal.deliveryTarget(address.accountId, address.target);
    this.groups = input.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("feishu_groups_invalid");
      const group = value as Record<string, unknown>;
      if (typeof group.chatId !== "string" || !/^oc_[A-Za-z0-9]+$/.test(group.chatId) || group.chatId.length > 200 ||
          seen.has(group.chatId) || group.chatId === privateChat ||
          !Array.isArray(group.allowedSenderIds) || group.allowedSenderIds.length > 200 ||
          group.allowedSenderIds.some((id: unknown) => typeof id !== "string" || !/^ou_[A-Za-z0-9]+$/.test(id) || id.length > 200) ||
          new Set(group.allowedSenderIds).size !== group.allowedSenderIds.length) throw new Error("feishu_groups_invalid");
      seen.add(group.chatId);
      const allowedSenderIds = [...group.allowedSenderIds as string[]].sort();
      return { chatId: group.chatId, allowedSenderIds, target: `feishu.group.${hash([appId, group.chatId])}`,
        memoryScope: `feishu.group.${hash(["memory", appId, group.chatId])}`,
        bindingHash: hash(["group", appId, group.chatId, allowedSenderIds]) };
    });
  }

  conversationAddress() { return this.personal.conversationAddress(); }
  conversationAddresses() {
    return [this.conversationAddress(), ...this.groups.map(({ target }) => ({ accountId: this.conversationAddress().accountId, target }))];
  }
  groupAddress(chatId: string) {
    const group = this.groups.find((item) => item.chatId === chatId);
    return group ? { accountId: this.conversationAddress().accountId, target: group.target } : undefined;
  }
  get hasGroups(): boolean { return this.groups.length > 0; }
  admit(identity: PersonalInboundIdentity) {
    if (identity.conversationType !== "group") return this.personal.admit(identity);
    const group = this.groups.find((item) => item.chatId === identity.target);
    return identity.accountId === this.appId && group?.allowedSenderIds.includes(identity.senderId ?? "") ? this.groupAddress(group.chatId) : undefined;
  }
  ownsAccount(accountId: string) { return this.personal.ownsAccount(accountId); }
  ownsAddress(accountId: string, target: string) {
    return this.ownsAccount(accountId) && (this.personal.ownsAddress(accountId, target) || this.groups.some((item) => item.target === target));
  }
  accepts(identity: PersonalInboundIdentity): boolean {
    if (identity.conversationType !== "group") return this.personal.accepts(identity);
    return this.ownsAccount(identity.accountId) && this.groups.some((item) => item.target === identity.target && item.allowedSenderIds.includes(identity.senderId ?? ""));
  }
  contextHash(accountId = this.conversationAddress().accountId, target = this.conversationAddress().target): string {
    if (this.personal.ownsAddress(accountId, target)) return this.personal.contextHash();
    const group = this.groups.find((item) => this.ownsAccount(accountId) && item.target === target);
    if (!group) throw new Error("owner_identity_unbound");
    return group.bindingHash;
  }
  memoryScope(accountId: string, target?: string): string {
    if (target === undefined || this.personal.ownsAddress(accountId, target)) return this.personal.memoryScope(accountId, target);
    const group = this.groups.find((item) => this.ownsAccount(accountId) && item.target === target);
    if (!group) throw new Error("owner_identity_unbound");
    return group.memoryScope;
  }
  deliveryTarget(accountId: string, target: string): string | undefined {
    return this.personal.deliveryTarget(accountId, target) ?? this.groups.find((item) => this.ownsAccount(accountId) && item.target === target)?.chatId;
  }
}
