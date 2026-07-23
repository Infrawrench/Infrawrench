/**
 * Actual-spend collection via the OVH account billing endpoints.
 *
 * Finalized spend comes from invoices: `GET /me/bill?date.from=&date.to=`
 * lists bill IDs issued in the window, `GET /me/bill/{billId}` carries the
 * pre-tax total, and `GET /me/bill/{billId}/details/{detailId}` breaks the
 * bill down per service line. The unbilled in-progress period comes from
 * `GET /me/consumption/usage/current` (one transaction per Public Cloud
 * service with per-plan elements), fetched only when the chunk covers today.
 *
 * Spend is period-native: rows are dated to the bill's issue date (details
 * often span the previous month, but chunks partition bills by issue date,
 * so dating rows to it keeps every row inside the chunk that fetched it and
 * collection exactly-once). Chunks containing no bill and not covering
 * today return nothing.
 *
 * The API credential needs the access rules `GET /me/bill*` and
 * `GET /me/consumption*` — account-level routes that a Public-Cloud-only
 * consumer key will not have unless granted. Missing consumption access
 * degrades gracefully (invoiced history still collects).
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

/** Signature of the client's private signed OVH fetch helper. */
export type OvhJsonFetcher = <T>(path: string) => Promise<T>;

/** order.Price / me.consumption.Price — both carry currencyCode + value. */
interface OvhPrice {
  currencyCode?: string;
  value?: number;
}

interface OvhBill {
  billId?: string;
  date?: string;
  priceWithoutTax?: OvhPrice;
}

interface OvhBillDetail {
  description?: string;
  /** The billed service, e.g. a Public Cloud project's service name. */
  domain?: string;
  totalPrice?: OvhPrice;
}

interface OvhConsumptionElement {
  planCode?: string;
  planFamily?: string;
  price?: OvhPrice;
}

interface OvhConsumptionTransaction {
  beginDate?: string;
  serviceId?: number;
  price?: OvhPrice;
  elements?: OvhConsumptionElement[];
}

/**
 * Above this many line items, fall back to the single bill-total row —
 * fetching details is one signed request per line, and a partial drain
 * would under-report the bill.
 */
const MAX_DETAILS_PER_BILL = 300;

export async function fetchOvhCostData(
  ovhFetch: OvhJsonFetcher,
  range: CostFetchRange,
): Promise<CostRow[]> {
  // Aggregate per (date, service, currency) so repeated lines for the same
  // service collapse into one stable dimension key.
  const totals = new Map<string, { row: CostRow; amount: number }>();
  const add = (date: string, service: string, currency: string, amount: number): void => {
    if (!Number.isFinite(amount) || amount === 0) return;
    const key = `${date} ${service} ${currency}`;
    const entry = totals.get(key);
    if (entry) {
      entry.amount += amount;
      return;
    }
    totals.set(key, { row: { date, service, currency, amount: 0 }, amount });
  };

  // 1. Invoices issued inside the chunk (pre-tax, matching net cost).
  const params = new URLSearchParams({
    "date.from": `${range.fromDate}T00:00:00Z`,
    "date.to": `${range.toDate}T23:59:59Z`,
  });
  const billIds = await ovhFetch<string[]>(`/me/bill?${params.toString()}`);
  for (const billId of billIds ?? []) {
    const encodedBill = encodeURIComponent(billId);
    const bill = await ovhFetch<OvhBill>(`/me/bill/${encodedBill}`);
    const date = (bill.date ?? "").slice(0, 10);
    if (!date || date < range.fromDate || date > range.toDate) continue;
    const billCurrency = bill.priceWithoutTax?.currencyCode ?? "EUR";

    // Stage detail rows and only commit a fully-drained breakdown; anything
    // partial (error, truncation) falls back to the bill total instead.
    let detailRows: Array<{ service: string; currency: string; amount: number }> | null = null;
    try {
      const detailIds = await ovhFetch<string[]>(`/me/bill/${encodedBill}/details`);
      if (detailIds && detailIds.length > 0 && detailIds.length <= MAX_DETAILS_PER_BILL) {
        const staged: Array<{ service: string; currency: string; amount: number }> = [];
        for (const detailId of detailIds) {
          const detail = await ovhFetch<OvhBillDetail>(
            `/me/bill/${encodedBill}/details/${encodeURIComponent(detailId)}`,
          );
          staged.push({
            service: detail.domain || detail.description || "",
            currency: detail.totalPrice?.currencyCode ?? billCurrency,
            amount: detail.totalPrice?.value ?? 0,
          });
        }
        detailRows = staged;
      }
    } catch {
      detailRows = null;
    }

    if (detailRows) {
      for (const line of detailRows) add(date, line.service, line.currency, line.amount);
    } else {
      add(date, "", billCurrency, bill.priceWithoutTax?.value ?? 0);
    }
  }

  // 2. The unbilled in-progress period — only when the chunk covers today,
  // because /me/consumption/usage/current always reports the present period
  // and attaching it to any other chunk would misdate it.
  const today = new Date().toISOString().slice(0, 10);
  if (today >= range.fromDate && today <= range.toDate) {
    try {
      const transactions = await ovhFetch<OvhConsumptionTransaction[]>(
        "/me/consumption/usage/current",
      );
      for (const tx of transactions ?? []) {
        const begin = (tx.beginDate ?? "").slice(0, 10);
        // Clamp so rows stay inside the fetched chunk even if the period
        // opened before it.
        const date = begin >= range.fromDate && begin <= range.toDate ? begin : range.fromDate;
        const txCurrency = tx.price?.currencyCode ?? "EUR";
        const elements = tx.elements ?? [];
        if (elements.length === 0) {
          add(date, String(tx.serviceId ?? ""), txCurrency, tx.price?.value ?? 0);
          continue;
        }
        for (const element of elements) {
          add(
            date,
            element.planFamily || element.planCode || String(tx.serviceId ?? ""),
            element.price?.currencyCode ?? txCurrency,
            element.price?.value ?? 0,
          );
        }
      }
    } catch {
      // Consumer key lacks GET /me/consumption* — invoiced history is still
      // collected, the current period just lags until its bill lands.
    }
  }

  const rows: CostRow[] = [];
  for (const { row, amount } of totals.values()) {
    if (amount === 0) continue;
    rows.push({ ...row, amount });
  }
  return rows;
}
