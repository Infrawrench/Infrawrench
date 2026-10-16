/**
 * Anomaly alerts scoped to one cost report: the contract for
 * `/cost-reports/{id}/anomaly-alert` and the rules the editor, the API, the CLI
 * and the Terraform provider share.
 *
 * Org-wide anomaly detection judges each provider and service against its own
 * history and routes through the org's alert rules. That answers "did anything
 * spike?", but not "did *my* slice spike?": a team that owns a report scoped to
 * its accounts or tags wants a page when that scope moves, at its own
 * sensitivity, in its own channel. A report anomaly alert is that: the detector
 * judges the report's filtered daily total (per currency) against its trailing
 * baseline and delivers to the destinations on the alert itself, chosen with the
 * same picker alert routing uses. It is *in addition to* the org-wide rules,
 * never instead of them: it does not consult or suppress them.
 */
import type { AlertDestination } from "./alert-routing";
import { COST_ANOMALY_LIMITS, DEFAULT_COST_ANOMALY_SETTINGS } from "./cost-anomalies";

/** Bounds on one alert. Sensitivity and floor use the org-wide settings' range. */
export const COST_REPORT_ANOMALY_ALERT_LIMITS = {
  sigmasMin: COST_ANOMALY_LIMITS.sigmasMin,
  sigmasMax: COST_ANOMALY_LIMITS.sigmasMax,
  minDeltaCentsMin: COST_ANOMALY_LIMITS.minDeltaCentsMin,
  minDeltaCentsMax: COST_ANOMALY_LIMITS.minDeltaCentsMax,
  maxDestinations: 20,
  /** Findings returned with the alert, newest first. */
  recentFindings: 20,
} as const;

/** What a new alert starts at: the org-wide defaults. */
export const DEFAULT_COST_REPORT_ANOMALY_ALERT = {
  sigmas: DEFAULT_COST_ANOMALY_SETTINGS.sigmas,
  minDeltaCents: DEFAULT_COST_ANOMALY_SETTINGS.minDeltaCents,
} as const;

/** Body of `PUT /cost-reports/{id}/anomaly-alert` (create or replace). */
export interface CostReportAnomalyAlertInput {
  /** Off keeps the configuration but stops evaluation. */
  enabled: boolean;
  /** Standard deviations above the trailing mean that count as anomalous. */
  sigmas: number;
  /**
   * Least rise over the trailing mean, in cents of the series' own currency,
   * before a day is reported however many sigmas it is.
   */
  minDeltaCents: number;
  /** Where findings go: the alert routing destination vocabulary. */
  destinations: AlertDestination[];
}

/** One day the report's scope spiked. */
export interface CostReportAnomaly {
  id: string;
  day: string;
  currency: string;
  /** That day's spend in the report's scope. */
  actual: number;
  /** The trailing 28-day mean it was judged against. */
  baseline: number;
  /** The bar it cleared: mean + sigmas x standard deviation. */
  threshold: number;
  /** When it was delivered; null while undelivered (or in the 7-day cooldown). */
  notifiedAt: string | null;
  createdAt: string;
}

export interface CostReportAnomalyAlert extends CostReportAnomalyAlertInput {
  id: string;
  reportId: string;
  /** The report's name, so an org-wide listing reads without a second fetch. */
  reportName: string;
  createdAt: string;
  updatedAt: string;
  /** Last time the detector judged this report's scope. */
  lastEvaluatedAt: string | null;
  /** Why the last evaluation failed, cleared on success. */
  lastError: string | null;
  /** The latest findings, newest first. */
  recent: CostReportAnomaly[];
}

/**
 * The reason an input cannot be saved, or null. Shared by the editor (which
 * disables Save with the same words) and the API (which answers 400 with them).
 * Destination *ownership* (a channel of this org, a current member) is the
 * server's half and is not checked here.
 */
export function costReportAnomalyAlertProblem(input: CostReportAnomalyAlertInput): string | null {
  const L = COST_REPORT_ANOMALY_ALERT_LIMITS;
  if (!Number.isFinite(input.sigmas) || input.sigmas < L.sigmasMin || input.sigmas > L.sigmasMax) {
    return `Sensitivity must be between ${L.sigmasMin} and ${L.sigmasMax} standard deviations.`;
  }
  if (
    !Number.isInteger(input.minDeltaCents) ||
    input.minDeltaCents < L.minDeltaCentsMin ||
    input.minDeltaCents > L.minDeltaCentsMax
  ) {
    return `The minimum rise must be between ${L.minDeltaCentsMin / 100} and ${L.minDeltaCentsMax / 100} a day.`;
  }
  if (!Array.isArray(input.destinations)) return "destinations must be a list.";
  if (input.destinations.length > L.maxDestinations) {
    return `At most ${L.maxDestinations} destinations.`;
  }
  if (input.enabled && input.destinations.length === 0) {
    return "Pick at least one destination, or turn the alert off.";
  }
  return null;
}
