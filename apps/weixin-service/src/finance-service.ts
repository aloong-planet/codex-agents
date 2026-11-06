import { createHash } from "node:crypto";
import path from "node:path";
import { settleCleanup } from "./async-cleanup.js";
import { DurableEffectLedger } from "./durable-effect-ledger.js";
import type { FeishuTransport } from "./feishu-channel.js";
import { FeishuInboundMedia, type FeishuResourceTransport } from "./feishu-inbound-media.js";
import type { FinanceConfiguration } from "./finance-config.js";
import { financeEntryDraft, financeImageRows, parseFinanceCommand, type FinanceInterpreter } from "./finance-interpreter.js";
import { FinanceJournal, type FinanceJournalEntry, type FinancePlan, type FinanceReply } from "./finance-journal.js";
import { FinanceLedger, type FinancePreview, type FinanceTurn } from "./finance-ledger.js";
import { financeErrorText, financePreviewReply, financeQueryReply, financeWriteReply } from "./finance-reply.js";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Transport = FeishuTransport & FeishuResourceTransport;

/** This consumer only accepts the authenticated receiver's projection; never register it on the group router. */
export class FinanceService {
  private readonly ledger: FinanceLedger;
  private readonly journal: FinanceJournal;
  private readonly effects: DurableEffectLedger;
  private readonly media: FeishuInboundMedia;
  private queue: Promise<void> = Promise.resolve();
  private ready = false;
  private closed = false;
  private error: string | undefined;

  constructor(private readonly options: { root: string; config: FinanceConfiguration; transport: Transport; interpreter: FinanceInterpreter }) {
    const { appId, tenantKey, ownerOpenId } = options.config;
    this.ledger = new FinanceLedger({ databasePath: path.join(options.root, "ledger.sqlite"), binding: { appId, tenantKey, ownerOpenId } });
    try {
      this.journal = new FinanceJournal(path.join(options.root, "journal.sqlite"));
      this.effects = new DurableEffectLedger(path.join(options.root, "effects.sqlite"));
      this.media = new FeishuInboundMedia(path.join(options.root, "media"), options.config.privateChatId, options.transport);
    } catch (error) { this.ledger.close(); throw error; }
  }

  state(): { ready: boolean; error?: string } { return { ready: this.ready, ...(this.error ? { error: this.error } : {}) }; }
  async start(): Promise<void> {
    await this.options.transport.start({ message: (event) => this.receive(event), ready: () => { this.ready = true; this.error = undefined; },
      unavailable: () => { this.ready = false; this.error = "penny_connection_unavailable"; } });
  }
  receive(event: unknown): Promise<void> {
    const task = this.queue.then(() => this.handle(event));
    this.queue = task.catch(() => { this.error = "penny_processing_unavailable"; });
    return task;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.ready = false;
    await settleCleanup([async () => { await this.options.transport.close(); this.closed = true; }, () => this.queue, () => this.options.interpreter.close(),
      () => this.ledger.close(), () => this.journal.close(), () => this.effects.close()]);
  }

  private async handle(event: unknown): Promise<void> {
    const config = this.options.config, root = object(event), sender = object(root?.sender), message = object(root?.message);
    if (this.closed || root?.app_id !== config.appId || root?.tenant_key !== config.tenantKey || sender?.sender_type !== "user" ||
        object(sender.sender_id)?.open_id !== config.ownerOpenId || message?.chat_type !== "p2p" || message.chat_id !== config.privateChatId) return;
    if (typeof message.message_id !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/u.test(message.message_id) ||
        typeof message.message_type !== "string" || typeof message.content !== "string" || message.content.length > 64 * 1024 ||
        typeof message.create_time !== "string" || !/^\d{10,16}$/u.test(message.create_time)) return;
    const occurredAt = Number(message.create_time);
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > 8.64e15) return;
    const key = hash(JSON.stringify([config.appId, config.tenantKey, config.ownerOpenId, config.privateChatId, message.message_id]));
    const inputHash = hash(JSON.stringify([message.message_type, message.content, occurredAt]));
    let entry = this.journal.get(key);
    if (entry && entry.inputHash !== inputHash) { this.error = "penny_inbound_conflict"; return; }
    if (entry?.completed) return;
    const turn: FinanceTurn = { appId: config.appId, tenantKey: config.tenantKey, senderOpenId: config.ownerOpenId, senderType: "user",
      conversationType: "private", eventKey: key, occurredAt, text: entry?.text ?? "", hasAttachments: entry?.hasAttachments ?? message.message_type !== "text" };
    if (!entry) {
      entry = { key, inputHash, text: "" };
      if (message.message_type === "file") {
        entry.reply = { text: "账单文件导入还在等待来源格式验证，本次未入账。你可以先用文字记账，或发送支付截图核对预览。" };
      } else {
        try {
          const content = await this.media.normalize({ messageId: message.message_id, type: message.message_type, content: message.content });
          turn.text = content.text; turn.hasAttachments = Boolean(content.attachments?.length); entry.text = content.text; entry.hasAttachments = turn.hasAttachments;
          const images = (content.attachments ?? []).filter((attachment) => attachment.kind === "image" && !attachment.quoted).map((attachment) => attachment.path);
          if (images.length > 8) throw new Error("finance_image_limit");
          const context = { ...this.ledger.context(turn), recent: this.journal.recent() };
          for (const ref of new Set(turn.text.match(/F\d{8,}/gu) ?? [])) {
            if (!context.records.some((record) => record.ref === ref)) {
              try { context.records.push(this.ledger.inspect(turn, ref).record); } catch { /* Unknown references remain a clarification. */ }
            }
          }
          for (const id of new Set(turn.text.match(/Q\d{8,}/gu) ?? [])) {
            if (!context.previews.some((preview) => preview.id === id)) {
              try { context.previews.push(this.ledger.preview(turn, id)); } catch { /* Unknown references remain a clarification. */ }
            }
          }
          const input = { text: turn.text, occurredAt, images, context };
          const control = !images.length ? this.control(turn.text, context.previews) : undefined;
          entry.plan = control ?? parseFinanceCommand({ command: await this.options.interpreter.interpret(input) }, input);
        } catch { entry.reply = { text: "本次未修改账本。消息或截图暂时无法可靠识别，请补充实际金额、收付款日期与方向；截图可重新发送清晰版本。" }; }
      }
      this.journal.save(entry);
    }
    if (!entry.reply) {
      try { entry.reply = this.execute(turn, entry); }
      catch (error) {
        const code = error instanceof Error && /^finance_[a-z_]+$/u.test(error.message) ? error.message : "finance_operation_failed";
        entry.reply = { text: `本次操作未完成。${code === "finance_operation_failed" ? "账本暂时不可用，请稍后明确重试或查询已有记录。" : financeErrorText(code)}` };
      }
      this.journal.save(entry);
    }
    const accepted = await this.deliver(key, entry.reply.text);
    if (accepted && entry.reply.preview) this.ledger.markPresented(turn, entry.reply.preview.id, entry.reply.preview.revision);
    entry.completed = true; this.journal.save(entry);
  }

  private control(text: string, previews: FinancePreview[]): FinancePlan | undefined {
    const value = text.trim();
    const confirmation = /^(确认|取消) (Q\d{8,})\/(\d+)$/u.exec(value);
    if (confirmation) return { kind: confirmation[1] === "确认" ? "confirm" : "cancel", id: confirmation[2]!, revision: Number(confirmation[3]) };
    const show = /^查看预览 (Q\d{8,})$/u.exec(value);
    if (show) return { kind: "show", id: show[1]! };
    const duplicate = /^(另记|重复) (Q\d{8,})\/(\d+) 第(\d+)条(?: (F\d{8,}))?$/u.exec(value);
    if (duplicate && (duplicate[1] === "重复") === Boolean(duplicate[5])) return { kind: "duplicate", id: duplicate[2]!, revision: Number(duplicate[3]),
      rowIndex: Number(duplicate[4]) - 1, ...(duplicate[5] ? { existingRef: duplicate[5] } : {}) };
    if (/^(确认|确认入账|确认撤销|好的|是的|取消)[。！!]?$/u.test(value)) {
      const pending = previews.filter((preview) => preview.status === "pending");
      if (value.startsWith("取消") && pending.length === 1) return { kind: "cancel", id: pending[0]!.id, revision: pending[0]!.revision };
      return { kind: "clarify", question: `请明确当前预览编号和版本后操作${pending.length ? `：${pending.map((preview) => `${preview.id}/${preview.revision}`).join("、")}` : "，目前没有待确认预览"}。例如“确认 Q00000001/1”。` };
    }
    return undefined;
  }

  private execute(turn: FinanceTurn, entry: FinanceJournalEntry): FinanceReply {
    const plan = entry.plan;
    if (!plan) throw new Error("finance_command_invalid");
    const previewReply = (preview: FinancePreview): FinanceReply => ({ text: financePreviewReply(preview),
      ...(preview.status === "pending" ? { preview: { id: preview.id, revision: preview.revision } } : {}) });
    switch (plan.kind) {
      case "clarify": return { text: `本次未修改账本。${plan.question}` };
      case "record": {
        const drafts = plan.entries.map((item) => financeEntryDraft(item, plan.book));
        try { return { text: financeWriteReply(this.ledger.record(turn, drafts)) }; }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "finance_duplicate_possible") throw error;
          // Save the selected continuation before preparing it; recovery must not reinterpret or retry the original write.
          entry.plan = { kind: "textPreview", drafts }; this.journal.save(entry);
          return previewReply(this.ledger.prepareText(turn, drafts));
        }
      }
      case "textPreview": return previewReply(this.ledger.prepareText(turn, plan.drafts));
      case "preview": return previewReply(this.ledger.prepareImport(turn, { kind: "screenshot", book: plan.book, rows: financeImageRows(plan.entries, plan.book) }));
      case "revise": return previewReply(this.ledger.reviseImport(turn, plan.previewId, plan.revision, { kind: "screenshot", book: plan.book, rows: financeImageRows(plan.entries, plan.book) }));
      case "query": return { text: financeQueryReply(this.ledger.query(turn, { book: plan.book, from: plan.from, to: plan.to, ...(plan.category ? { category: plan.category } : {}) })) };
      case "inspect": {
        const result = this.ledger.inspect(turn, plan.ref);
        return { text: `记录 ${result.record.ref}${result.record.withdrawn ? "（已撤销）" : ""}\n${result.history.map((record) => financeWriteReply({ status: record.withdrawn ? "withdrawn" : "corrected", records: [record] })).join("\n")}` };
      }
      case "correct": return { text: financeWriteReply(this.ledger.correct(turn, plan.ref, plan.revision, financeEntryDraft(plan.replacement, plan.book))) };
      case "withdraw": return previewReply(this.ledger.prepareWithdrawal(turn, plan.ref, plan.revision));
      case "confirm": return { text: financeWriteReply(this.ledger.confirm(turn, plan.id, plan.revision)) };
      case "cancel": return previewReply(this.ledger.cancel(turn, plan.id, plan.revision));
      case "show": return previewReply(this.ledger.preview(turn, plan.id));
      case "duplicate": return previewReply(this.ledger.resolveDuplicate(turn, plan.id, plan.revision, plan.rowIndex, plan.existingRef));
    }
  }

  private async deliver(key: string, text: string): Promise<boolean> {
    const points = Array.from(text), operationId = `penny:${key}`, config = this.options.config;
    for (let offset = 0, ordinal = 0; offset < points.length; offset += 4000, ordinal++) {
      const segment = points.slice(offset, offset + 4000).join(""), attemptId = `${operationId}:${ordinal}`;
      const existing = this.effects.listByOperation(operationId).find((effect) => effect.attemptId === attemptId);
      const clientId = hash(JSON.stringify([attemptId, segment])).slice(0, 32);
      const prepared = this.effects.prepare({ attemptId, operationId, causeEventKey: key, accountId: config.appId,
        target: `feishu.${hash(JSON.stringify([config.appId, config.privateChatId]))}`, kind: "feishu_text", clientId, ordinal });
      if (existing) {
        if (prepared.state === "accepted") continue;
        this.error = prepared.state === "rejected" ? "penny_reply_rejected" : "penny_reply_unknown"; return false;
      }
      let response: Awaited<ReturnType<FeishuTransport["sendText"]>>;
      try { response = await this.options.transport.sendText({ chatId: config.privateChatId, text: segment, uuid: clientId }); }
      catch { this.effects.settle(attemptId, "unknown"); this.error = "penny_reply_unknown"; return false; }
      if (response.code !== 0 || !response.data?.message_id) {
        const rejected = Number.isSafeInteger(response.code) && response.code !== 0;
        this.effects.settle(attemptId, rejected ? "rejected" : "unknown", rejected ? response.code : undefined);
        this.error = rejected ? "penny_reply_rejected" : "penny_reply_unknown"; return false;
      }
      this.effects.settle(attemptId, "accepted");
    }
    this.error = undefined; return true;
  }
}
