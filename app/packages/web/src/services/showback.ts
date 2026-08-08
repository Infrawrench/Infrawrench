/**
 * The showback report: spend grouped by cost centre through the org's
 * allocation rules. Shared by the HTTP route (`api/routes/cost-centres.ts`)
 * and the tool registry (`tools/costs.ts`), the same split as `cost-query.ts`.
 */
import {
  UNALLOCATED_KEY,
  type CostBasis,
  type CostConversion,
  type ShowbackReport,
} from "@infrawrench/client-core";
import { listAllocationRules, listCostCentres } from "@infrawrench/server-core/cost/allocation";
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
 */
export async function getShowbackReport(
  organizationId: string,
  from: string,
  to: string,
  costBasis?: CostBasis,
  displayCurrency?: string,
): Promise<ShowbackReport> {
  const [centres, rules] = await Promise.all([
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
  ]);
  const centreNames = new Map(centres.map((c) => [c.id, c.name]));

  // Rules pointing at a deleted centre can't exist (FK cascade), but guard
  // anyway: an unknown centre id must not silently relabel spend.
  const orderedRules = rules
    .filter((r) => centreNames.has(r.costCentreId))
    .map((r) => ({ costCentreId: r.costCentreId, match: r.match }));

  // Follows the caller's basis. Charging a team the full cash value of a
  // three-year commitment in the month it was signed is not a chargeback
  // anyone can budget against.
  const rows = await getShowbackSpend(organizationId, orderedRules, from, to, costBasis);

  const byCentre = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const key = row.costCentreId || UNALLOCATED_KEY;
    const bucket = byCentre.get(key) ?? {};
    bucket[row.currency] = (bucket[row.currency] ?? 0) + row.amount;
    byCentre.set(key, bucket);
  }

  const centreEntries: ShowbackReport["centres"] = [];
  // Every defined centre appears, even with zero spend — a showback report
  // with silently missing centres reads as a data loss, not an empty bucket.
  for (const centre of centres) {
    centreEntries.push({
      costCentreId: centre.id,
      name: centre.name,
      totals: byCentre.get(centre.id) ?? {},
    });
  }
  const unallocated = byCentre.get(UNALLOCATED_KEY);
  if (unallocated && Object.keys(unallocated).length > 0) {
    centreEntries.push({ costCentreId: null, name: "Unallocated", totals: unallocated });
  }

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

  const converted = centreEntries.map((entry) => ({
    ...entry,
    totals: convertTotals(entry.totals, target, rates, to).totals,
  }));

  return {
    from,
    to,
    currencies: [...new Set(converted.flatMap((c) => Object.keys(c.totals)))].sort(),
    centres: converted,
    ...(conversion ? { conversion } : {}),
  };
}
