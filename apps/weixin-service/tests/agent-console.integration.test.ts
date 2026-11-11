// Whole-app wiring of the console login (agent-console::US-001): the service process builds the gate on its
// state directory and starts the control channel, and the `console` command reaches it there.
// The team overview's APIs (agent-console::US-003 to US-005, US-001/AC-03) through real main with Feishu dispatch in fixture mode:
// the projection's rules are unit-tested in console-overview.test.ts; these cases show its inputs are wired to the running service.
// The private conversations' APIs (agent-console::US-006, REQ-002/AC-03, CON-002) the same way: their rules are unit-tested in
// private-conversations.test.ts, and these cases show the running service's definitions, records and memory reach them, or not.
// The fixture replier stands in for the reply turn and records each turn's input; the model's own turn runs only in the opt-in
// real-model suite.
// Coverage gap: the real macOS default-browser launch is not exercised; the login case puts a stand-in `open`
// (and `xdg-open`) first on PATH and checks that it received the printed link.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { authorizeLocalService, exchangeLoginLink } from "../e2e/console-session.js";
import { startFixtureServer } from "../e2e/fixture-server.js";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { groupMemoryAccount, seedEvent, seedMemory } from "./support/memory.js";
import { signalProcessGroup } from "./support/process-group.js";
import { processWaitLimitMs } from "./support/process-wait.js";
import { config, decision, groupMessage, start } from "./support/real-main.js";

const SERVICE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

type CommandResult = { code: number; stdout: string; stderr: string };

function runConsole(args: string[], env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "src/console-cli.ts", ...args], {
      cwd: SERVICE_DIRECTORY,
      env: { ...process.env, ...env },
      timeout: 20_000,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function loginLinkIn(output: string, port: string): string {
  const match = output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/login\\?t=[0-9a-f]{48}`));
  if (!match) throw new Error(`no login link in: ${output}`);
  return match[0];
}

describe("console login command against the running service", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function temporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
  }

  async function startService(options: { stateDirectory: string; port?: number }) {
    const server = await startFixtureServer("fixture", "fixture", undefined, options);
    cleanups.push(() => server.close());
    return server;
  }

  /** Puts a stand-in `open` and `xdg-open` first on PATH; each records the URL it was asked to open. */
  function standInOpener(stateDirectory: string) {
    const bin = temporaryDirectory("agent-console-bin-");
    const opened = path.join(bin, "opened.txt");
    for (const opener of ["open", "xdg-open"]) {
      fs.writeFileSync(path.join(bin, opener), `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`, { mode: 0o755 });
    }
    return { opened, env: { WEIXIN_DEMO_STATE_DIR: stateDirectory, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } };
  }

  it("prints a link that authorizes the browser, and the authorization survives a service restart", async () => {
    const stateDirectory = temporaryDirectory("agent-console-state-");
    const first = await startService({ stateDirectory });
    const port = new URL(first.url).port;

    const opener = standInOpener(stateDirectory);
    const login = await runConsole(["login", "--no-open"], opener.env);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain("2 分钟内有效");
    expect(fs.existsSync(opener.opened)).toBe(false);
    const cookie = await exchangeLoginLink(loginLinkIn(login.stdout, port));
    const page = await fetch(`${first.url}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="connection-app-tab"');

    await first.close();
    const restarted = await startService({ stateDirectory, port: Number(port) });
    expect((await fetch(`${restarted.url}/api/state`, { headers: { cookie } })).status).toBe(200);
  }, 60_000);

  it("opens the link in the default browser, lists the browsers and revokes them, warning when the audit cannot be written", async () => {
    const stateDirectory = temporaryDirectory("agent-console-state-");
    const server = await startService({ stateDirectory });
    const port = new URL(server.url).port;
    const { opened, env } = standInOpener(stateDirectory);

    const login = await runConsole(["login"], env);
    expect(login.code).toBe(0);
    const link = loginLinkIn(login.stdout, port);
    expect(fs.readFileSync(opened, "utf8")).toBe(link);
    const chrome = await exchangeLoginLink(link, CHROME_MAC);
    const second = await runConsole(["login"], env);
    const safari = await exchangeLoginLink(loginLinkIn(second.stdout, port), SAFARI_MAC);

    const list = await runConsole(["list"], env);
    expect(list.code).toBe(0);
    const idOf = (label: string) => {
      const line = list.stdout.split("\n").find((entry) => entry.includes(label));
      expect(line).toBeDefined();
      const id = line!.split(/\s+/)[0]!;
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      return id;
    };
    const [chromeId, safariId] = [idOf("Chrome · macOS"), idOf("Safari · macOS")];

    const revoke = await runConsole(["revoke", chromeId], env);
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain("已收回 1 个浏览器的授权");
    expect(revoke.stderr).toBe("");
    expect((await fetch(`${server.url}/api/state`, { headers: { cookie: chrome } })).status).toBe(401);

    const audit = path.join(fs.realpathSync(stateDirectory), "console-audit.jsonl");
    fs.chmodSync(audit, 0o400);
    try {
      const unaudited = await runConsole(["revoke", safariId], env);
      expect(unaudited.code).toBe(0);
      expect(unaudited.stdout).toContain("已收回 1 个浏览器的授权");
      expect(unaudited.stderr).toContain("审计记录写入失败");
    } finally {
      fs.chmodSync(audit, 0o600);
    }
    expect((await fetch(`${server.url}/api/state`, { headers: { cookie: safari } })).status).toBe(401);
  }, 60_000);

  it("says the service is not running when the service was killed and left its connection file", async () => {
    const stateDirectory = temporaryDirectory("agent-console-state-");
    const server = await startService({ stateDirectory });
    // Kill the service's whole process group, as a crash or `kill -9` would; no shutdown cleanup runs.
    signalProcessGroup(server.pid, "SIGKILL");
    const until = Date.now() + 5_000;
    while (Date.now() < until && (await fetch(`${server.url}/api/state`).then(() => true, () => false))) await delay(50);
    expect(fs.existsSync(path.join(stateDirectory, "console-control.json"))).toBe(true);

    const result = await runConsole(["login", "--no-open"], { WEIXIN_DEMO_STATE_DIR: stateDirectory });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("本机服务未运行");
    expect(result.stdout).not.toContain("/login?t=");
  }, 60_000);

  it("says the service is not running when no service owns the state directory", async () => {
    const result = await runConsole(["login", "--no-open"], { WEIXIN_DEMO_STATE_DIR: temporaryDirectory("agent-console-empty-") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("本机服务未运行");
  }, 30_000);
});

describe("team overview and private conversation APIs against the running service", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A state directory whose channel configuration dispatches in two groups, 银河护卫队 (oc_alpha) and 产品讨论组 (oc_beta). */
  function dispatchDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-overview-"));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const base = config("feishu");
    fs.writeFileSync(path.join(directory, "channel.json"), JSON.stringify({ ...base, feishu: { ...base.feishu,
      groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
      dispatch: { groupChatIds: ["oc_alpha", "oc_beta"], agents: [{ id: "sam" }, { id: "alice", appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "fixture-alice" },
        { id: "bill", appId: "cli_bbbbbbbbbbbbbbbb", appSecret: "fixture-bill" }, { id: "jack", appId: "cli_cccccccccccccccc", appSecret: "fixture-jack" }] } } }),
      { mode: 0o600 });
    return directory;
  }
  const NAMES = { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify({ chats: { oc_alpha: { name: "银河护卫队" }, oc_beta: { name: "产品讨论组" } } }) };
  async function running(directory: string) {
    const service = await start(directory, NAMES);
    cleanups.push(() => service.close());
    return service;
  }
  /** The memory accounts of both groups' Coordinator and the owner's personal one, as the service derives them from the file. */
  function accounts(directory: string) {
    const owner = parseChannelStartupConfiguration(JSON.parse(fs.readFileSync(path.join(directory, "channel.json"), "utf8"))).entries.find((entry) => entry.channel === "feishu")!.owner;
    return { alpha: groupMemoryAccount(directory, "oc_alpha"), beta: groupMemoryAccount(directory, "oc_beta"),
      personal: { account: owner.memoryScope(owner.conversationAddress().accountId), target: owner.conversationAddress().target } };
  }

  it("serves the dispatch groups, the live roster and each request's record from the running service's dispatch", async () => {
    const service = await running(dispatchDirectory());
    await service.post("/api/fixture/inbound", groupMessage("om_overview", "帮我整理闲鱼商品描述", decision("alice", "整理闲鱼商品描述")));
    await service.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    type View = { dispatch: boolean; groups: unknown; agents: Record<string, { name: string }>; teams: Array<{ id: string; counts: Record<string, unknown> }>;
      requests: Array<{ chatId: string; title: string; lead: string; requester: string; status: string; delivery: string; message: { text: string };
        assignments: Array<{ executor: string; status: string }> }> };
    const view = await service.get<View>("/api/overview");
    expect(view.dispatch).toBe(true);
    expect(view.groups).toEqual([{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "产品讨论组" }]);
    expect(Object.keys(view.agents).sort()).toEqual(["alice", "bill", "jack", "sam"]);
    expect(view.teams.find(({ id }) => id === "alice")?.counts).toEqual({ oc_alpha: { running: 0, waiting: 0, history: 1 }, oc_beta: { running: 0, waiting: 0, history: 0 } });
    expect(view.requests).toEqual([expect.objectContaining({ chatId: "oc_alpha", title: "整理闲鱼商品描述", lead: "alice", requester: "owner", status: "completed",
      delivery: "accepted", message: expect.objectContaining({ text: "帮我整理闲鱼商品描述" }), assignments: [expect.objectContaining({ executor: "执行者 1", status: "completed" })] })]);
  }, 60_000);

  it("shows a dispatch group's own memory, every entry and event, and no route reaches or changes any other memory", async () => {
    const directory = dispatchDirectory(), { alpha, beta, personal } = accounts(directory);
    await seedMemory(directory, alpha.account, alpha.target, "alpha-1", "上新文案先发到上新话题");
    await seedEvent(directory, alpha.account, alpha.target, "alpha-2", "2025-01-15", "去年的商品 C 校对完成");
    await seedMemory(directory, beta.account, beta.target, "beta-1", "产品讨论组的发布节奏是双周");
    await seedMemory(directory, personal.account, personal.target, "personal-1", "本人偏好晚上收提醒");
    const service = await running(directory);
    const cookie = await authorizeLocalService(directory), origin = service.url;
    const memory = (group: string, init: RequestInit = {}) => fetch(`${origin}/api/overview/memory?group=${group}`, { ...init, headers: { cookie, origin, ...init.headers } });

    const shown = await (await memory("oc_alpha")).json() as { readable: boolean; entries: Array<{ value: string }>; events: Array<{ date: string; summary: string }> };
    expect(shown).toMatchObject({ readable: true, entries: [{ category: "projects", value: "上新文案先发到上新话题" }],
      events: [{ date: "2025-01-15", kind: "observed", summary: "去年的商品 C 校对完成" }] });
    expect(((await (await memory("oc_beta")).json()) as { entries: Array<{ value: string }> }).entries.map(({ value }) => value)).toEqual(["产品讨论组的发布节奏是双周"]);
    // The owner's private chat is no dispatch group, so personal memory is never reachable; nor is any chat that is not one.
    for (const group of ["oc_private", "oc_unknown", ""]) expect((await memory(group)).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await memory("oc_alpha", { method, headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    }
    expect(((await (await memory("oc_alpha")).json()) as { entries: unknown[] }).entries).toHaveLength(1);
  }, 60_000);

  it("lists the authorized browsers with the current one marked, and revokes another, auditing the browser that asked", async () => {
    const directory = dispatchDirectory();
    const service = await running(directory);
    const origin = service.url;
    const [owner, other] = [await authorizeLocalService(directory), await authorizeLocalService(directory)];
    type Browser = { id: string; label: string; current: boolean };
    const list = async (cookie: string) => (await (await fetch(`${origin}/api/console/browsers`, { headers: { cookie } })).json() as { browsers: Browser[] }).browsers;
    const browsers = await list(owner);
    expect(browsers.filter(({ current }) => current)).toHaveLength(1);
    const otherId = (await list(other)).find(({ current }) => current)!.id, ownerId = browsers.find(({ current }) => current)!.id;
    expect(otherId).not.toBe(ownerId);

    const revoke = await fetch(`${origin}/api/console/browsers/revoke`, { method: "POST", headers: { cookie: owner, origin, "content-type": "application/json" },
      body: JSON.stringify({ target: otherId }) });
    expect(await revoke.json()).toEqual({ revoked: 1, auditFailed: false });
    expect((await fetch(`${origin}/api/overview`, { headers: { cookie: other } })).status).toBe(401);
    expect((await list(owner)).map(({ id }) => id)).not.toContain(otherId);
    const audit = fs.readFileSync(path.join(fs.realpathSync(directory), "console-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({ by: "browser", browser: { id: ownerId }, event: "browser_revoked", browsers: [{ id: otherId }] });
  }, 60_000);

  type Chat = { agent: { id: string; name: string }; pending: boolean; requests: string[];
    messages: Array<{ role: "owner" | "agent"; text: string; requestId: string | null; state?: string; reason?: string }> };
  /** The owner's conversation with `agentId` once its last message has its reply, polled like the console page polls it. */
  async function answered(service: Awaited<ReturnType<typeof running>>, agentId: string): Promise<Chat> {
    const deadline = Date.now() + processWaitLimitMs;
    for (;;) {
      const chat = await service.get<Chat>(`/api/private-chats/${encodeURIComponent(agentId)}`);
      if (!chat.pending) return chat;
      if (Date.now() > deadline) throw new Error(`no reply from ${agentId}: ${JSON.stringify(chat)}`);
      await delay(30);
    }
  }

  it("lets the owner chat with Sam and every defined Team Leader, before onboarding and while the team is being deleted, and with nobody else", async () => {
    const directory = dispatchDirectory();
    const service = await running(directory);
    const cookie = await authorizeLocalService(directory), origin = service.url;
    const chat = (agentId: string, message?: unknown) => fetch(`${origin}/api/private-chats/${encodeURIComponent(agentId)}${message === undefined ? "" : "/messages"}`,
      message === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(message) });
    // An Executor, Penny and anyone unknown have no conversation (agent-console::US-006/AC-01).
    await service.post("/api/fixture/inbound", groupMessage("om_bill_held", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelHold: true }));
    const executor = (await service.until((state) => state.agentDispatch?.jobs[0]?.assignments[0]?.status === "running")).agentDispatch!.jobs[0]!.assignments[0]!;
    for (const agentId of ["penny", executor.executor, executor.id, "unknown"]) {
      for (const response of [await chat(agentId), await chat(agentId, { text: "你好" })]) {
        expect(response.status, agentId).toBe(404);
        expect(await response.json()).toEqual({ error: "只能与 Sam 和各团队负责人私聊" });
      }
    }
    // A team saved on 团队管理 whose application is not created yet, and Bill's team, deleted while its request runs (US-006/AC-04).
    const { version } = await service.get<{ version: number }>("/api/teams");
    const { teamId } = await service.post<{ teamId: string }>("/api/teams/save", { basedOn: version, team: { teamName: "设计团队", responsibility: "视觉方案", groups: [],
      method: "qr", leader: { name: "Daisy", appId: "", instructions: "" }, executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: [] }] } });
    const { view } = await service.post<{ view: { teams: Array<{ id: string; deleting: boolean }> } }>("/api/teams/delete", { teamId: "bill" });
    expect(view.teams.find(({ id }) => id === "bill")?.deleting).toBe(true);
    for (const [agentId, name] of [["sam", "Sam"], [teamId, "Daisy"], ["bill", "Bill"]] as const) {
      expect(await service.post<Chat>(`/api/private-chats/${agentId}/messages`, { text: `你好，${name}` })).toMatchObject({ agent: { id: agentId, name }, pending: true });
      const replied = await answered(service, agentId);
      console.log(JSON.stringify({ kind: "console_private_chat", agent: agentId, command: `你好，${name}`, reply: replied.messages.at(-1)?.text }));
      expect(replied.messages.map(({ role, text, state }) => [role, text, state])).toEqual([["owner", `你好，${name}`, "answered"], ["agent", `收到：你好，${name}`, undefined]]);
    }
  }, 60_000);

  it("gives Sam the state, teams and reports of the owner's requests and a Team Leader its own results, recalls no memory and leaves nothing of the conversation anywhere else", async () => {
    const directory = dispatchDirectory(), { alpha, personal } = accounts(directory);
    await seedMemory(directory, alpha.account, alpha.target, "alpha-1", "群记忆：上新文案先发到上新话题");
    await seedMemory(directory, personal.account, personal.target, "personal-1", "本人记忆：偏好晚上收提醒");
    const service = await running(directory);
    await service.post("/api/fixture/inbound", groupMessage("om_private_basis", "帮我写商品 D 的上新文案", decision("alice", "写商品 D 的上新文案"), {
      leaderPlan: { assignments: [{ profileId: "executor-1", title: "写上新文案", brief: "交办：只给执行者看的要求" }], decisions: [] },
      modelReply: JSON.stringify({ message: "执行结果：只给负责人看的文案", results: [{ subject: "写上新文案", status: "completed" }] }),
      leaderClosing: { message: "收尾：商品 D 的文案已经写好" } }));
    const settled = await service.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && state.agentFixtureOutboxes?.alice?.text.length === 2);
    const requestId = settled.agentDispatch!.jobs[0]!.id;
    const jobs = settled.agentDispatch!.jobs.length, posts = JSON.stringify([settled.fixtureTextOutbox, settled.feishuFixtureTextOutbox, settled.agentFixtureOutboxes]);

    const said = { sam: "暗号甲：Sam，商品 D 现在怎样了？", alice: "暗号乙：Alice，文案写成什么样？" };
    for (const [agentId, text] of Object.entries(said)) {
      expect((await service.post<Chat>(`/api/private-chats/${agentId}/messages`, { text, requestId })).requests).toEqual([requestId]);
      const replied = await answered(service, agentId);
      console.log(JSON.stringify({ kind: "console_private_chat", agent: agentId, command: text, reply: replied.messages.at(-1)?.text }));
      expect(replied.messages.at(-1)).toMatchObject({ role: "agent", text: `收到：${text}`, requestId });
    }
    const turns = (await service.state()).fixturePrivateTurns!;
    expect(turns.map(({ agentId }) => agentId)).toEqual(["sam", "alice"]);
    const [sam, alice] = turns.map(({ input }) => JSON.stringify(input));
    // Sam reads the request's state, lead and posts, the closing included, and never the Brief or the Executor's result (REQ-002/AC-03).
    expect(sam).toContain("\"state\":\"completed\"");
    expect(sam).toContain("收尾：商品 D 的文案已经写好");
    for (const hidden of ["交办：只给执行者看的要求", "执行结果：只给负责人看的文案"]) expect(sam).not.toContain(hidden);
    // Alice reads her own Executor's result.
    expect(alice).toContain("执行结果：只给负责人看的文案");
    // Neither reply turn recalled any memory: not the group's, which Sam reads in the group, and not the owner's own (CON-002).
    for (const input of [sam, alice]) for (const fact of ["群记忆：上新文案先发到上新话题", "本人记忆：偏好晚上收提醒"]) expect(input).not.toContain(fact);

    // Nothing of the conversation became a request, a group post or a record, or entered any memory: every file of the service's
    // state but the conversations' own store is searched for what the owner and the agents said (CON-002).
    const after = await service.state();
    expect(after.agentDispatch!.jobs).toHaveLength(jobs);
    expect(JSON.stringify([after.fixtureTextOutbox, after.feishuFixtureTextOutbox, after.agentFixtureOutboxes])).toBe(posts);
    const chats = await Promise.all(Object.keys(said).map((agentId) => service.get<Chat>(`/api/private-chats/${agentId}`)));
    const spoken = chats.flatMap(({ messages }) => messages.map(({ text }) => text));
    expect(spoken).toHaveLength(4);
    const files = (fs.readdirSync(directory, { recursive: true }) as string[]).map((name) => path.join(directory, name))
      .filter((file) => fs.lstatSync(file).isFile() && !path.basename(file).startsWith("private-conversations.sqlite"));
    // The search reads memory's own text: it finds the seeded group fact, so the absence below is not the search missing the stores.
    expect(files.filter((file) => fs.readFileSync(file).includes(Buffer.from("群记忆：上新文案先发到上新话题"))).some((file) => file.includes(`${path.sep}memory${path.sep}`))).toBe(true);
    for (const file of files) {
      const bytes = fs.readFileSync(file);
      for (const text of spoken) expect(bytes.includes(Buffer.from(text)), `${text} in ${file}`).toBe(false);
    }
  }, 60_000);
});
