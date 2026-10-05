/**
 * Actual-spend collection from Datadog's Usage Metering cost endpoints.
 *
 * Verified against Datadog's published OpenAPI document
 * (DataDog/datadog-api-client-typescript, `.generator/schemas/v2/openapi.yaml`,
 * operations `GetEstimatedCostByOrg`, `GetHistoricalCostByOrg`,
 * `GetProjectedCost`) and https://docs.datadoghq.com/api/latest/usage-metering/
 * plus https://docs.datadoghq.com/account_management/plan_and_usage/cost_details/
 * (2026-10). Recorded fixtures in Datadog's own client test suites
 * (datadog-api-client-python `tests/v2/cassettes`) supplied the charge-type
 * vocabulary the reference leaves untyped.
 *
 * What Datadog offers, and why the collector is shaped the way it is:
 *
 * - **Estimated cost** (`/api/v2/usage/estimated_cost`) covers only the
 *   current and the previous calendar month, lags up to 72 hours, and with
 *   `start_date`/`end_date` returns one entry per org per day. Asked with
 *   `cost_aggregation=cumulative` each entry is the month-to-date running
 *   total, so a day's cost is the difference between consecutive days in the
 *   same month. The parameter is sent explicitly rather than relying on the
 *   default, which the reference describes ambiguously ("day-over-day
 *   cumulative cost"); asking for the running total and differencing it is
 *   correct whatever the default is. Each month is requested on its own from
 *   its 1st, so the first day of a fetched range always has a predecessor.
 * - **Historical cost** (`/api/v2/usage/historical_cost`) is monthly only and
 *   is finalised around the 16th of the following month. It is used for
 *   months older than the estimated window, which in practice means the
 *   initial backfill, and each month's total is dated to the 1st of the
 *   month. Only months that lie *entirely* inside the requested range are
 *   written: a backfill asks for whole months, while an incremental pass's
 *   trailing window (see `restatementDays` on the manifest) can never contain
 *   a whole month older than the estimated window, so a month is never filed
 *   twice, once daily and once as a monthly lump.
 * - Both endpoints take `view=sub-org`, which breaks spend down per child
 *   organization for a parent org and is simply the one org for a standalone
 *   one. The org name rides along as the `org` tag and the Datadog region as
 *   `region`.
 * - Each product reports a charge list per pricing model: `committed` (spend
 *   at contracted rates), `on_demand` (overage at on-demand rates) and a
 *   `total` that is their sum. The split is kept as the `pricing` tag and
 *   `total` is used only when nothing finer is present, so a product's money
 *   is never counted twice.
 * - Several product ids share a display label (Datadog renamed a few), so rows
 *   are aggregated by their final key before they are returned. Two rows with
 *   the same key would otherwise collapse in storage to whichever came last.
 *
 * Datadog reports no currency field. Contracts are priced in US dollars, so
 * rows are USD; this is stated in the plugin's docs.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { DatadogContext } from "./api.js";
import { ddFetch, isPermissionError, statusOf } from "./api.js";
import { productLabel } from "./products.js";

/** One `charges[]` entry. */
export interface DdCharge {
  charge_type?: string;
  cost?: number;
  product_name?: string;
}

/** One entry of a `CostByOrgResponse` / `ProjectedCostResponse`. */
export interface DdCostEntry {
  id?: string;
  type?: string;
  attributes?: {
    account_name?: string;
    account_public_id?: string;
    org_name?: string;
    public_id?: string;
    region?: string;
    date?: string;
    total_cost?: number;
    projected_total_cost?: number;
    charges?: DdCharge[];
  };
}

export interface DdCostResponse {
  data?: DdCostEntry[];
}

const COST_HELP = {
  label: "Datadog application key permissions",
  url: "https://docs.datadoghq.com/account_management/plan_and_usage/cost_details/#permissions",
};

const DAY_MS = 86_400_000;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** First day of the month after `date`'s month. */
function nextMonthStart(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return utcDate(Date.UTC(y, m, 1));
}

/** Last day of `date`'s month. */
function monthEnd(date: string): string {
  return utcDate(Date.parse(`${nextMonthStart(date)}T00:00:00Z`) - DAY_MS);
}

/** First day of the month before `date`'s month. */
function previousMonthStart(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return utcDate(Date.UTC(y, m - 2, 1));
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * Collapse a product's charge list into one amount per pricing model.
 * `total` is the sum of the others in every recorded response, so it is used
 * only when nothing finer exists for the product.
 */
export function chargesByPricing(charges: DdCharge[]): Map<string, Map<string, number>> {
  const byProduct = new Map<string, { fine: Map<string, number>; total: number | undefined }>();
  for (const c of charges) {
    const product = (c.product_name ?? "").trim();
    const type = (c.charge_type ?? "")
      .trim()
      .toLowerCase()
      .replace(/^projected_/, "");
    const cost = typeof c.cost === "number" && Number.isFinite(c.cost) ? c.cost : undefined;
    if (!product || !type || cost === undefined) continue;
    let entry = byProduct.get(product);
    if (!entry) {
      entry = { fine: new Map(), total: undefined };
      byProduct.set(product, entry);
    }
    if (type === "total") entry.total = (entry.total ?? 0) + cost;
    else entry.fine.set(type, (entry.fine.get(type) ?? 0) + cost);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [product, entry] of byProduct) {
    if (entry.fine.size > 0) out.set(product, entry.fine);
    else if (entry.total !== undefined) out.set(product, new Map([["total", entry.total]]));
  }
  return out;
}

function rowKey(r: CostRow): string {
  return JSON.stringify([r.date, r.service, r.region ?? "", r.tags ?? {}]);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function makeRow(
  date: string,
  product: string,
  pricing: string,
  amount: number,
  entry: DdCostEntry,
): CostRow {
  const a = entry.attributes ?? {};
  const tags: Record<string, string> = {};
  const org = (a.org_name ?? "").trim();
  if (org) tags["org"] = org;
  if (pricing !== "total") tags["pricing"] = pricing;
  return {
    date,
    service: productLabel(product),
    ...(a.region ? { region: a.region } : {}),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    currency: "USD",
    amount,
  };
}

function wrapCostError(err: unknown, what: string): never {
  if (isPermissionError(err)) {
    throw new CostSetupError(
      `Datadog refused the ${what} request (HTTP ${statusOf(err)}). Cost data needs an application key whose owner has both the Usage Read (usage_read) and Billing Read (billing_read) permissions, or a scoped key granted both scopes, and both keys must belong to the parent organization: child organizations cannot read cost.`,
      COST_HELP,
    );
  }
  throw err;
}

/** Org identity for grouping: public id where Datadog sends one. */
function orgKey(entry: DdCostEntry): string {
  const a = entry.attributes ?? {};
  return a.public_id || a.org_name || "";
}

/**
 * Daily rows for one calendar month of the estimated window, derived by
 * differencing the month-to-date running totals.
 */
async function estimatedMonth(
  ctx: DatadogContext,
  start: string,
  end: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const res = await ddFetch<DdCostResponse>(ctx, "/api/v2/usage/estimated_cost", {
    query: {
      view: "sub-org",
      start_date: start,
      end_date: end,
      cost_aggregation: "cumulative",
    },
  }).catch((err) => wrapCostError(err, "estimated cost"));

  // org → date → entry (a later entry for the same day wins: re-estimates).
  const byOrg = new Map<string, Map<string, DdCostEntry>>();
  for (const entry of res.data ?? []) {
    const date = (entry.attributes?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) continue;
    const key = orgKey(entry);
    let days = byOrg.get(key);
    if (!days) {
      days = new Map();
      byOrg.set(key, days);
    }
    days.set(date, entry);
  }

  const rows: CostRow[] = [];
  for (const days of byOrg.values()) {
    const previous = new Map<string, number>();
    for (const date of [...days.keys()].sort()) {
      const entry = days.get(date)!;
      const current = chargesByPricing(entry.attributes?.charges ?? []);
      for (const [product, pricing] of current) {
        for (const [model, cumulative] of pricing) {
          const k = `${product}\u0000${model}`;
          const daily = round(cumulative - (previous.get(k) ?? 0));
          previous.set(k, cumulative);
          if (date < range.fromDate || date > range.toDate || daily === 0) continue;
          rows.push(makeRow(date, product, model, daily, entry));
        }
      }
      // A product missing from a later day keeps its running total: an
      // omitted line is "no change reported", not a refund of the month.
    }
  }
  return rows;
}

/** Monthly rows from the finalised historical endpoint, dated to the 1st. */
async function historicalMonths(
  ctx: DatadogContext,
  firstMonth: string,
  lastMonth: string,
): Promise<CostRow[]> {
  const res = await ddFetch<DdCostResponse>(ctx, "/api/v2/usage/historical_cost", {
    query: {
      view: "sub-org",
      start_month: firstMonth.slice(0, 7),
      end_month: lastMonth.slice(0, 7),
    },
  }).catch((err) => wrapCostError(err, "historical cost"));

  const rows: CostRow[] = [];
  for (const entry of res.data ?? []) {
    const raw = (entry.attributes?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    const date = monthStart(raw);
    if (date < firstMonth || date > lastMonth) continue;
    for (const [product, pricing] of chargesByPricing(entry.attributes?.charges ?? [])) {
      for (const [model, amount] of pricing) {
        if (amount === 0) continue;
        rows.push(makeRow(date, product, model, round(amount), entry));
      }
    }
  }
  return rows;
}

/** Sum rows that share a storage key (several product ids map to one label). */
export function aggregateRows(rows: CostRow[]): CostRow[] {
  const merged = new Map<string, CostRow>();
  for (const row of rows) {
    const k = rowKey(row);
    const existing = merged.get(k);
    if (existing) existing.amount = round(existing.amount + row.amount);
    else merged.set(k, { ...row });
  }
  return [...merged.values()].filter((r) => r.amount !== 0);
}

export async function fetchDatadogCostData(
  ctx: DatadogContext,
  range: CostFetchRange,
  now: number = Date.now(),
): Promise<CostRow[]> {
  const today = utcDate(now);
  const to = minDate(range.toDate, today);
  if (to < range.fromDate) return [];

  const estimatedStart = previousMonthStart(today);
  const rows: CostRow[] = [];

  // Months before the estimated window: whole months only, from historical.
  const histEnd = minDate(to, utcDate(Date.parse(`${estimatedStart}T00:00:00Z`) - DAY_MS));
  if (range.fromDate <= histEnd) {
    const firstWhole =
      range.fromDate === monthStart(range.fromDate)
        ? range.fromDate
        : nextMonthStart(range.fromDate);
    const lastWhole = histEnd === monthEnd(histEnd) ? monthStart(histEnd) : undefined;
    if (lastWhole && firstWhole <= lastWhole) {
      rows.push(...(await historicalMonths(ctx, firstWhole, lastWhole)));
    }
  }

  // The estimated window, one calendar month per request.
  let cursor = monthStart(maxDate(range.fromDate, estimatedStart));
  while (cursor <= to) {
    const end = minDate(monthEnd(cursor), to);
    if (end >= range.fromDate) {
      rows.push(...(await estimatedMonth(ctx, cursor, end, range)));
    }
    cursor = nextMonthStart(cursor);
  }

  return aggregateRows(rows);
}

/** Month-to-date and projected month-end spend, per org, for detail views. */
export interface DatadogOrgCostSummary {
  publicId: string;
  orgName: string;
  region: string;
  /** Estimated month-to-date total, when Datadog reported one. */
  monthToDate?: number;
  /** Projected month-end total; Datadog publishes it from around the 12th. */
  projected?: number;
  /** Per product: month-to-date and projected, by display label. */
  products: Array<{ product: string; monthToDate?: number; projected?: number }>;
}

function productTotals(charges: DdCharge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [product, pricing] of chargesByPricing(charges)) {
    const label = productLabel(product);
    let sum = 0;
    for (const v of pricing.values()) sum += v;
    out.set(label, round((out.get(label) ?? 0) + sum));
  }
  return out;
}

/**
 * Current-month estimated and projected cost per org. Both halves are best
 * effort: a projection that is not published yet (before about the 12th) or a
 * key without billing access leaves that half empty rather than failing.
 */
export async function fetchDatadogCostSummary(
  ctx: DatadogContext,
): Promise<DatadogOrgCostSummary[]> {
  const [estimated, projected] = await Promise.all([
    ddFetch<DdCostResponse>(ctx, "/api/v2/usage/estimated_cost", {
      query: { view: "sub-org", start_month: utcDate(Date.now()).slice(0, 7) },
    }).catch(() => ({ data: [] }) as DdCostResponse),
    ddFetch<DdCostResponse>(ctx, "/api/v2/usage/projected_cost", {
      query: { view: "sub-org" },
    }).catch(() => ({ data: [] }) as DdCostResponse),
  ]);

  const orgs = new Map<string, DatadogOrgCostSummary>();
  const productMap = new Map<string, Map<string, { monthToDate?: number; projected?: number }>>();
  const touch = (entry: DdCostEntry): DatadogOrgCostSummary => {
    const a = entry.attributes ?? {};
    const key = orgKey(entry);
    let org = orgs.get(key);
    if (!org) {
      org = {
        publicId: a.public_id ?? "",
        orgName: a.org_name ?? "",
        region: a.region ?? "",
        products: [],
      };
      orgs.set(key, org);
      productMap.set(key, new Map());
    }
    return org;
  };

  // A month query can still return one entry per day on some accounts; keep
  // the latest date per org, which is the month-to-date figure.
  const latest = new Map<string, DdCostEntry>();
  for (const entry of estimated.data ?? []) {
    const key = orgKey(entry);
    const prev = latest.get(key);
    if (!prev || (entry.attributes?.date ?? "") >= (prev.attributes?.date ?? "")) {
      latest.set(key, entry);
    }
  }
  for (const entry of latest.values()) {
    const org = touch(entry);
    const totals = productTotals(entry.attributes?.charges ?? []);
    let sum = 0;
    for (const [label, v] of totals) {
      sum += v;
      const pm = productMap.get(orgKey(entry))!;
      pm.set(label, { ...pm.get(label), monthToDate: v });
    }
    org.monthToDate = round(entry.attributes?.total_cost ?? sum);
  }
  for (const entry of projected.data ?? []) {
    const org = touch(entry);
    const totals = productTotals(entry.attributes?.charges ?? []);
    let sum = 0;
    for (const [label, v] of totals) {
      sum += v;
      const pm = productMap.get(orgKey(entry))!;
      pm.set(label, { ...pm.get(label), projected: v });
    }
    org.projected = round(entry.attributes?.projected_total_cost ?? sum);
  }
  for (const [key, org] of orgs) {
    org.products = [...(productMap.get(key) ?? new Map()).entries()]
      .map(([product, v]) => ({ product, ...v }))
      .sort((a, b) => (b.projected ?? b.monthToDate ?? 0) - (a.projected ?? a.monthToDate ?? 0));
  }
  return [...orgs.values()];
}
