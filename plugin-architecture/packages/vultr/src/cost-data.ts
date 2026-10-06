/**
 * Billed spend from Vultr's billing API.
 *
 * - Closed periods: `GET /v2/billing/invoices`, then
 *   `GET /v2/billing/invoices/{id}/items` for every invoice near the range.
 *   Each item carries `product`, `description`, `start_date`, `end_date` and
 *   `total`; the total is spread evenly over the UTC days the item covers.
 * - The open month: `GET /v2/billing/pending-charges` returns the same item
 *   shape for charges accrued so far this month; each item is spread over its
 *   start date to today. Every daily run restates the open month, and
 *   `restatementDays` keeps the previous month inside the window so the
 *   invoice replaces the estimate when it closes.
 *
 * Items name the product ("Cloud Compute", "Block Storage", ...) but carry
 * no subscription id and no region, so the only dimension is `service`.
 * Negative items (promotional credit, refunds) are `credit` rows and a
 * product containing "tax" is a `tax` row.
 */

import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { VultrApi } from "./api.js";
import type { VultrInvoice, VultrInvoiceItem } from "./types.js";

const DAY_MS = 86_400_000;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStart(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The UTC days an item covers, inclusive, capped at `capMs` when given. */
export function itemDays(item: VultrInvoiceItem, capMs?: number): string[] {
  const start = dayStart(item.start_date);
  if (start === null) return [];
  let end = dayStart(item.end_date) ?? start;
  // An end stamped exactly at midnight belongs to the previous day.
  if (item.end_date && /T00:00:00/.test(item.end_date) && end > start) end -= DAY_MS;
  if (capMs !== undefined) end = Math.min(end, capMs);
  if (end < start) end = start;
  const days: string[] = [];
  for (let t = start; t <= end && days.length < 400; t += DAY_MS) days.push(utcDay(t));
  return days;
}

export function chargeTypeOf(item: VultrInvoiceItem): CostChargeType {
  const product = `${item.product ?? ""} ${item.description ?? ""}`.toLowerCase();
  if (/\btax\b|\bvat\b|\bgst\b/.test(product)) return "tax";
  if ((item.total ?? 0) < 0) return "credit";
  return "usage";
}

export function serviceOf(item: VultrInvoiceItem): string {
  return (item.product || item.description || "Other").trim();
}

class RowBuilder {
  private readonly rows = new Map<string, CostRow>();
  constructor(private readonly range: CostFetchRange) {}

  add(item: VultrInvoiceItem, capMs?: number): void {
    const total = Number(item.total ?? 0);
    if (!Number.isFinite(total) || total === 0) return;
    const days = itemDays(item, capMs);
    if (days.length === 0) return;
    const perDay = total / days.length;
    const service = serviceOf(item);
    const chargeType = chargeTypeOf(item);
    for (const date of days) {
      if (date < this.range.fromDate || date > this.range.toDate) continue;
      const key = `${date}|${service}|${chargeType}`;
      const row = this.rows.get(key);
      if (row) row.amount += perDay;
      else
        this.rows.set(key, {
          date,
          service,
          currency: "USD",
          amount: perDay,
          ...(chargeType !== "usage" ? { chargeType } : {}),
        });
    }
  }

  build(): CostRow[] {
    return [...this.rows.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
  }
}

export async function fetchVultrCostData(
  api: VultrApi,
  range: CostFetchRange,
  now: number = Date.now(),
): Promise<CostRow[]> {
  const builder = new RowBuilder(range);
  const from = Date.parse(`${range.fromDate}T00:00:00Z`);
  const to = Date.parse(`${range.toDate}T00:00:00Z`);
  const invoices = await api.all<VultrInvoice>("/billing/invoices", "billing_invoices");
  // An invoice is dated when it is issued, after the period it bills, so
  // look a little either side of the range.
  const relevant = invoices.filter((inv) => {
    const t = Date.parse(inv.date ?? "");
    return Number.isFinite(t) && t >= from - 7 * DAY_MS && t <= to + 45 * DAY_MS;
  });
  for (const inv of relevant) {
    const items = await api.all<VultrInvoiceItem>(
      `/billing/invoices/${inv.id}/items`,
      "invoice_items",
    );
    for (const item of items) builder.add(item);
  }
  const today = dayStart(new Date(now).toISOString()) ?? now;
  if (today >= from) {
    const pending = await api.get<{ pending_charges?: VultrInvoiceItem[] }>(
      "/billing/pending-charges",
    );
    for (const item of pending.pending_charges ?? []) builder.add(item, today);
  }
  return builder.build();
}
