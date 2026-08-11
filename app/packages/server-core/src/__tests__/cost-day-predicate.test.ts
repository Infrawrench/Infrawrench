/**
 * Guards the one thing that makes `cost_daily`'s day-range predicate safe:
 * the column is qualified.
 *
 * ClickHouse resolves SELECT aliases inside WHERE. Four readers project
 * `toString(day) AS day` so JS gets a "YYYY-MM-DD" string, and in those an
 * unqualified `day` in the WHERE binds to the alias rather than the column —
 * `String >= Date`, which ClickHouse refuses to unify ("There is no supertype
 * for types String, Date"). In `cost-reconcile.ts` that throw is not a blank
 * panel: it escapes `collectAccountCosts` and fails the account's entire cost
 * collection.
 *
 * The pairing is invisible at either end on its own — a `SELECT` list and a
 * `WHERE` two lines apart, each fine in isolation — so it is asserted over the
 * source of every cost reader rather than per query. See `DAY_FROM_SQL` in
 * `clickhouse/cost-readers.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAY_FROM_SQL, DAY_TO_SQL } from "../clickhouse/cost-readers";
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

describe("cost_daily day-range predicate", () => {
  it("qualifies the column so a SELECT alias cannot capture it", () => {
    expect(DAY_FROM_SQL).toContain("cost_daily.day");
    expect(DAY_TO_SQL).toContain("cost_daily.day");
  });

  it.each(SOURCES)("%s never compares an unqualified day to a date", (rel) => {
    // An unqualified `day <op> toDate(...)` is the shape that binds to a
    // `toString(day) AS day` projection. `cost_daily.day` is exempt, which is
    // the whole point; the negative lookbehind is what distinguishes them.
    const offenders = read(rel).match(/(?<!cost_daily\.)\bday\s*[<>]=?\s*toDate\(/g);
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
    expect(sql).toContain("toString(day) AS day");
    expect(sql).toContain(DAY_FROM_SQL);
    expect(sql).toContain(DAY_TO_SQL);
  });
});
