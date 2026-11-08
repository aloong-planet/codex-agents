// Two installed plugin processes against one real service (agent-console::US-001/AC-05): they share one
// credential, so the service keeps one 「Codex 插件」 entry and polling causes no re-authorization; after the
// owner revokes the entry they come back as one new entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requestConsoleControl } from "../../../apps/weixin-service/src/console-control.js";
import { startFixtureService, type FixtureService } from "./support/fixture-service.js";

const port = 4329;
const baseUrl = `http://127.0.0.1:${port}`;
const serverEntry = path.resolve(process.cwd(), "dist/server.mjs");
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-plugin-credential-"));

/** Ids of the service's 「Codex 插件」 entries. */
async function pluginEntries(): Promise<string[]> {
  const { browsers } = await requestConsoleControl(stateDirectory, { command: "list" });
  return (browsers as Array<{ id: string; label: string }>).filter((browser) => browser.label === "Codex 插件").map((browser) => browser.id);
}

function pluginAuthorizations(): number {
  const audit = path.join(fs.realpathSync(stateDirectory), "console-audit.jsonl");
  return fs.readFileSync(audit, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { by: string; event: string })
    .filter((entry) => entry.by === "codex-plugin" && entry.event === "browser_authorized").length;
}

async function startPlugin(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, WEIXIN_DEMO_BASE_URL: baseUrl, WEIXIN_DEMO_STATE_DIR: stateDirectory } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "plugin-credential-e2e", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function readState(client: Client) {
  const result = await client.callTool({ name: "get_weixin_state", arguments: {} });
  if ("toolResult" in result) throw new Error("unexpected task result");
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ phase: expect.any(String) });
}

describe("installed plugin processes share one local authorization", () => {
  let service: FixtureService | undefined;
  const plugins: Client[] = [];

  beforeAll(async () => {
    service = await startFixtureService({ port, stateDirectory });
    plugins.push(...await Promise.all([startPlugin(), startPlugin()]));
  }, 20_000);

  afterAll(async () => {
    await Promise.all(plugins.map((plugin) => plugin.close()));
    await service?.stop();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  });

  it("keeps one entry while both poll, and returns as one new entry after a revocation", async () => {
    const [first, second] = plugins as [Client, Client];
    await Promise.all([readState(first), readState(second)]);
    const [entry] = await pluginEntries();
    expect(await pluginEntries()).toHaveLength(1);
    expect(pluginAuthorizations()).toBe(1);

    for (let round = 0; round < 4; round += 1) {
      await readState(first);
      await readState(second);
    }
    expect(await pluginEntries()).toEqual([entry]);
    expect(pluginAuthorizations()).toBe(1);

    await requestConsoleControl(stateDirectory, { command: "revoke", target: entry! });
    await readState(first);
    await readState(second);
    const renewed = await pluginEntries();
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).not.toBe(entry);
    expect(pluginAuthorizations()).toBe(2);

    for (let round = 0; round < 3; round += 1) {
      await readState(first);
      await readState(second);
    }
    expect(await pluginEntries()).toEqual(renewed);
    expect(pluginAuthorizations()).toBe(2);
  }, 30_000);
});
