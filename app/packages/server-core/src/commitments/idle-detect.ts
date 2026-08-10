/**
 * Idle-commitment detection — **pure**. No db, no ClickHouse, no clock, no
 * network.
 *
 * Utilization has been computed and rendered since commitments shipped
 * (`utilization.ts`); nothing has ever *told* anyone about it. A commitment at
 * 20% is money that already left the account and bought nothing, and unlike
 * every other finding in the cost surface it does not get worse — it just
 * keeps not getting better until someone looks at the page.
 *
 * ## Rule 1: never alert on a null utilization
 *
 * This is the sharpest edge in the whole feature and it is worth stating as
 * loudly as the code allows. {@link computeCommitmentUtilization} returns
 * `null` in four situations, and every one of them means **unknown**:
 *
 * - `unit_denominated` — a GCP CUD commits vCPUs, not dollars. Cost rows
 *   cannot say how many of the committed vCPUs ran.
 * - `no_data_days` — every active day in the window is a day collection never
 *   covered (backfill in flight, provider export lagging).
 * - `no_active_days` — the commitment's term does not overlap the window.
 * - a zero obligation, which would make the ratio 0/0.
 *
 * In a table, "unknown" and "unused" look different. In a threshold
 * comparison they do not: `null < 0.7` is `false` in JavaScript, which is the
 * safe direction by luck rather than by design, and one refactor to
 * `(utilization ?? 0) < threshold` would page an org about every healthy CUD
 * it owns and every commitment whose account had a bad collection night. So
 * the null case is an **explicit early return with its own skip reason**,
 * before any arithmetic, and there is a test for each of the four reasons.
 *
 * The same rule covers the fifth null this module adds itself: an account
 * whose plugin does not declare `costs.chargeTypes` produces cost rows with no
 * commitment attribution, so delivered reads 0 for a plan that is working
 * perfectly. `attributed: false` skips before anything is measured — the same
 * decision `commitments/feed.ts` makes when it reports
 * `reason: "unattributed_rows"` rather than 0%.
 *
 * ## Rule 2: a window, not a day
 *
 * The finding is computed from **one aggregate over the whole window**
 * (Σdelivered ÷ Σobligation over the days that carried data), not from a count
 * of bad days. That is what makes "a weekend is not a finding" true by
 * construction rather than by a fudge factor: a weekday-only workload on a
 * 30-day window sits around 71% — five sevenths of the term, plus whatever
 * runs at the weekend — which is above the 70% default and does not fire. Drop
 * the window to a week and the same workload reads the same 71%, because the
 * ratio is scale-free. What a short window actually costs is *confidence*, and
 * {@link IdleCommitmentOptions.minMeasuredDays} is the knob that buys it back.
 *
 * ## Rule 3: money, not a percentage
 *
 * A 20% commitment is a headline; `obligation − delivered` is the number
 * somebody takes to a renewal meeting. Every finding carries it, and the floor
 * that decides whether to speak at all is denominated in it — a 4% commitment
 * wasting $3 a month is true and worthless.
 */
import {
  computeCommitmentUtilization,
  type CommitmentUtilizationUnavailableReason,
} from "./utilization";

/** Why a commitment produced no finding. Returned, never silently dropped. */
export type IdleCommitmentSkipReason =
  /** Utilization was not measurable — see rule 1. Carries which case it was. */
  | CommitmentUtilizationUnavailableReason
  /** The account's cost rows carry no commitment attribution. */
  | "unattributed_rows"
  /** Not active during the window (expired, or not started). */
  | "not_active"
  /** Too few days in the window carried cost data to judge on. */
  | "insufficient_measured_days"
  /** At or above the threshold — the commitment is doing its job. */
  | "not_idle"
  /** Idle, but the money involved is too small to say anything about. */
  | "waste_below_floor";

export interface IdleCommitmentInput {
  accountId: string;
  commitmentId: string;
  description: string;
  kind: string;
  /** "active" | "queued" | "expired" — the provider's own word. */
  state: string;
  currency: string | null;
  /** Committed spend per hour; null/undefined for unit-denominated records. */
  hourlyCommitmentAmount: number | null;
  /** Term bounds, ISO timestamps or days. */
  startDate: string | null;
  endDate: string | null;
  /**
   * False when the account's plugin does not declare `costs.chargeTypes`, so
   * its rows carry no commitment id and delivered would read 0 for a healthy
   * plan. Skipped outright — see rule 1.
   */
  attributed: boolean;
  /** ISO days on which the account has any cost rows at all. */
  daysWithData: Iterable<string>;
  /** Σ amortized consumption stamped with this commitment's id over the window. */
  deliveredAmount: number;
}

export interface IdleCommitmentOptions {
  /** Utilization percent (0–100) the window must stay under. */
  thresholdPercent: number;
  /** Window days that must carry cost data before anything is judged. */
  minMeasuredDays: number;
  /**
   * Least wasted money before alerting, **in the units of the commitment's own
   * currency**. The caller restates its USD-denominated setting per currency
   * (`usdFloorIn` in `cost/anomaly-detect.ts`) exactly the way the anomaly
   * detector does, so one org-level number means the same real amount against
   * a provider that bills in dollars and one that bills in yen.
   */
  minWasteAmount: number;
}

export interface IdleCommitmentFinding {
  accountId: string;
  commitmentId: string;
  description: string;
  kind: string;
  currency: string | null;
  window: { from: string; to: string };
  /** delivered ÷ obligation over the measured days, unclamped, 0–1 scale. */
  utilization: number;
  /** hourly × 24 × measuredDays, in `currency` units. */
  obligationAmount: number;
  deliveredAmount: number;
  /** obligation − delivered, floored at 0 — the money that bought nothing. */
  wastedAmount: number;
  measuredDays: number;
  /** Active window days with no cost data. Reported so the reader can discount. */
  missingDays: number;
}

export interface IdleCommitmentResult {
  findings: IdleCommitmentFinding[];
  skipped: Array<{
    accountId: string;
    commitmentId: string;
    reason: IdleCommitmentSkipReason;
  }>;
}

/**
 * Judge one commitment. Exported alongside the batch entry point because every
 * branch below is worth a test of its own.
 */
export function judgeIdleCommitment(
  commitment: IdleCommitmentInput,
  window: { from: string; to: string },
  options: IdleCommitmentOptions,
): IdleCommitmentFinding | IdleCommitmentSkipReason {
  // A queued commitment has not started; an expired one cannot be acted on.
  // Neither is "idle", and both would otherwise land in `no_active_days`
  // wearing a reason that reads like a data problem.
  if (commitment.state !== "active") return "not_active";

  // Rule 1, part one: no attribution means delivered reads 0 for a plan that
  // may be working perfectly. Checked *before* the utilization call so the
  // result can never be mistaken for a measured zero.
  if (commitment.attributed === false) return "unattributed_rows";

  const measured = computeCommitmentUtilization({
    hourlyCommitmentAmount: commitment.hourlyCommitmentAmount,
    startDate: commitment.startDate,
    endDate: commitment.endDate,
    window,
    daysWithData: commitment.daysWithData,
    deliveredAmount: commitment.deliveredAmount,
  });

  // Rule 1, part two, and the load-bearing line of this module: a null
  // utilization is UNKNOWN and never alerts. Not `?? 0`, not `< threshold`,
  // not "treat missing as idle". `reason` is carried through so the skip says
  // which of the four unknowns it was.
  if (measured.utilization === null) {
    return measured.reason ?? "no_data_days";
  }

  // Rule 2: enough of the window has to be real data before a ratio computed
  // from it is worth acting on.
  if (measured.measuredDays < options.minMeasuredDays) return "insufficient_measured_days";

  const threshold = options.thresholdPercent / 100;
  if (measured.utilization >= threshold) return "not_idle";

  const obligationAmount = measured.obligationAmount ?? 0;
  // Floored: an over-used commitment cannot be here (it fails `not_idle`
  // first), but a rounding wobble must not produce negative "waste".
  const wastedAmount = Math.max(0, obligationAmount - measured.deliveredAmount);

  // Rule 3: the floor is on the money, not the percentage.
  if (wastedAmount < options.minWasteAmount) return "waste_below_floor";

  return {
    accountId: commitment.accountId,
    commitmentId: commitment.commitmentId,
    description: commitment.description,
    kind: commitment.kind,
    currency: commitment.currency,
    window,
    utilization: measured.utilization,
    obligationAmount,
    deliveredAmount: measured.deliveredAmount,
    wastedAmount,
    measuredDays: measured.measuredDays,
    missingDays: measured.missingDays,
  };
}

/** Judge a whole inventory. Findings come back worst (most wasted) first. */
export function detectIdleCommitments(
  commitments: IdleCommitmentInput[],
  window: { from: string; to: string },
  options: IdleCommitmentOptions,
): IdleCommitmentResult {
  const findings: IdleCommitmentFinding[] = [];
  const skipped: IdleCommitmentResult["skipped"] = [];

  for (const commitment of commitments) {
    const verdict = judgeIdleCommitment(commitment, window, options);
    if (typeof verdict === "string") {
      skipped.push({
        accountId: commitment.accountId,
        commitmentId: commitment.commitmentId,
        reason: verdict,
      });
      continue;
    }
    findings.push(verdict);
  }

  findings.sort(
    (a, b) => b.wastedAmount - a.wastedAmount || a.description.localeCompare(b.description),
  );
  return { findings, skipped };
}
