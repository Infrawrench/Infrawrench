/**
 * Actual-spend collection via the Cost Management Query API.
 *
 * Queries `ActualCost` at subscription scope with Daily granularity, grouped
 * by ServiceName + ResourceLocation. The response is columnar
 * (`properties.columns` + `properties.rows`) with no guaranteed column order,
 * so indices are resolved dynamically from the column metadata.
 *
 * The service principal needs the "Cost Management Reader" role on the
 * subscription — the plain "Reader" role used for ARM resource listing is
 * NOT sufficient for cost queries. Azure serves ~13 months of history and
 * rate-limits this API aggressively; a 429 surfaces as a thrown error from
 * the HTTP helper and the host backs off.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { ARM, type AzureHttpContext } from "./shared.js";

const COST_API_VERSION = "2025-03-01";

interface QueryColumn {
  name?: string;
  type?: string;
}

interface QueryResponse {
  properties?: {
    columns?: QueryColumn[];
    rows?: Array<Array<string | number>>;
    /** Full URL (with $skiptoken) for the next page, when more rows exist. */
    nextLink?: string;
  };
}

/** UsageDate arrives as a yyyyMMdd integer (e.g. 20260701) → "2026-07-01". */
function formatUsageDate(raw: string | number | undefined): string {
  const s = String(raw ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // Defensive: some scopes return ISO date-times instead of integers.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

/** ResourceLocation placeholders for global/unattributed spend map to "no region". */
function normalizeRegion(raw: string): string {
  if (!raw || raw === "Unassigned" || raw === "Unknown" || raw === "All Regions") return "";
  return raw;
}

export async function fetchAzureCostData(
  ctx: AzureHttpContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  // Both timePeriod bounds are inclusive, matching the host's range semantics.
  const body = {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: {
      from: `${range.fromDate}T00:00:00+00:00`,
      to: `${range.toDate}T23:59:59+00:00`,
    },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [
        { type: "Dimension", name: "ServiceName" },
        { type: "Dimension", name: "ResourceLocation" },
      ],
    },
  };

  const rows: CostRow[] = [];
  let url: string | undefined =
    `${ARM}/subscriptions/${ctx.subscriptionId}` +
    `/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;

  while (url) {
    const data: QueryResponse = await ctx.post<QueryResponse>(url, body);
    const props = data.properties;
    // 204 No Content (no spend in the window) comes back as {} from the
    // HTTP helper — nothing to parse.
    if (!props) break;

    const columns = props.columns ?? [];
    const costIdx = columns.findIndex((c) => c.name === "Cost" || c.name === "PreTaxCost");
    const dateIdx = columns.findIndex((c) => c.name === "UsageDate");
    const serviceIdx = columns.findIndex((c) => c.name === "ServiceName");
    const regionIdx = columns.findIndex((c) => c.name === "ResourceLocation");
    const currencyIdx = columns.findIndex((c) => c.name === "Currency");
    if ((props.rows?.length ?? 0) > 0 && (costIdx === -1 || dateIdx === -1)) {
      throw new Error(
        `Azure cost query: unexpected column set [${columns.map((c) => c.name).join(", ")}]`,
      );
    }

    for (const row of props.rows ?? []) {
      const amount = Number(row[costIdx] ?? 0);
      if (amount === 0 || Number.isNaN(amount)) continue;
      const date = formatUsageDate(row[dateIdx]);
      if (!date) continue;
      rows.push({
        date,
        service: String(row[serviceIdx] ?? ""),
        region: normalizeRegion(String(row[regionIdx] ?? "")),
        currency: String(row[currencyIdx] ?? "") || "USD",
        amount,
      });
    }

    url = props.nextLink || undefined;
  }

  return rows;
}
