/**
 * Cost collection.
 *
 * Two sources, tried in order (views verified against their reference pages
 * on docs.snowflake.com, 2026-10):
 *
 * 1. **Billed**: `SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY`, the
 *    amounts on the bill in the contract currency, per account, day and
 *    service type, with `BALANCE_SOURCE` (capacity, rollover, free usage,
 *    overage, rebate), `BILLING_TYPE` (consumption, rebate, priority support,
 *    vps_deployment_fee, support_credit), `RATING_TYPE` (compute,
 *    data_transfer, storage, other) and `IS_ADJUSTMENT`. Latency up to 72
 *    hours, and a day can change until month end. Readable only by roles
 *    granted the organization usage views (ORGADMIN, or the organization
 *    account's GLOBALORGADMIN), and never by reseller customers. Filtered to
 *    `ACCOUNT_LOCATOR = CURRENT_ACCOUNT()` so connecting several accounts of
 *    one organization does not count anyone twice.
 * 2. **Estimated** when (1) is not authorized: credits from
 *    `ACCOUNT_USAGE.METERING_DAILY_HISTORY` (365 days, 3 hour latency) times
 *    the credit price on the connection, storage bytes from
 *    `ACCOUNT_USAGE.STORAGE_USAGE` times the storage price, and transfer bytes
 *    from `ACCOUNT_USAGE.DATA_TRANSFER_HISTORY` times the transfer price when
 *    one is entered. Cloud services credits are only billed above 10% of the
 *    day's warehouse credits; `CREDITS_ADJUSTMENT_CLOUD_SERVICES` (negative)
 *    carries the discount, so cloud services are charged net of it.
 *
 * Warehouse compute is split per warehouse in both paths, pro rata to each
 * warehouse's compute credits that day in `WAREHOUSE_METERING_HISTORY`, so
 * the split always sums to the day's total. Every row carries a `costBasis`
 * tag (`billed` or `estimated`) because the manifest's `estimated` flag is
 * per plugin while the source is decided per account.
 */

import type { CostChargeType, CostRow } from "@infrawrench/plugin-base";
import type { SnowflakeContext } from "./api.js";
import { isNotAuthorized, num, runSql, str } from "./api.js";
import type { SnowflakeRates } from "./catalog.js";
import { SERVICE, humanServiceType, serviceGroup } from "./catalog.js";

export type CostBasis = "billed" | "estimated";

export interface CostFetch {
  rows: CostRow[];
  basis: CostBasis;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Storage and transfer prices are per binary terabyte. */
const TB = 1024 ** 4;

function checkDate(d: string): string {
  if (!DATE_RE.test(d)) throw new Error(`Snowflake plugin: invalid date "${d}"`);
  return d;
}

function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Day → warehouse → compute credits, for the per-warehouse split. */
export type WarehouseShares = Map<string, Map<string, number>>;

export async function warehouseCreditsByDay(
  ctx: SnowflakeContext,
  from: string,
  to: string,
): Promise<WarehouseShares> {
  const res = await runSql(
    ctx,
    `SELECT TO_VARCHAR(TO_DATE(START_TIME), 'YYYY-MM-DD') AS D, WAREHOUSE_NAME AS W,
       SUM(CREDITS_USED_COMPUTE) AS C
     FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
     WHERE START_TIME >= '${checkDate(from)}'::DATE AND START_TIME < DATEADD('day', 1, '${checkDate(to)}'::DATE)
     GROUP BY 1, 2`,
  );
  const out: WarehouseShares = new Map();
  for (const r of res.rows) {
    const day = str(r["d"]);
    const credits = num(r["c"]) ?? 0;
    if (!day || credits <= 0) continue;
    let byWh = out.get(day);
    if (!byWh) out.set(day, (byWh = new Map()));
    byWh.set(str(r["w"]), (byWh.get(str(r["w"])) ?? 0) + credits);
  }
  return out;
}

/**
 * Spread one warehouse-compute row across the day's warehouses. Returns the
 * row untouched when there is nothing to split by.
 */
export function splitByWarehouse(row: CostRow, shares: Map<string, number> | undefined): CostRow[] {
  if (!shares || shares.size === 0) return [row];
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [row];
  return [...shares.entries()].map(([warehouse, credits]) => {
    const share = credits / total;
    return {
      ...row,
      resourceId: warehouse,
      tags: { ...row.tags, warehouse },
      amount: round(row.amount * share),
      ...(row.usageAmount !== undefined ? { usageAmount: round(row.usageAmount * share) } : {}),
    };
  });
}

function chargeTypeFor(billingType: string, isAdjustment: boolean): CostChargeType {
  const b = billingType.toLowerCase();
  if (b === "rebate" || b === "support_credit") return "credit";
  if (b.includes("support")) return "support";
  if (isAdjustment) return "adjustment";
  if (b === "consumption" || !b) return "usage";
  return "other";
}

function unitFor(ratingType: string): string | undefined {
  switch (ratingType.toLowerCase()) {
    case "compute":
      return "credits";
    case "storage":
    case "data_transfer":
      return "TB";
    default:
      return undefined;
  }
}

/** Path 1: billed amounts from ORGANIZATION_USAGE. Throws when not authorized. */
export async function fetchBilledRows(
  ctx: SnowflakeContext,
  from: string,
  to: string,
  shares: WarehouseShares | undefined,
): Promise<CostRow[]> {
  const res = await runSql(
    ctx,
    `SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS D, SERVICE_TYPE AS ST, RATING_TYPE AS RT,
       BILLING_TYPE AS BT, BALANCE_SOURCE AS BS, CURRENCY AS CUR, IS_ADJUSTMENT AS ADJ,
       REGION AS REGION, SUM(USAGE) AS USAGE, SUM(USAGE_IN_CURRENCY) AS AMOUNT
     FROM SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY
     WHERE ACCOUNT_LOCATOR = CURRENT_ACCOUNT()
       AND USAGE_DATE BETWEEN '${checkDate(from)}' AND '${checkDate(to)}'
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`,
  );
  const rows: CostRow[] = [];
  for (const r of res.rows) {
    const amount = num(r["amount"]) ?? 0;
    const usage = num(r["usage"]);
    if (amount === 0 && !usage) continue;
    const serviceType = str(r["st"]);
    const ratingType = str(r["rt"]);
    const service = serviceGroup(serviceType, ratingType);
    const unit = unitFor(ratingType);
    const row: CostRow = {
      date: str(r["d"]),
      service,
      ...(str(r["region"]) ? { region: str(r["region"]) } : {}),
      currency: str(r["cur"]) || "USD",
      amount: round(amount, 4),
      ...(usage !== undefined ? { usageAmount: usage } : {}),
      ...(unit ? { usageUnit: unit } : {}),
      chargeType: chargeTypeFor(str(r["bt"]), r["adj"] === true),
      tags: {
        costBasis: "billed",
        serviceType: humanServiceType(serviceType),
        ...(str(r["bs"]) ? { balanceSource: str(r["bs"]) } : {}),
      },
    };
    rows.push(
      ...(service === SERVICE.warehouse ? splitByWarehouse(row, shares?.get(row.date)) : [row]),
    );
  }
  return rows;
}

/** Path 2: credits, storage and transfer priced at the connection's rates. */
export async function fetchEstimatedRows(
  ctx: SnowflakeContext,
  rates: SnowflakeRates,
  from: string,
  to: string,
  shares: WarehouseShares | undefined,
  region: string | undefined,
): Promise<CostRow[]> {
  const f = checkDate(from);
  const t = checkDate(to);
  const [metering, storage, transfer] = await Promise.all([
    runSql(
      ctx,
      `SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS D, SERVICE_TYPE AS ST,
         SUM(CREDITS_USED_COMPUTE) AS COMPUTE, SUM(CREDITS_USED_CLOUD_SERVICES) AS CLOUD,
         SUM(CREDITS_ADJUSTMENT_CLOUD_SERVICES) AS ADJ
       FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
       WHERE USAGE_DATE BETWEEN '${f}' AND '${t}'
       GROUP BY 1, 2`,
    ),
    runSql(
      ctx,
      `SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS D,
         COALESCE(STORAGE_BYTES, 0) + COALESCE(STAGE_BYTES, 0) + COALESCE(FAILSAFE_BYTES, 0)
           + COALESCE(HYBRID_TABLE_STORAGE_BYTES, 0) AS BYTES
       FROM SNOWFLAKE.ACCOUNT_USAGE.STORAGE_USAGE
       WHERE USAGE_DATE BETWEEN '${f}' AND '${t}'`,
    ).catch((err: unknown) => {
      if (isNotAuthorized(err)) return { rows: [] as Record<string, unknown>[] };
      throw err;
    }),
    rates.transferPerTb === undefined
      ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
      : runSql(
          ctx,
          `SELECT TO_VARCHAR(TO_DATE(START_TIME), 'YYYY-MM-DD') AS D, TRANSFER_TYPE AS TT,
             SUM(TO_NUMBER(BYTES_TRANSFERRED)) AS BYTES
           FROM SNOWFLAKE.ACCOUNT_USAGE.DATA_TRANSFER_HISTORY
           WHERE START_TIME >= '${f}'::DATE AND START_TIME < DATEADD('day', 1, '${t}'::DATE)
             AND TRANSFER_TYPE <> 'INTERNAL'
           GROUP BY 1, 2`,
        ).catch((err: unknown) => {
          if (isNotAuthorized(err)) return { rows: [] as Record<string, unknown>[] };
          throw err;
        }),
  ]);

  const base = (date: string, service: string, serviceType: string): CostRow => ({
    date,
    service,
    ...(region ? { region } : {}),
    currency: rates.currency,
    amount: 0,
    tags: { costBasis: "estimated", serviceType: humanServiceType(serviceType) },
  });
  const rows: CostRow[] = [];
  const cloudByDay = new Map<string, number>();

  for (const r of metering.rows) {
    const date = str(r["d"]);
    const serviceType = str(r["st"]);
    const compute = num(r["compute"]) ?? 0;
    cloudByDay.set(
      date,
      (cloudByDay.get(date) ?? 0) + (num(r["cloud"]) ?? 0) + (num(r["adj"]) ?? 0),
    );
    if (compute <= 0) continue;
    const service = serviceGroup(serviceType);
    const row: CostRow = {
      ...base(date, service, serviceType),
      amount: round(compute * rates.creditPrice, 4),
      usageAmount: round(compute),
      usageUnit: "credits",
    };
    rows.push(
      ...(service === SERVICE.warehouse ? splitByWarehouse(row, shares?.get(date)) : [row]),
    );
  }
  for (const [date, credits] of cloudByDay) {
    if (credits <= 0.000001) continue;
    rows.push({
      ...base(date, SERVICE.cloudServices, "CLOUD_SERVICES"),
      amount: round(credits * rates.creditPrice, 4),
      usageAmount: round(credits),
      usageUnit: "credits",
    });
  }
  for (const r of storage.rows) {
    const date = str(r["d"]);
    const bytes = num(r["bytes"]) ?? 0;
    if (bytes <= 0) continue;
    const tb = bytes / TB;
    rows.push({
      ...base(date, SERVICE.storage, "STORAGE"),
      amount: round((tb * rates.storagePerTbMonth) / daysInMonth(date), 4),
      usageAmount: round(tb),
      usageUnit: "TB",
    });
  }
  for (const r of transfer.rows) {
    const date = str(r["d"]);
    const bytes = num(r["bytes"]) ?? 0;
    if (bytes <= 0 || rates.transferPerTb === undefined) continue;
    const tb = bytes / TB;
    const row = base(date, SERVICE.dataTransfer, "DATA_TRANSFER");
    rows.push({
      ...row,
      amount: round(tb * rates.transferPerTb, 4),
      usageAmount: round(tb),
      usageUnit: "TB",
      tags: { ...row.tags, transferType: humanServiceType(str(r["tt"])) },
    });
  }
  return rows.filter((r) => r.amount !== 0);
}

/**
 * Daily cost rows for `from`..`to`, billed when the role can read
 * organization usage and estimated otherwise.
 */
export async function fetchSnowflakeCostData(
  ctx: SnowflakeContext,
  rates: SnowflakeRates,
  from: string,
  to: string,
): Promise<CostFetch> {
  // The split is a refinement: a role without ACCOUNT_USAGE access on
  // warehouse metering still gets its totals.
  const shares = await warehouseCreditsByDay(ctx, from, to).catch((err: unknown) => {
    if (isNotAuthorized(err)) return undefined;
    throw err;
  });
  try {
    return { rows: await fetchBilledRows(ctx, from, to, shares), basis: "billed" };
  } catch (err) {
    if (!isNotAuthorized(err)) throw err;
  }
  const regionRes = await runSql(ctx, "SELECT CURRENT_REGION() AS R").catch(() => undefined);
  const region = regionRes ? str(regionRes.rows[0]?.["r"]) : undefined;
  return {
    rows: await fetchEstimatedRows(ctx, rates, from, to, shares, region || undefined),
    basis: "estimated",
  };
}

export interface MonthSummary {
  month: string;
  basis: CostBasis;
  currency: string;
  total: number;
  byService: Array<{ service: string; amount: number }>;
  byWarehouse: Array<{ warehouse: string; amount: number; credits: number }>;
}

/** Month-to-date totals for the account page, from the same rows the collector writes. */
export function summarizeMonth(month: string, fetched: CostFetch): MonthSummary {
  const byService = new Map<string, number>();
  const byWarehouse = new Map<string, { amount: number; credits: number }>();
  let total = 0;
  let currency = "USD";
  for (const r of fetched.rows) {
    total += r.amount;
    currency = r.currency;
    const service = r.service ?? SERVICE.other;
    byService.set(service, (byService.get(service) ?? 0) + r.amount);
    const wh = r.tags?.["warehouse"];
    if (wh) {
      const cur = byWarehouse.get(wh) ?? { amount: 0, credits: 0 };
      cur.amount += r.amount;
      if (r.usageUnit === "credits") cur.credits += r.usageAmount ?? 0;
      byWarehouse.set(wh, cur);
    }
  }
  return {
    month,
    basis: fetched.basis,
    currency,
    total: round(total, 2),
    byService: [...byService.entries()]
      .map(([service, amount]) => ({ service, amount: round(amount, 2) }))
      .sort((a, b) => b.amount - a.amount),
    byWarehouse: [...byWarehouse.entries()]
      .map(([warehouse, v]) => ({
        warehouse,
        amount: round(v.amount, 2),
        credits: round(v.credits, 2),
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}
