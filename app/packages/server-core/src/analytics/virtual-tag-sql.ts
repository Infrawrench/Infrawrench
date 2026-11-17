/**
 * Virtual tags, compiled into the `cost_daily` scan that was going to run
 * anyway.
 *
 * A virtual tag is an ordered rule list (`client-core/src/virtual-tags.ts`).
 * Here it becomes one SQL expression per tag:
 *
 * - **A tag with no split rules** is a scalar `CASE WHEN rule1 THEN value1
 *   WHEN rule2 THEN value2 … ELSE default END`, a `text` like any column.
 *   Filtering and grouping on it is exactly filtering and grouping on a column.
 * - **A tag with split rules** is a JSON array of shares: each row's values
 *   with their weights (`[{a, 0.6}, {b, 0.4}]`; a row a fixed rule matches is
 *   `[{x, 1}]`). The reader joins it laterally through `jsonb_to_recordset`,
 *   so the row becomes one row per share, the tag's value is
 *   `alias.vt_value`, and the summed money is multiplied by `alias.vt_weight`.
 *   Each row's weights sum to one, so the join conserves every total by
 *   construction. Two split tags in one query are two lateral joins (a
 *   Cartesian product, not a zip) and the money is multiplied by both weights,
 *   which conserves totals for the same reason.
 *
 * - **A tag built on tags** (a rule filtering on `virtual_tag['team']`) nests
 *   the referenced tag's scalar `CASE` inside its own rule condition, from
 *   {@link CompiledVirtualTag.dependencies}. Only scalar tags can be
 *   referenced, so nesting never adds a join, and the depth is bounded by
 *   `VIRTUAL_TAG_LIMITS.maxReferenceDepth`.
 *
 * {@link VirtualTagScope} is the bookkeeping: a reader asks it for a tag's
 * value wherever it needs one (group, filter, allocation match, export
 * column), then asks it for the joins and the weight it accumulated. A query
 * that never mentions a virtual tag gets no joins and no weight, so its SQL is
 * byte-identical to what it was before virtual tags existed.
 *
 * Every value is a bound parameter; the only numbers rendered raw are weights
 * this module derived (finite-guarded), the stance `adjustedAmountExpr` takes
 * for billing-rule factors.
 */
import {
  VIRTUAL_TAG_LIMITS,
  type CostFilter,
  type VirtualTagValueTransform,
} from "@infrawrench/client-core";
import { and, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  asciiLower,
  asciiUpper,
  firstMatch,
  membershipCondition,
  physicalDimensionExpr,
  tagValueExpr,
  textParam,
  type PhysicalCostDimension,
} from "./cost-sql";
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
  /**
   * The compiled tags this tag's rule (and source) filters test, by key, each
   * carrying its own `dependencies` in turn. A `virtual_tag` term inside a
   * rule compiles to the referenced tag's scalar `CASE`, nested in place,
   * so a tag built on tags is still one expression in the one scan. Absent
   * (or missing a key) when nothing was resolved: such a term throws
   * {@link VirtualTagUnresolvedError} rather than matching nothing.
   */
  dependencies?: VirtualTagDefinitions | undefined;
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

/** A weight as a float8 literal. Finite-guarded: nothing else reaches SQL raw. */
function weightLiteral(weight: number): SQL {
  const w = Number.isFinite(weight) ? weight : 0;
  return sql.raw(`${String(w)}::float8`);
}

/**
 * How deep a `virtual_tag` term may nest a referenced tag's expression before
 * compilation gives up: the save-time limit, plus the tag itself. Stored rows
 * the save check never let through (a hand-edited cycle) stop here instead of
 * recursing forever.
 */
const MAX_COMPILE_DEPTH = VIRTUAL_TAG_LIMITS.maxReferenceDepth + 1;

/**
 * The compilation context for one tag's rules: the tags its filters may
 * reference, and how many tags deep this expression already is.
 */
interface RuleScope {
  dependencies: VirtualTagDefinitions | undefined;
  depth: number;
}

function scopeOf(tag: CompiledVirtualTag, depth = 1): RuleScope {
  return { dependencies: tag.dependencies, depth };
}

/**
 * A referenced tag's single value per row, nested in place. Only a scalar tag
 * can be one: a split tag gives a row several values, and a rule's filter is
 * a yes/no question about the row. The save check refuses both a reference to
 * a split tag and a split on a referenced tag; this guards stored rows.
 */
function referencedTagExpr(key: string, scope: RuleScope): SQL {
  const def = scope.dependencies?.get(key);
  if (!def) throw new VirtualTagUnresolvedError(key);
  if (def.split) {
    throw new Error(
      `The virtual tag "${key}" splits rows between values, so another tag's rule cannot ` +
        "filter on it. Edit the rule that references it.",
    );
  }
  if (scope.depth >= MAX_COMPILE_DEPTH) {
    throw new Error(
      `Virtual tags filtering on "${key}" nest deeper than ` +
        `${VIRTUAL_TAG_LIMITS.maxReferenceDepth} tags, or in a loop. Edit the rules that reference it.`,
    );
  }
  return scalarExpr(def, scope.depth + 1);
}

/** One predicate per filter term (physical columns, or nested virtual tags). */
function filtersCondition(filters: readonly CostFilter[], scope: RuleScope): SQL[] {
  return filters.map((f) => {
    const expr =
      f.dimension === "virtual_tag"
        ? referencedTagExpr(f.tagKey ?? "", scope)
        : physicalDimensionExpr(f.dimension as PhysicalCostDimension, f.tagKey);
    return membershipCondition(expr, f.op, f.values);
  });
}

function sourceCondition(source: CompiledVirtualTagSource, scope: RuleScope): SQL {
  return and(
    sql`${tagValueExpr(source.tagKey)} != ''`,
    ...filtersCondition(source.filters, scope),
  )!;
}

/** ASCII-only, like the cost filters' fold (see `asciiLower`). */
function foldValue(expr: SQL, transform: VirtualTagValueTransform): SQL {
  if (transform === "lower") return asciiLower(expr);
  if (transform === "upper") return asciiUpper(expr);
  return expr;
}

/** The copied value of a `tag` rule: the first present source, prefixed and folded. */
function sourceValue(rule: CompiledVirtualTagRule, scope: RuleScope): SQL {
  const branches = rule.sources.map((s) => {
    const raw = foldValue(tagValueExpr(s.tagKey), rule.valueTransform);
    const value = s.valuePrefix ? sql`(${textParam(s.valuePrefix)} || ${raw})` : raw;
    return { when: sourceCondition(s, scope), then: value };
  });
  return firstMatch(branches, sql`''`);
}

/**
 * The condition under which a rule claims a row. `dependencies` resolves the
 * rule's `virtual_tag` terms (the owning tag's {@link CompiledVirtualTag.dependencies}).
 */
export function virtualTagRuleCondition(
  rule: CompiledVirtualTagRule,
  dependencies?: VirtualTagDefinitions | undefined,
): SQL {
  return ruleCondition(rule, { dependencies, depth: 1 });
}

function ruleCondition(rule: CompiledVirtualTagRule, scope: RuleScope): SQL {
  const conds: SQL[] = [...filtersCondition(rule.filters, scope)];
  if (rule.startsOn) conds.push(gte(costDaily.day, rule.startsOn));
  if (rule.endsOn) conds.push(lte(costDaily.day, rule.endsOn));
  if (rule.kind === "tag") {
    conds.push(
      sql`(${sql.join(
        rule.sources.map((s) => sourceCondition(s, scope)),
        sql` OR `,
      )})`,
    );
  }
  return conds.length > 0 ? and(...conds)! : sql`true`;
}

/** A scalar tag's value expression: `CASE WHEN c1 THEN v1 … ELSE default END`. */
function scalarExpr(tag: CompiledVirtualTag, depth = 1): SQL {
  const scope = scopeOf(tag, depth);
  const branches = tag.rules.map((rule) => ({
    when: ruleCondition(rule, scope),
    then: rule.kind === "tag" ? sourceValue(rule, scope) : textParam(rule.value ?? ""),
  }));
  return firstMatch(branches, textParam(tag.defaultValue ?? ""));
}

/**
 * The lateral join's column names. Distinct from every alias a reader projects
 * (`value`, `key`…) on purpose: Postgres resolves a bare `GROUP BY` name
 * against the input columns before the projection's aliases, so a join column
 * called `value` would silently take over a reader's `GROUP BY value`.
 */
const VALUE_COLUMN = "vt_value";
const WEIGHT_COLUMN = "vt_weight";

/** A JSON array of `{vt_value, vt_weight}` shares, the shape the join reads back. */
function pairs(items: Array<{ value: SQL; weight: SQL }>): SQL {
  const objects = items.map(
    (i) =>
      sql`jsonb_build_object(${sql.raw(`'${VALUE_COLUMN}'`)}, ${i.value}, ${sql.raw(`'${WEIGHT_COLUMN}'`)}, ${i.weight})`,
  );
  return sql`jsonb_build_array(${sql.join(objects, sql`, `)})`;
}

/** One metric share's weight for the row's day. */
function metricWeightExpr(
  metric: NonNullable<CompiledVirtualTagRule["metric"]>,
  index: number,
): SQL {
  const even = 1 / metric.values.length;
  if (metric.days.length === 0) return weightLiteral(even);
  const arms = metric.days.map(
    (d, i) => sql`WHEN ${d}::date THEN ${weightLiteral(metric.weights[i]?.[index] ?? even)}`,
  );
  return sql`(CASE ${costDaily.day} ${sql.join(arms, sql` `)} ELSE ${weightLiteral(even)} END)`;
}

/** A split tag's shares expression: a JSON array of `{vt_value, vt_weight}`. */
function pairsExpr(tag: CompiledVirtualTag): SQL {
  const scope = scopeOf(tag);
  const one = weightLiteral(1);
  const fallback = pairs([{ value: textParam(tag.defaultValue ?? ""), weight: one }]);
  const branches = tag.rules.map((rule) => {
    let output: SQL;
    switch (rule.kind) {
      case "value":
        output = pairs([{ value: textParam(rule.value ?? ""), weight: one }]);
        break;
      case "tag":
        output = pairs([{ value: sourceValue(rule, scope), weight: one }]);
        break;
      case "split":
        output = pairs(
          rule.shares.map((s) => ({ value: textParam(s.value), weight: weightLiteral(s.weight) })),
        );
        break;
      case "metric_split": {
        const metric = rule.metric!;
        output = pairs(
          metric.values.map((value, i) => ({
            value: textParam(value),
            weight: metricWeightExpr(metric, i),
          })),
        );
        break;
      }
    }
    return { when: ruleCondition(rule, scope), then: output };
  });
  return firstMatch(branches, fallback);
}

/**
 * Which rule claimed a row, 1-based, or 0 for none: the processing pass's
 * per-rule breakdown. Same conditions in the same order as the value
 * expressions, so "rule 3 claims 40%" is a statement about what queries do.
 */
export function virtualTagRuleIndexExpr(tag: CompiledVirtualTag): SQL {
  const scope = scopeOf(tag);
  const branches = tag.rules.map((rule, i) => ({
    when: ruleCondition(rule, scope),
    then: sql.raw(String(i + 1)),
  }));
  return firstMatch(branches, sql`0`);
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
   * The tag's value as a `text` expression. For a split tag this registers a
   * lateral join (once per key, however many times it is asked for), so the
   * caller must read {@link lateralJoins} and {@link weight} *after* building
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
    return sql`${sql.identifier(alias)}.${sql.identifier(VALUE_COLUMN)}`;
  }

  /**
   * One `jsonb_to_recordset(<shares>) AS vt_n(vt_value, vt_weight)` per split
   * tag used; empty for none. Each is joined `CROSS JOIN LATERAL`, so it reads
   * the row it expands.
   */
  lateralJoins(): SQL[] {
    return [...this.joined.entries()].map(
      ([key, alias]) =>
        sql`jsonb_to_recordset(${pairsExpr(this.definition(key))}) AS ${sql.identifier(alias)}(${sql.identifier(VALUE_COLUMN)} text, ${sql.identifier(WEIGHT_COLUMN)} float8)`,
    );
  }

  /** The product of the joined tags' weights, or null when nothing was joined. */
  weight(): SQL | null {
    if (this.joined.size === 0) return null;
    return sql.join(
      [...this.joined.values()].map(
        (alias) => sql`${sql.identifier(alias)}.${sql.identifier(WEIGHT_COLUMN)}`,
      ),
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
 * Apply a scope's joins to a select builder. Each split tag is its own lateral
 * join, which is what makes two of them a Cartesian product rather than a zip
 * of share lists of different lengths.
 */
export function withVirtualTagJoins<B extends { crossJoinLateral(table: SQL): unknown }>(
  builder: B,
  scope: VirtualTagScope,
): B {
  let current = builder;
  for (const join of scope.lateralJoins()) current = current.crossJoinLateral(join) as B;
  return current;
}
