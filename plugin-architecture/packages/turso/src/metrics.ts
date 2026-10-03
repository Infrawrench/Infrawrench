/**
 * Daily usage charts for a Turso database.
 *
 * Turso has no time-series API: `GET .../databases/{db}/usage` takes
 * `from`/`to` and answers one total for the window (rows read and written,
 * storage, bytes synced; verified against the turso-docs OpenAPI spec,
 * October 2026). So the chart asks once per UTC day and plots each answer as
 * that day's point. The spec does not say how finely Turso aggregates, which
 * is why the buckets are whole days rather than hours.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";

/** Without a range from the host, chart the last week. */
export const TURSO_METRICS_CAPABILITY = { defaultTimeRangeMs: 7 * 86_400_000 };

const DAY_MS = 86_400_000;
/** One request per day: a month is the most a single chart asks for. */
const MAX_DAYS = 31;
const CONCURRENCY = 4;

interface UsageTotal {
  rows_read?: number;
  rows_written?: number;
  storage_bytes?: number;
  bytes_synced?: number;
}

const SERIES: Array<{ key: keyof UsageTotal; label: string; unit: string }> = [
  { key: "rows_read", label: "Rows Read", unit: "rows" },
  { key: "rows_written", label: "Rows Written", unit: "rows" },
  { key: "storage_bytes", label: "Storage", unit: "bytes" },
  { key: "bytes_synced", label: "Bytes Synced", unit: "bytes" },
];

/** The UTC day starts covering `[startMs, endMs)`, newest `MAX_DAYS` only. */
export function dayBuckets(startMs: number, endMs: number): number[] {
  const first = Math.floor(startMs / DAY_MS) * DAY_MS;
  const days: number[] = [];
  for (let day = first; day < endMs; day += DAY_MS) days.push(day);
  return days.slice(-MAX_DAYS);
}

export async function fetchDatabaseUsageSeries(
  fetchApi: <T>(path: string) => Promise<T>,
  databasePath: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - TURSO_METRICS_CAPABILITY.defaultTimeRangeMs;
  const days = dayBuckets(startMs, endMs);

  const totals = await mapLimit(days, CONCURRENCY, async (day) => {
    const params = new URLSearchParams({
      from: new Date(day).toISOString(),
      to: new Date(Math.min(day + DAY_MS, endMs)).toISOString(),
    });
    try {
      const data = await fetchApi<{ database?: { total?: UsageTotal } }>(
        `${databasePath}/usage?${params.toString()}`,
      );
      return data.database?.total ?? null;
    } catch {
      // One failed day leaves a gap rather than blanking the whole chart.
      return null;
    }
  });

  const out: MetricSeries[] = [];
  for (const series of SERIES) {
    const points = days.flatMap((day, i) => {
      const value = totals[i]?.[series.key];
      return typeof value === "number" && Number.isFinite(value) ? [{ timestamp: day, value }] : [];
    });
    if (points.length > 0) out.push({ label: series.label, unit: series.unit, points });
  }
  return out;
}

/** `Promise.all` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
