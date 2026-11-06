/** Decimal strings cross tool/storage boundaries; all arithmetic stays in integer cents. */
export function parseCnyAmount(amount: string, currency = "CNY"): string {
  if (currency !== "CNY") throw new Error("finance_currency_unsupported");
  if (typeof amount !== "string" || !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/u.test(amount)) {
    throw new Error("finance_amount_invalid");
  }
  const [whole, fraction = ""] = amount.split(".");
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor <= 0n) throw new Error("finance_amount_invalid");
  return minor.toString();
}

export function formatCnyAmount(minor: string | bigint): string {
  const value = BigInt(minor), absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export type FinanceBook = "personal" | "business";
export type FinanceKind = "income" | "expense" | "income_refund" | "expense_refund" | "transfer";
export type FinancePosting = {
  book: FinanceBook;
  date: string;
  kind: FinanceKind;
  amountMinor: string;
  category: string;
  withdrawn: boolean;
};
export type FinanceQuery = { book?: FinanceBook; from: string; to: string; category?: string };

export function validateFinanceDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || date.startsWith("0000") ||
      !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new Error("finance_date_invalid");
  return date;
}

export function financeMessageDate(occurredAt: number): string {
  if (!Number.isFinite(occurredAt)) throw new Error("finance_date_invalid");
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(occurredAt);
  return validateFinanceDate(date);
}

export function summarizeFinance<T extends FinancePosting>(entries: readonly T[], query: FinanceQuery) {
  const book = query.book ?? "personal", from = validateFinanceDate(query.from), to = validateFinanceDate(query.to);
  if (from > to) throw new Error("finance_date_range_invalid");
  const records = entries.filter((entry) => !entry.withdrawn && entry.book === book && entry.date >= from && entry.date <= to &&
    (query.category === undefined || entry.category === query.category));
  const sums = { income: 0n, expense: 0n, income_refund: 0n, expense_refund: 0n, transfer: 0n };
  for (const record of records) sums[record.kind] += BigInt(record.amountMinor);
  const netIncome = sums.income - sums.income_refund, netExpenses = sums.expense - sums.expense_refund;
  return {
    book, from, to, currency: "CNY" as const, records,
    totals: {
      grossIncome: formatCnyAmount(sums.income), grossExpenses: formatCnyAmount(sums.expense),
      incomeRefunds: formatCnyAmount(sums.income_refund), expenseRefunds: formatCnyAmount(sums.expense_refund),
      netIncome: formatCnyAmount(netIncome), netExpenses: formatCnyAmount(netExpenses),
      netMovement: formatCnyAmount(netIncome - netExpenses), transfers: formatCnyAmount(sums.transfer),
    },
  };
}
