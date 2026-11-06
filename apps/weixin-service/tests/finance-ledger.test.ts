import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FinanceLedger, type FinanceImport, type FinanceTurn } from "../src/finance-ledger.js";

// Native ledger operations only. Real file shapes, model interpretation and authenticated transport require separate evidence.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const binding = { appId: "penny-app", tenantKey: "tenant", ownerOpenId: "penny-owner" };
const turn = (eventKey: string, changes: Partial<FinanceTurn> = {}): FinanceTurn => ({
  appId: "penny-app", tenantKey: "tenant", senderOpenId: "penny-owner", senderType: "user", conversationType: "private",
  eventKey, text: eventKey, occurredAt: Date.parse("2026-11-06T16:00:00Z"), ...changes,
});
const november = { from: "2026-11-01", to: "2026-11-30" };
const imported: FinanceImport = { kind: "statement", rows: [{ draft: { kind: "expense", amount: "58", date: "2026-11-06", description: "groceries" } },
  { draft: { kind: "expense", amount: "12", date: "2026-11-06", description: "travel" } }] };
const confirmation = (id: string, revision: number, event = "confirm") => turn(event, { text: `确认 ${id}/${revision}` });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penny-ledger-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "finance", "ledger.sqlite");
  const open = () => {
    const ledger = new FinanceLedger({ databasePath, binding, now: () => 1794000000000, busyTimeoutMs: 0 });
    cleanup.push(() => ledger.close()); return ledger;
  };
  return { databasePath, open };
}

describe("private financial ledger", () => {
  it("posts separate books and recovers stable records and instruction outcomes after restart", () => {
    const { open } = setup(), started = performance.now(), ledger = open();
    console.info(`FinanceLedger construction: ${(performance.now() - started).toFixed(2)}ms`);
    const drafts = [{ kind: "expense" as const, amount: "35", description: "午饭" },
      { book: "business" as const, kind: "income" as const, amount: "120.00", description: "销售到账" }];
    const result = ledger.record(turn("first"), drafts);
    expect(result.records.map((record) => record.ref)).toEqual(["F00000001", "F00000002"]);
    expect(result.records[0]).toMatchObject({ date: "2026-11-07", amountMinor: "3500", category: "未分类", currency: "CNY",
      book: "personal", provenance: { kind: "text", eventKey: "first" } });
    ledger.close(); const recovered = open();
    expect(recovered.record(turn("first"), drafts).records.map((record) => record.ref)).toEqual(["F00000001", "F00000002"]);
    expect(recovered.query(turn("query"), november).totals.netExpenses).toBe("35.00");
    expect(recovered.query(turn("query"), { ...november, book: "business" }).totals.netIncome).toBe("120.00");
    expect(recovered.inspect(turn("inspect"), "F00000001").history).toMatchObject([{ revision: 1, amountMinor: "3500" }]);
  });

  it("denies other applications, tenants, users, bots and groups before financial access", () => {
    const { open, databasePath } = setup(), ledger = open();
    ledger.record(turn("seed"), [{ kind: "expense", amount: "35", description: "午饭" }]);
    const changed: Partial<FinanceTurn>[] = [{ appId: "sam-app" }, { tenantKey: "another-tenant" },
      { senderOpenId: "sam-owner" }, { senderType: "app" }, { conversationType: "group" }];
    for (const change of changed) {
      const unauthorized = turn("foreign", change);
      expect(() => ledger.query(unauthorized, november)).toThrow("finance_access_denied");
      expect(() => ledger.inspect(unauthorized, "F00000001")).toThrow("finance_access_denied");
      expect(() => ledger.context(unauthorized)).toThrow("finance_access_denied");
      expect(() => ledger.record(unauthorized, [{ kind: "expense", amount: "9", description: "forbidden" }]))
        .toThrow("finance_access_denied");
      expect(() => ledger.prepareImport(unauthorized, imported)).toThrow("finance_access_denied");
      expect(() => ledger.prepareText(unauthorized, [])).toThrow("finance_access_denied");
      expect(() => ledger.reviseImport(unauthorized, "Q00000001", 1, imported)).toThrow("finance_access_denied");
      expect(() => ledger.preview(unauthorized, "Q00000001")).toThrow("finance_access_denied");
      expect(() => ledger.markPresented(unauthorized, "Q00000001", 1)).toThrow("finance_access_denied");
      expect(() => ledger.confirm(unauthorized, "Q00000001", 1)).toThrow("finance_access_denied");
      expect(() => ledger.cancel(unauthorized, "Q00000001", 1)).toThrow("finance_access_denied");
      expect(() => ledger.correct(unauthorized, "F00000001", 1, { amount: "1" })).toThrow("finance_access_denied");
      expect(() => ledger.prepareWithdrawal(unauthorized, "F00000001", 1)).toThrow("finance_access_denied");
      expect(() => ledger.resolveDuplicate(unauthorized, "Q00000001", 1, 0)).toThrow("finance_access_denied");
    }
    expect(ledger.query(turn("query"), november).records).toHaveLength(1);
    ledger.close();
    expect(() => new FinanceLedger({ databasePath, binding: { ...binding, ownerOpenId: "replacement-owner" } }))
      .toThrow("finance_binding_changed");
    expect(open().query(turn("query"), november).totals.netExpenses).toBe("35.00");
  });

  it("rolls back a failed batch and refuses a second mutation for the same instruction", () => {
    const { open, databasePath } = setup(), ledger = open();
    expect(() => ledger.record(turn("batch"), [{ kind: "expense", amount: "1", description: "first" },
      { kind: "expense", amount: "2.123", description: "invalid second" }])).toThrow("finance_amount_invalid");
    expect(ledger.query(turn("query"), november).records).toEqual([]);
    ledger.record(turn("batch"), [{ kind: "expense", amount: "1", description: "first" }]);
    expect(() => ledger.record(turn("batch"), [{ kind: "expense", amount: "2", description: "changed replay" }]))
      .toThrow("finance_replay_conflict");
    const lock = new DatabaseSync(databasePath);
    try {
      lock.exec("BEGIN IMMEDIATE");
      expect(() => ledger.record(turn("locked"), [{ kind: "income", amount: "10", description: "cannot save" }])).toThrow();
      expect(ledger.query(turn("query"), november).totals).toMatchObject({ grossIncome: "0.00", netExpenses: "1.00" });
    } finally { lock.exec("ROLLBACK"); lock.close(); }
    expect(ledger.query(turn("query"), november).records).toHaveLength(1);
  });

  it("commits only the exact presented preview revision after restart and leaves cancellations unchanged", () => {
    const { open } = setup(), ledger = open();
    const initial = ledger.prepareImport(turn("upload"), imported);
    expect(ledger.query(turn("query"), november).records).toEqual([]);
    expect(() => ledger.confirm(confirmation(initial.id, 1), initial.id, 1)).toThrow("finance_preview_not_presented");
    ledger.markPresented(turn("delivery"), initial.id, 1);
    expect(() => ledger.confirm(turn("unrelated"), initial.id, 1)).toThrow("finance_confirmation_required");
    expect(() => ledger.confirm(confirmation(initial.id, 1, "upload"), initial.id, 1)).toThrow("finance_replay_conflict");
    ledger.reviseImport(turn("business"), initial.id, 1, { ...imported, book: "business" });
    expect(() => ledger.confirm(confirmation(initial.id, 1), initial.id, 1)).toThrow("finance_preview_stale");
    ledger.close(); const recovered = open();
    expect(recovered.preview(turn("inspect"), initial.id)).toMatchObject({ revision: 2, book: "business", status: "pending", presentedRevision: null });
    expect(() => recovered.confirm(confirmation(initial.id, 2), initial.id, 2)).toThrow("finance_preview_not_presented");
    recovered.markPresented(turn("delivery-2"), initial.id, 2);
    expect(recovered.confirm(confirmation(initial.id, 2), initial.id, 2).records).toHaveLength(2);
    expect(recovered.confirm(confirmation(initial.id, 2, "confirm-again"), initial.id, 2).records.map((record) => record.ref))
      .toEqual(["F00000001", "F00000002"]);
    expect(recovered.query(turn("query"), { ...november, book: "business" }).totals.netExpenses).toBe("70.00");
    expect(recovered.query(turn("query"), november).records).toEqual([]);
    const cancelled = recovered.prepareImport(turn("second-upload"), imported);
    recovered.cancel(turn("cancel"), cancelled.id, 1);
    expect(() => recovered.confirm(confirmation(cancelled.id, 1, "confirm-cancelled"), cancelled.id, 1)).toThrow("finance_preview_closed");
    expect(recovered.query(turn("query"), { ...november, book: "business" }).records).toHaveLength(2);
  });

  it("keeps correction history and confirms a withdrawal once across two open ledger instances", () => {
    const { open } = setup(), ledger = open();
    ledger.record(turn("lunch"), [{ kind: "expense", amount: "35", description: "午饭" }]);
    const corrected = ledger.correct(turn("correction"), "F00000001", 1, { amount: "32" });
    expect(corrected).toMatchObject({ status: "corrected", records: [{ ref: "F00000001", revision: 2, amountMinor: "3200" }] });
    expect(() => ledger.correct(turn("stale"), "F00000001", 1, { amount: "30" })).toThrow("finance_record_stale");
    const stale = ledger.prepareWithdrawal(turn("withdrawal-old"), "F00000001", 2);
    ledger.markPresented(turn("delivery"), stale.id, 1);
    ledger.correct(turn("correct-again"), "F00000001", 2, { amount: "31" });
    expect(() => ledger.confirm(confirmation(stale.id, 1), stale.id, 1)).toThrow("finance_record_stale");
    const current = ledger.prepareWithdrawal(turn("withdrawal-current"), "F00000001", 3);
    ledger.markPresented(turn("delivery"), current.id, 1);
    expect(ledger.query(turn("query"), november).totals.netExpenses).toBe("31.00");
    const second = open();
    expect(second.confirm(confirmation(current.id, 1), current.id, 1)).toMatchObject({ status: "withdrawn",
      records: [{ ref: "F00000001", revision: 4, withdrawn: true }] });
    expect(ledger.confirm(confirmation(current.id, 1, "repeat-confirm"), current.id, 1).records).toHaveLength(1);
    ledger.close(); second.close(); const recovered = open();
    expect(recovered.query(turn("query"), november).records).toEqual([]);
    expect(recovered.inspect(turn("inspect"), "F00000001").history.map((record) => [record.revision, record.amountMinor, record.withdrawn]))
      .toEqual([[1, "3500", false], [2, "3200", false], [3, "3100", false], [4, "3100", true]]);
  });

  it("retains source identities through corrections and withdrawal and keeps distinct partial refunds", () => {
    const { open } = setup(), ledger = open();
    const original: FinanceImport = { kind: "statement", rows: [{ draft: { kind: "expense", amount: "100", date: "2026-11-01", description: "purchase" },
      source: { profile: "normalized-fixture", eventId: "000001" } }] };
    const post = (input: FinanceImport, event: string) => {
      const preview = ledger.prepareImport(turn(event), input);
      ledger.markPresented(turn(`${event}-delivery`), preview.id, preview.revision);
      return ledger.confirm(confirmation(preview.id, preview.revision, `${event}-confirm`), preview.id, preview.revision);
    };
    post(original, "original");
    const refunds: FinanceImport = { kind: "statement", rows: [
      { draft: { kind: "expense_refund", amount: "20", date: "2026-11-06", description: "first refund", refundOf: { recordRef: "F00000001" } }, source: { profile: "normalized-fixture", eventId: "000001-r1" } },
      { draft: { kind: "expense_refund", amount: "10", date: "2026-11-07", description: "second refund", refundOf: { recordRef: "F00000001" } }, source: { profile: "normalized-fixture", eventId: "000001-r2" } },
    ] };
    post(refunds, "refunds");
    expect(ledger.query(turn("query"), november).totals).toMatchObject({ grossExpenses: "100.00", expenseRefunds: "30.00", netExpenses: "70.00" });
    ledger.correct(turn("correct-original"), "F00000001", 1, { amount: "99" });
    const withdraw = ledger.prepareWithdrawal(turn("withdraw-original"), "F00000001", 2);
    ledger.markPresented(turn("withdraw-delivery"), withdraw.id, 1);
    ledger.confirm(confirmation(withdraw.id, 1, "withdraw-confirm"), withdraw.id, 1);
    const repeated = post({ kind: "statement", rows: [...original.rows, ...refunds.rows] }, "overlap");
    expect(repeated).toMatchObject({ records: [], skipped: { duplicates: 3, excluded: 0 } });
    expect(ledger.inspect(turn("inspect"), "F00000001").record).toMatchObject({ revision: 3, withdrawn: true,
      provenance: { profile: "normalized-fixture", eventId: "000001" } });
    expect(ledger.query(turn("query"), november).records).toHaveLength(2);
    expect(ledger.query(turn("query"), november).totals.netExpenses).toBe("-30.00");
  });

  it("keeps all rows unposted when any preview item is unresolved", () => {
    const { open } = setup(), ledger = open();
    const preview = ledger.prepareImport(turn("unclear-image"), { kind: "screenshot", rows: [imported.rows[0]!, { issue: "amount cropped" }] });
    ledger.markPresented(turn("show"), preview.id, 1);
    expect(() => ledger.confirm(confirmation(preview.id, 1), preview.id, 1)).toThrow("finance_preview_unresolved");
    expect(ledger.query(turn("query"), november).records).toEqual([]);
    expect(ledger.preview(turn("inspect"), preview.id).status).toBe("pending");
    expect(() => ledger.record(turn("attachment-bypass", { hasAttachments: true }), [{ kind: "expense", amount: "58", description: "image" }]))
      .toThrow("finance_preview_required");
  });

  it("asks the owner whether a similar event is distinct or already recorded and reviews that choice before posting", () => {
    const { open } = setup(), ledger = open();
    const lunch = { book: "business" as const, kind: "expense" as const, amount: "35", description: "working lunch" };
    ledger.record(turn("lunch"), [lunch]);
    expect(() => ledger.record(turn("possible-copy"), [lunch])).toThrow("finance_duplicate_possible");
    const preview = ledger.prepareText(turn("possible-copy"), [lunch]);
    expect(preview).toMatchObject({ book: "business", rows: [{ issue: "finance_duplicate_possible", possibleDuplicateRefs: ["F00000001"] }] });
    ledger.markPresented(turn("show"), preview.id, 1);
    expect(() => ledger.resolveDuplicate(turn("model-choice"), preview.id, 1, 0)).toThrow("finance_confirmation_required");
    ledger.resolveDuplicate(turn("owner-choice", { text: `另记 ${preview.id}/1 第1条` }), preview.id, 1, 0);
    expect(() => ledger.confirm(confirmation(preview.id, 1), preview.id, 1)).toThrow("finance_preview_stale");
    expect(() => ledger.confirm(confirmation(preview.id, 2), preview.id, 2)).toThrow("finance_preview_not_presented");
    ledger.markPresented(turn("show-2"), preview.id, 2);
    ledger.confirm(confirmation(preview.id, 2), preview.id, 2);
    expect(ledger.query(turn("query"), { ...november, book: "business" }).totals.netExpenses).toBe("70.00");
    const screenshot = ledger.prepareImport(turn("screenshot"), { kind: "screenshot", book: "business", rows: [{
      draft: { ...lunch, date: "2026-11-07" }, source: { profile: "normalized-fixture", eventId: "000045" },
    }] });
    ledger.markPresented(turn("show-image"), screenshot.id, 1);
    ledger.resolveDuplicate(turn("same-event", { text: `重复 ${screenshot.id}/1 第1条 F00000001` }), screenshot.id, 1, 0, "F00000001");
    ledger.markPresented(turn("show-linked"), screenshot.id, 2);
    expect(ledger.confirm(confirmation(screenshot.id, 2, "confirm-link"), screenshot.id, 2))
      .toMatchObject({ records: [], skipped: { duplicates: 1, excluded: 0 } });
    expect(ledger.query(turn("query"), { ...november, book: "business" }).records).toHaveLength(2);
  });

  it("requires ownership for transfers and keeps explicit original evidence for both refund directions", () => {
    const { open } = setup(), ledger = open();
    expect(() => ledger.record(turn("transfer"), [{ kind: "transfer", amount: "100", description: "充值" }]))
      .toThrow("finance_transfer_ownership_required");
    expect(() => ledger.record(turn("refund-unknown"), [{ kind: "expense_refund", amount: "10", description: "退款" }]))
      .toThrow("finance_refund_original_required");
    expect(ledger.query(turn("query"), november).records).toEqual([]);
    ledger.record(turn("known-transfer"), [{ kind: "transfer", amount: "100", description: "本人支付宝转银行卡", selfTransferConfirmed: true }]);
    expect(ledger.query(turn("query"), november).totals).toMatchObject({ grossIncome: "0.00", grossExpenses: "0.00", netMovement: "0.00", transfers: "100.00" });
    ledger.record(turn("income"), [{ kind: "income", amount: "200", description: "销售到账" }]);
    expect(() => ledger.record(turn("wrong-original"), [{ kind: "expense_refund", amount: "10", description: "退款", refundOf: { recordRef: "F00000002" } }]))
      .toThrow("finance_refund_original_invalid");
    ledger.record(turn("sales-refund"), [{ kind: "income_refund", amount: "40", description: "退给买家", refundOf: { recordRef: "F00000002" } }]);
    ledger.record(turn("purchase-refund"), [{ kind: "expense_refund", amount: "20", description: "退款到账", refundOf: { unrecorded: "此前未记账的衣服付款" } }]);
    expect(ledger.query(turn("query"), november).totals).toMatchObject({ netIncome: "160.00", netExpenses: "-20.00", netMovement: "180.00" });
    expect(ledger.inspect(turn("inspect"), "F00000004").record.refundOf).toEqual({ unrecorded: "此前未记账的衣服付款" });
  });

  it("counts proven repeated rows and refuses changed source events or a preview made stale by another commit", () => {
    const { open } = setup(), ledger = open();
    const row = { draft: { kind: "expense" as const, amount: "58", date: "2026-11-06", description: "purchase" },
      source: { profile: "normalized-fixture", eventId: "000089" } };
    const first = ledger.prepareImport(turn("first-upload"), { kind: "statement", rows: [row, row, { excluded: "unpaid" }] });
    const second = ledger.prepareImport(turn("second-upload"), { kind: "statement", rows: [row] });
    ledger.markPresented(turn("show-first"), first.id, 1); ledger.markPresented(turn("show-second"), second.id, 1);
    expect(ledger.confirm(confirmation(first.id, 1), first.id, 1))
      .toMatchObject({ records: [{ ref: "F00000001" }], skipped: { duplicates: 1, excluded: 1 } });
    expect(() => ledger.confirm(confirmation(second.id, 1, "confirm-second"), second.id, 1)).toThrow("finance_preview_changed");
    const changed = ledger.prepareImport(turn("changed-source"), { kind: "statement", rows: [{ ...row, draft: { ...row.draft, amount: "60" } }] });
    expect(changed.rows).toMatchObject([{ issue: "finance_source_conflict" }]);
    ledger.markPresented(turn("show-changed"), changed.id, 1);
    expect(() => ledger.confirm(confirmation(changed.id, 1, "confirm-changed"), changed.id, 1)).toThrow("finance_preview_unresolved");
    expect(ledger.query(turn("query"), november).totals.netExpenses).toBe("58.00");
  });

  it("rejects candidate data that attempts to supply host-owned duplicate or withdrawal decisions", () => {
    const { open } = setup(), ledger = open();
    for (const extra of [{ duplicateRef: "F00000099" }, { duplicateDecision: "existing" }, { posting: { withdrawn: true } }]) {
      const untrusted = JSON.parse(JSON.stringify({ kind: "statement", rows: [{ draft: {
        kind: "expense", amount: "58", date: "2026-11-06", description: "purchase",
      }, ...extra }] }));
      expect(() => ledger.prepareImport(turn("host-owned-fields"), untrusted)).toThrow("finance_row_invalid");
    }
    expect(ledger.query(turn("query"), november).records).toEqual([]);
  });
});
