/**
 * Commitment utilization: of the money an org committed to spending, how much
 * did it actually use?
 *
 * Pure and db-free. Callers supply the commitment, the window, the set of
 * days the account has *any* cost data for, and the delivered total; nothing
 * here reaches for a clock or a table.
 *
 * Only money-denominated commitments (those with an `hourlyCommitmentAmount`)
 * are measurable from cost rows:
 *
 *     obligation = hourly × 24 × |active ∩ window ∩ days-we-have-data|
 *     delivered  = Σ usage rows stamped with the commitment id, same day set
 *     utilization = delivered / obligation
 *
 * **The days-we-have-data intersection is the whole trick.** Counting a day
 * the cost collection never ran (backfill still in flight, provider export
 * lagging) puts committed hours in the denominator with no chance of matching
 * spend in the numerator — a fully-used plan reads as under-utilized, and
 * somebody walks off to cancel a healthy commitment. Days without data are
 * excluded from the obligation and reported separately as `missingDays`, so
 * the number that renders is honest about what it measured. The canonical
 * test: five days of data on a plan fully used each of them → 100%, not 50%.
 *
 * Values above 1 are reported unclamped — spending past the commitment is
 * real (usage billed at the discounted rate beyond the committed amount) and
 * clamping it would hide exactly the signal that says "commit more".
 *
 * Unit-denominated commitments (GCP CUDs) return `null` with reason
 * `unit_denominated` — never 0%. Cost rows cannot say how many of the
 * committed vCPUs ran, and in a table that prints 0%, "unknown" and "unused"
 * are indistinguishable; one of those is a purchase order nobody should sign.
 */

export type CommitmentUtilizationUnavailableReason =
  "unit_denominated" | "no_active_days" | "no_data_days";

export interface CommitmentUtilizationInput {
  /** Committed spend per hour; null/undefined for unit-denominated records. */
  hourlyCommitmentAmount?: number | null;
  /** Term start (ISO timestamp or date). */
  startDate?: string | null;
  /** Term end; null means still open-ended as far as the provider said. */
  endDate?: string | null;
  /** Inclusive ISO-day window being measured. */
  window: { from: string; to: string };
  /** ISO days (YYYY-MM-DD) on which the account has any cost rows at all. */
  daysWithData: Iterable<string>;
  /**
   * Σ amount of usage rows stamped with this commitment's id over the window.
   * (Such rows only exist on days with data, so no further intersection is
   * needed on the numerator side.)
   */
  deliveredAmount: number;
}

export interface CommitmentUtilizationResult {
  /** delivered / obligation, unclamped. Null when not measurable. */
  utilization: number | null;
  reason?: CommitmentUtilizationUnavailableReason;
  /** hourly × 24 × measuredDays. Null when not measurable. */
  obligationAmount: number | null;
  deliveredAmount: number;
  /** |active ∩ window| in days. */
  activeDays: number;
  /** |active ∩ window ∩ days-with-data| — what the obligation covers. */
  measuredDays: number;
  /** Active-in-window days with no cost data — reported, never guessed at. */
  missingDays: number;
}

const DAY_MS = 86_400_000;

/** "2026-07-01T…" or "2026-07-01" → "2026-07-01"; empty/invalid → null. */
function isoDayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function addDays(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).valueOf() + n * DAY_MS).toISOString().slice(0, 10);
}

export function computeCommitmentUtilization(
  input: CommitmentUtilizationInput,
): CommitmentUtilizationResult {
  const hourly = input.hourlyCommitmentAmount ?? null;

  // Active ∩ window, as an inclusive ISO-day range.
  const startDay = isoDayOf(input.startDate) ?? input.window.from;
  const endDay = isoDayOf(input.endDate) ?? input.window.to;
  const from = startDay > input.window.from ? startDay : input.window.from;
  const to = endDay < input.window.to ? endDay : input.window.to;

  const base = {
    deliveredAmount: input.deliveredAmount,
  };

  if (hourly === null || hourly === undefined) {
    // Unit-denominated: the question is "are the committed vCPUs running",
    // which cost rows cannot answer. Unknown, not zero.
    return {
      ...base,
      utilization: null,
      reason: "unit_denominated",
      obligationAmount: null,
      activeDays: 0,
      measuredDays: 0,
      missingDays: 0,
    };
  }

  if (from > to) {
    return {
      ...base,
      utilization: null,
      reason: "no_active_days",
      obligationAmount: null,
      activeDays: 0,
      measuredDays: 0,
      missingDays: 0,
    };
  }

  const dataDays =
    input.daysWithData instanceof Set ? input.daysWithData : new Set(input.daysWithData);
  let activeDays = 0;
  let measuredDays = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    activeDays += 1;
    if (dataDays.has(day)) measuredDays += 1;
  }
  const missingDays = activeDays - measuredDays;

  if (measuredDays === 0) {
    // Every active day is a day collection never covered. An obligation of 0
    // would make utilization 0/0; reporting 0% would say "unused" when the
    // truth is "unmeasured".
    return {
      ...base,
      utilization: null,
      reason: "no_data_days",
      obligationAmount: null,
      activeDays,
      measuredDays,
      missingDays,
    };
  }

  const obligationAmount = hourly * 24 * measuredDays;
  return {
    ...base,
    utilization: obligationAmount > 0 ? input.deliveredAmount / obligationAmount : null,
    obligationAmount,
    activeDays,
    measuredDays,
    missingDays,
  };
}
