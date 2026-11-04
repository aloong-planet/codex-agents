import type { SendTextResult } from "./channel-contract.js";

export type NotificationAddress = { accountId: string; target: string };
export type NotificationDestination = NotificationAddress & { channel?: "weixin" | "feishu" };
export type NotificationChannelState = { enabled: boolean; credentialStatus: "usable" | "stale"; credentialGeneration: string; contextGeneration: string | null; contextUpdatedAt?: number };
export interface NotificationChannel {
  state(destination: NotificationDestination): NotificationChannelState;
  subscribe?(listener: () => void): () => void;
  send(input: NotificationDestination & { message: string; operationId: string; beforeSubmit: () => boolean }): Promise<SendTextResult>;
}

/** Constructed once at startup. Scope names retained storage; destination names this channel. */
export class OwnerNotificationRoute {
  readonly memoryAccountId: string;
  private readonly scope: NotificationAddress;
  private readonly selected: NotificationDestination;
  private readonly destinations: NotificationDestination[];
  readonly capturesCreationDestination: boolean;

  constructor(input: { memoryAccountId: string; scope: NotificationAddress; selected: NotificationDestination & { channel: "weixin" | "feishu" }; destinations?: Array<NotificationDestination & { channel: "weixin" | "feishu" }> }) {
    if (![input.memoryAccountId, input.scope.accountId, input.scope.target, input.selected.accountId, input.selected.target]
      .every((value) => typeof value === "string" && /^[A-Za-z0-9:._@-]{1,512}$/.test(value)) ||
      !["weixin", "feishu"].includes(input.selected.channel)) throw new Error("notification_route_invalid");
    this.memoryAccountId = input.memoryAccountId;
    this.scope = { ...input.scope };
    this.selected = { ...input.selected };
    this.capturesCreationDestination = input.destinations !== undefined;
    this.destinations = (input.destinations ?? [input.selected]).map((item) => ({ ...item }));
    if (!this.destinations.length || this.destinations.some((item, index) =>
      ![item.accountId, item.target].every((value) => typeof value === "string" && /^[A-Za-z0-9:._@-]{1,512}$/.test(value)) ||
      !["weixin", "feishu"].includes(item.channel ?? "") || this.destinations.slice(0, index).some((prior) => sameAddress(item, prior))) ||
      !this.isSelected(input.selected)) throw new Error("notification_route_invalid");
  }

  scopeFor(address: NotificationAddress): NotificationAddress | undefined {
    return this.destinations.some((item) => sameAddress(address, item)) ? { ...this.scope } : undefined;
  }

  capture(address: NotificationAddress): NotificationDestination | undefined {
    const destination = this.destinations.find((item) => sameAddress(address, item));
    return destination ? { ...destination } : undefined;
  }

  resolve(scope: NotificationAddress, preference?: NotificationDestination): NotificationDestination | undefined {
    if (!sameAddress(scope, this.scope)) return undefined;
    if (preference) return this.isSelected(preference) ? { ...preference } : undefined;
    if (!this.capturesCreationDestination) return { ...this.selected };
    const destination = this.destinations.find((item) => item.channel === "feishu");
    if (!destination) throw new Error("notification_migration_feishu_binding_required");
    return { ...destination };
  }

  isSelected(destination: NotificationDestination): boolean {
    return this.destinations.some((item) => sameAddress(destination, item) && (destination.channel ?? "weixin") === item.channel);
  }

  memoryScope(accountId: string, targets: string[]): NotificationAddress | undefined {
    return accountId === this.memoryAccountId && this.destinations.some((item) => targets.includes(item.target)) ? { ...this.scope } : undefined;
  }

  captureMemory(accountId: string, target: string): NotificationDestination | undefined {
    if (accountId !== this.memoryAccountId) return undefined;
    const matches = this.destinations.filter((item) => item.target === target);
    return matches.length === 1 ? { ...matches[0]! } : undefined;
  }

  legacyMemoryDestination(accountId: string): NotificationDestination | undefined {
    return accountId === this.memoryAccountId ? this.resolve(this.scope) : undefined;
  }

  memoryDestination(accountId: string, confirmedTarget: string): NotificationDestination | undefined {
    return accountId === this.memoryAccountId && [this.scope.target, this.selected.target].includes(confirmedTarget)
      ? { ...this.selected } : undefined;
  }
}

function sameAddress(a: NotificationAddress, b: NotificationAddress): boolean {
  return a.accountId === b.accountId && a.target === b.target;
}
