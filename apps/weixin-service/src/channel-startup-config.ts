import { readFileSync } from "node:fs";
import { PersonalOwnerIdentity, type PersonalChannel, type PersonalChannelBinding, type PersonalOwnerConfiguration } from "./personal-owner-identity.js";
import { OwnerNotificationRoute, type NotificationAddress } from "./notification-channel.js";

export type ChannelStartupEntry = {
  owner: PersonalOwnerIdentity;
  binding: Readonly<PersonalChannelBinding>;
} & (
  | { channel: "weixin" }
  | { channel: "feishu"; connection: Readonly<{ appId: string; appSecret: string }> }
);
export type ChannelStartupConfiguration = ChannelStartupEntry & {
  enabledChannels: readonly PersonalChannel[];
  entries: readonly ChannelStartupEntry[];
  taskScope: Readonly<NotificationAddress>;
  notificationRoute: OwnerNotificationRoute;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("channel_configuration_invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /\s/u.test(value) || Array.from(value).some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("channel_configuration_invalid");
  }
  return value;
}

/** Parse once before constructing either transport. Never includes input values in errors. */
export function parseChannelStartupConfiguration(value: unknown): ChannelStartupConfiguration {
  try {
    const config = record(value);
    const choices = config.enabledChannels === undefined ? [config.channel] : config.enabledChannels;
    if (!Array.isArray(choices) || choices.length === 0 || choices.length > 2 ||
        choices.some((choice) => choice !== "weixin" && choice !== "feishu") ||
        new Set(choices).size !== choices.length ||
        (config.enabledChannels !== undefined && config.channel !== undefined &&
          (choices.length !== 1 || choices[0] !== config.channel))) throw new Error("channel_selector_invalid");
    const enabledChannels = Object.freeze([...choices] as PersonalChannel[]);
    const ownerInput = record(config.owner);
    if (!Array.isArray(ownerInput.bindings)) throw new Error("owner_binding_invalid");
    const ownerConfig: PersonalOwnerConfiguration = {
      memoryAccountId: text(ownerInput.memoryAccountId),
      bindings: ownerInput.bindings.map((value) => {
        const binding = record(value);
        if (binding.channel !== "weixin" && binding.channel !== "feishu") throw new Error("owner_binding_invalid");
        return { channel: binding.channel, accountId: text(binding.accountId), target: text(binding.target), senderId: text(binding.senderId) };
      }),
    };
    const bound = ownerConfig.bindings.map((binding) => {
      const owner = new PersonalOwnerIdentity(ownerConfig, binding.channel);
      if (binding.channel === "feishu" && (!/^cli_[0-9a-fA-F]{16}$/.test(binding.accountId) ||
          !/^oc_[A-Za-z0-9]+$/.test(binding.target) || !/^ou_[A-Za-z0-9]+$/.test(binding.senderId))) {
        throw new Error("feishu_binding_invalid");
      }
      return { owner, binding: Object.freeze({ ...binding }) };
    });
    const entries = Object.freeze(enabledChannels.map((channel): ChannelStartupEntry => {
      const selected = bound.find((item) => item.binding.channel === channel);
      if (!selected) throw new Error("owner_channel_unbound");
      if (channel === "weixin") return Object.freeze({ ...selected, channel });
      const connection = record(config.feishu);
      const appId = text(connection.appId);
      const appSecret = text(connection.appSecret);
      if (appId !== selected.binding.accountId) throw new Error("feishu_binding_invalid");
      return Object.freeze({ ...selected, channel, connection: Object.freeze({ appId, appSecret }) });
    }));
    // This explicit, stable address names existing task storage, not the new recipient.
    const scopeInput = record(config.taskScope);
    const taskScope = Object.freeze({ accountId: text(scopeInput.accountId), target: text(scopeInput.target) });
    const first = entries[0]!;
    const notificationRoute = new OwnerNotificationRoute({
      memoryAccountId: first.owner.memoryAccountId, scope: taskScope,
      selected: { channel: first.channel, ...first.owner.conversationAddress() },
      // A disabled binding can retain a preference, but has no active delivery port.
      destinations: bound.map(({ owner, binding }) => ({ channel: binding.channel, ...owner.conversationAddress() })),
    });
    return Object.freeze({ ...first, enabledChannels, entries, taskScope, notificationRoute });
  } catch {
    throw new Error("channel_startup_configuration_invalid");
  }
}

export function loadChannelStartupConfiguration(path: string | undefined): ChannelStartupConfiguration {
  if (!path) throw new Error("channel_startup_configuration_required");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("channel_startup_configuration_unreadable"); }
  return parseChannelStartupConfiguration(value);
}
