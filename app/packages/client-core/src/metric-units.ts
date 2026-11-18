/**
 * Value formatting for plugin metric series (`MetricSeries.unit`), shared by
 * every surface that draws one: recharts on web/desktop (`MetricChart`),
 * `react-native-svg` on mobile.
 *
 * Byte-valued series (`bytes`, `bytes/s`; the only two unit strings plugin
 * metric definitions emit for byte quantities, per a repo-wide grep of every
 * `unit:` declaration) print raw numbers like "17179869184bytes" that blow
 * out a narrow Y-axis gutter: DigitalOcean droplet memory, filesystem and
 * bandwidth charts. Humanize them into a single binary-scaled unit
 * (KiB/MiB/GiB/TiB/PiB) chosen once from the largest magnitude on the axis,
 * so every tick, the tooltip, and the aria-label summary agree on one scale
 * instead of each picking its own from its own value.
 *
 * Every other unit plugins emit (%, counts, ms, USD, vCPUs, tokens,
 * connections…) keeps its own word, but the number is made readable: a space
 * before a word unit ("150 ms", not "150ms"), none before a symbol ("42%",
 * "3/s", "21°C"), and compact notation once the axis reaches the thousands
 * ("8K count", "10M tokens"), so a long tick neither runs into its unit nor
 * outgrows the Y-axis gutter.
 *
 * The time axis has the same problem the other way round: a chart of daily
 * points labelled "00:00, 00:00, 00:00" says nothing. See
 * `createMetricTimeFormatter`.
 *
 * No React, no chart library: unit-test target.
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
 * (512 GiB); mirrors the rounding `niceAxis` ticks already carry for other
 * units.
 */
function scaledDecimals(scaled: number, exponent: number): number {
  if (exponent === 0) return 0;
  const magnitude = Math.abs(scaled);
  if (magnitude < 10) return 2;
  if (magnitude < 100) return 1;
  return 0;
}

/** From this magnitude on, an axis switches to compact notation ("8K"). */
const COMPACT_FROM = 1000;

/**
 * Whether the unit is a symbol that sits against the number ("42%", "3/s",
 * "21°C") rather than a word that takes a space ("42 connections").
 */
function gluesToNumber(unit: string): boolean {
  return /^[%‰°/]/.test(unit);
}

function numberFormat(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    // A malformed locale tag must not take the chart down with it.
    return new Intl.NumberFormat(undefined, options);
  }
}

function plainUnitFormatter(
  rawUnit: string,
  maxAbsValue: number,
  locale: string | undefined,
): MetricValueFormatter {
  // Some plugins pad their unit themselves (" cores"); the spacing is ours.
  const unit = rawUnit.trim();
  // Chosen once from the axis, like the byte scale: compact ticks on a large
  // axis, full precision on a small one. A large axis's small values ("0",
  // "500") still read correctly in compact notation.
  const compact = Math.abs(maxAbsValue) >= COMPACT_FROM;
  const compactFormat = numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const wholeFormat = numberFormat(locale, { maximumFractionDigits: 2 });
  // Sub-unit readings (0.0042 s of latency) keep their significant digits
  // instead of rounding to "0".
  const smallFormat = numberFormat(locale, { maximumSignificantDigits: 3 });
  const separator = unit === "" || gluesToNumber(unit) ? "" : " ";

  return (value: number) => {
    const magnitude = Math.abs(value);
    const format = compact
      ? compactFormat
      : magnitude > 0 && magnitude < 1
        ? smallFormat
        : wholeFormat;
    return `${format.format(value)}${separator}${unit}`;
  };
}

/**
 * Builds a formatter for one metric axis/series. `maxAbsValue` should be the
 * largest magnitude that will actually be plotted (e.g. the axis domain's
 * top): the byte scale (or, for other units, compact notation) is chosen once
 * from it, then reused for every value passed through the returned formatter,
 * so ticks stay comparable instead of each rescaling independently.
 * `locale` picks the digit grouping and compact suffixes; it defaults to the
 * runtime's.
 */
export function createMetricValueFormatter(
  unit: string,
  maxAbsValue: number,
  locale?: string,
): MetricValueFormatter {
  const suffix = byteRateSuffix(unit);
  if (suffix === null) return plainUnitFormatter(unit, maxAbsValue, locale);

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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Below this span a chart's ticks are times of day; above it they need the
 * date, since the same "14:00" comes round once a day.
 */
const TIME_ONLY_SPAN_MS = 26 * HOUR_MS;

export interface MetricTimeFormatter {
  /** Short label for an X-axis tick. */
  tick: (timestamp: number) => string;
  /** Label for the tooltip: always carries the date. */
  tooltip: (timestamp: number) => string;
  /**
   * The timestamps to label, at most `max` of them: every point when there
   * are few, otherwise every n-th point counted back from the newest, so
   * labels sit evenly apart and the latest point always has one. Left to
   * itself, recharts skips labels by their measured width, and dates of
   * different widths ("Nov 1", "Oct 30") then bunch unevenly along the axis.
   */
  ticks: (max: number) => number[];
}

function dateTimeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): (timestamp: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(locale, options);
  } catch {
    format = new Intl.DateTimeFormat(undefined, options);
  }
  return (timestamp: number) => format.format(new Date(timestamp));
}

/**
 * Builds the X-axis and tooltip formatters for one chart from the timestamps
 * it plots (epoch milliseconds, any order):
 *
 * - a span under about a day reads as times of day ("14:00");
 * - points a day or more apart read as dates ("Nov 18"), in UTC when every
 *   point sits on a UTC midnight, which is how daily buckets arrive, so a
 *   viewer west of Greenwich does not see each day labelled as the one before;
 * - anything else (a week of hourly points) reads as both ("Nov 18, 14:00").
 *
 * Times stay on a 24-hour clock, as these charts have always shown them.
 */
export function createMetricTimeFormatter(
  timestamps: readonly number[],
  locale?: string,
): MetricTimeFormatter {
  const sorted = [...new Set(timestamps.filter(Number.isFinite))].sort((a, b) => a - b);
  const span = sorted.length > 1 ? sorted[sorted.length - 1]! - sorted[0]! : 0;
  let step = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i]! - sorted[i - 1]!);

  const ticks = (max: number) => {
    const every = Math.max(1, Math.ceil(sorted.length / Math.max(1, Math.floor(max))));
    return sorted.filter((_, i) => (sorted.length - 1 - i) % every === 0);
  };

  const date = { month: "short", day: "numeric" } as const;
  const time = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

  if (sorted.length > 1 && step >= DAY_MS) {
    const zone = sorted.every((t) => t % DAY_MS === 0) ? ({ timeZone: "UTC" } as const) : {};
    return {
      tick: dateTimeFormat(locale, { ...date, ...zone }),
      tooltip: dateTimeFormat(locale, { ...date, year: "numeric", ...zone }),
      ticks,
    };
  }
  const withDate = dateTimeFormat(locale, { ...date, ...time });
  return {
    tick: span < TIME_ONLY_SPAN_MS ? dateTimeFormat(locale, time) : withDate,
    tooltip: withDate,
    ticks,
  };
}
