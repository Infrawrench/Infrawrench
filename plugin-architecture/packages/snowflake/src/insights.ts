/**
 * Read-mostly reports shown on detail pages and fed to the host's credit and
 * quota passes: the capacity balance, per-query cost attribution, resource
 * monitor quotas, and warehouse recommendations.
 */

import type { CreditBalance, QuotaUsage } from "@infrawrench/plugin-base";
import { CreditAccessError, QuotaAccessError } from "@infrawrench/plugin-base";
import type { SnowflakeContext } from "./api.js";
import { isNotAuthorized, literal, num, runSql, str } from "./api.js";
import { WAREHOUSE_SIZES, findSize, sizeIndex } from "./catalog.js";
import { parsePercents } from "./mappers.js";

const ORG_USAGE_DOCS = {
  label: "Organization usage views",
  url: "https://docs.snowflake.com/en/sql-reference/organization-usage",
};

// --- Capacity balance -----------------------------------------------------------

/**
 * Latest end-of-day balances from `ORGANIZATION_USAGE.REMAINING_BALANCE_DAILY`
 * (latency up to 72 hours; only the organization that funds a shared
 * contract can read it). Capacity, rollover and free usage are separate
 * pots; on-demand consumption is a negative running balance, not credit, so
 * it is left out.
 */
export async function fetchBalances(ctx: SnowflakeContext): Promise<CreditBalance[]> {
  let res;
  try {
    res = await runSql(
      ctx,
      `SELECT TO_VARCHAR(DATE, 'YYYY-MM-DD') AS D, CONTRACT_NUMBER AS CONTRACT, CURRENCY AS CUR,
         CAPACITY_BALANCE AS CAPACITY, ROLLOVER_BALANCE AS ROLLOVER, FREE_USAGE_BALANCE AS FREE
       FROM SNOWFLAKE.ORGANIZATION_USAGE.REMAINING_BALANCE_DAILY
       QUALIFY ROW_NUMBER() OVER (PARTITION BY CONTRACT_NUMBER, CURRENCY ORDER BY DATE DESC) = 1`,
    );
  } catch (err) {
    if (isNotAuthorized(err)) {
      throw new CreditAccessError(
        "The connection's role cannot read SNOWFLAKE.ORGANIZATION_USAGE. Pick a role with the organization usage views (ORGADMIN, or GLOBALORGADMIN in the organization account) under Edit credentials to see the capacity balance.",
        ORG_USAGE_DOCS,
      );
    }
    throw err;
  }
  const out: CreditBalance[] = [];
  for (const r of res.rows) {
    const currency = str(r["cur"]) || "USD";
    const contract = str(r["contract"]) || "default";
    const pots: Array<[string, string, number | undefined]> = [
      ["capacity", "Capacity balance", num(r["capacity"])],
      ["rollover", "Rollover balance", num(r["rollover"])],
      ["free", "Free usage balance", num(r["free"])],
    ];
    for (const [pot, label, remaining] of pots) {
      if (remaining === undefined || (pot !== "capacity" && remaining === 0)) continue;
      out.push({
        key: `${contract}:${pot}:${currency}`,
        label: res.rows.length > 1 ? `${label} (contract ${contract})` : label,
        remaining,
        currency,
      });
    }
  }
  return out;
}

// --- Per-query attribution ------------------------------------------------------

export interface AttributionEntry {
  value: string;
  credits: number;
  queries: number;
}

export interface AttributionReport {
  days: number;
  byQueryTag: AttributionEntry[];
  byUser: AttributionEntry[];
  byRole: AttributionEntry[];
  byWarehouse: AttributionEntry[];
  totalCredits: number;
}

export const ATTRIBUTION_DAYS = 30;
const ATTRIBUTION_TOP = 15;

/**
 * Credits attributed to queries over the last `days`, grouped four ways, from
 * `ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY` (365 days, up to 8 hours
 * latency; excludes idle warehouse time, queries of about 100 ms or less,
 * cloud services and serverless). The view has no role column, so roles come
 * from `QUERY_HISTORY` by query id. Kept out of the cost store on purpose:
 * the daily rows already account for every credit, and the same credits
 * split by tag would double any report that summed both.
 */
export async function fetchAttribution(
  ctx: SnowflakeContext,
  days = ATTRIBUTION_DAYS,
): Promise<AttributionReport> {
  const res = await runSql(
    ctx,
    `WITH A AS (
       SELECT QUERY_ID, NULLIF(QUERY_TAG, '') AS QUERY_TAG, USER_NAME, WAREHOUSE_NAME,
         COALESCE(CREDITS_ATTRIBUTED_COMPUTE, 0) + COALESCE(CREDITS_USED_QUERY_ACCELERATION, 0) AS CREDITS
       FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
       WHERE START_TIME >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
     ), Q AS (
       SELECT QUERY_ID, ROLE_NAME FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE START_TIME >= DATEADD('day', -${days + 1}, CURRENT_TIMESTAMP())
     ), D AS (
       SELECT 'tag' AS DIM, COALESCE(QUERY_TAG, '(untagged)') AS VAL, CREDITS FROM A
       UNION ALL SELECT 'user', COALESCE(USER_NAME, '(unknown)'), CREDITS FROM A
       UNION ALL SELECT 'warehouse', COALESCE(WAREHOUSE_NAME, '(unknown)'), CREDITS FROM A
       UNION ALL SELECT 'role', COALESCE(Q.ROLE_NAME, '(unknown)'), A.CREDITS
         FROM A LEFT JOIN Q ON Q.QUERY_ID = A.QUERY_ID
     )
     SELECT DIM, VAL, SUM(CREDITS) AS CREDITS, COUNT(*) AS QUERIES
     FROM D GROUP BY DIM, VAL
     QUALIFY ROW_NUMBER() OVER (PARTITION BY DIM ORDER BY SUM(CREDITS) DESC) <= ${ATTRIBUTION_TOP}
     ORDER BY DIM, CREDITS DESC`,
    { timeoutSec: 300 },
  );
  const report: AttributionReport = {
    days,
    byQueryTag: [],
    byUser: [],
    byRole: [],
    byWarehouse: [],
    totalCredits: 0,
  };
  for (const r of res.rows) {
    const entry: AttributionEntry = {
      value: str(r["val"]),
      credits: Math.round((num(r["credits"]) ?? 0) * 1000) / 1000,
      queries: num(r["queries"]) ?? 0,
    };
    switch (str(r["dim"])) {
      case "tag":
        report.byQueryTag.push(entry);
        break;
      case "user":
        report.byUser.push(entry);
        break;
      case "role":
        report.byRole.push(entry);
        break;
      case "warehouse":
        report.byWarehouse.push(entry);
        report.totalCredits += entry.credits;
        break;
    }
  }
  report.totalCredits = Math.round(report.totalCredits * 1000) / 1000;
  return report;
}

// --- Resource monitor quotas ----------------------------------------------------

/**
 * One quota per resource monitor that has a credit quota: both halves are
 * Snowflake's own (`credit_quota`, `used_credits` from SHOW RESOURCE
 * MONITORS). A role sees only monitors it owns or has MONITOR on, so the
 * list is a subset unless the connection runs as ACCOUNTADMIN.
 */
export async function fetchMonitorQuotas(ctx: SnowflakeContext): Promise<QuotaUsage[]> {
  let res;
  try {
    res = await runSql(ctx, "SHOW RESOURCE MONITORS");
  } catch (err) {
    if (isNotAuthorized(err)) {
      throw new QuotaAccessError(
        "The connection's role cannot list resource monitors. Use a role that owns them or has MONITOR on them (ACCOUNTADMIN sees all).",
        {
          label: "Working with resource monitors",
          url: "https://docs.snowflake.com/en/user-guide/resource-monitors",
        },
      );
    }
    throw err;
  }
  const out: QuotaUsage[] = [];
  for (const r of res.rows) {
    const limit = num(r["credit_quota"]);
    if (limit === undefined || limit <= 0) continue;
    const name = str(r["name"]);
    const frequency = str(r["frequency"]).toLowerCase();
    out.push({
      id: `resource-monitor/${name}`,
      service: "resource-monitors",
      name: frequency && frequency !== "never" ? `${name} (${frequency})` : name,
      limit,
      used: num(r["used_credits"]) ?? 0,
      unit: "credits",
      adjustable: true,
    });
  }
  return out;
}

/** Warehouses assigned to each monitor, from SHOW WAREHOUSES. */
export function warehousesByMonitor(
  warehouses: Array<Record<string, unknown>>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const w of warehouses) {
    const monitor = str(w["resource_monitor"]);
    if (!monitor || monitor === "null") continue;
    const list = out.get(monitor) ?? [];
    list.push(str(w["name"]));
    out.set(monitor, list);
  }
  return out;
}

/** Percent thresholds of a monitor, for rebuilding its TRIGGERS clause. */
export function monitorTriggers(fields: {
  notifyAt?: string | undefined;
  suspendAt?: string | number | undefined;
  suspendImmediatelyAt?: string | number | undefined;
}): string {
  const parts: string[] = [];
  for (const p of parsePercents(fields.notifyAt ?? "")) parts.push(`ON ${p} PERCENT DO NOTIFY`);
  const suspend = Number(fields.suspendAt);
  if (Number.isFinite(suspend) && suspend > 0) parts.push(`ON ${suspend} PERCENT DO SUSPEND`);
  const immediate = Number(fields.suspendImmediatelyAt);
  if (Number.isFinite(immediate) && immediate > 0) {
    parts.push(`ON ${immediate} PERCENT DO SUSPEND_IMMEDIATE`);
  }
  return parts.length > 0 ? `TRIGGERS ${parts.join(" ")}` : "";
}

// --- Warehouse recommendations ----------------------------------------------------

export interface WarehouseActivity {
  /** Hours in the window with any query load. */
  activeHours: number;
  /** Mean running load across active five-minute intervals. */
  avgRunning: number;
  /** Mean queued (overload plus provisioning) load across active intervals. */
  avgQueued: number;
  /** Compute credits in the window. */
  credits: number;
  days: number;
}

export interface Recommendation {
  id: "never-suspends" | "long-auto-suspend" | "downsize" | "queueing" | "unused";
  severity: "warning" | "info";
  title: string;
  detail: string;
  /** Suggested new size (SHOW spelling) for `downsize`. */
  size?: string;
  /** Suggested auto-suspend seconds. */
  autoSuspend?: number;
}

export const ACTIVITY_DAYS = 14;

/**
 * Load and credits for one warehouse over the last `days`, from
 * `WAREHOUSE_LOAD_HISTORY` (five-minute intervals) and
 * `WAREHOUSE_METERING_HISTORY` (hourly). Both lag up to three hours.
 */
export async function fetchWarehouseActivity(
  ctx: SnowflakeContext,
  warehouse: string,
  days = ACTIVITY_DAYS,
): Promise<WarehouseActivity> {
  const name = literal(warehouse);
  const res = await runSql(
    ctx,
    `SELECT
       (SELECT COUNT(DISTINCT DATE_TRUNC('hour', START_TIME))
          FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
          WHERE WAREHOUSE_NAME = ${name} AND START_TIME >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
            AND AVG_RUNNING + AVG_QUEUED_LOAD + AVG_QUEUED_PROVISIONING > 0) AS ACTIVE_HOURS,
       (SELECT AVG(AVG_RUNNING)
          FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
          WHERE WAREHOUSE_NAME = ${name} AND START_TIME >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
            AND AVG_RUNNING + AVG_QUEUED_LOAD + AVG_QUEUED_PROVISIONING > 0) AS AVG_RUNNING,
       (SELECT AVG(AVG_QUEUED_LOAD + AVG_QUEUED_PROVISIONING)
          FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
          WHERE WAREHOUSE_NAME = ${name} AND START_TIME >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
            AND AVG_RUNNING + AVG_QUEUED_LOAD + AVG_QUEUED_PROVISIONING > 0) AS AVG_QUEUED,
       (SELECT SUM(CREDITS_USED_COMPUTE)
          FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
          WHERE WAREHOUSE_NAME = ${name} AND START_TIME >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())) AS CREDITS`,
  );
  const r = res.rows[0] ?? {};
  return {
    activeHours: num(r["active_hours"]) ?? 0,
    avgRunning: num(r["avg_running"]) ?? 0,
    avgQueued: num(r["avg_queued"]) ?? 0,
    credits: num(r["credits"]) ?? 0,
    days,
  };
}

/**
 * Recommendations from a warehouse's settings and, when available, its
 * activity. Thresholds are deliberately conservative:
 *
 * - Auto-suspend off (0) on a warehouse with auto-resume on: it bills for
 *   every idle second until suspended by hand.
 * - Auto-suspend above 10 minutes: every resume bills at least 60 seconds,
 *   so 60 to 300 seconds is the usual setting; longer only keeps the cache
 *   warm at full price.
 * - Downsize: Medium or larger, average running load under 0.25 while active
 *   and no meaningful queueing (under 0.05). Load is the share of the
 *   warehouse's capacity in use, so a quarter-full warehouse would fit in
 *   the next size down at about half the load.
 * - Queueing above 0.1 average: queries wait for capacity; a larger size or
 *   more clusters would cut latency (it costs more, so it is info only).
 * - No credits in the window: unused, a candidate to drop.
 */
export function recommendWarehouse(
  settings: { size?: string; autoSuspend?: number; autoResume?: boolean; maxClusterCount?: number },
  activity: WarehouseActivity | undefined,
): Recommendation[] {
  const out: Recommendation[] = [];
  const autoSuspend = settings.autoSuspend ?? 0;
  if (autoSuspend === 0) {
    out.push({
      id: "never-suspends",
      severity: "warning",
      title: "Auto-suspend is off",
      detail:
        "This warehouse keeps running, and billing, until someone suspends it. Set auto-suspend to a few minutes; auto-resume brings it back when a query arrives.",
      autoSuspend: 300,
    });
  } else if (autoSuspend > 600) {
    out.push({
      id: "long-auto-suspend",
      severity: "warning",
      title: `Auto-suspend waits ${Math.round(autoSuspend / 60)} minutes`,
      detail:
        "Each idle stretch before suspending is billed at the full warehouse rate. 60 to 300 seconds suits most workloads; keep it longer only if a warm cache measurably speeds up frequent queries.",
      autoSuspend: 300,
    });
  }
  if (!activity) return out;
  if (activity.credits <= 0 && activity.activeHours === 0) {
    out.push({
      id: "unused",
      severity: "info",
      title: `No use in ${activity.days} days`,
      detail:
        "No queries ran on this warehouse in the window. If nothing depends on it, dropping it removes the risk of it being resumed by accident.",
    });
    return out;
  }
  const idx = sizeIndex(settings.size);
  if (
    idx >= 2 &&
    activity.activeHours >= 4 &&
    activity.avgRunning < 0.25 &&
    activity.avgQueued < 0.05
  ) {
    const smaller = WAREHOUSE_SIZES[idx - 1]!;
    out.push({
      id: "downsize",
      severity: "warning",
      title: `Try ${smaller.show}`,
      detail: `While active over the last ${activity.days} days the warehouse averaged ${Math.round(activity.avgRunning * 100)}% of its capacity with no queueing. One size down halves the credits per hour (${findSize(settings.size)?.credits ?? "?"} to ${smaller.credits}); queries may run somewhat longer.`,
      size: smaller.show,
    });
  }
  if (activity.avgQueued > 0.1) {
    out.push({
      id: "queueing",
      severity: "info",
      title: "Queries are queueing",
      detail: `Queued load averaged ${activity.avgQueued.toFixed(2)} while active, so queries wait for capacity. ${(settings.maxClusterCount ?? 1) > 1 ? "Raise the maximum cluster count" : "A multi-cluster setting (Enterprise edition) or a larger size"} would cut the wait, at a higher credit rate.`,
    });
  }
  return out;
}
