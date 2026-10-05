import type { CloudFetch } from "./fetch";
import type { CostAnomalyFeedback } from "./cost-anomaly-feedback";
import type { AlertEmailRecipients } from "./alert-email";

/* ------------------------------------------------------------------ *
 * Cost anomalies: GET /costs/anomalies.
 * ------------------------------------------------------------------ */

/** The breakdowns anomaly detection evaluates. */
export type CostAnomalyDimension = "provider" | "service";

/**
 * What kind of finding a row is.
 *
 * - `spike`: spend far above the key's own trailing baseline.
 * - `new_source`: a key that spent (effectively) nothing across the whole
 *   trailing window and suddenly has material spend. It can never be a
 *   `spike`: with a zero baseline there is no mean or sigma to exceed, and the
 *   observed-days guard silences brand-new keys on purpose.
 *
 * The two are mutually exclusive for a given (day, key): a row is judged as a
 * spike first, and only a key with no baseline at all can be a new source.
 */
export type CostAnomalyKind = "spike" | "new_source";

/**
 * Somebody worked out what a finding was, and said so.
 *
 * The act is the acknowledgement; the artifact is the annotation it creates at
 * the anomaly's own day, org-wide, so the explanation lands on **every** chart
 * covering that day rather than dying in the head of whoever worked it out.
 * `annotationId` is that note.
 *
 * Two properties are worth stating because the rest follows from them:
 *
 * - **`explanation` is stored on the anomaly, not read back from the note.**
 *   The note is a living overlay anyone may reword or delete; this is the
 *   record of what was said when the finding was closed. Deleting the
 *   annotation therefore removes the chart marker and nulls `annotationId`:
 *   it never turns the anomaly back into an open question.
 * - **Acknowledging does not suppress detection.** An explained spike is
 *   explained, not exempt: the same key spiking again on a later day is a new
 *   row, detected and alerted on exactly as it would have been.
 */
export interface CostAnomalyAcknowledgement {
  /** The sentence. Also the text of the annotation this created. */
  explanation: string;
  /** When the *current* explanation was recorded: restamped by a correction. */
  acknowledgedAt: string;
  acknowledgedByUserId: string | null;
  /**
   * The annotation drawn on the charts, or null once that note has been
   * deleted. Null here never means "unexplained": see above.
   */
  annotationId: string | null;
}

/**
 * A detected spend anomaly: one UTC day where a provider's or service's spend
 * cleared the trailing-baseline threshold (mean + N·stddev over the prior
 * 28 days, with an absolute floor), or where a key with no prior spend at all
 * started costing money. Detection runs server-side after each cost
 * collection; this row is what the anomalies list renders.
 */
export interface CostAnomaly {
  id: string;
  /** The anomalous day, YYYY-MM-DD (UTC). */
  day: string;
  /**
   * Which detection produced this row. Older rows, written before new-source
   * detection existed, read as `spike`.
   */
  kind: CostAnomalyKind;
  dimension: CostAnomalyDimension;
  /** The dimension's value: a plugin id or a service name. */
  dimensionKey: string;
  currency: string;
  actualCents: number;
  /** Trailing-window mean, in cents. Zero (or near it) for a `new_source`. */
  baselineCents: number;
  /**
   * The bar the day cleared, in cents: the baseline mean + N·stddev for a
   * `spike`, the new-source floor for a `new_source`.
   */
  thresholdCents: number;
  detectedAt: string;
  /** Null when delivery failed or the cooldown suppressed the notification. */
  notifiedAt: string | null;
  /**
   * Root-cause hints computed when the anomaly fired: what the change
   * timeline and audit log say happened in the anomaly's window ("12
   * gce-instance resources appeared", "Astrid ran workflow \"Nightly
   * rebuild\""), ranked, at most three. Empty for anomalies detected before
   * hints existed. Optional so a client a release ahead of its server still
   * renders the row.
   */
  hints?: string[];
  /**
   * The explanation somebody attached to this finding, or null while it is
   * still an open question. Optional on the wire for the same reason `hints`
   * is: a client a release ahead of its server renders the row unexplained
   * rather than crashing on a missing field.
   */
  acknowledgement?: CostAnomalyAcknowledgement | null;
  /**
   * Whether somebody said this finding was expected (planned or known) or
   * unexpected (a real problem), or null while nobody has. Optional on the
   * wire like `acknowledgement`.
   */
  feedback?: CostAnomalyFeedback | null;
  /**
   * The suppression that explained this finding when it was detected, or
   * null. A suppressed finding is stored (the record stays complete) but is
   * never alerted on; `notifiedAt` stays null.
   */
  suppressionId?: string | null;
}

export const COST_ANOMALY_DIMENSION_LABELS: Record<CostAnomalyDimension, string> = {
  provider: "Provider",
  service: "Service",
};

export const COST_ANOMALY_KIND_LABELS: Record<CostAnomalyKind, string> = {
  spike: "Spike",
  new_source: "New spend source",
};

/**
 * The window `GET /costs/anomalies?days=` accepts. Clients clamp to it so a
 * typo fails locally rather than as a 400 after the round trip.
 */
export const COST_ANOMALY_WINDOW = { minDays: 1, maxDays: 90, defaultDays: 30 } as const;

/**
 * "+173%" over the trailing baseline, or null when there is no baseline to be
 * up from.
 *
 * A `new_source` never gets a percentage, **whatever its stored baseline
 * rounds to**: a key that spent a few sub-cent trial amounts across the window
 * has a baseline of one cent, and dividing by it prints a six-figure
 * percentage; a true zero prints `Infinity`. Neither is the fact that matters,
 * which is that the thing is new. Every surface renders `new` instead.
 */
export function costAnomalyDeltaPercent(
  anomaly: Pick<CostAnomaly, "kind" | "actualCents" | "baselineCents">,
): string | null {
  if (anomaly.kind === "new_source") return null;
  if (!(anomaly.baselineCents > 0)) return null;
  const pct = ((anomaly.actualCents - anomaly.baselineCents) / anomaly.baselineCents) * 100;
  if (!Number.isFinite(pct)) return null;
  return `+${Math.round(pct)}%`;
}

/**
 * Recently detected spend anomalies, newest day first (`GET /costs/anomalies`,
 * permission `costs:read`). Detection itself runs server-side after each cost
 * collection pass: there is nothing to trigger from a client.
 */
export async function listCostAnomalies(
  api: CloudFetch,
  orgId: string,
  days: number = COST_ANOMALY_WINDOW.defaultDays,
): Promise<CostAnomaly[]> {
  const clamped = Math.min(
    Math.max(Math.round(days), COST_ANOMALY_WINDOW.minDays),
    COST_ANOMALY_WINDOW.maxDays,
  );
  const res = await api.org<{ anomalies: CostAnomaly[] }>(
    orgId,
    `/costs/anomalies?days=${clamped}`,
  );
  return res?.anomalies ?? [];
}

/**
 * Whether this finding has been explained.
 *
 * One predicate, shared, because every surface needs the same answer and the
 * field is optional on the wire: `undefined` (an older server), `null` (an open
 * question) and an object all have to collapse to one boolean, and three
 * surfaces spelling that themselves is three chances to get it wrong.
 */
export function isCostAnomalyExplained(anomaly: Pick<CostAnomaly, "acknowledgement">): boolean {
  return Boolean(anomaly.acknowledgement);
}

/**
 * How many of these findings nobody has explained yet: the number worth
 * printing next to the section heading.
 *
 * This is what "an acknowledged anomaly stops nagging" means here: explained
 * rows stay in the list, keep their place in the day order, and simply stop
 * counting. Hiding them would lose the detection record and invite the next
 * person to work the same spike out from scratch.
 */
export function countUnexplainedCostAnomalies(anomalies: readonly CostAnomaly[]): number {
  return anomalies.reduce((n, a) => (isCostAnomalyExplained(a) ? n : n + 1), 0);
}

/**
 * Explain a finding (`POST /costs/anomalies/:id/acknowledge`, permission
 * `costs:write`).
 *
 * The server creates the annotation (at the anomaly's own day, org-wide) so
 * no client can put the note on the wrong date, and the model calling this
 * through MCP gets the same artifact a person clicking "Explain" does. Sending
 * it again replaces the sentence (and rewords the note it already made) rather
 * than filing a second one; it will not, however, recreate a note that was
 * deliberately deleted.
 */
export async function acknowledgeCostAnomaly(
  api: CloudFetch,
  orgId: string,
  anomalyId: string,
  explanation: string,
): Promise<CostAnomaly | null> {
  return api.org<CostAnomaly>(
    orgId,
    `/costs/anomalies/${encodeURIComponent(anomalyId)}/acknowledge`,
    { method: "POST", body: JSON.stringify({ explanation }) },
  );
}

/* ------------------------------------------------------------------ *
 * Anomaly tuning: GET/PUT /costs/anomaly-settings.
 * ------------------------------------------------------------------ */

/**
 * The per-org knobs on anomaly detection. Everything else about the model
 * the 28-day baseline, the 3-day re-judged window, the 7-day cooldown, the
 * 7-observed-day guard) is fixed, because those are properties of the data
 * rather than a preference.
 *
 * Money is in cents and denominated in USD; the detector converts each floor
 * into the currency of the series it is judging, so one setting means the same
 * real amount whether a provider bills in dollars or yen.
 */
/**
 * Which anomalies, if any, also page the org's Twilio recipients by SMS.
 *
 * Deliberately one nested choice rather than two orthogonal booleans. The three
 * values order themselves (off ⊂ new sources ⊂ everything) so there is never
 * a combination that needs two different text messages out of one evaluation
 * pass, and the middle value is the one worth having: a spend source appearing
 * from nothing is what a leaked key or a fat-fingered instance type looks like,
 * while a spike on an existing line is usually a busy day.
 */
export type CostAnomalySmsMode = "off" | "new_source" | "all";

export const COST_ANOMALY_SMS_MODES = ["off", "new_source", "all"] as const;

export const COST_ANOMALY_SMS_MODE_LABELS: Record<CostAnomalySmsMode, string> = {
  off: "Never",
  new_source: "New spend sources only",
  all: "Every anomaly",
};

export interface CostAnomalySettings {
  /**
   * How many standard deviations above its own trailing mean a day's spend
   * must land to count as a spike. Lower is more sensitive.
   */
  sigmas: number;
  /**
   * Minimum rise over the baseline mean before a spike alerts, in USD cents.
   * The statistical bar alone flags penny-scale noise as wildly unusual; this
   * is what keeps it quiet.
   */
  minDeltaCents: number;
  /**
   * Minimum first-day spend before a *new spend source* alerts, in USD cents.
   * A provider or service with no spend across the whole trailing window can
   * never clear a sigma bar, so it gets its own absolute floor instead.
   */
  newSourceMinCents: number;
  /**
   * Whether anomalies also text the org's Twilio recipients, and which kinds.
   * Defaults to `off`: every org with Twilio configured for budgets would
   * otherwise start receiving anomaly texts the day this shipped.
   *
   * One batched SMS per evaluation pass summarises whatever that pass alerted
   * on, so turning this on cannot turn a day where thirty services jump into
   * thirty text messages.
   */
  smsAlerts: CostAnomalySmsMode;
  /**
   * Whether repeated `expected` feedback on a provider or service raises its
   * spike threshold (see `costAnomalySigmaNudge`). Defaults to true. Optional
   * on a PUT: omitting it keeps the stored value, so a client that predates
   * the setting cannot switch it off by saving the thresholds.
   */
  feedbackTuning?: boolean | undefined;
  /**
   * Who is emailed about each anomaly, besides the routing rules. Optional on
   * the PUT, unlike every other field here: omitting it leaves the stored list
   * alone, so a client that predates email cannot silently clear it. The GET
   * always carries it.
   */
  emailRecipients?: AlertEmailRecipients | undefined;
}

/**
 * What `GET`/`PUT /costs/anomaly-settings` answer with: the stored settings
 * plus one derived, read-only fact.
 *
 * `smsAlerts` on its own is not enough for a form to tell the truth: an org
 * can select "every anomaly" while having no Twilio credentials, or none of its
 * recipients opted into SMS, and nothing would ever be sent. The server knows;
 * the client cannot (the Twilio settings routes are `org:settings:write`, which
 * a `costs:read` member does not hold), so it is answered here.
 */
export interface CostAnomalySettingsView extends CostAnomalySettings {
  /**
   * True when a page raised right now could actually be delivered: paging is
   * enabled for the org, Twilio credentials and a from-number are stored, and
   * at least one recipient opted into SMS.
   */
  smsConfigured: boolean;
}

/**
 * Bounds the API enforces. They exist to keep a setting from turning detection
 * into either a pager storm or a permanent silence:
 *
 * - `sigmas` below 1 flags roughly a third of ordinary days; 0 flags every day
 *   that is a cent above average. Above 10 nothing short of a 10x jump fires.
 * - The floors must be positive: a floor of zero (or a negative one) removes
 *   the noise filter entirely, and are capped where a floor stops being a
 *   noise filter and starts being a way to switch detection off by accident.
 */
export const COST_ANOMALY_LIMITS = {
  sigmasMin: 1,
  sigmasMax: 10,
  /** $1: below this the floor no longer filters penny noise. */
  minDeltaCentsMin: 100,
  /** $100,000/day. */
  minDeltaCentsMax: 10_000_000,
  newSourceMinCentsMin: 100,
  newSourceMinCentsMax: 10_000_000,
} as const;

/**
 * What an org that has never touched the settings gets: the values anomaly
 * detection shipped with, so leaving the form alone changes nothing.
 */
export const DEFAULT_COST_ANOMALY_SETTINGS: Required<Omit<CostAnomalySettings, "emailRecipients">> =
  {
    sigmas: 3,
    /** $10. */
    minDeltaCents: 1000,
    /**
     * $25. Deliberately above the spike floor: a spike is corroborated by the
     * key's own history, while a new source has none, so it should have to be
     * worth more before it wakes anyone.
     */
    newSourceMinCents: 2500,
    /** Opt-in. Turning an existing Twilio setup into a new pager is a surprise. */
    smsAlerts: "off",
    feedbackTuning: true,
  };
