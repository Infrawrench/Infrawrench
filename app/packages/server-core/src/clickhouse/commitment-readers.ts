/**
 * ClickHouse aggregates feeding the commitment modules
 * (`../commitments/{coverage,utilization,planner}.ts`: all pure; every
 * query here exists to hand them their inputs and nothing else).
 *
 * ─── Everything here is amortized, and that is not a preference ────────────
 *
 * Every money expression below is {@link amortizedAmountExpr}, never `amount`.
 * Cash is not merely a different view for these three readers: it is
 * structurally zero on exactly the rows they are about:
 *
 * - AWS prices RI-covered usage at an unblended rate of zero ("For Amazon EC2
 *   and Amazon RDS line items that have an RI discount applied to them, the
 *   `UnblendedRate` is zero"), and Savings-Plan-covered usage the same way.
 * - Azure prices reservation-covered usage at an `EffectivePrice` of zero in
 *   the `ActualCost` dataset.
 *
 * The money left the account when the commitment was *bought*, so on a cash
 * basis covered spend is nothing, everywhere, forever. A coverage ratio built
 * on it reads 0% no matter how much an org has committed, which is worse than
 * the honest "unavailable" it replaced, because 0% looks like an answer.
 *
 * The consequence is a rule: **numerator and denominator must share this
 * basis.** A mixed-basis ratio (amortized covered spend over cash uncovered
 * spend, say) is not a percentage of anything, and it would be wrong in the
 * direction that gets a healthy commitment cancelled. So the uncovered side of
 * `getCommitmentCoverageCells`, the delivered total behind utilization, and the
 * planner's uncovered series are all amortized too. For uncovered on-demand
 * usage the two bases agree anyway (nothing to spread), so this costs nothing
 * where it does not apply: it just removes the chance of them disagreeing.
 *
 * ─── What counts as covered ───────────────────────────────────────────────
 *
 * Two independent signals, because no provider supplies both universally:
 *
 * - `charge_type = 'commitment_covered_usage'`: "a commitment covered this
 *   hour". AWS can say this (`RECORD_TYPE` of `DiscountedUsage` /
 *   `SavingsPlanCoveredUsage`) and cannot say which commitment: Cost Explorer's
 *   `SAVINGS_PLAN_ARN` and `RESERVATION_ID` are filter-only dimensions and
 *   cannot be grouped by.
 * - `commitment_id != ''`: "*this* commitment covered it". Azure can say this
 *   (`BenefitId`) but only on EA/MCA agreements.
 *
 * Coverage counts a row carrying **either**, and a row carrying both exactly
 * once: see the `OR` in the numerator and its exact complement in the
 * denominator. Per-commitment utilization, which cannot work from the charge
 * type alone, still requires the id.
 *
 * ─── Which rows are eligible at all ───────────────────────────────────────
 *
 * Coverage and utilization restrict to consumption:
 * `charge_type IN ('usage', 'commitment_covered_usage')`. A commitment fee in
 * a coverage denominator double-counts the purchase against the usage it
 * bought, and a negative discount line can push coverage past 100%. The caller
 * further restricts to accounts whose plugin declares `chargeTypes` (via the
 * `accountIds` parameters), for everyone else `usage` is just the default
 * stamp, not a claim.
 */
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured, type ClickHouseDb } from "./client";
import { amortizedAmountExpr, costDailyOrgCondition, dayRange } from "./cost-readers";
import { costDaily } from "./schema";

async function query<T>(build: (db: ClickHouseDb) => Promise<T[]>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  return await build(getClickHouseDb());
}

/** The charge type a provider stamps on consumption a commitment covered. */
const COVERED_CHARGE_TYPE = "commitment_covered_usage";

/**
 * Consumption, at whatever rate it was billed. Both members, because covered
 * usage is still usage: dropping it here would shrink every denominator by
 * exactly the spend a commitment touches.
 */
export const CONSUMPTION_CHARGE_TYPES: readonly string[] = ["usage", COVERED_CHARGE_TYPE];

export function consumptionCondition(): SQL {
  return inArray(costDaily.charge_type, [...CONSUMPTION_CHARGE_TYPES]);
}

/** Carries either coverage signal. */
export function coveredCondition(): SQL {
  return sql`(${eq(costDaily.charge_type, COVERED_CHARGE_TYPE)} OR ${ne(costDaily.commitment_id, "")})`;
}

/** Carries neither: the exact complement of {@link coveredCondition}, so no row is counted twice. */
export function uncoveredCondition(): SQL {
  return sql`(${ne(costDaily.charge_type, COVERED_CHARGE_TYPE)} AND ${eq(costDaily.commitment_id, "")})`;
}

/** Where one cost row lands in the coverage partition. */
export type CoverageRowClass = "covered" | "uncovered" | "not_consumption";

/**
 * The specification the three SQL fragments above transliterate: every row
 * lands in **exactly one** class, so a row carrying both coverage signals; a
 * `commitment_covered_usage` row that also names its commitment, which is what
 * a provider reporting both produces; is counted once, not twice.
 *
 * Kept as real code rather than prose because the partition is the property
 * that makes the ratio a percentage: `coveredCondition` and `uncoveredCondition`
 * are its De Morgan pair, and a test that exercises this function is testing the
 * same rule the queries run.
 */
export function classifyCoverageRow(chargeType: string, commitmentId: string): CoverageRowClass {
  if (!CONSUMPTION_CHARGE_TYPES.includes(chargeType)) return "not_consumption";
  return chargeType === COVERED_CHARGE_TYPE || commitmentId !== "" ? "covered" : "uncovered";
}

/** One coverage aggregate: the pure module's `CoverageCell`, unmapped. */
export interface CoverageCellRow {
  account_id: string;
  plugin_id: string;
  service: string;
  region: string;
  currency: string;
  covered_amount: number;
  uncovered_amount: number;
}

/**
 * Amortized consumption per (account, plugin, service, region, currency) over
 * the window, split by whether a commitment covered it.
 */
export async function getCommitmentCoverageCells(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<CoverageCellRow[]> {
  if (accountIds.length === 0) return [];
  const money = amortizedAmountExpr();
  const rows = await query((db) =>
    db
      .select({
        account_id: costDaily.account_id,
        plugin_id: costDaily.plugin_id,
        service: costDaily.service,
        region: costDaily.region,
        currency: costDaily.currency,
        covered_amount: sql<number>`sumIf(${money}, ${coveredCondition()})`.as("covered_amount"),
        uncovered_amount: sql<number>`sumIf(${money}, ${uncoveredCondition()})`.as(
          "uncovered_amount",
        ),
      })
      .from(costDaily)
      .final()
      .where(
        and(
          costDailyOrgCondition(organizationId),
          dayRange(from, to),
          consumptionCondition(),
          inArray(costDaily.account_id, accountIds),
        ),
      )
      .groupBy(
        costDaily.account_id,
        costDaily.plugin_id,
        costDaily.service,
        costDaily.region,
        costDaily.currency,
      ),
  );
  return rows.map((r) => ({
    ...r,
    covered_amount: Number(r.covered_amount),
    uncovered_amount: Number(r.uncovered_amount),
  }));
}

/**
 * Which days each account has *any* cost rows for: the days-we-have-data
 * set that keeps a collection gap from reading as an idle commitment. Any
 * charge type counts: a day with only a tax line is still a day the
 * collection ran.
 */
export async function getAccountDataDays(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<Map<string, Set<string>>> {
  if (accountIds.length === 0) return new Map();
  const rows = await query((db) =>
    db
      .selectDistinct({
        account_id: costDaily.account_id,
        day: sql<string>`toString(${costDaily.day})`.as("day"),
      })
      .from(costDaily)
      .where(
        and(
          costDailyOrgCondition(organizationId),
          dayRange(from, to),
          inArray(costDaily.account_id, accountIds),
        ),
      ),
  );
  const result = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = result.get(r.account_id);
    if (!set) {
      set = new Set();
      result.set(r.account_id, set);
    }
    set.add(r.day);
  }
  return result;
}

/** Delivered usage per (account, commitment id, currency) over the window. */
export interface CommitmentDeliveredRow {
  account_id: string;
  commitment_id: string;
  currency: string;
  amount: number;
}

/**
 * Amortized consumption attributable to each specific commitment. Unlike
 * coverage this *does* need `commitment_id` ("was this plan used" is a
 * per-holding question and the charge type alone cannot answer it) so
 * providers that report covered usage without an id contribute nothing here
 * and their holdings report utilization as unmeasured rather than as 0%.
 */
export async function getCommitmentDeliveredTotals(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<CommitmentDeliveredRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await query((db) =>
    db
      .select({
        account_id: costDaily.account_id,
        commitment_id: costDaily.commitment_id,
        currency: costDaily.currency,
        amount: sql<number>`sum(${amortizedAmountExpr()})`.as("amount"),
      })
      .from(costDaily)
      .final()
      .where(
        and(
          costDailyOrgCondition(organizationId),
          dayRange(from, to),
          consumptionCondition(),
          ne(costDaily.commitment_id, ""),
          inArray(costDaily.account_id, accountIds),
        ),
      )
      .groupBy(costDaily.account_id, costDaily.commitment_id, costDaily.currency),
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** One day's uncovered usage spend in one (plugin, service, region) cell. */
export interface UncoveredDailyRow {
  plugin_id: string;
  service: string;
  region: string;
  currency: string;
  day: string;
  amount: number;
}

/**
 * The planner's raw series: uncovered consumption per cell per day. Days a
 * cell spent nothing simply have no row: the pure planner treats absence
 * as zero.
 *
 * `uncoveredCondition` here is the same predicate coverage's denominator uses,
 * and the money is amortized for the same reason: the planner's "you could
 * commit to this" sits on the same screen as the coverage range, and two
 * numbers about the same uncovered spend must not be computed on different
 * bases.
 */
export async function getUncoveredDailySpend(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<UncoveredDailyRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await query((db) =>
    db
      .select({
        plugin_id: costDaily.plugin_id,
        service: costDaily.service,
        region: costDaily.region,
        currency: costDaily.currency,
        day: sql<string>`toString(${costDaily.day})`.as("day"),
        amount: sql<number>`sum(${amortizedAmountExpr()})`.as("amount"),
      })
      .from(costDaily)
      .final()
      .where(
        and(
          costDailyOrgCondition(organizationId),
          dayRange(from, to),
          consumptionCondition(),
          uncoveredCondition(),
          inArray(costDaily.account_id, accountIds),
        ),
      )
      .groupBy(
        costDaily.plugin_id,
        costDaily.service,
        costDaily.region,
        costDaily.currency,
        sql`day`,
      ),
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/* ------------------------------------------------------------------ *
 * Commitment reports
 * ------------------------------------------------------------------ */

/** Bucket sizes a commitment report reads at; days are the finest the table holds. */
export type CommitmentReportBucketSize = "daily" | "weekly" | "monthly" | "quarterly";

/**
 * The split a commitment report query groups by. `commitment` keys each row
 * by its commitment id, `__unattributed__` for covered usage or an unused fee
 * with no id, and `__on_demand__` for uncovered usage; commitment *type* is
 * that same key mapped through the inventory by the caller.
 */
export type CommitmentReportSplit =
  "none" | "provider" | "service" | "account" | "region" | "commitment";

export interface CommitmentReportCellQuery {
  from: string;
  to: string;
  bucket: CommitmentReportBucketSize;
  split: CommitmentReportSplit;
  /** Already narrowed to visible, attributing accounts (and any account/provider filter). */
  accountIds: string[];
  services?: string[] | undefined;
  regions?: string[] | undefined;
  /**
   * Commitment ids the commitment side is restricted to, or null for every
   * commitment. Uncovered usage is never restricted by this: it is the rest
   * of the coverage denominator.
   */
  commitmentIds: string[] | null;
}

/** One aggregate of {@link getCommitmentReportCells}: the client-core `CommitmentReportCell`, unmapped. */
export interface CommitmentReportCellRow {
  bucket: string;
  group_key: string;
  currency: string;
  covered: number;
  covered_all: number;
  unused: number;
  uncovered: number;
  uncovered_eligible: number;
  covered_on_demand: number;
  covered_measured: number;
}

function reportBucketExpr(bucket: CommitmentReportBucketSize): SQL {
  switch (bucket) {
    case "weekly":
      return sql`toString(toStartOfWeek(${costDaily.day}, 1))`;
    case "monthly":
      return sql`toString(toStartOfMonth(${costDaily.day}))`;
    case "quarterly":
      return sql`toString(toStartOfQuarter(${costDaily.day}))`;
    case "daily":
      return sql`toString(${costDaily.day})`;
  }
}

function reportSplitExpr(split: CommitmentReportSplit): SQL {
  switch (split) {
    case "none":
      return sql`''`;
    case "provider":
      return sql`toString(${costDaily.plugin_id})`;
    case "service":
      return sql`toString(${costDaily.service})`;
    case "account":
      return sql`${costDaily.account_id}`;
    case "region":
      return sql`toString(${costDaily.region})`;
    case "commitment":
      return sql`multiIf(${consumptionCondition()} AND ${uncoveredCondition()}, '__on_demand__', ${costDaily.commitment_id} = '', '__unattributed__', ${costDaily.commitment_id})`;
  }
}

/**
 * The commitment report's one scan: per bucket, group and currency, the seven
 * amortized sums `client-core/src/commitment-reports.ts` turns into metrics
 * (its module header defines each).
 *
 * Three charge types are read: the two consumption types, and
 * `commitment_fee` **only where the provider reported an amortized amount**.
 * On the amortized basis a purchase is worth zero on its own row (its value
 * is on the covered usage), so what a fee row still carries is commitment no
 * usage absorbed. A fee row without a reported amortized figure would fall
 * back to its cash amount, which is the purchase itself, and counting that as
 * "unused" would report a fresh three-year reservation as wasted in full on
 * the day it was bought.
 *
 * "Eligible" uncovered usage is uncovered usage in a (provider, service,
 * region) cell that had any covered usage in the same window and accounts:
 * the feed's narrow-coverage cells, computed in the same scan by subquery so
 * the cost visibility scope applies to both halves.
 */
export async function getCommitmentReportCells(
  organizationId: string,
  q: CommitmentReportCellQuery,
): Promise<CommitmentReportCellRow[]> {
  if (q.accountIds.length === 0) return [];
  const money = amortizedAmountExpr();
  const consumption = consumptionCondition();
  const covered = coveredCondition();
  const uncovered = uncoveredCondition();
  const fee = sql`(${eq(costDaily.charge_type, "commitment_fee")} AND ${costDaily.amortized_reported} = 1)`;
  const selected: SQL =
    q.commitmentIds === null
      ? sql`1`
      : q.commitmentIds.length === 0
        ? sql`0`
        : inArray(costDaily.commitment_id, q.commitmentIds);
  const accountFilter = inArray(costDaily.account_id, q.accountIds);
  const dimensionFilters: SQL[] = [];
  if (q.services?.length) dimensionFilters.push(inArray(costDaily.service, q.services));
  if (q.regions?.length) dimensionFilters.push(inArray(costDaily.region, q.regions));
  const scope = and(
    costDailyOrgCondition(organizationId),
    dayRange(q.from, q.to),
    accountFilter,
    ...dimensionFilters,
  )!;
  const eligible = sql`(${costDaily.plugin_id}, ${costDaily.service}, ${costDaily.region}) IN (SELECT ${costDaily.plugin_id}, ${costDaily.service}, ${costDaily.region} FROM ${costDaily} WHERE ${scope} AND ${consumption} AND ${covered} GROUP BY ${costDaily.plugin_id}, ${costDaily.service}, ${costDaily.region})`;
  const coveredSelected = sql`${consumption} AND ${covered} AND ${selected}`;
  const measured = sql`${coveredSelected} AND ${costDaily.on_demand_reported} = 1`;

  const rows = await query((db) =>
    db
      .select({
        bucket: sql<string>`${reportBucketExpr(q.bucket)}`.as("bucket"),
        group_key: sql<string>`${reportSplitExpr(q.split)}`.as("group_key"),
        currency: costDaily.currency,
        covered: sql<number>`sumIf(${money}, ${coveredSelected})`.as("covered"),
        covered_all: sql<number>`sumIf(${money}, ${consumption} AND ${covered})`.as("covered_all"),
        unused: sql<number>`sumIf(${costDaily.amortized_amount}, ${fee} AND ${selected})`.as(
          "unused",
        ),
        uncovered: sql<number>`sumIf(${money}, ${consumption} AND ${uncovered})`.as("uncovered"),
        uncovered_eligible:
          sql<number>`sumIf(${money}, ${consumption} AND ${uncovered} AND ${eligible})`.as(
            "uncovered_eligible",
          ),
        covered_on_demand: sql<number>`sumIf(${costDaily.on_demand_amount}, ${measured})`.as(
          "covered_on_demand",
        ),
        covered_measured: sql<number>`sumIf(${money}, ${measured})`.as("covered_measured"),
      })
      .from(costDaily)
      .final()
      .where(and(scope, sql`(${consumption} OR ${fee})`))
      .groupBy(sql`bucket`, sql`group_key`, costDaily.currency),
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    group_key: r.group_key,
    currency: r.currency,
    covered: Number(r.covered),
    covered_all: Number(r.covered_all),
    unused: Number(r.unused),
    uncovered: Number(r.uncovered),
    uncovered_eligible: Number(r.uncovered_eligible),
    covered_on_demand: Number(r.covered_on_demand),
    covered_measured: Number(r.covered_measured),
  }));
}

/** Distinct services and regions with consumption in the window, for the editor's pickers. */
export async function getCommitmentReportDimensionValues(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<{ services: string[]; regions: string[] }> {
  if (accountIds.length === 0) return { services: [], regions: [] };
  const rows = await query((db) =>
    db
      .selectDistinct({
        service: sql<string>`toString(${costDaily.service})`.as("service"),
        region: sql<string>`toString(${costDaily.region})`.as("region"),
      })
      .from(costDaily)
      .where(
        and(
          costDailyOrgCondition(organizationId),
          dayRange(from, to),
          consumptionCondition(),
          inArray(costDaily.account_id, accountIds),
        ),
      ),
  );
  const services = new Set<string>();
  const regions = new Set<string>();
  for (const r of rows) {
    if (r.service) services.add(r.service);
    if (r.region) regions.add(r.region);
  }
  return {
    services: [...services].sort((a, b) => a.localeCompare(b)),
    regions: [...regions].sort((a, b) => a.localeCompare(b)),
  };
}
