import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexConversation, CodexTurnModel } from "./codex-conversation.js";
import { ChannelTurnAdapter, type ConversationTurnToolControl } from "./channel-turn-adapter.js";
import { MAIN_REPLY_OUTPUT_SCHEMA, parseMainReply } from "./main-reply-result.js";
import { AppServerTurnFailure } from "./app-server-turn-driver.js";
import type { WorkflowHandoffReceipt } from "./workflow-tool-host.js";
import type { DispatchAgent, DispatchExecutor, DispatchExecutionResult, DispatchJob } from "./agent-dispatch-types.js";
import { COORDINATOR_ID } from "./team-registry.js";
import type { ProfileToolHost, ResolvedAgentProfile } from "./agent-profile.js";

type Runtime = { agent: CodexConversation; cwd: string };
type MemoryScope = ResolvedAgentProfile["memoryScope"];
/** Domain-neutral source rules every Executor turn carries; domain rules come only from the Agent Profile. */
const SHARED_EXECUTOR_RULES = "需要实时信息时先检索并读取可靠来源，来源必须支持对应事实，不能只把链接列在文末冒充查证。交付文件前复核其事实与来源是否相符。";

/** Group authority stays canonical; only the isolated session and outbound application vary by role. */
export class CodexDispatchExecutor implements DispatchExecutor {
  private readonly database: DatabaseSync;
  private readonly runtimes = new Map<string, Runtime>();
  private closing = false;
  constructor(databasePath: string, private readonly options: {
    agents: readonly DispatchAgent[];
    createRuntime(job: DispatchJob, scope: string, tools: ProfileToolHost): Runtime;
    tools: ConversationTurnToolControl;
    /** The job's Executor profile as resolved for its definitions version; the only source of its instructions, tools and memory scope. */
    profile(job: DispatchJob): Readonly<{ instructions: string; memoryScope: MemoryScope; tools: ProfileToolHost }>;
    contextRevision(job: DispatchJob): string;
    authorized(job: DispatchJob): boolean;
    model(job: DispatchJob): CodexTurnModel;
    memory(job: DispatchJob, scope: MemoryScope): string;
    capture(job: DispatchJob, scope: MemoryScope, reply: string): Promise<void>;
    existingResult(job: DispatchJob): DispatchExecutionResult | undefined;
    prepareThread?(job: DispatchJob, threadId: string): void;
  }) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS agent_session (scope TEXT PRIMARY KEY, thread_id TEXT NOT NULL)");
  }
  async run(job: DispatchJob, signal: AbortSignal): Promise<DispatchExecutionResult> {
    const role = this.options.agents.find(({ id }) => id === job.agentId);
    if (!role || role.id === COORDINATOR_ID || role.senderAccountId !== job.senderAccountId) throw new Error("dispatch_role_invalid");
    const revision = this.options.contextRevision(job);
    const eligible = () => !this.closing && !signal.aborted && this.options.authorized(job) && this.options.contextRevision(job) === revision;
    if (!eligible()) throw new Error("dispatch_authorization_changed");
    const existing = this.options.existingResult(job);
    if (existing) return existing;
    const profile = this.options.profile(job);
    const scope = createHash("sha256").update(JSON.stringify([job.event.accountId, job.event.target, role, job.bindingHash, revision, profile.tools.contractHash()])).digest("hex");
    let runtime = this.runtimes.get(scope);
    if (!runtime) { runtime = this.options.createRuntime(job, `dispatch-${scope}`, profile.tools); this.runtimes.set(scope, runtime); }
    const previous = this.database.prepare("SELECT thread_id FROM agent_session WHERE scope = ?").get(scope);
    const threadId = await runtime.agent.startOrResume(previous ? String(previous.thread_id) : undefined, runtime.cwd, []);
    this.database.prepare("INSERT INTO agent_session VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET thread_id = excluded.thread_id").run(scope, threadId);
    if (!eligible()) throw new Error("dispatch_authorization_changed");
    this.options.prepareThread?.(job, threadId);
    const event = { ...(job.executionEvent ?? job.event), agentId: role.id, dispatchRequestId: job.id, senderAccountId: job.senderAccountId, ...(job.retry ? { dispatchRetry: true } : {}) };
    const interrupt = () => { void runtime!.agent.interruptThread(threadId).catch(() => {}); };
    signal.addEventListener("abort", interrupt);
    let result: DispatchExecutionResult;
    try {
      const turn = await runtime.agent.runTurn(threadId, new ChannelTurnAdapter(threadId, event, {
        accountMemory: this.options.memory(job, profile.memoryScope), outboundRoots: [], channelLabel: "飞书", outboundDelivery: true,
        workflowTools: this.options.tools, isClosing: () => !eligible(), recoveryAllowed: eligible,
        roleInstructions: `你是 ${role.name}。你的职责：${role.responsibility}。你独立完成本次分派的事务：${job.summary}。不要冒充其他 Agent，不要把工作再分派给其他 Agent。只能使用本轮已授权能力，不能执行终端命令或操作网站后台；无法执行的步骤必须明确标记未执行。` + SHARED_EXECUTOR_RULES + profile.instructions,
      }), undefined, (progress) => { if (signal.aborted && progress.kind === "turn_accepted") interrupt(); },
      { ...this.options.model(job), outputSchema: MAIN_REPLY_OUTPUT_SCHEMA });
      if (turn.owner === "workflow_owned") result = this.receipt(turn.receipt);
      else {
        const parsed = parseMainReply(turn.finalText);
        result = { message: parsed.message, status: parsed.results.some(({ status }) => status === "needs_input") ? "waiting"
          : parsed.results.some(({ status }) => status !== "completed") ? "failed" : "completed" };
      }
    } catch (error) {
      if (!(error instanceof AppServerTurnFailure) || error.ownership.owner !== "workflow" || !error.ownership.receipt) throw error;
      result = this.receipt(error.ownership.receipt);
    } finally { signal.removeEventListener("abort", interrupt); }
    // A memory failure must not undo a completed business result or cause its effects to repeat.
    if (!signal.aborted) await this.options.capture(job, profile.memoryScope, result.message).catch(() => {});
    return result;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.runtimes.values()].map(({ agent }) => agent.close()));
    this.database.close();
  }
  private receipt(receipt: WorkflowHandoffReceipt): DispatchExecutionResult {
    return { status: receipt.outcome === "accepted" ? "completed" : receipt.outcome === "needs_input" ? "waiting" : "failed",
      message: receipt.reply, ...(receipt.runRef ? { runRef: receipt.runRef } : {}) };
  }
}
