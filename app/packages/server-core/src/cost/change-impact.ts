/**
 * Cost per change / cost per deploy — the arithmetic. **Pure**: no db, no
 * ClickHouse, no clock of its own (callers pass "today"), which is what makes
 * every rule below exhaustively testable. The gathering lives beside it in
 * `change-impact-load.ts`; the wire contract and phrasing live in
 * `client-core/change-cost-impact.ts`.
 *
 * This is the fourth member of the cost-alert/analysis family and answers a
 * question none of the other three do:
 *
 * - **Budgets** (`budget-eval.ts`) — an absolute monthly total.
 * - **Anomalies** (`anomaly-detect.ts`) — unconfigured statistical outliers.
 * - **Change alerts** (`change-detect.ts`) — a configured *relative* movement
 *   of a cost *scope*. Note the name collision: that module is about spend
 *   changing, this one is about a *resource change event* costing something.
 * - **Change impact** (this module) — "we made this edit; what did it do to
 *   the run rate?"
 *
 * ## Windows, exactly
 *
 * All windows are inclusive complete UTC days, and the change's own day `T` is
 * in **neither**: on the day of the edit the resource was billed partly under
 * the old shape and partly under the new one, so including it drags both
 * numbers toward each other and understates every real delta.
 *
 * - `before` = `[T-w, T-1]`
 * - `after`  = `[T+1, T+w]`
 *
 * Today is never in a window either — the accruing day always reads as a dip.
 * `w` shrinks **symmetrically** to whatever both sides actually support, so
 * the two rates always average the same number of days: a 7-day mean against a
 * 2-day mean compares a settled figure to a noisy one and prints the noise as
 * a finding.
 *
 * ## Charge-type basis
 *
 * One basis per result, named on the result (`costBasis`). The caller picks
 * cash or amortized and both windows are read on the same one. There is no
 * code path here that can mix them, and the reason is that mixing them is
 * indistinguishable from a real saving: an amortized "after" against a cash
 * "before" on a commitment-covered resource shows the discount as a win.
 *
 * ## Period-native providers
 *
 * A `periodNative` plugin files an invoice period's whole amount against the
 * period's **start** day (see KNOWLEDGE's "Period-native plugins must date to
 * the period start"). A 7-day window therefore either contains a month's bill
 * or contains nothing, and neither is a run rate. Those resources return
 * `unknown` with `period_native_provider` rather than a number that would be
 * wrong by a factor of thirty.
 *
 * ## The null that must never become a zero
 *
 * Two facts look identical in a table of cost rows: "this resource was billed
 * nothing" and "we hold no billing for this resource". They are separated here
 * by **collection coverage** — the inclusive day span the org actually
 * collected cost for the resource's account. Inside coverage, a day with no
 * row genuinely cost nothing and is zero-filled. Outside coverage, the day is
 * not part of any window at all. And a resource with no spend *anywhere* in
 * either window is `unknown`, never `$0.00/day`: a security group that was
 * never billable must not report that changing it saved nothing, because that
 * sentence implies we looked.
 */

import type {
  ChangeCostImpact,
  ChangeCostImpactConfidence,
  ChangeCostImpactReason,
  ChangeCostImpactSeries,
  ChangeCostImpactWindow,
  CostBasis,
} from "@infrawrench/client-core";
import {
  clampChangeImpactWindowDays,
  MIN_CHANGE_IMPACT_WINDOW_DAYS,
} from "@infrawrench/client-core";
import { addDays, daysBetween } from "./dates";

export {
  clampChangeImpactWindowDays,
  DEFAULT_CHANGE_IMPACT_WINDOW_DAYS,
  MAX_CHANGE_IMPACT_WINDOW_DAYS,
  MIN_CHANGE_IMPACT_WINDOW_DAYS,
} from "@infrawrench/client-core";

/** Daily points for one currency, as ClickHouse returned them. */
export interface ChangeImpactSeriesInput {
  currency: string;
  /** `{ day: "YYYY-MM-DD", amount }`. Only days that actually have rows. */
  points: Array<{ day: string; amount: number }>;
}

export interface ChangeImpactInput {
  /** UTC day the change landed on. */
  eventDay: string;
  /** Today, UTC. The last *complete* day is `today - 1`. */
  today: string;
  /** Requested half-window; clamped to the supported range. */
  windowDays: number;
  costBasis: CostBasis;
  /**
   * Inclusive day span the org has collected cost for this resource's account,
   * or null when it has collected none. This is the only thing that separates
   * "billed nothing" from "we don't know" — do not synthesise it from the
   * series, which cannot express the difference.
   */
  coverage: { firstDay: string; lastDay: string } | null;
  /** Per-currency daily spend for the resource across the union window. */
  series: ChangeImpactSeriesInput[];
  /** The provider dates whole invoice periods to the period start. */
  periodNative: boolean;
  /** Other recorded changes to the same resource inside the union window. */
  overlappingChanges: number;
  /**
   * False when the resource carries no provider-native id — nothing in
   * `cost_daily` can be keyed to it, so no amount of data would help.
   */
  costAddressable: boolean;
}

/** Confidence floor by comparable days per side. */
const HIGH_CONFIDENCE_DAYS = 7;
const MEDIUM_CONFIDENCE_DAYS = 4;

function unknown(
  input: ChangeImpactInput,
  reasons: ChangeCostImpactReason[],
  overrides: Partial<ChangeCostImpact> = {},
): ChangeCostImpact {
  return {
    status: "unknown",
    costBasis: input.costBasis,
    windowDays: clampChangeImpactWindowDays(input.windowDays),
    effectiveWindowDays: 0,
    eventDay: input.eventDay,
    before: null,
    after: null,
    series: [],
    confidence: "none",
    reasons,
    overlappingChanges: input.overlappingChanges,
    ...overrides,
  };
}

/**
 * Inclusive day count of `[from, to]`, or 0 when the span is inverted. Used to
 * measure how much of a requested window the coverage actually supports.
 */
function spanDays(from: string, to: string): number {
  const days = daysBetween(from, to) + 1;
  return days > 0 ? days : 0;
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

function earlierOf(a: string, b: string): string {
  return a < b ? a : b;
}

/** Sum the points falling inside `[from, to]`. Days with no point are 0. */
function windowTotal(
  points: ReadonlyArray<{ day: string; amount: number }>,
  window: ChangeCostImpactWindow,
): number {
  let total = 0;
  for (const p of points) {
    if (p.day >= window.from && p.day <= window.to) total += p.amount;
  }
  return total;
}

/** Round money to the sub-cent precision the collectors store. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function demote(confidence: ChangeCostImpactConfidence): ChangeCostImpactConfidence {
  switch (confidence) {
    case "high":
      return "medium";
    case "medium":
      return "low";
    case "low":
    case "none":
      return "none";
  }
}

/**
 * Compare a resource's per-day spend either side of a change.
 *
 * Never throws and never guesses: every path that cannot produce a number
 * produces a `status` other than `measured` plus the reasons why.
 */
export function computeChangeCostImpact(input: ChangeImpactInput): ChangeCostImpact {
  const windowDays = clampChangeImpactWindowDays(input.windowDays);

  // Order matters: the categorical impossibilities come first, so a resource
  // that can never be priced says so rather than reporting "not enough days"
  // and inviting someone to wait a week for an answer that will never arrive.
  if (!input.costAddressable) return unknown(input, ["no_cost_identity"]);
  if (input.periodNative) return unknown(input, ["period_native_provider"]);
  if (!input.coverage) return unknown(input, ["no_cost_data"]);

  // The accruing day is never comparable, so the newest usable day is
  // yesterday — and never past what the account has actually collected.
  const lastComplete = earlierOf(addDays(input.today, -1), input.coverage.lastDay);

  const beforeAvailable = spanDays(
    laterOf(addDays(input.eventDay, -windowDays), input.coverage.firstDay),
    earlierOf(addDays(input.eventDay, -1), lastComplete),
  );
  if (beforeAvailable <= 0) return unknown(input, ["no_coverage_before"]);

  const afterAvailable = spanDays(
    laterOf(addDays(input.eventDay, 1), input.coverage.firstDay),
    earlierOf(addDays(input.eventDay, windowDays), lastComplete),
  );
  if (afterAvailable <= 0) return unknown(input, ["no_coverage_after"]);

  const effective = Math.min(windowDays, beforeAvailable, afterAvailable);

  // Both windows are anchored on the event day and are the same length, which
  // is what makes the two means comparable. `effective <= *Available` keeps
  // them inside coverage by construction.
  const before: ChangeCostImpactWindow = {
    from: addDays(input.eventDay, -effective),
    to: addDays(input.eventDay, -1),
  };
  const after: ChangeCostImpactWindow = {
    from: addDays(input.eventDay, 1),
    to: addDays(input.eventDay, effective),
  };

  const reasons: ChangeCostImpactReason[] = [];
  if (effective < windowDays) reasons.push("window_clamped");

  if (effective < MIN_CHANGE_IMPACT_WINDOW_DAYS) {
    return {
      ...unknown(input, [...reasons, "short_window"]),
      status: "insufficient_data",
      effectiveWindowDays: effective,
      before,
      after,
    };
  }

  const series: ChangeCostImpactSeries[] = [];
  let sawSpend = false;
  for (const s of input.series) {
    const beforeTotal = round6(windowTotal(s.points, before));
    const afterTotal = round6(windowTotal(s.points, after));
    if (beforeTotal !== 0 || afterTotal !== 0) sawSpend = true;
    const beforePerDay = round6(beforeTotal / effective);
    const afterPerDay = round6(afterTotal / effective);
    series.push({
      currency: s.currency,
      beforePerDay,
      afterPerDay,
      deltaPerDay: round6(afterPerDay - beforePerDay),
      // A zero "before" has no percentage. Reporting one would divide by
      // nothing and print six figures for a resource that came into being.
      deltaPercent:
        beforeTotal === 0 ? null : Math.round(((afterTotal - beforeTotal) / beforeTotal) * 100),
      beforeTotal,
      afterTotal,
    });
  }

  // Collected across both windows and found nothing at all. That is "we have
  // no cost for this resource", not "this change cost nothing" — the two are
  // different answers and this is where they are kept apart.
  if (!sawSpend) return unknown(input, [...reasons, "no_cost_data"]);

  let confidence: ChangeCostImpactConfidence =
    effective >= HIGH_CONFIDENCE_DAYS
      ? "high"
      : effective >= MEDIUM_CONFIDENCE_DAYS
        ? "medium"
        : "low";

  // A delta is correlation. Where something else touched the same resource in
  // the same window we cannot claim the movement, so we say so and step down
  // rather than quietly taking the credit.
  if (input.overlappingChanges > 0) {
    reasons.push("overlapping_changes");
    confidence = demote(confidence);
  }

  return {
    status: "measured",
    costBasis: input.costBasis,
    windowDays,
    effectiveWindowDays: effective,
    eventDay: input.eventDay,
    before,
    after,
    series: series.sort((a, b) => Math.abs(b.deltaPerDay) - Math.abs(a.deltaPerDay)),
    confidence,
    reasons,
    overlappingChanges: input.overlappingChanges,
  };
}

/**
 * The widest span any of a set of windows can reach, so a batched caller can
 * fetch every resource's cost in one read. Returns null for an empty set.
 */
export function changeImpactFetchRange(
  eventDays: readonly string[],
  windowDays: number,
): { from: string; to: string } | null {
  const w = clampChangeImpactWindowDays(windowDays);
  let from: string | undefined;
  let to: string | undefined;
  for (const day of eventDays) {
    const lo = addDays(day, -w);
    const hi = addDays(day, w);
    if (from === undefined || lo < from) from = lo;
    if (to === undefined || hi > to) to = hi;
  }
  return from === undefined || to === undefined ? null : { from, to };
}

/**
 * Sum a set of per-resource impacts into a deployment total.
 *
 * Only `measured` rows contribute — an unknown resource adds nothing rather
 * than zero, and is counted separately so the total can never quietly claim to
 * cover resources it could not price. The confidence is the **weakest** among
 * the contributors: a breakdown is only as trustworthy as its worst row.
 */
export function sumChangeCostImpacts(impacts: readonly ChangeCostImpact[]): {
  total: Array<{ currency: string; deltaPerDay: number }>;
  unknownResources: number;
  confidence: ChangeCostImpactConfidence;
} {
  const byCurrency = new Map<string, number>();
  let unknownResources = 0;
  let confidence: ChangeCostImpactConfidence | null = null;
  const rank: Record<ChangeCostImpactConfidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

  for (const impact of impacts) {
    if (impact.status !== "measured") {
      unknownResources += 1;
      continue;
    }
    for (const s of impact.series) {
      byCurrency.set(s.currency, round6((byCurrency.get(s.currency) ?? 0) + s.deltaPerDay));
    }
    if (confidence === null || rank[impact.confidence] < rank[confidence]) {
      confidence = impact.confidence;
    }
  }

  return {
    total: [...byCurrency.entries()]
      .map(([currency, deltaPerDay]) => ({ currency, deltaPerDay }))
      .sort((a, b) => Math.abs(b.deltaPerDay) - Math.abs(a.deltaPerDay)),
    unknownResources,
    confidence: confidence ?? "none",
  };
}
