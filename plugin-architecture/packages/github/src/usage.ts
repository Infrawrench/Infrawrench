/**
 * The enhanced billing platform's usage endpoints (GitHub REST API
 * description `api.github.com` / `ghec`, verified 2026-10):
 *
 * - `GET {billing}/usage?year&month[&day][&cost_center_id]`: dated line items
 *   (`date`, `product`, `sku`, `quantity`, `unitType`, `pricePerUnit`,
 *   `grossAmount`, `discountAmount`, `netAmount`, `organizationName`,
 *   `repositoryName`). For an enterprise it returns usage **without** a cost
 *   centre by default and one cost centre's usage with `cost_center_id`, so
 *   the default call plus one call per cost centre partitions the bill.
 * - `GET {billing}/usage/summary`: one month's totals by product and SKU, with
 *   gross, discount and net quantities and amounts. For an enterprise the
 *   default covers every cost centre.
 * - `GET {billing}/premium_request/usage`: premium requests by model.
 * - `GET {billing}/ai_credit/usage`: AI credits by model, the unit that
 *   replaced premium requests for Copilot from June 2026.
 *
 * `{billing}` is `/organizations/{org}/settings/billing` or
 * `/enterprises/{enterprise}/settings/billing` (see `billingBase`).
 */

import type { GitHubContext } from "./api.js";
import { billingBase, ghFetch } from "./api.js";

export interface UsageItem {
  date?: string;
  product?: string;
  sku?: string;
  quantity?: number;
  unitType?: string;
  pricePerUnit?: number;
  grossAmount?: number;
  discountAmount?: number;
  netAmount?: number;
  organizationName?: string;
  repositoryName?: string;
}

export interface SummaryItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  pricePerUnit?: number;
  grossQuantity?: number;
  grossAmount?: number;
  discountQuantity?: number;
  discountAmount?: number;
  netQuantity?: number;
  netAmount?: number;
}

export interface CostCenter {
  id?: string;
  name?: string;
  state?: string;
  azure_subscription?: string | null;
  ai_credit_pool_enabled?: boolean;
  ai_credit_pool_state?: { target_amount?: number | null; current_amount?: number | null };
  resources?: Array<{ type?: string; name?: string }>;
}

export interface YearMonth {
  year: number;
  month: number;
}

/** Every calendar month (UTC) the inclusive date range touches, oldest first. */
export function monthsBetween(fromDate: string, toDate: string): YearMonth[] {
  const [fy, fm] = fromDate.split("-").map(Number) as [number, number];
  const [ty, tm] = toDate.split("-").map(Number) as [number, number];
  const out: YearMonth[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (out.length > 60) break;
  }
  return out;
}

export function currentYearMonth(now = new Date()): YearMonth {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** `2025-10-01T00:00:00Z` and `2025-10-01` both become `2025-10-01`. */
export function isoDay(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1] : undefined;
}

export async function fetchUsageItems(
  ctx: GitHubContext,
  ym: YearMonth,
  costCenterId?: string,
): Promise<UsageItem[]> {
  const res = await ghFetch<{ usageItems?: UsageItem[] }>(ctx, `${billingBase(ctx.owner)}/usage`, {
    query: {
      year: ym.year,
      month: ym.month,
      ...(costCenterId && ctx.owner.kind === "enterprise" ? { cost_center_id: costCenterId } : {}),
    },
  });
  return res.usageItems ?? [];
}

export async function fetchUsageSummary(
  ctx: GitHubContext,
  ym: YearMonth,
  filter: { product?: string; sku?: string; repository?: string; costCenterId?: string } = {},
): Promise<SummaryItem[]> {
  const res = await ghFetch<{ usageItems?: SummaryItem[] }>(
    ctx,
    `${billingBase(ctx.owner)}/usage/summary`,
    {
      query: {
        year: ym.year,
        month: ym.month,
        product: filter.product,
        sku: filter.sku,
        repository: filter.repository,
        ...(filter.costCenterId && ctx.owner.kind === "enterprise"
          ? { cost_center_id: filter.costCenterId }
          : {}),
      },
    },
  );
  return res.usageItems ?? [];
}

export async function fetchModelUsage(
  ctx: GitHubContext,
  kind: "premium_request" | "ai_credit",
  ym: YearMonth,
): Promise<SummaryItem[]> {
  const res = await ghFetch<{ usageItems?: SummaryItem[] }>(
    ctx,
    `${billingBase(ctx.owner)}/${kind}/usage`,
    { query: { year: ym.year, month: ym.month } },
  );
  return res.usageItems ?? [];
}

/** Enterprise cost centres (active only). Organizations have none. */
export async function fetchCostCenters(ctx: GitHubContext): Promise<CostCenter[]> {
  if (ctx.owner.kind !== "enterprise") return [];
  const res = await ghFetch<{ costCenters?: CostCenter[] }>(
    ctx,
    `${billingBase(ctx.owner)}/cost-centers`,
    { query: { state: "active" } },
  );
  return (res.costCenters ?? []).filter((c) => c.id && c.state !== "deleted");
}

/** One month of dated line items, each tagged with the cost centre it belongs to. */
export interface TaggedUsageItem extends UsageItem {
  costCenter?: string;
  costCenterId?: string;
}

/**
 * A month's line items across the whole bill. For an organization that is a
 * single call; for an enterprise it is the default call (usage outside any
 * cost centre) plus one per cost centre, which together partition the bill.
 */
export async function fetchMonthItems(
  ctx: GitHubContext,
  ym: YearMonth,
  costCenters?: CostCenter[],
): Promise<TaggedUsageItem[]> {
  const base = await fetchUsageItems(ctx, ym);
  if (ctx.owner.kind !== "enterprise") return base;
  const centers = costCenters ?? (await fetchCostCenters(ctx).catch(() => []));
  const out: TaggedUsageItem[] = [...base];
  for (const c of centers) {
    const items = await fetchUsageItems(ctx, ym, c.id);
    for (const item of items) {
      out.push({ ...item, ...(c.name ? { costCenter: c.name } : {}), costCenterId: c.id! });
    }
  }
  return out;
}

export interface SummaryTotals {
  gross: number;
  discount: number;
  net: number;
}

export function sumItems(items: Array<SummaryItem | UsageItem>): SummaryTotals {
  let gross = 0;
  let discount = 0;
  let net = 0;
  for (const i of items) {
    gross += i.grossAmount ?? 0;
    discount += i.discountAmount ?? 0;
    net += i.netAmount ?? 0;
  }
  return { gross: round2(gross), discount: round2(discount), net: round2(net) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
