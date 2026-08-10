/**
 * Commitment coverage: how much of the org's usage spend is covered by a
 * reservation, savings plan, or committed-use discount.
 *
 * Pure and db-free on purpose — this is the part that must not lie, and it is
 * testable only if nothing here can reach for a clock or a table. Callers
 * aggregate `cost_daily` into {@link CoverageCell}s and hand them over.
 *
 * The numerator is unambiguous: usage spend on rows stamped with a commitment
 * id. The denominator is not — there is **no single honest denominator** —
 * so coverage is reported as a *range*:
 *
 * - **broad** (the lower bound): covered ÷ (covered + *all* uncovered usage).
 *   Over-counts the denominator, because egress, per-request charges and the
 *   like cannot be committed against no matter what you buy.
 * - **narrow** (the upper bound): covered ÷ (covered + uncovered usage in
 *   commitment-*eligible* cells). A cell is `(pluginId, service, region)` and
 *   is eligible when any row in it carried a commitment id in the window —
 *   provider evidence that commitments can land there, rather than a
 *   hand-maintained table of committable services that goes stale the day a
 *   provider adds one.
 *
 * Only `usage` rows participate, on either side. A commitment fee in the
 *   denominator double-counts the purchase against the usage it bought; a
 *   negative discount line can push coverage past 100%. Callers must filter
 *   to `charge_type = 'usage'` before aggregating.
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
 * window, restricted to `usage` rows: spend on rows carrying a commitment id
 * vs spend on rows carrying none.
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
  /** Σ usage spend on commitment-stamped rows. */
  coveredAmount: number;
  /** Σ uncovered usage spend, everywhere (the broad denominator's tail). */
  uncoveredAmount: number;
  /** Σ uncovered usage spend in commitment-eligible cells only. */
  uncoveredEligibleAmount: number;
  /** Lower bound: covered ÷ (covered + all uncovered). Null when no spend. */
  broadRatio: number | null;
  /** Upper bound: covered ÷ (covered + eligible uncovered). Null when no spend. */
  narrowRatio: number | null;
}

export interface CommitmentCoverageReport {
  /** False when every in-scope account was excluded — unavailable, not 0%. */
  available: boolean;
  currencies: CoverageByCurrency[];
  /** Accounts whose plugin cannot tell usage from anything else. */
  excludedAccountIds: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
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
  // EC2 proves the cell is committable for its sibling account too.
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
