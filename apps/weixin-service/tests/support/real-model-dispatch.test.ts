import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { processWaitLimitMs } from "./process-wait.js";
import type { State } from "./real-main.js";
import { atRest, keepExecutorRollouts, realModelScenario, runRecord } from "./real-model-dispatch.js";
import { seedExecutorHome } from "./runtime-home.js";

// The real-model suite's own entry point, checked without a model: the Codex executable is a command that only fails and the Codex
// home holds a synthetic login. A broken record or a leftover root would otherwise show only after a real-model run was spent.
// Gaps, both of which need an Executor that only a real run produces:
// - that the process group's kill stops an App Server main left behind;
// - that a scenario fails when one of its own Executor rollouts is withheld (the withholding itself is checked on seeded homes).
const SYNTHETIC_LOGIN = '{"OPENAI_API_KEY":"sk-synthetic"}';
const FALLBACK = "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。";
const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string) { const directory = mkdtempSync(join(tmpdir(), prefix)); created.push(directory); return directory; }
/** The scenario roots the entry point makes under the system's temporary directory. */
const scenarioRoots = () => readdirSync(tmpdir()).filter((name) => name.startsWith("real-model-scenario-")).sort();
/** Every file under `directory`, as sorted relative paths. */
function listing(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();
}
function noModel() {
  const codexHome = temporary("real-model-entry-codex-");
  writeFileSync(join(codexHome, "auth.json"), SYNTHETIC_LOGIN);
  return { CODEX_BIN: "/usr/bin/false", CODEX_HOME: codexHome };
}
const fallbackPosted = (state: State) => state.feishuFixtureTextOutbox?.length === 1;

// The state's shape follows what real main reports under the seam (the two real-main cases below read the same fields).
const reported = {
  accounts: [], codex: { models: { accounts: [{ accountId: "fixture-bot", resolved: { available: true, model: "gpt-5.6-luna", effort: "low", configRevision: 0, source: "track", track: "fast" } },
    { accountId: "feishu.134510bfcd5236dbf6f222594a857cb6bb19bc6bf707c74b3eef174a47409445", resolved: { available: false, reason: "track_unavailable", configRevision: 0, source: "track" } }] } },
  agentDispatch: { jobs: [{ id: "request-1", agentId: "bill", senderAccountId: "cli_bbbbbbbbbbbbbbbb", status: "completed", requester: "ou_owner", definitionsVersion: 1, assignments: [] }],
    notices: [{ id: "request-1:scope", state: "accepted" }, { id: "request-1:closing:0", state: "accepted" }] },
  fixtureDispatchTurns: [{ role: "coordinator", turn: "classify", messageId: "om_one", startedAt: 1, endedAt: 2, input: {}, output: { kind: "dispatch" } }],
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
const context: Parameters<typeof runRecord>[1] = { scenario: "out-of-role-mention", acceptance: ["agent-dispatch::REQ-004"], outcome: "passed", startedAt: "2026-11-11T01:00:00.000Z",
  executorRollouts: ["executor-rollouts/dispatch-aa/sessions/2026/11/11/rollout-2026-11-11T01-00-30-thread-one.jsonl"],
  endedAt: "2026-11-11T01:01:00.000Z", messages: [{ messageId: "om_one", senderId: "ou_owner", text: "帮我规划一日游", mention: "jack" }] };

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
  expect(record).toMatchObject({ ...context,
    models: [{ accountId: "fixture-bot", available: true, model: "gpt-5.6-luna", effort: "low" },
      { accountId: "feishu.134510bfcd5236dbf6f222594a857cb6bb19bc6bf707c74b3eef174a47409445", available: false, reason: "track_unavailable" }],
    requests: [{ id: "request-1", agentId: "bill", status: "completed" }], notices: [{ id: "request-1:scope", state: "accepted" }, { id: "request-1:closing:0", state: "accepted" }],
    turns: [{ role: "coordinator", turn: "classify", messageId: "om_one", output: { kind: "dispatch" } }] });
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

it("keeps only the thread rollouts of Executor homes, byte for byte, and withholds one that holds a credential pattern", () => {
  const state = temporary("real-model-entry-state-"), kept = temporary("real-model-entry-rollouts-");
  const runtimes = join(state, "group-model-runtimes"), first = `dispatch-${"a".repeat(64)}`, second = `dispatch-${"b".repeat(64)}`;
  // Homes as an App Server leaves them after a turn, login copy included; compaction has not run on them.
  const [active] = seedExecutorHome(join(runtimes, first), [{ threadId: "thread-one" }]);
  const [archived, leaking] = seedExecutorHome(join(runtimes, second), [{ threadId: "thread-two", archived: true }, { threadId: "thread-three" }]);
  appendFileSync(join(runtimes, second, leaking!), '{"access_token":"not-a-real-token"}\n');
  // The Coordinator's and a Team Leader's homes hold rollouts too; they are not Executor homes.
  seedExecutorHome(join(runtimes, "dispatch-coordinator"), [{ threadId: "thread-sam" }]);
  seedExecutorHome(join(runtimes, `dispatch-leader-${"c".repeat(64)}`), [{ threadId: "thread-leader" }]);
  const inRecord = (home: string, rollout: string) => `${home}/${rollout.slice("codex-home/".length)}`;
  expect(keepExecutorRollouts(state, kept)).toEqual({ kept: [inRecord(first, active!), inRecord(second, archived!)], withheld: [inRecord(second, leaking!)] });
  expect(listing(kept)).toEqual([inRecord(first, active!), inRecord(second, archived!)]);
  expect(readFileSync(join(kept, inRecord(first, active!)))).toEqual(readFileSync(join(runtimes, first, active!)));
});

it("keeps no rollout when the state directory has no runtime", () => {
  expect(keepExecutorRollouts(temporary("real-model-entry-state-"), temporary("real-model-entry-rollouts-"))).toEqual({ kept: [], withheld: [] });
});

it("writes a scenario's run record, service log and granted directory, and leaves no temporary root or login behind", async () => {
  const records = temporary("real-model-entry-records-"), before = scenarioRoots();
  const directory = await realModelScenario({ id: "entry-self-test", acceptance: ["agent-dispatch::REQ-001"], files: { "project/sample.txt": "x\n" }, records, env: noModel() }, async (run) => {
    await run.send("om_entry_self_test", "帮我整理闲鱼商品描述");
    await run.until("the Coordinator's fallback post", fallbackPosted, processWaitLimitMs);
  });
  expect(directory.startsWith(`${records}/`) && directory.endsWith("-entry-self-test")).toBe(true);
  const record = JSON.parse(readFileSync(join(directory, "run-record.json"), "utf8"));
  expect(record).toMatchObject({ scenario: "entry-self-test", acceptance: ["agent-dispatch::REQ-001"], outcome: "passed", requests: [],
    messages: [{ messageId: "om_entry_self_test", senderId: "ou_owner", text: "帮我整理闲鱼商品描述" }],
    posts: [{ identity: "sam", chatId: "oc_alpha", message: FALLBACK, acceptedAt: expect.any(Number) }],
    notices: [{ state: "accepted" }], deliverables: [], executorRollouts: [],
    turns: [{ role: "coordinator", turn: "classify", messageId: "om_entry_self_test", error: "isolated_runtime_catalog_unavailable" }] });
  expect(record).not.toHaveProperty("failure");
  // The record names the model of every account, the dispatch account among them.
  expect(record.models.length).toBeGreaterThan(0);
  for (const model of record.models) expect(model).toMatchObject({ accountId: expect.any(String), model: expect.any(String), effort: expect.any(String) });
  expect(readFileSync(join(directory, "granted-directory", "project", "sample.txt"), "utf8")).toBe("x\n");
  const log = readFileSync(join(directory, "service.log"), "utf8");
  expect(log).toContain("当前为 fixture 测试模式");
  // Nothing of the login reaches the record, and the scenario's own roots are gone.
  expect(listing(directory).filter((name) => name.endsWith("auth.json"))).toEqual([]);
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
    turns: [{ turn: "classify", input: { mentionedAgentIds: ["jack"] } }] });
  expect(existsSync(join(records, name!, "service.log"))).toBe(true);
  expect(scenarioRoots()).toEqual(before);
}, 30000);
