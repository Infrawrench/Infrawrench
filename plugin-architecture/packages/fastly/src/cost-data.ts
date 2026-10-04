/**
 * Fastly spend, from the Invoices API (`/billing/v3/invoices`, verified
 * against Fastly's published OpenAPI clients, 2026-10).
 *
 * Fastly bills monthly and publishes no daily cost, so the collector is
 * period-native: every row is dated to the first day of its billing month.
 *
 * - **Closed months** come from the posted invoice: `GET /billing/v3/invoices`
 *   filtered by `billing_start_date` / `billing_end_date`, each invoice's
 *   `transaction_line_items` grouped by product.
 * - **The current month** comes from `GET /billing/v3/invoices/month-to-date`,
 *   the running estimate Fastly shows in the billing dashboard. It is restated
 *   in place on every pass (same date, same keys), and replaced by the posted
 *   invoice once that month is over.
 * - **A closed month whose invoice is not posted yet** (the first days of a
 *   month) returns nothing, so the rows the month-to-date estimate wrote while
 *   it was current survive until the invoice replaces them.
 *
 * A chunk only reports the months whose first day lies inside it, so the
 * host's month-aligned chunks and its trailing restatement window stay
 * exactly-once.
 *
 * Billing data is readable by users with the Billing or Superuser role; the
 * token's scope must be `global` or `global:read`.
 */

import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { FastlyContext } from "./api.js";
import { fastlyCursorPaged, fastlyFetch, isPermissionError } from "./api.js";

/** One invoice line, as both the posted and the month-to-date invoices carry it. */
export interface FastlyLineItem {
  amount?: number | string;
  rate?: number | string;
  units?: number | string;
  description?: string;
  /** e.g. `Compute`, `Full-Site Delivery`. */
  product_group?: string;
  /** e.g. `Network Services`, `Security`. */
  product_line?: string;
  product_name?: string;
  region?: string;
  /** The unit of measure, e.g. `requests`, `bandwidth`. */
  usage_type?: string;
  credit_coupon_code?: string;
}

export interface FastlyInvoice {
  invoice_id?: string;
  customer_id?: string;
  invoice_posted_on?: string;
  billing_start_date?: string;
  billing_end_date?: string;
  statement_number?: string;
  currency_code?: string;
  monthly_transaction_amount?: number | string;
  transaction_line_items?: FastlyLineItem[];
}

export interface FastlyMonthToDate {
  customer_id?: string;
  invoice_id?: string;
  billing_start_date?: string;
  billing_end_date?: string;
  monthly_transaction_amount?: number | string;
  transaction_line_items?: FastlyLineItem[];
}

const BILLING_HELP = {
  label: "Fastly user roles",
  url: "https://www.fastly.com/documentation/guides/account-info/user-access-and-control/about-user-roles-and-permissions/",
};

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** `YYYY-MM-01` of an ISO timestamp, in UTC; empty when unparseable. */
export function monthStartOf(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return /^\d{4}-\d{2}/.test(iso) ? `${iso.slice(0, 7)}-01` : "";
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** First-of-month dates (`YYYY-MM-01`) inside the inclusive range. */
export function periodStartsInRange(range: CostFetchRange): string[] {
  const out: string[] = [];
  const from = new Date(`${range.fromDate}T00:00:00.000Z`);
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  if (cursor.toISOString().slice(0, 10) < range.fromDate) {
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  while (cursor.toISOString().slice(0, 10) <= range.toDate) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function addMonths(monthStart: string, n: number): string {
  const d = new Date(`${monthStart}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * What kind of charge a line is. Fastly marks credits with a coupon code (and
 * a negative amount); tax and support are their own products.
 */
export function chargeTypeOf(line: FastlyLineItem): CostChargeType {
  const amount = num(line.amount);
  if ((line.credit_coupon_code ?? "").trim() !== "" || amount < 0) return "credit";
  const text = `${line.product_line ?? ""} ${line.product_group ?? ""} ${line.product_name ?? ""} ${line.description ?? ""}`;
  if (/\btax(es)?\b|\bvat\b/i.test(text)) return "tax";
  if (/\bsupport\b/i.test(text)) return "support";
  return "usage";
}

/** The product a line is filed under: the `service` dimension. */
export function productOf(line: FastlyLineItem): string {
  return (
    (line.product_name ?? "").trim() ||
    (line.product_group ?? "").trim() ||
    (line.description ?? "").trim() ||
    "Other"
  );
}

/**
 * Turn invoice lines into rows for one month, aggregated by
 * (product, region, product line, product group, charge type) so a re-fetch
 * reproduces the same dimension keys. Lines of one key that share a unit of
 * measure carry the summed quantity.
 */
export function linesToRows(
  lines: readonly FastlyLineItem[],
  date: string,
  currency: string,
): CostRow[] {
  const buckets = new Map<
    string,
    {
      service: string;
      region: string;
      productLine: string;
      productGroup: string;
      chargeType: CostChargeType;
      amount: number;
      units: number;
      unit: string | null;
    }
  >();
  for (const line of lines) {
    const amount = num(line.amount);
    if (amount === 0) continue;
    const service = productOf(line);
    const region = (line.region ?? "").trim();
    const productLine = (line.product_line ?? "").trim();
    const productGroup = (line.product_group ?? "").trim();
    const chargeType = chargeTypeOf(line);
    const unit = (line.usage_type ?? "").trim();
    const key = [service, region, productLine, productGroup, chargeType].join("\u0000");
    const b = buckets.get(key);
    if (b) {
      b.amount += amount;
      b.units += num(line.units);
      if (b.unit !== unit) b.unit = null;
    } else {
      buckets.set(key, {
        service,
        region,
        productLine,
        productGroup,
        chargeType,
        amount,
        units: num(line.units),
        unit,
      });
    }
  }
  const rows: CostRow[] = [];
  for (const b of buckets.values()) {
    if (Math.abs(b.amount) < 1e-9) continue;
    const tags: Record<string, string> = {};
    if (b.productLine) tags["productLine"] = b.productLine;
    if (b.productGroup) tags["productGroup"] = b.productGroup;
    rows.push({
      date,
      service: b.service,
      region: b.region,
      currency,
      amount: Math.round(b.amount * 1e6) / 1e6,
      ...(b.unit && b.units > 0 ? { usageAmount: b.units, usageUnit: b.unit } : {}),
      ...(b.chargeType !== "usage" ? { chargeType: b.chargeType } : {}),
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  }
  return rows;
}

async function guarded<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isPermissionError(err)) {
      throw new CostSetupError(
        "Fastly refused the billing request. Invoices are readable by users with the Billing or Superuser role, using a token with the global or global:read scope. Create the token as such a user, then update the account's credentials.",
        BILLING_HELP,
      );
    }
    throw err;
  }
}

/** Posted invoices whose billing period starts in `[fromMonth, toMonth]`. */
export async function listInvoices(
  ctx: FastlyContext,
  fromMonth: string,
  toMonth: string,
): Promise<FastlyInvoice[]> {
  // The end filter is given as the first day after the last month so an
  // invoice whose period ends at 23:59:59 on the last day is never cut off;
  // anything extra the filter lets through is dropped by month below.
  const all = await fastlyCursorPaged<FastlyInvoice>(
    ctx,
    "/billing/v3/invoices",
    { billing_start_date: fromMonth, billing_end_date: addMonths(toMonth, 1) },
    200,
  );
  return all.filter((inv) => {
    const m = monthStartOf(inv.billing_start_date);
    return m !== "" && m >= fromMonth && m <= toMonth;
  });
}

export async function getMonthToDate(ctx: FastlyContext): Promise<FastlyMonthToDate> {
  return (await fastlyFetch<FastlyMonthToDate>(ctx, "/billing/v3/invoices/month-to-date")) ?? {};
}

/**
 * The month-to-date invoice carries no currency; the account's most recent
 * posted invoice does. USD (Fastly's default) when there is none yet.
 */
async function latestCurrency(ctx: FastlyContext): Promise<string> {
  const res = await fastlyFetch<{ data?: FastlyInvoice[] }>(ctx, "/billing/v3/invoices", {
    query: { limit: 1 },
  });
  return res?.data?.[0]?.currency_code || "USD";
}

export function currentMonthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function fetchFastlyCostData(
  ctx: FastlyContext,
  range: CostFetchRange,
  now: Date = new Date(),
): Promise<CostRow[]> {
  const periods = periodStartsInRange(range);
  if (periods.length === 0) return [];
  const current = currentMonthStart(now);
  const closed = periods.filter((p) => p < current);
  const wantCurrent = periods.includes(current);

  return guarded(async () => {
    const rows: CostRow[] = [];
    let currency = "";
    if (closed.length > 0) {
      const invoices = await listInvoices(ctx, closed[0]!, closed[closed.length - 1]!);
      for (const inv of invoices) {
        const month = monthStartOf(inv.billing_start_date);
        if (!closed.includes(month)) continue;
        currency ||= inv.currency_code ?? "";
        rows.push(
          ...linesToRows(inv.transaction_line_items ?? [], month, inv.currency_code || "USD"),
        );
      }
    }
    if (wantCurrent) {
      const mtd = await getMonthToDate(ctx);
      const ccy = currency || (await latestCurrency(ctx).catch(() => "USD"));
      rows.push(...linesToRows(mtd.transaction_line_items ?? [], current, ccy));
    }
    return mergeRows(rows);
  });
}

/**
 * Two invoices for one month (a correction posted separately) would produce
 * two rows with one key, which would collapse in storage: sum them instead.
 */
function mergeRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const r of rows) {
    const key = [
      r.date,
      r.service,
      r.region,
      r.currency,
      r.chargeType ?? "usage",
      r.tags?.["productLine"] ?? "",
      r.tags?.["productGroup"] ?? "",
    ].join("\u0000");
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    prev.amount = Math.round((prev.amount + r.amount) * 1e6) / 1e6;
    if (prev.usageUnit && prev.usageUnit === r.usageUnit) {
      prev.usageAmount = (prev.usageAmount ?? 0) + (r.usageAmount ?? 0);
    } else {
      delete prev.usageAmount;
      delete prev.usageUnit;
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Billing summary for the account detail view
// ---------------------------------------------------------------------------

export interface FastlyProductTotal {
  product: string;
  productLine: string;
  amount: number;
}

export interface FastlyInvoiceSummary {
  invoiceId: string;
  month: string;
  total: number;
  currency: string;
  postedOn: string;
  statementNumber: string;
}

export interface FastlyUsageLine {
  productId: string;
  name: string;
  region: string;
  unit: string;
  quantity: number;
}

export interface FastlyBillingSummary {
  currency: string;
  monthToDate: number;
  monthToDateByProduct: FastlyProductTotal[];
  invoices: FastlyInvoiceSummary[];
  /** This month's billable usage by product, from the Usage Metrics API. */
  usage: FastlyUsageLine[];
}

interface FastlyUsageMetric {
  month?: string;
  usage_type?: string;
  name?: string;
  region?: string;
  unit?: string;
  quantity?: number | string;
  raw_quantity?: number | string;
  product_id?: string;
}

/**
 * `GET /billing/v3/usage-metrics?start_month=YYYY-MM&end_month=YYYY-MM`:
 * monthly billable quantities per product and usage type (Compute requests,
 * Image Optimizer transforms, Next-Gen WAF requests, log streaming, …), in the
 * units the invoice uses.
 */
export async function fetchUsageMetrics(
  ctx: FastlyContext,
  month: string,
): Promise<FastlyUsageLine[]> {
  const ym = month.slice(0, 7);
  const res = await fastlyFetch<{ data?: FastlyUsageMetric[] }>(ctx, "/billing/v3/usage-metrics", {
    query: { start_month: ym, end_month: ym },
  });
  return (res?.data ?? [])
    .map((u) => ({
      productId: u.product_id ?? "",
      name: u.name ?? u.usage_type ?? "",
      region: u.region ?? "",
      unit: u.unit && u.unit !== "unit" ? u.unit : "",
      quantity: num(u.quantity),
    }))
    .filter((u) => u.quantity !== 0)
    .sort((a, b) => a.productId.localeCompare(b.productId) || a.name.localeCompare(b.name));
}

export function productTotals(lines: readonly FastlyLineItem[]): FastlyProductTotal[] {
  const totals = new Map<string, FastlyProductTotal>();
  for (const line of lines) {
    const amount = num(line.amount);
    if (amount === 0) continue;
    const product = productOf(line);
    const productLine = (line.product_line ?? "").trim();
    const key = `${product}\u0000${productLine}`;
    const t = totals.get(key);
    if (t) t.amount += amount;
    else totals.set(key, { product, productLine, amount });
  }
  return [...totals.values()]
    .map((t) => ({ ...t, amount: Math.round(t.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);
}

/** Month-to-date total by product plus the last year of posted invoices. */
export async function fetchFastlyBillingSummary(
  ctx: FastlyContext,
  now: Date = new Date(),
): Promise<FastlyBillingSummary> {
  const current = currentMonthStart(now);
  const [mtd, invoices, usage] = await Promise.all([
    getMonthToDate(ctx),
    listInvoices(ctx, addMonths(current, -12), addMonths(current, -1)),
    fetchUsageMetrics(ctx, current).catch(() => [] as FastlyUsageLine[]),
  ]);
  const sorted = [...invoices].sort((a, b) =>
    String(b.billing_start_date ?? "").localeCompare(String(a.billing_start_date ?? "")),
  );
  const currency = sorted[0]?.currency_code || "USD";
  const lines = mtd.transaction_line_items ?? [];
  const lineSum = lines.reduce((s, l) => s + num(l.amount), 0);
  return {
    currency,
    monthToDate:
      mtd.monthly_transaction_amount !== undefined
        ? num(mtd.monthly_transaction_amount)
        : Math.round(lineSum * 100) / 100,
    monthToDateByProduct: productTotals(lines),
    invoices: sorted.map((inv) => ({
      invoiceId: String(inv.invoice_id ?? ""),
      month: monthStartOf(inv.billing_start_date).slice(0, 7),
      total: num(inv.monthly_transaction_amount),
      currency: inv.currency_code || currency,
      postedOn: (inv.invoice_posted_on ?? "").slice(0, 10),
      statementNumber: inv.statement_number ?? "",
    })),
    usage,
  };
}
