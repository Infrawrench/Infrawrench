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

/** The dimensions that are a column (or a tag lookup) on `cost_daily` itself. */
export type PhysicalCostDimension = Exclude<CostDimensionId, "virtual_tag">;

/**
 * Column expression for a physical dimension. Tag dimensions read from the
 * `tags` map; everything else is a plain column. `virtual_tag` is not here on
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
      return tagValueExpr(tagKey);
    }
  }
}

/**
 * One tag's value on a row, `''` when the row does not carry the key.
 *
 * `->>` on a missing key is SQL `NULL`, and every reader groups, compares and
 * concatenates tag values on the understanding that an absent tag is the empty
 * string: `NULL` would drop out of `IN`, `!=` and `||` instead of reading as
 * "untagged". The key is cast because `->>` is also defined for an integer
 * (array index) operand, so an untyped parameter would be ambiguous.
 */
export function tagValueExpr(tagKey: string): SQL {
  return sql`coalesce(${costDaily.tags} ->> ${tagKey}::text, '')`;
}

/** Whether a row carries the tag key at all, whatever its value. */
export function hasTagExpr(tagKey: string): SQL {
  return sql`jsonb_exists(${costDaily.tags}, ${tagKey}::text)`;
}

/**
 * First match wins: `CASE WHEN c1 THEN v1 WHEN c2 THEN v2 … ELSE fallback END`
 * over ordered (condition, value) pairs, or just `fallback` with none. The
 * shape of every rule list compiled here: allocation, reallocation, virtual
 * tags.
 */
export function firstMatch(branches: Array<{ when: SQL; then: SQL }>, fallback: SQL): SQL {
  if (branches.length === 0) return fallback;
  const arms = branches.map((b) => sql`WHEN ${b.when} THEN ${b.then}`);
  return sql`(CASE ${sql.join(arms, sql` `)} ELSE ${fallback} END)`;
}

/**
 * A string literal bound as `text`. Postgres cannot infer a parameter's type
 * from a `CASE` branch on its own, from `||`, or from a bare projection, so
 * every literal value that reaches one of those positions says what it is.
 */
export function textParam(value: string): SQL {
  return sql`${value}::text`;
}

/**
 * The `[from, to]` day-range predicate every `cost_daily` reader filters on.
 *
 * Shared so no reader can get the comparison wrong: the bounds are
 * `"YYYY-MM-DD"` strings bound against the `date` column, so the comparison is
 * by calendar day, inclusive at both ends.
 */
export function dayRange(from: string, to: string): SQL {
  return and(gte(costDaily.day, from), lte(costDaily.day, to))!;
}

const ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";

/**
 * The ASCII case fold every text operator applies, in SQL: `A-Z` only, which
 * is exactly what `foldCostFilterCase` in client-core does on the JS side.
 * Postgres' `lower()` would also fold non-ASCII letters by the collation's
 * rules, so a needle the JS side left alone could stop matching the column.
 */
export function asciiLower(expr: SQL): SQL {
  return sql`translate(${expr}, ${sql.raw(`'${ASCII_UPPER}'`)}, ${sql.raw(`'${ASCII_LOWER}'`)})`;
}

/** The `upper` twin of {@link asciiLower}: `a-z` only. */
export function asciiUpper(expr: SQL): SQL {
  return sql`translate(${expr}, ${sql.raw(`'${ASCII_LOWER}'`)}, ${sql.raw(`'${ASCII_UPPER}'`)})`;
}

/**
 * The flexible-match form of a column: ASCII case folded, then ASCII
 * whitespace, `_` and `-` removed; the SQL twin of client-core's
 * `normalizeCostFilterValue`, character class for character class (a
 * `[[:space:]]` class would follow the locale and take non-ASCII spaces too).
 * The pattern is a constant (never user input), so it is rendered raw; the
 * values it is compared with are normalised in JS and bound as parameters.
 */
export function flexibleMatchExpr(expr: SQL): SQL {
  return sql`regexp_replace(${asciiLower(expr)}, ${sql.raw("'[\\t\\n\\v\\f\\r _-]'")}, '', 'g')`;
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
 * - `contains` / `not_contains` / `starts_with`: `strpos` / `starts_with` over
 *   the folded column against folded values, OR-ed across values (and negated
 *   as a whole for `not_contains`). An empty value list matches nothing
 *   (`not_contains`: everything), the convention `in` already follows.
 * - `is_set` / `is_not_set`: `expr != ''` / `expr = ''`. A missing tag reads
 *   as `''` ({@link tagValueExpr}), so "absent" and "empty" are one state, as
 *   they are everywhere else a tag is read.
 *
 * Values only ever reach SQL as bound parameters; the raw fragments are the
 * constant fold and normalisation patterns above.
 */
export function membershipCondition(expr: SQL, op: CostFilterOp, values: string[]): SQL {
  switch (op) {
    case "in":
    case "not_in":
      if (values.length === 0) return op === "in" ? sql`false` : sql`true`;
      return op === "in" ? inArray(expr, values) : notInArray(expr, values);
    case "flexible_match": {
      const targets = distinct(values.map(normalizeCostFilterValue));
      if (targets.length === 0) return sql`false`;
      return inArray(flexibleMatchExpr(expr), targets);
    }
    case "contains":
    case "not_contains":
    case "starts_with": {
      const needles = distinct(values.map(foldCostFilterCase));
      if (needles.length === 0) return op === "not_contains" ? sql`true` : sql`false`;
      const column = asciiLower(expr);
      const hits = needles.map((needle) =>
        op === "starts_with"
          ? sql`starts_with(${column}, ${textParam(needle)})`
          : sql`strpos(${column}, ${textParam(needle)}) > 0`,
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
