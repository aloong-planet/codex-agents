import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * thread rollouts.
 */
export const realModelDispatch = process.env.DISPATCH_REAL_MODEL_TEST === "1";

const GROUP = "oc_alpha", OWNER = "ou_owner", COORDINATOR = "sam", COORDINATOR_APPLICATION = "cli_0123456789abcdef";
/** The seeded teams of `dispatchConfig`, by Team Leader. */
const TEAMS = { alice: { name: "Alice", appId: "cli_aaaaaaaaaaaaaaaa" }, bill: { name: "Bill", appId: "cli_bbbbbbbbbbbbbbbb" }, jack: { name: "Jack", appId: "cli_cccccccccccccccc" } } as const;
export type TeamId = keyof typeof TEAMS;

export type ScenarioMessage = { messageId: string; senderId: string; text: string; mention?: TeamId };
type Post = { identity: string; chatId: string; message: string; acceptedAt: number };
type Media = { chatId: string; kind: string; fileName: string; bytesBase64: string };
export type RunRecord = {
  scenario: string;
  /** The acceptance items the scenario checks. */
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
  /** Every turn of the Coordinator, the Team Leaders and the Executors: decisions, plans with their Briefs, results and closings. */
  turns: DispatchTurnRecord[];
  /** Every post the group received, in the order received, under the identity that sent it. */
  posts: Post[];
  /** The delivery state of every post the service tried to send. */
  notices: unknown[];
  /** Every file or image the group received, saved beside the record. */
  deliverables: Array<{ identity: string; chatId: string; kind: string; fileName: string; savedAs: string }>;
  /** Each Executor's thread rollouts, saved beside the record: its whole turn, with the tool calls and web searches it made. */
  executorRollouts: string[];
};

/** The run record of a scenario, from the state the service reports, and the delivered files to save with it. */
export function runRecord(state: State | undefined, context: Pick<RunRecord, "scenario" | "acceptance" | "outcome" | "failure" | "startedAt" | "endedAt" | "messages" | "executorRollouts">):
  { record: RunRecord; files: Array<{ path: string; bytes: Buffer }> } {
  const identities = [[COORDINATOR, { text: state?.feishuFixtureTextOutbox ?? [], media: state?.feishuFixtureMediaOutbox ?? [] }] as const,
    ...Object.entries(state?.agentFixtureOutboxes ?? {})];
  const posts = identities.flatMap(([identity, { text }]) => (text as Array<Omit<Post, "identity">>).map(({ chatId, message, acceptedAt }) => ({ identity, chatId, message, acceptedAt })))
    .sort((left, right) => left.acceptedAt - right.acceptedAt);
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const deliverables = identities.flatMap(([identity, { media }]) => (media as Media[]).map(({ chatId, kind, fileName, bytesBase64 }) => {
    const savedAs = `deliverables/${files.length + 1}-${identity}-${basename(fileName)}`;
    files.push({ path: savedAs, bytes: Buffer.from(bytesBase64, "base64") });
    return { identity, chatId, kind, fileName, savedAs };
  }));
  return { files, record: { ...context,
    models: (state?.codex?.models?.accounts ?? []).map(({ accountId, resolved }) => ({ accountId, ...resolved })),
    requests: state?.agentDispatch?.jobs ?? [], turns: state?.fixtureDispatchTurns ?? [], posts, notices: state?.agentDispatch?.notices ?? [], deliverables } };
}

/** What a login copy holds, and what a model credential looks like; a rollout that matches is never copied. */
const CREDENTIAL = /"(?:access_token|refresh_token|id_token)"|sk-[A-Za-z0-9_-]{20,}/u;
/**
 * Copies every Executor's thread rollouts from a stopped service's state directory into `destination`, under the home's name, and
 * returns their paths there. Only files named as rollouts are copied, from Executor homes only, so nothing else of a home, such as
 * its login copy, can follow. A rollout that holds a credential pattern is withheld and reported instead.
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
        const relative = join(home, rollout.slice(codexHome.length + 1));
        if (CREDENTIAL.test(readFileSync(rollout, "utf8"))) { withheld.push(relative); continue; }
        mkdirSync(dirname(join(destination, relative)), { recursive: true });
        copyFileSync(rollout, join(destination, relative));
        kept.push(relative);
      }
    }
  }
  return { kept, withheld };
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
  let running: Awaited<ReturnType<typeof start>> | undefined, state: State | undefined, failure: unknown, failed = false;
  const fail = (error: unknown) => { if (!failed) { failed = true; failure = error; } };
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
  // The service stops before the granted directory is copied, so no Executor still writes there.
  try { await running?.close(); } catch (error) { fail(error); }
  try {
    mkdirSync(join(recordDirectory, "deliverables"), { recursive: true });
    // The service has stopped, so every released Executor home is down to its rollouts and no App Server still writes one.
    const rollouts = keepExecutorRollouts(directory, join(recordDirectory, "executor-rollouts"));
    if (rollouts.withheld.length) fail(new Error(`withheld ${rollouts.withheld.length} Executor rollout(s) that hold a credential pattern: ${rollouts.withheld.join(", ")}`));
    const { record, files } = runRecord(state, { scenario: scenario.id, acceptance: scenario.acceptance, outcome: failed ? "failed" : "passed",
      ...(failed ? { failure: failure instanceof Error ? failure.message : String(failure) } : {}), startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), messages,
      executorRollouts: rollouts.kept.map((path) => `executor-rollouts/${path}`) });
    writeFileSync(join(recordDirectory, "run-record.json"), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(recordDirectory, "service.log"), log);
    for (const { path, bytes } of files) writeFileSync(join(recordDirectory, path), bytes);
    cpSync(grantedDirectory, join(recordDirectory, "granted-directory"), { recursive: true });
    console.info(`Dispatch real-model run record (${failed ? "failed" : "passed"}): ${recordDirectory}`);
  } catch (error) { fail(error); }
  rmSync(directory, { recursive: true, force: true });
  rmSync(business, { recursive: true, force: true });
  if (failed) throw failure;
  return recordDirectory;
}
