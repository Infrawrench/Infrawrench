/**
 * Virtual tags, compiled into the `cost_daily` scan that was going to run
 * anyway.
 *
 * A virtual tag is an ordered rule list (`client-core/src/virtual-tags.ts`).
 * Here it becomes one SQL expression per tag:
 *
 * - **A tag with no split rules** is a scalar `multiIf(rule1, value1, rule2,
 *   value2, …, default)`, a `String` like any column. Filtering and grouping on
 *   it is exactly filtering and grouping on a column.
 * - **A tag with split rules** is an `Array(Tuple(String, Float64))`: each row's
 *   values with their weights (`[('a', 0.6), ('b', 0.4)]`; a row a fixed rule
 *   matches is `[('x', 1)]`). The reader `ARRAY JOIN`s it, so the row becomes
 *   one row per share, the tag's value is `tupleElement(alias, 1)`, and the
 *   summed money is multiplied by `tupleElement(alias, 2)`. Each row's weights
 *   sum to one, so the join conserves every total by construction. Two split
 *   tags in one query are two `ARRAY JOIN` clauses (a Cartesian product, not a
 *   zip) and the money is multiplied by both weights, which conserves totals
 *   for the same reason.
 *
 * {@link VirtualTagScope} is the bookkeeping: a reader asks it for a tag's
 * value wherever it needs one (group, filter, allocation match, export
 * column), then asks it for the joins and the weight it accumulated. A query
 * that never mentions a virtual tag gets no joins and no weight, so its SQL is
 * byte-identical to what it was before virtual tags existed.
 *
 * Every value goes through the dialect's literal escaping; the only numbers
 * rendered raw are weights this module derived (finite-guarded), the stance
 * `adjustedAmountExpr` takes for billing-rule factors.
 */
import type { CostFilter, VirtualTagValueTransform } from "@infrawrench/client-core";
import { and, gte, lte, sql, type SQL } from "drizzle-orm";
import { membershipCondition, physicalDimensionExpr, type PhysicalCostDimension } from "./cost-sql";
import { costDaily } from "./schema";

/* ------------------------------------------------------------------ *
 * The compiled shape: what the server-side resolver hands the readers.
 * ------------------------------------------------------------------ */

export interface CompiledVirtualTagSource {
  tagKey: string;
  valuePrefix: string | null;
  filters: CostFilter[];
}

/**
 * One rule, its query text already compiled to filters and, for a metric
 * split, its per-day weights already resolved for the range being read.
 */
export interface CompiledVirtualTagRule {
  filters: CostFilter[];
  startsOn: string | null;
  endsOn: string | null;
  kind: "value" | "tag" | "split" | "metric_split";
  value: string | null;
  sources: CompiledVirtualTagSource[];
  valueTransform: VirtualTagValueTransform;
  /** `split`: the values and their fixed weights (normalised to sum to one). */
  shares: Array<{ value: string; weight: number }>;
  /**
   * `metric_split`: the values and, per day, each value's weight. Days outside
   * `days` (the rule's window clipped to the read range) take `evenWeight`.
   */
  metric: { values: string[]; days: string[]; weights: number[][] } | null;
}

export interface CompiledVirtualTag {
  key: string;
  defaultValue: string | null;
  /** Whether any rule divides rows: decides scalar vs. joined compilation. */
  split: boolean;
  rules: CompiledVirtualTagRule[];
}

/** The org's virtual tags a query needs, by key. */
export type VirtualTagDefinitions = ReadonlyMap<string, CompiledVirtualTag>;

/**
 * A query referenced a virtual tag the caller did not (or could not) resolve.
 *
 * Thrown rather than read as "match nothing" or ignored: a budget scoped to
 * `virtual_tag['team'] = 'payments'` whose tag was deleted must fail loudly,
 * never silently measure all spend.
 */
export class VirtualTagUnresolvedError extends Error {
  override readonly name = "VirtualTagUnresolvedError";
  readonly key: string;

  constructor(key: string) {
    super(
      `The virtual tag "${key}" does not exist in this organization. It may have been deleted; ` +
        "edit the filter or grouping that references it.",
    );
    this.key = key;
  }
}

/* ------------------------------------------------------------------ *
 * Expressions
 * ------------------------------------------------------------------ */

/** A weight as a Float64 literal. Finite-guarded: nothing else reaches SQL raw. */
function weightLiteral(weight: number): SQL {
  const w = Number.isFinite(weight) ? weight : 0;
  return sql.raw(`toFloat64(${String(w)})`);
}

/** An AND of physical filters, or `1` when there are none. */
function filtersCondition(filters: readonly CostFilter[]): SQL[] {
  return filters.map((f) => {
    if (f.dimension === "virtual_tag") {
      // Refused at validation; guarded here so a hand-edited row cannot recurse.
      throw new Error("A virtual tag rule cannot filter on another virtual tag.");
    }
    return membershipCondition(
      physicalDimensionExpr(f.dimension as PhysicalCostDimension, f.tagKey),
      f.op,
      f.values,
    );
  });
}

function sourceCondition(source: CompiledVirtualTagSource): SQL {
  return and(sql`${costDaily.tags}[${source.tagKey}] != ''`, ...filtersCondition(source.filters))!;
}

function foldValue(expr: SQL, transform: VirtualTagValueTransform): SQL {
  if (transform === "lower") return sql`lower(${expr})`;
  if (transform === "upper") return sql`upper(${expr})`;
  return expr;
}

/** The copied value of a `tag` rule: the first present source, prefixed and folded. */
function sourceValue(rule: CompiledVirtualTagRule): SQL {
  const branches = rule.sources.map((s) => {
    const raw = foldValue(sql`${costDaily.tags}[${s.tagKey}]`, rule.valueTransform);
    const value = s.valuePrefix ? sql`concat(${s.valuePrefix}, ${raw})` : raw;
    return sql`${sourceCondition(s)}, ${value}`;
  });
  return sql`multiIf(${sql.join(branches, sql`, `)}, '')`;
}

/** The condition under which a rule claims a row. */
export function virtualTagRuleCondition(rule: CompiledVirtualTagRule): SQL {
  const conds: SQL[] = [...filtersCondition(rule.filters)];
  if (rule.startsOn) conds.push(gte(costDaily.day, rule.startsOn));
  if (rule.endsOn) conds.push(lte(costDaily.day, rule.endsOn));
  if (rule.kind === "tag") {
    conds.push(sql`(${sql.join(rule.sources.map(sourceCondition), sql` OR `)})`);
  }
  return conds.length > 0 ? and(...conds)! : sql`1`;
}

/** A scalar tag's value expression: `multiIf(c1, v1, …, default)`. */
function scalarExpr(tag: CompiledVirtualTag): SQL {
  const fallback = sql`${tag.defaultValue ?? ""}`;
  if (tag.rules.length === 0) return fallback;
  const branches = tag.rules.map((rule) => {
    const value = rule.kind === "tag" ? sourceValue(rule) : sql`${rule.value ?? ""}`;
    return sql`${virtualTagRuleCondition(rule)}, ${value}`;
  });
  return sql`multiIf(${sql.join(branches, sql`, `)}, ${fallback})`;
}

const PAIRS_TYPE = sql.raw("Array(Tuple(String, Float64))");

function pairs(items: Array<{ value: SQL; weight: SQL }>): SQL {
  const tuples = items.map((i) => sql`tuple(${i.value}, ${i.weight})`);
  return sql`CAST([${sql.join(tuples, sql`, `)}] AS ${PAIRS_TYPE})`;
}

/** One metric share's weight for the row's day. */
function metricWeightExpr(
  metric: NonNullable<CompiledVirtualTagRule["metric"]>,
  index: number,
): SQL {
  const even = 1 / metric.values.length;
  if (metric.days.length === 0) return weightLiteral(even);
  const days = sql.join(
    metric.days.map((d) => sql`${d}`),
    sql`, `,
  );
  const weights = sql.join(
    metric.weights.map((row) => weightLiteral(row[index] ?? even)),
    sql`, `,
  );
  return sql`transform(toString(${costDaily.day}), [${days}], [${weights}], ${weightLiteral(even)})`;
}

/** A split tag's `Array(Tuple(value, weight))` expression. */
function pairsExpr(tag: CompiledVirtualTag): SQL {
  const one = weightLiteral(1);
  const fallback = pairs([{ value: sql`${tag.defaultValue ?? ""}`, weight: one }]);
  if (tag.rules.length === 0) return fallback;
  const branches = tag.rules.map((rule) => {
    let output: SQL;
    switch (rule.kind) {
      case "value":
        output = pairs([{ value: sql`${rule.value ?? ""}`, weight: one }]);
        break;
      case "tag":
        output = pairs([{ value: sourceValue(rule), weight: one }]);
        break;
      case "split":
        output = pairs(
          rule.shares.map((s) => ({ value: sql`${s.value}`, weight: weightLiteral(s.weight) })),
        );
        break;
      case "metric_split": {
        const metric = rule.metric!;
        output = pairs(
          metric.values.map((value, i) => ({
            value: sql`${value}`,
            weight: metricWeightExpr(metric, i),
          })),
        );
        break;
      }
    }
    return sql`${virtualTagRuleCondition(rule)}, ${output}`;
  });
  return sql`multiIf(${sql.join(branches, sql`, `)}, ${fallback})`;
}

/**
 * Which rule claimed a row, 1-based, or 0 for none: the processing pass's
 * per-rule breakdown. Same conditions in the same order as the value
 * expressions, so "rule 3 claims 40%" is a statement about what queries do.
 */
export function virtualTagRuleIndexExpr(tag: CompiledVirtualTag): SQL {
  if (tag.rules.length === 0) return sql`toUInt16(0)`;
  const branches = tag.rules.map(
    (rule, i) => sql`${virtualTagRuleCondition(rule)}, ${sql.raw(`toUInt16(${i + 1})`)}`,
  );
  return sql`multiIf(${sql.join(branches, sql`, `)}, toUInt16(0))`;
}

/* ------------------------------------------------------------------ *
 * The scope a reader compiles through.
 * ------------------------------------------------------------------ */

export class VirtualTagScope {
  private readonly joined = new Map<string, string>();

  constructor(private readonly definitions: VirtualTagDefinitions | undefined) {}

  private definition(key: string): CompiledVirtualTag {
    const def = this.definitions?.get(key);
    if (!def) throw new VirtualTagUnresolvedError(key);
    return def;
  }

  /**
   * The tag's value as a `String` expression. For a split tag this registers
   * an `ARRAY JOIN` (once per key, however many times it is asked for), so the
   * caller must read {@link arrayJoins} and {@link weight} *after* building
   * every expression that mentions a virtual tag.
   */
  value(key: string): SQL {
    const def = this.definition(key);
    if (!def.split) return scalarExpr(def);
    let alias = this.joined.get(key);
    if (!alias) {
      alias = `vt_${this.joined.size}`;
      this.joined.set(key, alias);
    }
    return sql`tupleElement(${sql.identifier(alias)}, 1)`;
  }

  /** `ARRAY JOIN` expressions, one per split tag used; empty for none. */
  arrayJoins(): SQL[] {
    return [...this.joined.entries()].map(
      ([key, alias]) => sql`${pairsExpr(this.definition(key))} AS ${sql.identifier(alias)}`,
    );
  }

  /** The product of the joined tags' weights, or null when nothing was joined. */
  weight(): SQL | null {
    if (this.joined.size === 0) return null;
    return sql.join(
      [...this.joined.values()].map((alias) => sql`tupleElement(${sql.identifier(alias)}, 2)`),
      sql` * `,
    );
  }

  /** `money * weight`, or `money` untouched when nothing was joined. */
  weighted(money: SQL): SQL {
    const weight = this.weight();
    return weight ? sql`(${money}) * ${weight}` : money;
  }
}

/**
 * Apply a scope's joins to a select builder. Each join is its own `.arrayJoin`
 * call (its own `ARRAY JOIN` clause), which is what makes two split tags a
 * Cartesian product rather than a zip of arrays of different lengths.
 */
export function withVirtualTagJoins<B extends { arrayJoin(...expressions: SQL[]): unknown }>(
  builder: B,
  scope: VirtualTagScope,
): B {
  let current = builder;
  for (const join of scope.arrayJoins()) current = current.arrayJoin(join) as B;
  return current;
}
