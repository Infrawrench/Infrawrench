import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { CoreWeaveContext } from "./api.js";
import { instanceSpec } from "./catalog.js";
import type { FocusRow } from "./focus.js";
import { dayOf, fetchFocusRows, quantityOf, toApiTime } from "./focus.js";
import type { CapacityPlan, NegotiatedRates, RateSource } from "./rates.js";
import { normalisePlan, rateForUsage } from "./rates.js";

/**
 * Daily cost rows for a CoreWeave account, derived from the FOCUS usage
 * export.
 *
 * The export carries billable quantities but no money, so each quantity is
 * multiplied by a rate: the account's negotiated rate where the user entered
 * one, otherwise the published on-demand list price (see `rates.ts`). The
 * manifest therefore declares `estimated: true`, and every row says which
 * source priced it in its `pricing` tag (`negotiated`, `list`, or `unpriced`
 * for SKUs CoreWeave only quotes on request, which keep their usage and carry
 * no money).
 *
 * The cluster and zone come from the `location` view and the capacity plan
 * from the `capacity_plan` view. The two are pivots of the same usage with
 * equal per-(hour, SKU) totals, so each location row is split across plans in
 * proportion to that day's plan mix for its SKU. That is what lets a Reserved
 * hour be priced at a negotiated reserved rate while still being attributed to
 * the cluster that used it.
 */

/** FOCUS history starts here; earlier requests return nothing. */
export const FOCUS_HISTORY_START = "2026-01-01";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface LocationAgg {
  date: string;
  clusterId: string;
  clusterName: string;
  zone: string;
  sku: string;
  unit: string;
  service: string;
  family: string;
  quantity: number;
}

function str(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** The export window for an inclusive day range, clipped to what can exist. */
export function exportWindow(
  range: CostFetchRange,
  now: number = Date.now(),
): { start: string; end: string } | null {
  const startDay = range.fromDate < FOCUS_HISTORY_START ? FOCUS_HISTORY_START : range.fromDate;
  const start = Date.parse(`${startDay}T00:00:00Z`);
  const requestedEnd = Date.parse(`${range.toDate}T00:00:00Z`) + DAY_MS;
  const topOfHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const end = Math.min(requestedEnd, topOfHour);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start: toApiTime(start), end: toApiTime(end) };
}

function aggregateLocation(rows: FocusRow[]): LocationAgg[] {
  const byKey = new Map<string, LocationAgg>();
  for (const r of rows) {
    const date = dayOf(r);
    const sku = str(r.SkuId);
    const quantity = quantityOf(r);
    if (!date || !sku || quantity === 0) continue;
    const agg: LocationAgg = {
      date,
      clusterId: str(r.x_ClusterId),
      clusterName: str(r.x_ClusterName),
      zone: str(r.RegionId),
      sku,
      unit: str(r.PricingUnit),
      service: str(r.ServiceName) || str(r.x_ProductFamily) || "CoreWeave",
      family: str(r.x_ProductFamily),
      quantity: 0,
    };
    const key = [agg.date, agg.clusterId, agg.zone, agg.sku, agg.unit, agg.service].join("|");
    const existing = byKey.get(key);
    if (existing) existing.quantity += quantity;
    else byKey.set(key, { ...agg, quantity });
  }
  return [...byKey.values()];
}

/** `date|sku` → plan → quantity, from the capacity-plan view. */
function aggregatePlans(rows: FocusRow[]): Map<string, Map<CapacityPlan | "other", number>> {
  const out = new Map<string, Map<CapacityPlan | "other", number>>();
  for (const r of rows) {
    const date = dayOf(r);
    const sku = str(r.SkuId);
    const quantity = quantityOf(r);
    if (!date || !sku || quantity === 0) continue;
    const plan = normalisePlan(r.x_CapacityPlan ?? r.PricingCategory) ?? "other";
    const key = `${date}|${sku}`;
    let plans = out.get(key);
    if (!plans) {
      plans = new Map();
      out.set(key, plans);
    }
    plans.set(plan, (plans.get(plan) ?? 0) + quantity);
  }
  return out;
}

const round = (n: number, digits = 6) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Build cost rows from already-fetched export rows. Pure, for tests. */
export function buildCostRows(
  locationRows: FocusRow[],
  planRows: FocusRow[],
  rates: NegotiatedRates,
): CostRow[] {
  const plans = aggregatePlans(planRows);
  const out: CostRow[] = [];
  for (const agg of aggregateLocation(locationRows)) {
    const mix = plans.get(`${agg.date}|${agg.sku}`);
    const total = mix ? [...mix.values()].reduce((a, b) => a + b, 0) : 0;
    const parts: Array<{ plan: CapacityPlan | undefined; quantity: number }> =
      mix && total > 0
        ? [...mix.entries()].map(([plan, q]) => ({
            plan: plan === "other" ? undefined : plan,
            quantity: (agg.quantity * q) / total,
          }))
        : [{ plan: undefined, quantity: agg.quantity }];
    for (const part of parts) {
      if (part.quantity === 0) continue;
      const priced = rateForUsage(rates, {
        sku: agg.sku,
        unit: agg.unit,
        service: agg.service,
        plan: part.plan,
      });
      const spec = instanceSpec(agg.sku);
      const tags: Record<string, string> = {
        sku: agg.sku,
        capacityPlan: part.plan ?? "unattributed",
        pricing: priced.source satisfies RateSource,
      };
      if (agg.clusterName) tags["cluster"] = agg.clusterName;
      if (agg.family) tags["productFamily"] = agg.family;
      if (spec?.gpuModel) tags["gpuModel"] = spec.gpuModel;
      out.push({
        date: agg.date,
        service: agg.service,
        ...(agg.zone ? { region: agg.zone } : {}),
        ...(agg.clusterId ? { resourceId: agg.clusterId } : {}),
        tags,
        currency: "USD",
        amount: round(part.quantity * priced.rate),
        usageAmount: round(part.quantity),
        ...(agg.unit ? { usageUnit: agg.unit } : {}),
      });
    }
  }
  return out;
}

export async function fetchCoreWeaveCostData(
  ctx: CoreWeaveContext,
  rates: NegotiatedRates,
  range: CostFetchRange,
  now: number = Date.now(),
): Promise<CostRow[]> {
  const window = exportWindow(range, now);
  if (!window) return [];
  const location = await fetchFocusRows(ctx, {
    startTime: window.start,
    endTime: window.end,
    groupBy: "location",
  });
  if (location.length === 0) return [];
  // The plan split is an enrichment: without it every row is priced at the
  // flat or list rate and tagged `unattributed`, which is still correct usage.
  const planRows = await fetchFocusRows(ctx, {
    startTime: window.start,
    endTime: window.end,
    groupBy: "capacity_plan",
  }).catch(() => [] as FocusRow[]);
  return buildCostRows(location, planRows, rates);
}

/** Billable GPU-hours of one row, whatever unit its SKU meters in. */
export function gpuHoursOf(row: FocusRow): number {
  const q = quantityOf(row);
  const unit = str(row.PricingUnit).toLowerCase();
  if (unit.startsWith("gpu")) return q;
  if (unit.startsWith("instance")) return q * (instanceSpec(str(row.SkuId))?.gpuCount ?? 0);
  return 0;
}

export interface UsageSummary {
  /** Inclusive first day and exclusive end of the window, ISO. */
  start: string;
  end: string;
  gpuHours: number;
  estimatedUsd: number;
  unpricedSkus: string[];
  bySku: Array<{
    sku: string;
    unit: string;
    quantity: number;
    usd: number;
    pricing: RateSource;
  }>;
  byCluster: Array<{ cluster: string; usd: number; gpuHours: number }>;
  byPlan: Array<{ plan: string; usd: number }>;
}

/** Month-to-date roll-up for the organization detail page. */
export function summarise(
  rows: CostRow[],
  locationRows: FocusRow[],
  window: { start: string; end: string },
): UsageSummary {
  const bySku = new Map<string, UsageSummary["bySku"][number]>();
  const byCluster = new Map<string, { cluster: string; usd: number; gpuHours: number }>();
  const byPlan = new Map<string, number>();
  const unpriced = new Set<string>();
  let total = 0;
  for (const r of rows) {
    const sku = r.tags?.["sku"] ?? "";
    const pricing = (r.tags?.["pricing"] ?? "list") as RateSource;
    if (pricing === "unpriced") unpriced.add(sku);
    const key = `${sku}|${r.usageUnit ?? ""}`;
    const s = bySku.get(key) ?? {
      sku,
      unit: r.usageUnit ?? "",
      quantity: 0,
      usd: 0,
      pricing,
    };
    s.quantity += r.usageAmount ?? 0;
    s.usd += r.amount;
    if (pricing === "negotiated") s.pricing = "negotiated";
    bySku.set(key, s);
    const cluster = r.tags?.["cluster"] || r.resourceId || "Unattributed";
    const c = byCluster.get(cluster) ?? { cluster, usd: 0, gpuHours: 0 };
    c.usd += r.amount;
    byCluster.set(cluster, c);
    const plan = r.tags?.["capacityPlan"] ?? "unattributed";
    byPlan.set(plan, (byPlan.get(plan) ?? 0) + r.amount);
    total += r.amount;
  }
  let gpuHours = 0;
  for (const row of locationRows) {
    const h = gpuHoursOf(row);
    gpuHours += h;
    const cluster = str(row.x_ClusterName) || str(row.x_ClusterId) || "Unattributed";
    const c = byCluster.get(cluster);
    if (c) c.gpuHours += h;
  }
  return {
    start: window.start,
    end: window.end,
    gpuHours: round(gpuHours, 2),
    estimatedUsd: round(total, 2),
    unpricedSkus: [...unpriced].filter(Boolean).sort(),
    bySku: [...bySku.values()].sort((a, b) => b.usd - a.usd || b.quantity - a.quantity),
    byCluster: [...byCluster.values()].sort((a, b) => b.usd - a.usd),
    byPlan: [...byPlan.entries()]
      .map(([plan, usd]) => ({ plan, usd }))
      .sort((a, b) => b.usd - a.usd),
  };
}
