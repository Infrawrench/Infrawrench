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

import type { ApiBody, ApiResponse, NoSlashString } from "@infrawrench/plugin-base";
import { pathEncode } from "@infrawrench/plugin-base";
import type { operations as DotcomOps } from "./api-types.dotcom.gen.js";
import type { operations as GhecOps } from "./api-types.ghec.gen.js";
import type { GitHubContext, Sparse } from "./api.js";
import { billingBase, byOwner, ghecApi, listOrNothing, statusOf } from "./api.js";

type Row<Answer> = Answer extends { usageItems?: readonly (infer Item)[] } ? Item : never;

export type UsageItem = Sparse<
  | Row<ApiResponse<DotcomOps["billing/get-github-billing-usage-report-org"]>>
  | Row<ApiResponse<GhecOps["billing/get-github-billing-usage-report-ghe"]>>
>;

/** The bill's summary rows, and the per-model rows of premium requests and AI credits. */
export type SummaryItem = Sparse<
  | Row<ApiResponse<DotcomOps["billing/get-github-billing-usage-summary-report-org"]>>
  | Row<ApiResponse<GhecOps["billing/get-github-billing-usage-summary-report-ghe"]>>
  | Row<ApiResponse<DotcomOps["billing/get-github-billing-premium-request-usage-report-org"]>>
  | Row<ApiResponse<GhecOps["billing/get-github-billing-premium-request-usage-report-ghe"]>>
> & { model?: string };

export type CostCenter = Sparse<ApiResponse<GhecOps["billing/get-cost-center"]>>;

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
  const query = { year: ym.year, month: ym.month };
  const res = await byOwner(ctx, {
    org: (api, org) => api.get(`/organizations/${org}/settings/billing/usage`, { query }),
    enterprise: (api, enterprise) =>
      api.get(`/enterprises/${enterprise}/settings/billing/usage`, {
        query: { ...query, ...(costCenterId ? { cost_center_id: costCenterId } : {}) },
      }),
  });
  const path = `${billingBase(ctx.owner)}/usage`;
  return [...listOrNothing<UsageItem>(res, res.usageItems, { path, key: "usageItems" })];
}

export async function fetchUsageSummary(
  ctx: GitHubContext,
  ym: YearMonth,
  filter: { product?: string; sku?: string; repository?: string; costCenterId?: string } = {},
): Promise<SummaryItem[]> {
  // An empty filter is no filter, rather than `?product=`.
  const query = {
    year: ym.year,
    month: ym.month,
    ...(filter.product ? { product: filter.product } : {}),
    ...(filter.sku ? { sku: filter.sku } : {}),
    ...(filter.repository ? { repository: filter.repository } : {}),
  };
  const res = await byOwner(ctx, {
    org: (api, org) => api.get(`/organizations/${org}/settings/billing/usage/summary`, { query }),
    enterprise: (api, enterprise) =>
      api.get(`/enterprises/${enterprise}/settings/billing/usage/summary`, {
        query: {
          ...query,
          ...(filter.costCenterId ? { cost_center_id: filter.costCenterId } : {}),
        },
      }),
  });
  return res.usageItems ?? [];
}

export async function fetchModelUsage(
  ctx: GitHubContext,
  kind: "premium_request" | "ai_credit",
  ym: YearMonth,
): Promise<SummaryItem[]> {
  const query = { year: ym.year, month: ym.month };
  const res = await byOwner(ctx, {
    org: (api, org) =>
      kind === "premium_request"
        ? api.get(`/organizations/${org}/settings/billing/premium_request/usage`, { query })
        : api.get(`/organizations/${org}/settings/billing/ai_credit/usage`, { query }),
    enterprise: (api, enterprise) =>
      kind === "premium_request"
        ? api.get(`/enterprises/${enterprise}/settings/billing/premium_request/usage`, { query })
        : api.get(`/enterprises/${enterprise}/settings/billing/ai_credit/usage`, { query }),
  });
  return res.usageItems ?? [];
}

/** Enterprise cost centres (active only). Organizations have none. */
export async function fetchCostCenters(ctx: GitHubContext): Promise<CostCenter[]> {
  if (ctx.owner.kind !== "enterprise") return [];
  const enterprise = pathEncode(ctx.owner.slug);
  const res = await ghecApi(ctx).get(`/enterprises/${enterprise}/settings/billing/cost-centers`, {
    query: { state: "active" },
  });
  const path = `/enterprises/${enterprise}/settings/billing/cost-centers`;
  return listOrNothing<CostCenter>(res, res.costCenters, { path, key: "costCenters" }).filter(
    (c) => c.id && c.state !== "deleted",
  );
}

/**
 * The cost centres a bill is split over. Usage under one is only read by asking for
 * that one, so a failed read must not pass for having none: only a 404 can mean that.
 */
export async function billedCostCenters(load: Promise<CostCenter[]>): Promise<CostCenter[]> {
  try {
    return await load;
  } catch (err) {
    if (statusOf(err) === 404) return [];
    throw err;
  }
}

/**
 * The enterprise whose cost centres these are. Neither of GitHub's documents has a
 * cost centre route for an organization, so a write there is refused rather than sent.
 */
export function costCenterEnterprise(ctx: GitHubContext): NoSlashString {
  if (ctx.owner.kind !== "enterprise") {
    throw new Error(
      "Cost centres only exist on GitHub enterprises. Connect the enterprise that owns this organization to manage them.",
    );
  }
  return pathEncode(ctx.owner.slug);
}

export type CostCenterMembers = ApiBody<GhecOps["billing/add-resource-to-cost-center"]>;

export async function createCostCenter(
  ctx: GitHubContext,
  body: ApiBody<GhecOps["billing/create-cost-center"]>,
): Promise<CostCenter> {
  const enterprise = costCenterEnterprise(ctx);
  return ghecApi(ctx).post(`/enterprises/${enterprise}/settings/billing/cost-centers`, { body });
}

export async function getCostCenter(ctx: GitHubContext, id: string): Promise<CostCenter> {
  const enterprise = costCenterEnterprise(ctx);
  const center = pathEncode(id);
  return ghecApi(ctx).get(`/enterprises/${enterprise}/settings/billing/cost-centers/${center}`);
}

export async function updateCostCenter(
  ctx: GitHubContext,
  id: string,
  body: ApiBody<GhecOps["billing/update-cost-center"]>,
): Promise<void> {
  const enterprise = costCenterEnterprise(ctx);
  const center = pathEncode(id);
  await ghecApi(ctx).patch(`/enterprises/${enterprise}/settings/billing/cost-centers/${center}`, {
    body,
  });
}

export async function deleteCostCenter(ctx: GitHubContext, id: string): Promise<void> {
  const enterprise = costCenterEnterprise(ctx);
  const center = pathEncode(id);
  await ghecApi(ctx).delete(`/enterprises/${enterprise}/settings/billing/cost-centers/${center}`);
}

export async function addCostCenterMembers(
  ctx: GitHubContext,
  id: string,
  body: CostCenterMembers,
): Promise<void> {
  const enterprise = costCenterEnterprise(ctx);
  const center = pathEncode(id);
  await ghecApi(ctx).post(
    `/enterprises/${enterprise}/settings/billing/cost-centers/${center}/resource`,
    { body },
  );
}

export async function removeCostCenterMembers(
  ctx: GitHubContext,
  id: string,
  body: CostCenterMembers,
): Promise<void> {
  const enterprise = costCenterEnterprise(ctx);
  const center = pathEncode(id);
  await ghecApi(ctx).delete(
    `/enterprises/${enterprise}/settings/billing/cost-centers/${center}/resource`,
    { body },
  );
}

/** One month of dated line items, each tagged with the cost centre it belongs to. */
export type TaggedUsageItem = UsageItem & {
  costCenter?: string;
  costCenterId?: string;
};

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
  const centers = costCenters ?? (await billedCostCenters(fetchCostCenters(ctx)));
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
