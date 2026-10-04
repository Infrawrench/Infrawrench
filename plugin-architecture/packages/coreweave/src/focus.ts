import type { CoreWeaveContext } from "./api.js";
import { cwFetch } from "./api.js";

/**
 * CoreWeave's FOCUS Billing Export API (`GET /v1/billing/focus`, public
 * preview since 2026-09-11): hourly billable usage in FOCUS 1.2 shape, the
 * same numbers as the Cloud Console's Billing insights page.
 *
 * Facts from https://docs.coreweave.com/billing/focus-export-api (2026-10)
 * that shape this module:
 *
 * - **Quantities only.** No cost fields in this release, so money is derived
 *   (see `cost-data.ts`). Cost columns are planned "on the same schema".
 * - **CKS only** in the preview: GPU, CPU, Storage and Network product
 *   families.
 * - Two mutually exclusive views via `group_by`: `location` (one row per
 *   hour, zone, cluster and SKU; capacity plan is null) and `capacity_plan`
 *   (one row per hour, SKU and plan; cluster and zone are null). For any hour
 *   and SKU the totals agree across views.
 * - At most 90 days per request, data from 2026-01-01 onward, 1,000 rows per
 *   page, `next_page_token` until absent.
 * - A 403 means FOCUS export is not enabled for the organization (Support
 *   enables it), not that the token lacks a role.
 */

export interface FocusRow {
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  PricingQuantity?: number | string | null;
  PricingUnit?: string | null;
  PricingCategory?: string | null;
  ServiceCategory?: string | null;
  ServiceName?: string | null;
  SkuId?: string | null;
  RegionId?: string | null;
  RegionName?: string | null;
  ResourceType?: string | null;
  x_CapacityPlan?: string | null;
  x_ClusterId?: string | null;
  x_ClusterName?: string | null;
  x_ProductFamily?: string | null;
}

interface FocusPage {
  data?: FocusRow[];
  next_page_token?: string | null;
  data_as_of?: string;
}

export type FocusGroupBy = "location" | "capacity_plan";

export interface FocusQuery {
  startTime: string;
  endTime: string;
  groupBy: FocusGroupBy;
  productFamily?: "GPU Compute" | "CPU Compute" | "Storage" | "Network";
  cluster?: string;
}

/** The API's own ceiling on one request's window. */
export const FOCUS_MAX_WINDOW_DAYS = 90;
const PAGE_SIZE = 1000;
/** Hard stop so a cursor that never ends cannot spin forever. */
const MAX_PAGES = 500;
const DAY_MS = 86_400_000;

/** Every row for one window and view, following `next_page_token`. */
export async function fetchFocusRows(ctx: CoreWeaveContext, q: FocusQuery): Promise<FocusRow[]> {
  const out: FocusRow[] = [];
  const windows = splitWindow(q.startTime, q.endTime);
  for (const [start, end] of windows) {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await cwFetch<FocusPage>(ctx, "/v1/billing/focus", {
        query: {
          start_time: start,
          end_time: end,
          group_by: q.groupBy,
          format: "json",
          page_size: PAGE_SIZE,
          ...(q.productFamily ? { product_family: q.productFamily } : {}),
          ...(q.cluster && q.groupBy === "location" ? { cluster: q.cluster } : {}),
          ...(token ? { page_token: token } : {}),
        },
      });
      out.push(...(res?.data ?? []));
      token = res?.next_page_token || undefined;
      if (!token) break;
    }
  }
  return out;
}

/** Split `[start, end)` into windows the API accepts (90 days or less). */
export function splitWindow(startIso: string, endIso: string): Array<[string, string]> {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: Array<[string, string]> = [];
  for (let s = start; s < end; s += FOCUS_MAX_WINDOW_DAYS * DAY_MS) {
    const e = Math.min(end, s + FOCUS_MAX_WINDOW_DAYS * DAY_MS);
    out.push([toApiTime(s), toApiTime(e)]);
  }
  return out;
}

/** ISO 8601 UTC without milliseconds, the form the docs' examples use. */
export function toApiTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function quantityOf(row: FocusRow): number {
  const n =
    typeof row.PricingQuantity === "number" ? row.PricingQuantity : Number(row.PricingQuantity);
  return Number.isFinite(n) ? n : 0;
}

/** The UTC day an hourly bucket starts in. */
export function dayOf(row: FocusRow): string {
  return (row.ChargePeriodStart ?? "").slice(0, 10);
}
