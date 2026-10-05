import type {
  BillingRuleMatch,
  CompiledBillingAdjustments,
  CostBasis,
  CostBinningId,
  CostBinSize,
  CostChargeType,
  CostDimensionId,
  CostFilter,
  CostGranularity,
  CostQueryRequest,
  CostSeriesPoint,
} from "@infrawrench/client-core";
import {
  effectiveCostBinning,
  HOURLY_BINNING_UNAVAILABLE_REASON,
  referencedVirtualTagKeys,
} from "@infrawrench/client-core";
import { and, asc, desc, eq, gte, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured, type ClickHouseDb } from "./client";
import {
  dayRange,
  membershipCondition,
  physicalDimensionExpr,
  type PhysicalCostDimension,
} from "./cost-sql";
import { aiCostAttributed, costDaily } from "./schema";
import {
  VirtualTagScope,
  virtualTagRuleIndexExpr,
  withVirtualTagJoins,
  type CompiledVirtualTag,
  type VirtualTagDefinitions,
} from "./virtual-tag-sql";
import {
  costVisibilityLayersFor,
  type CompiledCostVisibilityLayer,
} from "../cost/visibility-context";

// Re-exported so the modules that already import them from here (the export
// row builder, the commitment readers, the tests) keep one import path.
export { dayRange, membershipCondition };
export type { VirtualTagDefinitions };

/**
 * The query vocabulary is the cost contract in `@infrawrench/client-core`:
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
 * `query` (the cost query language's text form) is omitted for a different
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
   * layer: a boolean has no meaning down here, the same way `query` text has
   * none. Absent means the SQL below is byte-identical to what it has always
   * been: no factor, no reallocation, no second aggregate, not even a projected
   * `raw_amount`. That is what every unattended reader (budgets, anomalies,
   * exports, the digest) relies on.
   */
  adjustments?: CompiledBillingAdjustments | undefined;
  /**
   * The org's virtual tags this query references, compiled for the range.
   *
   * Optional, and resolved lazily when absent: a query whose filters or
   * grouping mention `virtual_tag` loads exactly those definitions itself (see
   * {@link resolveVirtualTags}), so every unattended reader (budgets, change
   * alerts, report delivery, unit costs) understands virtual tags without each
   * of them learning to. A key that resolves to nothing throws; it never
   * degrades to unfiltered spend.
   */
  virtualTags?: VirtualTagDefinitions | undefined;
};

/**
 * The virtual tag definitions a read needs: `provided` when it already covers
 * every referenced key, otherwise loaded from Postgres for exactly those keys.
 *
 * The loader is imported dynamically on purpose. This module is otherwise
 * ClickHouse-only, and `cost/virtual-tags.ts` opens a database connection as an
 * import side effect; a static import would hand that to every consumer of a
 * cost reader, including the tests and tools that never touch a virtual tag.
 * A query that references none never reaches the import at all.
 */
export async function resolveVirtualTags(
  organizationId: string,
  keys: readonly string[],
  from: string,
  to: string,
  provided?: VirtualTagDefinitions,
): Promise<VirtualTagDefinitions | undefined> {
  if (keys.length === 0) return provided;
  if (provided && keys.every((k) => provided.has(k))) return provided;
  const { loadVirtualTagDefinitions } = await import("../cost/virtual-tags");
  return loadVirtualTagDefinitions(organizationId, keys, from, to);
}

/** One grouped series. `key` is "" when the query is ungrouped. */
export interface CostSeriesGroup {
  key: string;
  currency: string;
  points: CostSeriesPoint[];
  /**
   * The same buckets, unadjusted: set only when `adjustments` were applied.
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
   * reallocation moved anything into or out of it, which is why the wire shape
   * (`CostAdjustmentSummary.rawTotals`) only exposes the sum.
   */
  rawPoints?: CostSeriesPoint[];
}

/* ------------------------------------------------------------------ *
 * The attributed view: AI caller dimensions.
 * ------------------------------------------------------------------ */

/** Tag-key prefix of the AI caller dimensions (`caller:team`). See `ai-attribution/`. */
const CALLER_TAG_PREFIX = "caller:";

/** The `cost_daily` columns both halves of the attributed view project, in order. */
const COST_VIEW_COLUMNS = [
  "organization_id",
  "account_id",
  "plugin_id",
  "day",
  "service",
  "region",
  "resource_id",
  "tags",
  "tags_hash",
  "currency",
  "amount",
  "usage_amount",
  "usage_unit",
  "ingested_at",
  "charge_type",
  "amortized_amount",
  "amortized_reported",
  "commitment_id",
] as const;

/**
 * `cost_daily` columns the caller splits have no counterpart for, with the
 * value the split half projects in their place. A zero `*_reported` flag makes
 * a split read as its amortized amount on the blended basis and as unlisted
 * for re-rating: a split is a share of a billed AI row, which is never a
 * commitment-blended or list-priced line.
 */
const BILLED_ONLY_COLUMNS = {
  list_amount: sql`toFloat64(0)`,
  list_reported: sql`toUInt8(0)`,
  blended_amount: sql`toFloat64(0)`,
  blended_reported: sql`toUInt8(0)`,
} as const;

/** The split half's projection: its own columns, then the billed-only defaults. */
function splitColumns(a: typeof aiCostAttributed): SQL {
  return sql.join(
    [
      ...COST_VIEW_COLUMNS.map((c) => sql`${a[c]}`),
      ...Object.entries(BILLED_ONLY_COLUMNS).map(
        ([name, value]) => sql`${value} AS ${sql.identifier(name)}`,
      ),
    ],
    sql`, `,
  );
}

/** True when any of these tag keys names an AI caller dimension. */
export function referencesCallerTags(tagKeys: Array<string | undefined>): boolean {
  return tagKeys.some((k) => typeof k === "string" && k.startsWith(CALLER_TAG_PREFIX));
}

/**
 * `cost_daily` with each attributed day's AI rows replaced by their caller
 * splits, aliased as `cost_daily` so every column reference, filter and
 * visibility layer below resolves against it unchanged.
 *
 * Only reached when a query names a `caller:` tag key; every other read is
 * byte-identical to what it was. Conservation is structural: the second half
 * holds, for each day an attribution run covered, splits that sum to every
 * AI-tagged row of that day, and the first half drops exactly those rows (AI
 * rows on days with a run). A day with no run keeps its billed rows, which
 * simply carry no caller tag. Latest run per day wins, so a run in progress is
 * invisible until it is complete.
 */
export function attributedCostSource(organizationId: string, from: string, to: string): SQL {
  const billedCols = sql.join(
    [
      ...COST_VIEW_COLUMNS.map((c) => sql`${costDaily[c]}`),
      ...(Object.keys(BILLED_ONLY_COLUMNS) as Array<keyof typeof BILLED_ONLY_COLUMNS>).map(
        (c) => sql`${costDaily[c]}`,
      ),
    ],
    sql`, `,
  );
  const splitCols = splitColumns(aiCostAttributed);
  const runDays = sql`SELECT ${aiCostAttributed.day} FROM ${aiCostAttributed} WHERE ${aiCostAttributed.organization_id} = ${organizationId} AND ${aiCostAttributed.day} >= ${sql`toDate(${from})`} AND ${aiCostAttributed.day} <= ${sql`toDate(${to})`}`;
  return sql`(SELECT ${billedCols} FROM ${costDaily} FINAL WHERE ${costDailyOrgCondition(organizationId)} AND ${dayRange(from, to)} AND NOT (mapContains(${costDaily.tags}, 'ai:provider') AND ${costDaily.day} IN (${runDays})) UNION ALL SELECT ${splitCols} FROM ${aiCostAttributed} WHERE ${aiCostAttributed.organization_id} = ${organizationId} AND ${aiCostAttributed.day} >= ${sql`toDate(${from})`} AND ${aiCostAttributed.day} <= ${sql`toDate(${to})`} AND (${aiCostAttributed.day}, ${aiCostAttributed.run_at}) IN (SELECT ${aiCostAttributed.day}, max(${aiCostAttributed.run_at}) FROM ${aiCostAttributed} WHERE ${aiCostAttributed.organization_id} = ${organizationId} AND ${aiCostAttributed.day} >= ${sql`toDate(${from})`} AND ${aiCostAttributed.day} <= ${sql`toDate(${to})`} GROUP BY ${aiCostAttributed.day})) AS ${sql.identifier("cost_daily")}`;
}

/**
 * Only the caller splits (`ai_cost_attributed`, latest run per day), aliased
 * as `cost_daily` so `costDailyOrgCondition` and its visibility layers apply
 * to them exactly as to billed rows. Feeds the caller-key and caller-value
 * pickers and the spend-by-caller breakdown. `from`/`to` are optional: the
 * pickers look at all history.
 */
export function callerSplitsSource(organizationId: string, from?: string, to?: string): SQL {
  const a = aiCostAttributed;
  const cols = splitColumns(a);
  const range = sql.join(
    [
      sql`${a.organization_id} = ${organizationId}`,
      ...(from ? [sql`${a.day} >= ${sql`toDate(${from})`}`] : []),
      ...(to ? [sql`${a.day} <= ${sql`toDate(${to})`}`] : []),
    ],
    sql` AND `,
  );
  return sql`(SELECT ${cols} FROM ${a} WHERE ${range} AND (${a.day}, ${a.run_at}) IN (SELECT ${a.day}, max(${a.run_at}) FROM ${a} WHERE ${range} GROUP BY ${a.day})) AS ${sql.identifier("cost_daily")}`;
}

/** Attributed spend for one caller tag over a range, visibility applied. */
export async function querySpendByCallerTag(
  organizationId: string,
  tagKey: string,
  from: string,
  to: string,
  limit = 100,
): Promise<Array<{ value: string; currency: string; amount: number }>> {
  const rows = await query((db) =>
    db
      .select({
        value: sql<string>`${costDaily.tags}[${tagKey}]`.as("value"),
        currency: costDaily.currency,
        amount: sql<number>`sum(${costDaily.amount})`.as("amount"),
      })
      .from(callerSplitsSource(organizationId, from, to))
      .where(costDailyOrgCondition(organizationId))
      .groupBy(sql`value`, costDaily.currency)
      .orderBy(desc(sql`amount`), asc(sql`value`))
      .limit(limit),
  );
  return rows.map((r) => ({
    value: String(r.value),
    currency: r.currency,
    amount: Number(r.amount),
  }));
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
 * virtual tags compile through the read's {@link VirtualTagScope}; everything
 * else is a plain column.
 */
function dimensionExpr(
  dimension: CostDimension,
  tagKey: string | undefined,
  scope: VirtualTagScope,
): SQL {
  if (dimension === "virtual_tag") {
    if (!tagKey) throw new Error("tagKey is required for the virtual_tag dimension");
    return scope.value(tagKey);
  }
  return physicalDimensionExpr(dimension as PhysicalCostDimension, tagKey);
}

/**
 * The amortized money expression, shared with `commitment-readers.ts` so the
 * two cannot drift into disagreeing about what "amortized" means.
 *
 * It falls back to `amount` when the row carries no amortized opinion. That
 * fallback is not a nicety: an org running one provider that amortizes and one
 * that doesn't would otherwise see the second provider's spend vanish entirely
 * the moment the amortized view was selected (not shown as an approximation,
 * not flagged, just gone) and the total would read as a dramatic saving.
 *
 * **"No opinion" is `amortized_reported = 0`, not `amortized_amount = 0`.**
 * Zero is a real amortized amount: a commitment purchase's cash lands on one
 * day and its *value* belongs to the days it buys, so its honest amortized
 * amount on the purchase day is nothing. Falling back for it would render the
 * purchase at full cash price alongside every amortized slice of it:
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

/**
 * The blended money expression: commitment discounts spread evenly across
 * the usage they were eligible to cover (plugin-base `cost-blending.ts`).
 *
 * Falls back to {@link amortizedAmountExpr} for a row with no blended opinion,
 * for the same reason amortized falls back to cash: plugins only stamp the
 * rows they blended, and a pool's blended amounts sum to its amortized ones,
 * so every unblended row reading as amortized is what makes the blended
 * total equal the amortized total for any day, any filter that keeps whole
 * pools, and every provider mix.
 */
export function blendedAmountExpr(): SQL {
  return sql`if(${costDaily.blended_reported} != 0, ${costDaily.blended_amount}, ${amortizedAmountExpr()})`;
}

/**
 * The money expression a query sums, per {@link CostBasis}. Exported so every
 * reader that offers a basis (exports included) resolves it identically.
 */
export function costBasisAmountExpr(basis: CostBasis | undefined): SQL {
  if (basis === "blended") return blendedAmountExpr();
  return basis === "amortized" ? amortizedAmountExpr() : sql`${costDaily.amount}`;
}

const amountExpr = costBasisAmountExpr;

/**
 * `charge_type IN (...)` when the caller narrowed the charge types, otherwise
 * nothing. Absent means every type, credits and refunds included: that is what
 * makes an unfiltered total the net number the provider would invoice.
 */
function chargeTypeCondition(chargeTypes: CostChargeType[] | undefined): SQL | undefined {
  if (!chargeTypes || chargeTypes.length === 0) return undefined;
  return inArray(costDaily.charge_type, chargeTypes);
}

/* ------------------------------------------------------------------ *
 * The one place a cost_daily read is scoped to an organization.
 * ------------------------------------------------------------------ */

/**
 * The SQL one cost visibility layer compiles to:
 * `(account IN … OR allocated centre IN …) AND <saved filter>`.
 *
 * The centre arm is the showback `multiIf` (first matching allocation rule
 * wins, unmatched rows are `''`) tested for membership, so "a row belongs to
 * the Platform centre" means exactly what the showback report says it means.
 * A layer with neither accounts nor centres is decided by its saved filter
 * alone, and one with nothing at all matches nothing: an empty scope fails
 * closed.
 */
function visibilityLayerCondition(layer: CompiledCostVisibilityLayer): SQL {
  if (layer.unresolvable) return sql`0`;
  // A layer that reads a virtual tag (through its saved filter or a cost
  // centre's allocation rules) matches nothing. This predicate is plain WHERE
  // SQL built synchronously from the compiled scope: it has no virtual tag
  // definitions to evaluate and no way to join a split tag's shares, and the
  // rule for anything a layer cannot resolve is to narrow, never to widen.
  if (
    (layer.filters ?? []).some((f) => f.dimension === "virtual_tag") ||
    layer.rules.some((r) => (r.match as { virtualTagKey?: string }).virtualTagKey)
  ) {
    return sql`0`;
  }
  const arms: SQL[] = [];
  if (layer.accountIds.length > 0) arms.push(inArray(costDaily.account_id, layer.accountIds));
  if (layer.costCentreIds.length > 0) {
    const branches = layer.rules.map(
      (rule) => sql`${matchConditions(rule.match)}, ${rule.costCentreId}`,
    );
    const centreExpr =
      branches.length > 0 ? sql`multiIf(${sql.join(branches, sql`, `)}, '')` : sql`''`;
    arms.push(inArray(centreExpr, layer.costCentreIds));
  }
  // No virtual tag reaches here (refused above), so an empty scope suffices.
  const noVirtualTags = new VirtualTagScope(undefined);
  const filterConds = (layer.filters ?? []).map((f) =>
    membershipCondition(dimensionExpr(f.dimension, f.tagKey, noVirtualTags), f.op, f.values),
  );
  if (arms.length === 0 && layer.filters === null) return sql`0`;
  const parts: SQL[] = [];
  if (arms.length > 0) parts.push(sql`(${sql.join(arms, sql` OR `)})`);
  parts.push(...filterConds);
  return parts.length > 0 ? sql`(${sql.join(parts, sql` AND `)})` : sql`1`;
}

/**
 * `organization_id = …`, narrowed by the cost visibility scope of whoever the
 * current execution runs for (see `cost/visibility-context.ts`).
 *
 * **Every read of `cost_daily` builds its org predicate here and nowhere
 * else** (this module, `commitment-readers.ts` and the export row stream).
 * That is what makes a scope hold on every cost surface at once, including
 * ones written after it: a reader cannot forget to apply a scope it never had
 * to know about. `__tests__/cost-visibility-sql.test.ts` fails if a raw
 * org-id equality on `cost_daily` appears anywhere else.
 *
 * Unattended callers (the poller's evaluators, exports, the digest) run with
 * no visibility established and get the bare org predicate, byte-identical to
 * what every reader issued before scopes existed.
 */
export function costDailyOrgCondition(organizationId: string): SQL {
  const orgCond = eq(costDaily.organization_id, organizationId);
  const layers = costVisibilityLayersFor(organizationId);
  if (!layers) return orgCond;
  return and(orgCond, ...layers.map(visibilityLayerCondition))!;
}

/* ------------------------------------------------------------------ *
 * Billing rules, compiled into the scan that was going to run anyway.
 * ------------------------------------------------------------------ */

/**
 * The SQL conditions a rule's match compiles to: an AND of the fields it sets,
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
function matchConditions(
  match: BillingRuleMatch & {
    virtualTagKey?: string | undefined;
    virtualTagValue?: string | undefined;
  },
  scope?: VirtualTagScope,
): SQL {
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
  // Allocation rules can match on a virtual tag. Only the showback reader passes
  // a scope; a virtual-tag match reaching a reader without one is a bug, and
  // throwing beats silently dropping the condition (which would widen the rule
  // to every row its other fields match).
  if (match.virtualTagKey) {
    if (!scope) throw new Error("A virtual tag match needs a virtual tag scope");
    const value = scope.value(match.virtualTagKey);
    conds.push(
      match.virtualTagValue !== undefined
        ? sql`${value} = ${match.virtualTagValue}`
        : sql`${value} != ''`,
    );
  }
  return conds.length > 0 ? sql.join(conds, sql` AND `) : sql`1`;
}

/**
 * The adjusted money expression: the raw one multiplied by every matching
 * percentage rule's factor.
 *
 * `amount * if(c1, 1.1, 1) * if(c2, 0.85, 1)`: a **product of conditional
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
 * still appear as branches that evaluate to `fallback`. That is not padding:
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

/**
 * The granularity `cost_daily` stores, which is the granularity of every
 * provider's cost rows: the plugin contract's `CostRow.date` is a UTC day and
 * the table is keyed by `day`. Reported per account by `GET /costs/status` so
 * the editors can explain why hourly bins are unavailable, and checked by
 * {@link bucketExpr} so no reader can quietly draw a day's spend as if it all
 * landed at midnight.
 */
export const COST_STORE_GRANULARITY: CostGranularity = "daily";

/**
 * The bucket expression for a bin size. Running totals (`cumulative`) are a
 * post-pass over these buckets, not a bucket of their own, so they never
 * reach here.
 */
function bucketExpr(bin: CostBinSize): SQL {
  switch (bin) {
    case "weekly":
      return sql`toString(toStartOfWeek(${costDaily.day}, 1))`;
    case "monthly":
      return sql`toString(toStartOfMonth(${costDaily.day}))`;
    case "quarterly":
      return sql`toString(toStartOfQuarter(${costDaily.day}))`;
    case "daily":
      return sql`toString(${costDaily.day})`;
    case "hourly":
      // There is no hour to bucket by: a day-keyed row would land entirely in
      // its midnight bucket and the chart would show 23 empty hours a day.
      throw new Error(HOURLY_BINNING_UNAVAILABLE_REASON);
  }
}

/** Replace each point with the running sum up to and including it. */
function runningSum(points: CostSeriesPoint[]): CostSeriesPoint[] {
  let running = 0;
  return points.map((p) => {
    running += p.amount;
    return { bucket: p.bucket, amount: running };
  });
}

/**
 * One row of {@link queryCosts}'s scan.
 *
 * `raw_amount` is optional because the column is only *projected* when billing
 * rules are in force, not defaulted to zero when they are not. A cost reader
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
 * Currencies are never merged: mixed-currency orgs get one series per
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
 * statement**: percentage factors into the summed expression, account
 * reallocations into the group expression, and adds one extra aggregate,
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
  const { bin, cumulative } = effectiveCostBinning(q);
  const scope = new VirtualTagScope(
    await resolveVirtualTags(
      organizationId,
      referencedVirtualTagKeys(q.filters, q.groupBy, q.groupByTagKey),
      q.from,
      q.to,
      q.virtualTags,
    ),
  );
  if (q.measure === "count") {
    return (await queryCostCounts(organizationId, q, scope)).series;
  }
  // `usage` sums the quantity column instead of money, over rows in one unit
  // only, and ignores currency entirely: forty hours billed in USD and forty in
  // EUR are eighty hours. The service refuses billing rules for it, so the
  // adjustment branches below never see a usage query.
  const usage = q.measure === "usage";
  const adjustments = usage ? undefined : q.adjustments;

  let groupExpr = q.groupBy === "none" ? sql`''` : dimensionExpr(q.groupBy, q.groupByTagKey, scope);
  // Only the account dimension can be re-attributed here: it is the only
  // grouping a reallocation names. Grouping by service or region is untouched
  // by a rule that moves an account's spend, which is correct: the money is
  // still that service's, it is just booked to somebody else.
  if (adjustments && q.groupBy === "account") {
    groupExpr = reallocationExpr(adjustments.reallocations, "account", groupExpr);
  }

  const where = and(
    costDailyOrgCondition(organizationId),
    dayRange(q.from, q.to),
    ...q.filters.map((f) =>
      membershipCondition(dimensionExpr(f.dimension, f.tagKey, scope), f.op, f.values),
    ),
    chargeTypeCondition(q.chargeTypes),
    usage ? eq(costDaily.usage_unit, q.usageUnit ?? "") : undefined,
  );

  // Money is computed after every expression that can mention a virtual tag,
  // because a split tag's weight is only known once the scope has seen it. A
  // read with no split tag gets `weighted(x) === x`: the old SQL, untouched.
  const rawExpr = scope.weighted(usage ? sql`${costDaily.usage_amount}` : amountExpr(q.costBasis));
  const moneyExpr = adjustments ? adjustedAmountExpr(rawExpr, adjustments.factors) : rawExpr;
  const selection = {
    bucket: bucketExpr(bin).as("bucket"),
    grp: groupExpr.as("grp"),
    currency: costDaily.currency,
    amount: sql<number>`sum(${moneyExpr})`.as("amount"),
  };

  // The collected figure rides along as a second aggregate over the same scan.
  // It is what makes "an adjusted total is never shown without the raw one" a
  // property of the query rather than a convention callers have to remember,
  // and it is projected **only** when there are rules, so an unadjusted read
  // cannot hand anything a zero that looks like a collected total.
  //
  // Two chains rather than one over a computed selection: the builder's types
  // track which clauses a query has used, and a selection it cannot see the
  // shape of collapses that bookkeeping into a union with no `.groupBy` on it.
  // A `caller:` tag key in the grouping or a filter reads the attributed view
  // instead (AI rows split by caller); nothing else changes about the query.
  const attributed = referencesCallerTags([
    q.groupBy === "tag" ? q.groupByTagKey : undefined,
    ...q.filters.map((f) => (f.dimension === "tag" ? f.tagKey : undefined)),
  ])
    ? attributedCostSource(organizationId, q.from, q.to)
    : null;
  const rows: QueryCostsRow[] = await query((db) =>
    attributed
      ? adjustments
        ? withVirtualTagJoins(
            db
              .select({ ...selection, raw_amount: sql<number>`sum(${rawExpr})`.as("raw_amount") })
              .from(attributed)
              .$dynamic(),
            scope,
          )
            .where(where)
            .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
            .orderBy(asc(sql`bucket`))
        : withVirtualTagJoins(db.select(selection).from(attributed).$dynamic(), scope)
            .where(where)
            .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
            .orderBy(asc(sql`bucket`))
      : adjustments
        ? withVirtualTagJoins(
            db
              .select({ ...selection, raw_amount: sql<number>`sum(${rawExpr})`.as("raw_amount") })
              .from(costDaily)
              .final()
              .$dynamic(),
            scope,
          )
            .where(where)
            .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
            .orderBy(asc(sql`bucket`))
        : withVirtualTagJoins(db.select(selection).from(costDaily).final().$dynamic(), scope)
            .where(where)
            .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
            .orderBy(asc(sql`bucket`)),
  );

  const groups = new Map<string, CostSeriesGroup>();
  for (const r of rows) {
    // A quantity has no currency: usage rows billed in different currencies
    // are the same hours, so they share one series keyed by `""`. The scan
    // still groups by currency (the SQL is the spend query's, unchanged) and
    // the fold happens here, on rows already ordered by bucket.
    const currency = usage ? "" : r.currency;
    const mapKey = `${r.grp}\x00${currency}`;
    let g = groups.get(mapKey);
    if (!g) {
      g = { key: String(r.grp), currency, points: [] };
      if (adjustments) g.rawPoints = [];
      groups.set(mapKey, g);
    }
    const bucket = String(r.bucket);
    const last = g.points[g.points.length - 1];
    if (usage && last && last.bucket === bucket) {
      last.amount += Number(r.amount);
      continue;
    }
    g.points.push({ bucket, amount: Number(r.amount) });
    // `rawPoints` exists only when rules were applied, which is exactly when
    // the projection carried `raw_amount`. The two conditions are the same
    // `adjustments` check, so this never reads a column that was not selected.
    if (g.rawPoints) g.rawPoints.push({ bucket: String(r.bucket), amount: Number(r.raw_amount) });
  }

  const result = [...groups.values()];
  if (cumulative) {
    for (const g of result) {
      g.points = runningSum(g.points);
      if (g.rawPoints) g.rawPoints = runningSum(g.rawPoints);
    }
  }
  return result;
}

/**
 * Daily usage quantity in one unit over a scope: what a usage budget measures.
 *
 * Sums `usage_amount` across rows whose `usage_unit` is exactly `usageUnit`.
 * Units are matched as the providers wrote them and never converted: "GB" and
 * "GB-Mo" are different quantities, and summing them would produce a number
 * that means nothing. Rows reporting no usage carry an empty unit and so never
 * match. Uses FINAL for the same reason {@link queryCosts} does.
 */
export async function queryUsageDaily(
  organizationId: string,
  q: { from: string; to: string; filters: CostFilter[]; usageUnit: string },
): Promise<CostSeriesPoint[]> {
  // A usage budget may filter by a virtual tag; a split tag's share weights the
  // quantity exactly as it weights money.
  const scope = new VirtualTagScope(
    await resolveVirtualTags(
      organizationId,
      referencedVirtualTagKeys(q.filters, "none", undefined),
      q.from,
      q.to,
    ),
  );
  const filterConds = q.filters.map((f) =>
    membershipCondition(dimensionExpr(f.dimension, f.tagKey, scope), f.op, f.values),
  );
  const quantity = scope.weighted(sql`${costDaily.usage_amount}`);
  const rows = await query((db) =>
    withVirtualTagJoins(
      db
        .select({
          bucket: sql`toString(${costDaily.day})`.as("bucket"),
          amount: sql<number>`sum(${quantity})`.as("amount"),
        })
        .from(costDaily)
        .final()
        .$dynamic(),
      scope,
    )
      .where(
        and(
          costDailyOrgCondition(organizationId),
          dayRange(q.from, q.to),
          eq(costDaily.usage_unit, q.usageUnit),
          ...filterConds,
        ),
      )
      .groupBy(sql`bucket`)
      .orderBy(asc(sql`bucket`)),
  );
  return rows.map((r) => ({ bucket: String(r.bucket), amount: Number(r.amount) }));
}

/**
 * The `count` measure: how many distinct values of the group-by dimension had
 * nonzero spend in each bin, plus the distinct count over the whole range.
 *
 * Two levels of aggregation, both in ClickHouse: the inner query sums spend per
 * (bin, value, currency) and the outer counts the values whose sum is not zero.
 * "Nonzero" is judged per currency, so a value billed 5 USD and refunded 5 EUR
 * on the same day still counts (the two amounts are not comparable), and
 * restated rows net out exactly as they do on the spend chart. Empty values
 * (rows with no resource id, untagged rows) are not a value and are never
 * counted.
 *
 * The range total is a separate distinct count rather than a sum of the bins:
 * a service billed on all thirty days is one service, not thirty.
 */
export async function queryCostCounts(
  organizationId: string,
  q: CostQuery,
  scope?: VirtualTagScope,
): Promise<{ series: CostSeriesGroup[]; total: number }> {
  if (q.groupBy === "none") throw new Error("The count measure needs a groupBy dimension");
  const { bin } = effectiveCostBinning(q);
  // The caller's scope when it has one (`queryCosts` resolves it once), so a
  // count can group or filter by a virtual tag like any other read.
  const vt =
    scope ??
    new VirtualTagScope(
      await resolveVirtualTags(
        organizationId,
        referencedVirtualTagKeys(q.filters, q.groupBy, q.groupByTagKey),
        q.from,
        q.to,
        q.virtualTags,
      ),
    );
  const groupExpr = dimensionExpr(q.groupBy, q.groupByTagKey, vt);
  const filterConds = q.filters.map((f) =>
    membershipCondition(dimensionExpr(f.dimension, f.tagKey, vt), f.op, f.values),
  );
  // Weighted after every expression above: a split tag's shares count only
  // where they carry money.
  const moneyExpr = vt.weighted(amountExpr(q.costBasis));
  const where = and(
    costDailyOrgCondition(organizationId),
    dayRange(q.from, q.to),
    ...filterConds,
    chargeTypeCondition(q.chargeTypes),
    sql`${groupExpr} != ''`,
  );

  const [perBin, overall] = await Promise.all([
    query((db) => {
      const grouped = db
        .select({
          bucket: bucketExpr(bin).as("bucket"),
          grp: groupExpr.as("grp"),
          currency: costDaily.currency,
          amount: sql<number>`sum(${moneyExpr})`.as("amount"),
        })
        .from(costDaily)
        .final()
        .$dynamic();
      const perGroup = withVirtualTagJoins(grouped, vt)
        .where(where)
        .groupBy(sql`bucket`, sql`grp`, costDaily.currency)
        .as("per_group");
      return db
        .select({
          bucket: perGroup.bucket,
          n: sql<string>`uniqExact(${perGroup.grp})`.as("n"),
        })
        .from(perGroup)
        .where(sql`${perGroup.amount} != 0`)
        .groupBy(perGroup.bucket)
        .orderBy(asc(perGroup.bucket));
    }),
    query((db) => {
      const grouped = db
        .select({
          grp: groupExpr.as("grp"),
          currency: costDaily.currency,
          amount: sql<number>`sum(${moneyExpr})`.as("amount"),
        })
        .from(costDaily)
        .final()
        .$dynamic();
      const perGroup = withVirtualTagJoins(grouped, vt)
        .where(where)
        .groupBy(sql`grp`, costDaily.currency)
        .as("per_group_total");
      return db
        .select({ n: sql<string>`uniqExact(${perGroup.grp})`.as("n") })
        .from(perGroup)
        .where(sql`${perGroup.amount} != 0`);
    }),
  ]);

  const points = perBin.map((r) => ({ bucket: String(r.bucket), amount: Number(r.n) }));
  return {
    series: points.length > 0 ? [{ key: "", currency: "", points }] : [],
    total: Number(overall[0]?.n ?? 0),
  };
}

/**
 * The usage units present in an org's cost rows, most-used first by row count:
 * the choices for a usage card's unit picker, so nobody has to know how a
 * provider spells "hours".
 */
export async function getCostUsageUnits(organizationId: string): Promise<string[]> {
  const rows = await query((db) =>
    db
      .select({
        unit: costDaily.usage_unit,
        rows: sql<string>`count()`.as("rows"),
      })
      .from(costDaily)
      .where(and(costDailyOrgCondition(organizationId), sql`${costDaily.usage_unit} != ''`))
      .groupBy(costDaily.usage_unit)
      .orderBy(desc(sql`rows`))
      .limit(500),
  );
  return rows.map((r) => r.unit);
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
 * amortized question wherever a commitment covers it, but it defaults to cash,
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
          costDailyOrgCondition(organizationId),
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
  opts?: { tagKey?: string; from?: string; to?: string; virtualTags?: VirtualTagDefinitions },
): Promise<string[]> {
  if (dimension === "tag" && referencesCallerTags([opts?.tagKey])) {
    const key = opts!.tagKey!;
    const callerRows = await query((db) =>
      db
        .selectDistinct({ value: sql<string>`${costDaily.tags}[${key}]`.as("value") })
        .from(callerSplitsSource(organizationId, opts?.from, opts?.to))
        .where(and(costDailyOrgCondition(organizationId), sql`${costDaily.tags}[${key}] != ''`))
        .orderBy(asc(sql`value`))
        .limit(500),
    );
    return callerRows.map((r) => String(r.value));
  }
  const keys = dimension === "virtual_tag" && opts?.tagKey ? [opts.tagKey] : [];
  // Metric weights are irrelevant to which values exist, so the range only
  // bounds the weights the loader resolves; one day keeps that tiny.
  const today = new Date().toISOString().slice(0, 10);
  const scope = new VirtualTagScope(
    await resolveVirtualTags(
      organizationId,
      keys,
      opts?.from ?? today,
      opts?.to ?? today,
      opts?.virtualTags,
    ),
  );
  const expr = dimensionExpr(dimension, opts?.tagKey, scope);
  const rows = await query((db) =>
    withVirtualTagJoins(
      db
        .selectDistinct({ value: expr.as("value") })
        .from(costDaily)
        .$dynamic(),
      scope,
    )
      .where(
        and(
          costDailyOrgCondition(organizationId),
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

/**
 * Distinct tag keys present in an org's cost data.
 *
 * The cap is generous on purpose: callers drop the org's hidden keys
 * (`applyTagKeySettings`) and trim to their own limit afterwards, and a bill
 * full of `aws:cloudformation:*` noise would otherwise spend the whole cap on
 * keys nobody will see.
 */
export async function getCostTagKeys(
  organizationId: string,
  limit = TAG_KEY_SCAN_LIMIT,
): Promise<string[]> {
  const rows = await query((db) =>
    db
      .selectDistinct({ key: sql<string>`arrayJoin(mapKeys(${costDaily.tags}))`.as("key") })
      .from(costDaily)
      .where(costDailyOrgCondition(organizationId))
      .orderBy(asc(sql`key`))
      .limit(limit),
  );
  // Caller dimensions live only on the attributed view; offering them here is
  // what puts `caller:team` in every group-by and filter picker.
  const callerRows = await query((db) =>
    db
      .selectDistinct({
        key: sql<string>`arrayJoin(mapKeys(${costDaily.tags}))`.as("key"),
      })
      .from(callerSplitsSource(organizationId))
      .where(costDailyOrgCondition(organizationId))
      .orderBy(asc(sql`key`))
      .limit(50),
  );
  // `infrawrench:upload` (custom cost uploads) is a per-file bookkeeping id:
  // nothing anyone would group or filter by, and one value per upload.
  const keys = new Set(rows.map((r) => r.key).filter((key) => key !== "infrawrench:upload"));
  for (const r of callerRows) if (r.key.startsWith(CALLER_TAG_PREFIX)) keys.add(r.key);
  return [...keys].sort();
}

/** Upper bound on distinct tag keys read per org for pickers and the usage table. */
export const TAG_KEY_SCAN_LIMIT = 2000;

/** Per-key usage over a window of cost data: the tag key settings table. */
export interface CostTagKeyUsageRow {
  key: string;
  pluginIds: string[];
  rowCount: number;
  resourceCount: number;
  lastSeen: string;
}

/**
 * How each tag key is used in the org's cost data since `from`: which
 * providers bill with it, on how many rows and distinct resources, and the
 * last day it appeared. Busiest keys first.
 *
 * Read without FINAL: these are orientation figures for deciding what to hide,
 * and a replaced-but-unmerged row inflating a count by one changes no decision,
 * while FINAL over a 90-day window is the expensive way to read it.
 */
export async function getCostTagKeyUsage(
  organizationId: string,
  from: string,
  limit = TAG_KEY_SCAN_LIMIT,
): Promise<CostTagKeyUsageRow[]> {
  const key = sql<string>`arrayJoin(mapKeys(${costDaily.tags}))`;
  const rows = await query((db) =>
    db
      .select({
        key: key.as("key"),
        plugin_ids: sql<string[]>`groupUniqArray(16)(toString(${costDaily.plugin_id}))`.as(
          "plugin_ids",
        ),
        row_count: sql<string>`count()`.as("row_count"),
        resource_count:
          sql<string>`uniqExactIf(${costDaily.resource_id}, ${costDaily.resource_id} != '')`.as(
            "resource_count",
          ),
        last_seen: sql<string>`toString(max(${costDaily.day}))`.as("last_seen"),
      })
      .from(costDaily)
      .where(and(costDailyOrgCondition(organizationId), gte(costDaily.day, from)))
      .groupBy(sql`key`)
      .orderBy(desc(sql`row_count`), asc(sql`key`))
      .limit(limit),
  );
  return rows.map((r) => ({
    key: r.key,
    pluginIds: [...r.plugin_ids].sort(),
    rowCount: Number(r.row_count),
    resourceCount: Number(r.resource_count),
    lastSeen: r.last_seen,
  }));
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
 * "Carries the key" is `mapContains`: a present-but-empty value counts as
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
  const scope = and(costDailyOrgCondition(organizationId), dayRange(from, to));

  // One `sumIf` per required key, selected alongside the totals so the whole
  // report is a single scan. The keys are the org's own configuration, but the
  // aliases they land under are generated here rather than derived from them:
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
    /** Match on one of the org's virtual tags (by key), optionally a value. */
    virtualTagKey?: string | undefined;
    virtualTagValue?: string | undefined;
  };
}

/**
 * Spend per cost centre via first-match-wins allocation rules, compiled into
 * one `multiIf` so ClickHouse walks `cost_daily` once. `rules` must already be
 * in evaluation order (ascending priority). Rows no rule claims come back
 * under the empty-string centre id: the caller labels that "Unallocated".
 *
 * Follows the caller's `costBasis`. Showback is the report where the basis
 * matters most: charging a team the full cash value of a three-year commitment
 * in the month it was signed is not a chargeback anyone can budget against.
 *
 * Cost centres nest, and deliberately none of that reaches here: this stays a
 * flat, pre-ordered rule list resolving each row to exactly one centre id in a
 * single scan. Parent/child precedence is already baked into the order the
 * caller passes (see `orderAllocationRules`), and the tree (own spend versus
 * subtree spend) is assembled from these sums afterwards in
 * `services/showback.ts`. A query per segment would be one scan of `cost_daily`
 * per node of the tree for an answer one scan already contains.
 *
 * ## Billing rules
 *
 * `adjustments` layers the org's billing rules on top **inside the same
 * statement**: percentage factors multiply the summed amount, and cost-centre
 * reallocations wrap the allocation `multiIf` in a second one that overrides
 * it. Reallocation is why the two `multiIf`s nest rather than merge: the
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
  virtualTags?: VirtualTagDefinitions,
): Promise<Array<{ costCentreId: string; currency: string; amount: number; rawAmount?: number }>> {
  // A rule matching on a split virtual tag claims each share separately: the
  // scope joins the tag, so a row 60% payments / 40% search lands 60% on the
  // payments centre and 40% on the search one, and the total is unchanged.
  const keys = [
    ...new Set(rules.flatMap((r) => (r.match.virtualTagKey ? [r.match.virtualTagKey] : []))),
  ];
  const scope = new VirtualTagScope(
    await resolveVirtualTags(organizationId, keys, from, to, virtualTags),
  );
  const branches = rules.map(
    (rule) => sql`${matchConditions(rule.match, scope)}, ${rule.costCentreId}`,
  );
  const allocationExpr =
    branches.length > 0 ? sql`multiIf(${sql.join(branches, sql`, `)}, '')` : sql`''`;
  const centreExpr = adjustments
    ? reallocationExpr(adjustments.reallocations, "cost_centre", allocationExpr)
    : allocationExpr;

  const rawExpr = scope.weighted(amountExpr(costBasis));
  const moneyExpr = adjustments ? adjustedAmountExpr(rawExpr, adjustments.factors) : rawExpr;

  const where = and(costDailyOrgCondition(organizationId), dayRange(from, to));
  const selection = {
    centre: centreExpr.as("centre"),
    currency: costDaily.currency,
    amount: sql<number>`sum(${moneyExpr})`.as("amount"),
  };
  // Projected only when rules are in force: see `QueryCostsRow` for why an
  // unadjusted read must return no collected figure rather than a zero one.
  const rows: Array<{
    centre: unknown;
    currency: string;
    amount: number;
    raw_amount?: number;
  }> = await query((db) => {
    // An allocation rule on a `caller:` tag reads the attributed view, which
    // is what lets a cost centre own "everything team=search spent on AI".
    const attributed = referencesCallerTags(rules.map((r) => r.match.tagKey))
      ? attributedCostSource(organizationId, from, to)
      : null;
    if (attributed) {
      return adjustments
        ? withVirtualTagJoins(
            db
              .select({ ...selection, raw_amount: sql<number>`sum(${rawExpr})`.as("raw_amount") })
              .from(attributed)
              .$dynamic(),
            scope,
          )
            .where(where)
            .groupBy(sql`centre`, costDaily.currency)
            .orderBy(desc(sql`amount`))
        : withVirtualTagJoins(db.select(selection).from(attributed).$dynamic(), scope)
            .where(where)
            .groupBy(sql`centre`, costDaily.currency)
            .orderBy(desc(sql`amount`));
    }
    return adjustments
      ? withVirtualTagJoins(
          db
            .select({ ...selection, raw_amount: sql<number>`sum(${rawExpr})`.as("raw_amount") })
            .from(costDaily)
            .final()
            .$dynamic(),
          scope,
        )
          .where(where)
          .groupBy(sql`centre`, costDaily.currency)
          .orderBy(desc(sql`amount`))
      : withVirtualTagJoins(db.select(selection).from(costDaily).final().$dynamic(), scope)
          .where(where)
          .groupBy(sql`centre`, costDaily.currency)
          .orderBy(desc(sql`amount`));
  });

  return rows.map((r) => ({
    costCentreId: String(r.centre),
    currency: r.currency,
    amount: Number(r.amount),
    ...(adjustments ? { rawAmount: Number(r.raw_amount) } : {}),
  }));
}

/** Earliest and latest cost day per account: drives backfill/status UI. */
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
      .where(costDailyOrgCondition(organizationId))
      .groupBy(costDaily.account_id),
  );
  const result = new Map<string, { firstDay: string; lastDay: string }>();
  for (const r of rows) result.set(r.account_id, { firstDay: r.first_day, lastDay: r.last_day });
  return result;
}

/** One grouped row of {@link getPricingLines}. */
export interface PricingLineRow {
  /** The cost centre (or synthetic bucket) the row resolved to; '' when none. */
  bucket: string;
  currency: string;
  /** `YYYY-MM`. */
  month: string;
  accountId: string;
  pluginId: string;
  service: string;
  region: string;
  chargeType: string;
  unit: string;
  usage: number;
  /** Tag key → value, only for the requested keys the row carries. */
  tags: Record<string, string>;
  /** Collected on the requested basis, after reallocation, before any rule. */
  collected: number;
  /** The part of `collected` whose rows reported a list price. */
  listedCollected: number;
  /** That part's list price. */
  listAmount: number;
}

/**
 * The grouped cost lines a managed-account invoice is priced from.
 *
 * The same allocation `multiIf` and cost-centre reallocation `getShowbackSpend`
 * compiles, so every row resolves to exactly the centre the showback report
 * puts it in; but grouped finer, by calendar month, account, provider,
 * service, region, charge type and unit, plus one column per tag key a rule
 * reads. That is the grain the pricing engine (`client-core/msp-pricing.ts`)
 * evaluates rules at, and it is fixed by the rules' own vocabulary rather than
 * by anything a user typed: tag keys arrive as escaped literals, never as SQL.
 *
 * Nothing is multiplied here. Percentage, tiered and expression rules all run
 * in the engine, which is what lets an invoice say which rule changed which
 * amount; the scan only sums collected money and its list price.
 *
 * `buckets`, when given, keeps only rows resolving to those centre ids, so an
 * invoice does not ship every other customer's lines back to the server.
 *
 * Each tag column is `'=' || value` when the row carries the key and `''` when
 * it does not, so "has the tag with an empty value" and "does not have the
 * tag" stay distinguishable, which is what `tagKey` without `tagValue` needs.
 */
export async function getPricingLines(
  organizationId: string,
  rules: ShowbackRule[],
  from: string,
  to: string,
  options: {
    costBasis?: CostBasis | undefined;
    reallocations?: CompiledBillingAdjustments["reallocations"] | undefined;
    tagKeys?: readonly string[] | undefined;
    buckets?: readonly string[] | undefined;
  } = {},
): Promise<PricingLineRow[]> {
  // As in `getShowbackSpend`: a rule matching on a split virtual tag claims
  // each share separately, weighted, so an invoice prices exactly the slice
  // showback puts in the customer's centre.
  const keys = [
    ...new Set(rules.flatMap((r) => (r.match.virtualTagKey ? [r.match.virtualTagKey] : []))),
  ];
  const scope = new VirtualTagScope(await resolveVirtualTags(organizationId, keys, from, to));
  const branches = rules.map(
    (rule) => sql`${matchConditions(rule.match, scope)}, ${rule.costCentreId}`,
  );
  const allocationExpr =
    branches.length > 0 ? sql`multiIf(${sql.join(branches, sql`, `)}, '')` : sql`''`;
  const centreExpr =
    options.reallocations && options.reallocations.length > 0
      ? reallocationExpr(options.reallocations, "cost_centre", allocationExpr)
      : allocationExpr;
  const rawExpr = scope.weighted(amountExpr(options.costBasis));
  const tagKeys = [...(options.tagKeys ?? [])];

  const selection: Record<string, SQL.Aliased> = {
    centre: centreExpr.as("centre"),
    currency: sql`${costDaily.currency}`.as("currency"),
    month: sql`formatDateTime(${costDaily.day}, '%Y-%m')`.as("month"),
    account_id: sql`${costDaily.account_id}`.as("account_id"),
    plugin_id: sql`${costDaily.plugin_id}`.as("plugin_id"),
    service: sql`${costDaily.service}`.as("service"),
    region: sql`${costDaily.region}`.as("region"),
    charge_type: sql`${costDaily.charge_type}`.as("charge_type"),
    usage_unit: sql`${costDaily.usage_unit}`.as("usage_unit"),
  };
  tagKeys.forEach((key, i) => {
    selection[`t${i}`] =
      sql`if(mapContains(${costDaily.tags}, ${key}), concat('=', ${costDaily.tags}[${key}]), '')`.as(
        `t${i}`,
      );
  });
  const groupKeys = Object.keys(selection);
  const aggregates = {
    collected: sql<number>`sum(${rawExpr})`.as("collected"),
    listed_collected: sql<number>`sum(if(${costDaily.list_reported} != 0, ${rawExpr}, 0))`.as(
      "listed_collected",
    ),
    list_amount_sum: sql<number>`sum(if(${costDaily.list_reported} != 0, ${scope.weighted(
      sql`${costDaily.list_amount}`,
    )}, 0))`.as("list_amount_sum"),
    usage_sum: sql<number>`sum(${scope.weighted(sql`${costDaily.usage_amount}`)})`.as("usage_sum"),
  };

  const where = and(costDailyOrgCondition(organizationId), dayRange(from, to));
  const buckets = options.buckets;
  const having =
    buckets && buckets.length > 0
      ? sql`centre IN (${sql.join(
          buckets.map((b) => sql`${b}`),
          sql`, `,
        )})`
      : undefined;

  const rows = (await query((db) => {
    const q = withVirtualTagJoins(
      db
        .select({ ...selection, ...aggregates })
        .from(costDaily)
        .final()
        .$dynamic(),
      scope,
    )
      .where(where)
      .groupBy(...groupKeys.map((k) => sql.raw(k)));
    return having ? q.having(having) : q;
  })) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const tags: Record<string, string> = {};
    tagKeys.forEach((key, i) => {
      const v = String(r[`t${i}`] ?? "");
      if (v.startsWith("=")) tags[key] = v.slice(1);
    });
    return {
      bucket: String(r["centre"] ?? ""),
      currency: String(r["currency"]),
      month: String(r["month"]),
      accountId: String(r["account_id"]),
      pluginId: String(r["plugin_id"]),
      service: String(r["service"]),
      region: String(r["region"]),
      chargeType: String(r["charge_type"]),
      unit: String(r["usage_unit"]),
      usage: Number(r["usage_sum"] ?? 0),
      tags,
      collected: Number(r["collected"] ?? 0),
      listedCollected: Number(r["listed_collected"] ?? 0),
      listAmount: Number(r["list_amount_sum"] ?? 0),
    };
  });
}

/** What one virtual tag does to the org's spend over a range, per currency. */
export interface VirtualTagStatsRows {
  /** Spend per claiming rule (1-based; 0 is "no rule matched"), per currency. */
  byRule: Array<{ rule: number; currency: string; amount: number }>;
  /** Largest values by spend, per currency, descending. */
  topValues: Array<{ value: string; currency: string; amount: number }>;
  /** Distinct non-empty values produced. */
  distinctValues: number;
}

/**
 * The processing pass's evaluation of one virtual tag: how much spend each
 * rule claims and which values come out, from the same compiled expressions
 * every query uses (so the numbers in Settings are statements about what the
 * graphs do). Three small aggregates rather than one wide one: a tag copying a
 * high-cardinality provider tag would otherwise return a row per value per
 * rule just to sum the per-rule totals.
 */
export async function getVirtualTagStats(
  organizationId: string,
  tag: CompiledVirtualTag,
  from: string,
  to: string,
): Promise<VirtualTagStatsRows> {
  const definitions = new Map([[tag.key, tag]]);
  // Through the visibility predicate like every reader: the processing pass
  // runs outside any request (unrestricted, the whole org), while a preview
  // inside a request sees only the caller's slice.
  const where = and(costDailyOrgCondition(organizationId), dayRange(from, to));

  const ruleScope = new VirtualTagScope(definitions);
  // Joined even though the rule index needs no value: a split rule's shares
  // must still be weighted, or a 50/50 rule would count its row twice.
  if (tag.split) ruleScope.value(tag.key);
  const ruleMoney = ruleScope.weighted(sql`${costDaily.amount}`);
  const byRule = await query((db) =>
    withVirtualTagJoins(
      db
        .select({
          rule: virtualTagRuleIndexExpr(tag).as("rule"),
          currency: costDaily.currency,
          amount: sql<number>`sum(${ruleMoney})`.as("amount"),
        })
        .from(costDaily)
        .final()
        .$dynamic(),
      ruleScope,
    )
      .where(where)
      .groupBy(sql`rule`, costDaily.currency),
  );

  const valueScope = new VirtualTagScope(definitions);
  const valueExpr = valueScope.value(tag.key);
  const valueMoney = valueScope.weighted(sql`${costDaily.amount}`);
  const topValues = await query((db) =>
    withVirtualTagJoins(
      db
        .select({
          value: valueExpr.as("value"),
          currency: costDaily.currency,
          amount: sql<number>`sum(${valueMoney})`.as("amount"),
        })
        .from(costDaily)
        .final()
        .$dynamic(),
      valueScope,
    )
      .where(and(where, sql`${valueExpr} != ''`))
      .groupBy(sql`value`, costDaily.currency)
      .orderBy(desc(sql`amount`))
      .limit(200),
  );

  const distinctScope = new VirtualTagScope(definitions);
  const distinctExpr = distinctScope.value(tag.key);
  const [distinct] = await query((db) =>
    withVirtualTagJoins(
      db
        .select({ n: sql<number>`uniqExact(${distinctExpr})`.as("n") })
        .from(costDaily)
        .$dynamic(),
      distinctScope,
    ).where(and(where, sql`${distinctExpr} != ''`)),
  );

  return {
    byRule: byRule.map((r) => ({
      rule: Number(r.rule),
      currency: String(r.currency),
      amount: Number(r.amount),
    })),
    topValues: topValues.map((r) => ({
      value: String(r.value),
      currency: String(r.currency),
      amount: Number(r.amount),
    })),
    distinctValues: Number(distinct?.n ?? 0),
  };
}

/** The org's earliest and latest cost day, or null with no cost data at all. */
export async function getOrgCostDayRange(
  organizationId: string,
): Promise<{ firstDay: string; lastDay: string } | null> {
  const [row] = await query((db) =>
    db
      .select({
        first_day: sql<string>`toString(min(${costDaily.day}))`.as("first_day"),
        last_day: sql<string>`toString(max(${costDaily.day}))`.as("last_day"),
        n: sql<number>`count()`.as("n"),
      })
      .from(costDaily)
      .where(costDailyOrgCondition(organizationId)),
  );
  if (!row || Number(row.n) === 0) return null;
  return { firstDay: row.first_day, lastDay: row.last_day };
}
