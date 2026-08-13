/**
 * Actual-spend collection from Turso invoices.
 *
 * Turso's Platform API exposes billing only as issued monthly invoices
 * (`GET /v1/organizations/{slug}/invoices?type=issued`) — an org-level
 * `amount_due` in dollars with no line items, no service/database breakdown,
 * and no explicit period fields (just `due_date`, verified against
 * docs.turso.tech, July 2026). Rows are therefore a monthly org lump sum,
 * dated to the invoice's due date — the billing-cycle boundary — and the
 * manifest declares `periodNative` so charts label the series accordingly.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

interface TursoInvoiceRecord {
  invoice_number?: string;
  amount_due?: string;
  due_date?: string;
  paid_at?: string | null;
  payment_failed_at?: string | null;
  invoice_pdf?: string;
}

export async function fetchTursoCostData(
  fetchApi: <T>(path: string) => Promise<T>,
  orgName: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const data = await fetchApi<{ invoices?: TursoInvoiceRecord[] }>(
    `/v1/organizations/${encodeURIComponent(orgName)}/invoices?type=issued`,
  );

  // One row per day: should two invoices ever share a due date, they collapse
  // into a single stable dimension key.
  const byDate = new Map<string, number>();
  for (const invoice of data.invoices ?? []) {
    const date = (invoice.due_date ?? "").slice(0, 10);
    if (!date || date < range.fromDate || date > range.toDate) continue;
    // `amount_due` is a formatted USD string, e.g. "10.29".
    const amount = Number(invoice.amount_due ?? "");
    if (!Number.isFinite(amount) || amount === 0) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + amount);
  }
  return [...byDate.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([date, amount]) => ({ date, currency: "USD", amount }));
}
