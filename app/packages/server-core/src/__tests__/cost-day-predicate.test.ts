/**
 * Guards `cost_daily`'s day-range predicate: one helper, `dayRange`, builds it,
 * with the column qualified and both bounds bound as parameters.
 *
 * Readers project `day` under its own name, and a cost query can be a subquery
 * or a union over `cost_daily` and the attributed AI view (`attributedCostSource`
 * in `cost-readers.ts`), so an unqualified or hand-built `day` comparison is one
 * refactor away from reading the wrong relation. Building the predicate through
 * Drizzle qualifies it every time; the source scan below keeps a reader from
 * hand-rolling the comparison and losing that.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { dayRange } from "../analytics/cost-readers";
import { buildCostExportQuery } from "../cost-exports/rows";

/** Every module that filters `cost_daily` by day range. */
const SOURCES = [
  "../analytics/cost-readers.ts",
  "../analytics/commitment-readers.ts",
  "../analytics/cost-reconcile.ts",
  "../analytics/custom-cost-store.ts",
  "../cost-exports/rows.ts",
] as const;

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const QUALIFIED_RANGE =
  /"cost_daily"\."day" >= (\$\d+|'2026-08-01') and "cost_daily"\."day" <= (\$\d+|'2026-08-10')/;

describe("cost_daily day-range predicate", () => {
  it("qualifies the column and binds both bounds", () => {
    const { sql, params } = new PgDialect().sqlToQuery(dayRange("2026-08-01", "2026-08-10"));
    expect(sql).toBe('("cost_daily"."day" >= $1 and "cost_daily"."day" <= $2)');
    // Bound, not interpolated: the bounds come from request input.
    expect(params).toEqual(["2026-08-01", "2026-08-10"]);
  });

  it.each(SOURCES)("%s builds no day comparison of its own", (rel) => {
    // Anything comparing `cost_daily`'s day outside `dayRange` is hand-rolled,
    // and a hand-rolled comparison is where the qualification gets lost.
    const offenders = read(rel).match(/costDaily\.day\}\s*[<>]=?/g);
    expect(offenders ?? []).toEqual([]);
  });

  it("builds an export query that filters through the same predicate", () => {
    const { sql } = buildCostExportQuery({
      organizationId: "org_1",
      from: "2026-08-01",
      to: "2026-08-10",
      dimensions: ["service"],
      tagKeys: [],
      filters: [],
    });
    expect(sql).toMatch(QUALIFIED_RANGE);
  });
});
