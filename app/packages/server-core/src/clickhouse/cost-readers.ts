import type {
  CostBasis,
  CostBinningId,
  CostChargeType,
  CostDimensionId,
  CostFilter,
  CostQueryRequest,
  CostSeriesPoint,
} from "@infrawrench/client-core";
import { getClickHouseClient, isClickHouseConfigured } from "./client";

/**
 * The query vocabulary is the cost contract in `@infrawrench/client-core` —
 * the same dimensions, binnings, and filters the widget config stores and the
 * API validates. `budgets.filters` is read through this module *and* through
 * the client-side type, so restating it here would let the two halves of one
 * jsonb column drift.
 */
export type CostBinning = CostBinningId;
export type CostDimension = CostDimensionId;
export type { CostBasis, CostChargeType, CostFilter };

/**
 * What ClickHouse itself can answer. The wire request carries three more
 * knobs (`topN`, `comparePreviousPeriod`, `forecast`) that the web service
 * layer resolves into extra queries before getting here.
 *
 * `query` — the cost query language's text form — is omitted for a different
 * reason, and deliberately: it is compiled to `filters` by the service layer,
 * and this type is where that is enforced. Query *text* has no meaning down
 * here and must never acquire one; the only thing that reaches the SQL below is
 * a `CostFilter[]` whose values are bound as parameters like every other
 * filter's.
 */
export type CostQuery = Omit<
  CostQueryRequest,
  "topN" | "comparePreviousPeriod" | "forecast" | "query"
>;

/** One grouped series. `key` is "" when the query is ungrouped. */
export interface CostSeriesGroup {
  key: string;
  currency: string;
  points: CostSeriesPoint[];
}

async function query<T>(sql: string, query_params: Record<string, unknown>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  const rs = await getClickHouseClient().query({ query: sql, query_params, format: "JSONEachRow" });
  return await rs.json<T>();
}

/**
 * Column expression for a dimension. Tag dimensions read from the Map column
 * via a bound parameter; everything else is a plain column.
 */
function dimensionExpr(
  dimension: CostDimension,
  tagKey: string | undefined,
  params: Record<string, unknown>,
  paramName: string,
): string {
  switch (dimension) {
    case "provider":
      return "plugin_id";
    case "account":
      return "account_id";
    case "service":
      return "service";
    case "region":
      return "region";
    case "resource":
      return "resource_id";
    case "charge_type":
      return "charge_type";
    case "commitment":
      return "commitment_id";
    case "tag": {
      if (!tagKey) throw new Error("tagKey is required for the tag dimension");
      params[paramName] = tagKey;
      return `tags[{${paramName}:String}]`;
    }
  }
}

/**
 * The money expression a query sums, per {@link CostBasis}.
 *
 * The amortized form falls back to `amount` whenever `amortized_amount` is 0,
 * which is the stored form of "this provider reports no amortized number". The
 * fallback is not a nicety: an org running one provider that amortizes and one
 * that doesn't would otherwise see the second provider's spend vanish entirely
 * the moment the amortized view was selected — not shown as an approximation,
 * not flagged, just gone — and the total would read as a dramatic saving. A row
 * genuinely worth nothing on this basis has `amount` of 0 too, so the fallback
 * costs nothing where it doesn't apply.
 */
function amountExpr(basis: CostBasis | undefined): string {
  return basis === "amortized" ? "if(amortized_amount != 0, amortized_amount, amount)" : "amount";
}

/**
 * `charge_type IN (...)` when the caller narrowed the charge types, otherwise
 * nothing. Absent means every type, credits and refunds included — that is what
 * makes an unfiltered total the net number the provider would invoice.
 */
function chargeTypeClause(
  chargeTypes: CostChargeType[] | undefined,
  params: Record<string, unknown>,
  paramName = "chargeTypes",
): string | null {
  if (!chargeTypes || chargeTypes.length === 0) return null;
  params[paramName] = chargeTypes;
  return `charge_type IN {${paramName}:Array(String)}`;
}

function bucketExpr(binning: CostBinning): string {
  switch (binning) {
    case "weekly":
      return "toString(toStartOfWeek(day, 1))";
    case "monthly":
      return "toString(toStartOfMonth(day))";
    // Cumulative is a running sum over daily buckets, applied after the query.
    case "daily":
    case "cumulative":
      return "toString(day)";
  }
}

/**
 * Aggregate cost_daily into per-bucket, per-group, per-currency sums.
 * Currencies are never merged — mixed-currency orgs get one series per
 * currency and the UI labels them. Uses FINAL so restated rows
 * (ReplacingMergeTree versions) never double-count.
 *
 * `costBasis` picks which money column is summed and `chargeTypes` narrows
 * which rows count; both default to the behaviour that predates them (cash,
 * every charge type), so a caller that sets neither gets the old query.
 */
export async function queryCosts(organizationId: string, q: CostQuery): Promise<CostSeriesGroup[]> {
  const params: Record<string, unknown> = { orgId: organizationId, from: q.from, to: q.to };
  const where = [
    "organization_id = {orgId:String}",
    "day >= toDate({from:String})",
    "day <= toDate({to:String})",
  ];

  q.filters.forEach((f, i) => {
    const expr = dimensionExpr(f.dimension, f.tagKey, params, `ftag${i}`);
    params[`fvals${i}`] = f.values;
    where.push(`${expr} ${f.op === "in" ? "IN" : "NOT IN"} {fvals${i}:Array(String)}`);
  });

  const chargeTypes = chargeTypeClause(q.chargeTypes, params);
  if (chargeTypes) where.push(chargeTypes);

  const groupExpr =
    q.groupBy === "none" ? "''" : dimensionExpr(q.groupBy, q.groupByTagKey, params, "gtag");

  const rows = await query<{ bucket: string; grp: string; currency: string; amount: number }>(
    `SELECT ${bucketExpr(q.binning)} AS bucket,
            ${groupExpr} AS grp,
            currency,
            sum(${amountExpr(q.costBasis)}) AS amount
     FROM cost_daily FINAL
     WHERE ${where.join(" AND ")}
     GROUP BY bucket, grp, currency
     ORDER BY bucket ASC`,
    params,
  );

  const groups = new Map<string, CostSeriesGroup>();
  for (const r of rows) {
    const mapKey = `${r.grp}\x00${r.currency}`;
    let g = groups.get(mapKey);
    if (!g) {
      g = { key: r.grp, currency: r.currency, points: [] };
      groups.set(mapKey, g);
    }
    g.points.push({ bucket: r.bucket, amount: Number(r.amount) });
  }

  const result = [...groups.values()];
  if (q.binning === "cumulative") {
    for (const g of result) {
      let running = 0;
      g.points = g.points.map((p) => {
        running += p.amount;
        return { bucket: p.bucket, amount: running };
      });
    }
  }
  return result;
}

/** One provider-native resource's summed spend over a date range. */
export interface ResourceCostTotal {
  accountId: string;
  /** Provider-native id as the plugin's `fetchCostData` reported it. */
  resourceId: string;
  currency: string;
  amount: number;
}

/**
 * Trailing spend per provider-native resource id. Feeds the orphan finder's
 * best-effort cost annotation: callers match `resourceId` against
 * `resources.externalId` in memory. Only plugins that declare the `resource`
 * cost dimension produce rows here, so sparse results are expected.
 *
 * `costBasis` is offered because "what does this idle volume cost us" is an
 * amortized question wherever a commitment covers it — but it defaults to cash,
 * since the orphan finder's number is a bill the reader recognises.
 */
export async function getResourceCostTotals(
  organizationId: string,
  from: string,
  to: string,
  costBasis?: CostBasis,
): Promise<ResourceCostTotal[]> {
  const rows = await query<{
    account_id: string;
    resource_id: string;
    currency: string;
    amount: number;
  }>(
    `SELECT account_id, resource_id, currency, sum(${amountExpr(costBasis)}) AS amount
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
       AND resource_id != ''
     GROUP BY account_id, resource_id, currency`,
    { orgId: organizationId, from, to },
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    resourceId: r.resource_id,
    currency: r.currency,
    amount: Number(r.amount),
  }));
}

/** Distinct values of a dimension within an org (for filter/group pickers). */
export async function getCostDimensionValues(
  organizationId: string,
  dimension: CostDimension,
  opts?: { tagKey?: string; from?: string; to?: string },
): Promise<string[]> {
  const params: Record<string, unknown> = { orgId: organizationId };
  const where = ["organization_id = {orgId:String}"];
  if (opts?.from) {
    params.from = opts.from;
    where.push("day >= toDate({from:String})");
  }
  if (opts?.to) {
    params.to = opts.to;
    where.push("day <= toDate({to:String})");
  }
  const expr = dimensionExpr(dimension, opts?.tagKey, params, "tagKey");
  const rows = await query<{ value: string }>(
    `SELECT DISTINCT ${expr} AS value
     FROM cost_daily
     WHERE ${where.join(" AND ")} AND ${expr} != ''
     ORDER BY value ASC
     LIMIT 500`,
    params,
  );
  return rows.map((r) => r.value);
}

/** Distinct tag keys present in an org's cost data. */
export async function getCostTagKeys(organizationId: string): Promise<string[]> {
  const rows = await query<{ key: string }>(
    `SELECT DISTINCT arrayJoin(mapKeys(tags)) AS key
     FROM cost_daily
     WHERE organization_id = {orgId:String}
     ORDER BY key ASC
     LIMIT 200`,
    { orgId: organizationId },
  );
  return rows.map((r) => r.key);
}

/** Aggregate spend split by whether rows carry every required tag key. */
export interface UntaggedSpendRows {
  /** Per currency: total spend and spend missing at least one required key. */
  totals: Array<{ currency: string; total: number; untagged: number }>;
  /** Per required key, per currency: spend on rows missing that key. */
  byKey: Array<{ key: string; currency: string; untagged: number }>;
  /** Largest untagged (account, service) buckets, descending. */
  topUntagged: Array<{ accountId: string; service: string; currency: string; amount: number }>;
}

/**
 * Untagged spend over the org's required tag keys: how much of the range's
 * spend is on rows missing at least one required key, overall and per key.
 * "Carries the key" is `mapContains` — a present-but-empty value counts as
 * tagged here (billing exports rarely emit empty tag values, and spend-side
 * strictness belongs to the resource compliance report, not the money view).
 *
 * Follows the caller's `costBasis`: the report's whole claim is "this much of
 * your spend can't be attributed to anyone", and it has to be a percentage of
 * the same total the graphs above it show, or the two disagree on screen.
 */
export async function getUntaggedSpend(
  organizationId: string,
  requiredKeys: string[],
  from: string,
  to: string,
  costBasis?: CostBasis,
): Promise<UntaggedSpendRows> {
  if (requiredKeys.length === 0) return { totals: [], byKey: [], topUntagged: [] };

  const params: Record<string, unknown> = { orgId: organizationId, from, to };
  requiredKeys.forEach((key, i) => {
    params[`key${i}`] = key;
  });
  const hasAll = requiredKeys.map((_, i) => `mapContains(tags, {key${i}:String})`).join(" AND ");
  const missingAny = `NOT (${hasAll})`;
  const money = amountExpr(costBasis);

  const totalsSelect = requiredKeys
    .map((_, i) => `sumIf(${money}, NOT mapContains(tags, {key${i}:String})) AS missing_${i}`)
    .join(",\n            ");

  const totalsRows = await query<Record<string, string | number>>(
    `SELECT currency,
            sum(${money}) AS total,
            sumIf(${money}, ${missingAny}) AS untagged,
            ${totalsSelect}
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
     GROUP BY currency
     ORDER BY currency ASC`,
    params,
  );

  const totals = totalsRows.map((r) => ({
    currency: String(r.currency),
    total: Number(r.total),
    untagged: Number(r.untagged),
  }));
  const byKey: UntaggedSpendRows["byKey"] = [];
  for (const r of totalsRows) {
    requiredKeys.forEach((key, i) => {
      byKey.push({ key, currency: String(r.currency), untagged: Number(r[`missing_${i}`]) });
    });
  }

  const topRows = await query<{
    account_id: string;
    service: string;
    currency: string;
    amount: number;
  }>(
    `SELECT account_id, service, currency, sum(${money}) AS amount
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
       AND ${missingAny}
     GROUP BY account_id, service, currency
     ORDER BY amount DESC
     LIMIT 15`,
    params,
  );

  return {
    totals,
    byKey,
    topUntagged: topRows.map((r) => ({
      accountId: r.account_id,
      service: r.service,
      currency: r.currency,
      amount: Number(r.amount),
    })),
  };
}

/** One allocation rule as the showback reader consumes it. */
export interface ShowbackRule {
  costCentreId: string;
  match: {
    tagKey?: string | undefined;
    tagValue?: string | undefined;
    accountId?: string | undefined;
    pluginId?: string | undefined;
    service?: string | undefined;
  };
}

/**
 * Spend per cost centre via first-match-wins allocation rules, compiled into
 * one `multiIf` so ClickHouse walks `cost_daily` once. `rules` must already be
 * in evaluation order (ascending priority). Rows no rule claims come back
 * under the empty-string centre id — the caller labels that "Unallocated".
 *
 * Follows the caller's `costBasis`. Showback is the report where the basis
 * matters most: charging a team the full cash value of a three-year commitment
 * in the month it was signed is not a chargeback anyone can budget against.
 */
export async function getShowbackSpend(
  organizationId: string,
  rules: ShowbackRule[],
  from: string,
  to: string,
  costBasis?: CostBasis,
): Promise<Array<{ costCentreId: string; currency: string; amount: number }>> {
  const params: Record<string, unknown> = { orgId: organizationId, from, to };

  const branches: string[] = [];
  rules.forEach((rule, i) => {
    const conds: string[] = [];
    const m = rule.match;
    if (m.tagKey) {
      params[`r${i}tk`] = m.tagKey;
      if (m.tagValue !== undefined) {
        params[`r${i}tv`] = m.tagValue;
        conds.push(`tags[{r${i}tk:String}] = {r${i}tv:String}`);
      } else {
        conds.push(`mapContains(tags, {r${i}tk:String})`);
      }
    }
    if (m.accountId) {
      params[`r${i}a`] = m.accountId;
      conds.push(`account_id = {r${i}a:String}`);
    }
    if (m.pluginId) {
      params[`r${i}p`] = m.pluginId;
      conds.push(`plugin_id = {r${i}p:String}`);
    }
    if (m.service) {
      params[`r${i}s`] = m.service;
      conds.push(`service = {r${i}s:String}`);
    }
    params[`r${i}c`] = rule.costCentreId;
    branches.push(`${conds.length > 0 ? conds.join(" AND ") : "1"}, {r${i}c:String}`);
  });

  const centreExpr = branches.length > 0 ? `multiIf(${branches.join(", ")}, '')` : "''";

  const rows = await query<{ centre: string; currency: string; amount: number }>(
    `SELECT ${centreExpr} AS centre, currency, sum(${amountExpr(costBasis)}) AS amount
     FROM cost_daily FINAL
     WHERE organization_id = {orgId:String}
       AND day >= toDate({from:String})
       AND day <= toDate({to:String})
     GROUP BY centre, currency
     ORDER BY amount DESC`,
    params,
  );
  return rows.map((r) => ({
    costCentreId: r.centre,
    currency: r.currency,
    amount: Number(r.amount),
  }));
}

/** Earliest and latest cost day per account — drives backfill/status UI. */
export async function getCostCoverage(
  organizationId: string,
): Promise<Map<string, { firstDay: string; lastDay: string }>> {
  const rows = await query<{ account_id: string; first_day: string; last_day: string }>(
    `SELECT account_id,
            toString(min(day)) AS first_day,
            toString(max(day)) AS last_day
     FROM cost_daily
     WHERE organization_id = {orgId:String}
     GROUP BY account_id`,
    { orgId: organizationId },
  );
  const result = new Map<string, { firstDay: string; lastDay: string }>();
  for (const r of rows) result.set(r.account_id, { firstDay: r.first_day, lastDay: r.last_day });
  return result;
}
