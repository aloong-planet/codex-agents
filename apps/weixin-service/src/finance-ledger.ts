import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  financeMessageDate, formatCnyAmount, parseCnyAmount, summarizeFinance, validateFinanceDate,
  type FinanceBook, type FinanceKind, type FinancePosting, type FinanceQuery,
} from "./finance-domain.js";

export type FinanceBinding = { appId: string; tenantKey: string; ownerOpenId: string };
/** Populated by the authenticated private inlet, never from model arguments. */
export type FinanceTurn = {
  appId: string; tenantKey: string; senderOpenId: string; senderType: "user" | "app";
  conversationType: "private" | "group"; eventKey: string; occurredAt: number;
  text: string; hasAttachments?: boolean;
};
export type FinanceDraft = {
  book?: FinanceBook; date?: string; kind: FinanceKind; amount: string; currency?: string;
  description: string; category?: string;
  selfTransferConfirmed?: boolean;
  refundOf?: { recordRef: string } | { unrecorded: string };
};
export type FinanceRecord = FinancePosting & {
  ref: string; revision: number; description: string; currency: "CNY";
  provenance: { kind: "text" | "statement" | "screenshot"; eventKey: string; profile?: string; eventId?: string };
  createdAt: number; updatedAt: number;
  selfTransferConfirmed?: boolean; refundOf?: FinanceDraft["refundOf"];
};
export type FinanceWriteResult = { status: "recorded" | "corrected" | "withdrawn"; records: FinanceRecord[];
  skipped?: { duplicates: number; excluded: number } };
export type FinanceImportRow = { draft?: FinanceDraft; source?: { profile: string; eventId: string }; issue?: string; excluded?: string };
export type FinanceImport = { book?: FinanceBook; kind: "statement" | "screenshot"; rows: FinanceImportRow[] };
type NormalizedPosting = Omit<FinanceRecord, "ref" | "revision" | "provenance" | "createdAt" | "updatedAt">;
export type FinancePreviewRow = FinanceImportRow & { posting?: NormalizedPosting; duplicateRef?: string; duplicateOfRow?: number;
  possibleDuplicateRefs?: string[]; duplicateDecision?: "distinct" | "existing" };
export type FinancePreview = {
  id: string; revision: number; status: "pending" | "committed" | "cancelled";
  book: FinanceBook; kind: "text" | "statement" | "screenshot" | "withdrawal"; rows: FinancePreviewRow[];
  eventKey: string; presentedRevision: number | null; result?: FinanceWriteResult;
  withdrawal?: { ref: string; revision: number };
};

export class FinanceLedger {
  private readonly database: DatabaseSync;
  private readonly binding: FinanceBinding;
  private readonly now: () => number;
  private closed = false;

  constructor(options: { databasePath: string; binding: FinanceBinding; now?: () => number; busyTimeoutMs?: number }) {
    this.binding = { ...options.binding };
    for (const value of Object.values(this.binding)) requireText(value, 256);
    this.now = options.now ?? Date.now;
    const directory = path.dirname(options.databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("finance_storage_invalid");
    fs.chmodSync(directory, 0o700);
    if (fs.existsSync(options.databasePath)) {
      const stat = fs.lstatSync(options.databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("finance_storage_invalid");
      fs.chmodSync(options.databasePath, 0o600);
    } else fs.closeSync(fs.openSync(options.databasePath, "wx", 0o600));
    this.database = new DatabaseSync(options.databasePath);
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) { this.database.close(); throw new Error("finance_storage_invalid"); }
    try {
      this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = ${timeout};
        CREATE TABLE IF NOT EXISTS finance_binding (id INTEGER PRIMARY KEY CHECK(id = 1), binding_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS finance_record (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS finance_revision (ref TEXT NOT NULL, revision INTEGER NOT NULL, data_json TEXT NOT NULL,
          event_key TEXT NOT NULL, PRIMARY KEY(ref, revision));
        CREATE TABLE IF NOT EXISTS finance_operation (event_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS finance_preview (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS finance_source (source_key TEXT PRIMARY KEY, record_ref TEXT NOT NULL, fingerprint TEXT NOT NULL);
      `);
      this.transaction(() => {
        const hash = digest(this.binding);
        this.database.prepare("INSERT OR IGNORE INTO finance_binding VALUES (1, ?)").run(hash);
        if (this.database.prepare("SELECT binding_hash FROM finance_binding WHERE id = 1").get()?.binding_hash !== hash) {
          throw new Error("finance_binding_changed");
        }
      });
    } catch (error) { this.database.close(); throw error; }
  }

  record(turn: FinanceTurn, drafts: readonly FinanceDraft[]): FinanceWriteResult {
    this.admit(turn);
    if (turn.hasAttachments) throw new Error("finance_preview_required");
    return this.mutate(turn, { action: "record", drafts }, () => {
      if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 1000) throw new Error("finance_batch_invalid");
      const records = drafts.map((draft) => {
        const posting = this.normalize(draft, turn);
        if (this.possibleDuplicates(posting).length) throw new Error("finance_duplicate_possible");
        return this.insert(posting, { kind: "text", eventKey: turn.eventKey }, turn);
      });
      return { status: "recorded", records };
    });
  }

  prepareText(turn: FinanceTurn, drafts: FinanceDraft[]): FinancePreview {
    this.admit(turn);
    if (turn.hasAttachments) throw new Error("finance_preview_required");
    return this.mutate(turn, { action: "prepare_text", drafts }, () => {
      const books = new Set(drafts.map((draft) => draft.book ?? "personal"));
      if (books.size !== 1) throw new Error("finance_batch_mixed_books");
      const content = this.importContent({ kind: "statement", book: drafts[0]?.book ?? "personal", rows: drafts.map((draft) => ({
        draft: { ...draft, date: draft.date ?? financeMessageDate(turn.occurredAt) },
      })) }, turn);
      const id = this.database.prepare("INSERT INTO finance_preview(data_json) VALUES ('{}')").run().lastInsertRowid;
      const preview: FinancePreview = { ...content, kind: "text", id: `Q${String(id).padStart(8, "0")}`, revision: 1,
        status: "pending", eventKey: turn.eventKey, presentedRevision: null };
      this.database.prepare("UPDATE finance_preview SET ref = ?, data_json = ? WHERE id = ?").run(preview.id, JSON.stringify(preview), id);
      return preview;
    });
  }

  prepareImport(turn: FinanceTurn, input: FinanceImport): FinancePreview {
    this.admit(turn);
    return this.mutate(turn, { action: "prepare", input }, () => {
      const content = this.importContent(input, turn);
      const id = this.database.prepare("INSERT INTO finance_preview(data_json) VALUES ('{}')").run().lastInsertRowid;
      const preview: FinancePreview = { ...content, id: `Q${String(id).padStart(8, "0")}`, revision: 1,
        status: "pending", eventKey: turn.eventKey, presentedRevision: null };
      this.database.prepare("UPDATE finance_preview SET ref = ?, data_json = ? WHERE id = ?").run(preview.id, JSON.stringify(preview), id);
      return preview;
    });
  }

  reviseImport(turn: FinanceTurn, id: string, revision: number, input: FinanceImport): FinancePreview {
    this.admit(turn);
    return this.mutate(turn, { action: "revise", id, revision, input }, () => {
      const preview = this.pendingPreview(id, revision);
      if (preview.kind !== input.kind) throw new Error("finance_preview_kind_invalid");
      const updated = { ...preview, ...this.importContent(input, turn), revision: revision + 1, eventKey: turn.eventKey, presentedRevision: null };
      this.savePreview(updated); return updated;
    });
  }

  resolveDuplicate(turn: FinanceTurn, id: string, revision: number, rowIndex: number, existingRef?: string): FinancePreview {
    this.admit(turn);
    const expected = existingRef ? `重复 ${id}/${revision} 第${rowIndex + 1}条 ${existingRef}` : `另记 ${id}/${revision} 第${rowIndex + 1}条`;
    if (turn.text.trim() !== expected) throw new Error("finance_confirmation_required");
    return this.mutate(turn, { action: "duplicate", id, revision, rowIndex, existingRef }, () => {
      const preview = this.pendingPreview(id, revision), row = preview.rows[rowIndex];
      if (preview.presentedRevision !== revision || preview.eventKey === turn.eventKey) throw new Error("finance_preview_not_presented");
      if (!Number.isSafeInteger(rowIndex) || row?.issue !== "finance_duplicate_possible" || !row.possibleDuplicateRefs?.length ||
          (existingRef && !row.possibleDuplicateRefs.includes(existingRef))) throw new Error("finance_duplicate_choice_invalid");
      delete row.issue;
      if (existingRef) row.duplicateRef = existingRef;
      row.duplicateDecision = existingRef ? "existing" : "distinct";
      const updated = { ...preview, revision: revision + 1, eventKey: turn.eventKey, presentedRevision: null };
      this.savePreview(updated); return updated;
    });
  }

  preview(turn: FinanceTurn, id: string): FinancePreview {
    this.admit(turn); return this.getPreview(id);
  }

  /** Called only after the host has delivered the complete exact preview to this private owner. */
  markPresented(turn: FinanceTurn, id: string, revision: number): void {
    this.admit(turn);
    this.transaction(() => {
      const preview = this.pendingPreview(id, revision);
      this.savePreview({ ...preview, presentedRevision: revision });
    });
  }

  confirm(turn: FinanceTurn, id: string, revision: number): FinanceWriteResult {
    this.admit(turn);
    if (turn.text.trim() !== `确认 ${id}/${revision}`) throw new Error("finance_confirmation_required");
    return this.mutate(turn, { action: "confirm", id, revision }, () => {
      const preview = this.getPreview(id);
      if (preview.revision !== revision) throw new Error("finance_preview_stale");
      if (preview.status === "committed" && preview.result) return preview.result;
      if (preview.status !== "pending") throw new Error("finance_preview_closed");
      if (preview.eventKey === turn.eventKey || preview.presentedRevision !== revision) throw new Error("finance_preview_not_presented");
      if (preview.rows.some((row) => row.issue)) throw new Error("finance_preview_unresolved");
      if (preview.kind === "withdrawal") {
        if (!preview.withdrawal) throw new Error("finance_preview_unresolved");
        const record = this.currentRecord(preview.withdrawal.ref, preview.withdrawal.revision);
        const withdrawn = this.updateRecord({ ...record, withdrawn: true }, turn);
        const result: FinanceWriteResult = { status: "withdrawn", records: [withdrawn] };
        this.savePreview({ ...preview, status: "committed", result }); return result;
      }
      const kind = preview.kind;
      for (const row of preview.rows) {
        if (row.source && row.posting && !row.excluded) {
          const known = this.sourceRecord(row.source, row.posting);
          if (row.duplicateDecision !== "existing" && (known?.record_ref ?? undefined) !== row.duplicateRef) throw new Error("finance_preview_changed");
          if (known && known.record_ref !== row.duplicateRef) throw new Error("finance_preview_changed");
        }
        if (row.posting && !row.excluded && !row.duplicateRef && row.duplicateOfRow === undefined) {
          const candidates = this.possibleDuplicates(row.posting, row.source);
          if (candidates.length && (row.duplicateDecision !== "distinct" || candidates.some((ref) => !row.possibleDuplicateRefs?.includes(ref)))) {
            throw new Error("finance_preview_changed");
          }
        }
        if (row.duplicateDecision === "existing" && row.source && row.posting && row.duplicateRef) {
          this.database.prepare("INSERT OR IGNORE INTO finance_source VALUES (?, ?, ?)")
            .run(sourceKey(row.source, row.posting), row.duplicateRef, postingFingerprint(row.posting));
        }
      }
      const records = preview.rows.filter((row) => !row.excluded && !row.duplicateRef && row.duplicateOfRow === undefined).map((row) => {
        if (!row.posting) throw new Error("finance_preview_unresolved");
        const record = this.insert(row.posting, { kind, eventKey: preview.eventKey, ...row.source }, turn);
        if (row.source) this.database.prepare("INSERT INTO finance_source VALUES (?, ?, ?)")
          .run(sourceKey(row.source, row.posting), record.ref, postingFingerprint(row.posting));
        return record;
      });
      const result: FinanceWriteResult = { status: "recorded", records, skipped: {
        duplicates: preview.rows.filter((row) => row.duplicateRef || row.duplicateOfRow !== undefined).length,
        excluded: preview.rows.filter((row) => row.excluded).length,
      } };
      this.savePreview({ ...preview, status: "committed", result }); return result;
    });
  }

  cancel(turn: FinanceTurn, id: string, revision: number): FinancePreview {
    this.admit(turn);
    return this.mutate(turn, { action: "cancel", id, revision }, () => {
      const preview = this.pendingPreview(id, revision), cancelled = { ...preview, status: "cancelled" as const };
      this.savePreview(cancelled); return cancelled;
    });
  }

  correct(turn: FinanceTurn, ref: string, revision: number, patch: Partial<FinanceDraft>): FinanceWriteResult {
    this.admit(turn);
    if (turn.hasAttachments) throw new Error("finance_preview_required");
    return this.mutate(turn, { action: "correct", ref, revision, patch }, () => {
      if (!Object.keys(patch).length || Object.keys(patch).some((key) =>
        !["book", "date", "kind", "amount", "currency", "description", "category", "refundOf", "selfTransferConfirmed"].includes(key))) throw new Error("finance_patch_invalid");
      const record = this.currentRecord(ref, revision);
      const normalized = this.normalize({ book: record.book, date: record.date, kind: record.kind,
        amount: formatCnyAmount(record.amountMinor), description: record.description, category: record.category,
        ...(record.refundOf ? { refundOf: record.refundOf } : {}), ...(record.selfTransferConfirmed ? { selfTransferConfirmed: true } : {}), ...patch }, turn);
      this.validateRelationship(normalized, record.ref);
      return { status: "corrected", records: [this.updateRecord({ ...normalized, ref: record.ref, revision: record.revision,
        provenance: record.provenance, createdAt: record.createdAt, updatedAt: record.updatedAt }, turn)] };
    });
  }

  prepareWithdrawal(turn: FinanceTurn, ref: string, revision: number): FinancePreview {
    this.admit(turn);
    return this.mutate(turn, { action: "withdrawal", ref, revision }, () => {
      const record = this.currentRecord(ref, revision);
      const id = this.database.prepare("INSERT INTO finance_preview(data_json) VALUES ('{}')").run().lastInsertRowid;
      const preview: FinancePreview = { id: `Q${String(id).padStart(8, "0")}`, revision: 1, status: "pending", book: record.book,
        kind: "withdrawal", rows: [{ posting: record }], eventKey: turn.eventKey, presentedRevision: null, withdrawal: { ref, revision } };
      this.database.prepare("UPDATE finance_preview SET ref = ?, data_json = ? WHERE id = ?").run(preview.id, JSON.stringify(preview), id);
      return preview;
    });
  }

  query(turn: FinanceTurn, query: FinanceQuery) {
    this.admit(turn);
    return summarizeFinance(this.records(), query);
  }

  inspect(turn: FinanceTurn, ref: string): { record: FinanceRecord; history: FinanceRecord[] } {
    this.admit(turn);
    const record = this.getRecord(ref);
    return { record, history: this.database.prepare("SELECT data_json FROM finance_revision WHERE ref = ? ORDER BY revision")
      .all(ref).map((row) => JSON.parse(String(row.data_json)) as FinanceRecord) };
  }

  context(turn: FinanceTurn): { records: FinanceRecord[]; previews: FinancePreview[] } {
    this.admit(turn);
    return { records: this.records().slice(-30), previews: this.database.prepare("SELECT data_json FROM finance_preview ORDER BY id DESC LIMIT 10")
      .all().map((row) => JSON.parse(String(row.data_json)) as FinancePreview) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.database.close();
  }

  private admit(turn: FinanceTurn): void {
    if (turn.appId !== this.binding.appId || turn.tenantKey !== this.binding.tenantKey ||
        turn.senderOpenId !== this.binding.ownerOpenId || turn.senderType !== "user" || turn.conversationType !== "private") {
      throw new Error("finance_access_denied");
    }
    requireText(turn.eventKey, 512);
    financeMessageDate(turn.occurredAt);
  }

  private normalize(draft: FinanceDraft, turn: FinanceTurn): NormalizedPosting {
    if (!hasOnlyKeys(draft, ["book", "date", "kind", "amount", "currency", "description", "category", "refundOf", "selfTransferConfirmed"])) {
      throw new Error("finance_draft_invalid");
    }
    const book = draft.book ?? "personal";
    if (book !== "personal" && book !== "business") throw new Error("finance_book_invalid");
    if (!["income", "expense", "income_refund", "expense_refund", "transfer"].includes(draft.kind)) throw new Error("finance_kind_invalid");
    const date = validateFinanceDate(draft.date ?? financeMessageDate(turn.occurredAt));
    if (date > financeMessageDate(turn.occurredAt)) throw new Error("finance_date_future");
    if (draft.kind === "transfer" && draft.selfTransferConfirmed !== true) throw new Error("finance_transfer_ownership_required");
    let refundOf: FinanceDraft["refundOf"];
    if (draft.kind === "income_refund" || draft.kind === "expense_refund") {
      if (!draft.refundOf || typeof draft.refundOf !== "object" || Object.keys(draft.refundOf).length !== 1) throw new Error("finance_refund_original_required");
      if ("recordRef" in draft.refundOf) refundOf = { recordRef: requireText(draft.refundOf.recordRef, 64) };
      else if ("unrecorded" in draft.refundOf) refundOf = { unrecorded: requireText(draft.refundOf.unrecorded, 500) };
      else throw new Error("finance_refund_original_required");
    }
    return { book, date, kind: draft.kind, amountMinor: parseCnyAmount(draft.amount, draft.currency),
      currency: "CNY", description: requireText(draft.description, 500), category: requireText(draft.category ?? "未分类", 80), withdrawn: false,
      ...(refundOf ? { refundOf } : {}), ...(draft.kind === "transfer" ? { selfTransferConfirmed: true } : {}) };
  }

  private importContent(input: FinanceImport, turn: FinanceTurn): Pick<FinancePreview, "kind" | "book" | "rows"> {
    if (!hasOnlyKeys(input, ["book", "kind", "rows"])) throw new Error("finance_import_invalid");
    const book = input.book ?? "personal";
    if (book !== "personal" && book !== "business") throw new Error("finance_book_invalid");
    if (input.kind !== "statement" && input.kind !== "screenshot") throw new Error("finance_source_invalid");
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 1000) throw new Error("finance_batch_invalid");
    const seen = new Map<string, { index: number; fingerprint: string }>();
    const rows = input.rows.map((row, index): FinancePreviewRow => {
      if (!hasOnlyKeys(row, ["draft", "source", "issue", "excluded"]) ||
          (row.source !== undefined && !hasOnlyKeys(row.source, ["profile", "eventId"]))) throw new Error("finance_row_invalid");
      if (row.issue && row.excluded) throw new Error("finance_row_invalid");
      if (row.issue) return { ...row, issue: requireText(row.issue, 500) };
      if (row.excluded) return { ...row, excluded: requireText(row.excluded, 500) };
      if (!row.draft?.date) return { ...row, issue: "finance_date_required" };
      try {
        const posting = this.normalize({ ...row.draft, book }, turn);
        const possibleDuplicateRefs = this.possibleDuplicates(posting, row.source);
        if (!row.source) return possibleDuplicateRefs.length
          ? { ...row, posting, possibleDuplicateRefs, issue: "finance_duplicate_possible" } : { ...row, posting };
        requireText(row.source.profile, 128); requireText(row.source.eventId, 256);
        const known = this.sourceRecord(row.source, posting);
        if (known) return known.fingerprint === postingFingerprint(posting)
          ? { ...row, posting, duplicateRef: known.record_ref } : { ...row, posting, issue: "finance_source_conflict" };
        const key = sourceKey(row.source, posting), prior = seen.get(key);
        if (prior) return prior.fingerprint === postingFingerprint(posting)
          ? { ...row, posting, duplicateOfRow: prior.index } : { ...row, posting, issue: "finance_source_conflict" };
        seen.set(key, { index, fingerprint: postingFingerprint(posting) });
        return possibleDuplicateRefs.length
          ? { ...row, posting, possibleDuplicateRefs, issue: "finance_duplicate_possible" } : { ...row, posting };
      }
      catch (error) {
        if (error instanceof Error && /^finance_[a-z_]+$/u.test(error.message)) return { ...row, issue: error.message };
        throw error;
      }
    });
    return { kind: input.kind, book, rows };
  }

  private sourceRecord(source: NonNullable<FinanceImportRow["source"]>, posting: FinancePosting): { record_ref: string; fingerprint: string } | undefined {
    const row = this.database.prepare("SELECT record_ref, fingerprint FROM finance_source WHERE source_key = ?").get(sourceKey(source, posting));
    return row ? { record_ref: String(row.record_ref), fingerprint: String(row.fingerprint) } : undefined;
  }

  private getPreview(id: string): FinancePreview {
    const row = this.database.prepare("SELECT data_json FROM finance_preview WHERE ref = ?").get(id);
    if (!row) throw new Error("finance_preview_not_found");
    return JSON.parse(String(row.data_json)) as FinancePreview;
  }

  private pendingPreview(id: string, revision: number): FinancePreview {
    const preview = this.getPreview(id);
    if (preview.revision !== revision) throw new Error("finance_preview_stale");
    if (preview.status !== "pending") throw new Error("finance_preview_closed");
    return preview;
  }

  private savePreview(preview: FinancePreview): void {
    this.database.prepare("UPDATE finance_preview SET data_json = ? WHERE ref = ?").run(JSON.stringify(preview), preview.id);
  }

  private insert(posting: ReturnType<FinanceLedger["normalize"]>, provenance: FinanceRecord["provenance"], turn: FinanceTurn): FinanceRecord {
    this.validateRelationship(posting);
    const id = this.database.prepare("INSERT INTO finance_record(data_json) VALUES ('{}')").run().lastInsertRowid;
    const record: FinanceRecord = { ...posting, ref: `F${String(id).padStart(8, "0")}`, revision: 1, provenance,
      createdAt: this.now(), updatedAt: this.now() };
    this.database.prepare("UPDATE finance_record SET ref = ?, data_json = ? WHERE id = ?").run(record.ref, JSON.stringify(record), id);
    this.saveRevision(record, turn);
    return record;
  }

  private possibleDuplicates(posting: FinancePosting, source?: FinanceImportRow["source"]): string[] {
    return this.records().filter((record) => record.book === posting.book && record.kind === posting.kind &&
      record.date === posting.date && record.amountMinor === posting.amountMinor &&
      !(source && record.provenance.profile === source.profile && record.provenance.eventId && record.provenance.eventId !== source.eventId))
      .map((record) => record.ref);
  }

  private validateRelationship(posting: NormalizedPosting, ownRef?: string): void {
    if (!posting.refundOf || !("recordRef" in posting.refundOf)) return;
    const original = this.getRecord(posting.refundOf.recordRef);
    if (original.ref === ownRef || original.withdrawn || original.book !== posting.book || original.date > posting.date ||
        original.kind !== (posting.kind === "income_refund" ? "income" : "expense")) throw new Error("finance_refund_original_invalid");
  }

  private saveRevision(record: FinanceRecord, turn: FinanceTurn): void {
    this.database.prepare("INSERT INTO finance_revision VALUES (?, ?, ?, ?)").run(record.ref, record.revision, JSON.stringify(record), turn.eventKey);
  }

  private records(): FinanceRecord[] {
    return this.database.prepare("SELECT data_json FROM finance_record ORDER BY id").all().map((row) => JSON.parse(String(row.data_json)) as FinanceRecord);
  }

  private getRecord(ref: string): FinanceRecord {
    const row = this.database.prepare("SELECT data_json FROM finance_record WHERE ref = ?").get(ref);
    if (!row) throw new Error("finance_record_not_found");
    return JSON.parse(String(row.data_json)) as FinanceRecord;
  }

  private currentRecord(ref: string, revision: number): FinanceRecord {
    const record = this.getRecord(ref);
    if (record.revision !== revision) throw new Error("finance_record_stale");
    if (record.withdrawn) throw new Error("finance_record_withdrawn");
    return record;
  }

  private updateRecord(record: FinanceRecord, turn: FinanceTurn): FinanceRecord {
    const updated = { ...record, revision: record.revision + 1, updatedAt: this.now() };
    this.database.prepare("UPDATE finance_record SET data_json = ? WHERE ref = ?").run(JSON.stringify(updated), record.ref);
    this.saveRevision(updated, turn); return updated;
  }

  private mutate<T>(turn: FinanceTurn, request: unknown, action: () => T): T {
    return this.transaction(() => {
      const hash = digest(request), existing = this.database.prepare("SELECT * FROM finance_operation WHERE event_key = ?").get(turn.eventKey);
      if (existing) {
        if (existing.request_hash !== hash) throw new Error("finance_replay_conflict");
        return JSON.parse(String(existing.result_json)) as T;
      }
      const result = action();
      this.database.prepare("INSERT INTO finance_operation VALUES (?, ?, ?)").run(turn.eventKey, hash, JSON.stringify(result));
      return result;
    });
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

function requireText(value: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  })) {
    throw new Error("finance_text_invalid");
  }
  return value.trim();
}

function hasOnlyKeys(value: unknown, keys: string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function digest(value: unknown): string {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : input;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function sourceKey(source: NonNullable<FinanceImportRow["source"]>, posting: FinancePosting): string {
  return digest([source.profile, source.eventId, posting.kind]);
}

function postingFingerprint(posting: FinancePosting): string {
  return digest([posting.kind, posting.date, posting.amountMinor]);
}
