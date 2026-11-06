// Typed command validation only. Actual Codex interpretation and payment-image recognition need separate live evidence.
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
