import type { MetricSeries } from "@infrawrench/plugin-base";
import type { Details } from "./mappers.js";

/**
 * The management API keeps short sample histories and returns them when a
 * request names an age and an increment (`msg_rates_age`/`msg_rates_incr`,
 * `lengths_age`/`lengths_incr`, `node_stats_age`/`node_stats_incr`). The
 * default retention policies keep 5 s samples for 10 minutes, 1 minute for an
 * hour, 10 minutes for 8 hours and 30 minutes for a day, so the window is
 * capped at a day and the increment picked from those granularities.
 */
export const MAX_WINDOW_S = 86_400;
export const DEFAULT_WINDOW_MS = 3_600_000;

export function sampleQuery(
  range: { startMs: number; endMs: number } | undefined,
  kinds: Array<"msg_rates" | "lengths" | "node_stats" | "data_rates">,
): Record<string, number> {
  const ageMs =
    range && range.endMs > range.startMs ? Date.now() - range.startMs : DEFAULT_WINDOW_MS;
  const age = Math.min(MAX_WINDOW_S, Math.max(60, Math.round(ageMs / 1000)));
  const incr = age <= 600 ? 5 : age <= 3600 ? 60 : age <= 28_800 ? 600 : 1800;
  const out: Record<string, number> = {};
  for (const k of kinds) {
    out[`${k}_age`] = age;
    out[`${k}_incr`] = incr;
  }
  return out;
}

function points(d: Details | undefined): Array<{ timestamp: number; value: number }> {
  return (d?.samples ?? [])
    .filter((s) => typeof s.timestamp === "number" && typeof s.sample === "number")
    .map((s) => ({ timestamp: s.timestamp!, value: s.sample! }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** A gauge (queue depth, memory used): samples are the values. */
export function gauge(label: string, unit: string, d: Details | undefined): MetricSeries | null {
  const p = points(d);
  return p.length ? { label, unit, points: p } : null;
}

/**
 * A counter (messages published, acked): samples are running totals, so the
 * rate is the difference between neighbouring samples over their gap. A drop
 * (counter reset after a restart) is skipped rather than charted as negative.
 */
export function counterRate(
  label: string,
  d: Details | undefined,
  unit = "msg/s",
): MetricSeries | null {
  const p = points(d);
  const out: Array<{ timestamp: number; value: number }> = [];
  for (let i = 1; i < p.length; i++) {
    const dt = (p[i]!.timestamp - p[i - 1]!.timestamp) / 1000;
    const dv = p[i]!.value - p[i - 1]!.value;
    if (dt > 0 && dv >= 0) out.push({ timestamp: p[i]!.timestamp, value: dv / dt });
  }
  return out.length ? { label, unit, points: out } : null;
}

export function compact(series: Array<MetricSeries | null>): MetricSeries[] {
  return series.filter((s): s is MetricSeries => s !== null);
}

/** A single reading when the server returned no samples (stats collection off). */
export function snapshot(
  label: string,
  unit: string,
  value: number | undefined,
): MetricSeries | null {
  return typeof value === "number"
    ? { label, unit, points: [{ timestamp: Date.now(), value }] }
    : null;
}
