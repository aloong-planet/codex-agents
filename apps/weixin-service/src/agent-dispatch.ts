import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundContent, SendTextResult } from "./channel-contract.js";
import type { DispatchAgent, DispatchClassifier, DispatchDelivery, DispatchExecutor, DispatchJob, DispatchPendingResult } from "./agent-dispatch-types.js";
import { parseDispatchDecision } from "./agent-dispatch-classifier.js";
import { COORDINATOR_ID } from "./team-registry.js";
import type { PendingPresentation } from "./workflow-pending-response-coordinator.js";

type Notice = { event: InboundContent; agentId: string; senderAccountId: string; text: string; bindingHash: string; presentation?: Omit<PendingPresentation, "acceptedAt"> };
type NoticeRow = { id: string; payload: string; state: string; result: string | null };

/** One durable intake, independent specialist execution, and independently recorded delivery outcomes. */
export class AgentDispatch {
  private readonly database: DatabaseSync;
  private started = false;
  private closing = false;
  private readonly intake = new Map<string, Promise<void>>();
  private readonly workers = new Map<string, { operation: Promise<void>; abort: AbortController }>();

  constructor(databasePath: string, private readonly options: {
    agents: readonly DispatchAgent[];
    classifier: DispatchClassifier;
    executor: DispatchExecutor;
    delivery: DispatchDelivery;
    authorized(event: InboundContent): boolean;
    bindingHash(event: InboundContent): string;
    memory(event: InboundContent): string;
    completedWork(job: DispatchJob): string;
    presentation(event: InboundContent, runRef: string): Omit<PendingPresentation, "acceptedAt"> | undefined;
    presented(presentation: PendingPresentation): void;
    pending?(event: InboundContent): Promise<DispatchPendingResult>;
    report(code: string): void;
  }) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS dispatch_input (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, binding_hash TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_job (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_notice (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
    `);
    if (!this.database.prepare("PRAGMA table_info(dispatch_notice)").all().some((column) => column.name === "accepted_at")) {
      this.database.exec("ALTER TABLE dispatch_notice ADD COLUMN accepted_at INTEGER");
    }
  }

  admit(event: InboundContent): void {
    if (this.closing) throw new Error("dispatch_closed");
    if (!this.options.authorized(event) || event.conversationType !== "group") return;
    this.database.prepare("INSERT OR IGNORE INTO dispatch_input(id, target, payload, binding_hash, state) VALUES (?, ?, ?, ?, 'queued')")
      .run(event.key, event.target, JSON.stringify(event), this.options.bindingHash(event));
    setImmediate(() => this.kick());
  }

  async start(): Promise<void> {
    if (this.started || this.closing) throw new Error("dispatch_already_started");
    this.started = true;
    this.database.prepare("UPDATE dispatch_input SET state = 'queued' WHERE state = 'classifying'").run();
    this.database.prepare("UPDATE dispatch_notice SET state = 'unknown' WHERE state = 'sending'").run();
    for (const row of this.database.prepare("SELECT payload, accepted_at FROM dispatch_notice WHERE state = 'accepted' AND accepted_at IS NOT NULL ORDER BY sequence").all()) {
      this.markPresented(JSON.parse(String(row.payload)) as Notice, Number(row.accepted_at));
    }
    for (const job of this.jobs()) if (job.status === "running") {
      job.status = "failed"; job.result = `服务中断，本次处理已停止。${this.options.completedWork(job)}已有操作不会自动重复；请核对结果后明确重试。`;
      this.recordResult(job);
    }
    for (const row of this.database.prepare("SELECT id, payload FROM dispatch_notice WHERE state = 'queued' ORDER BY sequence").all()) {
      await this.deliverNotice(String(row.id), JSON.parse(String(row.payload)) as Notice);
    }
    this.kick();
  }

  getState() {
    return { jobs: this.jobs().map(({ id, agentId, senderAccountId, summary, status, result, attempt, runRef, event }) =>
      ({ id, agentId, senderAccountId, summary, status, result, attempt, runRef, accountId: event.accountId, target: event.target, requester: event.senderId })),
    notices: this.database.prepare("SELECT id, state FROM dispatch_notice ORDER BY sequence").all() };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const worker of this.workers.values()) worker.abort.abort();
    await Promise.allSettled([this.options.classifier.close?.(), this.options.executor.close()]);
    await Promise.allSettled([...this.intake.values(), ...[...this.workers.values()].map(({ operation }) => operation)]);
    this.database.close();
  }

  private kick(): void {
    if (!this.started || this.closing) return;
    for (const row of this.database.prepare("SELECT DISTINCT target FROM dispatch_input WHERE state = 'queued'").all()) {
      const target = String(row.target);
      if (this.intake.has(target)) continue;
      const operation = this.processInputs(target).catch(() => this.failure("dispatch_intake_failed"))
        .finally(() => { this.intake.delete(target); });
      this.intake.set(target, operation);
    }
    for (const job of this.jobs()) {
      if (job.status !== "queued" || [...this.workers.keys()].some((id) => {
        const active = this.job(id); return active?.event.target === job.event.target && active.agentId === job.agentId;
      })) continue;
      const abort = new AbortController();
      const operation = this.execute(job, abort.signal).catch(() => this.failure("dispatch_execution_record_failed"))
        .finally(() => { this.workers.delete(job.id); this.kick(); });
      this.workers.set(job.id, { operation, abort });
    }
  }

  private async processInputs(target: string): Promise<void> {
    while (!this.closing) {
      const row = this.database.prepare("SELECT * FROM dispatch_input WHERE target = ? AND state = 'queued' ORDER BY sequence LIMIT 1").get(target);
      if (!row) return;
      const event = JSON.parse(String(row.payload)) as InboundContent, bindingHash = String(row.binding_hash);
      if (!this.eligible(event, bindingHash)) { this.finishInput(event.key); continue; }
      this.database.prepare("UPDATE dispatch_input SET state = 'classifying' WHERE id = ?").run(event.key);
      if ((event.mentionedAgentIds?.length ?? 0) > 1) {
        await this.coordinate(event, bindingHash, "你点名了多个 Agent。这项事务希望由谁独立负责？");
        this.finishInput(event.key); continue;
      }
      const input = { event, agents: this.options.agents.map(({ id, name, responsibility }) => ({ id, name, responsibility })),
        requests: this.jobs().filter((job) => job.event.target === event.target && job.event.senderId === event.senderId)
          .slice(-20).map(({ id, agentId, summary, status }) => ({ id, agentId, summary, status })), memory: this.options.memory(event) };
      try {
        const pending = await this.options.pending?.(event);
        if (pending && !pending.handled && pending.cancelledRunRef) {
          const superseded = this.jobs().find((job) => job.runRef === pending.cancelledRunRef && job.event.target === event.target && job.event.senderId === event.senderId);
          if (superseded) { superseded.status = "cancelled"; this.save(superseded); }
        }
        if (pending?.handled) {
          const agent = this.options.agents.find((item) => pending.senderAccountId ? item.senderAccountId === pending.senderAccountId : item.id === COORDINATOR_ID);
          if (!agent) throw new Error("dispatch_pending_sender_unavailable");
          const original = this.jobs().find((job) => job.runRef === pending.runRef && job.event.target === event.target && job.event.senderId === event.senderId);
          const presentation = pending.result.status === "waiting" && pending.runRef ? this.options.presentation(event, pending.runRef) : undefined;
          const notice = { event, bindingHash, agentId: agent.id, senderAccountId: agent.senderAccountId, text: pending.result.message,
            ...(presentation ? { presentation } : {}) };
          if (original) {
            original.status = pending.result.status; original.result = pending.result.message;
            this.recordResult(original, `${event.key}:pending`, notice);
          } else this.queueNotice(`${event.key}:pending`, notice);
          await this.deliverNotice(`${event.key}:pending`, notice);
          this.finishInput(event.key); this.kick(); continue;
        }
        const decision = parseDispatchDecision(await this.options.classifier.classify(input), input);
        if (!this.eligible(event, bindingHash) || this.closing) { this.finishInput(event.key); continue; }
        if (decision.kind === "dispatch" || decision.kind === "propose") {
          const agent = this.options.agents.find((candidate) => candidate.id === decision.agentId)!;
          const named = this.options.agents.find(({ id }) => id === event.mentionedAgentIds?.[0]);
          if (decision.kind === "dispatch" && named && named.id !== COORDINATOR_ID && named.id !== agent.id) {
            const explanation = decision.message || `这项需求属于 ${agent.name} 的职责。我请 Sam 重新分派，由他独立处理。`;
            const informed = await this.deliverNotice(`${event.key}:scope`, { event, bindingHash, agentId: named.id, senderAccountId: named.senderAccountId, text: explanation });
            if (!informed.ok) { this.finishInput(event.key); continue; }
            const reassigned = await this.coordinate(event, bindingHash, `已将这项需求转派给 ${agent.name}。`);
            if (!reassigned.ok) { this.finishInput(event.key); continue; }
          }
          if (!this.job(event.key)) this.save({ id: event.key, event, bindingHash, agentId: agent.id, senderAccountId: agent.senderAccountId,
            summary: decision.summary, status: decision.kind === "propose" ? "proposed" : "queued", attempt: 0 });
          if (decision.kind === "propose") await this.coordinate(event, bindingHash,
            `要不要请 ${agent.name} 帮你${decision.summary}？请回复这条建议确认，或告诉我暂时不用。`);
        } else if (decision.kind === "confirm" || decision.kind === "decline") {
          const job = this.job(decision.requestId!);
          if (!job || job.status !== "proposed" || job.event.senderId !== event.senderId || job.event.target !== event.target || !this.eligible(job.event, job.bindingHash)) {
            await this.coordinate(event, bindingHash, "这条建议现在无法确认，请说明要处理的事务。");
          } else {
            job.status = decision.kind === "confirm" ? "queued" : "cancelled";
            if (decision.kind === "confirm") job.executionEvent = {
              ...event, text: `${(job.executionEvent ?? job.event).text}\n确认与要求：${event.text}`,
            };
            this.save(job);
            if (decision.kind === "decline") await this.coordinate(event, bindingHash, "好的，这条建议暂不处理。");
          }
        } else if (decision.kind === "cancel" || decision.kind === "supplement") {
          const job = this.job(decision.requestId!);
          if (!job || job.event.senderId !== event.senderId || job.event.target !== event.target || !this.eligible(job.event, job.bindingHash) ||
              !["queued", "running", "waiting", "proposed"].includes(job.status)) {
            await this.coordinate(event, bindingHash, "这项请求已经结束或无法继续，请说明新的需求。");
          } else if (decision.kind === "cancel") {
            job.cancelRequested = true; job.supplements = [];
            if (job.status === "running" && this.workers.has(job.id)) { this.save(job); this.workers.get(job.id)!.abort.abort(); }
            else {
              job.status = "cancelled"; job.result = `已停止继续处理。${this.options.completedWork(job)}已经完成的操作不会自动撤销。`;
              const report = this.recordResult(job, `${event.key}:cancelled`);
              await this.deliverNotice(report.id, report.notice);
            }
          } else {
            if ((job.supplements?.length ?? 0) >= 20) await this.coordinate(event, bindingHash, "这项请求已有多条补充待处理，请等当前处理结束后再补充。");
            else if (job.status === "running" || job.status === "queued") { (job.supplements ??= []).push(event); this.save(job); }
            else if (job.status === "proposed") {
              job.summary = decision.summary || job.summary;
              job.executionEvent = { ...event, text: `${(job.executionEvent ?? job.event).text}\n补充要求：${event.text}` }; this.save(job);
              await this.coordinate(event, bindingHash, "已补充到建议中。请确认是否开始处理。");
            } else { job.executionEvent = event; job.attempt++; job.status = "queued"; this.save(job); }
          }
        } else if (decision.kind === "retry" || decision.kind === "retry_report") {
          const job = this.job(decision.requestId!);
          if (!job || job.event.target !== event.target || job.event.senderId !== event.senderId || !this.eligible(job.event, job.bindingHash)) {
            await this.coordinate(event, bindingHash, "无法继续这项请求，请说明需要处理的事务。");
          } else if (decision.kind === "retry_report") {
            const originalId = job.reportId ?? `${job.id}:result:${job.attempt}`;
            const previous = this.database.prepare("SELECT state, payload FROM dispatch_notice WHERE id = ?").get(originalId);
            const retried = this.database.prepare("SELECT state FROM dispatch_notice WHERE id GLOB ?").all(`${originalId}:retry:*`);
            if (previous?.state === "rejected" && retried.every((notice) => notice.state === "rejected")) {
              await this.deliverNotice(`${originalId}:retry:${event.key}`, JSON.parse(String(previous.payload)) as Notice);
            } else await this.coordinate(event, bindingHash, "这条汇报已被接收或发送结果无法确认，不能自动重发。业务操作不会重新执行。");
          } else if (job.status === "failed") {
            job.status = "queued"; job.attempt++; job.retry = true; job.fixtureMessageId = event.messageId; this.save(job);
          } else await this.coordinate(event, bindingHash, "这项请求没有可重试的失败处理；已完成的操作不会重新执行。");
        } else if (decision.kind !== "ignore") {
          await this.coordinate(event, bindingHash, decision.message || "你指的是哪件事，希望得到什么结果？确认后我会交给合适的 Agent。");
        }
      } catch {
        if (!this.closing && this.eligible(event, bindingHash)) await this.coordinate(event, bindingHash, "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。");
      }
      this.finishInput(event.key);
      this.kick();
    }
  }

  private async execute(job: DispatchJob, signal: AbortSignal): Promise<void> {
    if (!this.eligible(job.event, job.bindingHash)) { job.status = "cancelled"; this.save(job); return; }
    job.status = "running"; this.save(job);
    try {
      const receipt = await this.deliverNotice(`${job.id}:receipt:${job.attempt}`, this.notice(job, `我准备处理：${job.summary}。完成后会在本群汇报。`));
      if (!receipt.ok) throw new Error("dispatch_receipt_unavailable");
      if (signal.aborted) throw new Error("dispatch_cancelled");
      const result = await this.options.executor.run(structuredClone(job), signal);
      job = this.job(job.id)!;
      job.status = result.status; job.result = result.message;
      if (result.runRef) job.runRef = result.runRef;
      if (result.status === "failed") job.result += this.options.completedWork(job);
    } catch (error) {
      job = this.job(job.id)!;
      job.status = "failed";
      job.result = error instanceof Error && error.message === "dispatch_receipt_unavailable"
        ? "接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。"
        : `${this.closing ? "服务中断，本次处理已停止。" : failureReason(error)}${this.options.completedWork(job)}已完成的操作不会自动重复，请补充信息后明确让我重试。`;
    }
    if (job.cancelRequested) {
      job.status = "cancelled"; job.result = `已停止继续处理。${this.options.completedWork(job)}已经完成的操作不会自动撤销。`; job.supplements = [];
    }
    // Delivery is a separate outcome: failure here must never restart completed business work.
    const report = this.recordResult(job);
    if (!this.closing) await this.deliverNotice(report.id, report.notice);
  }

  private recordResult(job: DispatchJob, id = `${job.id}:result:${job.attempt}`, notice = this.notice(job, job.result!, true)): { id: string; notice: Notice } {
    job.reportId = id;
    const report = { id: job.reportId, notice };
    this.transaction(() => {
      this.queueNotice(report.id, report.notice);
      if (job.status === "completed" && job.supplements?.length) {
        job.executionEvent = job.supplements.shift()!; job.attempt++; job.status = "queued";
        delete job.retry; delete job.fixtureMessageId; delete job.runRef;
      }
      this.save(job);
    });
    return report;
  }
  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { action(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private async coordinate(event: InboundContent, bindingHash: string, text: string) {
    const sam = this.options.agents.find(({ id }) => id === COORDINATOR_ID)!;
    return this.deliverNotice(`${event.key}:coordination`, { event, bindingHash, agentId: sam.id, senderAccountId: sam.senderAccountId, text });
  }
  private notice(job: DispatchJob, text: string, result = false): Notice {
    const presentation = result && job.status === "waiting" && job.runRef ? this.options.presentation(job.executionEvent ?? job.event, job.runRef) : undefined;
    return { event: job.event, bindingHash: job.bindingHash, agentId: job.agentId, senderAccountId: job.senderAccountId, text,
      ...(presentation ? { presentation } : {}) };
  }
  private markPresented(notice: Notice, acceptedAt: number): void {
    if (!notice.presentation) return;
    try { this.options.presented({ ...notice.presentation, acceptedAt }); }
    catch { this.failure("dispatch_presentation_record_failed"); }
  }
  private queueNotice(id: string, notice: Notice) {
    this.database.prepare("INSERT OR IGNORE INTO dispatch_notice(id, payload, state) VALUES (?, ?, 'queued')").run(id, JSON.stringify(notice));
  }
  private async deliverNotice(id: string, notice: Notice): Promise<SendTextResult> {
    this.queueNotice(id, notice);
    const row = this.database.prepare("SELECT id, payload, state, result FROM dispatch_notice WHERE id = ?").get(id) as NoticeRow;
    if (row.state !== "queued") return row.result ? JSON.parse(row.result) as SendTextResult : { ok: false, reason: "unknown", acceptedSegments: 0 };
    notice = JSON.parse(row.payload) as Notice;
    const eligible = () => this.eligible(notice.event, notice.bindingHash) &&
      this.options.agents.some((agent) => agent.id === notice.agentId && agent.senderAccountId === notice.senderAccountId);
    if (!eligible() || this.closing) {
      this.database.prepare("UPDATE dispatch_notice SET state = 'cancelled' WHERE id = ?").run(id);
      return { ok: false, reason: "unavailable", acceptedSegments: 0 };
    }
    this.database.prepare("UPDATE dispatch_notice SET state = 'sending' WHERE id = ?").run(id);
    let result: SendTextResult;
    try { result = await this.options.delivery({ accountId: notice.event.accountId, target: notice.event.target,
      senderAccountId: notice.senderAccountId, message: notice.text, operationId: `dispatch:${id}`, beforeSubmit: eligible }); }
    catch { result = { ok: false, reason: "unknown", acceptedSegments: 0 }; }
    const state = result.ok ? "accepted" : result.reason === "unknown" || (result.acceptedSegments ?? 0) > 0 ? "unknown" : "rejected";
    const acceptedAt = result.ok ? Date.now() : null;
    this.database.prepare("UPDATE dispatch_notice SET state = ?, result = ?, accepted_at = ? WHERE id = ?").run(state, JSON.stringify(result), acceptedAt, id);
    if (acceptedAt !== null) this.markPresented(notice, acceptedAt);
    return result;
  }
  private jobs(): DispatchJob[] { return this.database.prepare("SELECT payload FROM dispatch_job ORDER BY rowid").all().map((row) => JSON.parse(String(row.payload)) as DispatchJob); }
  private job(id: string): DispatchJob | undefined { const row = this.database.prepare("SELECT payload FROM dispatch_job WHERE id = ?").get(id); return row ? JSON.parse(String(row.payload)) as DispatchJob : undefined; }
  private save(job: DispatchJob) { this.database.prepare("INSERT INTO dispatch_job VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(job.id, JSON.stringify(job)); }
  private finishInput(id: string) { this.database.prepare("UPDATE dispatch_input SET state = 'completed' WHERE id = ?").run(id); }
  private eligible(event: InboundContent, bindingHash: string): boolean { return this.options.authorized(event) && this.options.bindingHash(event) === bindingHash; }
  private failure(code: string) { try { this.options.report(code); } catch { /* Diagnostics cannot change task outcomes. */ } }
}

function failureReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "dispatch_authorization_changed") return "权限或可用上下文发生变化，本次处理已停止。";
  if (code === "dispatch_model_unavailable") return "当前模型不可用，本次未能继续处理。";
  if (code.startsWith("main_reply_")) return "模型未返回有效的结果报告，本次处理已停止。";
  return "执行连接中断或处理出错，本次未能完成。";
}
