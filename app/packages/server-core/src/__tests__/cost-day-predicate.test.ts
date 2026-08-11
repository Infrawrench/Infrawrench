/**
 * Guards the one thing that makes `cost_daily`'s day-range predicate safe:
 * the column is qualified, and the bound is a `Date` rather than a `String`.
 *
 * ClickHouse resolves SELECT aliases inside WHERE. Four readers project
 * `toString(day) AS day` so JS gets a "YYYY-MM-DD" string, and in those an
 * unqualified `day` in the WHERE binds to the alias rather than the column —
 * `String >= Date`, which ClickHouse refuses to unify ("There is no supertype
 * for types String, Date"). In `cost-reconcile.ts` that throw is not a blank
 * panel: it escapes `collectAccountCosts` and fails the account's entire cost
 * collection.
 *
 * Building the predicate through Drizzle is what removes the hazard: the
 * builder qualifies every column in a `WHERE`, and the `day` column's own
 * mapping renders a `"YYYY-MM-DD"` bound as `toDate('…')`. Both halves are
 * asserted here, and the source scan below keeps a reader from hand-rolling the
 * comparison and losing them again.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClickHouseDialect } from "drizzle-orm/clickhouse-core";
import { dayRange } from "../clickhouse/cost-readers";
import { buildCostExportQuery } from "../cost-exports/rows";

/** Every module that filters `cost_daily` by day range. */
const SOURCES = [
  "../clickhouse/cost-readers.ts",
  "../clickhouse/commitment-readers.ts",
  "../clickhouse/cost-reconcile.ts",
  "../cost-exports/rows.ts",
] as const;

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const render = (fragment: Parameters<ClickHouseDialect["sqlToQuery"]>[0]) =>
  new ClickHouseDialect().sqlToQuery(fragment).sql;

describe("cost_daily day-range predicate", () => {
  it("qualifies the column so a SELECT alias cannot capture it", () => {
    const sql = render(dayRange("2026-08-01", "2026-08-10"));
    expect(sql).toContain("`cost_daily`.`day`");
    // A `Date` bound, not a string one — this is the comparison ClickHouse
    // accepts, and the reason the bound goes through the column rather than
    // being interpolated.
    expect(sql).toContain("toDate('2026-08-01')");
    expect(sql).toContain("toDate('2026-08-10')");
  });

  it.each(SOURCES)("%s builds no day comparison of its own", (rel) => {
    // Anything comparing `day` outside `dayRange` is hand-rolled, and a
    // hand-rolled comparison is where the qualification gets lost.
    const offenders = read(rel).match(/\bday\b\s*[<>]=?\s*toDate\(/g);
    expect(offenders ?? []).toEqual([]);
  });

  it("builds an export query whose day range survives the aliased SELECT", () => {
    const { sql } = buildCostExportQuery({
      organizationId: "org_1",
      from: "2026-08-01",
      to: "2026-08-10",
      dimensions: ["service"],
      tagKeys: [],
      filters: [],
    });
    // The projection that makes the hazard live, and the predicate that is
    // immune to it — both in one statement, which is the real-world pairing.
    expect(sql).toContain("toString(`day`) as `day`");
    expect(sql).toContain(render(dayRange("2026-08-01", "2026-08-10")));
  });
});
