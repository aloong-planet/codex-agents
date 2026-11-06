import fs from "node:fs";
import type { FinanceBinding } from "./finance-ledger.js";
import type { FeishuWebhookConfiguration } from "./feishu-webhook-receiver.js";

export type FinanceConfiguration = FinanceBinding & {
  appSecret: string; privateChatId: string; webhook: FeishuWebhookConfiguration;
};

/** Penny is optional and separate from the group roster and existing personal-channel selector. */
export function parseFinanceConfiguration(value: unknown, reserved: { apps: string[]; ports: number[] } = { apps: [], ports: [] }): FinanceConfiguration {
  try {
    const input = object(value, ["appId", "appSecret", "tenantKey", "ownerOpenId", "privateChatId", "webhook"]);
    const appId = text(input.appId), ownerOpenId = text(input.ownerOpenId), privateChatId = text(input.privateChatId);
    if (!/^cli_[a-f0-9]{16}$/iu.test(appId) || !/^ou_[A-Za-z0-9]+$/u.test(ownerOpenId) || !/^oc_[A-Za-z0-9]+$/u.test(privateChatId) ||
        reserved.apps.includes(appId)) throw new Error();
    const webhook = object(input.webhook, ["port", "path", "verificationToken", "encryptKey"]);
    if (typeof webhook.port !== "number" || !Number.isInteger(webhook.port) || webhook.port < 1 || webhook.port > 65535 ||
        reserved.ports.includes(webhook.port) || typeof webhook.path !== "string" || webhook.path.length > 200 ||
        !/^\/[A-Za-z0-9/_-]+$/u.test(webhook.path)) throw new Error();
    return { appId, ownerOpenId, privateChatId, appSecret: text(input.appSecret), tenantKey: text(input.tenantKey),
      webhook: { port: webhook.port, path: webhook.path, verificationToken: text(webhook.verificationToken), encryptKey: text(webhook.encryptKey) } };
  } catch { throw new Error("finance_configuration_invalid"); }
}

export function loadFinanceConfiguration(file: string, reserved: Parameters<typeof parseFinanceConfiguration>[1]): FinanceConfiguration {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error();
    return parseFinanceConfiguration(JSON.parse(fs.readFileSync(file, "utf8")), reserved);
  } catch { throw new Error("finance_configuration_unavailable"); }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /\s/u.test(value) ||
      [...value].some((character) => character.codePointAt(0)! < 32)) throw new Error();
  return value;
}
