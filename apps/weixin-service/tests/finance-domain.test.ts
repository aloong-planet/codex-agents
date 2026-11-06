import { describe, expect, it } from "vitest";
import { financeMessageDate, formatCnyAmount, parseCnyAmount, summarizeFinance, validateFinanceDate, type FinancePosting } from "../src/finance-domain.js";

const posting = (kind: FinancePosting["kind"], amountMinor: string, changes: Partial<FinancePosting> = {}): FinancePosting => ({
  book: "personal", date: "2026-11-06", category: "日常", withdrawn: false, kind, amountMinor, ...changes,
});
const november = { from: "2026-11-01", to: "2026-11-30" };

// Native domain values, not payment-platform fixtures. Intake/model/source compatibility is tested separately.
describe("exact CNY bookkeeping", () => {
  it("preserves cents without floating-point rounding", () => {
    expect(parseCnyAmount("0.01")).toBe("1");
    expect(parseCnyAmount("0.10")).toBe("10");
    expect(parseCnyAmount("1234.56")).toBe("123456");
    expect(formatCnyAmount("1")).toBe("0.01");
    expect(formatCnyAmount("10")).toBe("0.10");
    expect(formatCnyAmount("123456")).toBe("1234.56");
  });

  it("refuses non-CNY, malformed, non-positive, over-precise and oversized amounts", () => {
    for (const invalid of ["0", "0.00", "-1", "1e2", "NaN", "1.001", "10000000000000000", " 1", "01", "1,000", "+1", ""]) {
      expect(() => parseCnyAmount(invalid), invalid).toThrow("finance_amount_invalid");
    }
    expect(() => parseCnyAmount("10.00", "USD")).toThrow("finance_currency_unsupported");
  });

  it("separates books, periods and categories while netting both refund directions", () => {
    const entries = [posting("income", "50000"), posting("income_refund", "2000"), posting("expense", "12000"),
      posting("expense_refund", "3000"), posting("transfer", "900000"),
      posting("income", "70000", { book: "business" }), posting("expense", "80000", { date: "2026-10-31" }),
      posting("expense", "60000", { date: "2026-12-01" }), posting("expense", "50000", { withdrawn: true }),
      posting("expense", "40000", { category: "其他" })];
    const report = summarizeFinance(entries, { ...november, category: "日常" });
    expect(report).toMatchObject({ book: "personal", from: "2026-11-01", to: "2026-11-30", currency: "CNY", totals: {
      grossIncome: "500.00", grossExpenses: "120.00", incomeRefunds: "20.00", expenseRefunds: "30.00",
      netIncome: "480.00", netExpenses: "90.00", netMovement: "390.00", transfers: "9000.00",
    } });
    expect(report.records).toHaveLength(5);
    expect(summarizeFinance(entries, { ...november, book: "business" }).totals.netIncome).toBe("700.00");
    expect(summarizeFinance(entries, november).totals.netMovement).toBe("-10.00");
  });

  it("keeps refunds in their actual month without rewriting originals or inventing empty-period entries", () => {
    const entries = [posting("expense", "10000", { date: "2026-10-31" }), posting("income", "20000", { date: "2026-10-31" }),
      posting("expense_refund", "4000"), posting("income_refund", "6000")];
    expect(summarizeFinance(entries, { from: "2026-10-01", to: "2026-10-31" }).totals).toMatchObject({
      grossIncome: "200.00", grossExpenses: "100.00", netIncome: "200.00", netExpenses: "100.00", netMovement: "100.00",
    });
    expect(summarizeFinance(entries, november).totals).toMatchObject({
      grossIncome: "0.00", grossExpenses: "0.00", netIncome: "-60.00", netExpenses: "-40.00", netMovement: "-20.00",
    });
    expect(summarizeFinance(entries, { from: "2026-12-01", to: "2026-12-31" })).toMatchObject({ records: [], totals: {
      grossIncome: "0.00", grossExpenses: "0.00", incomeRefunds: "0.00", expenseRefunds: "0.00",
      netIncome: "0.00", netExpenses: "0.00", netMovement: "0.00", transfers: "0.00",
    } });
  });

  it("preserves cents in large totals and validates actual Shanghai calendar dates", () => {
    expect(parseCnyAmount("9999999999999999.99")).toBe("999999999999999999");
    expect(summarizeFinance([posting("income", "999999999999999999"), posting("income", "1")], november).totals.netIncome)
      .toBe("10000000000000000.00");
    expect(financeMessageDate(Date.parse("2026-11-06T15:59:59Z"))).toBe("2026-11-06");
    expect(financeMessageDate(Date.parse("2026-11-06T16:00:00Z"))).toBe("2026-11-07");
    expect(validateFinanceDate("2024-02-29")).toBe("2024-02-29");
    for (const invalid of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-11-31", "0000-01-01", "26-11-06"]) {
      expect(() => validateFinanceDate(invalid), invalid).toThrow("finance_date_invalid");
    }
    expect(() => summarizeFinance([], { from: "2026-11-30", to: "2026-11-01" })).toThrow("finance_date_range_invalid");
  });
});
