/**
 * Actual-spend collection via the ClickHouse Cloud usageCost API.
 *
 * `GET /v1/organizations/{organizationId}/usageCost?from_date=..&to_date=..`
 * returns daily, per-entity (data warehouse / service / ClickPipe) cost
 * records broken down by metric (compute, storage, backup, data transfer,
 * …). Both dates are inclusive and `to_date` may be at most 30 days after
 * `from_date` — the host's month-aligned ≤31-day chunks fit that exactly.
 *
 * Amounts are ClickHouse Credits (CHC) converted at the $1-per-CHC list
 * price. Organizations on committed-spend contracts buy credits at a
 * discount, so reported USD is list price, not the negotiated rate.
 *
 * Uses the same Cloud API key (HTTP Basic auth) as service listing — no
 * extra permissions beyond organization billing read access.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

/** Minimal slice of the client context needed for cost collection. */
export interface CostContext {
  cloudApi<T>(method: string, path: string): Promise<T>;
  organizationId: string;
}

interface UsageCostRecord {
  date?: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  /** Per-category CHC amounts, e.g. { computeCHC: 1.2, storageCHC: 0.4 }. */
  metrics?: Record<string, number | null>;
  totalCHC?: number;
}

interface UsageCostResponse {
  result?: {
    grandTotalCHC?: number;
    costs?: UsageCostRecord[];
  };
}

/** Known metric keys → human cost-category labels. */
const METRIC_LABELS: Record<string, string> = {
  computeCHC: "Compute",
  storageCHC: "Storage",
  backupCHC: "Backup",
  dataTransferCHC: "Data Transfer",
  publicDataTransferCHC: "Public Data Transfer",
  interRegionTier1DataTransferCHC: "Inter-Region Data Transfer (Tier 1)",
  interRegionTier2DataTransferCHC: "Inter-Region Data Transfer (Tier 2)",
  interRegionTier3DataTransferCHC: "Inter-Region Data Transfer (Tier 3)",
  interRegionTier4DataTransferCHC: "Inter-Region Data Transfer (Tier 4)",
  initialLoadCHC: "Initial Load",
  clickpipesCHC: "ClickPipes",
};

/** Fallback for metric keys added after this list: "fooBarCHC" → "Foo Bar". */
function metricLabel(key: string): string {
  const known = METRIC_LABELS[key];
  if (known) return known;
  const words = key
    .replace(/CHC$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function fetchClickHouseCostData(
  ctx: CostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const path =
    `/v1/organizations/${ctx.organizationId}/usageCost` +
    `?from_date=${range.fromDate}&to_date=${range.toDate}`;
  const data = await ctx.cloudApi<UsageCostResponse>("GET", path);

  const rows: CostRow[] = [];
  for (const record of data.result?.costs ?? []) {
    const date = record.date;
    if (!date) continue;
    // entityId (a stable UUID) keys the resource dimension — entityName is
    // user-renamable and would break same-day dedup on rename.
    const resourceId = record.entityId ?? "";
    for (const [key, value] of Object.entries(record.metrics ?? {})) {
      const amount = Number(value ?? 0);
      if (amount === 0 || Number.isNaN(amount)) continue;
      rows.push({
        date,
        service: metricLabel(key),
        resourceId,
        // 1 CHC = $1 list price (see module comment).
        currency: "USD",
        amount,
      });
    }
  }
  return rows;
}
