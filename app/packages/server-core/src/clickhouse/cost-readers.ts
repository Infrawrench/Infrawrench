import type {
  BillingRuleMatch,
  CompiledBillingAdjustments,
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
  "topN" | "comparePreviousPeriod" | "forecast" | "query" | "adjusted"
> & {
  /**
   * The org's billing rules, already compiled and ordered by the caller.
   *
   * The wire request's `adjusted: boolean` is resolved to this by the service
   * layer — a boolean has no meaning down here, the same way `query` text has
   * none. Absent means the SQL below is byte-identical to what it has always
   * been, which is what every unattended reader (budgets, anomalies, exports,
   * the digest) relies on.
   */
  adjustments?: CompiledBillingAdjustments | undefined;
};

/** One grouped series. `key` is "" when the query is ungrouped. */
export interface CostSeriesGroup {
  key: string;
  currency: string;
  points: CostSeriesPoint[];
  /**
   * The same buckets, unadjusted — set only when `adjustments` were applied.
   *
   * Per-bucket rather than a single total so it converts through exactly the
   * code path `points` does: a raw period total would have no day to pick an
   * exchange rate for, and converting it at the range-end rate while the series
   * converted per day is how "adjusted" and "collected" end up disagreeing by a
   * rate movement rather than by a markup.
   *
   * Read as a partition of the raw money by *adjusted* group, so summing it
   * across every group is the org's collected total for the range. Reading one
   * group's entry as "what this series was before" is only true when no
   * reallocation moved anything into or out of it — which is why the wire shape
   * (`CostAdjustmentSummary.rawTotals`) only exposes the sum.
   */
  rawPoints?: CostSeriesPoint[];
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
 * The amortized money expression, shared with `commitment-readers.ts` so the
 * two cannot drift into disagreeing about what "amortized" means.
 *
 * It falls back to `amount` when the row carries no amortized opinion. That
 * fallback is not a nicety: an org running one provider that amortizes and one
 * that doesn't would otherwise see the second provider's spend vanish entirely
 * the moment the amortized view was selected — not shown as an approximation,
 * not flagged, just gone — and the total would read as a dramatic saving.
 *
 * **"No opinion" is `amortized_reported = 0`, not `amortized_amount = 0`.**
 * Zero is a real amortized amount: a commitment purchase's cash lands on one
 * day and its *value* belongs to the days it buys, so its honest amortized
 * amount on the purchase day is nothing. Falling back for it would render the
 * purchase at full cash price alongside every amortized slice of it —
 * double-counting precisely what amortization exists to smooth.
 *
 * The `OR amortized_amount != 0` arm is what keeps three years of history
 * reading exactly as it does today: rows written before `amortized_reported`
 * existed default it to 0, so a pre-existing row with a non-zero amortized
 * amount still uses it, and one with zero still falls back.
 */
const AMORTIZED_EXPR =
  "if(amortized_reported != 0 OR amortized_amount != 0, amortized_amount, amount)";

/** The money expression a query sums, per {@link CostBasis}. */
function amountExpr(basis: CostBasis | undefined): string {
  return basis === "amortized" ? AMORTIZED_EXPR : "amount";
}

/**
 * The amortized expression, for readers that are amortized-only rather than
 * basis-switchable — commitment coverage and utilization, which have no honest
 * cash form (see `commitment-readers.ts`).
 */
export function amortizedAmountExpr(): string {
  return AMORTIZED_EXPR;
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

/* ------------------------------------------------------------------ *
 * Billing rules, compiled into the scan that was going to run anyway.
 * ------------------------------------------------------------------ */

/**
 * The SQL conditions a rule's match compiles to — an AND of the fields it sets,
 * or `1` (matches everything) when it sets none.
 *
 * Shared by allocation rules and billing rules on purpose: they match on the
 * same `cost_daily` columns with the same semantics, and two builders for one
 * vocabulary is how the showback report and an adjusted total end up disagreeing
 * about which rows a tag rule claims. `BillingRuleMatch` is a superset
 * (`chargeType`), so an allocation match passes through structurally.
 *
 * Every value is bound as a query parameter, never interpolated.
 */
function matchConditions(
  match: BillingRuleMatch,
  params: Record<string, unknown>,
  prefix: string,
): string {
  const conds: string[] = [];
  if (match.tagKey) {
    params[`${prefix}tk`] = match.tagKey;
    if (match.tagValue !== undefined) {
      params[`${prefix}tv`] = match.tagValue;
      conds.push(`tags[{${prefix}tk:String}] = {${prefix}tv:String}`);
    } else {
      conds.push(`mapContains(tags, {${prefix}tk:String})`);
    }
  }
  if (match.accountId) {
    params[`${prefix}a`] = match.accountId;
    conds.push(`account_id = {${prefix}a:String}`);
  }
  if (match.pluginId) {
    params[`${prefix}p`] = match.pluginId;
    conds.push(`plugin_id = {${prefix}p:String}`);
  }
  if (match.service) {
    params[`${prefix}s`] = match.service;
    conds.push(`service = {${prefix}s:String}`);
  }
  if (match.chargeType) {
    params[`${prefix}ct`] = match.chargeType;
    conds.push(`charge_type = {${prefix}ct:String}`);
  }
  return conds.length > 0 ? conds.join(" AND ") : "1";
}

/**
 * The adjusted money expression: the raw one multiplied by every matching
 * percentage rule's factor.
 *
 * `amount * if(c1, 1.1, 1) * if(c2, 0.85, 1)` — a **product of conditional
 * factors**, not a `multiIf`. That is the composition half of the ordering
 * model in SQL: markups genuinely compose, so two 10% rules must give ×1.21,
 * and a first-match-wins expression would silently give ×1.10. Multiplication
 * commutes, so the compiled order does not change the arithmetic; it exists so
 * the same rule set always produces the same SQL.
 *
 * Factors are inlined as literals rather than bound: they are numbers this
 * module derived from a validated `percent` (`1 + percent/100`, bounded to
 * [-100, 1000]), never caller text, and ClickHouse will not parameterise inside
 * an arithmetic expression without a cast that costs more than it buys. Every
 * *match* value is still bound.
 */
function adjustedAmountExpr(
  raw: string,
  factors: CompiledBillingAdjustments["factors"],
  params: Record<string, unknown>,
): string {
  if (factors.length === 0) return raw;
  const terms = factors.map((f, i) => {
    const cond = matchConditions(f.match, params, `bf${i}`);
    // A guard, not a formality: an unbounded literal here would be the one
    // place a rule's number reaches the SQL text.
    const factor = Number.isFinite(f.factor) ? f.factor : 1;
    return `if(${cond}, ${factor}, 1)`;
  });
  return `(${raw}) * ${terms.join(" * ")}`;
}

/**
 * Re-attribution expression for one dimension, first-match-wins across **all**
 * reallocation rules.
 *
 * `kind` is the dimension being rewritten; rules targeting the *other* kind
 * still appear as branches that evaluate to `fallback`. That is not padding —
 * it is what keeps first-match-wins global. A cost-centre rule at priority 0
 * and an account rule at priority 1 that both match the same row must move it
 * to the centre and leave the account alone, and dropping the centre rule from
 * the account expression would let the account rule fire on a row that was
 * already claimed. The graph and the showback report would then disagree about
 * whether that row moved.
 *
 * Reallocation only ever rewrites a *label*. `amount` is untouched by every
 * branch, which is why total spend is conserved by construction rather than by
 * arithmetic that has to be checked.
 */
function reallocationExpr(
  reallocations: CompiledBillingAdjustments["reallocations"],
  kind: "cost_centre" | "account",
  fallback: string,
  params: Record<string, unknown>,
): string {
  if (reallocations.length === 0) return fallback;
  const branches = reallocations.map((r, i) => {
    const cond = matchConditions(r.match, params, `br${i}`);
    if (r.targetKind !== kind) return `${cond}, ${fallback}`;
    params[`br${i}t`] = r.targetId;
    return `${cond}, {br${i}t:String}`;
  });
  return `multiIf(${branches.join(", ")}, ${fallback})`;
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
 *
 * ## Billing rules
 *
 * `adjustments`, when present, compiles the org's rules **into this same
 * statement** — percentage factors into the summed expression, account
 * reallocations into the group expression — and adds one extra aggregate,
 * `sum(raw)`, so the collected figure comes back from the same pass. One scan
 * answers both questions; there is no second query and no post-processing of
 * rows in application code.
 *
 * Cost-centre reallocations appear in the group expression as branches
 * resolving to the unmoved value: they change nothing here (there is no cost
 * centre dimension) but they must still consume their row, or a later
 * account-targeted rule would fire on a row showback already considers moved.
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

  const rawExpr = amountExpr(q.costBasis);
  const adjustments = q.adjustments;
  const moneyExpr = adjustments
    ? adjustedAmountExpr(rawExpr, adjustments.factors, params)
    : rawExpr;

  let groupExpr =
    q.groupBy === "none" ? "''" : dimensionExpr(q.groupBy, q.groupByTagKey, params, "gtag");
  // Only the account dimension can be re-attributed here — it is the only
  // grouping a reallocation names. Grouping by service or region is untouched
  // by a rule that moves an account's spend, which is correct: the money is
  // still that service's, it is just booked to somebody else.
  if (adjustments && q.groupBy === "account") {
    groupExpr = reallocationExpr(adjustments.reallocations, "account", groupExpr, params);
  }

  // The collected figure rides along as a second aggregate over the same scan.
  // It is what makes "an adjusted total is never shown without the raw one" a
  // property of the query rather than a convention callers have to remember.
  const rawSelect = adjustments ? `,\n            sum(${rawExpr}) AS raw_amount` : "";

  const rows = await query<{
    bucket: string;
    grp: string;
    currency: string;
    amount: number;
    raw_amount?: number;
  }>(
    `SELECT ${bucketExpr(q.binning)} AS bucket,
            ${groupExpr} AS grp,
            currency,
            sum(${moneyExpr}) AS amount${rawSelect}
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
      if (adjustments) g.rawPoints = [];
      groups.set(mapKey, g);
    }
    g.points.push({ bucket: r.bucket, amount: Number(r.amount) });
    g.rawPoints?.push({ bucket: r.bucket, amount: Number(r.raw_amount ?? 0) });
  }

  const result = [...groups.values()];
  if (q.binning === "cumulative") {
    for (const g of result) {
      let running = 0;
      g.points = g.points.map((p) => {
        running += p.amount;
        return { bucket: p.bucket, amount: running };
      });
      if (g.rawPoints) {
        let rawRunning = 0;
        g.rawPoints = g.rawPoints.map((p) => {
          rawRunning += p.amount;
          return { bucket: p.bucket, amount: rawRunning };
        });
      }
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
 *
 * Cost centres nest, and deliberately none of that reaches here: this stays a
 * flat, pre-ordered rule list resolving each row to exactly one centre id in a
 * single scan. Parent/child precedence is already baked into the order the
 * caller passes (see `orderAllocationRules`), and the tree — own spend versus
 * subtree spend — is assembled from these sums afterwards in
 * `services/showback.ts`. A query per segment would be one scan of `cost_daily`
 * per node of the tree for an answer one scan already contains.
 *
 * ## Billing rules
 *
 * `adjustments` layers the org's billing rules on top **inside the same
 * statement**: percentage factors multiply the summed amount, and cost-centre
 * reallocations wrap the allocation `multiIf` in a second one that overrides
 * it. Reallocation is why the two `multiIf`s nest rather than merge — the
 * allocation rules answer "where did this land", the billing rules answer "and
 * where should it be billed instead", and collapsing them would make a
 * reallocation indistinguishable from someone editing the allocation rules.
 *
 * `rawAmount` comes back on every row when adjustments are applied, from the
 * same scan, so the caller can always show what was collected.
 */
export async function getShowbackSpend(
  organizationId: string,
  rules: ShowbackRule[],
  from: string,
  to: string,
  costBasis?: CostBasis,
  adjustments?: CompiledBillingAdjustments,
): Promise<Array<{ costCentreId: string; currency: string; amount: number; rawAmount?: number }>> {
  const params: Record<string, unknown> = { orgId: organizationId, from, to };

  const branches: string[] = [];
  rules.forEach((rule, i) => {
    params[`r${i}c`] = rule.costCentreId;
    branches.push(`${matchConditions(rule.match, params, `r${i}`)}, {r${i}c:String}`);
  });

  const allocationExpr = branches.length > 0 ? `multiIf(${branches.join(", ")}, '')` : "''";
  const centreExpr = adjustments
    ? reallocationExpr(adjustments.reallocations, "cost_centre", allocationExpr, params)
    : allocationExpr;

  const rawExpr = amountExpr(costBasis);
  const moneyExpr = adjustments
    ? adjustedAmountExpr(rawExpr, adjustments.factors, params)
    : rawExpr;
  const rawSelect = adjustments ? `, sum(${rawExpr}) AS raw_amount` : "";

  const rows = await query<{
    centre: string;
    currency: string;
    amount: number;
    raw_amount?: number;
  }>(
    `SELECT ${centreExpr} AS centre, currency, sum(${moneyExpr}) AS amount${rawSelect}
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
    ...(adjustments ? { rawAmount: Number(r.raw_amount ?? 0) } : {}),
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
