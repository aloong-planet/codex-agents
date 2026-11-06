import { expect, it } from "vitest";
import { parseFinanceConfiguration } from "../src/finance-config.js";

// Local configuration contract, not proof of live application identity or platform permissions.
it("requires a complete separate private binding without exposing rejected configuration values", () => {
  const config = { appId: "cli_123456789abcdef0", appSecret: "fixture-secret", tenantKey: "fixture-tenant", ownerOpenId: "ou_pennyowner",
    privateChatId: "oc_pennyprivate", webhook: { port: 4319, path: "/feishu/penny/events", verificationToken: "fixture-token", encryptKey: "fixture-key" } };
  expect(parseFinanceConfiguration(config, { apps: ["cli_0123456789abcdef"], ports: [4317, 4318] }))
    .toMatchObject({ appId: "cli_123456789abcdef0", ownerOpenId: "ou_pennyowner", privateChatId: "oc_pennyprivate", webhook: { port: 4319 } });
  for (const invalid of [{ ...config, groups: ["oc_group"] }, { ...config, tenantKey: "" }, { ...config, appSecret: "" },
    { ...config, ownerOpenId: "Sam" }, { ...config, webhook: { ...config.webhook, path: "/api/state?all" } }]) {
    expect(() => parseFinanceConfiguration(invalid)).toThrow(/^finance_configuration_invalid$/u);
  }
  expect(() => parseFinanceConfiguration(config, { apps: ["cli_123456789abcdef0"], ports: [] })).toThrow("finance_configuration_invalid");
  expect(() => parseFinanceConfiguration(config, { apps: [], ports: [4319] })).toThrow("finance_configuration_invalid");
});
