import type { FindingRemediation } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";
import type { AlertEmailRecipients } from "./alert-email";

/* ------------------------------------------------------------------ *
 * Efficiency alerts: GET/PUT /costs/efficiency-alert-settings and
 * GET /costs/efficiency-alerts.
 *
 * The fourth, fifth and sixth cost-alert families. What separates them from
 * the first three is *what they are computed from*: budgets, anomalies and
 * change alerts all judge a spend total against another spend total, so
 * every one of them is blind to the two facts an org most reliably gets
 * surprised by; a commitment's calendar, and the volume the spend bought.
 *
 * - **Commitment expiry** is the only one with no spend input at all. It
 *   reads an end date. The spend it warns about has not happened yet, which
 *   is the entire value: an expired reservation reverts to on-demand and the
 *   change alert that eventually notices is a week late and $9,000 poorer.
 * - **Idle commitments** judge delivered usage against the commitment's own
 *   obligation: money already spent, measured against what it bought.
 * - **Unit-cost regressions** divide spend by a business metric. This is the
 *   only cost alert that can stay quiet while spend doubles (because volume
 *   tripled) and fire while spend is flat (because volume halved).
 *
 * All three share one settings row and one events feed because they share
 * one property: they are conditions a reader acts on within a week, not
 * pages. The settings live together so an org tunes "how noisy is the slow
 * lane" in one place.
 * ------------------------------------------------------------------ */

/** Which of the three efficiency detectors produced an event. */
export const EFFICIENCY_ALERT_KINDS = [
  "commitment_expiry",
  "commitment_idle",
  "unit_cost_regression",
  "unit_cost_threshold",
] as const;
export type EfficiencyAlertKind = (typeof EFFICIENCY_ALERT_KINDS)[number];

export const EFFICIENCY_ALERT_KIND_LABELS: Record<EfficiencyAlertKind, string> = {
  commitment_expiry: "Commitment expiry",
  commitment_idle: "Idle commitment",
  unit_cost_regression: "Unit-cost regression",
  unit_cost_threshold: "Unit-cost threshold",
};

/**
 * Per-org tuning for the three efficiency detectors.
 *
 * Every field has a default that works with no setup, the way
 * {@link DEFAULT_COST_ANOMALY_SETTINGS} does: a missing row is
 * indistinguishable from a saved-defaults row, so the feature is on for every
 * org that predates the table.
 *
 * Money is in cents and denominated in USD; each detector restates its floor
 * into the currency it is judging, so one setting means the same real amount
 * whether a provider bills in dollars or yen.
 */
export interface CostEfficiencySettings {
  /* --- Commitment expiry --- */
  commitmentExpiryEnabled: boolean;
  /**
   * Days of notice, each firing once per commitment per term end. Descending
   * by convention; the server sorts and de-duplicates whatever it is given.
   */
  commitmentExpiryHorizonDays: number[];
  /**
   * Whether a commitment that lapsed **without any warning having fired** also
   * raises one alert, at horizon 0. See the note on
   * {@link DEFAULT_COST_EFFICIENCY_SETTINGS}.
   */
  commitmentExpiryAlertOnExpired: boolean;

  /* --- Idle commitments --- */
  commitmentIdleEnabled: boolean;
  /** Utilization percent the window must stay under. */
  commitmentIdleThresholdPercent: number;
  /** Trailing days the utilization is measured over. */
  commitmentIdleWindowDays: number;
  /**
   * Days inside the window that must actually carry cost data before any
   * judgement is made. This is what keeps a collection outage from reading as
   * an idle commitment.
   */
  commitmentIdleMinMeasuredDays: number;
  /** Least wasted money (obligation − delivered) before alerting, USD cents. */
  commitmentIdleMinWasteCents: number;

  /* --- Unit-cost regression --- */
  unitCostRegressionEnabled: boolean;
  /** Percent the unit cost must rise versus the prior window. */
  unitCostThresholdPercent: number;
  /** Length of each of the two compared windows, in days. */
  unitCostWindowDays: number;
  /**
   * Days **inside each window** that must carry a reported, positive metric
   * value. Both windows must clear it: a regression measured against a window
   * that is mostly gaps is not a regression.
   */
  unitCostMinReportedDays: number;
  /** Least spend in the current window before alerting, USD cents. */
  unitCostMinSpendCents: number;

  /* --- Delivery --- */
  /**
   * Who is emailed about all three (commitment expiry, idle commitments,
   * unit-cost regressions), besides the routing rules. Optional on the PUT:
   * omitting it leaves the stored list alone. The GET always carries it.
   */
  emailRecipients?: AlertEmailRecipients | undefined;
}

/**
 * Bounds the API enforces, exported so the editor enforces the same ones.
 *
 * They exist to keep a setting from turning a detector into either a pager
 * storm or a permanent silence: the same rule {@link COST_ANOMALY_LIMITS}
 * follows.
 */
export const COST_EFFICIENCY_LIMITS = {
  /** At most six horizons; beyond that one commitment is its own digest. */
  maxExpiryHorizons: 6,
  /** A day of notice is the least that is actionable; two years the most. */
  minExpiryHorizonDays: 1,
  maxExpiryHorizonDays: 730,

  /** 1–99%. 100% would fire on every commitment that is not perfect. */
  minIdleThresholdPercent: 1,
  maxIdleThresholdPercent: 99,
  /** A week is the shortest window that can contain a weekend. */
  minIdleWindowDays: 7,
  maxIdleWindowDays: 90,
  /** Below three measured days the "window" is a dip again. */
  minIdleMinMeasuredDays: 3,
  maxIdleMinMeasuredDays: 90,
  minIdleWasteCents: 100,
  maxIdleWasteCents: 100_000_000,

  /** 1–1000%. Below 1% every rounding wobble is a regression. */
  minUnitCostThresholdPercent: 1,
  maxUnitCostThresholdPercent: 1000,
  /**
   * A week minimum: a shorter window cannot contain a full weekly cycle, and
   * unit costs are as weekday-shaped as the spend underneath them.
   */
  minUnitCostWindowDays: 7,
  maxUnitCostWindowDays: 90,
  minUnitCostReportedDays: 5,
  maxUnitCostReportedDays: 90,
  minUnitCostSpendCents: 100,
  maxUnitCostSpendCents: 100_000_000,

  /** GET /costs/efficiency-alerts?limit= bounds. */
  minEventsLimit: 1,
  maxEventsLimit: 200,
  defaultEventsLimit: 50,
} as const;

/**
 * What an org that has never touched the settings gets.
 *
 * The reasoning behind each number, because these are the values that decide
 * whether the feature is useful or ignored:
 *
 * - **60/30/7 days.** Three notices, each for a different decision. 60 days is
 *   procurement lead time: long enough to run a renewal through whoever signs
 *   for it. 30 days is the last point at which re-sizing is a considered
 *   choice rather than a scramble. 7 days is "this is happening; either renew
 *   or budget for on-demand". Fewer horizons and the first one is either too
 *   early to act on or too late to act well.
 * - **`commitmentExpiryAlertOnExpired: true`.** A commitment that lapsed
 *   without ever warning (because it was collected for the first time after
 *   its end date, or the org connected the account late) is the single worst
 *   case this feature exists for, and it is silent by construction: every
 *   horizon is in the past, so nothing fires. One alert at horizon 0 is the
 *   only way anyone learns. It is bounded: only commitments that ended inside
 *   the trailing look-back are considered, so connecting an account with ten
 *   years of expired reservations does not produce ten years of alerts.
 * - **70% over 30 days, ≥14 measured days.** 70% is roughly where a 1-year
 *   no-upfront commitment stops beating on-demand for the usage it covers, so
 *   below it the commitment is losing money rather than merely underperforming.
 *   30 days is four weekends: a weekday-only workload sits near 71% over a
 *   full month, which is exactly the population that should *not* fire. 14
 *   measured days means half the window has to be real data before anything is
 *   judged.
 * - **$50 of waste.** Below that the finding is true and worthless.
 * - **20% over 14 days, ≥10 reported days each side.** Two weeks each side
 *   covers two full weekly cycles, and 10 of 14 reported days on both sides is
 *   the minimum history at which the ratio means anything: a metric reported
 *   three times a fortnight has no unit cost to regress. 20% is well outside
 *   the month-to-month drift of a healthy unit cost and well inside the size
 *   of a real pricing or efficiency change.
 * - **$100 of spend.** A metric whose scope spends less than that in a
 *   fortnight cannot produce a unit-cost move worth reading.
 */
export const DEFAULT_COST_EFFICIENCY_SETTINGS: CostEfficiencySettings = {
  commitmentExpiryEnabled: true,
  commitmentExpiryHorizonDays: [60, 30, 7],
  commitmentExpiryAlertOnExpired: true,

  commitmentIdleEnabled: true,
  commitmentIdleThresholdPercent: 70,
  commitmentIdleWindowDays: 30,
  commitmentIdleMinMeasuredDays: 14,
  /** $50. */
  commitmentIdleMinWasteCents: 5000,

  unitCostRegressionEnabled: true,
  unitCostThresholdPercent: 20,
  unitCostWindowDays: 14,
  unitCostMinReportedDays: 10,
  /** $100. */
  unitCostMinSpendCents: 10_000,
};

/**
 * One fired efficiency alert, in the one shape every surface renders.
 *
 * A single row type across three detectors rather than three, because every
 * surface that shows them shows them in one list and the three carry the same
 * five facts: what it is about, when, how much money, how far off, and whether
 * anyone was told. The detector-specific extras live in `detail`, which is
 * display-only: nothing branches on it except the renderer.
 */
export interface EfficiencyAlertEvent {
  id: string;
  kind: EfficiencyAlertKind;
  /** What the alert is about: the commitment's description, or the metric's name. */
  subject: string;
  /** The account, for commitment kinds; null for unit-cost regressions. */
  accountId: string | null;
  accountName: string | null;
  /** ISO 4217 of every money field below, or null when the row carries none. */
  currency: string | null;
  /**
   * The money at stake, in **units of `currency`** (not cents: commitment
   * amounts are provider-reported in currency units and rounding them to cents
   * on the way through would be a lie about the precision).
   *
   * Per kind: the on-demand exposure for expiry, the wasted amount for idle,
   * the current window's spend for a regression.
   */
  amount: number | null;
  /** Free-form per-kind facts for the renderer. Never branched on. */
  detail: Record<string, string | number | null>;
  firedAt: string;
  notifiedAt: string | null;
  /**
   * Idle commitments only: the owning plugin's commands for inspecting and
   * acting on the commitment. Null (or absent, from older servers) for the
   * other kinds and when the commitment record is gone.
   */
  remediation?: FindingRemediation | null;
}

/** The org's efficiency-alert tuning (`GET /costs/efficiency-alert-settings`). */
export async function getCostEfficiencySettings(
  api: CloudFetch,
  orgId: string,
): Promise<CostEfficiencySettings> {
  const res = await api.org<CostEfficiencySettings>(orgId, "/costs/efficiency-alert-settings");
  return res ?? { ...DEFAULT_COST_EFFICIENCY_SETTINGS };
}

/**
 * Recently fired efficiency-alert events, newest first
 * (`GET /costs/efficiency-alerts`, permission `costs:read`).
 */
export async function listEfficiencyAlertEvents(
  api: CloudFetch,
  orgId: string,
  options: { kind?: EfficiencyAlertKind; limit?: number } = {},
): Promise<EfficiencyAlertEvent[]> {
  const limit = Math.min(
    Math.max(
      Math.round(options.limit ?? COST_EFFICIENCY_LIMITS.defaultEventsLimit),
      COST_EFFICIENCY_LIMITS.minEventsLimit,
    ),
    COST_EFFICIENCY_LIMITS.maxEventsLimit,
  );
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.kind) params.set("kind", options.kind);
  const res = await api.org<{ events: EfficiencyAlertEvent[] }>(
    orgId,
    `/costs/efficiency-alerts?${params.toString()}`,
  );
  return res?.events ?? [];
}
