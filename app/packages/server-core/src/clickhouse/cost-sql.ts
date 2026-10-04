/**
 * The column-level SQL vocabulary every `cost_daily` reader shares: which
 * column a physical dimension reads, the day-range predicate, and IN/NOT IN
 * over a value list.
 *
 * Its own leaf (it imports only the schema) so that `cost-readers.ts`,
 * `virtual-tag-sql.ts` and the export row builder can all use one definition
 * without importing each other: virtual tag rules are themselves filters over
 * these columns, and the readers in turn compile virtual tags.
 */
import type { CostDimensionId, CostFilter } from "@infrawrench/client-core";
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
