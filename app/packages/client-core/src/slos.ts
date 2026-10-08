/**
 * Service-level objectives and error budgets.
 *
 * An SLO is a target ("99.9% of probe checks succeed") over a rolling window
 * (7, 28 or 30 days), measured from data Infrawrench already records: the
 * synthetic probes' "Up" and "Latency" series, or any metric series a synced
 * resource reports. Nothing new is measured; an SLO is a way of reading the
 * metric store.
 *
 * This module is the shared pure half every surface uses: the wire contract
 * for `/api/org/:orgId/slos`, the input limits the editors and the API both
 * enforce, the burn-rate arithmetic the poller alerts on and the detail page
 * draws, and the Bearer fetch helpers mobile and the CLI call. Keeping the
 * arithmetic here is the quotas stance: the poller pages on the same numbers
 * the page shows, so the two cannot disagree in front of somebody deciding
 * whether to freeze deploys.
 *
 * ## Events
 *
 * Every SLI is computed over **minutes with data** from the 1m metric rollup.
 * A minute is one event; how good it was depends on the SLI kind:
 *
 * - `probe_availability`: the minute's average of the 0/1 "Up" series, so a
 *   minute with one failed check out of two counts half good.
 * - `probe_latency`: good when the minute's average "Latency" is at or under
 *   the threshold. Failed checks record their latency too (usually the
 *   timeout), so an outage burns a latency budget as well.
 * - `metric_threshold`: good when the minute's average satisfies the
 *   comparator ("CPU % < 80").
 *
 * Minutes with no data are not events at all, in either direction: a probe
 * that was paused has not been down, and has not been up either.
 *
 * ## Burn-rate alerting
 *
 * The multiwindow, multi-burn-rate policy from the Google SRE workbook
 * ("Alerting on SLOs", table 5-8): page when 2% of the budget burns in an hour
 * or 5% in six hours, open a ticket when 10% burns in three days, each paired
 * with a short window 1/12 of the long one so the alert stops soon after the
 * burning does. The thresholds are expressed as *budget fractions* and turned
 * into burn rates per SLO window (`burnRate = fraction × period / window`),
 * which reproduces the workbook's 14.4 / 6 / 1 for a 30-day window and scales
 * correctly for 7 and 28 days.
 */
import type { CloudFetch } from "./fetch";

export type SloSliKind = "probe_availability" | "probe_latency" | "metric_threshold";

export const SLO_SLI_KINDS: readonly SloSliKind[] = [
  "probe_availability",
  "probe_latency",
  "metric_threshold",
];

export type SloComparator = "<" | "<=" | ">" | ">=";

export const SLO_COMPARATORS: readonly SloComparator[] = ["<", "<=", ">", ">="];

export const SLO_WINDOW_DAYS = [7, 28, 30] as const;
export type SloWindowDays = (typeof SLO_WINDOW_DAYS)[number];

/**
 * What an SLO is doing right now, worst first:
 *
 * - `exhausted`: the budget for the window is spent (remaining ≤ 0).
 * - `fast_burn`: a page-severity burn-rate pair is firing.
 * - `slow_burn`: the ticket-severity pair is firing.
 * - `ok`: measured and none of the above.
 * - `unknown`: no data in the window (or the SLO has never been evaluated).
 *   Never rendered as healthy: no evidence is not good evidence.
 */
export type SloStatus = "exhausted" | "fast_burn" | "slow_burn" | "ok" | "unknown";

/** The alert level the poller last settled on; the notification claim column. */
export type SloBurnAlert = "none" | "slow" | "fast";

export const SLO_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 500,
  /** Below half, "objective" stops meaning anything. */
  minTargetPercent: 50,
  /** Five nines over 7 days is 6 seconds of budget; more is not measurable per minute. */
  maxTargetPercent: 99.999,
  minLatencyThresholdMs: 1,
  /** Mirrors the probe timeout ceiling: nothing can be slower than that. */
  maxLatencyThresholdMs: 60_000,
  maxMetricKeyLength: 200,
  /** A governance rail, not a product tier. */
  maxPerOrg: 200,
} as const;

export const SLO_DEFAULTS = {
  targetPercent: 99.9,
  windowDays: 30 as SloWindowDays,
  latencyThresholdMs: 500,
  comparator: "<" as SloComparator,
  alertsEnabled: true,
  suggestFreeze: true,
} as const;

/** The windows burn rates are reported for. */
export type SloBurnWindow = "5m" | "30m" | "1h" | "6h" | "3d";

export const SLO_BURN_WINDOW_MINUTES: Readonly<Record<SloBurnWindow, number>> = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "6h": 360,
  "3d": 4320,
};

export const SLO_BURN_WINDOWS: readonly SloBurnWindow[] = ["5m", "30m", "1h", "6h", "3d"];

export interface SloBurnPolicy {
  id: "fast" | "sustained" | "slow";
  /** `page` maps to the `fast` alert level, `ticket` to `slow`. */
  severity: "page" | "ticket";
  longWindow: SloBurnWindow;
  shortWindow: SloBurnWindow;
  /** Share of the whole window's budget that burning at the threshold consumes in the long window. */
  budgetFraction: number;
}

/** SRE workbook table 5-8, as budget fractions. */
export const SLO_BURN_POLICIES: readonly SloBurnPolicy[] = [
  { id: "fast", severity: "page", longWindow: "1h", shortWindow: "5m", budgetFraction: 0.02 },
  { id: "sustained", severity: "page", longWindow: "6h", shortWindow: "30m", budgetFraction: 0.05 },
  { id: "slow", severity: "ticket", longWindow: "3d", shortWindow: "6h", budgetFraction: 0.1 },
];

/** Burn rate per window; null where the window held no events. */
export type SloBurnRates = Partial<Record<SloBurnWindow, number | null>>;

/** Where the SLI comes from. Fields not used by the kind are null. */
export interface SloSourceFields {
  sliKind: SloSliKind;
  /** `probe_*`: the synthetic probe row. */
  probeId: string | null;
  /** `probe_latency`: a check is good at or under this many milliseconds. */
  latencyThresholdMs: number | null;
  /** `metric_threshold`: the synced resource (`resources.id`) reporting the series. */
  resourceId: string | null;
  /** `metric_threshold`: the series label, e.g. "CPU %". */
  metricKey: string | null;
  /** `metric_threshold`: a minute is good when `value <comparator> threshold`. */
  comparator: SloComparator | null;
  threshold: number | null;
}

/** Body of `POST /api/org/:orgId/slos` and `PUT .../:id`. */
export interface SloInput extends SloSourceFields {
  name: string;
  description: string | null;
  /** Percentage, e.g. 99.9. */
  targetPercent: number;
  windowDays: SloWindowDays;
  /** Route burn-rate alerts through the org's alert routing rules. */
  alertsEnabled: boolean;
  /** When the budget is spent, say so and suggest a change freeze. */
  suggestFreeze: boolean;
  enabled: boolean;
}

/** Wire shape of an SLO as every read endpoint returns it. */
export interface Slo extends SloInput {
  id: string;
  /** Display labels for the source, resolved on read; null when it is gone. */
  probeName: string | null;
  resourceName: string | null;
  accountId: string | null;
  pluginId: string | null;
  resourceTypeId: string | null;
  status: SloStatus;
  /** Fraction of good events over the window (0–1); null with no data. */
  sli: number | null;
  goodEvents: number;
  totalEvents: number;
  /** Fraction of the window's budget left; negative when overspent; null with no data. */
  budgetRemaining: number | null;
  /** The whole window's budget, in minutes of total badness (43.2 for 99.9% over 30 days). */
  budgetTotalMinutes: number;
  /** `budgetRemaining` in the same unit; negative when overspent. */
  budgetRemainingMinutes: number | null;
  burnRates: SloBurnRates;
  burnAlert: SloBurnAlert;
  /** When the budget last ran out; null while some remains. */
  exhaustedAt: string | null;
  lastEvalAt: string | null;
  /** Why the last evaluation said nothing (metric store down, source deleted). */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SloListResponse {
  slos: Slo[];
}

/** One hour of the window: how many minute-events, and how much of them was good. */
export interface SloBucket {
  startMs: number;
  good: number;
  total: number;
}

/** A change freeze in effect, as the detail view's freeze suggestion needs it. */
export interface SloActiveFreeze {
  id: string;
  name: string;
  endsAt: string | null;
}

/** `GET /slos/:id`: the SLO plus its hourly buckets over the window. */
export interface SloDetailResponse {
  slo: Slo;
  buckets: SloBucket[];
  activeFreeze: SloActiveFreeze | null;
}

export interface SloProbeOption {
  id: string;
  name: string;
  url: string;
  status: "up" | "down" | "unknown";
}

export interface SloMetricResourceOption {
  resourceId: string;
  displayName: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  series: Array<{ label: string; unit: string }>;
}

/** `GET /slos/sources`: what an SLO can be measured from, for the editor's pickers. */
export interface SloSourcesResponse {
  probes: SloProbeOption[];
  metricResources: SloMetricResourceOption[];
}

/** Body of `POST /slos/:id/freeze`. */
export interface SloFreezeRequest {
  /** Null = until somebody ends it. */
  durationHours: number | null;
  reason?: string;
}

export const SLO_FREEZE_DURATIONS_HOURS: readonly (number | null)[] = [24, 72, 168, null];

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

function compare(value: number, comparator: SloComparator, threshold: number): boolean {
  switch (comparator) {
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
  }
}

/** The ClickHouse series an SLO reads, by kind. */
export function sloSeriesLabel(source: Pick<SloSourceFields, "sliKind" | "metricKey">): string {
  switch (source.sliKind) {
    case "probe_availability":
      return "Up";
    case "probe_latency":
      return "Latency";
    case "metric_threshold":
      return source.metricKey ?? "";
  }
}

/** How good one minute was, 0–1, from its averaged sample. */
export function sloMinuteGoodness(source: SloSourceFields, value: number): number {
  if (!Number.isFinite(value)) return 0;
  switch (source.sliKind) {
    case "probe_availability":
      return Math.min(1, Math.max(0, value));
    case "probe_latency":
      return value <= (source.latencyThresholdMs ?? SLO_DEFAULTS.latencyThresholdMs) ? 1 : 0;
    case "metric_threshold":
      if (source.comparator === null || source.threshold === null) return 0;
      return compare(value, source.comparator, source.threshold) ? 1 : 0;
  }
}

/** Per-minute samples → one bucket per minute. */
export function sloMinuteBuckets(
  source: SloSourceFields,
  samples: ReadonlyArray<{ tsMs: number; value: number }>,
): SloBucket[] {
  return samples.map((s) => ({
    startMs: s.tsMs,
    good: sloMinuteGoodness(source, s.value),
    total: 1,
  }));
}

/** Sum the buckets starting in `[fromMs, toMs]`. */
export function sumSloBuckets(
  buckets: readonly SloBucket[],
  fromMs: number,
  toMs: number = Number.POSITIVE_INFINITY,
): { good: number; total: number } {
  let good = 0;
  let total = 0;
  for (const b of buckets) {
    if (b.startMs < fromMs || b.startMs > toMs) continue;
    good += b.good;
    total += b.total;
  }
  return { good, total };
}

// ---------------------------------------------------------------------------
// Budget and burn arithmetic
// ---------------------------------------------------------------------------

/** The allowed bad fraction: 0.001 for 99.9%. */
export function sloErrorBudgetFraction(targetPercent: number): number {
  return Math.max(0, 1 - targetPercent / 100);
}

/** How fast the budget is burning: 1 means exactly on budget for the window. */
export function sloBurnRate(good: number, total: number, targetPercent: number): number | null {
  if (total <= 0) return null;
  const allowed = sloErrorBudgetFraction(targetPercent);
  const badFraction = Math.max(0, total - good) / total;
  if (allowed <= 0) return badFraction > 0 ? Number.POSITIVE_INFINITY : 0;
  return badFraction / allowed;
}

/** The burn rate at which `policy` fires for an SLO over `windowDays`. */
export function sloBurnRateThreshold(policy: SloBurnPolicy, windowDays: number): number {
  const periodMinutes = windowDays * 24 * 60;
  return (policy.budgetFraction * periodMinutes) / SLO_BURN_WINDOW_MINUTES[policy.longWindow];
}

/** The window's whole budget in minutes of total badness. */
export function sloBudgetTotalMinutes(targetPercent: number, windowDays: number): number {
  return sloErrorBudgetFraction(targetPercent) * windowDays * 24 * 60;
}

/** Fraction of the budget left given the window's events; null with no data. */
export function sloBudgetRemaining(
  good: number,
  total: number,
  targetPercent: number,
): number | null {
  if (total <= 0) return null;
  const allowedBad = sloErrorBudgetFraction(targetPercent) * total;
  const bad = Math.max(0, total - good);
  if (allowedBad <= 0) return bad > 0 ? -1 : 1;
  return 1 - bad / allowedBad;
}

export interface SloSnapshot {
  sli: number | null;
  goodEvents: number;
  totalEvents: number;
  budgetRemaining: number | null;
  burnRates: SloBurnRates;
  burnAlert: SloBurnAlert;
}

/** Windows at or under this length are read from minute buckets, longer ones from hourly. */
const MINUTE_RESOLUTION_LIMIT_MINUTES = 360;

/**
 * Everything the poller stores about an SLO, from two reads: minute buckets
 * covering at least the last six hours, and hourly buckets covering the
 * window. Pure, so the evaluator and the tests run the same code.
 */
export function computeSloSnapshot(args: {
  minuteBuckets: readonly SloBucket[];
  hourlyBuckets: readonly SloBucket[];
  targetPercent: number;
  windowDays: number;
  nowMs: number;
}): SloSnapshot {
  const { minuteBuckets, hourlyBuckets, targetPercent, windowDays, nowMs } = args;
  const windowStart = nowMs - windowDays * 24 * 60 * 60_000;
  // Hourly buckets are labelled by their start; the one straddling the window
  // start is left out rather than counted whole.
  const whole = sumSloBuckets(hourlyBuckets, windowStart, nowMs);

  const burnRates: SloBurnRates = {};
  for (const w of SLO_BURN_WINDOWS) {
    const minutes = SLO_BURN_WINDOW_MINUTES[w];
    const from = nowMs - minutes * 60_000;
    const source =
      minutes <= MINUTE_RESOLUTION_LIMIT_MINUTES
        ? sumSloBuckets(minuteBuckets, from, nowMs)
        : sumSloBuckets(hourlyBuckets, from, nowMs);
    burnRates[w] = sloBurnRate(source.good, source.total, targetPercent);
  }

  let burnAlert: SloBurnAlert = "none";
  for (const policy of SLO_BURN_POLICIES) {
    const threshold = sloBurnRateThreshold(policy, windowDays);
    const long = burnRates[policy.longWindow];
    const short = burnRates[policy.shortWindow];
    const fires =
      long !== null && long !== undefined && short !== null && short !== undefined
        ? long >= threshold && short >= threshold
        : false;
    if (!fires) continue;
    if (policy.severity === "page") {
      burnAlert = "fast";
      break;
    }
    burnAlert = "slow";
  }

  return {
    sli: whole.total > 0 ? whole.good / whole.total : null,
    goodEvents: whole.good,
    totalEvents: whole.total,
    budgetRemaining: sloBudgetRemaining(whole.good, whole.total, targetPercent),
    burnRates,
    burnAlert,
  };
}

/** The worst true thing about an SLO, from its stored snapshot. */
export function deriveSloStatus(snapshot: {
  sli: number | null;
  budgetRemaining: number | null;
  burnAlert: SloBurnAlert;
}): SloStatus {
  if (snapshot.sli === null || snapshot.budgetRemaining === null) return "unknown";
  if (snapshot.budgetRemaining <= 0) return "exhausted";
  if (snapshot.burnAlert === "fast") return "fast_burn";
  if (snapshot.burnAlert === "slow") return "slow_burn";
  return "ok";
}

/** Worst-first ordering for lists and the wallboard. */
export const SLO_STATUS_ORDER: readonly SloStatus[] = [
  "exhausted",
  "fast_burn",
  "slow_burn",
  "unknown",
  "ok",
];

export function compareSloStatus(a: SloStatus, b: SloStatus): number {
  return SLO_STATUS_ORDER.indexOf(a) - SLO_STATUS_ORDER.indexOf(b);
}

// ---------------------------------------------------------------------------
// History (the detail view's charts)
// ---------------------------------------------------------------------------

export interface SloHistoryPoint {
  tsMs: number;
  value: number;
}

export interface SloHistory {
  /** SLI per UTC day, as a percentage; days with no events are omitted. */
  dailySli: SloHistoryPoint[];
  /** Budget remaining (percentage of the window's budget) after each hour. */
  budgetBurndown: SloHistoryPoint[];
}

/**
 * Turn the hourly buckets into the two series the detail view draws. The
 * burndown divides cumulative badness by the budget the *whole* window's
 * events allow, so its last point is exactly the stored budget remaining.
 */
export function buildSloHistory(buckets: readonly SloBucket[], targetPercent: number): SloHistory {
  const sorted = [...buckets].sort((a, b) => a.startMs - b.startMs);
  const byDay = new Map<number, { good: number; total: number }>();
  let totalAll = 0;
  for (const b of sorted) {
    const day = Math.floor(b.startMs / 86_400_000) * 86_400_000;
    const acc = byDay.get(day) ?? { good: 0, total: 0 };
    acc.good += b.good;
    acc.total += b.total;
    byDay.set(day, acc);
    totalAll += b.total;
  }
  const dailySli: SloHistoryPoint[] = [];
  for (const [day, acc] of byDay) {
    if (acc.total > 0) dailySli.push({ tsMs: day, value: (acc.good / acc.total) * 100 });
  }

  const budgetBurndown: SloHistoryPoint[] = [];
  const allowedBad = sloErrorBudgetFraction(targetPercent) * totalAll;
  if (totalAll > 0 && allowedBad > 0) {
    let cumBad = 0;
    for (const b of sorted) {
      cumBad += Math.max(0, b.total - b.good);
      budgetBurndown.push({ tsMs: b.startMs, value: (1 - cumBad / allowedBad) * 100 });
    }
  }
  return { dailySli, budgetBurndown };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `0.99934` → `"99.934%"`: enough digits to see a nines target move. */
export function formatSloPercent(fraction: number, digits = 3): string {
  return `${Number((fraction * 100).toFixed(digits))}%`;
}

/** `99.9` → `"99.9%"`. */
export function formatSloTarget(targetPercent: number): string {
  return `${Number(targetPercent.toFixed(3))}%`;
}

/** `14.4` → `"14.4×"`; infinity (a 100% target with any badness) → `"∞"`. */
export function formatBurnRate(rate: number): string {
  if (!Number.isFinite(rate)) return "∞";
  return `${Number(rate.toFixed(rate >= 10 ? 1 : 2))}×`;
}

/**
 * Minutes of budget as a short duration, sign dropped (callers say "over by"):
 * `0.5` → `"30s"`, `43.2` → `"43m 12s"`, `125` → `"2h 5m"`, `1500` → `"1d 1h"`.
 */
export function formatBudgetDuration(minutes: number): string {
  const totalSeconds = Math.round(Math.abs(minutes) * 60);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const s = totalSeconds % 60;
    return s > 0 ? `${totalMinutes}m ${s}s` : `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const m = totalMinutes % 60;
    return m > 0 ? `${totalHours}h ${m}m` : `${totalHours}h`;
  }
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** One-line English description of the source, for the CLI and alert text. */
export function describeSloSource(
  slo: Pick<
    Slo,
    | "sliKind"
    | "probeName"
    | "resourceName"
    | "latencyThresholdMs"
    | "metricKey"
    | "comparator"
    | "threshold"
  >,
): string {
  switch (slo.sliKind) {
    case "probe_availability":
      return `Availability of probe "${slo.probeName ?? "deleted probe"}"`;
    case "probe_latency":
      return `Probe "${slo.probeName ?? "deleted probe"}" answering within ${slo.latencyThresholdMs ?? SLO_DEFAULTS.latencyThresholdMs} ms`;
    case "metric_threshold":
      return `${slo.metricKey ?? "?"} ${slo.comparator ?? "<"} ${slo.threshold ?? "?"} on "${slo.resourceName ?? "deleted resource"}"`;
  }
}

// ---------------------------------------------------------------------------
// Validation (the editors and the API boundary reject the same inputs)
// ---------------------------------------------------------------------------

/** Returns a human-readable problem, or null when the input is acceptable. */
export function validateSloInput(input: SloInput): string | null {
  const name = input.name.trim();
  if (!name) return "A name is required.";
  if (name.length > SLO_LIMITS.maxNameLength) {
    return `The name must be at most ${SLO_LIMITS.maxNameLength} characters.`;
  }
  if ((input.description ?? "").length > SLO_LIMITS.maxDescriptionLength) {
    return `The description must be at most ${SLO_LIMITS.maxDescriptionLength} characters.`;
  }
  if (!SLO_SLI_KINDS.includes(input.sliKind)) return "Unknown SLI kind.";
  if (
    !Number.isFinite(input.targetPercent) ||
    input.targetPercent < SLO_LIMITS.minTargetPercent ||
    input.targetPercent > SLO_LIMITS.maxTargetPercent
  ) {
    return `The target must be between ${SLO_LIMITS.minTargetPercent}% and ${SLO_LIMITS.maxTargetPercent}%.`;
  }
  if (!(SLO_WINDOW_DAYS as readonly number[]).includes(input.windowDays)) {
    return "The window must be 7, 28 or 30 days.";
  }
  if (input.sliKind === "probe_availability" || input.sliKind === "probe_latency") {
    if (!input.probeId) return "Choose a probe.";
  }
  if (input.sliKind === "probe_latency") {
    const t = input.latencyThresholdMs;
    if (
      t === null ||
      !Number.isInteger(t) ||
      t < SLO_LIMITS.minLatencyThresholdMs ||
      t > SLO_LIMITS.maxLatencyThresholdMs
    ) {
      return `The latency threshold must be a whole number of milliseconds between ${SLO_LIMITS.minLatencyThresholdMs} and ${SLO_LIMITS.maxLatencyThresholdMs}.`;
    }
  }
  if (input.sliKind === "metric_threshold") {
    if (!input.resourceId) return "Choose a resource.";
    const key = (input.metricKey ?? "").trim();
    if (!key) return "Choose a metric.";
    if (key.length > SLO_LIMITS.maxMetricKeyLength) return "The metric name is too long.";
    if (input.comparator === null || !SLO_COMPARATORS.includes(input.comparator)) {
      return "Choose a comparison.";
    }
    if (input.threshold === null || !Number.isFinite(input.threshold)) {
      return "The threshold must be a number.";
    }
  }
  return null;
}

/** Null out the source fields a kind does not use, so storage never holds stale ones. */
export function normalizeSloSource(input: SloSourceFields): SloSourceFields {
  const isProbe = input.sliKind === "probe_availability" || input.sliKind === "probe_latency";
  const isMetric = input.sliKind === "metric_threshold";
  return {
    sliKind: input.sliKind,
    probeId: isProbe ? input.probeId : null,
    latencyThresholdMs: input.sliKind === "probe_latency" ? input.latencyThresholdMs : null,
    resourceId: isMetric ? input.resourceId : null,
    metricKey: isMetric ? (input.metricKey ?? "").trim() || null : null,
    comparator: isMetric ? input.comparator : null,
    threshold: isMetric ? input.threshold : null,
  };
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile, the CLI, any host that talks the cloud API)
// ---------------------------------------------------------------------------

/** `GET /api/org/:orgId/slos` (`resources:read`). */
export async function fetchSlos(api: CloudFetch, orgId: string): Promise<SloListResponse> {
  const res = await api.org<SloListResponse>(orgId, "/slos");
  return res ?? { slos: [] };
}

/** `GET /api/org/:orgId/slos/:id`: the SLO with its hourly history (`resources:read`). */
export async function fetchSloDetail(
  api: CloudFetch,
  orgId: string,
  sloId: string,
): Promise<SloDetailResponse | null> {
  return api.org<SloDetailResponse>(orgId, `/slos/${encodeURIComponent(sloId)}`);
}

export async function fetchSloSources(api: CloudFetch, orgId: string): Promise<SloSourcesResponse> {
  const res = await api.org<SloSourcesResponse>(orgId, "/slos/sources");
  return res ?? { probes: [], metricResources: [] };
}

export async function createSlo(
  api: CloudFetch,
  orgId: string,
  body: SloInput,
): Promise<Slo | null> {
  return api.org<Slo>(orgId, "/slos", { method: "POST", body: JSON.stringify(body) });
}

export async function updateSlo(
  api: CloudFetch,
  orgId: string,
  sloId: string,
  body: Partial<SloInput>,
): Promise<Slo | null> {
  return api.org<Slo>(orgId, `/slos/${encodeURIComponent(sloId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteSlo(api: CloudFetch, orgId: string, sloId: string): Promise<void> {
  await api.org(orgId, `/slos/${encodeURIComponent(sloId)}`, { method: "DELETE" });
}
