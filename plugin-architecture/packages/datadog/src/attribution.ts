/**
 * Cost attribution by tag, from `GET /api/v2/cost_by_tag/monthly_cost_attribution`.
 *
 * Verified against Datadog's published OpenAPI document (operation
 * `GetMonthlyCostAttribution`, schema `MonthlyCostAttributionAttributes`) and
 * https://docs.datadoghq.com/api/latest/usage-metering/ (2026-10):
 *
 * - Monthly only, finalised by the 19th of the following month, parent orgs
 *   only, and not offered on US1-FED.
 * - Costs are broken down by the tag keys the organization configured for
 *   usage attribution in Datadog (Plan & Usage, up to three keys). Nobody
 *   should have to know or type those keys, so the first request asks for the
 *   totals with no breakdown, reads the configured keys out of
 *   `tag_config_source` (documented format
 *   `<source_org_name>:::<tag 1>///<tag 2>///<tag 3>`), and only then asks
 *   for the breakdown by exactly those keys.
 * - `values` maps `<billing_dimension>_<on_demand|committed|total>_cost` and
 *   `<billing_dimension>_percentage_in_<org|account>` to numbers. Only the
 *   `_total_cost` fields are summed: the other two cost fields are its parts.
 * - Pagination is a `next_record_id` cursor. Datadog's own pseudo code sleeps
 *   between pages to stay under the rate limit; a detail view cannot wait that
 *   long, so the view reads a bounded number of pages and says when it
 *   stopped early.
 *
 * Attribution is shown on the organization page rather than collected into
 * the cost store. The daily product rows already account for every dollar,
 * and the same dollars split a second way by tag would double the total of
 * any report that did not filter one of the two out.
 */

import type { DatadogContext } from "./api.js";
import { ddFetch } from "./api.js";
import { productLabel } from "./products.js";

interface DdAttributionEntry {
  attributes?: {
    month?: string;
    org_name?: string;
    public_id?: string;
    tag_config_source?: string;
    tags?: Record<string, string[] | null> | null;
    values?: Record<string, number | null> | null;
  };
}

interface DdAttributionResponse {
  data?: DdAttributionEntry[];
  meta?: { pagination?: { next_record_id?: string | null } };
}

export interface CostAttributionRow {
  orgName: string;
  /** "team:web, service:api"; "(untagged)" when the usage carried no value. */
  tags: string;
  totalCost: number;
  /** Product with the largest share of this row's cost. */
  topProduct: string;
}

export interface CostAttributionReport {
  /** `YYYY-MM` of the month reported. */
  month: string;
  /** Tag keys the organization configured for attribution. */
  tagKeys: string[];
  rows: CostAttributionRow[];
  /** True when the page budget ran out before the cursor did. */
  truncated: boolean;
}

const MAX_PAGES = 5;

/** Parse `<source_org_name>:::<tag 1>///<tag 2>///<tag 3>` into tag keys. */
export function parseTagConfigSource(raw: string | undefined): string[] {
  if (!raw) return [];
  const sep = raw.indexOf(":::");
  const list = sep >= 0 ? raw.slice(sep + 3) : raw;
  return [
    ...new Set(
      list
        .split("///")
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The latest month Datadog has finalised attribution for: the previous month
 * from the 19th on, the one before it until then.
 */
export function latestAttributionMonth(now: number): string {
  const d = new Date(now);
  const back = d.getUTCDate() >= 19 ? 1 : 2;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1))
    .toISOString()
    .slice(0, 7);
}

function describeTags(tags: Record<string, string[] | null> | null | undefined): string {
  if (!tags) return "";
  const parts: string[] = [];
  for (const [key, values] of Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))) {
    const vals = (values ?? []).filter(Boolean);
    parts.push(vals.length > 0 ? `${key}:${vals.join("|")}` : `${key}:(untagged)`);
  }
  return parts.join(", ");
}

function summarise(values: Record<string, number | null> | null | undefined): {
  total: number;
  top: string;
} {
  let total = 0;
  let top = "";
  let topValue = -Infinity;
  for (const [field, value] of Object.entries(values ?? {})) {
    if (!field.endsWith("_total_cost") || typeof value !== "number") continue;
    total += value;
    if (value > topValue) {
      topValue = value;
      top = field.slice(0, -"_total_cost".length);
    }
  }
  return { total: Math.round(total * 100) / 100, top: top ? productLabel(top) : "" };
}

async function page(
  ctx: DatadogContext,
  month: string,
  tagKeys: string[],
  cursor?: string,
): Promise<DdAttributionResponse> {
  return ddFetch<DdAttributionResponse>(ctx, "/api/v2/cost_by_tag/monthly_cost_attribution", {
    query: {
      start_month: month,
      end_month: month,
      fields: "*",
      ...(tagKeys.length > 0 ? { tag_breakdown_keys: tagKeys.join(",") } : {}),
      ...(cursor ? { next_record_id: cursor } : {}),
    },
  });
}

export async function fetchCostAttribution(
  ctx: DatadogContext,
  now: number = Date.now(),
): Promise<CostAttributionReport> {
  const month = latestAttributionMonth(now);
  const probe = await page(ctx, month, []);
  const tagKeys = parseTagConfigSource(
    (probe.data ?? []).map((e) => e.attributes?.tag_config_source).find(Boolean),
  );

  const entries: DdAttributionEntry[] = [];
  let truncated = false;
  if (tagKeys.length === 0) {
    entries.push(...(probe.data ?? []));
  } else {
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await page(ctx, month, tagKeys, cursor);
      entries.push(...(res.data ?? []));
      cursor = res.meta?.pagination?.next_record_id ?? undefined;
      if (!cursor) break;
      if (i === MAX_PAGES - 1) truncated = true;
    }
  }

  const rows = entries
    .map((e): CostAttributionRow => {
      const a = e.attributes ?? {};
      const { total, top } = summarise(a.values);
      return {
        orgName: a.org_name ?? "",
        tags: describeTags(a.tags) || "(all usage)",
        totalCost: total,
        topProduct: top,
      };
    })
    .filter((r) => r.totalCost !== 0)
    .sort((a, b) => b.totalCost - a.totalCost);

  return { month, tagKeys, rows, truncated };
}
