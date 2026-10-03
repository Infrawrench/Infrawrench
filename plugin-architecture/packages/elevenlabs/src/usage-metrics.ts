/**
 * Per-voice and per-model usage charts from the workspace analytics warehouse.
 *
 * `POST /v1/workspace/analytics/query/usage-by-product-over-time` (operationId
 * `usage_by_product_over_time` in https://api.elevenlabs.io/openapi.json,
 * verified October 2026) is the same endpoint `cost-data.ts` prices spend
 * from. Its `group_by` enum includes `voice_id` and `model`, so one
 * query grouped by either dimension returns every voice's (or model's) daily
 * rows and the detail view keeps only the rows for the one being viewed.
 * Grouping rather than filtering is deliberate: `group_by` values are an
 * enum in the spec, while `filters[].column` is a free string whose valid
 * names are not documented.
 *
 * The response is a generic table (`columns`, `column_types`, `column_units`,
 * `rows`) and the spec does not enumerate the measure columns, so every
 * numeric column becomes a series, labelled from its name and unit. Nothing
 * here assumes a column name beyond the time column and the grouping key.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";

export const USAGE_QUERY_PATH = "/v1/workspace/analytics/query/usage-by-product-over-time";

const DAY_MS = 86_400_000;
/** The endpoint rejects anything before 2020-01-01. */
const MIN_START_MS = Date.UTC(2020, 0, 1);

export type UsageGroup = "voice_id" | "model";

export interface UsageQueryResponse {
  columns?: string[];
  column_types?: string[];
  column_units?: Array<string | null>;
  rows?: unknown[][];
}

/** Request body for one daily, UTC-aligned query grouped by `group`. */
export function usageQueryBody(
  group: UsageGroup,
  range: { startMs: number; endMs: number },
): Record<string, unknown> {
  return {
    start_time: Math.max(MIN_START_MS, Math.floor(range.startMs / DAY_MS) * DAY_MS),
    end_time: Math.max(MIN_START_MS, range.endMs),
    interval_seconds: 86_400,
    group_by: [group],
    time_zone: "UTC",
  };
}

/** Units from the spec's `ColumnUnit` enum, mapped onto chart units. */
const UNIT_LABELS: Record<string, string> = {
  ms: "ms",
  s: "seconds",
  min: "minutes",
  duration: "seconds",
  credits: "credits",
  usd: "USD",
  eur: "EUR",
  inr: "INR",
  pln: "PLN",
  gbp: "GBP",
  ratio: "ratio",
  rating: "rating",
};

const TIME_COLUMN_NAMES = ["time", "timestamp", "bucket", "bucket_start", "start_time", "date"];
const NUMERIC_TYPES = new Set(["Float", "Int"]);

/**
 * Turn a grouped usage table into one series per numeric column, keeping only
 * rows whose grouping column equals `key`. Returns `[]` when the table has no
 * recognisable time or grouping column, so schema drift degrades to an empty
 * chart rather than a wrong one. All-zero series are dropped.
 */
export function usageSeriesFor(
  body: UsageQueryResponse,
  group: UsageGroup,
  key: string,
): MetricSeries[] {
  const columns = body.columns ?? [];
  const types = body.column_types ?? [];
  const units = body.column_units ?? [];
  let timeIdx = types.findIndex((type) => type === "DateTime");
  if (timeIdx < 0) timeIdx = columns.findIndex((c) => TIME_COLUMN_NAMES.includes(c.toLowerCase()));
  const groupIdx = columns.findIndex((c) => c.toLowerCase() === group);
  if (timeIdx < 0 || groupIdx < 0) return [];

  const measures = columns
    .map((name, idx) => ({ name, idx }))
    .filter(
      ({ idx }) => idx !== timeIdx && idx !== groupIdx && NUMERIC_TYPES.has(types[idx] ?? ""),
    );

  const byStamp = new Map<number, number[]>();
  for (const row of body.rows ?? []) {
    if (String(row[groupIdx] ?? "") !== key) continue;
    const stamp = parseStamp(row[timeIdx]);
    if (stamp === undefined) continue;
    const acc = byStamp.get(stamp) ?? measures.map(() => 0);
    measures.forEach(({ idx }, i) => {
      const value = Number(row[idx]);
      if (Number.isFinite(value)) acc[i]! += value;
    });
    byStamp.set(stamp, acc);
  }

  const stamps = [...byStamp.keys()].sort((a, b) => a - b);
  const series: MetricSeries[] = [];
  measures.forEach(({ name, idx }, i) => {
    const points = stamps.map((timestamp) => ({
      timestamp,
      value: Number(byStamp.get(timestamp)![i]!.toFixed(4)),
    }));
    if (!points.some((p) => p.value !== 0)) return;
    const unitRaw = units[idx];
    const unit = typeof unitRaw === "string" ? UNIT_LABELS[unitRaw.toLowerCase()] : undefined;
    series.push({ label: humanise(name), ...(unit ? { unit } : {}), points });
  });
  return series;
}

/** `tts_characters` → `Tts characters`; `credits` → `Credits`. */
function humanise(column: string): string {
  const words = column.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : column;
}

/**
 * DateTime cells arrive as ISO strings, possibly zone-less (UTC), or as epoch
 * numbers in seconds or milliseconds.
 */
function parseStamp(cell: unknown): number | undefined {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return cell < 1e12 ? cell * 1000 : cell;
  }
  if (typeof cell !== "string" || cell === "") return undefined;
  const iso = cell.includes("T") ? cell : cell.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : undefined;
}
