import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { processWaitLimitMs } from "./process-wait.js";
import type { State } from "./real-main.js";
import { atRest, holdsCredential, keepExecutorRollouts, realModelScenario, runRecord, saveRunRecord } from "./real-model-dispatch.js";
import { seedExecutorHome } from "./runtime-home.js";

// The real-model suite's own entry point, checked without a model: the Codex executable is a command that only fails, or a stub
// that never answers, and the Codex home holds a synthetic login. A broken record, a leftover root or a leftover process would
// otherwise show only after a real-model run was spent. Every token below is synthetic and assembled here, never a real one.
// Gap: a failure while the record is being written, such as an unwritable record directory, ends the scenario with that error;
// no case drives it.
const SYNTHETIC_LOGIN = '{"OPENAI_API_KEY":"sk-synthetic"}';
const FALLBACK = "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。";
const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string) { const directory = mkdtempSync(join(tmpdir(), prefix)); created.push(directory); return directory; }
/** The scenario roots the entry point makes under the system's temporary directory. */
const scenarioRoots = () => readdirSync(tmpdir()).filter((name) => name.startsWith("real-model-scenario-")).sort();
/** Every file under `directory`, as sorted relative paths. */
function listing(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();
}
function noModel() {
  const codexHome = temporary("real-model-entry-codex-");
  writeFileSync(join(codexHome, "auth.json"), SYNTHETIC_LOGIN);
  return { CODEX_BIN: "/usr/bin/false", CODEX_HOME: codexHome };
}
const fallbackPosted = (state: State) => state.feishuFixtureTextOutbox?.length === 1;

// Rollout lines as the App Server writes them: an envelope around a payload, with whatever a turn read or wrote as a JSON string
// inside it (the shape of every line of the rollout kept in ticket 34's run records, whose first line names the account).
const line = (type: string, payload: unknown, ordinal = 1) => `${JSON.stringify({ timestamp: "2026-11-11T00:26:33.000Z", ordinal, type, payload })}\n`;
const toolOutput = (output: string) => line("response_item", { type: "function_call_output", call_id: "call_1", output });
const USER = "user-Synthetic000000000000", ACCOUNT = "00000000-aaaa-0000-aaaa-000000000000";
const sessionMeta = line("session_meta", { creator_user_id: USER, creator_account_id: ACCOUNT, session_id: "thread-one", id: "thread-one", cwd: "/private/tmp/workspace", cli_version: "0.0.0" }, 0);
const SIGNED_TOKEN = ["eyJ" + "hbGciOiJub25lIn0", "eyJ" + "zdWIiOiJzeW50aGV0aWMifQ", "c3ludGhldGljLXNpZ25hdHVyZQ"].join(".");
const API_KEY = "sk-" + "proj-" + "Synthetic0".repeat(3);
const LOGIN_FILE = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "synthetic", access_token: "synthetic", refresh_token: "synthetic", account_id: "synthetic" } });
const inRecord = (home: string, rollout: string) => `${home}/${rollout.slice("codex-home/".length)}`;

// The state's shape follows what real main reports under the seam (the real-main cases below read the same fields).
const reported = {
  accounts: [], codex: { models: { accounts: [{ accountId: "fixture-bot", resolved: { available: true, model: "gpt-5.6-luna", effort: "low", configRevision: 0, source: "track", track: "fast" } },
    { accountId: "feishu.134510bfcd5236dbf6f222594a857cb6bb19bc6bf707c74b3eef174a47409445", resolved: { available: false, reason: "track_unavailable", configRevision: 0, source: "track" } }] } },
  agentDispatch: { jobs: [{ id: "request-1", agentId: "bill", senderAccountId: "cli_bbbbbbbbbbbbbbbb", status: "completed", requester: "ou_owner", definitionsVersion: 1, assignments: [] }],
    notices: [{ id: "request-1:scope", state: "accepted" }, { id: "request-1:closing:0", state: "accepted" }] },
  fixtureDispatchTurns: [{ role: "coordinator", turn: "classify", messageId: "om_one", startedAt: 1, endedAt: 2, input: { memory: "" }, output: { kind: "dispatch" } }],
  feishuFixtureTextOutbox: [{ chatId: "oc_alpha", message: "已将这项需求转派给 Bill。", simulated: true, acceptedAt: 20 }],
  feishuFixtureMediaOutbox: [],
  agentFixtureOutboxes: {
    alice: { text: [], media: [] },
    bill: { text: [{ chatId: "oc_alpha", message: "我安排执行者 1（能力档 1）处理：排行程。完成后会在本群汇报。", simulated: true, acceptedAt: 30 },
      { chatId: "oc_alpha", message: "行程已发到群里。", simulated: true, acceptedAt: 50 }],
      media: [{ chatId: "oc_alpha", kind: "file", fileName: "../南京一日游.md", bytesBase64: Buffer.from("# 南京一日游").toString("base64"), simulated: true }] },
    jack: { text: [{ chatId: "oc_alpha", message: "这属于生活事务，不在技术团队职责内。", simulated: true, acceptedAt: 10 }], media: [] },
  },
} as unknown as State;
const context: Parameters<typeof runRecord>[1] = { scenario: "out-of-role-mention", acceptance: ["agent-dispatch::REQ-004"], startedAt: "2026-11-11T01:00:00.000Z",
  endedAt: "2026-11-11T01:01:00.000Z", messages: [{ messageId: "om_one", senderId: "ou_owner", text: "帮我规划一日游", mention: "jack" }],
  executorRollouts: ["executor-rollouts/dispatch-aa/sessions/2026/11/11/rollout-2026-11-11T01-00-30-thread-one.jsonl"], withheld: [] };

it("puts every identity's posts in the order the group received them, and keeps each delivered file under its sender's name inside the record", () => {
  const { record, files } = runRecord(reported, context);
  expect(record.posts).toEqual([
    { identity: "jack", chatId: "oc_alpha", message: "这属于生活事务，不在技术团队职责内。", acceptedAt: 10 },
    { identity: "sam", chatId: "oc_alpha", message: "已将这项需求转派给 Bill。", acceptedAt: 20 },
    { identity: "bill", chatId: "oc_alpha", message: "我安排执行者 1（能力档 1）处理：排行程。完成后会在本群汇报。", acceptedAt: 30 },
    { identity: "bill", chatId: "oc_alpha", message: "行程已发到群里。", acceptedAt: 50 },
  ]);
  // A file name is the sender's own choice, so it never leads outside the record's directory.
  expect(record.deliverables).toEqual([{ identity: "bill", chatId: "oc_alpha", kind: "file", fileName: "../南京一日游.md", savedAs: "deliverables/1-bill-南京一日游.md" }]);
  expect(files).toEqual([{ path: "deliverables/1-bill-南京一日游.md", bytes: Buffer.from("# 南京一日游") }]);
  expect(record).toMatchObject({ scenario: "out-of-role-mention", acceptance: ["agent-dispatch::REQ-004"], outcome: "passed", startedAt: "2026-11-11T01:00:00.000Z", endedAt: "2026-11-11T01:01:00.000Z",
    messages: [{ messageId: "om_one", senderId: "ou_owner", text: "帮我规划一日游", mention: "jack" }],
    models: [{ accountId: "fixture-bot", available: true, model: "gpt-5.6-luna", effort: "low" },
      { accountId: "feishu.134510bfcd5236dbf6f222594a857cb6bb19bc6bf707c74b3eef174a47409445", available: false, reason: "track_unavailable" }],
    requests: [{ id: "request-1", agentId: "bill", status: "completed" }], notices: [{ id: "request-1:scope", state: "accepted" }, { id: "request-1:closing:0", state: "accepted" }],
    turns: [{ role: "coordinator", turn: "classify", messageId: "om_one", output: { kind: "dispatch" } }],
    executorRollouts: ["executor-rollouts/dispatch-aa/sessions/2026/11/11/rollout-2026-11-11T01-00-30-thread-one.jsonl"], withheld: [] });
  expect(record).not.toHaveProperty("failure");
});

it("keeps a scenario's own failure, and leaves out the content of a recorded turn whose memory quotes a login", () => {
  const turns = [{ role: "coordinator", turn: "classify", messageId: "om_one", startedAt: 1, endedAt: 2, input: { memory: `上次有人贴过：${LOGIN_FILE}` }, output: { kind: "ignore" } },
    { role: "leader", turn: "plan", requestId: "request-1", teamId: "bill", startedAt: 3, endedAt: 4, input: { memory: "" }, output: { assignments: [] } },
    { role: "executor", turn: "run", requestId: "request-1", teamId: "bill", startedAt: 5, endedAt: 6, input: { title: "排行程" }, error: `tool failed with OPENAI_API_KEY=${API_KEY}` }];
  const leaking = { ...reported, fixtureDispatchTurns: turns } as unknown as State;
  const { record } = runRecord(leaking, context);
  expect(record.turns).toEqual([
    { role: "coordinator", turn: "classify", messageId: "om_one", startedAt: 1, endedAt: 2, input: "<withheld: credential pattern>", output: "<withheld: credential pattern>" },
    { role: "leader", turn: "plan", requestId: "request-1", teamId: "bill", startedAt: 3, endedAt: 4, input: { memory: "" }, output: { assignments: [] } },
    { role: "executor", turn: "run", requestId: "request-1", teamId: "bill", startedAt: 5, endedAt: 6, input: "<withheld: credential pattern>", error: "<withheld: credential pattern>" }]);
  const named = ["turn 1 (credential pattern)", "turn 3 (credential pattern)"];
  expect(record).toMatchObject({ outcome: "failed", failure: `withheld from the record: ${named.join(", ")}`, withheld: named });
  expect(JSON.stringify(record)).not.toContain("access_token");
  expect(JSON.stringify(record)).not.toContain(API_KEY);
  // The scenario's own failure stays the record's failure; what was withheld is still named.
  expect(runRecord(leaking, { ...context, failure: "expected the request to be led by bill" }).record)
    .toMatchObject({ outcome: "failed", failure: "expected the request to be led by bill", withheld: named });
});

it.each([
  ["the classification still runs", { turnEnded: false, request: "completed", notice: "accepted" }, false],
  ["a request still runs", { turnEnded: true, request: "running", notice: "accepted" }, false],
  ["a post is still being sent", { turnEnded: true, request: "completed", notice: "sending" }, false],
  ["the request ended and every post has an outcome", { turnEnded: true, request: "partially_failed", notice: "rejected" }, true],
  ["the request waits for its requester", { turnEnded: true, request: "waiting", notice: "accepted" }, true],
] as const)("tells whether a message's handling is at rest: %s", (_name, { turnEnded, request, notice }, expected) => {
  const state = { agentDispatch: { jobs: [{ status: request }], notices: [{ id: "n", state: notice }] },
    fixtureDispatchTurns: [{ role: "coordinator", turn: "classify", messageId: "om_one", startedAt: 1, ...(turnEnded ? { endedAt: 2 } : {}), input: {} }] } as unknown as State;
  expect(atRest(state, "om_one")).toBe(expected);
  // Another message's classification says nothing about this one.
  expect(atRest(state, "om_other")).toBe(false);
});

it.each([
  ["a tool output that quotes a login file", toolOutput(LOGIN_FILE), true],
  ["a login file quoted two levels deep", toolOutput(JSON.stringify({ content: LOGIN_FILE })), true],
  ["a signed token in a message", line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `Authorization: Bearer ${SIGNED_TOKEN}` }] }), true],
  ["an API key in a tool output", toolOutput(`OPENAI_API_KEY=${API_KEY}`), true],
  ["web results and file names with hyphenated words, and a token field named in prose", toolOutput("来源：https://example.com/guides/task-management-for-small-teams ，另见 " +
    "risk-assessment-and-mitigation-plan、disk-usage-and-quota-limits、sk-learn-contrib-utilities-for-pipelines 与 access_token 字段说明"), false],
  ["the account's identifiers in a rollout's first line", sessionMeta, false],
] as const)("tells whether a rollout line holds a credential: %s", (_name, text, expected) => {
  expect(holdsCredential(text)).toBe(expected);
});

it("keeps only the thread rollouts of Executor homes, with the account's identifiers replaced and every other byte as it was", () => {
  const state = temporary("real-model-entry-state-"), kept = temporary("real-model-entry-rollouts-");
  const runtimes = join(state, "group-model-runtimes"), first = `dispatch-${"a".repeat(64)}`, second = `dispatch-${"b".repeat(64)}`;
  // Homes as an App Server leaves them after a turn, login copy included; compaction has not run on them.
  const [active] = seedExecutorHome(join(runtimes, first), [{ threadId: "thread-one" }]);
  const [archived] = seedExecutorHome(join(runtimes, second), [{ threadId: "thread-two", archived: true }]);
  const written = sessionMeta + toolOutput("行程已保存：南京一日游.md");
  writeFileSync(join(runtimes, first, active!), written);
  // The Coordinator's and a Team Leader's homes hold rollouts too; they are not Executor homes.
  seedExecutorHome(join(runtimes, "dispatch-coordinator"), [{ threadId: "thread-sam" }]);
  seedExecutorHome(join(runtimes, `dispatch-leader-${"c".repeat(64)}`), [{ threadId: "thread-leader" }]);
  expect(keepExecutorRollouts(state, kept)).toEqual({ kept: [inRecord(first, active!), inRecord(second, archived!)], withheld: [] });
  expect(listing(kept)).toEqual([inRecord(first, active!), inRecord(second, archived!)]);
  expect(readFileSync(join(kept, inRecord(first, active!)), "utf8")).toBe(written.replace(USER, "<redacted>").replace(ACCOUNT, "<redacted>"));
  expect(readFileSync(join(kept, inRecord(second, archived!)))).toEqual(readFileSync(join(runtimes, second, archived!)));
});

it.each([
  ["a login quoted in a tool output", toolOutput(LOGIN_FILE), "credential pattern"],
  ["an account identifier the replacement cannot reach, quoted inside a tool output", toolOutput(JSON.stringify({ creator_account_id: ACCOUNT })), "account identifier"],
] as const)("withholds a rollout that holds %s", (_name, text, reason) => {
  const state = temporary("real-model-entry-state-"), kept = temporary("real-model-entry-rollouts-"), home = `dispatch-${"d".repeat(64)}`;
  const [rollout] = seedExecutorHome(join(state, "group-model-runtimes", home), [{ threadId: "thread-four" }]);
  writeFileSync(join(state, "group-model-runtimes", home, rollout!), sessionMeta + text);
  expect(keepExecutorRollouts(state, kept)).toEqual({ kept: [], withheld: [`${inRecord(home, rollout!)} (${reason})`] });
  expect(listing(kept)).toEqual([]);
});

it("keeps no rollout when the state directory has no runtime", () => {
  expect(keepExecutorRollouts(temporary("real-model-entry-state-"), temporary("real-model-entry-rollouts-"))).toEqual({ kept: [], withheld: [] });
});

it.each([
  ["had passed", undefined],
  ["had already failed", new Error("the scenario's own assertion failed first")],
])("names a withheld rollout in the record of a scenario that %s, and ends the scenario with a failure", (_name, own) => {
  const state = temporary("real-model-entry-state-"), record = join(temporary("real-model-entry-records-"), "record"), home = `dispatch-${"e".repeat(64)}`;
  const [rollout] = seedExecutorHome(join(state, "group-model-runtimes", home), [{ threadId: "thread-five" }]);
  appendFileSync(join(state, "group-model-runtimes", home, rollout!), toolOutput(LOGIN_FILE));
  const withheld = `executor-rollouts/${inRecord(home, rollout!)} (credential pattern)`;
  const ended = saveRunRecord({ recordDirectory: record, stateDirectory: state, grantedDirectory: join(state, "nothing-granted"), state: undefined, log: "service log\n",
    ...(own ? { failure: { error: own } } : {}), context: { scenario: "withheld-rollout", acceptance: [], startedAt: "2026-11-11T01:00:00.000Z", messages: [] } });
  const failure = own ? "the scenario's own assertion failed first" : `withheld from the record: ${withheld}`;
  expect((ended?.error as Error).message).toBe(failure);
  if (own) expect(ended?.error).toBe(own);
  expect(JSON.parse(readFileSync(join(record, "run-record.json"), "utf8"))).toMatchObject({ scenario: "withheld-rollout", outcome: "failed", failure, executorRollouts: [], withheld: [withheld] });
  expect(listing(record)).toEqual(["run-record.json", "service.log"]);
});

it("writes a scenario's run record, service log and granted directory, and leaves no temporary root or login behind", async () => {
  const records = temporary("real-model-entry-records-"), before = scenarioRoots();
  const skill = temporary("real-model-entry-skill-");
  writeFileSync(join(skill, "SKILL.md"), "---\nname: entry-probe\ndescription: entry probe\n---\n");
  const directory = await realModelScenario({ id: "entry-self-test", acceptance: ["agent-dispatch::REQ-001"], files: { "project/sample.txt": "x\n" }, records, env: noModel() }, async (run) => {
    // A scenario sets the console up as the owner does: the run's own requests reach its API, authorized.
    expect(await run.post("/api/skills/read", { folder: skill })).toMatchObject({ preview: { name: "entry-probe", files: [{ path: "SKILL.md" }] } });
    expect(await run.get("/api/skills")).toEqual({ skills: [] });
    await run.send("om_entry_self_test", "帮我整理闲鱼商品描述");
    await run.until("the Coordinator's fallback post", fallbackPosted, processWaitLimitMs);
  });
  expect(directory.startsWith(`${records}/`) && directory.endsWith("-entry-self-test")).toBe(true);
  const record = JSON.parse(readFileSync(join(directory, "run-record.json"), "utf8"));
  expect(record).toMatchObject({ scenario: "entry-self-test", acceptance: ["agent-dispatch::REQ-001"], outcome: "passed", requests: [],
    messages: [{ messageId: "om_entry_self_test", senderId: "ou_owner", text: "帮我整理闲鱼商品描述" }],
    posts: [{ identity: "sam", chatId: "oc_alpha", message: FALLBACK, acceptedAt: expect.any(Number) }],
    notices: [{ state: "accepted" }], deliverables: [], executorRollouts: [], withheld: [],
    turns: [{ role: "coordinator", turn: "classify", messageId: "om_entry_self_test", error: "isolated_runtime_catalog_unavailable" }] });
  expect(record).not.toHaveProperty("failure");
  // The record names the model of every account, the dispatch account among them.
  expect(record.models.length).toBeGreaterThan(0);
  for (const model of record.models) expect(model).toMatchObject({ accountId: expect.any(String), model: expect.any(String), effort: expect.any(String) });
  expect(readFileSync(join(directory, "granted-directory", "project", "sample.txt"), "utf8")).toBe("x\n");
  const log = readFileSync(join(directory, "service.log"), "utf8");
  expect(log).toContain("当前为 fixture 测试模式");
  // No Executor ran, so no rollout is kept; nothing of the login file reaches the record, and the scenario's own roots are gone.
  expect(listing(directory).filter((name) => name.endsWith("auth.json") || name.includes("rollout"))).toEqual([]);
  expect(log + JSON.stringify(record)).not.toContain("sk-synthetic");
  expect(scenarioRoots()).toEqual(before);
}, 30000);

it("still writes the record of a scenario whose wait runs out, naming what it waited for, and fails with that reason", async () => {
  const records = temporary("real-model-entry-records-"), before = scenarioRoots();
  const reason = "timed out after 300 ms waiting for a post that never comes";
  await expect(realModelScenario({ id: "entry-self-test-failure", acceptance: ["agent-dispatch::REQ-004"], records, env: noModel() }, async (run) => {
    await run.send("om_entry_failure", "帮我规划一日游", { mention: "jack" });
    await run.until("the Coordinator's fallback post", fallbackPosted, processWaitLimitMs);
    await run.until("a post that never comes", () => false, 300);
  })).rejects.toThrow(reason);
  const [name] = readdirSync(records);
  const record = JSON.parse(readFileSync(join(records, name!, "run-record.json"), "utf8"));
  expect(record).toMatchObject({ scenario: "entry-self-test-failure", outcome: "failed", failure: reason,
    messages: [{ messageId: "om_entry_failure", text: "帮我规划一日游", mention: "jack" }], posts: [{ identity: "sam", message: FALLBACK }],
    // The genuine mention of Jack's application reached the Coordinator's turn.
    turns: [{ turn: "classify", input: { event: { mentionedAgentIds: ["jack"] } } }] });
  expect(existsSync(join(records, name!, "service.log"))).toBe(true);
  expect(scenarioRoots()).toEqual(before);
}, 30000);

it("leaves no App Server behind when one outlives the service's stop", async () => {
  const records = temporary("real-model-entry-records-"), stub = temporary("real-model-entry-stub-");
  const executable = join(stub, "codex"), pidFile = join(stub, "app-server.pid");
  // Stands in for the Codex executable: it answers the catalog query, and as an App Server it ignores SIGTERM and never exits.
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = debug ]; then printf '%s' '{"models":[{"slug":"stub-model"}]}'; exit 0; fi\n` +
    `trap '' TERM\necho $$ > "$(dirname "$0")/app-server.pid"\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  let pid = 0, aliveDuring = false;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The service cannot stop cleanly while its App Server ignores it; how the scenario then ends is not this case's point.
  await realModelScenario({ id: "entry-self-test-leftover", acceptance: [], records, env: { ...noModel(), CODEX_BIN: executable } }, async (run) => {
    await run.send("om_entry_leftover", "帮我整理闲鱼商品描述");
    await run.until("the stub App Server's start", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", processWaitLimitMs);
    pid = Number(readFileSync(pidFile, "utf8"));
    aliveDuring = alive();
  }).catch(() => undefined);
  expect(pid).toBeGreaterThan(0);
  expect(aliveDuring).toBe(true);
  await expect.poll(alive, { timeout: processWaitLimitMs }).toBe(false);
}, 45000);
