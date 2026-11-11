import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { EXECUTOR_RUNTIME_HOME } from "../../src/agent-dispatch-executor.js";
import type { DispatchTurnRecord } from "../../src/fixture-dispatch-recorder.js";
import { ISOLATED_RUNTIME_KINDS } from "../../src/isolated-runtime-kinds.js";
import { allowNotes, dispatchConfig, start, type State } from "./real-main.js";

/**
 * The entry point of the real-model dispatch suite (agent-dispatch Testing Decisions). A scenario runs real main in fixture mode
 * under WORKFLOW_FIXTURE_DISPATCH_REAL_MODEL: messages enter through the fixture Feishu ingress, every platform is a fixture, and
 * only the Coordinator, the Team Leaders and the Executors reach the real model, with the login their runtimes copy themselves.
 *
 * Each scenario has its own service process, state directory and granted directory, all temporary and removed when it ends,
 * and leaves one run record, also when it fails: a failed scenario's record is its evidence. The record holds what a reviewer
 * needs to judge the run without repeating it. Of the runtime homes, where the login copies are, it keeps only the Executors'
 * thread rollouts, with the account's identifiers replaced. Whatever holds a credential pattern is withheld from the record,
 * named there, and fails the scenario.
 */
export const realModelDispatch = process.env.DISPATCH_REAL_MODEL_TEST === "1";

const GROUP = "oc_alpha", OWNER = "ou_owner", COORDINATOR = "sam", COORDINATOR_APPLICATION = "cli_0123456789abcdef";
/** The seeded teams of `dispatchConfig`, by Team Leader. */
const TEAMS = { alice: { name: "Alice", appId: "cli_aaaaaaaaaaaaaaaa" }, bill: { name: "Bill", appId: "cli_bbbbbbbbbbbbbbbb" }, jack: { name: "Jack", appId: "cli_cccccccccccccccc" } } as const;
export type TeamId = keyof typeof TEAMS;

export type ScenarioMessage = { messageId: string; senderId: string; text: string; mention?: TeamId };
export type GroupPost = { identity: string; chatId: string; message: string; acceptedAt: number };
export type DeliveredFile = { identity: string; chatId: string; kind: string; fileName: string; bytesBase64: string };
export type RunRecord = {
  scenario: string;
  /** The acceptance items the scenario's assertions check. */
  acceptance: string[];
  outcome: "passed" | "failed";
  failure?: string;
  startedAt: string;
  endedAt: string;
  /** The model each account's turns resolve to; dispatch turns use the Feishu owner's account. */
  models: unknown[];
  messages: ScenarioMessage[];
  /** The Dispatch Requests with their Assignments, as the service reports them. */
  requests: unknown[];
  /** Every turn of the Coordinator, the Team Leaders and the Executors: inputs, decisions, plans with their Briefs, results and closings. */
  turns: DispatchTurnRecord[];
  /** Every post the group received, in the order received, under the identity that sent it. */
  posts: GroupPost[];
  /** The delivery state of every post the service tried to send. */
  notices: unknown[];
  /** Every file or image the group received, saved beside the record. */
  deliverables: Array<{ identity: string; chatId: string; kind: string; fileName: string; savedAs: string }>;
  /** Each Executor's thread rollouts, saved beside the record: its whole turn, with the tool calls and web searches it made. */
  executorRollouts: string[];
  /** What was left out because it held a credential pattern or an account identifier that could not be replaced. Any entry fails the scenario. */
  withheld: string[];
};

/** What the fixture platform accepted from each identity that posts in the group: the Coordinator, then every Team Leader. */
function outboxes(state: State | undefined): Array<readonly [string, { text: unknown[]; media: unknown[] }]> {
  return [[COORDINATOR, { text: state?.feishuFixtureTextOutbox ?? [], media: state?.feishuFixtureMediaOutbox ?? [] }], ...Object.entries(state?.agentFixtureOutboxes ?? {})];
}
/** Every post the group received, in the order received, under the identity that sent it. */
export function groupPosts(state: State | undefined): GroupPost[] {
  return outboxes(state).flatMap(([identity, { text }]) => (text as Array<Omit<GroupPost, "identity">>).map(({ chatId, message, acceptedAt }) => ({ identity, chatId, message, acceptedAt })))
    .sort((left, right) => left.acceptedAt - right.acceptedAt);
}
/** Every file or image the group received, under the identity that sent it. */
export function deliveredFiles(state: State | undefined): DeliveredFile[] {
  return outboxes(state).flatMap(([identity, { media }]) => (media as Array<Omit<DeliveredFile, "identity">>).map(({ chatId, kind, fileName, bytesBase64 }) => ({ identity, chatId, kind, fileName, bytesBase64 })));
}

/**
 * What must never reach a record, wherever a text quotes it: the token fields of a login file, whose quotes are escaped once per
 * level of JSON nesting; a signed token; an API key. A key has a digit and a capital, which ordinary hyphenated words do not.
 */
const CREDENTIALS = [/\\*"(?:access_token|refresh_token|id_token)\\*"/u,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{20,}/u];
export function holdsCredential(text: string): boolean { return CREDENTIALS.some((pattern) => pattern.test(text)); }

const REDACTED = "<redacted>", WITHHELD = "<withheld: credential pattern>";
/** The logged-in account's identifiers, which the App Server writes into a rollout's first line. */
const ACCOUNT_IDENTIFIER = /("creator_(?:account|user)_id"\s*:\s*")[^"\\]*"/gu;
/** Such a field, in any quoting, whose value is neither the marker nor null: one the replacement could not reach. */
const UNREDACTED_IDENTIFIER = /\\*"creator_(?:account|user)_id\\*"\s*:\s*(?!"<redacted>"|null)/u;

/**
 * Copies every Executor's thread rollouts from a stopped service's state directory into `destination`, under the home's name, and
 * returns their paths there. Only files named as rollouts are copied, from Executor homes only, so nothing else of a home, such as
 * its login copy, can follow. A copy has the account's identifiers replaced by a marker and every other byte as it was. A rollout
 * that holds a credential pattern, or an identifier the replacement could not reach, is not copied; it is returned as withheld
 * with the reason.
 */
export function keepExecutorRollouts(stateDirectory: string, destination: string): { kept: string[]; withheld: string[] } {
  const runtimes = join(stateDirectory, ISOLATED_RUNTIME_KINDS.dispatchAgent.directory), kept: string[] = [], withheld: string[] = [];
  if (!existsSync(runtimes)) return { kept, withheld };
  for (const home of readdirSync(runtimes).filter((name) => EXECUTOR_RUNTIME_HOME.test(name)).sort()) {
    const codexHome = join(runtimes, home, "codex-home");
    for (const sessions of ["archived_sessions", "sessions"]) {
      if (!existsSync(join(codexHome, sessions))) continue;
      const rollouts = readdirSync(join(codexHome, sessions), { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)).map((entry) => join(entry.parentPath, entry.name)).sort();
      for (const rollout of rollouts) {
        const relative = join(home, rollout.slice(codexHome.length + 1)), original = readFileSync(rollout, "utf8");
        if (holdsCredential(original)) { withheld.push(`${relative} (credential pattern)`); continue; }
        const copy = original.replace(ACCOUNT_IDENTIFIER, `$1${REDACTED}"`);
        if (UNREDACTED_IDENTIFIER.test(copy)) { withheld.push(`${relative} (account identifier)`); continue; }
        mkdirSync(dirname(join(destination, relative)), { recursive: true });
        writeFileSync(join(destination, relative), copy);
        kept.push(relative);
      }
    }
  }
  return { kept, withheld };
}

/**
 * The run record of a scenario, from the state the service reports, and the delivered files to save with it. `failure` is the
 * scenario's own; `withheld` names what was already left out. A recorded turn that holds a credential pattern, in the group
 * memory or the discussion it was given for instance, keeps its place and loses its content, and is named as withheld too.
 */
export function runRecord(state: State | undefined, context: Pick<RunRecord, "scenario" | "acceptance" | "failure" | "startedAt" | "endedAt" | "messages" | "executorRollouts" | "withheld">):
  { record: RunRecord; files: Array<{ path: string; bytes: Buffer }> } {
  const withheld = [...context.withheld];
  const turns = (state?.fixtureDispatchTurns ?? []).map((turn, index) => {
    if (!holdsCredential(JSON.stringify(turn))) return turn;
    withheld.push(`turn ${index + 1} (credential pattern)`);
    return { ...turn, input: WITHHELD, ...(turn.output !== undefined ? { output: WITHHELD } : {}), ...(turn.error !== undefined ? { error: WITHHELD } : {}) };
  });
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const deliverables = deliveredFiles(state).map(({ identity, chatId, kind, fileName, bytesBase64 }) => {
    // A file name is the sender's own choice, so only its last segment names the saved copy.
    const savedAs = `deliverables/${files.length + 1}-${identity}-${basename(fileName)}`;
    files.push({ path: savedAs, bytes: Buffer.from(bytesBase64, "base64") });
    return { identity, chatId, kind, fileName, savedAs };
  });
  const failure = context.failure ?? (withheld.length ? `withheld from the record: ${withheld.join(", ")}` : undefined);
  return { files, record: { scenario: context.scenario, acceptance: context.acceptance, outcome: failure === undefined ? "passed" : "failed", ...(failure !== undefined ? { failure } : {}),
    startedAt: context.startedAt, endedAt: context.endedAt,
    models: (state?.codex?.models?.accounts ?? []).map(({ accountId, resolved }) => ({ accountId, ...resolved })), messages: context.messages,
    requests: state?.agentDispatch?.jobs ?? [], turns, posts: groupPosts(state), notices: state?.agentDispatch?.notices ?? [], deliverables,
    executorRollouts: context.executorRollouts, withheld } };
}

/**
 * Writes a scenario's record into `recordDirectory` once its service has stopped: the record itself, the service log, the delivered
 * files, the granted directory and the Executors' rollouts. `failure` is the scenario's own, if it has one. Returns the failure the
 * scenario ends with: its own, or else what had to be withheld from the record.
 */
export function saveRunRecord(run: { recordDirectory: string; stateDirectory: string; grantedDirectory: string; state: State | undefined; log: string; failure?: { error: unknown };
  context: Pick<RunRecord, "scenario" | "acceptance" | "startedAt" | "messages"> }): { error: unknown } | undefined {
  mkdirSync(join(run.recordDirectory, "deliverables"), { recursive: true });
  // The service has stopped, so every released Executor home is down to its rollouts and no App Server still writes one.
  const rollouts = keepExecutorRollouts(run.stateDirectory, join(run.recordDirectory, "executor-rollouts"));
  const { record, files } = runRecord(run.state, { ...run.context, endedAt: new Date().toISOString(),
    ...(run.failure ? { failure: run.failure.error instanceof Error ? run.failure.error.message : String(run.failure.error) } : {}),
    executorRollouts: rollouts.kept.map((path) => `executor-rollouts/${path}`), withheld: rollouts.withheld.map((path) => `executor-rollouts/${path}`) });
  writeFileSync(join(run.recordDirectory, "run-record.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(run.recordDirectory, "service.log"), run.log);
  for (const { path, bytes } of files) writeFileSync(join(run.recordDirectory, path), bytes);
  if (existsSync(run.grantedDirectory)) cpSync(run.grantedDirectory, join(run.recordDirectory, "granted-directory"), { recursive: true });
  console.info(`Dispatch real-model run record (${record.outcome}): ${run.recordDirectory}`);
  return run.failure ?? (record.failure !== undefined ? { error: new Error(record.failure) } : undefined);
}

const RESTING = ["proposed", "waiting", "completed", "partially_failed", "partially_unassigned", "failed", "cancelled"];
/**
 * Whether the handling of `messageId` is at rest: its classification ended, every post has a delivery outcome and every request
 * has ended or waits for its requester. Nothing more happens then until another message arrives.
 */
export function atRest(state: State, messageId: string): boolean {
  return (state.fixtureDispatchTurns ?? []).some((turn) => turn.turn === "classify" && turn.messageId === messageId && turn.endedAt !== undefined) &&
    (state.agentDispatch?.notices ?? []).every(({ state: delivery }) => delivery !== "queued" && delivery !== "sending") &&
    (state.agentDispatch?.jobs ?? []).every(({ status }) => RESTING.includes(status));
}

export type ScenarioRun = {
  /** Sends a group message from the owner; `mention` genuinely mentions that Team Leader's application. */
  send(messageId: string, text: string, options?: { mention?: TeamId }): Promise<void>;
  state(): Promise<State>;
  /** Waits for `predicate`; `what` names the awaited state in the failure when `timeoutMs` runs out. */
  until(what: string, predicate: (state: State) => boolean, timeoutMs: number): Promise<State>;
  /** The temporary directory granted to the Executors' file tools, where `files` were written. */
  grantedDirectory: string;
  /** The console's API as the authorized owner, for what a scenario sets up before its message: a POST and a GET of a JSON route. */
  post<T = unknown>(route: string, body: unknown): Promise<T>;
  get<T = unknown>(route: string): Promise<T>;
};

/**
 * Runs one scenario and returns its record's directory. `files` are written into the granted directory before the service
 * starts. Records go under DISPATCH_REAL_MODEL_RECORD_DIR, each run in a directory of its own, so a rerun never replaces the
 * record of the run before it. `records` and `env` are for this entry point's own test.
 */
export async function realModelScenario(scenario: { id: string; acceptance: string[]; files?: Record<string, string>; records?: string; env?: Record<string, string> },
  body: (run: ScenarioRun) => Promise<void>): Promise<string> {
  const startedAt = new Date();
  const records = scenario.records ?? process.env.DISPATCH_REAL_MODEL_RECORD_DIR ?? join(tmpdir(), "dispatch-real-model-records");
  const recordDirectory = join(records, `${startedAt.toISOString().replace(/[-:]|\.\d+/gu, "")}-${scenario.id}`);
  const directory = mkdtempSync(join(tmpdir(), "real-model-scenario-state-")), business = mkdtempSync(join(tmpdir(), "real-model-scenario-files-"));
  const grantedDirectory = join(business, "demo-vault");
  const messages: ScenarioMessage[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined, state: State | undefined, failure: { error: unknown } | undefined;
  // The first failure is the scenario's; later ones are consequences of it.
  const fail = (error: unknown) => { failure ??= { error }; };
  try {
    mkdirSync(join(grantedDirectory, ".obsidian"), { recursive: true });
    for (const [relative, content] of Object.entries(scenario.files ?? {})) {
      mkdirSync(dirname(join(grantedDirectory, relative)), { recursive: true });
      writeFileSync(join(grantedDirectory, relative), content);
    }
    dispatchConfig(directory, true);
    const service = running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business, WORKFLOW_FIXTURE_DISPATCH_REAL_MODEL: "1", ...scenario.env }, { ownProcessGroup: true });
    await allowNotes(service);
    await body({
      grantedDirectory,
      state: () => service.state(),
      post: (route, payload) => service.post(route, payload),
      get: (route) => service.get(route),
      async send(messageId, text, options = {}) {
        const mentioned = options.mention ? TEAMS[options.mention] : undefined;
        const content = JSON.stringify({ text: mentioned ? `@_user_0 ${text}` : text });
        messages.push({ messageId, senderId: OWNER, text, ...(options.mention ? { mention: options.mention } : {}) });
        // The event carries the mention as the receiving application sees it; the message's own details name the mentioned application.
        await service.post("/api/fixture/feishu/inbound", {
          event: { app_id: COORDINATOR_APPLICATION, sender: { sender_type: "user", sender_id: { open_id: OWNER } },
            message: { message_id: messageId, create_time: String(Date.now()), chat_id: GROUP, chat_type: "group", message_type: "text", content,
              mentions: mentioned ? [{ key: "@_user_0", id: { open_id: "ou_samview0" }, name: mentioned.name }] : [] } },
          ...(mentioned ? { messageDetails: { message_id: messageId, chat_id: GROUP, msg_type: "text", body: { content },
            mentions: [{ key: "@_user_0", id: mentioned.appId, id_type: "app_id", name: mentioned.name }] } } : {}),
        });
      },
      async until(what, predicate, timeoutMs) {
        try { return await service.until(predicate, timeoutMs); }
        catch (error) {
          // The service's own failure text repeats the whole state and log, which the record already holds.
          const exited = error instanceof Error && error.message.startsWith("fixture exited");
          throw new Error(exited ? `the service exited while waiting for ${what}` : `timed out after ${timeoutMs} ms waiting for ${what}`);
        }
      },
    });
  } catch (error) { fail(error); }
  try { state = await running?.state(); } catch (error) { fail(error); }
  const log = running?.output() ?? "";
  // The service stops before the record is written, so no Executor still writes into the granted directory or its own home.
  try { await running?.close(); } catch (error) { fail(error); }
  let ended = failure;
  try {
    ended = saveRunRecord({ recordDirectory, stateDirectory: directory, grantedDirectory, state, log, ...(failure ? { failure } : {}),
      context: { scenario: scenario.id, acceptance: scenario.acceptance, startedAt: startedAt.toISOString(), messages } });
  } catch (error) { ended ??= { error }; }
  rmSync(directory, { recursive: true, force: true });
  rmSync(business, { recursive: true, force: true });
  if (ended) throw ended.error;
  return recordDirectory;
}
