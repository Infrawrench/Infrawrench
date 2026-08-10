/**
 * ClickHouse aggregates feeding the commitment modules
 * (`../commitments/{coverage,utilization,planner}.ts` — all pure; every
 * query here exists to hand them their inputs and nothing else).
 *
 * All three restrict to `charge_type = 'usage'`: a commitment fee in a
 * coverage denominator double-counts the purchase against the usage it
 * bought, and a negative discount line can push coverage past 100%. The
 * caller further restricts to accounts whose plugin declares `chargeTypes`
 * (via the `accountIds` parameters) — for everyone else `usage` is just the
 * default stamp, not a claim.
 */
import { getClickHouseClient, isClickHouseConfigured } from "./client";

async function query<T>(sql: string, query_params: Record<string, unknown>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  const rs = await getClickHouseClient().query({ query: sql, query_params, format: "JSONEachRow" });
  return await rs.json<T>();
}

/** One coverage aggregate — the pure module's `CoverageCell`, unmapped. */
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
 * Usage spend per (account, plugin, service, region, currency) over the
 * window, split by whether the row carries a commitment id.
 */
export async function getCommitmentCoverageCells(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<CoverageCellRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await query<CoverageCellRow>(
    `SELECT account_id, plugin_id, service, region, currency,
            sumIf(amount, commitment_id != '') AS covered_amount,
            sumIf(amount, commitment_id = '') AS uncovered_amount
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
       AND charge_type = 'usage'
       AND account_id IN {accountIds:Array(String)}
     GROUP BY account_id, plugin_id, service, region, currency`,
    { orgId: organizationId, from, to, accountIds },
  );
  return rows.map((r) => ({
    ...r,
    covered_amount: Number(r.covered_amount),
    uncovered_amount: Number(r.uncovered_amount),
  }));
}

/**
 * Which days each account has *any* cost rows for — the days-we-have-data
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
  const rows = await query<{ account_id: string; day: string }>(
    `SELECT DISTINCT account_id, toString(day) AS day
     FROM cost_daily
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
       AND account_id IN {accountIds:Array(String)}`,
    { orgId: organizationId, from, to, accountIds },
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

export async function getCommitmentDeliveredTotals(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<CommitmentDeliveredRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await query<CommitmentDeliveredRow>(
    `SELECT account_id, commitment_id, currency, sum(amount) AS amount
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
       AND charge_type = 'usage'
       AND commitment_id != ''
       AND account_id IN {accountIds:Array(String)}
     GROUP BY account_id, commitment_id, currency`,
    { orgId: organizationId, from, to, accountIds },
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
 * The planner's raw series: uncovered usage spend per cell per day. Days a
 * cell spent nothing simply have no row — the pure planner treats absence
 * as zero.
 */
export async function getUncoveredDailySpend(
  organizationId: string,
  from: string,
  to: string,
  accountIds: string[],
): Promise<UncoveredDailyRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await query<UncoveredDailyRow>(
    `SELECT plugin_id, service, region, currency, toString(day) AS day,
            sum(amount) AS amount
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
       AND charge_type = 'usage'
       AND commitment_id = ''
       AND account_id IN {accountIds:Array(String)}
     GROUP BY plugin_id, service, region, currency, day`,
    { orgId: organizationId, from, to, accountIds },
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}
