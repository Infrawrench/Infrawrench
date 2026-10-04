/**
 * Cost collection for New Relic, from the usage events New Relic writes into
 * an organization's account (verified against "Query and alert on usage
 * data", https://docs.newrelic.com/docs/accounts/accounts-billing/new-relic-one-pricing-billing/usage-queries-alerts/,
 * 2026-10):
 *
 * - `NrConsumption`: hourly usage. Data ingest is `productLine =
 *   'DataPlatform'` with `GigabytesIngested`, broken down by `usageMetric`
 *   (the source) and `consumingAccountId`/`consumingAccountName`. Compute is
 *   `metric IN ('CoreCCU', 'AdvancedCCU')` with `consumption`, broken down by
 *   `dimension_productCapability`.
 * - `NrMTDConsumption`: month-to-date aggregates. Users are
 *   `FullPlatformUsersBillable` and `CoreUsersBillable` (`FullUsersBillable`
 *   on organizations still on the original user model); synthetic checks are
 *   `metric = 'SyntheticChecks'` with `billableConsumption`.
 *
 * Usage for a parent account and all its children is recorded in the parent,
 * which is why the account is a credential (the "usage account") rather than
 * every account being queried: querying each would count child usage twice.
 *
 * None of these carry money, so amounts are usage times the rates in
 * `rates.ts` and the manifest declares `estimated`.
 *
 * **Month-to-date differencing.** Billing is monthly: data ingest above the
 * free allowance, users at the month's billable count, synthetic checks
 * beyond the included allowance. Each is turned into daily rows by taking the
 * month-to-date billable amount at the end of each day and writing the
 * difference from the day before, so a month's rows always sum to exactly
 * what the month bills (at the configured rates) even though the first days
 * of a month carry the user charge and the free allowance absorbs the first
 * gigabytes. That needs each month read from its 1st, so collection always
 * fetches whole months and only returns the days inside the requested range.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { NewRelicContext, NrqlRow } from "./api.js";
import { isPermissionError, runNrql } from "./api.js";
import type { NewRelicRates } from "./rates.js";
import { PRODUCTS } from "./rates.js";

const DAY_MS = 86_400_000;

interface Month {
  /** `YYYY-MM-01`. */
  start: string;
  /** First day of the next month, `YYYY-MM-DD`. */
  end: string;
}

/** Calendar months (UTC) that overlap `[from, to]`. */
export function monthsCovering(from: string, to: string): Month[] {
  const out: Month[] = [];
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    out.push({
      start: `${y}-${String(m).padStart(2, "0")}-01`,
      end: `${ny}-${String(nm).padStart(2, "0")}-01`,
    });
    y = ny;
    m = nm;
  }
  return out;
}

/** `SINCE … UNTIL … WITH TIMEZONE 'UTC'` for a month, clamped to now. */
export function monthClause(month: Month, nowMs = Date.now()): string {
  const endMs = Date.parse(`${month.end}T00:00:00Z`);
  const until = endMs > nowMs ? "now" : `'${month.end} 00:00:00'`;
  return `SINCE '${month.start} 00:00:00' UNTIL ${until} WITH TIMEZONE 'UTC'`;
}

function dateOfRow(row: NrqlRow): string | undefined {
  const begin = row["beginTimeSeconds"];
  if (typeof begin !== "number") return undefined;
  return new Date(begin * 1000).toISOString().slice(0, 10);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * A facet attribute from a FACET … TIMESERIES row. NerdGraph returns each
 * facet attribute under its own name and also as the `facet` array (or a
 * bare string for a single facet); the name is preferred and the array
 * position is the fallback.
 */
export function facetValue(row: NrqlRow, name: string, index: number): string {
  const direct = row[name];
  if (direct !== undefined && direct !== null) return String(direct);
  const facet = row["facet"];
  if (Array.isArray(facet)) {
    const v = facet[index];
    return v === undefined || v === null ? "" : String(v);
  }
  if (index === 0 && (typeof facet === "string" || typeof facet === "number")) return String(facet);
  return "";
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function inRange(date: string, range: CostFetchRange): boolean {
  return date >= range.fromDate && date <= range.toDate;
}

function daysOf(month: Month, nowMs: number): string[] {
  const out: string[] = [];
  const endMs = Math.min(Date.parse(`${month.end}T00:00:00Z`), nowMs + DAY_MS);
  for (let t = Date.parse(`${month.start}T00:00:00Z`); t < endMs; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Turn a month-to-date series into daily increments. `mtdByDay` holds the
 * month-to-date value at the end of each day it was reported; days without a
 * report carry the previous value forward. Never negative: a count that
 * drops (a correction) restates the day it dropped on as zero rather than
 * writing a negative charge.
 */
export function dailyIncrements(
  days: string[],
  mtdByDay: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  let previous = 0;
  let carried = 0;
  for (const day of days) {
    const reported = mtdByDay.get(day);
    if (reported !== undefined) carried = Math.max(carried, reported);
    out.set(day, Math.max(0, carried - previous));
    previous = carried;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data ingest
// ---------------------------------------------------------------------------

interface IngestCell {
  date: string;
  accountId: string;
  accountName: string;
  source: string;
  gb: number;
}

async function ingestRows(
  ctx: NewRelicContext,
  usageAccountId: number,
  rates: NewRelicRates,
  month: Month,
  range: CostFetchRange,
  nowMs: number,
): Promise<CostRow[]> {
  const results = await runNrql(
    ctx,
    usageAccountId,
    `SELECT sum(GigabytesIngested) AS 'gb' FROM NrConsumption WHERE productLine = 'DataPlatform' FACET consumingAccountId, consumingAccountName, usageMetric ${monthClause(month, nowMs)} TIMESERIES 1 day LIMIT MAX`,
    120,
  );
  const cells: IngestCell[] = [];
  const totals = new Map<string, number>();
  for (const row of results) {
    const date = dateOfRow(row);
    const gb = num(row["gb"]);
    if (!date || gb <= 0) continue;
    cells.push({
      date,
      accountId: facetValue(row, "consumingAccountId", 0),
      accountName: facetValue(row, "consumingAccountName", 1),
      source: facetValue(row, "usageMetric", 2),
      gb,
    });
    totals.set(date, (totals.get(date) ?? 0) + gb);
  }
  // Billable gigabytes per day: the month-to-date total above the free
  // allowance at the end of the day, minus the same at the end of the
  // previous day.
  const billableByDay = new Map<string, number>();
  let cumulative = 0;
  for (const day of daysOf(month, nowMs)) {
    const before = Math.max(0, cumulative - rates.freeGbPerMonth);
    cumulative += totals.get(day) ?? 0;
    const after = Math.max(0, cumulative - rates.freeGbPerMonth);
    billableByDay.set(day, after - before);
  }
  const rows: CostRow[] = [];
  for (const c of cells) {
    if (!inRange(c.date, range)) continue;
    const total = totals.get(c.date) ?? 0;
    const billable = total > 0 ? ((billableByDay.get(c.date) ?? 0) * c.gb) / total : 0;
    rows.push({
      date: c.date,
      service: PRODUCTS.dataIngest,
      region: ctx.region.id,
      tags: {
        ...(c.accountId ? { account: c.accountName || c.accountId, accountId: c.accountId } : {}),
        ...(c.source ? { source: c.source } : {}),
      },
      currency: "USD",
      amount: round(billable * rates.dataPerGb),
      usageAmount: round(c.gb),
      usageUnit: "GB",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

async function computeRows(
  ctx: NewRelicContext,
  usageAccountId: number,
  rates: NewRelicRates,
  month: Month,
  range: CostFetchRange,
  nowMs: number,
): Promise<CostRow[]> {
  const metrics: string[] = [];
  if (rates.coreCcu !== undefined) metrics.push("'CoreCCU'");
  if (rates.advancedCcu !== undefined) metrics.push("'AdvancedCCU'");
  if (metrics.length === 0) return [];
  const results = await runNrql(
    ctx,
    usageAccountId,
    `SELECT sum(consumption) AS 'ccu' FROM NrConsumption WHERE metric IN (${metrics.join(", ")}) FACET metric, dimension_productCapability, consumingAccountId, consumingAccountName ${monthClause(month, nowMs)} TIMESERIES 1 day LIMIT MAX`,
    120,
  );
  const rows: CostRow[] = [];
  for (const row of results) {
    const date = dateOfRow(row);
    const ccu = num(row["ccu"]);
    if (!date || ccu <= 0 || !inRange(date, range)) continue;
    const metric = facetValue(row, "metric", 0);
    const advanced = metric === "AdvancedCCU";
    const rate = advanced ? rates.advancedCcu : rates.coreCcu;
    if (rate === undefined) continue;
    const capability = facetValue(row, "dimension_productCapability", 1);
    const accountId = facetValue(row, "consumingAccountId", 2);
    const accountName = facetValue(row, "consumingAccountName", 3);
    rows.push({
      date,
      service: advanced ? PRODUCTS.advancedCompute : PRODUCTS.coreCompute,
      region: ctx.region.id,
      tags: {
        ...(accountId ? { account: accountName || accountId, accountId } : {}),
        ...(capability ? { capability } : {}),
      },
      currency: "USD",
      amount: round(ccu * rate),
      usageAmount: round(ccu),
      usageUnit: "CCU",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Users and synthetic checks (month-to-date counts)
// ---------------------------------------------------------------------------

async function mtdRows(
  ctx: NewRelicContext,
  usageAccountId: number,
  rates: NewRelicRates,
  month: Month,
  range: CostFetchRange,
  nowMs: number,
): Promise<CostRow[]> {
  const clause = monthClause(month, nowMs);
  const [users, synthetics] = await Promise.all([
    runNrql(
      ctx,
      usageAccountId,
      `SELECT latest(FullPlatformUsersBillable) AS 'full', latest(FullUsersBillable) AS 'legacyFull', latest(CoreUsersBillable) AS 'core' FROM NrMTDConsumption ${clause} TIMESERIES 1 day`,
    ),
    runNrql(
      ctx,
      usageAccountId,
      `SELECT latest(billableConsumption) AS 'billable' FROM NrMTDConsumption WHERE metric = 'SyntheticChecks' ${clause} TIMESERIES 1 day`,
    ),
  ]);
  const days = daysOf(month, nowMs);
  const series = (rows: NrqlRow[], pick: (r: NrqlRow) => number | undefined) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const date = dateOfRow(r);
      const v = pick(r);
      if (date && v !== undefined) m.set(date, v);
    }
    return m;
  };
  const value = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const full = series(users, (r) => value(r["full"]) ?? value(r["legacyFull"]));
  const core = series(users, (r) => value(r["core"]));
  const checks = series(synthetics, (r) => value(r["billable"]));

  const out: CostRow[] = [];
  const emit = (
    increments: Map<string, number>,
    service: string,
    rate: number,
    unit: string,
  ): void => {
    for (const [date, qty] of increments) {
      if (qty <= 0 || !inRange(date, range)) continue;
      out.push({
        date,
        service,
        region: ctx.region.id,
        currency: "USD",
        amount: round(qty * rate),
        usageAmount: round(qty),
        usageUnit: unit,
      });
    }
  };
  emit(dailyIncrements(days, full), PRODUCTS.fullPlatformUsers, rates.fullPlatformUser, "Users");
  emit(dailyIncrements(days, core), PRODUCTS.coreUsers, rates.coreUser, "Users");
  emit(dailyIncrements(days, checks), PRODUCTS.syntheticChecks, rates.syntheticCheck, "Checks");
  return out;
}

/**
 * Daily estimated cost rows for `range`, by product (`service`), with the
 * consuming account and the ingest source or compute capability as tags.
 */
export async function fetchNewRelicCostData(
  ctx: NewRelicContext,
  usageAccountId: number,
  rates: NewRelicRates,
  range: CostFetchRange,
  nowMs = Date.now(),
): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  try {
    for (const month of monthsCovering(range.fromDate, range.toDate)) {
      if (Date.parse(`${month.start}T00:00:00Z`) > nowMs) break;
      const [ingest, compute, mtd] = await Promise.all([
        ingestRows(ctx, usageAccountId, rates, month, range, nowMs),
        computeRows(ctx, usageAccountId, rates, month, range, nowMs),
        mtdRows(ctx, usageAccountId, rates, month, range, nowMs),
      ]);
      rows.push(...ingest, ...compute, ...mtd);
    }
  } catch (err) {
    if (isPermissionError(err)) {
      throw new CostSetupError(
        `The New Relic user key cannot query usage in account ${usageAccountId}. Pick the organization's parent (or reporting) account as the usage account, and use a key whose user can query data in it.`,
        {
          label: "Usage data in New Relic",
          url: "https://docs.newrelic.com/docs/accounts/accounts-billing/new-relic-one-pricing-billing/usage-queries-alerts/",
        },
      );
    }
    throw err;
  }
  return aggregate(rows);
}

/** Collapse rows that share a date and every dimension (cost_daily keys on them). */
function aggregate(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const r of rows) {
    const key = JSON.stringify([r.date, r.service, r.region, r.tags ?? {}, r.usageUnit]);
    const existing = byKey.get(key);
    if (existing) {
      existing.amount = round(existing.amount + r.amount);
      existing.usageAmount = round((existing.usageAmount ?? 0) + (r.usageAmount ?? 0));
    } else {
      byKey.set(key, { ...r, ...(r.tags ? { tags: { ...r.tags } } : {}) });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Month-to-date summary for the account detail view
// ---------------------------------------------------------------------------

export interface UsageSummary {
  month: string;
  gigabytesIngested?: number;
  billableGigabytes?: number;
  fullPlatformUsers?: number;
  coreUsers?: number;
  basicUsers?: number;
  coreCcu?: number;
  advancedCcu?: number;
  syntheticChecksIncluded?: number;
  syntheticChecksBillable?: number;
  /** Estimated month-to-date cost per product, at the configured rates. */
  costs: Array<{ product: string; usage: string; amount?: number }>;
  totalCost: number;
  byAccount: Array<{ account: string; gigabytes: number }>;
  bySource: Array<{ source: string; gigabytes: number }>;
}

const fmt = (n: number, digits = 2) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

export async function fetchUsageSummary(
  ctx: NewRelicContext,
  usageAccountId: number,
  rates: NewRelicRates,
  nowMs = Date.now(),
): Promise<UsageSummary> {
  const month = new Date(nowMs).toISOString().slice(0, 7);
  const since = "SINCE this month WITH TIMEZONE 'UTC'";
  const [mtd, compute, synth, accounts, sources] = await Promise.all([
    runNrql(
      ctx,
      usageAccountId,
      `SELECT latest(GigabytesIngested) AS 'gb', latest(GigabytesIngestedBillable) AS 'billableGb', latest(FullPlatformUsersBillable) AS 'full', latest(FullUsersBillable) AS 'legacyFull', latest(CoreUsersBillable) AS 'core', latest(BasicUsersBillable) AS 'basic' FROM NrMTDConsumption ${since}`,
    ),
    runNrql(
      ctx,
      usageAccountId,
      `SELECT latest(consumption) AS 'ccu' FROM NrMTDConsumption WHERE metric IN ('CoreCCU', 'AdvancedCCU') FACET metric ${since}`,
    ).catch(() => [] as NrqlRow[]),
    runNrql(
      ctx,
      usageAccountId,
      `SELECT latest(freeConsumption) AS 'free', latest(billableConsumption) AS 'billable' FROM NrMTDConsumption WHERE metric = 'SyntheticChecks' ${since}`,
    ).catch(() => [] as NrqlRow[]),
    runNrql(
      ctx,
      usageAccountId,
      `SELECT sum(GigabytesIngested) AS 'gb' FROM NrConsumption WHERE productLine = 'DataPlatform' FACET consumingAccountName ${since} LIMIT 25`,
    ).catch(() => [] as NrqlRow[]),
    runNrql(
      ctx,
      usageAccountId,
      `SELECT sum(GigabytesIngested) AS 'gb' FROM NrConsumption WHERE productLine = 'DataPlatform' FACET usageMetric ${since} LIMIT 25`,
    ).catch(() => [] as NrqlRow[]),
  ]);
  const v = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const m = mtd[0] ?? {};
  const summary: UsageSummary = { month, costs: [], totalCost: 0, byAccount: [], bySource: [] };
  const gb = v(m["gb"]);
  const billableGb =
    v(m["billableGb"]) ?? (gb !== undefined ? Math.max(0, gb - rates.freeGbPerMonth) : undefined);
  const full = v(m["full"]) ?? v(m["legacyFull"]);
  const core = v(m["core"]);
  const basic = v(m["basic"]);
  if (gb !== undefined) summary.gigabytesIngested = gb;
  if (billableGb !== undefined) summary.billableGigabytes = billableGb;
  if (full !== undefined) summary.fullPlatformUsers = full;
  if (core !== undefined) summary.coreUsers = core;
  if (basic !== undefined) summary.basicUsers = basic;
  for (const row of compute) {
    const metric = facetValue(row, "metric", 0);
    const ccu = v(row["ccu"]);
    if (ccu === undefined) continue;
    if (metric === "CoreCCU") summary.coreCcu = ccu;
    if (metric === "AdvancedCCU") summary.advancedCcu = ccu;
  }
  const s = synth[0] ?? {};
  const included = v(s["free"]);
  const billableChecks = v(s["billable"]);
  if (included !== undefined) summary.syntheticChecksIncluded = included;
  if (billableChecks !== undefined) summary.syntheticChecksBillable = billableChecks;

  const add = (product: string, usage: string, amount: number | undefined) => {
    summary.costs.push({ product, usage, ...(amount !== undefined ? { amount } : {}) });
    if (amount !== undefined) summary.totalCost += amount;
  };
  if (gb !== undefined) {
    add(
      PRODUCTS.dataIngest,
      `${fmt(gb)} GB (${fmt(billableGb ?? 0)} GB billable)`,
      (billableGb ?? 0) * rates.dataPerGb,
    );
  }
  if (full !== undefined)
    add(PRODUCTS.fullPlatformUsers, fmt(full, 0), full * rates.fullPlatformUser);
  if (core !== undefined) add(PRODUCTS.coreUsers, fmt(core, 0), core * rates.coreUser);
  if (summary.coreCcu !== undefined) {
    add(
      PRODUCTS.coreCompute,
      `${fmt(summary.coreCcu)} CCU`,
      rates.coreCcu !== undefined ? summary.coreCcu * rates.coreCcu : undefined,
    );
  }
  if (summary.advancedCcu !== undefined) {
    add(
      PRODUCTS.advancedCompute,
      `${fmt(summary.advancedCcu)} CCU`,
      rates.advancedCcu !== undefined ? summary.advancedCcu * rates.advancedCcu : undefined,
    );
  }
  if (billableChecks !== undefined) {
    add(
      PRODUCTS.syntheticChecks,
      `${fmt(billableChecks, 0)} billable (${fmt(included ?? 0, 0)} included)`,
      billableChecks * rates.syntheticCheck,
    );
  }
  summary.totalCost = round(summary.totalCost);
  summary.byAccount = accounts
    .map((r) => ({ account: facetValue(r, "consumingAccountName", 0), gigabytes: num(r["gb"]) }))
    .filter((r) => r.account && r.gigabytes > 0);
  summary.bySource = sources
    .map((r) => ({ source: facetValue(r, "usageMetric", 0), gigabytes: num(r["gb"]) }))
    .filter((r) => r.source && r.gigabytes > 0);
  return summary;
}
