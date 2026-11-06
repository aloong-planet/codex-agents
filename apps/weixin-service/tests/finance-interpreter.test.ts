// Typed command validation only. Actual Codex interpretation and payment-image recognition need separate live evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FinanceLedger } from "../src/finance-ledger.js";
import { expect, test } from "vitest";
import { financeImageRows, parseFinanceCommand, type FinanceEntry, type FinanceInterpretationInput } from "../src/finance-interpreter.js";

test("only current owner evidence can propose text writes and images remain unresolved previews", () => {
  const input: FinanceInterpretationInput = { text: "午饭 35 元", occurredAt: Date.parse("2026-11-06T12:00:00+08:00"), images: [], context: { records: [], previews: [], recent: [] } };
  const entry: FinanceEntry = { date: null, kind: "expense", amount: "35", currency: "CNY", description: "午饭", category: null,
    selfTransferConfirmed: false, originalRef: null, unrecordedOriginal: null, status: "settled", issue: null };
  const command = { kind: "record", evidence: "午饭 35 元", book: "personal", entries: [entry] };
  expect(parseFinanceCommand({ command }, input)).toMatchObject({ kind: "record", entries: [{ amount: "35" }] });
  for (const candidate of [{ ...command, path: "/tmp/ledger" }, { ...command, owner: "another" },
    { ...command, evidence: "昨日旧消息" }, { ...command, entries: [{ ...entry, amount: null }] }]) {
    expect(() => parseFinanceCommand({ command: candidate }, input)).toThrow();
  }
  expect(() => parseFinanceCommand({ command }, { ...input, images: ["/private/image.png"] })).toThrow("finance_preview_required");
  const preview = parseFinanceCommand({ command: { kind: "preview", book: "business", entries: [{ ...entry, amount: null, status: "unresolved", issue: "付款金额看不清" }] } }, { ...input, images: ["/private/image.png"] });
  expect(preview.kind).toBe("preview");
  if (preview.kind !== "preview") throw new Error("expected preview");
  expect(financeImageRows(preview.entries, preview.book)).toEqual([{ issue: "支出；午饭。付款金额看不清" }]);
  expect(financeImageRows([entry], "personal")).toEqual([{ issue: "支出；午饭；35 CNY。金额、日期、方向或交易状态不明确，请补充实际收付款信息。" }]);
  const pending: FinanceInterpretationInput = { ...input, context: { ...input.context, previews: [{ id: "Q00000001", revision: 1,
    status: "pending", book: "personal", kind: "screenshot", eventKey: "image", presentedRevision: 1,
    rows: [{ issue: "第一笔缺金额" }, { issue: "第二笔缺日期" }] }] } };
  expect(() => parseFinanceCommand({ command: { kind: "revise", previewId: "Q00000001", revision: 1, book: "personal", entries: [entry] } }, pending))
    .toThrow("finance_preview_rows_changed");
});

test.each(["correct", "withdraw", "inspect"] as const)("%s requires the owner to name the record in the current message", (kind) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penny-selection-"));
  const binding = { appId: "penny", tenantKey: "tenant", ownerOpenId: "owner" };
  const ledger = new FinanceLedger({ databasePath: path.join(root, "ledger.sqlite"), binding });
  try {
    const turn = { ...binding, senderOpenId: "owner", senderType: "user" as const, conversationType: "private" as const,
      eventKey: "seed", text: "午饭 35 元", occurredAt: Date.parse("2026-11-06T12:00:00+08:00") };
    ledger.record(turn, [{ kind: "expense", amount: "35", description: "午饭" }]);
    const input: FinanceInterpretationInput = { text: "把那笔改为 32 元", occurredAt: turn.occurredAt, images: [],
      context: { ...ledger.context(turn), recent: [] } };
    expect(input.context.records).toMatchObject([{ ref: "F00000001", amountMinor: "3500" }]);
    const command = { kind, ref: "F00000001", ...(kind === "inspect" ? {} : { revision: 1 }), ...(kind === "correct" ? {
      evidence: input.text, book: "personal", replacement: { date: null, kind: "expense", amount: "32", currency: "CNY", description: "午饭", category: null,
        selfTransferConfirmed: false, originalRef: null, unrecordedOriginal: null, status: "settled", issue: null },
    } : {}) };
    expect(() => parseFinanceCommand({ command }, input)).toThrow("finance_record_selection_required");
    expect(parseFinanceCommand({ command }, { ...input, text: `F00000001：${input.text}` })).toMatchObject({ kind, ref: "F00000001" });
  } finally { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
