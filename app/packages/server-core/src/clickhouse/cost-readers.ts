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
import { and, asc, desc, eq, gte, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured, type ClickHouseDb } from "./client";
import { costDaily } from "./schema";

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
 * a `CostFilter[]` whose values go through the dialect's own escaping like
 * every other filter's.
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
   * been: no factor, no reallocation, no second aggregate, not even a projected
   * `raw_amount`. That is what every unattended reader (budgets, anomalies,
   * exports, the digest) relies on.
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

/**
 * Unconfigured deployments have no cost history, so `[]` is the truth there. A
 * configured-but-failing ClickHouse throws, so the caller's request fails
 * loudly rather than rendering an outage as "you have spent nothing".
 */
async function query<T>(build: (db: ClickHouseDb) => Promise<T[]>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  return await build(getClickHouseDb());
}

/**
 * Column expression for a dimension. Tag dimensions read from the Map column;
 * everything else is a plain column.
 */
function dimensionExpr(dimension: CostDimension, tagKey: string | undefined): SQL {
  switch (dimension) {
    case "provider":
      return sql`${costDaily.plugin_id}`;
    case "account":
      return sql`${costDaily.account_id}`;
    case "service":
      return sql`${costDaily.service}`;
    case "region":
      return sql`${costDaily.region}`;
    case "resource":
      return sql`${costDaily.resource_id}`;
    case "charge_type":
      return sql`${costDaily.charge_type}`;
    case "commitment":
      return sql`${costDaily.commitment_id}`;
    case "tag": {
      if (!tagKey) throw new Error("tagKey is required for the tag dimension");
      return sql`${costDaily.tags}[${tagKey}]`;
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
export function amortizedAmountExpr(): SQL {
  return sql`if(${costDaily.amortized_reported} != 0 OR ${costDaily.amortized_amount} != 0, ${costDaily.amortized_amount}, ${costDaily.amount})`;
}

/** The money expression a query sums, per {@link CostBasis}. */
function amountExpr(basis: CostBasis | undefined): SQL {
  return basis === "amortized" ? amortizedAmountExpr() : sql`${costDaily.amount}`;
}

/**
 * The `[from, to]` day-range predicate every `cost_daily` reader filters on.
 *
 * Shared so no reader can get the comparison wrong. `day` is a `Date` column and
 * the bounds are `"YYYY-MM-DD"` strings, which the column's own mapping renders
 * as `toDate('…')` — comparing a `String` against a `Date` is a hard error in
 * ClickHouse rather than a coercion, and this is what keeps it from happening.
 *
 * The builder also qualifies the column as `cost_daily`.`day`, which matters
 * more than it looks: ClickHouse resolves SELECT aliases inside `WHERE`, unlike
 * standard SQL, and several readers below project `toString(day) AS day`. An
 * unqualified `day` in the predicate would bind to *that alias* and the query
 * would die with "There is no supertype for types String, Date". A qualified
 * identifier cannot bind to a projection alias.
 */
export function dayRange(from: string, to: string): SQL {
  return and(gte(costDaily.day, from), lte(costDaily.day, to))!;
}

/**
 * `charge_type IN (...)` when the caller narrowed the charge types, otherwise
 * nothing. Absent means every type, credits and refunds included — that is what
 * makes an unfiltered total the net number the provider would invoice.
 */
function chargeTypeCondition(chargeTypes: CostChargeType[] | undefined): SQL | undefined {
  if (!chargeTypes || chargeTypes.length === 0) return undefined;
  return inArray(costDaily.charge_type, chargeTypes);
}

/**
 * `expr IN (values)` / `expr NOT IN (values)`, including for the empty list.
 *
 * Drizzle refuses an empty `inArray`, but an empty filter list is reachable from
 * the wire and used to mean "match nothing" (and, negated, "match everything").
 * Spelling those out keeps a saved filter that lost its last value behaving the
 * way it did before, instead of throwing on read.
 */
export function membershipCondition(expr: SQL, op: CostFilter["op"], values: string[]): SQL {
  if (values.length === 0) return op === "in" ? sql`0` : sql`1`;
  return op === "in" ? inArray(expr, values) : notInArray(expr, values);
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
 * Every value goes through the dialect's literal escaping, never interpolation.
 */
function matchConditions(match: BillingRuleMatch): SQL {
  const conds: SQL[] = [];
  if (match.tagKey) {
    conds.push(
      match.tagValue !== undefined
        ? sql`${costDaily.tags}[${match.tagKey}] = ${match.tagValue}`
        : sql`mapContains(${costDaily.tags}, ${match.tagKey})`,
    );
  }
  if (match.accountId) conds.push(eq(costDaily.account_id, match.accountId));
  if (match.pluginId) conds.push(eq(costDaily.plugin_id, match.pluginId));
  if (match.service) conds.push(eq(costDaily.service, match.service));
  if (match.chargeType) conds.push(eq(costDaily.charge_type, match.chargeType));
  return conds.length > 0 ? sql.join(conds, sql` AND `) : sql`1`;
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
 * Factors are rendered as bare numeric literals rather than through the string
 * escaping every match value gets: they are numbers this module derived from a
 * validated `percent` (`1 + percent/100`, bounded to [-100, 1000]), never caller
 * text. The `Number.isFinite` guard is what keeps that true.
 */
function adjustedAmountExpr(raw: SQL, factors: CompiledBillingAdjustments["factors"]): SQL {
  if (factors.length === 0) return raw;
  const terms = factors.map((f) => {
    // A guard, not a formality: an unbounded value here would be the one place
    // a rule's number reaches the SQL text.
    const factor = Number.isFinite(f.factor) ? f.factor : 1;
    return sql`if(${matchConditions(f.match)}, ${sql.raw(String(factor))}, 1)`;
  });
  return sql`(${raw}) * ${sql.join(terms, sql` * `)}`;
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
  fallback: SQL,
): SQL {
  if (reallocations.length === 0) return fallback;
  const branches = reallocations.map((r) => {
    const cond = matchConditions(r.match);
    return r.targetKind !== kind ? sql`${cond}, ${fallback}` : sql`${cond}, ${r.targetId}`;
  });
  return sql`multiIf(${sql.join(branches, sql`, `)}, ${fallback})`;
}

function bucketExpr(binning: CostBinning): SQL {
  switch (binning) {
    case "weekly":
      return sql`toString(toStartOfWeek(${costDaily.day}, 1))`;
    case "monthly":
      return sql`toString(toStartOfMonth(${costDaily.day}))`;
    // Cumulative is a running sum over daily buckets, applied after the query.
    case "daily":
    case "cumulative":
      return sql`toString(${costDaily.day})`;
  }
}

/**
 * One row of {@link queryCosts}'s scan.
 *
 * `raw_amount` is optional because the column is only *projected* when billing
 * rules are in force — not defaulted to zero when they are not. A cost reader
 * that hands back a plausible `0` for "what we collected" is worse than one that
 * hands back nothing: `undefined` fails loudly at the first arithmetic, a zero
 * renders as a number somebody bills against.
 */
interface QueryCostsRow {
  bucket: unknown;
  grp: unknown;
  currency: string;
  amount: number;
  raw_amount?: number;
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
  const rawExpr = amountExpr(q.costBasis);
  const adjustments = q.adjustments;
  const moneyExpr = adjustments ? adjustedAmountExpr(rawExpr, adjustments.factors) : rawExpr;

  let groupExpr = q.groupBy === "none" ? sql`''` : dimensionExpr(q.groupBy, q.groupByTagKey);
  // Only the account dimension can be re-attributed here — it is the only
  // grouping a reallocation names. Grouping by service or region is untouched
  // by a rule that moves an account's spend, which is correct: the money is
  // still that service's, it is just booked to somebody else.
  if (adjustments && q.groupBy === "account") {
    groupExpr = reallocationExpr(adjustments.reallocations, "account", groupExpr);
  }

  const where = and(
    eq(costDaily.organization_id, organizationId),
    dayRange(q.from, q.to),
    ...q.filters.map((f) =>
      membershipCondition(dimensionExpr(f.dimension, f.tagKey), f.op, f.values),
    ),
    chargeTypeCondition(q.chargeTypes),
  );
  const selection = {
    bucket: bucketExpr(q.binning).as("bucket"),
    grp: groupExpr.as("grp"),
    currency: costDaily.currency,
    amount: sql<number>`sum(${moneyExpr})`.as("amount"),
  };

  // The collected figure rides along as a second aggregate over the same scan.
  // It is what makes "an adjusted total is never shown without the raw one" a
  // property of the query rather than a convention callers have to remember —
  // and it is projected **only** when there are rules, so an unadjusted read
  // cannot hand anything a zero that looks like a collected total.
  //
  // Two chains rather than one over a computed selection: the builder's types
  // track which clauses a query has used, and a selection it cannot see the
  // shape of collapses that bookkeeping into a union with no `.groupBy` on it.
  const rows: QueryCostsRow[] = await query((db) =>
    adjustments
      ? db
          .select({ ...selection, raw_amount: sql<number>`sum(${rawExpr})`.as("raw_amount") })
          .from(costDaily)
          .final()
          .where(where)
          .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
          .orderBy(asc(sql`bucket`))
      : db
          .select(selection)
          .from(costDaily)
          .final()
          .where(where)
          .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
          .orderBy(asc(sql`bucket`)),
  );

  const groups = new Map<string, CostSeriesGroup>();
  for (const r of rows) {
    const mapKey = `${r.grp}\x00${r.currency}`;
    let g = groups.get(mapKey);
    if (!g) {
      g = { key: String(r.grp), currency: r.currency, points: [] };
      if (adjustments) g.rawPoints = [];
      groups.set(mapKey, g);
    }
    g.points.push({ bucket: String(r.bucket), amount: Number(r.amount) });
    // `rawPoints` exists only when rules were applied, which is exactly when
    // the projection carried `raw_amount`. The two conditions are the same
    // `adjustments` check, so this never reads a column that was not selected.
    if (g.rawPoints) g.rawPoints.push({ bucket: String(r.bucket), amount: Number(r.raw_amount) });
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
  const rows = await query((db) =>
    db
      .select({
        account_id: costDaily.account_id,
        resource_id: costDaily.resource_id,
        currency: costDaily.currency,
        amount: sql<number>`sum(${amountExpr(costBasis)})`.as("amount"),
      })
      .from(costDaily)
      .final()
      .where(
        and(
          eq(costDaily.organization_id, organizationId),
          dayRange(from, to),
          sql`${costDaily.resource_id} != ''`,
        ),
      )
      .groupBy(costDaily.account_id, costDaily.resource_id, costDaily.currency),
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
  const expr = dimensionExpr(dimension, opts?.tagKey);
  const rows = await query((db) =>
    db
      .selectDistinct({ value: expr.as("value") })
      .from(costDaily)
      .where(
        and(
          eq(costDaily.organization_id, organizationId),
          opts?.from ? gte(costDaily.day, opts.from) : undefined,
          opts?.to ? lte(costDaily.day, opts.to) : undefined,
          sql`${expr} != ''`,
        ),
      )
      .orderBy(asc(sql`value`))
      .limit(500),
  );
  return rows.map((r) => String(r.value));
}

/** Distinct tag keys present in an org's cost data. */
export async function getCostTagKeys(organizationId: string): Promise<string[]> {
  const rows = await query((db) =>
    db
      .selectDistinct({ key: sql<string>`arrayJoin(mapKeys(${costDaily.tags}))`.as("key") })
      .from(costDaily)
      .where(eq(costDaily.organization_id, organizationId))
      .orderBy(asc(sql`key`))
      .limit(200),
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

  const hasKey = (key: string) => sql`mapContains(${costDaily.tags}, ${key})`;
  const missingAny = sql`NOT (${sql.join(requiredKeys.map(hasKey), sql` AND `)})`;
  const money = amountExpr(costBasis);
  const scope = and(eq(costDaily.organization_id, organizationId), dayRange(from, to));

  // One `sumIf` per required key, selected alongside the totals so the whole
  // report is a single scan. The keys are the org's own configuration, but the
  // aliases they land under are generated here rather than derived from them —
  // a tag key is arbitrary user text and has no business being an identifier.
  const perKey = Object.fromEntries(
    requiredKeys.map((key, i) => [
      `missing_${i}`,
      sql<number>`sumIf(${money}, NOT ${hasKey(key)})`.as(`missing_${i}`),
    ]),
  ) as Record<string, SQL.Aliased<number>>;

  const totalsRows = await query((db) =>
    db
      .select({
        currency: costDaily.currency,
        total: sql<number>`sum(${money})`.as("total"),
        untagged: sql<number>`sumIf(${money}, ${missingAny})`.as("untagged"),
        ...perKey,
      })
      .from(costDaily)
      .final()
      .where(scope)
      .groupBy(costDaily.currency)
      .orderBy(asc(costDaily.currency)),
  );

  const totals = totalsRows.map((r) => ({
    currency: String(r.currency),
    total: Number(r.total),
    untagged: Number(r.untagged),
  }));
  const byKey: UntaggedSpendRows["byKey"] = [];
  for (const r of totalsRows) {
    requiredKeys.forEach((key, i) => {
      byKey.push({
        key,
        currency: String(r.currency),
        untagged: Number((r as Record<string, unknown>)[`missing_${i}`]),
      });
    });
  }

  const topRows = await query((db) =>
    db
      .select({
        account_id: costDaily.account_id,
        service: costDaily.service,
        currency: costDaily.currency,
        amount: sql<number>`sum(${money})`.as("amount"),
      })
      .from(costDaily)
      .final()
      .where(and(scope, missingAny))
      .groupBy(costDaily.account_id, costDaily.service, costDaily.currency)
      .orderBy(desc(sql`amount`))
      .limit(15),
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
  const branches = rules.map((rule) => sql`${matchConditions(rule.match)}, ${rule.costCentreId}`);
  const allocationExpr =
    branches.length > 0 ? sql`multiIf(${sql.join(branches, sql`, `)}, '')` : sql`''`;
  const centreExpr = adjustments
    ? reallocationExpr(adjustments.reallocations, "cost_centre", allocationExpr)
    : allocationExpr;

  const rawExpr = amountExpr(costBasis);
  const moneyExpr = adjustments ? adjustedAmountExpr(rawExpr, adjustments.factors) : rawExpr;

  const where = and(eq(costDaily.organization_id, organizationId), dayRange(from, to));
  const selection = {
    centre: centreExpr.as("centre"),
    currency: costDaily.currency,
    amount: sql<number>`sum(${moneyExpr})`.as("amount"),
  };
  // Projected only when rules are in force — see `QueryCostsRow` for why an
  // unadjusted read must return no collected figure rather than a zero one.
  const rows: Array<{
    centre: unknown;
    currency: string;
    amount: number;
    raw_amount?: number;
  }> = await query((db) =>
    adjustments
      ? db
          .select({ ...selection, raw_amount: sql<number>`sum(${rawExpr})`.as("raw_amount") })
          .from(costDaily)
          .final()
          .where(where)
          .groupBy(sql`centre`, costDaily.currency)
          .orderBy(desc(sql`amount`))
      : db
          .select(selection)
          .from(costDaily)
          .final()
          .where(where)
          .groupBy(sql`centre`, costDaily.currency)
          .orderBy(desc(sql`amount`)),
  );

  return rows.map((r) => ({
    costCentreId: String(r.centre),
    currency: r.currency,
    amount: Number(r.amount),
    ...(adjustments ? { rawAmount: Number(r.raw_amount) } : {}),
  }));
}

/** Earliest and latest cost day per account — drives backfill/status UI. */
export async function getCostCoverage(
  organizationId: string,
): Promise<Map<string, { firstDay: string; lastDay: string }>> {
  const rows = await query((db) =>
    db
      .select({
        account_id: costDaily.account_id,
        first_day: sql<string>`toString(min(${costDaily.day}))`.as("first_day"),
        last_day: sql<string>`toString(max(${costDaily.day}))`.as("last_day"),
      })
      .from(costDaily)
      .where(eq(costDaily.organization_id, organizationId))
      .groupBy(costDaily.account_id),
  );
  const result = new Map<string, { firstDay: string; lastDay: string }>();
  for (const r of rows) result.set(r.account_id, { firstDay: r.first_day, lastDay: r.last_day });
  return result;
}
