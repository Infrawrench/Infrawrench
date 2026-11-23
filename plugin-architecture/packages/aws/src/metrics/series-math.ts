import type { MetricSeries } from "@infrawrench/plugin-base";

/**
 * Join two series on their timestamps and derive one value per shared
 * timestamp. A derived point is dropped when `derive` returns null or a
 * non-finite number, so a series built from a missing input is empty rather
 * than zero.
 */
export function combineSeries(
  a: MetricSeries | null,
  b: MetricSeries | null,
  derive: (a: number, b: number) => number | null,
): Array<{ timestamp: number; value: number }> {
  if (!a || !b) return [];
  const byTime = new Map(b.points.map((p) => [p.timestamp, p.value]));
  const out: Array<{ timestamp: number; value: number }> = [];
  for (const p of a.points) {
    const other = byTime.get(p.timestamp);
    if (other === undefined) continue;
    const value = derive(p.value, other);
    if (value !== null && Number.isFinite(value)) out.push({ timestamp: p.timestamp, value });
  }
  return out;
}

/**
 * Map each point of a series, dropping points the mapper turns into null or
 * a non-finite number.
 */
export function mapSeriesPoints(
  series: MetricSeries | null,
  map: (value: number) => number | null,
): Array<{ timestamp: number; value: number }> {
  if (!series) return [];
  const out: Array<{ timestamp: number; value: number }> = [];
  for (const p of series.points) {
    const value = map(p.value);
    if (value !== null && Number.isFinite(value)) out.push({ timestamp: p.timestamp, value });
  }
  return out;
}
