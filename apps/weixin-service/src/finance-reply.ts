import { formatCnyAmount } from "./finance-domain.js";
import type { FinanceLedger, FinancePreview, FinanceRecord, FinanceWriteResult } from "./finance-ledger.js";

const books = { personal: "个人账", business: "经营账" };
const kinds = { income: "收入", expense: "支出", income_refund: "退给买家（冲减收入）", expense_refund: "收到退款（冲减支出）", transfer: "本人账户资金转移（不计收支）" };
const line = (record: Pick<FinanceRecord, "book" | "date" | "kind" | "amountMinor" | "description" | "category">) =>
  `${books[record.book]} · ${record.date} · ${kinds[record.kind]} ¥${formatCnyAmount(record.amountMinor)} · ${record.description} · ${record.category}`;

export function financeWriteReply(result: FinanceWriteResult): string {
  return [result.status === "withdrawn" ? "已撤销。该笔不再计入统计，历史记录保留。" :
    result.status === "corrected" ? "已更正，修改历史已保留。" : `已入账 ${result.records.length} 笔。`,
    ...result.records.map((record) => `${record.ref}（版本 ${record.revision}）\n${line(record)}`),
    ...(result.skipped ? [`已排除重复 ${result.skipped.duplicates} 笔、未成功等不计入项 ${result.skipped.excluded} 笔。`] : []),
  ].join("\n");
}

export function financePreviewReply(preview: FinancePreview): string {
  const token = `${preview.id}/${preview.revision}`;
  if (preview.status === "committed" && preview.result) return financeWriteReply(preview.result);
  if (preview.status === "cancelled") return `${token} 已取消，账本没有变化。`;
  const rows = preview.rows.map((row, index) => {
    const content = row.posting ? line(row.posting) : "待补全交易信息";
    const notes: string[] = [];
    if (row.excluded) notes.push(`不入账：${row.excluded}`);
    if (row.duplicateRef || row.duplicateOfRow !== undefined) notes.push(`已排除重复：${row.duplicateRef ?? `本批第${row.duplicateOfRow! + 1}条`}`);
    if (row.issue === "finance_duplicate_possible") {
      notes.push(`可能与 ${row.possibleDuplicateRefs?.join("、")} 重复。确为另一笔请回复“另记 ${token} 第${index + 1}条”；同一笔请回复“重复 ${token} 第${index + 1}条 ${row.possibleDuplicateRefs?.[0]}”。`);
    } else if (row.issue) notes.push(`待补充：${financeErrorText(row.issue)}`);
    return `${index + 1}. ${content}${notes.length ? `\n${notes.join("\n")}` : ""}`;
  });
  return [`${preview.kind === "withdrawal" ? "撤销预览" : "入账预览"} · ${books[preview.book]} · ${token}`,
    ...rows, preview.kind === "withdrawal" ? `将撤销 ${preview.withdrawal?.ref}，历史记录保留。尚未撤销。` : "尚未入账。可先补充信息或更改账本。",
    preview.rows.some((row) => row.issue) ? "请先补齐上述待确认信息；目前不能确认入账。" : `核对无误请回复“确认 ${token}”。`,
    `放弃请回复“取消 ${token}”；重新查看请回复“查看预览 ${preview.id}”。`,
  ].join("\n");
}

export function financeQueryReply(result: ReturnType<FinanceLedger["query"]>): string {
  const totals = result.totals;
  return [`${books[result.book]} · ${result.from} 至 ${result.to} · 人民币`,
    `收入 ¥${totals.grossIncome}；退给买家 ¥${totals.incomeRefunds}；净收入 ¥${totals.netIncome}。`,
    `支出 ¥${totals.grossExpenses}；收到退款 ¥${totals.expenseRefunds}；净支出 ¥${totals.netExpenses}。`,
    `收支结余 ¥${totals.netMovement}；本人账户资金转移 ¥${totals.transfers}（不计收支）。`,
    "结余只反映已记录的收支，不代表银行余额或经营利润。",
    ...(result.records.length ? result.records.slice(0, 50).map((record) => `${record.ref} · ${line(record)}`) : ["该期间暂无已记录交易。"]),
    ...(result.records.length > 50 ? [`共 ${result.records.length} 笔，以上列出前 50 笔；汇总包含全部符合条件记录。请缩小日期或分类查看其余明细。`] : []),
  ].join("\n");
}

export function financeErrorText(code: string): string {
  const messages: Record<string, string> = {
    finance_amount_invalid: "金额需为大于零、最多两位小数的人民币数值。",
    finance_currency_unsupported: "目前仅记人民币，请说明人民币实际收付款金额。",
    finance_date_invalid: "请提供有效的实际收付款日期。", finance_date_future: "日期晚于消息日期，请确认实际收付款日期。",
    finance_date_required: "请补充截图中的实际收付款日期。",
    finance_date_range_invalid: "起始日期不能晚于结束日期。",
    finance_refund_original_required: "请指出退款对应的原记录编号，或说明原交易尚未记账。",
    finance_refund_original_invalid: "退款与原记录的账本、方向或日期不匹配，请核对。",
    finance_transfer_ownership_required: "请确认是否本人账户之间的资金转移。",
    finance_preview_stale: "预览已更新，请重新查看当前版本后确认。",
    finance_preview_not_presented: "当前完整预览尚未确认送达，请发送“查看预览 Q编号”重新查看。",
    finance_preview_closed: "该预览已取消或完成，请先查看它的当前状态。",
    finance_preview_changed: "预览期间出现了相关新记录，请重新提供交易信息以核对重复情况。",
    finance_preview_unresolved: "预览仍有待补充或待核对项目，尚未入账。",
    finance_record_not_found: "未找到这个记录编号，请核对。", finance_preview_not_found: "未找到这个预览编号，请核对。",
    finance_record_stale: "记录已更新，请先查看当前记录再更正或撤销。",
    finance_record_withdrawn: "这条记录已经撤销，仍可查看历史。",
    finance_record_selection_required: "请在消息中明确写出要操作的 F 记录编号。",
    finance_facts_unresolved: "交易信息仍不完整，请补充实际金额、日期和收支方向。",
  };
  return messages[code] ?? (/^finance_[a-z_]+$/u.test(code) ? "交易信息未通过校验，请核对金额、日期、账本与交易状态。" : code);
}
