/**
 * Commitment coverage: how much of the org's usage spend is covered by a
 * reservation, savings plan, or committed-use discount.
 *
 * Pure and db-free on purpose — this is the part that must not lie, and it is
 * testable only if nothing here can reach for a clock or a table. Callers
 * aggregate `cost_daily` into {@link CoverageCell}s and hand them over.
 *
 * ## The basis: amortized, never cash
 *
 * Both sides of every ratio here are **amortized** money, and the callers that
 * aggregate the cells are responsible for that (see
 * `../clickhouse/commitment-readers.ts`). Cash is not an alternative view: AWS
 * prices RI- and SP-covered usage at an unblended rate of zero and Azure prices
 * reservation-covered usage at an `EffectivePrice` of zero, because the money
 * left the account when the commitment was bought. Covered *cash* spend is
 * therefore structurally zero and a cash coverage ratio reads 0% forever, for
 * every org, however much it has committed — an answer-shaped non-answer, worse
 * than the "unavailable" it would replace.
 *
 * The corollary binds the denominator too: `coveredAmount` and
 * `uncoveredAmount` must be the *same* kind of money. A mixed-basis ratio is
 * not a percentage of anything.
 *
 * ## The numerator: two signals, counted once
 *
 * A row is covered when it carries **either** a `commitment_covered_usage`
 * charge type or a non-empty commitment id — and a row carrying both counts
 * once. Neither signal is universally available: Cost Explorer can say *that*
 * an hour was covered but not *which* commitment covered it (`SAVINGS_PLAN_ARN`
 * and `RESERVATION_ID` are filter-only, never groupable), and Azure can say
 * which but only on EA/MCA agreements. A numerator that required the id would
 * read 0% on all of AWS.
 *
 * The denominator is not so tidy — there is **no single honest denominator** —
 * so coverage is reported as a *range*:
 *
 * - **broad** (the lower bound): covered ÷ (covered + *all* uncovered usage).
 *   Over-counts the denominator, because egress, per-request charges and the
 *   like cannot be committed against no matter what you buy.
 * - **narrow** (the upper bound): covered ÷ (covered + uncovered usage in
 *   commitment-*eligible* cells). A cell is `(pluginId, service, region)` and
 *   is eligible when any row in it was covered in the window — provider
 *   evidence that commitments can land there, rather than a hand-maintained
 *   table of committable services that goes stale the day a provider adds one.
 *
 * Only consumption rows participate, on either side — `usage` and
 * `commitment_covered_usage`. A commitment fee in the denominator
 * double-counts the purchase against the usage it bought; a negative discount
 * line can push coverage past 100%. Callers must restrict to those two charge
 * types before aggregating.
 *
 * Accounts whose plugin does not declare `chargeTypes` are excluded entirely:
 * their rows all read as uncovered usage (the plugin cannot tell), and they
 * would drag coverage down for reasons unrelated to purchasing. They are
 * listed in `excludedAccountIds` so the report can say who is missing — and
 * a scope where *every* account is excluded reports unavailable, not 0%,
 * because "we can't tell" and "you own no commitments" are different answers.
 *
 * Currencies are never merged: a ratio of mixed-currency sums is not a
 * percentage of anything. Each currency reports its own range.
 */

/**
 * One `(account, plugin, service, region, currency)` aggregate over the
 * window, restricted to consumption rows: **amortized** spend a commitment
 * covered vs amortized spend it did not. The two must be the same kind of
 * money and must partition the cell — every consumption row lands in exactly
 * one of them.
 */
export interface CoverageCell {
  accountId: string;
  pluginId: string;
  service: string;
  region: string;
  currency: string;
  coveredAmount: number;
  uncoveredAmount: number;
}

/** An account in scope and whether its plugin declares `chargeTypes`. */
export interface CoverageAccount {
  accountId: string;
  chargeTypesDeclared: boolean;
}

export interface CoverageByCurrency {
  currency: string;
  /** Σ amortized consumption a commitment covered. */
  coveredAmount: number;
  /** Σ amortized uncovered consumption, everywhere (the broad denominator's tail). */
  uncoveredAmount: number;
  /** Σ amortized uncovered consumption in commitment-eligible cells only. */
  uncoveredEligibleAmount: number;
  /**
   * Lower bound: covered ÷ (covered + all uncovered). Null when the window has
   * no meaningful base to divide by — no spend, or refunds and corrections
   * having cancelled it out. See {@link ratio}.
   */
  broadRatio: number | null;
  /** Upper bound: covered ÷ (covered + eligible uncovered). Null on the same terms. */
  narrowRatio: number | null;
}

export interface CommitmentCoverageReport {
  /** False when every in-scope account was excluded — unavailable, not 0%. */
  available: boolean;
  currencies: CoverageByCurrency[];
  /** Accounts whose plugin cannot tell usage from anything else. */
  excludedAccountIds: string[];
}

/**
 * Below this, a denominator is not a base to take a percentage of. One unit of
 * the currency — a cent, a yen — is far under any real window's consumption and
 * far over the floating-point residue left when a refund cancels a month of
 * spend, which is the case this exists for.
 */
const MIN_COVERAGE_DENOMINATOR = 1;

/**
 * Coverage as a fraction, or `null` for "unavailable".
 *
 * Both sums here are net of refunds, credits and corrections, and a provider
 * can restate a window's consumption to nothing or below: a reservation
 * returned mid-term, a support credit landing against the month it was billed
 * for, an Azure negative `Usage` line. Three shapes come out of that, and none
 * of them is a percentage:
 *
 * - **A non-positive or near-zero denominator.** `covered + uncovered` at
 *   0.004 with 50 of covered spend divides out to 1,250,000%. The number would
 *   be arithmetically correct and completely meaningless, and it would render
 *   as an answer.
 * - **A negative numerator.** Net covered spend below zero — the refund of a
 *   commitment exceeding what it delivered in the window — is not "negative
 *   coverage", it is a window this measure does not describe.
 * - **A ratio above 1.** Only reachable when the uncovered side went negative,
 *   which says the same thing.
 *
 * Reporting unavailable is the honest output, and it is a state every caller
 * already handles: these fields have always been nullable for the no-spend
 * case. A wrong number here is worse than a missing one, because coverage is
 * read as a purchasing signal.
 */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator < MIN_COVERAGE_DENOMINATOR) return null;
  if (numerator < 0) return null;
  const value = numerator / denominator;
  // The tolerance absorbs float residue on a fully-covered window (where
  // uncovered sums to ~0 across many cells) without absorbing a real overshoot.
  if (value > 1 + 1e-9) return null;
  return Math.min(value, 1);
}

export function computeCommitmentCoverage(
  cells: CoverageCell[],
  accounts: CoverageAccount[],
): CommitmentCoverageReport {
  const excluded = new Set(accounts.filter((a) => !a.chargeTypesDeclared).map((a) => a.accountId));
  const included = accounts.filter((a) => a.chargeTypesDeclared);
  if (included.length === 0) {
    return {
      available: false,
      currencies: [],
      excludedAccountIds: [...excluded].sort(),
    };
  }

  const usable = cells.filter((cell) => !excluded.has(cell.accountId));

  // Eligibility is provider evidence per (plugin, service, region) — pooled
  // across accounts, since a commitment landing in one account's us-east-1
  // EC2 proves the cell is committable for its sibling account too. Evidence
  // is covered *money*, which is why it has to be read on the amortized basis:
  // on cash it is zero everywhere and no cell would ever look eligible.
  const eligibleCells = new Set<string>();
  for (const cell of usable) {
    if (cell.coveredAmount > 0) {
      eligibleCells.add(`${cell.pluginId}\x00${cell.service}\x00${cell.region}`);
    }
  }

  const byCurrency = new Map<
    string,
    { covered: number; uncovered: number; uncoveredEligible: number }
  >();
  for (const cell of usable) {
    let entry = byCurrency.get(cell.currency);
    if (!entry) {
      entry = { covered: 0, uncovered: 0, uncoveredEligible: 0 };
      byCurrency.set(cell.currency, entry);
    }
    entry.covered += cell.coveredAmount;
    entry.uncovered += cell.uncoveredAmount;
    if (eligibleCells.has(`${cell.pluginId}\x00${cell.service}\x00${cell.region}`)) {
      entry.uncoveredEligible += cell.uncoveredAmount;
    }
  }

  const currencies: CoverageByCurrency[] = [...byCurrency.entries()]
    .map(([currency, entry]) => ({
      currency,
      coveredAmount: entry.covered,
      uncoveredAmount: entry.uncovered,
      uncoveredEligibleAmount: entry.uncoveredEligible,
      broadRatio: ratio(entry.covered, entry.covered + entry.uncovered),
      narrowRatio: ratio(entry.covered, entry.covered + entry.uncoveredEligible),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    available: true,
    currencies,
    excludedAccountIds: [...excluded].sort(),
  };
}
