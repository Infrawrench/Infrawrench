import { CostSetupError, type CostFetchRange, type CostRow } from "@infrawrench/plugin-base";
import { isAuthorizationGap, OciApiError, type OciApi } from "./api.js";

/**
 * Billed spend from the OCI Usage API (`POST /20200107/usage`,
 * RequestSummarizedUsages), queryType COST, DAILY granularity.
 *
 * `computedAmount` is the billed amount in the tenancy's billing currency
 * (Oracle's docs: "the computed cost"), after the tenancy's own rate card and
 * discounts. The Usage API allows four `groupBy` keys per request, so the
 * collector makes two passes per chunk:
 *
 * 1. The spend itself, grouped by service, SKU, region and resource OCID.
 *    Every row comes from here, so the total is exactly OCI's.
 * 2. A time-aggregated map of resource OCID → compartment path, which is
 *    stamped onto pass 1's rows as the `compartment` tag. It adds no money,
 *    so it cannot double count; a resource the second pass does not name
 *    simply carries no compartment tag.
 *
 * The SKU name rides as the `sku` tag (it is what separates a shape's OCPU
 * hours from its memory hours inside one service).
 *
 * DAILY queries must start and end at midnight UTC and span at most 90 days;
 * the end is exclusive. Data lags up to 48 hours and is restated, and the
 * Usage API holds twelve months of history.
 */

const MAX_DAYS_PER_QUERY = 90;
const DAY_MS = 86_400_000;

interface UsageSummary {
  timeUsageStarted: string;
  service?: string | null;
  skuName?: string | null;
  region?: string | null;
  resourceId?: string | null;
  compartmentPath?: string | null;
  computedAmount?: number | null;
  computedQuantity?: number | null;
  unit?: string | null;
  currency?: string | null;
  isForecast?: boolean;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Split an inclusive date range into ≤90-day [start, endExclusive) windows. */
export function usageWindows(range: CostFetchRange): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const endExclusive = addDays(range.toDate, 1);
  let start = range.fromDate;
  while (start < endExclusive) {
    const candidate = addDays(start, MAX_DAYS_PER_QUERY);
    const end = candidate < endExclusive ? candidate : endExclusive;
    out.push({ start, end });
    start = end;
  }
  return out;
}

function setupError(err: unknown, tenancy: string): never {
  if (isAuthorizationGap(err)) {
    throw new CostSetupError(
      "This API key's user cannot read cost data. Add an IAM policy such as `Allow group <your-group> to read usage-report in tenancy` for a group the user belongs to.",
      {
        label: "Open IAM policies",
        url: `https://cloud.oracle.com/identity/domains/policies?compartmentId=${encodeURIComponent(tenancy)}`,
      },
    );
  }
  throw err;
}

async function summarize(
  api: OciApi,
  region: string,
  body: Record<string, unknown>,
): Promise<UsageSummary[]> {
  return api.listAll<UsageSummary>(
    {
      service: "usageapi",
      region,
      method: "POST",
      path: "/20200107/usage",
      query: { limit: 1000 },
      body,
    },
    500,
  );
}

export async function fetchOciCostData(
  api: OciApi,
  homeRegion: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const tenantId = api.tenancyOcid;
  const rows = new Map<string, CostRow>();
  for (const window of usageWindows(range)) {
    const base = {
      tenantId,
      timeUsageStarted: `${window.start}T00:00:00Z`,
      timeUsageEnded: `${window.end}T00:00:00Z`,
      granularity: "DAILY",
      queryType: "COST",
    };
    let spend: UsageSummary[];
    try {
      spend = await summarize(api, homeRegion, {
        ...base,
        groupBy: ["service", "skuName", "region", "resourceId"],
      });
    } catch (err) {
      setupError(err, tenantId);
    }
    let compartments = new Map<string, string>();
    try {
      const paths = await summarize(api, homeRegion, {
        ...base,
        isAggregateByTime: true,
        compartmentDepth: 6,
        groupBy: ["resourceId", "compartmentPath"],
      });
      compartments = new Map(
        paths
          .filter((p) => p.resourceId && p.compartmentPath)
          .map((p) => [p.resourceId!, p.compartmentPath!]),
      );
    } catch (err) {
      // Attribution is a nicety; spend already collected stands without it.
      if (!(err instanceof OciApiError)) throw err;
    }
    for (const item of spend) {
      if (item.isForecast) continue;
      if (item.computedAmount === null || item.computedAmount === undefined) continue;
      if (!Number.isFinite(item.computedAmount)) continue;
      const date = item.timeUsageStarted.slice(0, 10);
      const service = item.service || "Other";
      const region = item.region || "";
      const resourceId = item.resourceId || "";
      const sku = item.skuName || "";
      const currency = item.currency || "USD";
      const compartment = resourceId ? compartments.get(resourceId) : undefined;
      const key = [date, service, region, resourceId, sku, currency].join("\u0000");
      const existing = rows.get(key);
      if (existing) {
        existing.amount += item.computedAmount;
        if (item.computedQuantity && existing.usageAmount !== undefined) {
          existing.usageAmount += item.computedQuantity;
        }
        continue;
      }
      const tags: Record<string, string> = {};
      if (sku) tags["sku"] = sku;
      if (compartment) tags["compartment"] = compartment;
      rows.set(key, {
        date,
        service,
        ...(region ? { region } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(Object.keys(tags).length ? { tags } : {}),
        currency,
        amount: item.computedAmount,
        ...(item.computedQuantity !== null && item.computedQuantity !== undefined
          ? { usageAmount: item.computedQuantity }
          : {}),
        ...(item.unit ? { usageUnit: item.unit } : {}),
      });
    }
  }
  return [...rows.values()].filter((r) => r.date >= range.fromDate && r.date <= range.toDate);
}

/**
 * Month-to-date spend plus OCI's own month-end forecast, for the tenancy
 * detail view. The forecast is OCI's (BASIC exponential smoothing), never
 * ours, and is omitted when OCI declines to forecast (under ten days of
 * history).
 */
export async function monthToDateWithForecast(
  api: OciApi,
  homeRegion: string,
  now = new Date(),
): Promise<{ currency: string; spent: number; forecast?: number }> {
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
  const tomorrow = addDays(today, 1);
  const body: Record<string, unknown> = {
    tenantId: api.tenancyOcid,
    timeUsageStarted: `${monthStart}T00:00:00Z`,
    timeUsageEnded: `${tomorrow}T00:00:00Z`,
    granularity: "DAILY",
    queryType: "COST",
  };
  if (tomorrow < next) {
    body["forecast"] = {
      forecastType: "BASIC",
      timeForecastStarted: `${tomorrow}T00:00:00Z`,
      timeForecastEnded: `${next}T00:00:00Z`,
    };
  }
  let items: UsageSummary[];
  try {
    items = await summarize(api, homeRegion, body);
  } catch (err) {
    if (body["forecast"] && err instanceof OciApiError && err.status === 400) {
      delete body["forecast"];
      items = await summarize(api, homeRegion, body);
    } else {
      throw err;
    }
  }
  let spent = 0;
  let forecastExtra = 0;
  let sawForecast = false;
  let currency = "USD";
  for (const i of items) {
    if (i.currency) currency = i.currency;
    const amount = i.computedAmount ?? 0;
    if (i.isForecast) {
      sawForecast = true;
      forecastExtra += amount;
    } else spent += amount;
  }
  return { currency, spent, ...(sawForecast ? { forecast: spent + forecastExtra } : {}) };
}
