/**
 * Cost per change / cost per deploy — the shared contract.
 *
 * "What did this change cost?" is answered by comparing a resource's *per-day*
 * spend over a window before the change against the window after it, and
 * reporting the difference as a **run-rate delta** (money per day) rather than
 * a total. A total would be a statement about two spans of time; the question
 * is about the estate's new cost of ownership, and only a rate says that.
 *
 * Three properties are load-bearing and every surface renders them:
 *
 * - **The charge-type basis is named, never assumed.** `costBasis` is on the
 *   request *and* echoed on the response, and the UI prints it. Cash and
 *   amortized answer different questions and mixing them silently is the
 *   failure mode this feature would die of — an amortized "after" against a
 *   cash "before" reads as a saving that nobody made.
 * - **A null is never a zero.** A resource we hold no cost data for reports
 *   `status: "unknown"`, not `$0.00/day`. Distinguishing "this change cost
 *   nothing" from "we cannot say what this change cost" is the entire value of
 *   the number; see {@link ChangeCostImpactReason} for which of the two a
 *   result is claiming.
 * - **A delta is correlation, not causation.** When other recorded changes
 *   touched the same resource inside the window, the result says so
 *   (`overlappingChanges`, reason `overlapping_changes`) and drops a
 *   confidence tier rather than claiming the whole movement.
 *
 * The arithmetic itself lives in `server-core/cost/change-impact.ts` (pure,
 * unit-tested). This module is the wire shape plus the phrasing every host
 * shares, so web, desktop and mobile cannot describe the same number
 * differently.
 */

import { formatMonthlyEstimate } from "./cost-estimate";
import type { CostBasis } from "./costs";
import type { CloudFetch } from "./fetch";

/** Default half-window, in whole UTC days, on each side of the change. */
export const DEFAULT_CHANGE_IMPACT_WINDOW_DAYS = 7;
/**
 * Below this many days on a side there is no comparison worth printing: one
 * day against one day is a single provider hiccup with a decimal point.
 */
export const MIN_CHANGE_IMPACT_WINDOW_DAYS = 2;
/**
 * Above this the "before" window stops describing the state the change
 * replaced — a month back is a different estate.
 */
export const MAX_CHANGE_IMPACT_WINDOW_DAYS = 30;

/** Most changes one batched cost-impact request may ask about. */
export const MAX_CHANGE_IMPACT_BATCH = 50;

export type ChangeCostImpactStatus =
  /** Both windows had collected data and the delta below is real. */
  | "measured"
  /** Windows exist but are too short to compare; no delta is reported. */
  | "insufficient_data"
  /** We hold nothing that can answer the question. **Not** zero. */
  | "unknown";

export type ChangeCostImpactConfidence = "high" | "medium" | "low" | "none";

/**
 * Why a result reads the way it does. Every non-`measured` status carries at
 * least one, and `measured` carries the ones that lowered its confidence — a
 * caller should never have to guess whether "unknown" means "not billable" or
 * "we have not collected that far back".
 */
export type ChangeCostImpactReason =
  /** The resource has no provider-native id, so no cost row can be keyed to it. */
  | "no_cost_identity"
  /**
   * The provider is `periodNative`: it dates a whole invoice period to the
   * period's *start* day, so a 7-day window either swallows a month's bill or
   * misses it entirely. Neither is an answer.
   */
  | "period_native_provider"
  /** Cost was collected across the window, but never any for this resource. */
  | "no_cost_data"
  /** Collection had not started by the "before" window. */
  | "no_coverage_before"
  /** Collection has not yet reached the "after" window (or the change is too recent). */
  | "no_coverage_after"
  /** Fewer than {@link MIN_CHANGE_IMPACT_WINDOW_DAYS} comparable days on a side. */
  | "short_window"
  /** The window was shortened to fit the data that exists. */
  | "window_clamped"
  /** Other recorded changes touched the same resource inside the window. */
  | "overlapping_changes";

/** One currency's before/after comparison. Currencies are never summed. */
export interface ChangeCostImpactSeries {
  currency: string;
  /** Mean money per day across the "before" window. */
  beforePerDay: number;
  /** Mean money per day across the "after" window. */
  afterPerDay: number;
  /** `afterPerDay - beforePerDay`. Positive means the change costs more. */
  deltaPerDay: number;
  /** Rounded percentage, or null when the "before" window spent nothing. */
  deltaPercent: number | null;
  beforeTotal: number;
  afterTotal: number;
}

/** An inclusive UTC day span. */
export interface ChangeCostImpactWindow {
  from: string;
  to: string;
}

export interface ChangeCostImpact {
  status: ChangeCostImpactStatus;
  /** Echoed so no surface can render a number without naming its basis. */
  costBasis: CostBasis;
  /** What the caller asked for. */
  windowDays: number;
  /** What the data supported — equal to or smaller than `windowDays`. */
  effectiveWindowDays: number;
  /** The UTC day the change landed on. Excluded from both windows. */
  eventDay: string;
  before: ChangeCostImpactWindow | null;
  after: ChangeCostImpactWindow | null;
  series: ChangeCostImpactSeries[];
  confidence: ChangeCostImpactConfidence;
  reasons: ChangeCostImpactReason[];
  /** Other changes to the same resource inside the union window. */
  overlappingChanges: number;
}

/** A cost impact keyed back to the change it was asked about. */
export interface ChangeCostImpactEntry {
  changeId: string;
  resourceId: string;
  impact: ChangeCostImpact;
}

/** One resource's share of a deployment's impact. */
export interface DeploymentCostImpactResource {
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  impact: ChangeCostImpact;
}

export interface DeploymentCostImpact {
  runId: string;
  costBasis: CostBasis;
  windowDays: number;
  /**
   * The run's **start** day, UTC — the day every resource's windows are
   * anchored on. A long build's cost consequences begin when the resources
   * appear, not when the last step logged.
   */
  eventDay: string;
  /**
   * Per-resource breakdown. `total` is the sum of exactly these rows, so a
   * reader can always check the addition.
   */
  resources: DeploymentCostImpactResource[];
  /**
   * Summed `deltaPerDay` per currency across the *measured* rows only —
   * an unknown row contributes nothing rather than zero, and
   * `unknownResources` says how many were left out.
   */
  total: Array<{ currency: string; deltaPerDay: number }>;
  /** Rows whose status was not `measured`; excluded from `total`. */
  unknownResources: number;
  /** Weakest confidence among the measured rows — a chain is its weakest link. */
  confidence: ChangeCostImpactConfidence;
}

export interface ChangeCostImpactRequest {
  changeIds: string[];
  windowDays?: number | undefined;
  costBasis?: CostBasis | undefined;
}

/** Which object a written cost annotation is about. */
export type ChangeCostImpactSubjectKind = "change" | "deployment";

export interface ChangeCostImpactAnnotationRequest {
  subjectKind: ChangeCostImpactSubjectKind;
  subjectId: string;
  windowDays?: number | undefined;
  costBasis?: CostBasis | undefined;
}

/**
 * Clamp a requested window to the supported range. Callers clamp before the
 * round trip so a typo fails locally; the server clamps again because it can
 * never trust a client to have done it.
 */
export function clampChangeImpactWindowDays(days: number | undefined): number {
  if (typeof days !== "number" || !Number.isFinite(days)) {
    return DEFAULT_CHANGE_IMPACT_WINDOW_DAYS;
  }
  const whole = Math.round(days);
  if (whole < MIN_CHANGE_IMPACT_WINDOW_DAYS) return MIN_CHANGE_IMPACT_WINDOW_DAYS;
  if (whole > MAX_CHANGE_IMPACT_WINDOW_DAYS) return MAX_CHANGE_IMPACT_WINDOW_DAYS;
  return whole;
}

/**
 * Validate a wire `costBasis`. Absent means `cash`, the documented default;
 * anything else present is `null` so the caller can 400 rather than silently
 * answering a different question than the one asked.
 */
export function parseCostBasis(value: unknown): CostBasis | null {
  if (value === undefined || value === null || value === "") return "cash";
  return value === "cash" || value === "amortized" ? value : null;
}

/** Human label for the basis, for the "(cash basis)" suffix every surface prints. */
export function costBasisLabel(basis: CostBasis): string {
  return basis === "amortized" ? "amortized basis" : "cash basis";
}

export const CHANGE_IMPACT_CONFIDENCE_LABELS: Record<ChangeCostImpactConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  none: "No confidence",
};

/**
 * Why a non-measured result says nothing, in the words a user needs. Kept here
 * rather than in each host so "unknown" never acquires three explanations.
 */
export function changeCostImpactReasonLabel(reason: ChangeCostImpactReason): string {
  switch (reason) {
    case "no_cost_identity":
      return "no provider id to match spend against";
    case "period_native_provider":
      return "this provider bills by invoice period, not by day";
    case "no_cost_data":
      return "no spend recorded for this resource";
    case "no_coverage_before":
      return "cost collection had not started yet";
    case "no_coverage_after":
      return "not enough days have passed since the change";
    case "short_window":
      return "too few comparable days";
    case "window_clamped":
      return "window shortened to the data available";
    case "overlapping_changes":
      return "other changes touched this resource in the same window";
  }
}

/**
 * The one-line rendering every surface uses.
 *
 * Returns null when there is nothing worth a line — the caller renders
 * nothing rather than a row saying "unknown" beside every security group that
 * was never billable in the first place. Pass `verbose` to get the explanation
 * instead of null, which is what a detail view wants.
 */
export function formatChangeCostImpact(
  impact: ChangeCostImpact,
  opts: { verbose?: boolean } = {},
): string | null {
  const basis = costBasisLabel(impact.costBasis);
  if (impact.status !== "measured") {
    if (!opts.verbose) return null;
    const why = impact.reasons.map(changeCostImpactReasonLabel).join("; ");
    return why ? `Cost impact unknown — ${why}.` : "Cost impact unknown.";
  }
  const parts = impact.series.map((s) => {
    const money = formatSignedPerDay(s.deltaPerDay, s.currency);
    return s.deltaPercent === null ? money : `${money} (${formatSignedPercent(s.deltaPercent)})`;
  });
  if (parts.length === 0) return null;
  const window = `${impact.effectiveWindowDays}d before/after`;
  return `${parts.join(", ")} · ${basis}, ${window}`;
}

/**
 * `+$12.40/day`, `−$3.00/day`, `$0/day`.
 *
 * Formatted through `formatMonthlyEstimate` rather than `formatMoney`, for the
 * reason that function was split out in the first place: `formatMoney` drops
 * cents above $10, which is right for a month of reported spend and wrong for a
 * **daily rate**, where $12 and $12.37 are eleven dollars a month apart. Its
 * name says "monthly" only because that was its first caller; what it actually
 * is, is "money with cents when there are any", which is exactly what a run
 * rate needs. Money is never formatted by hand here.
 */
export function formatSignedPerDay(amount: number, currency: string): string {
  const magnitude = formatMonthlyEstimate(Math.abs(amount), currency);
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${sign}${magnitude}/day`;
}

/** `+173%` / `-42%`; the caller has already decided a percentage is meaningful. */
export function formatSignedPercent(percent: number): string {
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

/**
 * Monthly-equivalent of a run-rate delta, at 30 days.
 *
 * A deliberate approximation, and it is stated as one wherever it renders: it
 * is the number people actually reason about ("this deploy added $400 a
 * month"), and quoting a calendar-exact figure would imply the daily rate is
 * known to that precision when it comes from a handful of observed days.
 */
export const CHANGE_IMPACT_MONTH_DAYS = 30;

export function changeImpactMonthly(deltaPerDay: number): number {
  return deltaPerDay * CHANGE_IMPACT_MONTH_DAYS;
}

/**
 * The text written onto a cost annotation. Shared so the note the server
 * stores reads the same as the line the UI renders, and so re-annotating a
 * restated window produces a *comparable* string rather than a new dialect.
 */
export function changeCostImpactAnnotationText(
  subject: { kind: ChangeCostImpactSubjectKind; label: string },
  impact: ChangeCostImpact,
): string | null {
  const line = formatChangeCostImpact(impact);
  if (line === null) return null;
  const noun = subject.kind === "deployment" ? "Deploy" : "Change";
  const caveat = impact.overlappingChanges > 0 ? " (other changes overlapped)" : "";
  return `${noun}: ${subject.label} — ${line}${caveat}`;
}

/** Batched cost impacts for a page of the change feed. */
export async function fetchChangeCostImpacts(
  api: CloudFetch,
  orgId: string,
  request: ChangeCostImpactRequest,
): Promise<ChangeCostImpactEntry[]> {
  if (request.changeIds.length === 0) return [];
  const body: ChangeCostImpactRequest = {
    changeIds: request.changeIds.slice(0, MAX_CHANGE_IMPACT_BATCH),
    ...(request.windowDays === undefined
      ? {}
      : { windowDays: clampChangeImpactWindowDays(request.windowDays) }),
    ...(request.costBasis === undefined ? {} : { costBasis: request.costBasis }),
  };
  const result = await api.org<{ impacts: ChangeCostImpactEntry[] }>(
    orgId,
    "/changes/cost-impacts",
    { method: "POST", body: JSON.stringify(body) },
  );
  return result?.impacts ?? [];
}

/** One deployment run's per-resource cost impact. */
export async function fetchDeploymentCostImpact(
  api: CloudFetch,
  orgId: string,
  runId: string,
  opts: { windowDays?: number; costBasis?: CostBasis } = {},
): Promise<DeploymentCostImpact | null> {
  const params = new URLSearchParams();
  if (opts.windowDays !== undefined) {
    params.set("windowDays", String(clampChangeImpactWindowDays(opts.windowDays)));
  }
  if (opts.costBasis) params.set("costBasis", opts.costBasis);
  const query = params.toString();
  return await api.org<DeploymentCostImpact>(
    orgId,
    `/deployments/runs/${encodeURIComponent(runId)}/cost-impact${query ? `?${query}` : ""}`,
  );
}
