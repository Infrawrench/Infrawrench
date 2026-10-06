import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { XInvoice, XOrg } from "./api.js";

/**
 * Billed spend from `GET /organizations/{id}/billing/invoices` plus the
 * running `billing/invoices/upcoming` total (verified 2026-10).
 *
 * Invoices carry one decimal `amount_due` and an `invoice_date`, with no line
 * items and no billing-period fields, so rows are period-native: one row per
 * invoice, dated to the first day of the month the invoice covers. Xata bills
 * monthly in arrears through Orb, which issues an invoice on the day the
 * period closes, so the covered month is the month of the day *before*
 * `invoice_date`. Void and draft invoices are skipped (a draft is superseded
 * by the upcoming invoice, which is the current month's running total).
 */
export function coveredMonthStart(invoiceDate: string): string {
  const ms = Date.parse(invoiceDate);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms - 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function fetchXataCostData(
  org: XOrg,
  invoices: XInvoice[],
  upcoming:
    { amount_due?: number; total?: number; currency?: string; target_date?: string } | undefined,
  range: CostFetchRange,
): CostRow[] {
  const totals = new Map<string, { currency: string; amount: number; status: string }>();
  const add = (date: string, currency: string, amount: number, status: string) => {
    if (!date || date < range.fromDate.slice(0, 7) + "-01" || date > range.toDate) return;
    if (!Number.isFinite(amount) || amount === 0) return;
    const key = `${date}|${currency}`;
    const cur = totals.get(key);
    if (cur) cur.amount += amount;
    else totals.set(key, { currency, amount, status });
  };
  for (const inv of invoices) {
    if (inv.status === "void" || inv.status === "draft") continue;
    add(
      coveredMonthStart(inv.invoice_date),
      (inv.currency || "USD").toUpperCase(),
      Number(inv.amount_due),
      inv.status,
    );
  }
  if (upcoming?.target_date) {
    const amount = Number(upcoming.total ?? upcoming.amount_due ?? 0);
    add(
      coveredMonthStart(upcoming.target_date),
      (upcoming.currency || "USD").toUpperCase(),
      amount,
      "upcoming",
    );
  }
  return [...totals.entries()].map(([key, v]) => ({
    date: key.split("|")[0]!,
    service: "Xata",
    currency: v.currency,
    amount: Math.round(v.amount * 100) / 100,
    tags: { organization: org.name, invoiceStatus: v.status },
  }));
}
