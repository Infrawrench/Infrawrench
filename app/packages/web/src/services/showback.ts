/**
 * The showback report: spend grouped by cost centre through the org's
 * allocation rules. Shared by the HTTP route (`api/routes/cost-centres.ts`)
 * and the tool registry (`tools/costs.ts`), the same split as `cost-query.ts`.
 */
import { UNALLOCATED_KEY, type CostBasis, type ShowbackReport } from "@infrawrench/client-core";
import { listAllocationRules, listCostCentres } from "@infrawrench/server-core/cost/allocation";
import { getShowbackSpend } from "@infrawrench/server-core/clickhouse/cost-readers";

export async function getShowbackReport(
  organizationId: string,
  from: string,
  to: string,
  costBasis?: CostBasis,
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

  return {
    from,
    to,
    currencies: [...new Set(rows.map((r) => r.currency))].sort(),
    centres: centreEntries,
  };
}
