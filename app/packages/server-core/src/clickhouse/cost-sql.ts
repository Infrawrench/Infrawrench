/**
 * The column-level SQL vocabulary every `cost_daily` reader shares: which
 * column a physical dimension reads, the day-range predicate, and the
 * predicate each filter operator compiles to.
 *
 * Its own leaf (it imports only the schema) so that `cost-readers.ts`,
 * `virtual-tag-sql.ts` and the export row builder can all use one definition
 * without importing each other: virtual tag rules are themselves filters over
 * these columns, and the readers in turn compile virtual tags.
 */
import {
  foldCostFilterCase,
  normalizeCostFilterValue,
  type CostDimensionId,
  type CostFilterOp,
} from "@infrawrench/client-core";
import { and, gte, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { costDaily } from "./schema";

/** The dimensions that are a column (or a map lookup) on `cost_daily` itself. */
export type PhysicalCostDimension = Exclude<CostDimensionId, "virtual_tag">;

/**
 * Column expression for a physical dimension. Tag dimensions read from the
 * Map column; everything else is a plain column. `virtual_tag` is not here on
 * purpose: it is not a column, and compiling one needs the org's definitions
 * (see `VirtualTagScope` in `virtual-tag-sql.ts`).
 */
export function physicalDimensionExpr(
  dimension: PhysicalCostDimension,
  tagKey: string | undefined,
): SQL {
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
 * The `[from, to]` day-range predicate every `cost_daily` reader filters on.
 *
 * Shared so no reader can get the comparison wrong. `day` is a `Date` column and
 * the bounds are `"YYYY-MM-DD"` strings, which the column's own mapping renders
 * as `toDate('…')`: comparing a `String` against a `Date` is a hard error in
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
 * The ASCII case fold every text operator applies, in SQL: ClickHouse's
 * `lower()` folds `A-Z` only, which is exactly what `foldCostFilterCase` in
 * client-core does on the JS side.
 */
function folded(expr: SQL): SQL {
  return sql`lower(${expr})`;
}

/**
 * The flexible-match form of a column: ASCII case folded, then `[[:space:]_-]`
 * removed; the SQL twin of client-core's `normalizeCostFilterValue`. The
 * pattern is a constant (never user input), so it is rendered raw; the values
 * it is compared with are normalised in JS and bound as escaped literals.
 */
export function flexibleMatchExpr(expr: SQL): SQL {
  return sql`replaceRegexpAll(${folded(expr)}, ${sql.raw("'[[:space:]_-]'")}, '')`;
}

/** De-duplicated, in first-seen order, so a repeated value is one predicate. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The predicate one filter term compiles to, for every operator.
 *
 * - `in` / `not_in`: `expr IN (values)` / `expr NOT IN (values)`, including
 *   for the empty list. Drizzle refuses an empty `inArray`, but an empty filter
 *   list is reachable from the wire and used to mean "match nothing" (and,
 *   negated, "match everything"). Spelling those out keeps a saved filter that
 *   lost its last value behaving the way it did before, instead of throwing on
 *   read.
 * - `flexible_match`: the normalised column `IN` the normalised values.
 * - `contains` / `not_contains` / `starts_with`: `position` / `startsWith` over
 *   the folded column against folded values, OR-ed across values (and negated
 *   as a whole for `not_contains`). An empty value list matches nothing
 *   (`not_contains`: everything), the convention `in` already follows.
 * - `is_set` / `is_not_set`: `expr != ''` / `expr = ''`. A missing map key
 *   reads as `''` in ClickHouse, so "absent" and "empty" are one state, as
 *   they are everywhere else a tag is read.
 *
 * Values only ever reach SQL as escaped literals through Drizzle's binding;
 * the one raw fragment is the constant normalisation pattern above.
 */
export function membershipCondition(expr: SQL, op: CostFilterOp, values: string[]): SQL {
  switch (op) {
    case "in":
    case "not_in":
      if (values.length === 0) return op === "in" ? sql`0` : sql`1`;
      return op === "in" ? inArray(expr, values) : notInArray(expr, values);
    case "flexible_match": {
      const targets = distinct(values.map(normalizeCostFilterValue));
      if (targets.length === 0) return sql`0`;
      return inArray(flexibleMatchExpr(expr), targets);
    }
    case "contains":
    case "not_contains":
    case "starts_with": {
      const needles = distinct(values.map(foldCostFilterCase));
      if (needles.length === 0) return op === "not_contains" ? sql`1` : sql`0`;
      const column = folded(expr);
      const hits = needles.map((needle) =>
        op === "starts_with"
          ? sql`startsWith(${column}, ${needle})`
          : sql`position(${column}, ${needle}) > 0`,
      );
      const any = hits.length === 1 ? hits[0]! : sql`(${sql.join(hits, sql` OR `)})`;
      return op === "not_contains" ? sql`NOT (${any})` : any;
    }
    case "is_set":
      return sql`${expr} != ''`;
    case "is_not_set":
      return sql`${expr} = ''`;
  }
}
