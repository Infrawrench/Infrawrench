/**
 * Volume metrics from the Usage Records API's `Daily` subresource. Twilio has
 * no hourly usage series, so every chart here is one point per UTC day.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { TwilioContext } from "./api.js";
import { accountPath, list2010 } from "./api.js";
import type { TwUsageRecord } from "./mappers.js";
import { num } from "./mappers.js";

export const METRICS_WINDOW_MS = 30 * 24 * 3600_000;

export function rangeOrDefault(timeRange: { startMs: number; endMs: number } | undefined): {
  startMs: number;
  endMs: number;
} {
  if (timeRange) return timeRange;
  const endMs = Date.now();
  return { startMs: endMs - METRICS_WINDOW_MS, endMs };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What each chart reads: category, which record field, label, unit. */
const VOLUME_SERIES: Array<{
  category: string;
  field: "count" | "usage" | "price";
  label: string;
  unit?: string;
}> = [
  { category: "sms-outbound", field: "count", label: "SMS sent", unit: "messages" },
  { category: "sms-inbound", field: "count", label: "SMS received", unit: "messages" },
  { category: "mms", field: "count", label: "MMS messages", unit: "messages" },
  { category: "calls", field: "count", label: "Calls", unit: "calls" },
  { category: "calls", field: "usage", label: "Call minutes", unit: "minutes" },
  { category: "totalprice", field: "price", label: "Spend" },
];

/**
 * Daily message, call and spend series for one account. `includeSubaccounts`
 * is true for the main account (its totals include every subaccount, as on
 * Twilio's own usage page) and false for a single subaccount.
 */
export async function usageSeries(
  ctx: TwilioContext,
  accountSid: string,
  includeSubaccounts: boolean,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const categories = [...new Set(VOLUME_SERIES.map((s) => s.category))];
  const fetched = new Map<string, TwUsageRecord[]>();
  await Promise.all(
    categories.map(async (category) => {
      const records = await list2010<TwUsageRecord>(
        ctx,
        `${accountPath(accountSid)}/Usage/Records/Daily.json`,
        "usage_records",
        {
          Category: category,
          StartDate: day(range.startMs),
          EndDate: day(range.endMs),
          IncludeSubaccounts: includeSubaccounts,
        },
      );
      fetched.set(category, records);
    }),
  );
  const out: MetricSeries[] = [];
  for (const spec of VOLUME_SERIES) {
    const records = fetched.get(spec.category) ?? [];
    const points = records
      .filter((r) => r.start_date)
      .map((r) => ({
        timestamp: Date.parse(`${r.start_date}T00:00:00Z`),
        value: num(spec.field === "price" ? r.price : r[spec.field]) ?? 0,
      }))
      .filter((p) => Number.isFinite(p.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (points.length === 0 || points.every((p) => p.value === 0)) continue;
    const unit =
      spec.field === "price"
        ? (records.find((r) => r.price_unit)?.price_unit ?? "usd").toUpperCase()
        : spec.unit;
    out.push({ label: spec.label, ...(unit ? { unit } : {}), points });
  }
  return out;
}
