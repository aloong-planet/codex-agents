import { readFileSync } from "node:fs";
import { PersonalOwnerIdentity, type PersonalChannel, type PersonalChannelBinding, type PersonalOwnerConfiguration } from "./personal-owner-identity.js";
import { OwnerNotificationRoute, type NotificationAddress } from "./notification-channel.js";
import { FeishuConversationIdentity } from "./feishu-conversation-identity.js";
import type { FeishuWebhookConfiguration } from "./feishu-webhook-receiver.js";
import { parseFeishuDispatch, type LocalDispatchConfiguration } from "./feishu-agent-config.js";

export type ChannelStartupEntry = {
  binding: Readonly<PersonalChannelBinding>;
} & (
  | { channel: "weixin"; owner: PersonalOwnerIdentity }
  | { channel: "feishu"; owner: FeishuConversationIdentity; connection: Readonly<{ appId: string; appSecret: string }>; webhook?: Readonly<FeishuWebhookConfiguration>; dispatch?: Readonly<LocalDispatchConfiguration> }
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
      if (connection.receiveMode !== undefined && !["websocket", "webhook"].includes(String(connection.receiveMode))) throw new Error("feishu_receive_mode_invalid");
      let webhook: Readonly<FeishuWebhookConfiguration> | undefined;
      if (connection.receiveMode === "webhook") {
        const input = record(connection.webhook);
        if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
            typeof input.path !== "string" || input.path.length > 200 || !/^\/[A-Za-z0-9/_-]+$/.test(input.path) ||
            Object.keys(input).some((key) => !["port", "path", "verificationToken", "encryptKey"].includes(key))) throw new Error("feishu_webhook_invalid");
        webhook = Object.freeze({ port: input.port, path: input.path, verificationToken: text(input.verificationToken), encryptKey: text(input.encryptKey) });
      } else if (connection.webhook !== undefined) throw new Error("feishu_receive_mode_invalid");
      const owner = new FeishuConversationIdentity(selected.owner, appId, connection.groups === undefined ? [] : connection.groups);
      const dispatch = connection.dispatch === undefined ? undefined : parseFeishuDispatch(connection.dispatch, { appId, appSecret }, owner);
      return Object.freeze({ ...selected, channel, owner, connection: Object.freeze({ appId, appSecret }), ...(webhook ? { webhook } : {}), ...(dispatch ? { dispatch } : {}) });
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
      groups: entries.filter((entry) => entry.channel === "feishu").flatMap(({ owner }) => owner.conversationAddresses()
        .filter((address) => address.target !== owner.conversationAddress().target)
        .map((address) => ({ memoryAccountId: owner.memoryScope(address.accountId, address.target), destination: { channel: "feishu" as const, ...address } }))),
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
