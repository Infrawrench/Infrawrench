/**
 * Value formatting for plugin metric series (`MetricSeries.unit`), shared by
 * every surface that draws one: recharts on web/desktop (`MetricChart`),
 * `react-native-svg` on mobile.
 *
 * Byte-valued series (`bytes`, `bytes/s` — the only two unit strings plugin
 * metric definitions emit for byte quantities, per a repo-wide grep of every
 * `unit:` declaration) print raw numbers like "17179869184bytes" that blow
 * out a narrow Y-axis gutter: DigitalOcean droplet memory, filesystem and
 * bandwidth charts. Humanize them into a single binary-scaled unit —
 * KiB/MiB/GiB/TiB/PiB — chosen once from the largest magnitude on the axis,
 * so every tick, the tooltip, and the aria-label summary agree on one scale
 * instead of each picking its own from its own value.
 *
 * Every other unit plugins emit (%, counts, ms, USD, vCPUs, tokens,
 * connections…) is already short and is left as `${value}${unit}`, matching
 * the formatting these charts used before this module existed.
 *
 * No React, no chart library — unit-test target.
 */

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export type MetricValueFormatter = (value: number) => string;

/** Unit strings plugin metric definitions use for byte-quantity series. */
function byteRateSuffix(unit: string): string | null {
  if (unit === "bytes") return "";
  if (unit === "bytes/s") return "/s";
  return null;
}

/**
 * Picks how many decimals read well at a given magnitude: more precision for
 * small scaled values (0.42 GiB), none once the number is already wide
 * (512 GiB) — mirrors the rounding `niceAxis` ticks already carry for other
 * units.
 */
function scaledDecimals(scaled: number, exponent: number): number {
  if (exponent === 0) return 0;
  const magnitude = Math.abs(scaled);
  if (magnitude < 10) return 2;
  if (magnitude < 100) return 1;
  return 0;
}

/**
 * Builds a formatter for one metric axis/series. `maxAbsValue` should be the
 * largest magnitude that will actually be plotted (e.g. the axis domain's
 * top) — the byte scale is chosen once from it, then reused for every value
 * passed through the returned formatter, so ticks stay comparable instead of
 * each rescaling independently.
 */
export function createMetricValueFormatter(
  unit: string,
  maxAbsValue: number,
): MetricValueFormatter {
  const suffix = byteRateSuffix(unit);
  if (suffix === null) {
    return (value: number) => (unit ? `${value}${unit}` : String(value));
  }

  const magnitude = Math.abs(maxAbsValue);
  const exponent =
    magnitude < 1024
      ? 0
      : Math.min(Math.floor(Math.log(magnitude) / Math.log(1024)), BINARY_UNITS.length - 1);
  const divisor = 1024 ** exponent;
  const label = `${BINARY_UNITS[exponent]}${suffix}`;

  return (value: number) => {
    const scaled = value / divisor;
    const decimals = scaledDecimals(scaled, exponent);
    return `${scaled.toFixed(decimals)} ${label}`;
  };
}
