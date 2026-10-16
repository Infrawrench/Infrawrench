/**
 * What each cost filter operator means, in JS.
 *
 * The cost readers never evaluate a filter here: every operator compiles to a
 * ClickHouse predicate (`server-core/src/clickhouse/cost-sql.ts`). This module
 * is the same semantics for the places that test a value outside SQL (the
 * editors' "matches these known values" preview, validation) and the single
 * statement of the normalisation rules both sides follow:
 *
 * - **Case folding is ASCII only.** ClickHouse's `lower()` folds `A-Z` and
 *   nothing else, so JS does exactly that rather than `toLowerCase()`, which
 *   would also fold `Ä` and make the editor promise a match the query does
 *   not make.
 * - **Flexible matching drops ASCII whitespace, `_` and `-`** after folding:
 *   the characters `[[:space:]_-]` names in RE2, which is what ClickHouse's
 *   `replaceRegexpAll` uses. `Prod_Env`, `prod-env`, `PROD ENV` and `prodenv`
 *   all normalise to `prodenv`.
 *
 * `server-core/src/__tests__/cost-filter-sql.test.ts` pins the SQL spelling
 * of both rules next to the tests of this file, so they cannot drift apart
 * silently.
 */
import {
  isCostFilterOp,
  isKeyedCostDimension,
  isPatternCostFilterOp,
  isValuelessCostFilterOp,
  type CostFilter,
} from "./costs";

/** `A-Z` to `a-z`, leaving every other character alone (ClickHouse `lower`). */
export function foldCostFilterCase(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The characters flexible matching ignores: RE2's `[[:space:]_-]`. */
const FLEXIBLE_IGNORED = /[\t\n\v\f\r _-]/g;

/**
 * The flexible-match form of a value: ASCII case folded, whitespace,
 * underscores and hyphens removed. The SQL side is
 * `replaceRegexpAll(lower(x), '[[:space:]_-]', '')`.
 */
export function normalizeCostFilterValue(value: string): string {
  return foldCostFilterCase(value).replace(FLEXIBLE_IGNORED, "");
}

/**
 * Whether a row whose dimension value is `actual` passes the filter. A
 * missing tag is `''`, exactly as the `cost_daily` map lookup reads it.
 */
export function costFilterMatches(filter: Pick<CostFilter, "op" | "values">, actual: string) {
  switch (filter.op) {
    case "in":
      return filter.values.includes(actual);
    case "not_in":
      return !filter.values.includes(actual);
    case "flexible_match": {
      const target = normalizeCostFilterValue(actual);
      return filter.values.some((v) => normalizeCostFilterValue(v) === target);
    }
    case "contains":
    case "not_contains": {
      const haystack = foldCostFilterCase(actual);
      const hit = filter.values.some((v) => haystack.includes(foldCostFilterCase(v)));
      return filter.op === "contains" ? hit : !hit;
    }
    case "starts_with": {
      const haystack = foldCostFilterCase(actual);
      return filter.values.some((v) => haystack.startsWith(foldCostFilterCase(v)));
    }
    case "is_set":
      return actual !== "";
    case "is_not_set":
      return actual === "";
  }
}

/**
 * A filter term that says something. Editors keep half-finished rows (a
 * dimension with no values picked yet) and drop them before saving; a
 * valueless operator is complete with no values at all.
 */
export function isCompleteCostFilter(filter: Pick<CostFilter, "op" | "values">): boolean {
  return isValuelessCostFilterOp(filter.op) || filter.values.length > 0;
}

/**
 * The first thing wrong with one filter term's operator and values, or null.
 * Shared by the zod schemas, the query language and the editors, so all of
 * them refuse in the same words.
 */
export function costFilterOpError(
  filter: Pick<CostFilter, "dimension" | "op" | "values">,
): string | null {
  if (!isCostFilterOp(filter.op)) return `Unknown filter operator "${String(filter.op)}".`;
  if (isValuelessCostFilterOp(filter.op)) {
    if (!isKeyedCostDimension(filter.dimension)) {
      return "IS SET and IS NOT SET apply to tags and virtual tags only.";
    }
    if (filter.values.length > 0) return "IS SET and IS NOT SET take no values.";
    return null;
  }
  if (filter.values.length === 0) return "A filter needs at least one value.";
  if (isPatternCostFilterOp(filter.op)) {
    if (filter.values.some((v) => v === "")) {
      return "A text match needs a value to look for; an empty one matches everything.";
    }
    if (
      filter.op === "flexible_match" &&
      filter.values.some((v) => normalizeCostFilterValue(v) === "")
    ) {
      return (
        "A flexible match ignores spaces, underscores and hyphens, so a value made only of " +
        "those matches nothing but empty values. Use IS NOT SET instead."
      );
    }
  }
  return null;
}
