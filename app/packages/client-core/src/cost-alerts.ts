import type { CloudFetch } from "./fetch";

import type { CostDimensionId, CostFilter } from "./costs";

/* ------------------------------------------------------------------ *
 * Change-based cost alerts: GET/POST/PUT/DELETE /cost-alerts.
 *
 * The third cost-alert family, deliberately distinct from the other two:
 * budgets alert on an absolute monthly total you chose; anomaly detection
 * alerts on unconfigured statistical outliers against a learned baseline;
 * change alerts alert on a *configured relative change*: "spend on this
 * scope moved more than X% (or $Y) versus the prior period"; on a scope
 * and cadence the user chose.
 * ------------------------------------------------------------------ */

/**
 * Which window is compared against which. The exact definitions (all
 * complete UTC days: the accruing current day never counts):
 *
 * - `daily`: one complete day vs the **same weekday one week earlier**
 *   (yesterday vs last Tuesday, not yesterday vs the day before), so weekday
 *   seasonality never reads as a change.
 * - `weekly`: the last 7 complete days vs the 7 complete days before them.
 * - `monthly`: month-to-date (the current month's complete days) vs the
 *   **same number of days** at the start of the prior month. Never MTD vs
 *   the full prior month: that comparison is always "down" until the 28th.
 */
export const COST_CHANGE_CADENCES = ["daily", "weekly", "monthly"] as const;
export type CostChangeCadence = (typeof COST_CHANGE_CADENCES)[number];

export const COST_CHANGE_CADENCE_LABELS: Record<CostChangeCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** One line per cadence for editors, spelling out the exact comparison. */
export const COST_CHANGE_CADENCE_DESCRIPTIONS: Record<CostChangeCadence, string> = {
  daily: "Yesterday vs the same day last week",
  weekly: "Last 7 complete days vs the prior 7",
  monthly: "Month to date vs the same number of days last month",
};

export const COST_CHANGE_DIRECTIONS = ["increase", "decrease", "both"] as const;
export type CostChangeDirection = (typeof COST_CHANGE_DIRECTIONS)[number];

export const COST_CHANGE_DIRECTION_LABELS: Record<CostChangeDirection, string> = {
  increase: "Increases only",
  decrease: "Decreases only",
  both: "Either direction",
};

/** A change-based cost alert, as the API returns it. */
export interface CostAlert {
  id: string;
  name: string;
  /** Which cost rows count: same vocabulary as budget and graph filters. */
  filters: CostFilter[];
  /**
   * Per-group fan-out: null watches the scope's one total; a dimension
   * watches **each group** against its own prior window, so one alert covers
   * "any service that moves" and each offending group fires its own event.
   */
  groupBy: CostDimensionId | null;
  /** The tag key groups come from; only set when `groupBy === "tag"`. */
  groupByTagKey: string | null;
  cadence: CostChangeCadence;
  /**
   * Percent of the prior window's spend the change must reach, or null.
   * At least one threshold is always set; when **both** are set, **both**
   * must hold before the alert fires: a 50% jump on $2 pages nobody.
   */
  thresholdPercent: number | null;
  /** Cents the change must reach, or null. */
  thresholdAmountCents: number | null;
  direction: CostChangeDirection;
  enabled: boolean;
  /** When evaluation last looked at this alert (fired or not). */
  lastEvaluatedAt: string | null;
  /** When the alert last fired an event, or null when it never has. */
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update payload (POST/PUT /cost-alerts). */
export interface CostAlertInput {
  name: string;
  filters: CostFilter[];
  groupBy: CostDimensionId | null;
  /** Required when `groupBy === "tag"`. */
  groupByTagKey?: string | undefined;
  cadence: CostChangeCadence;
  thresholdPercent: number | null;
  thresholdAmountCents: number | null;
  direction: CostChangeDirection;
  enabled: boolean;
}

/** Bounds the API enforces; clients enforce the same ones locally. */
export const COST_ALERT_LIMITS = {
  maxNameLength: 120,
  /** 1% .. 10000%: a 100x move is the largest sane percent threshold. */
  minPercent: 1,
  maxPercent: 10_000,
  maxAlertsPerOrg: 200,
  /** GET /cost-alerts/events?limit= bounds. */
  minEventsLimit: 1,
  maxEventsLimit: 200,
  defaultEventsLimit: 50,
} as const;

export const DEFAULT_COST_ALERT_INPUT: CostAlertInput = {
  name: "",
  filters: [],
  groupBy: null,
  cadence: "weekly",
  thresholdPercent: 25,
  // Both thresholds by default: percent finds the movement, the absolute
  // floor keeps a 50%-of-nearly-nothing jump from firing.
  thresholdAmountCents: 10_000,
  direction: "increase",
  enabled: true,
};

/**
 * One fired comparison: the current window's spend against the prior
 * window's, for one group (or the whole scope) in one currency.
 */
export interface CostAlertEvent {
  id: string;
  alertId: string;
  /** The alert's name at read time; "" when the alert was since deleted. */
  alertName: string;
  /** Cadence period the current window belongs to: the dedup key. */
  periodKey: string;
  /** Current window, inclusive UTC days. */
  windowFrom: string;
  windowTo: string;
  /** Prior window it was compared against, inclusive UTC days. */
  previousFrom: string;
  previousTo: string;
  /** The offending group; "" when the alert watches one total. */
  groupKey: string;
  currency: string;
  previousAmountCents: number;
  currentAmountCents: number;
  /**
   * Signed percent change, rounded. Null when the prior window had no spend
   * at all: new spend has no percentage, only an amount. -100 when the
   * group vanished.
   */
  changePercent: number | null;
  direction: "increase" | "decrease";
  firedAt: string;
  notifiedAt: string | null;
}

/**
 *"+173%", "-42%", or "new" for spend with no prior window to be up from.
 * Every surface renders the null-percent case as `new`: a made-up huge
 * percentage buries the fact that matters, which is that the thing is new.
 */
export function costAlertEventDeltaLabel(event: Pick<CostAlertEvent, "changePercent">): string {
  if (event.changePercent === null) return "new";
  const rounded = Math.round(event.changePercent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** The org's change alerts (`GET /cost-alerts`, permission `costs:read`). */
export async function listCostAlerts(api: CloudFetch, orgId: string): Promise<CostAlert[]> {
  const res = await api.org<{ alerts: CostAlert[] }>(orgId, "/cost-alerts");
  return res?.alerts ?? [];
}

/**
 * Recently fired change-alert events, newest first
 * (`GET /cost-alerts/events`, permission `costs:read`). Optionally scoped to
 * one alert.
 */
export async function listCostAlertEvents(
  api: CloudFetch,
  orgId: string,
  options: { alertId?: string; limit?: number } = {},
): Promise<CostAlertEvent[]> {
  const limit = Math.min(
    Math.max(
      Math.round(options.limit ?? COST_ALERT_LIMITS.defaultEventsLimit),
      COST_ALERT_LIMITS.minEventsLimit,
    ),
    COST_ALERT_LIMITS.maxEventsLimit,
  );
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.alertId) params.set("alertId", options.alertId);
  const res = await api.org<{ events: CostAlertEvent[] }>(
    orgId,
    `/cost-alerts/events?${params.toString()}`,
  );
  return res?.events ?? [];
}
