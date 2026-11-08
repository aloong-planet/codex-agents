import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { PublicCodexServiceState } from "../../src/conversation-service.js";
import { authorizeLocalService } from "../../e2e/console-session.js";

// Shared real-main helpers for whole-app cases: main runs in fixture mode with fixture-only external peers.
export type DispatchAssignmentState = { id: string; teamId: string; profileId: string; executor: string; title: string; status: string; attempt: number };
export type State = { agentDispatch?: { jobs: Array<{ id: string; agentId: string; senderAccountId: string; status: string; requester: string; result?: string;
    definitionsVersion: number | null; assignments: DispatchAssignmentState[] }>; notices?: Array<{ id: string; state: string }> };
  fixtureLeaderRequests?: Array<{ phase: "plan" | "close"; teamId: string; input: { brief: { message: string; latest?: string; summary: string }; refusal?: string;
    directory?: Array<{ name: string; responsibility: string }>; memory?: string;
    assignments?: Array<{ title: string; executor: string; status: string; result: string }> } }>;
  fixtureCoordinationRequests?: Array<{ threadId: string; input: unknown }>;
  fixtureMemoryCurations?: Array<{ curator: "group" | "dispatch"; accountId: string; turns: Array<{ user: string; assistant?: string }> }>;
  fixtureThreadStarts?: Array<{ threadId: string; serviceName: unknown; dynamicTools: string[] | null }>; agentFixtureOutboxes?: Record<string, { text: Array<{ chatId: string; message: string }>; media: unknown[] }>;  fixtureModelRequests?: Array<{ threadId: string; input: unknown }>; fixtureOutbox?: { kind: string; fileName: string }[]; feishuFixtureMediaOutbox?: { chatId: string; kind: string; bytesBase64: string }[]; weixinFixtureReplies?: { accountId: string; target: string; message: string }[]; channels?: Record<string, { enabled: boolean; ready: boolean }>; feishuFixtureTextOutbox?: { message: string }[]; channel?: string; ready?: boolean; accounts: { accountId: string }[]; codex: PublicCodexServiceState;
  fixtureMediaOutbox?: { chatId: string; kind: string; bytesBase64: string; fileName: string }[];
  penny?: { configured: boolean; ready: boolean; error?: string };
  pennyFixtureTextOutbox?: { chatId: string; message: string }[];
  workflows?: { runs: { runRef: string; workflowId: string; status: string; steps: unknown[]; effects: unknown[] }[] };
  workflowModulePermissions?: { modules: { moduleId: string; revision: number; scopes: { scopeId: string }[] }[] };
  fixtureTextOutbox?: { message: string }[];
  fixtureOnboardingCalls?: Array<Record<string, string>> };
export const config = (channel: "weixin" | "feishu") => ({ channel,
  owner: { memoryAccountId: "fixture-bot", bindings: [
    { channel: "weixin", accountId: "fixture-bot", target: "fixture-user@im.wechat", senderId: "fixture-user@im.wechat" },
    { channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" },
  ] }, taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
  feishu: { appId: "cli_0123456789abcdef", appSecret: "fixture-secret" },
});
export async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no_port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
export async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const until = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(25);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}
/** Starts main on `directory`; `packageRoot` runs another checkout of this package, such as an older commit's tree. */
export async function start(directory: string, extraEnv: Record<string, string> = {}, options: { packageRoot?: string } = {}) {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEMO_MODE: "fixture", PORT: String(port), CHANNEL_CONFIG_PATH: join(directory, "channel.json"),
      WORKFLOW_FIXTURE_STATE_DIRECTORY: directory, WORKFLOW_SIMULATOR_MODEL: "fixture", WORKFLOW_SIMULATOR_PENDING_ROUTER: "fixture", WEIXIN_OTEL_ENABLED: "0", ...extraEnv },
  });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  // The local service requires an authorized browser; the test logs in through the control channel like the owner.
  let cookie: string | undefined;
  const authorized = async () => cookie ??= await authorizeLocalService(directory);
  async function state(): Promise<State> { return await (await fetch(`${url}/api/state`, { headers: { cookie: await authorized() }, signal: AbortSignal.timeout(1000) })).json() as State; }
  async function until(predicate: (value: State) => boolean, timeout = 15000): Promise<State> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture exited: ${output}`);
      try { const value = await state(); if (predicate(value)) return value; } catch { /* bounded startup/readiness */ }
      await delay(30);
    }
    throw new Error(`fixture condition timed out: ${JSON.stringify(await state())}\n${output}`);
  }
  try { await until((value) => value.channel === "feishu" ? value.ready === true : value.codex?.enabledTargets.length > 0); }
  catch (error) { await stop(child); throw error; }
  return { state, until, output: () => output, close: async () => { await stop(child); expect(child.exitCode, output).toBe(0); },
    crash: async () => {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
      expect(child.signalCode).toBe("SIGKILL");
    },
    /** POSTs as the authorized owner, expects 200 and returns the JSON body. */
    async post<T = unknown>(route: string, body: unknown): Promise<T> {
      const response = await fetch(`${url}${route}`, { method: "POST", headers: { origin: url, "content-type": "application/json", cookie: await authorized() }, body: JSON.stringify(body) });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return (text ? JSON.parse(text) : undefined) as T;
    },
    /** POSTs as the authorized owner and returns the status and JSON body, whatever the status. */
    async send<T = unknown>(route: string, body: unknown): Promise<{ status: number; body: T }> {
      const response = await fetch(`${url}${route}`, { method: "POST", headers: { origin: url, "content-type": "application/json", cookie: await authorized() }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T };
    },
    /** GETs a JSON route as the authorized owner. */
    async get<T = unknown>(route: string): Promise<T> {
      const response = await fetch(`${url}${route}`, { headers: { cookie: await authorized() }, signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return JSON.parse(text) as T;
    } };
}

export function dispatchConfig(directory: string, dual = false) {
    const configuration = config("feishu");
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...configuration, ...(dual ? { channel: undefined, enabledChannels: ["weixin", "feishu"] } : {}), feishu: { ...configuration.feishu,
      groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner", "ou_colleague"] }],
      dispatch: { groupChatIds: ["oc_alpha"], agents: [{ id: "sam" },
        { id: "alice", appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "fixture-alice" },
        { id: "bill", appId: "cli_bbbbbbbbbbbbbbbb", appSecret: "fixture-bill" },
        { id: "jack", appId: "cli_cccccccccccccccc", appSecret: "fixture-jack" }] },
    } }));
}

/** A Feishu group text event from the owner in `oc_alpha`, with the fixture's canned Coordinator decision and optional extra fixture inputs. */
/** The fixture Coordinator's decision to dispatch a request to `agentId`. */
export const decision = (agentId: string, summary: string) => ({ kind: "dispatch", agentId, requestId: null, summary, message: "" });
export const groupMessage = (messageId: string, text: string, dispatchDecision: unknown, extra: Record<string, unknown> = {}) => ({
  event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text }), mentions: [] } }, dispatchDecision, ...extra });
