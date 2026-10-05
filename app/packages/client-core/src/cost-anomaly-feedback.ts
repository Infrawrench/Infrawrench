import type { CloudFetch } from "./fetch";
import type { CostAnomaly, CostAnomalyDimension } from "./cost-anomalies";

/* ------------------------------------------------------------------ *
 * Anomaly feedback: telling detection whether a finding was a real
 * problem, and letting that answer tune what alerts next time.
 *
 * Three pieces, each small on its own:
 *
 * - **A verdict on the finding.** `expected` (planned or known) or
 *   `unexpected` (a real problem), with an optional reason category and
 *   note. Recorded on the anomaly with who said it and when.
 * - **A suppression**, optionally created by an `expected` verdict: "spend in
 *   this scope is expected on these days until this date". Detection still
 *   stores a finding the suppression explains (the record stays complete) but
 *   marks it suppressed and does not alert on it.
 * - **A sensitivity nudge.** A provider or service that keeps being marked
 *   expected gets its spike threshold raised a little, within bounds, and
 *   any `unexpected` verdict on it in the same window cancels the nudge.
 *
 * The date and coverage rules below are pure and shared by the server (which
 * applies them during detection) and the clients (which preview "this will
 * also cover …" before anybody saves).
 * ------------------------------------------------------------------ */

/** What a person said a finding was. */
export const COST_ANOMALY_VERDICTS = ["expected", "unexpected"] as const;
export type CostAnomalyVerdict = (typeof COST_ANOMALY_VERDICTS)[number];

export const COST_ANOMALY_VERDICT_LABELS: Record<CostAnomalyVerdict, string> = {
  expected: "Expected",
  unexpected: "Unexpected",
};

/** Optional reason categories, for filtering and for the precision report. */
export const COST_ANOMALY_FEEDBACK_REASONS = [
  "planned_launch",
  "migration",
  "seasonal",
  "pricing_change",
  "data_issue",
  "other",
] as const;
export type CostAnomalyFeedbackReason = (typeof COST_ANOMALY_FEEDBACK_REASONS)[number];

export const COST_ANOMALY_FEEDBACK_REASON_LABELS: Record<CostAnomalyFeedbackReason, string> = {
  planned_launch: "Planned launch",
  migration: "Migration",
  seasonal: "Seasonal",
  pricing_change: "Pricing change",
  data_issue: "Data issue",
  other: "Other",
};

/**
 * How a suppression repeats.
 *
 * - `one_off`: every day from its start until it expires. A migration, a
 *   launch week, a load test.
 * - `weekly`: the anchor day's weekday, every week. A Monday batch job.
 * - `monthly`: the anchor day's day of the month, give or take a day (billing
 *   runs drift by a day around month ends and weekends). A month-end close.
 * - `seasonal`: the anchor day's calendar date, give or take three days, every
 *   year. Black Friday, a yearly renewal.
 */
export const COST_ANOMALY_RECURRENCES = ["one_off", "weekly", "monthly", "seasonal"] as const;
export type CostAnomalyRecurrence = (typeof COST_ANOMALY_RECURRENCES)[number];

export const COST_ANOMALY_RECURRENCE_LABELS: Record<CostAnomalyRecurrence, string> = {
  one_off: "One-off",
  weekly: "Recurring weekly",
  monthly: "Recurring monthly",
  seasonal: "Seasonal (yearly)",
};

/**
 * What a suppression covers. `provider` and `service` are the two breakdowns
 * detection judges; `account`, `tag` and `cost_centre` are slices of spend
 * that cut across them. In every case the rule is the same: on a covered day,
 * the scope's spend is set aside before the day is judged, and a finding that
 * only existed because of it is stored as suppressed instead of alerting.
 */
export const COST_ANOMALY_SUPPRESSION_SCOPES = [
  "provider",
  "service",
  "account",
  "tag",
  "cost_centre",
] as const;
export type CostAnomalySuppressionScope = (typeof COST_ANOMALY_SUPPRESSION_SCOPES)[number];

export const COST_ANOMALY_SUPPRESSION_SCOPE_LABELS: Record<CostAnomalySuppressionScope, string> = {
  provider: "Provider",
  service: "Service",
  account: "Account",
  tag: "Tag",
  cost_centre: "Cost centre",
};

/**
 * Bounds the API enforces, and the constants of the sensitivity nudge.
 *
 * The nudge is deliberately small and capped: half a standard deviation per
 * `expected` verdict after the first, at most two in total, and never past the
 * global 10σ ceiling. Feedback should make a noisy key quieter, not switch it
 * off; a key that genuinely never matters wants a suppression, which has an
 * expiry somebody chose.
 */
export const COST_ANOMALY_FEEDBACK_LIMITS = {
  noteMaxLength: 500,
  /** Active (unexpired) suppressions an organization can hold. */
  maxActiveSuppressions: 100,
  /** Furthest a suppression may expire after it starts: three years. */
  maxSuppressionDays: 1096,
  scopeKeyMaxLength: 256,
  /** Feedback older than this no longer moves a key's sensitivity. */
  sensitivityWindowDays: 90,
  /** σ added per `expected` verdict beyond the first. */
  sigmaStep: 0.5,
  /** Most σ feedback can add to one key. */
  maxSigmaNudge: 2,
  /** The global ceiling, matching `COST_ANOMALY_LIMITS.sigmasMax`. */
  sigmasCeiling: 10,
  /** Months the precision report can span. */
  precisionMaxMonths: 24,
  precisionDefaultMonths: 6,
} as const;

/** Default lifetime of a suppression, by recurrence, in days from its start. */
export const COST_ANOMALY_SUPPRESSION_DEFAULT_DAYS: Record<CostAnomalyRecurrence, number> = {
  one_off: 7,
  weekly: 90,
  monthly: 180,
  seasonal: 730,
};

/** Tolerance either side of the anchor date, in days, by recurrence. */
const RECURRENCE_TOLERANCE_DAYS: Record<CostAnomalyRecurrence, number> = {
  one_off: 0,
  weekly: 0,
  monthly: 1,
  seasonal: 3,
};

/** The verdict half of an anomaly row, or null while nobody has given one. */
export interface CostAnomalyFeedback {
  verdict: CostAnomalyVerdict;
  reason: CostAnomalyFeedbackReason | null;
  note: string | null;
  /** When the current verdict was recorded; restamped when it changes. */
  at: string;
  byUserId: string | null;
  /** Display name (or email) of whoever gave it, when they are still known. */
  byName: string | null;
  /**
   * The suppression this verdict created, or null (none was asked for, it was
   * deleted, or the verdict is `unexpected`).
   */
  suppressionId: string | null;
}

/** A suppression as the list and the editor see it. */
export interface CostAnomalySuppression {
  id: string;
  scope: CostAnomalySuppressionScope;
  /**
   * The scope's value: a plugin id, a service name, an account id, a tag
   * value, or a cost centre id.
   */
  scopeKey: string;
  /** The tag key, for `scope: "tag"`; null otherwise. */
  tagKey: string | null;
  /**
   * A human label for `scopeKey` where it is an id (the account or cost
   * centre name); null when the id no longer resolves or the key is already
   * readable.
   */
  scopeLabel: string | null;
  recurrence: CostAnomalyRecurrence;
  /** The day the pattern is anchored to: its weekday, day of month or date. */
  anchorDay: string;
  /** First day covered, YYYY-MM-DD. */
  startsOn: string;
  /** Last day covered, YYYY-MM-DD, inclusive. */
  expiresOn: string;
  reason: CostAnomalyFeedbackReason | null;
  note: string | null;
  /** The anomaly whose `expected` verdict created this, if any. */
  sourceAnomalyId: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Whether it still covers today or a later day. */
  active: boolean;
  /** How many detected findings it has suppressed so far. */
  suppressedCount: number;
}

/** What creating or editing a suppression sends. */
export interface CostAnomalySuppressionInput {
  scope: CostAnomalySuppressionScope;
  scopeKey: string;
  /** Required when `scope` is `tag`. */
  tagKey?: string | undefined;
  recurrence: CostAnomalyRecurrence;
  anchorDay: string;
  /** Defaults to `anchorDay`. */
  startsOn?: string | undefined;
  expiresOn: string;
  reason?: CostAnomalyFeedbackReason | null | undefined;
  note?: string | null | undefined;
}

/** What `POST /costs/anomalies/:id/feedback` sends. */
export interface CostAnomalyFeedbackInput {
  verdict: CostAnomalyVerdict;
  reason?: CostAnomalyFeedbackReason | null | undefined;
  note?: string | null | undefined;
  /**
   * Also record the note as the anomaly's explanation, which publishes it as
   * an annotation on every chart covering the day: exactly what the Explain
   * action does. Ignored without a note.
   */
  explain?: boolean | undefined;
  /**
   * Only with `verdict: "expected"`: create (or update) a suppression so the
   * same pattern does not alert again. The scope defaults to the anomaly's own
   * provider or service, the anchor to its day, and the expiry to the
   * recurrence's default lifetime.
   */
  suppress?:
    | {
        recurrence: CostAnomalyRecurrence;
        scope?: CostAnomalySuppressionScope | undefined;
        scopeKey?: string | undefined;
        tagKey?: string | undefined;
        expiresOn?: string | undefined;
      }
    | undefined;
}

export interface CostAnomalyFeedbackResult {
  anomaly: CostAnomaly;
  suppression: CostAnomalySuppression | null;
}

/** One provider or service whose sensitivity feedback has moved. */
export interface CostAnomalySensitivityAdjustment {
  dimension: CostAnomalyDimension;
  dimensionKey: string;
  /** The organization-wide σ. */
  baseSigmas: number;
  /** The σ detection judges this key's spikes against. */
  sigmas: number;
  expectedCount: number;
  unexpectedCount: number;
  /** One sentence saying why, for the tuning panel. */
  explanation: string;
}

/** `GET /costs/anomaly-sensitivity`. */
export interface CostAnomalySensitivity {
  /** `feedbackTuning` from the settings: false means no nudge applies. */
  enabled: boolean;
  windowDays: number;
  baseSigmas: number;
  /**
   * Every key with feedback in the window, including ones whose verdicts
   * cancel out (an `unexpected` verdict holds sensitivity where it was), so
   * the panel can say why a key it expected to see moved did not.
   */
  adjustments: CostAnomalySensitivityAdjustment[];
}

/** One month of the precision report. */
export interface CostAnomalyPrecisionPeriod {
  /** YYYY-MM. */
  month: string;
  detected: number;
  /** Findings detection stored as suppressed rather than alerting on. */
  suppressed: number;
  expected: number;
  unexpected: number;
  /**
   * Share of reviewed findings marked unexpected: how often an alert was a
   * real problem. Null when nothing that month has a verdict.
   */
  precision: number | null;
}

/** `GET /costs/anomaly-precision`. */
export interface CostAnomalyPrecisionReport {
  months: number;
  periods: CostAnomalyPrecisionPeriod[];
  totals: Omit<CostAnomalyPrecisionPeriod, "month">;
  /** Verdict counts by reason category, across the whole window. */
  reasons: Array<{ reason: CostAnomalyFeedbackReason; count: number }>;
}

/* ------------------------------------------------------------------ *
 * Pure date and coverage rules.
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(day: string): Date | null {
  if (!ISO_DAY.test(day)) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ? null : d;
}

/** True for a real calendar day in YYYY-MM-DD form. */
export function isCostAnomalyIsoDay(day: string): boolean {
  return parseDay(day) !== null;
}

function shiftDay(day: string, delta: number): string {
  const d = parseDay(day);
  if (!d) return day;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
function dayDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * The default last day for a suppression of `recurrence` starting `startsOn`.
 */
export function defaultSuppressionExpiry(
  recurrence: CostAnomalyRecurrence,
  startsOn: string,
): string {
  return shiftDay(startsOn, COST_ANOMALY_SUPPRESSION_DEFAULT_DAYS[recurrence]);
}

/**
 * Whether a suppression's pattern covers `day`, ignoring scope.
 *
 * The window is inclusive at both ends. Monthly anchors past the end of a
 * shorter month fall on its last day (an anchor of the 31st covers the 30th
 * of April and the 28th or 29th of February), and the tolerance is measured
 * from that.
 */
export function suppressionCoversDay(
  s: Pick<CostAnomalySuppression, "recurrence" | "anchorDay" | "startsOn" | "expiresOn">,
  day: string,
): boolean {
  const d = parseDay(day);
  const anchor = parseDay(s.anchorDay);
  if (!d || !anchor) return false;
  if (day < s.startsOn || day > s.expiresOn) return false;
  const tolerance = RECURRENCE_TOLERANCE_DAYS[s.recurrence];
  switch (s.recurrence) {
    case "one_off":
      return true;
    case "weekly":
      return d.getUTCDay() === anchor.getUTCDay();
    case "monthly": {
      // Compare against the anchor's occurrence in this month and both
      // neighbours, so a tolerance can reach across a month boundary.
      for (const offset of [-1, 0, 1]) {
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + offset;
        const year = y + Math.floor(m / 12);
        const month = ((m % 12) + 12) % 12;
        const dom = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
        const occurrence = new Date(Date.UTC(year, month, dom));
        if (Math.abs(dayDiff(occurrence, d)) <= tolerance) return true;
      }
      return false;
    }
    case "seasonal": {
      for (const offset of [-1, 0, 1]) {
        const year = d.getUTCFullYear() + offset;
        const month = anchor.getUTCMonth();
        const dom = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
        const occurrence = new Date(Date.UTC(year, month, dom));
        if (Math.abs(dayDiff(occurrence, d)) <= tolerance) return true;
      }
      return false;
    }
  }
}

/**
 * The next `count` days on or after `from` the pattern covers, for a preview
 * line in the editor. Bounded so a one-off spanning years cannot loop long.
 */
export function upcomingSuppressedDays(
  s: Pick<CostAnomalySuppression, "recurrence" | "anchorDay" | "startsOn" | "expiresOn">,
  from: string,
  count = 3,
): string[] {
  const out: string[] = [];
  let day = from < s.startsOn ? s.startsOn : from;
  for (let i = 0; i < 800 && out.length < count && day <= s.expiresOn; i += 1) {
    if (suppressionCoversDay(s, day)) out.push(day);
    day = shiftDay(day, 1);
  }
  return out;
}

/**
 * What a suppression input is wrong about, or null when it is fine. The same
 * function the API runs, so the editor can refuse before the round trip.
 */
export function costAnomalySuppressionInputError(
  input: CostAnomalySuppressionInput,
): string | null {
  if (!COST_ANOMALY_SUPPRESSION_SCOPES.includes(input.scope)) return "Unknown scope";
  const key = input.scopeKey.trim();
  if (!key) return "Choose what the suppression covers";
  if (key.length > COST_ANOMALY_FEEDBACK_LIMITS.scopeKeyMaxLength) return "Scope value is too long";
  if (input.scope === "tag" && !input.tagKey?.trim()) return "A tag suppression needs a tag key";
  if (!COST_ANOMALY_RECURRENCES.includes(input.recurrence)) return "Unknown recurrence";
  if (!isCostAnomalyIsoDay(input.anchorDay)) return "The anchor day must be a YYYY-MM-DD date";
  const startsOn = input.startsOn ?? input.anchorDay;
  if (!isCostAnomalyIsoDay(startsOn)) return "The start must be a YYYY-MM-DD date";
  if (!isCostAnomalyIsoDay(input.expiresOn)) return "The expiry must be a YYYY-MM-DD date";
  if (input.expiresOn < startsOn) return "The expiry must be on or after the start";
  const span = dayDiff(parseDay(startsOn)!, parseDay(input.expiresOn)!);
  if (span > COST_ANOMALY_FEEDBACK_LIMITS.maxSuppressionDays) {
    return "A suppression can last at most three years";
  }
  if ((input.note ?? "").length > COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength) {
    return "The note is too long";
  }
  return null;
}

/**
 * The σ feedback adds to one key's spike threshold.
 *
 * Nothing for a single `expected` verdict (one planned launch says nothing
 * about the key), then half a σ per further one, capped. Any `unexpected`
 * verdict in the same window holds the key at the organization's σ: a key
 * that just had a real problem is the last one to make quieter.
 */
export function costAnomalySigmaNudge(expectedCount: number, unexpectedCount: number): number {
  if (unexpectedCount > 0) return 0;
  const steps = Math.max(0, expectedCount - 1);
  return Math.min(
    COST_ANOMALY_FEEDBACK_LIMITS.maxSigmaNudge,
    steps * COST_ANOMALY_FEEDBACK_LIMITS.sigmaStep,
  );
}

/** The σ a key is judged against, given the org's σ and its feedback. */
export function costAnomalyEffectiveSigmas(
  baseSigmas: number,
  expectedCount: number,
  unexpectedCount: number,
): number {
  const nudged = baseSigmas + costAnomalySigmaNudge(expectedCount, unexpectedCount);
  return Math.min(COST_ANOMALY_FEEDBACK_LIMITS.sigmasCeiling, Math.round(nudged * 10) / 10);
}

/** Whether a finding has a verdict. Tolerates an older server's missing field. */
export function costAnomalyVerdict(
  anomaly: Pick<CostAnomaly, "feedback">,
): CostAnomalyVerdict | null {
  return anomaly.feedback?.verdict ?? null;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers.
 * ------------------------------------------------------------------ */

/**
 * Give a finding a verdict (`POST /costs/anomalies/:id/feedback`,
 * `costs:write`). Sending it again replaces the verdict, and updates the
 * suppression an earlier `expected` verdict created rather than adding a
 * second one. Switching to `unexpected` removes that suppression.
 */
export async function submitCostAnomalyFeedback(
  api: CloudFetch,
  orgId: string,
  anomalyId: string,
  input: CostAnomalyFeedbackInput,
): Promise<CostAnomalyFeedbackResult | null> {
  return api.org<CostAnomalyFeedbackResult>(
    orgId,
    `/costs/anomalies/${encodeURIComponent(anomalyId)}/feedback`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/** Withdraw a verdict, and the suppression it created (`DELETE …/feedback`). */
export async function clearCostAnomalyFeedback(
  api: CloudFetch,
  orgId: string,
  anomalyId: string,
): Promise<CostAnomaly | null> {
  return api.org<CostAnomaly>(orgId, `/costs/anomalies/${encodeURIComponent(anomalyId)}/feedback`, {
    method: "DELETE",
  });
}

export async function listCostAnomalySuppressions(
  api: CloudFetch,
  orgId: string,
): Promise<CostAnomalySuppression[]> {
  const res = await api.org<{ suppressions: CostAnomalySuppression[] }>(
    orgId,
    "/costs/anomaly-suppressions",
  );
  return res?.suppressions ?? [];
}

export async function createCostAnomalySuppression(
  api: CloudFetch,
  orgId: string,
  input: CostAnomalySuppressionInput,
): Promise<CostAnomalySuppression | null> {
  return api.org<CostAnomalySuppression>(orgId, "/costs/anomaly-suppressions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCostAnomalySuppression(
  api: CloudFetch,
  orgId: string,
  id: string,
  input: CostAnomalySuppressionInput,
): Promise<CostAnomalySuppression | null> {
  return api.org<CostAnomalySuppression>(
    orgId,
    `/costs/anomaly-suppressions/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export async function deleteCostAnomalySuppression(
  api: CloudFetch,
  orgId: string,
  id: string,
): Promise<void> {
  await api.org(orgId, `/costs/anomaly-suppressions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getCostAnomalySensitivity(
  api: CloudFetch,
  orgId: string,
): Promise<CostAnomalySensitivity | null> {
  return api.org<CostAnomalySensitivity>(orgId, "/costs/anomaly-sensitivity");
}

export async function getCostAnomalyPrecision(
  api: CloudFetch,
  orgId: string,
  months: number = COST_ANOMALY_FEEDBACK_LIMITS.precisionDefaultMonths,
): Promise<CostAnomalyPrecisionReport | null> {
  const clamped = Math.min(
    Math.max(Math.round(months), 1),
    COST_ANOMALY_FEEDBACK_LIMITS.precisionMaxMonths,
  );
  return api.org<CostAnomalyPrecisionReport>(orgId, `/costs/anomaly-precision?months=${clamped}`);
}
