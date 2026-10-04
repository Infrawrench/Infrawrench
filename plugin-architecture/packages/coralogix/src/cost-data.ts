/**
 * Spend collection from Coralogix data usage.
 *
 * Coralogix's API reports usage in *units* (see `usage.ts`), never money: the
 * price of a unit is set by the team's plan or contract and no API exposes it.
 * Coralogix publishes one list price, "1 unit = $1.50 of usage for logs,
 * metrics, or traces in any pipeline"
 * (https://coralogix.com/docs/user-guides/account-management/payment-and-billing/data-usage/,
 * verified 2026-10), so that is the default, and the account carries an
 * editable "Price per unit" credential for a contracted rate. Every amount is
 * therefore `units × unit price`, which is why the manifest declares
 * `estimated: true`.
 *
 * Rows are one per day, pillar and TCO priority: `service` is the pillar
 * ("Logs", "Traces"...), `region` is the Coralogix region, and the `pillar`
 * and `priority` tags carry the raw pillar and the TCO priority by the TCO
 * Optimizer's names (Frequent Search, Monitoring, Compliance, Blocked), so a
 * cost report can split the bill by how data is routed, which is the lever
 * Coralogix gives you to change it. `usageAmount` is the units the row was
 * priced from.
 *
 * Requests are made a month at a time. The Data Usage page itself offers 90
 * days; the API also takes a year-long preset, so the history bound is a year
 * and a window older than the server will answer (400) is skipped as empty
 * rather than failing the whole backfill.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { CoralogixContext } from "./api.js";
import { isPermissionError, statusOf } from "./api.js";
import type { UsageCell } from "./usage.js";
import { PILLAR_LABELS, PRIORITY_LABELS, fetchUsageCells } from "./usage.js";

/** Coralogix's published list price: 1 unit = $1.50. */
export const DEFAULT_UNIT_PRICE_USD = 1.5;

/** Days per usage request. */
export const CHUNK_DAYS = 31;

const DAY_MS = 86_400_000;

const PERMISSION_HELP = {
  label: "Coralogix API keys",
  url: "https://coralogix.com/docs/user-guides/account-management/api-keys/api-keys/",
};

/**
 * Parse the account's unit price. Blank means the published default; anything
 * that is not a positive number is a setup problem the user has to fix, not a
 * reason to price everything at zero.
 */
export function parseUnitPrice(raw: string | undefined): number {
  const value = (raw ?? "").trim().replace(/^\$/, "").replace(",", ".");
  if (!value) return DEFAULT_UNIT_PRICE_USD;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CostSetupError(
      `The account's price per unit ("${raw}") is not a positive number. Edit the account and enter your plan's price per Coralogix unit in US dollars, or clear the field to use the published $1.50.`,
    );
  }
  return n;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Split an inclusive range into consecutive windows of at most `days`. */
export function chunkRange(range: CostFetchRange, days = CHUNK_DAYS): CostFetchRange[] {
  const out: CostFetchRange[] = [];
  let start = Date.parse(`${range.fromDate}T00:00:00Z`);
  const end = Date.parse(`${range.toDate}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = Math.min(end, start + (days - 1) * DAY_MS);
    out.push({ fromDate: utcDate(start), toDate: utcDate(chunkEnd) });
    start = chunkEnd + DAY_MS;
  }
  return out;
}

/** Price usage cells into cost rows, merged by their final key. */
export function cellsToCostRows(
  cells: UsageCell[],
  unitPrice: number,
  regionId: string,
): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const c of cells) {
    if (!(c.units > 0)) continue;
    const priority = c.priority ? PRIORITY_LABELS[c.priority] : undefined;
    const key = `${c.date}|${c.pillar}|${priority ?? ""}`;
    const existing = rows.get(key);
    if (existing) {
      existing.amount += c.units * unitPrice;
      existing.usageAmount = (existing.usageAmount ?? 0) + c.units;
      continue;
    }
    rows.set(key, {
      date: c.date,
      service: PILLAR_LABELS[c.pillar],
      region: regionId,
      tags: { pillar: c.pillar, ...(priority ? { priority } : {}) },
      currency: "USD",
      amount: c.units * unitPrice,
      usageAmount: c.units,
      usageUnit: "units",
    });
  }
  return [...rows.values()];
}

export async function fetchCoralogixCostData(
  ctx: CoralogixContext,
  range: CostFetchRange,
  unitPrice: number,
): Promise<CostRow[]> {
  const cells: UsageCell[] = [];
  const chunks = chunkRange(range);
  for (const [i, chunk] of chunks.entries()) {
    try {
      cells.push(...(await fetchUsageCells(ctx, chunk)));
    } catch (err) {
      if (isPermissionError(err)) {
        throw new CostSetupError(
          "Coralogix refused the data usage request. Give the API key the DataUsage preset (the data-usage:Read permission) in Settings, API Keys.",
          PERMISSION_HELP,
        );
      }
      // An old window beyond what the server keeps answers 400; the newest
      // window must work, so only earlier ones may be skipped.
      if (statusOf(err) === 400 && i < chunks.length - 1) continue;
      throw err;
    }
  }
  return cellsToCostRows(cells, unitPrice, ctx.region.id);
}
