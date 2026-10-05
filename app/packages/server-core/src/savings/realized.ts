/**
 * Realized savings: the gathering half. `math.ts` is the arithmetic.
 *
 * ## Computed lazily, on read: deliberately
 *
 * Nothing realized is stored. Provider billing arrives late and is restated
 * (`DEFAULT_RESTATEMENT_DAYS`, and far more for the period-native plugins), so
 * a realized figure computed the week after a resize is computed against data
 * still filling in; a stored one would freeze that and need an invalidation
 * rule mirroring every collector's restatement horizon. Recomputing on read
 * makes "the figure improves as billing lands" a property of the design. The
 * cost is two or three ClickHouse range-scans per report, the shapes the cost
 * graphs already run.
 *
 * Lives in `server-core` rather than `web` because the weekly digest runs in
 * the poller, which cannot import web.
 */
import {
  orderAllocationRules,
  REALIZED_SAVINGS_LIMITS,
  SAVINGS_EVENT_KIND_LABELS,
  type RealizedSavingsReport,
  type SavingsEventKind,
  type SavingsEventResult,
} from "@infrawrench/client-core";

import { getCostCoverage, queryCosts } from "../clickhouse/cost-readers";
import { listAllocationRules, listCostCentres } from "../cost/allocation";
import { addDays, isoDay } from "../cost/dates";
import { strictlyVisibleAccountIds } from "../cost/visibility-context";
import { getPlugin } from "../plugin-loader";
import {
  accountNamesFor,
  listSavingsEventRows,
  toSavingsEvent,
  type SavingsEventRow,
} from "./events";
import {
  aggregateRealizedSavings,
  attributeCostCentre,
  computeCommitmentRealization,
  computeRealization,
  horizonMonthsToDays,
  rangeDays,
  type DailySeries,
} from "./math";
import { getOrgSavingsSettings } from "./settings";

/** Oldest billing day ever read: `cost_daily`'s TTL is three years. */
const MAX_LOOKBACK_DAYS = 3 * 366;

/** A caller mistake the API maps to a 400. */
export class RealizedSavingsRangeError extends Error {}

export interface RealizedSavingsOptions {
  from?: string | undefined;
  to?: string | undefined;
  /** Injectable for tests. */
  now?: Date | undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The default range: the last twelve calendar months through yesterday. */
export function defaultSavingsRange(today: string): { from: string; to: string } {
  const to = addDays(today, -1);
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return { from: isoDay(d), to };
}

export function resolveSavingsRange(
  options: RealizedSavingsOptions,
  today: string,
): { from: string; to: string } {
  const def = defaultSavingsRange(today);
  const from = options.from ?? def.from;
  const to = options.to ?? def.to;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) {
    throw new RealizedSavingsRangeError("from and to must be YYYY-MM-DD");
  }
  if (from > to) throw new RealizedSavingsRangeError("from must not be after to");
  if (rangeDays(from, to) > REALIZED_SAVINGS_LIMITS.maxRangeDays) {
    throw new RealizedSavingsRangeError(
      `A savings report covers at most ${REALIZED_SAVINGS_LIMITS.maxRangeDays} days`,
    );
  }
  return { from, to };
}

async function periodNativePlugins(pluginIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of new Set(pluginIds)) {
    const loaded = await getPlugin(id);
    if (loaded?.plugin.manifest.costs?.periodNative === true) out.add(id);
  }
  return out;
}

/** Per-resource daily spend for every event's resource, in one read. */
async function loadResourceSeries(
  organizationId: string,
  rows: SavingsEventRow[],
  from: string,
  to: string,
): Promise<Map<string, DailySeries[]>> {
  const out = new Map<string, DailySeries[]>();
  const externalIds = [
    ...new Set(rows.map((r) => r.externalId).filter((id): id is string => Boolean(id))),
  ];
  const accountIds = [
    ...new Set(rows.map((r) => r.accountId).filter((id): id is string => Boolean(id))),
  ];
  if (externalIds.length === 0 || from > to) return out;
  const groups = await queryCosts(organizationId, {
    from,
    to,
    binning: "daily",
    groupBy: "resource",
    filters: [
      { dimension: "resource", op: "in", values: externalIds },
      ...(accountIds.length > 0
        ? [{ dimension: "account" as const, op: "in" as const, values: accountIds }]
        : []),
    ],
  });
  for (const g of groups) {
    const list = out.get(g.key) ?? [];
    list.push({
      currency: g.currency,
      points: g.points.map((p) => ({ day: p.bucket, amount: p.amount })),
    });
    out.set(g.key, list);
  }
  return out;
}

/** Per (account, currency): daily discount (positive) and amortized fee. */
async function loadCommitmentDays(
  organizationId: string,
  from: string,
  to: string,
): Promise<
  Map<
    string,
    { accountId: string; currency: string; discount: Map<string, number>; fee: Map<string, number> }
  >
> {
  const out = new Map<
    string,
    { accountId: string; currency: string; discount: Map<string, number>; fee: Map<string, number> }
  >();
  if (from > to) return out;
  const [discounts, fees] = await Promise.all([
    queryCosts(organizationId, {
      from,
      to,
      binning: "daily",
      groupBy: "account",
      costBasis: "cash",
      filters: [{ dimension: "charge_type", op: "in", values: ["commitment_discount"] }],
    }),
    queryCosts(organizationId, {
      from,
      to,
      binning: "daily",
      groupBy: "account",
      costBasis: "amortized",
      filters: [{ dimension: "charge_type", op: "in", values: ["commitment_fee"] }],
    }),
  ]);
  const entry = (accountId: string, currency: string) => {
    const key = `${accountId} ${currency}`;
    let e = out.get(key);
    if (!e) {
      e = { accountId, currency, discount: new Map(), fee: new Map() };
      out.set(key, e);
    }
    return e;
  };
  // The discount line is written negative; its magnitude is the on-demand
  // value the commitment offset.
  for (const g of discounts) {
    const e = entry(g.key, g.currency);
    for (const p of g.points) e.discount.set(p.bucket, (e.discount.get(p.bucket) ?? 0) - p.amount);
  }
  for (const g of fees) {
    const key = `${g.key} ${g.currency}`;
    // Fees only matter where a discount line exists to net them against.
    const e = out.get(key);
    if (!e) continue;
    for (const p of g.points) e.fee.set(p.bucket, (e.fee.get(p.bucket) ?? 0) + p.amount);
  }
  return out;
}

/** The realized savings report for an org. */
export async function getRealizedSavingsReport(
  organizationId: string,
  options: RealizedSavingsOptions = {},
): Promise<RealizedSavingsReport> {
  const now = options.now ?? new Date();
  const today = isoDay(now);
  const yesterday = addDays(today, -1);
  const range = resolveSavingsRange(options, today);
  const settings = await getOrgSavingsSettings(organizationId);

  // Cost visibility: an event is per account, with no cost row to test a
  // centre or saved filter against, so a scoped caller sees only events on
  // accounts granted to them outright (the credits/commitments rule).
  const visible = strictlyVisibleAccountIds(organizationId);
  const rows = (await listSavingsEventRows(organizationId, range.to)).filter(
    (r) => !visible || (r.accountId !== null && visible.has(r.accountId)),
  );

  const oldestNeeded = rows.reduce((min, r) => {
    const start = addDays(r.occurredOn, -settings.baselineWindowDays);
    return start < min ? start : min;
  }, range.from);
  const fetchFrom =
    oldestNeeded < addDays(today, -MAX_LOOKBACK_DAYS)
      ? addDays(today, -MAX_LOOKBACK_DAYS)
      : oldestNeeded;

  const [coverage, series, commitmentDays, centres, rules, periodNative] = await Promise.all([
    getCostCoverage(organizationId),
    loadResourceSeries(organizationId, rows, fetchFrom, yesterday),
    loadCommitmentDays(organizationId, range.from, range.to < yesterday ? range.to : yesterday),
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
    periodNativePlugins(rows.map((r) => r.pluginId).filter((p): p is string => Boolean(p))),
  ]);
  const orderedRules = orderAllocationRules(rules, centres);
  const centreNames = new Map(centres.map((c) => [c.id, c.name]));

  const accountIds = [
    ...rows.map((r) => r.accountId).filter((id): id is string => Boolean(id)),
    ...[...commitmentDays.values()].map((c) => c.accountId),
  ];
  const accountInfo = await accountNamesFor(organizationId, accountIds);

  const results: Array<
    SavingsEventResult & { months: Array<{ month: string; realized: number; projected: number }> }
  > = [];

  for (const row of rows) {
    const recurring = row.kind === "sleep_schedule";
    const horizonMonths = row.horizonMonths ?? settings.horizonMonths;
    const realization = computeRealization({
      kind: row.kind as SavingsEventKind,
      occurredOn: row.occurredOn,
      endedOn: row.endedOn,
      horizonDays: recurring ? null : horizonMonthsToDays(horizonMonths),
      today,
      range,
      baselineWindowDays: settings.baselineWindowDays,
      shortfallThreshold: settings.shortfallThresholdPercent / 100,
      coverage: row.accountId ? (coverage.get(row.accountId) ?? null) : null,
      series: row.externalId ? (series.get(row.externalId) ?? []) : [],
      costAddressable: Boolean(row.externalId && row.accountId),
      periodNative: row.pluginId ? periodNative.has(row.pluginId) : false,
      projectedMonthly: row.projectedMonthlyAmount,
      currency: row.currency,
      baselineDailyEstimate: row.baselineDailyEstimate,
      postDailyEstimate: row.postDailyEstimate,
      offFraction: row.offFraction,
      manual: row.kind === "manual",
    });
    const attributed =
      row.costCentreId ??
      attributeCostCentre(orderedRules, {
        accountId: row.accountId,
        pluginId: row.pluginId,
        tags: row.tags ?? null,
      });
    const account = row.accountId ? accountInfo.get(row.accountId) : undefined;
    results.push({
      ...toSavingsEvent(row, account?.displayName ?? null),
      ...realization,
      attributedCostCentreId: attributed,
      attributedCostCentreName: attributed ? (centreNames.get(attributed) ?? null) : null,
      editable: row.kind === "manual" ? "full" : "annotate",
    });
  }

  for (const c of commitmentDays.values()) {
    if (visible && !visible.has(c.accountId)) continue;
    const r = computeCommitmentRealization({ discountByDay: c.discount, feeByDay: c.fee, range });
    if (r.measuredDays === 0) continue;
    const account = accountInfo.get(c.accountId);
    const attributed = attributeCostCentre(orderedRules, {
      accountId: c.accountId,
      pluginId: account?.pluginId ?? null,
      tags: null,
    });
    const nowIso = now.toISOString();
    results.push({
      id: `commitment:${c.accountId}:${c.currency}`,
      kind: "commitment",
      source: "derived",
      title: `Commitment discounts on ${account?.displayName ?? c.accountId}`,
      note:
        `On-demand value offset ${r.discount.toFixed(2)} ${c.currency}, less ` +
        `${r.fee.toFixed(2)} ${c.currency} of amortized commitment fees, over ${r.measuredDays} days ` +
        "with a discount line. Reservations whose discount is built into the rate write no such " +
        "line and are not counted.",
      occurredOn: r.firstDay ?? range.from,
      endedOn: null,
      accountId: c.accountId,
      accountName: account?.displayName ?? null,
      pluginId: account?.pluginId ?? null,
      resourceTypeId: null,
      resourceId: null,
      resourceName: null,
      costCentreId: null,
      projectedMonthlyAmount: null,
      currency: c.currency,
      horizonMonths: null,
      costAnnotationId: null,
      createdByUserId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      basis: "billing",
      status: "accruing",
      realizedCurrency: c.currency,
      baselinePerDay: null,
      currentPerDay: null,
      realizedToDate: r.realized,
      realizedInRange: r.realized,
      projectedInRange: null,
      accruedDays: r.measuredDays,
      horizonEndsOn: null,
      attributedCostCentreId: attributed,
      attributedCostCentreName: attributed ? (centreNames.get(attributed) ?? null) : null,
      shortfall: null,
      editable: "none",
      months: r.months.map((m) => ({ ...m, projected: 0 })),
    });
  }

  const aggregate = aggregateRealizedSavings(results, (kind) => SAVINGS_EVENT_KIND_LABELS[kind]);
  results.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0));

  return {
    from: range.from,
    to: range.to,
    settings,
    ...aggregate,
    events: results.map(({ months: _months, ...rest }) => rest),
    shortfallCount: results.filter((r) => r.shortfall !== null).length,
    unmeasuredCount: results.filter((r) => r.basis === "unmeasured").length,
  };
}
