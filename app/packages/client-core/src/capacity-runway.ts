/**
 * Capacity runway: the shared pure half.
 *
 * The wire contract for `/api/org/:orgId/quotas/runway`, the bounds the
 * settings form and the API both enforce, and the forecasting arithmetic:
 * a robust trend fitted over a resource's recorded usage, projected to the
 * moment it reaches its limit, or, for a monthly allowance, to what it will
 * reach by the end of the billing cycle.
 *
 * It lives here rather than in server-core for the quota radar's reason: the
 * poller alerts on the same projection the page draws and the CLI prints, and
 * two implementations of "runs out in nine days" is two chances to disagree.
 *
 * Honesty rules the arithmetic keeps:
 *
 * - **Robust, not least-squares.** The slope is Theil-Sen (the median of
 *   every pairwise slope), so one reading taken mid-migration or one cleanup
 *   that freed half a disk moves the projection by one vote, not by its size.
 * - **Short is not safe.** Under {@link RUNWAY_MIN_POINTS} readings, or a
 *   history spanning less than {@link RUNWAY_MIN_SPAN_DAYS}, there is no
 *   projection and the row says so.
 * - **Noisy is said out loud.** When the change the trend explains over the
 *   window is smaller than the scatter around it, the projection is still
 *   shown but flagged, and it never pages anybody on its own.
 */

/** How far back the runway fit looks, in days. */
export const RUNWAY_WINDOW_DAYS = 14;

/** Fewest readings a runway trend may be drawn through. */
export const RUNWAY_MIN_POINTS = 3;

/**
 * Shortest history, in days, a runway trend may be drawn through. A day of
 * hourly readings holds a daily cycle's peak and trough once; less than that
 * and the slope is the time of day.
 */
export const RUNWAY_MIN_SPAN_DAYS = 1;

/** Furthest ahead a crossing date is reported; beyond it the row says "over a year". */
export const RUNWAY_HORIZON_DAYS = 365;

/** Most points the pairwise fit considers; longer series are thinned evenly. */
const RUNWAY_MAX_FIT_POINTS = 240;

/** Bounds the API enforces on the tunable numbers, shared with the form. */
export const RUNWAY_ALERT_LIMITS = {
  /** Alert when a resource will reach its limit within this many days. */
  runwayDays: { min: 1, max: 90 },
  /**
   * Alert when a monthly allowance is at this fraction, or is projected past
   * its whole allowance before the cycle resets. The quota threshold's range.
   */
  allowanceThreshold: { min: 0.5, max: 0.99 },
} as const;

export const DEFAULT_RUNWAY_DAYS = 14;
export const DEFAULT_ALLOWANCE_THRESHOLD = 0.8;

/** Where a row sits. Ordered, most urgent first. */
export type RunwayStatus =
  /** Usage is at or over its limit now. */
  | "full"
  /**
   * Alerting: runs out within the org's runway days on a clean trend, or a
   * monthly allowance is over the threshold or projected past its limit
   * before the cycle resets.
   */
  | "critical"
  /** Inside the runway days, but the trend is too noisy to page on. */
  | "watch"
  | "ok";

export const RUNWAY_STATUSES: readonly RunwayStatus[] = ["full", "critical", "watch", "ok"];

export const RUNWAY_STATUS_LABELS: Record<RunwayStatus, string> = {
  full: "At the limit",
  critical: "Running out",
  watch: "Noisy trend",
  ok: "Healthy",
};

/** How much to trust a projection. */
export type RunwayConfidence =
  /** Enough readings, and the trend stands clear of the scatter. */
  | "ok"
  /** Enough readings, but the scatter is as large as the trend. */
  | "noisy"
  /** Too few readings, or too short a history, for any projection. */
  | "short";

/** What produced the rate. */
export type RunwayMethod =
  /** Theil-Sen over the recorded readings. */
  | "trend"
  /**
   * A monthly allowance without enough readings this cycle for a trend: the
   * average rate since the cycle started (the counter was zero at the start,
   * so `used / elapsed` is a rate, not a guess).
   */
  | "cycle-average";

/** Where the limit came from, so the reader knows whose number it is. */
export type RunwayLimitSource = "provider" | "plan" | "constant";

/** One recorded reading. */
export interface RunwayPoint {
  /** ISO instant the provider value was read (the resource's sync time). */
  observedAt: string;
  used: number;
  /** The limit at the time, so a resize does not rewrite history. */
  limit: number;
}

export interface RunwayForecast {
  /** Change in usage per day, in the row's unit; null without a rate. */
  perDay: number | null;
  /**
   * Days until usage reaches the limit at that rate. Null when the rate is
   * flat or falling, when the row is already full, when the crossing lies
   * beyond {@link RUNWAY_HORIZON_DAYS}, or (for an allowance) when the cycle
   * resets first.
   */
  daysLeft: number | null;
  /** The crossing as an ISO instant, when `daysLeft` is set. */
  fullAt: string | null;
  method: RunwayMethod | null;
  confidence: RunwayConfidence;
  /** Readings the fit used. Shown, so a thin trend reads as thin. */
  points: number;
}

/** The billing cycle of a monthly allowance. */
export interface RunwayCycle {
  /** ISO start of the current cycle. */
  start: string;
  /** ISO end of the current cycle (the next reset). */
  end: string;
  /** Usage projected at `end` at the current rate; null without a rate. */
  projectedUsed: number | null;
  /** `projectedUsed / limit`; null without a rate. */
  projectedUtilization: number | null;
}

/** One usage on one resource, as the API returns it. */
export interface RunwayRow {
  /** Stable identity within the resource: the field key or `metric:<label>`. */
  key: string;
  resourceId: string;
  resourceName: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  /** What runs out ("Storage", "Compute hours"). */
  label: string;
  /** What both numbers count; `bytes` renders as binary sizes. */
  unit: string | null;
  used: number;
  limit: number;
  utilization: number;
  limitSource: RunwayLimitSource;
  /** The plan the allowance was looked up by, when `limitSource` is `plan`. */
  plan: string | null;
  /** `allowance` resets monthly; `runway` accumulates until it hits the limit. */
  kind: "runway" | "allowance";
  /** Where the value is read: a synced field or output, or a stored metric series. */
  source: "field" | "output" | "metric";
  /** ISO instant of the reading `used` comes from. */
  observedAt: string;
  forecast: RunwayForecast;
  /** The billing cycle, for allowances; null for runway rows. */
  cycle: RunwayCycle | null;
  status: RunwayStatus;
}

export interface RunwayListResponse {
  /** Every declared usage with a reading, soonest to run out first. */
  rows: RunwayRow[];
  /** The org's runway alert threshold in days, so the page and the alert agree. */
  runwayDays: number;
  /** The org's allowance alert threshold, as a fraction. */
  allowanceThreshold: number;
  /** How far back the trend looks, in days. */
  windowDays: number;
}

/** A row on the resource detail page, with the history the chart draws. */
export interface ResourceRunwayRow extends RunwayRow {
  history: RunwayPoint[];
}

export interface ResourceRunwayResponse {
  rows: ResourceRunwayRow[];
  runwayDays: number;
  allowanceThreshold: number;
  windowDays: number;
}

// --- The fit ---

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Thin a series evenly to at most `max` points, always keeping both ends. */
function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

export interface RobustFit {
  /** Units per day. */
  slope: number;
  /** Value at day 0 of the input's time base. */
  intercept: number;
  confidence: Exclude<RunwayConfidence, "short">;
  points: number;
}

/**
 * Theil-Sen fit of value against time (in days). Null when the series is too
 * short to support a slope (see {@link RUNWAY_MIN_POINTS} and
 * {@link RUNWAY_MIN_SPAN_DAYS}).
 *
 * Noise test: the change the slope explains across the span, against the
 * scatter around the line (the residuals' median absolute deviation, scaled
 * to a standard deviation). A trend that moves less than three of those
 * across the whole window is indistinguishable from wobble, and is flagged
 * `noisy` rather than dropped: the reader still sees where it points.
 */
export function fitRobustTrend(points: ReadonlyArray<{ t: number; v: number }>): RobustFit | null {
  const usable = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (usable.length < RUNWAY_MIN_POINTS) return null;
  const sorted = [...usable].sort((a, b) => a.t - b.t);
  const span = sorted[sorted.length - 1]!.t - sorted[0]!.t;
  if (span < RUNWAY_MIN_SPAN_DAYS) return null;

  const fitPoints = thin(sorted, RUNWAY_MAX_FIT_POINTS);
  const slopes: number[] = [];
  for (let i = 0; i < fitPoints.length; i++) {
    for (let j = i + 1; j < fitPoints.length; j++) {
      const dt = fitPoints[j]!.t - fitPoints[i]!.t;
      if (dt <= 0) continue;
      slopes.push((fitPoints[j]!.v - fitPoints[i]!.v) / dt);
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  const intercept = median(fitPoints.map((p) => p.v - slope * p.t));
  const residuals = fitPoints.map((p) => Math.abs(p.v - (intercept + slope * p.t)));
  const scatter = 1.4826 * median(residuals);
  const explained = Math.abs(slope) * span;
  const confidence = scatter > 0 && explained < 3 * scatter ? "noisy" : "ok";
  return { slope, intercept, confidence, points: usable.length };
}

function toDayPoints(history: ReadonlyArray<RunwayPoint>): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  for (const p of history) {
    const t = Date.parse(p.observedAt);
    if (!Number.isFinite(t) || !Number.isFinite(p.used)) continue;
    out.push({ t: t / DAY_MS, v: p.used });
  }
  return out;
}

/**
 * Project an accumulating usage (a disk, a database's size) to its limit.
 *
 * `used` and `limit` are the current reading's, not the fit line's: the row
 * shows those numbers, and a projection from a different number than the one
 * on screen reads as arithmetic nobody can follow.
 */
export function forecastRunway(
  history: ReadonlyArray<RunwayPoint>,
  used: number,
  limit: number,
  now: Date,
): RunwayForecast {
  const fit = fitRobustTrend(toDayPoints(history));
  if (!fit) {
    return {
      perDay: null,
      daysLeft: null,
      fullAt: null,
      method: null,
      confidence: "short",
      points: history.length,
    };
  }
  const base = {
    perDay: fit.slope,
    method: "trend" as const,
    confidence: fit.confidence,
    points: fit.points,
  };
  if (fit.slope <= 0 || used >= limit) return { ...base, daysLeft: null, fullAt: null };
  const days = (limit - used) / fit.slope;
  if (!Number.isFinite(days) || days > RUNWAY_HORIZON_DAYS) {
    return { ...base, daysLeft: null, fullAt: null };
  }
  return {
    ...base,
    daysLeft: days,
    fullAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
  };
}

// --- Billing cycles ---

function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Parse a stored cycle boundary: ISO 8601, a date-only string, or a unix
 * epoch in seconds or milliseconds (number or numeric string). Null when it
 * is none of those.
 */
export function parseCycleInstant(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (Number.isFinite(numeric)) {
    // Seconds until the year 33658; anything larger is milliseconds.
    const ms = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * The current monthly cycle. A provider-reported start wins (billing cycles
 * anchor on the subscription date); without one, the cycle starts on
 * `anchorDay` of the month, UTC. A reported start that has already been left
 * behind by more than a month is rolled forward, because a stale field is
 * still the anchor, just not this cycle's.
 */
export function currentCycle(
  now: Date,
  options: { start?: Date | null; end?: Date | null; anchorDay?: number },
): { start: Date; end: Date } {
  let start = options.start ?? null;
  if (start && start.getTime() <= now.getTime()) {
    let end =
      options.end && options.end.getTime() > start.getTime() ? options.end : addMonthsUtc(start, 1);
    let guard = 0;
    while (end.getTime() <= now.getTime() && guard++ < 240) {
      start = end;
      end = addMonthsUtc(start, 1);
    }
    return { start, end };
  }
  // Only the reset is reported (the next one, usually): the cycle is the
  // month before it.
  const end = options.end ?? null;
  if (end && end.getTime() > now.getTime()) {
    let cycleEnd = end;
    let cycleStart = addMonthsUtc(cycleEnd, -1);
    let guard = 0;
    while (cycleStart.getTime() > now.getTime() && guard++ < 240) {
      cycleEnd = cycleStart;
      cycleStart = addMonthsUtc(cycleEnd, -1);
    }
    return { start: cycleStart, end: cycleEnd };
  }
  const anchor = Math.min(28, Math.max(1, Math.round(options.anchorDay ?? 1)));
  let candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), anchor));
  if (candidate.getTime() > now.getTime()) candidate = addMonthsUtc(candidate, -1);
  return { start: candidate, end: addMonthsUtc(candidate, 1) };
}

/**
 * Project a monthly allowance to the end of its cycle.
 *
 * Only readings inside the current cycle count: last cycle's counter climbed
 * from zero too, and fitting across the reset would draw a sawtooth's average
 * slope. With too few readings this cycle the rate is `used / elapsed`, which
 * is honest for a counter that started the cycle at zero, and is marked as
 * such (`cycle-average`).
 */
export function forecastAllowance(
  history: ReadonlyArray<RunwayPoint>,
  used: number,
  limit: number,
  cycle: { start: Date; end: Date },
  now: Date,
): { forecast: RunwayForecast; cycle: RunwayCycle } {
  const startMs = cycle.start.getTime();
  const inCycle = history.filter((p) => Date.parse(p.observedAt) >= startMs);
  const fit = fitRobustTrend(toDayPoints(inCycle));
  const elapsedDays = (now.getTime() - startMs) / DAY_MS;
  const remainingDays = Math.max(0, (cycle.end.getTime() - now.getTime()) / DAY_MS);

  let perDay: number | null = null;
  let method: RunwayMethod | null = null;
  let confidence: RunwayConfidence = "short";
  if (fit) {
    perDay = Math.max(0, fit.slope);
    method = "trend";
    confidence = fit.confidence;
  } else if (elapsedDays >= RUNWAY_MIN_SPAN_DAYS && used >= 0) {
    perDay = used / elapsedDays;
    method = "cycle-average";
    confidence = "ok";
  }

  const projectedUsed = perDay === null ? null : used + perDay * remainingDays;
  let daysLeft: number | null = null;
  if (perDay !== null && perDay > 0 && used < limit) {
    const days = (limit - used) / perDay;
    // A crossing after the reset is no crossing: the counter starts again.
    if (Number.isFinite(days) && days <= remainingDays) daysLeft = days;
  }
  return {
    forecast: {
      perDay,
      daysLeft,
      fullAt: daysLeft === null ? null : new Date(now.getTime() + daysLeft * DAY_MS).toISOString(),
      method,
      confidence,
      points: inCycle.length,
    },
    cycle: {
      start: cycle.start.toISOString(),
      end: cycle.end.toISOString(),
      projectedUsed,
      projectedUtilization: projectedUsed === null ? null : projectedUsed / limit,
    },
  };
}

// --- Buckets and order ---

/**
 * Bucket a row. Full beats critical beats watch: a disk at its limit is also
 * inside any runway window, and the mildest true thing about it is the least
 * useful summary.
 */
export function runwayStatus(
  row: Pick<RunwayRow, "kind" | "used" | "limit" | "forecast" | "cycle">,
  settings: { runwayDays: number; allowanceThreshold: number },
): RunwayStatus {
  if (row.used >= row.limit) return "full";
  if (row.kind === "allowance") {
    if (row.used >= settings.allowanceThreshold * row.limit) return "critical";
    const projected = row.cycle?.projectedUsed ?? null;
    if (projected !== null && projected >= row.limit) {
      return row.forecast.confidence === "noisy" ? "watch" : "critical";
    }
    return "ok";
  }
  const days = row.forecast.daysLeft;
  if (days === null || days > settings.runwayDays) return "ok";
  return row.forecast.confidence === "ok" ? "critical" : "watch";
}

/** Rows that warrant an alert. `watch` never pages: its trend is noise-sized. */
export function alertableRunway(rows: RunwayRow[]): RunwayRow[] {
  return rows.filter((r) => r.status === "full" || r.status === "critical");
}

/**
 * Soonest to run out first: full rows (zero days), then by days left, then
 * rows with no crossing by how full they are (projected end-of-cycle for an
 * allowance), then a stable tie-break.
 */
export function sortRunwayRows<T extends RunwayRow>(rows: T[]): T[] {
  const daysOf = (r: RunwayRow) =>
    r.status === "full" ? 0 : (r.forecast.daysLeft ?? Number.POSITIVE_INFINITY);
  const fullness = (r: RunwayRow) => r.cycle?.projectedUtilization ?? r.utilization;
  return [...rows].sort((a, b) => {
    const ad = daysOf(a);
    const bd = daysOf(b);
    if (ad !== bd) return ad - bd;
    const af = fullness(a);
    const bf = fullness(b);
    if (af !== bf) return bf - af;
    return `${a.resourceId}:${a.key}`.localeCompare(`${b.resourceId}:${b.key}`);
  });
}

// --- Formatting ---

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** `12.4 GiB` for bytes, `1,024 connections` otherwise: the unit is printed verbatim. */
export function formatRunwayAmount(value: number, unit: string | null | undefined): string {
  if (!Number.isFinite(value)) return "n/a";
  if (unit === "bytes") {
    let v = Math.abs(value);
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = v >= 100 || i === 0 ? 0 : 1;
    return `${value < 0 ? "-" : ""}${v.toFixed(digits)} ${BYTE_UNITS[i]}`;
  }
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  const num = rounded.toLocaleString("en-US");
  if (!unit) return num;
  return unit === "%" ? `${num}%` : `${num} ${unit}`;
}

/**
 * The countdown, coarsening as it grows: "in 9 days" implies a precision a
 * fortnight of readings can support; "in 7 months" is the honest rendering of
 * the same estimate further out.
 */
export function formatRunwayDays(days: number): string {
  if (days < 1) return "in under a day";
  if (days < 14) {
    const whole = Math.round(days);
    return `in ${whole} day${whole === 1 ? "" : "s"}`;
  }
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return `in ${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  const months = Math.round(days / 30);
  return `in ${months} month${months === 1 ? "" : "s"}`;
}
