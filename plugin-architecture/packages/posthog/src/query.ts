import type { MetricSeries } from "@infrawrench/plugin-base";
import type { PostHogContext } from "./api.js";
import { PostHogApiError, phFetch } from "./api.js";

/**
 * HogQL through `POST /api/projects/{project_id}/query/` with
 * `{ query: { kind: "HogQLQuery", query } }` (scope `query:read`), answering
 * `{ columns, results: [[...], ...] }`.
 */
export const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

interface HogQLResponse {
  columns?: string[];
  results?: unknown[][];
  error?: string | null;
}

export async function runHogQL(
  ctx: PostHogContext,
  projectId: string,
  query: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const res = await phFetch<HogQLResponse>(
    ctx,
    `/api/projects/${encodeURIComponent(projectId)}/query/`,
    {
      method: "POST",
      body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "infrawrench" }),
    },
  );
  if (res?.error) throw new PostHogApiError(400, `HogQL error: ${res.error}`);
  return { columns: res?.columns ?? [], rows: res?.results ?? [] };
}

/** A HogQL string literal. */
export function hogqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Hourly buckets up to a week, daily beyond. */
export function bucketFor(windowMs: number): "toStartOfHour" | "toStartOfDay" {
  return windowMs <= 7 * 24 * 3600_000 ? "toStartOfHour" : "toStartOfDay";
}

export async function eventSeries(
  ctx: PostHogContext,
  projectId: string,
  range: { startMs: number; endMs: number },
  label: string,
  extraWhere = "",
): Promise<MetricSeries[]> {
  const bucket = bucketFor(range.endMs - range.startMs);
  const query = [
    `SELECT ${bucket}(timestamp) AS t, count() AS c FROM events`,
    `WHERE timestamp >= fromUnixTimestamp(${Math.floor(range.startMs / 1000)})`,
    `AND timestamp < fromUnixTimestamp(${Math.floor(range.endMs / 1000)})`,
    extraWhere ? `AND ${extraWhere}` : "",
    "GROUP BY t ORDER BY t",
  ]
    .filter(Boolean)
    .join(" ");
  const { rows } = await runHogQL(ctx, projectId, query);
  const points = rows
    .map((r) => ({ timestamp: Date.parse(String(r[0])), value: Number(r[1]) }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
  return [{ label, unit: "count", points }];
}

export function rangeOrDefault(
  range: { startMs: number; endMs: number } | undefined,
  windowMs = METRICS_WINDOW_MS,
): { startMs: number; endMs: number } {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}
