/**
 * The showback report: spend grouped by cost centre through the org's
 * allocation rules. Shared by the HTTP route (`api/routes/cost-centres.ts`)
 * and the tool registry (`tools/costs.ts`), the same split as `cost-query.ts`.
 *
 * Cost centres nest, so the report is a tree: each row carries the spend
 * allocated **directly** to it (`totals`) alongside its own plus every
 * descendant's (`subtreeTotals`). Both matter — "Engineering $40k, of which
 * Platform $12k" is the shape a finance conversation actually takes, and only
 * one of those numbers can be read off a single figure.
 *
 * The nesting never reaches the database. One `multiIf` over `cost_daily`
 * resolves each row to exactly one centre in one scan (see `getShowbackSpend`);
 * everything below is arithmetic over that result.
 */
import {
  billingAdjustmentsAreEmpty,
  buildShowbackCentres,
  fixedRuleAmountForRange,
  UNALLOCATED_KEY,
  type CostAdjustmentSummary,
  type CostBasis,
  type CostConversion,
  type ShowbackReport,
} from "@infrawrench/client-core";
import { listAllocationRules, listCostCentres } from "@infrawrench/server-core/cost/allocation";
import { resolveBillingAdjustments } from "@infrawrench/server-core/cost/billing-rules";
import { getShowbackSpend } from "@infrawrench/server-core/clickhouse/cost-readers";
import { convertTotals } from "@infrawrench/server-core/cost/currency-convert";
import { loadConversionContext } from "@infrawrench/server-core/cost/currency-settings";

/**
 * `displayCurrency` is opt-in and only honoured when the org has configured
 * that currency; absent, the report is per-currency exactly as before.
 *
 * A showback report converts on **one** rate — the one in force on `to`, the
 * last day of the period — rather than per day. Unlike a graph these are
 * period totals with no day attached to convert against, and a chargeback is a
 * statement about a closed period: "August, at the August rate" is a sentence a
 * finance team can defend, where "August at a blend of whatever rates the
 * underlying days happened to fall under" is not one they can reproduce.
 *
 * `adjusted` layers the org's billing rules on: markups multiply, and a
 * reallocation moves a centre's spend onto another centre. Off by default, like
 * every other adjusted surface — a chargeback report that silently showed
 * marked-up numbers is one nobody could reconcile against the invoice. On, the
 * report carries `adjustment` with the collected totals beside them.
 *
 * Showback is the one report where a **fixed-amount** rule is fully attributed:
 * "the platform team charges $5,000/month to Engineering" is precisely a
 * chargeback line, so the pro-rated amount is added to its target centre's own
 * spend (and to the unallocated bucket when the rule names no target). It is
 * still reported separately in `adjustment.fixedTotals` so it can be subtracted
 * back out.
 */
export async function getShowbackReport(
  organizationId: string,
  from: string,
  to: string,
  costBasis?: CostBasis,
  displayCurrency?: string,
  adjusted?: boolean,
): Promise<ShowbackReport> {
  const [centres, rules, billing] = await Promise.all([
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
    adjusted ? resolveBillingAdjustments(organizationId) : Promise.resolve(null),
  ]);
  const centreIds = new Set(centres.map((c) => c.id));

  // Rules pointing at a deleted centre can't exist (FK cascade), but guard
  // anyway: an unknown centre id must not silently relabel spend.
  //
  // `listAllocationRules` already returns evaluation order — ascending
  // priority, then the more deeply nested centre first on a tie. Nesting stops
  // here: `getShowbackSpend` compiles this flat list into one `multiIf` and
  // resolves each row to exactly one centre in a single scan of `cost_daily`,
  // and the tree is assembled from the resulting sums below. A per-segment
  // query would be one scan per node of the tree for the same answer.
  const orderedRules = rules
    .filter((r) => centreIds.has(r.costCentreId))
    .map((r) => ({ costCentreId: r.costCentreId, match: r.match }));

  // Follows the caller's basis. Charging a team the full cash value of a
  // three-year commitment in the month it was signed is not a chargeback
  // anyone can budget against.
  // The billing rules ride into the same scan: percentage factors multiply the
  // summed amount, cost-centre reallocations wrap the allocation `multiIf`, and
  // `rawAmount` comes back from the same pass. Omitted when the org has no
  // rules, so an unadjusted report issues the query it always has.
  const compiled =
    billing && !billingAdjustmentsAreEmpty(billing.adjustments) ? billing.adjustments : undefined;
  const rows = await getShowbackSpend(organizationId, orderedRules, from, to, costBasis, compiled);

  const byCentre = new Map<string, Record<string, number>>();
  const rawByCentre = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const key = row.costCentreId || UNALLOCATED_KEY;
    const bucket = byCentre.get(key) ?? {};
    bucket[row.currency] = (bucket[row.currency] ?? 0) + row.amount;
    byCentre.set(key, bucket);
    if (row.rawAmount !== undefined) {
      const raw = rawByCentre.get(key) ?? {};
      raw[row.currency] = (raw[row.currency] ?? 0) + row.rawAmount;
      rawByCentre.set(key, raw);
    }
  }

  // Fixed amounts, pro-rated over the range and booked onto the centre they
  // name. Added after the scan because nothing in `cost_daily` produced them —
  // a flat overhead is owed whether or not the provider billed anything.
  const fixedTotals: Record<string, number> = {};
  for (const rule of billing?.adjustments.fixed ?? []) {
    const amount = fixedRuleAmountForRange(rule, from, to);
    if (amount === 0) continue;
    fixedTotals[rule.currency] = (fixedTotals[rule.currency] ?? 0) + amount;
    // A rule that names an account has no centre to land on here, and a rule
    // that names nothing is an org-level charge: both go to Unallocated rather
    // than being invented onto a centre that never agreed to them.
    const key =
      rule.targetKind === "cost_centre" && rule.targetId && centreIds.has(rule.targetId)
        ? rule.targetId
        : UNALLOCATED_KEY;
    const bucket = byCentre.get(key) ?? {};
    bucket[rule.currency] = (bucket[rule.currency] ?? 0) + amount;
    byCentre.set(key, bucket);
  }

  // Every defined centre appears, even with zero spend — a showback report
  // with silently missing centres reads as a data loss, not an empty bucket —
  // and the unallocated bucket keeps its own first-class row at the end rather
  // than being folded into a parent.
  const centreEntries: ShowbackReport["centres"] = buildShowbackCentres(
    centres,
    byCentre,
    byCentre.get(UNALLOCATED_KEY),
  );

  const { displayCurrency: target, rates } = await loadConversionContext(
    organizationId,
    displayCurrency,
  );

  // The conversion report is derived once from the org-wide totals rather than
  // unioned from the per-centre passes: the caveat a reader needs ("EUR was
  // converted at 1.09; SEK could not be and is still in SEK") is a statement
  // about the period, and a centre that happens to hold no SEK must not make
  // it look like the period held none either.
  const combined: Record<string, number> = {};
  for (const row of rows) combined[row.currency] = (combined[row.currency] ?? 0) + row.amount;
  const conversion: CostConversion | null = convertTotals(combined, target, rates, to).conversion;

  // Own and subtree amounts convert independently on the same rate, so a
  // parent's subtree figure stays the sum of the converted numbers underneath
  // it rather than a separately-rounded second opinion.
  const converted = centreEntries.map((entry) => ({
    ...entry,
    totals: convertTotals(entry.totals, target, rates, to).totals,
    subtreeTotals: convertTotals(entry.subtreeTotals, target, rates, to).totals,
  }));

  // The collected figures, converted the same way and on the same day as the
  // adjusted ones — a chargeback statement has to be reconcilable against the
  // invoice line for line, and a raw total converted on a different rate would
  // differ from the adjusted one by a currency movement rather than a markup.
  let adjustment: CostAdjustmentSummary | undefined;
  if (billing) {
    const rawCombined: Record<string, number> = {};
    for (const row of rows) {
      const raw = row.rawAmount ?? row.amount;
      rawCombined[row.currency] = (rawCombined[row.currency] ?? 0) + raw;
    }
    adjustment = {
      rules: billing.rules,
      rawTotals: convertTotals(rawCombined, target, rates, to).totals,
      fixedTotals: convertTotals(fixedTotals, target, rates, to).totals,
    };
  }

  return {
    from,
    to,
    currencies: [...new Set(converted.flatMap((c) => Object.keys(c.subtreeTotals)))].sort(),
    centres: converted,
    ...(conversion ? { conversion } : {}),
    ...(adjustment ? { adjustment } : {}),
  };
}
