/**
 * Quota & limit radar — the shared pure half.
 *
 * The wire contract for `/api/org/:orgId/quotas`, the bounds the settings form
 * and the API boundary both clamp against (the `PROBE_LIMITS` stance — the
 * form and the server must not disagree about what a valid threshold is), and
 * the trend arithmetic that turns a series of snapshots into "this runs out in
 * nine days".
 *
 * It lives in client-core rather than server-core for the usual reason: the
 * poller alerts on the same projection the page draws, and two
 * implementations of "trending to exhaustion" is two chances to disagree in
 * front of a user who is deciding whether to open a support ticket.
 *
 * The plugin-base import is type-only on purpose (the `expiry.ts` stance): no
 * runtime dependency on plugin-base, so the mobile bundle stays lean.
 */
import type { QuotaUsage } from "@infrawrench/plugin-base";

/** Where a quota sits relative to the org's threshold. */
export type QuotaSeverity =
  /** `used >= limit`. The provider is already refusing requests. */
  | "exhausted"
  /** At or over the org's alert threshold. */
  | "critical"
  /** Under the threshold, but the trend reaches the limit inside the horizon. */
  | "trending"
  /** Comfortably inside the limit with no adverse trend. */
  | "ok";

export const QUOTA_SEVERITIES: readonly QuotaSeverity[] = [
  "exhausted",
  "critical",
  "trending",
  "ok",
];

export const QUOTA_SEVERITY_LABELS: Record<QuotaSeverity, string> = {
  exhausted: "At the limit",
  critical: "Over threshold",
  trending: "Trending to exhaustion",
  ok: "Healthy",
};

/**
 * Bounds the API enforces on the tunable numbers, shared with the settings
 * form so neither can accept what the other rejects.
 */
export const QUOTA_ALERT_LIMITS = {
  threshold: {
    /**
     * A floor rather than 0: a threshold under half means every quota an org
     * holds is "over threshold", which is the same as having no threshold and
     * produces an alert nobody reads twice.
     */
    min: 0.5,
    /**
     * Not 1.0. At exactly the limit the provider is already refusing requests,
     * so an alert is a report of an outage rather than a warning about one.
     */
    max: 0.99,
  },
} as const;

/** Utilisation at which a quota alerts when the org has never touched the form. */
export const DEFAULT_QUOTA_THRESHOLD = 0.8;

/**
 * How far ahead the trend is allowed to look.
 *
 * Deliberately short. A linear fit over a fortnight of readings says something
 * useful about a quota filling steadily; extrapolated to a quarter it says
 * nothing at all, because provisioning is lumpy and the next deploy is not on
 * the line. Thirty days is roughly "can I get a support ticket approved in
 * time", which is the decision the number is for.
 */
export const QUOTA_TREND_HORIZON_DAYS = 30;

/**
 * Fewest snapshots a trend may be drawn through.
 *
 * Two points always fit a line perfectly, and the line through two readings
 * taken either side of a single deploy projects that deploy repeating forever.
 * Three is the smallest number at which a slope is evidence rather than an
 * artefact of when the collector happened to run.
 */
export const QUOTA_TREND_MIN_POINTS = 3;

/** One historical reading, as the API returns it. */
export interface QuotaSnapshot {
  /** ISO instant the reading was taken. */
  observedAt: string;
  used: number;
  /** The limit *at the time*. Never today's — see `db/quota-schema.ts`. */
  limit: number;
  utilization: number;
}

/**
 * The projection for one quota. Every field is null when there is not enough
 * evidence, and null is rendered as "not enough history" rather than as
 * "no risk" — the two are opposite claims and only one of them is true.
 */
export interface QuotaTrend {
  /** Change in *utilisation fraction* per day, from a least-squares fit. */
  perDay: number | null;
  /**
   * Days until `used` reaches `limit` at the fitted rate, or null when the
   * fit is flat, falling, or lands beyond {@link QUOTA_TREND_HORIZON_DAYS}.
   * Never negative: an already-exhausted quota is `exhausted`, not "ran out
   * six days ago".
   */
  daysToExhaustion: number | null;
  /** How many snapshots the fit used. Shown, so a thin trend reads as thin. */
  points: number;
}

/** One quota row as the API returns it. */
export interface QuotaRow {
  /** Stable per-account identity, the plugin's own `QuotaUsage.id`. */
  key: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  service: string;
  name: string;
  region: string | null;
  limit: number;
  used: number;
  utilization: number;
  unit: string | null;
  adjustable: boolean | null;
  docsUrl: string | null;
  observedAt: string;
  severity: QuotaSeverity;
  trend: QuotaTrend;
}

/**
 * Why an account has no rows.
 *
 * Reported per account rather than folded into a single banner because the
 * answers differ per account and the fix does too: one account's credential is
 * missing a policy while another's provider has no quota API at all. A page
 * that showed a single "some data may be missing" would leave the reader
 * unable to act on either.
 */
export interface QuotaAccountStatus {
  accountId: string;
  accountName: string;
  pluginId: string;
  /** Number of quota rows currently stored for this account. */
  quotaCount: number;
  /** ISO instant of the last successful collection; null if never. */
  lastPolledAt: string | null;
  /** Last collection failure, or null when the last pass succeeded. */
  lastError: string | null;
  lastErrorHelpLabel: string | null;
  lastErrorHelpUrl: string | null;
  /** The plugin declares only a representative subset of the provider's quotas. */
  partial: boolean;
}

export interface QuotaListResponse {
  rows: QuotaRow[];
  accounts: QuotaAccountStatus[];
  /** The org's alert threshold, so the page's bar marker matches the alert. */
  threshold: number;
  /**
   * Plugins in this org that declare no quota capability at all. Named, not
   * counted: "Vercel cannot report quotas" is actionable in a way that "3
   * providers unsupported" is not.
   */
  unsupportedPluginIds: string[];
}

export interface QuotaSettings {
  enabled: boolean;
  threshold: number;
}

export interface QuotaSettingsPatch {
  enabled?: boolean;
  threshold?: number;
}

// --- The pure half ---

/**
 * Least-squares slope of utilisation against time, in fraction-per-day.
 *
 * Regression rather than first-vs-last, and the reason is the same one that
 * makes the credit burn look at consecutive pairs: endpoints are exactly the
 * two readings most likely to be atypical. A quota that sat at 40% for a
 * fortnight and spiked to 90% the morning the collector last ran has a
 * first-vs-last slope that projects exhaustion tomorrow; the fit through every
 * point says what actually happened, which is that something changed once.
 *
 * Returns null below {@link QUOTA_TREND_MIN_POINTS} readings, or when every
 * reading shares an instant (a zero time span has no slope, only a division by
 * zero waiting to be rendered as `Infinity` days).
 */
export function fitQuotaSlope(snapshots: QuotaSnapshot[]): number | null {
  if (snapshots.length < QUOTA_TREND_MIN_POINTS) return null;

  const points: Array<{ t: number; u: number }> = [];
  for (const s of snapshots) {
    const t = Date.parse(s.observedAt);
    if (!Number.isFinite(t) || !Number.isFinite(s.utilization)) continue;
    points.push({ t: t / 86_400_000, u: s.utilization });
  }
  if (points.length < QUOTA_TREND_MIN_POINTS) return null;

  const n = points.length;
  const meanT = points.reduce((acc, p) => acc + p.t, 0) / n;
  const meanU = points.reduce((acc, p) => acc + p.u, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    const dt = p.t - meanT;
    numerator += dt * (p.u - meanU);
    denominator += dt * dt;
  }
  // Every reading at the same instant. Not an error — a freshly backfilled
  // account looks exactly like this — but it is not a slope either.
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Project a quota forward from its history.
 *
 * `current` is the live utilisation rather than the last snapshot's, because
 * the current row is written by the same pass that appends the snapshot and is
 * the value the rest of the page shows; projecting from a different number
 * than the one on screen is how a bar at 62% ends up next to "full in two
 * days" with no visible arithmetic connecting them.
 */
export function computeQuotaTrend(
  snapshots: QuotaSnapshot[],
  current: number,
  horizonDays: number = QUOTA_TREND_HORIZON_DAYS,
): QuotaTrend {
  const perDay = fitQuotaSlope(snapshots);
  const points = snapshots.length;
  if (perDay === null) return { perDay: null, daysToExhaustion: null, points };

  // Flat or falling: there is no exhaustion date, and inventing one from noise
  // around zero would put "full in 400 days" on a quota that is going down.
  if (perDay <= 0) return { perDay, daysToExhaustion: null, points };

  const remaining = 1 - current;
  // Already at or over the limit. The severity says so; a days-to-exhaustion
  // of zero would read as a prediction rather than as a present tense fact.
  if (remaining <= 0) return { perDay, daysToExhaustion: null, points };

  const days = remaining / perDay;
  if (!Number.isFinite(days) || days > horizonDays) {
    return { perDay, daysToExhaustion: null, points };
  }
  return { perDay, daysToExhaustion: days, points };
}

/**
 * Bucket a quota.
 *
 * Order matters and is not arbitrary: exhausted beats over-threshold beats
 * trending. A quota at 100% is also over an 80% threshold and also trending,
 * and reporting the mildest true thing about it would be the least useful
 * possible summary.
 */
export function quotaSeverity(
  utilization: number,
  threshold: number,
  trend: QuotaTrend,
): QuotaSeverity {
  if (utilization >= 1) return "exhausted";
  if (utilization >= threshold) return "critical";
  if (trend.daysToExhaustion !== null) return "trending";
  return "ok";
}

/** Rows that warrant an alert: at the limit, over threshold, or heading there. */
export function alertableQuotas(rows: QuotaRow[]): QuotaRow[] {
  return rows.filter((r) => r.severity !== "ok");
}

/**
 * Sort worst-first: severity bucket, then utilisation, then the soonest
 * exhaustion date, then a stable tie-break so two identical rows do not swap
 * places between renders.
 */
export function sortQuotaRows(rows: QuotaRow[]): QuotaRow[] {
  const rank: Record<QuotaSeverity, number> = { exhausted: 0, critical: 1, trending: 2, ok: 3 };
  return [...rows].sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    if (b.utilization !== a.utilization) return b.utilization - a.utilization;
    const ad = a.trend.daysToExhaustion ?? Number.POSITIVE_INFINITY;
    const bd = b.trend.daysToExhaustion ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return `${a.accountId}:${a.key}`.localeCompare(`${b.accountId}:${b.key}`);
  });
}

/** `62%`, and `0%`/`100%` rather than a rounded `0.4%` that reads as nothing. */
export function formatQuotaUtilization(utilization: number): string {
  if (!Number.isFinite(utilization)) return "—";
  const pct = utilization * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** `1,024 vCPUs` — the unit is the provider's word, so it is printed verbatim. */
export function formatQuotaAmount(value: number, unit: string | null | undefined): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  const num = rounded.toLocaleString("en-US");
  return unit ? `${num} ${unit}` : num;
}

/** "in 9 days" / "in under a day" — the row's countdown text. */
export function formatDaysToExhaustion(days: number): string {
  if (days < 1) return "in under a day";
  const whole = Math.round(days);
  return `in ${whole} day${whole === 1 ? "" : "s"}`;
}

/**
 * The one place a plugin reading becomes a stored row's numbers. Re-exported
 * shape rather than the plugin-base function so the server, the CLI and any
 * future local-mode reader round utilisation identically.
 */
export function quotaRowUtilization(reading: Pick<QuotaUsage, "used" | "limit">): number {
  if (!Number.isFinite(reading.limit) || reading.limit <= 0) return 0;
  return reading.used / reading.limit;
}
