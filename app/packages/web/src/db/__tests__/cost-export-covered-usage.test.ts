import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Guards migration `0091_cost_export_covered_usage` — the one-time data
 * migration that appends `commitment_covered_usage` to stored cost-export
 * queries that were narrowed to `usage`.
 *
 * The failure it repairs is silent by construction. Until the collectors
 * learned to stamp it, commitment-covered consumption *was* `usage`, so an
 * export filtered to `["usage"]` meant "consumption". Split it in two and that
 * export keeps running, keeps succeeding, and quietly drops the covered spend
 * from the warehouse — no error, no gap, just a smaller number.
 *
 * It cannot be executed here (these tests have no database), so what is checked
 * is the shape that makes it safe to run against production data: it appends
 * rather than replaces, it appends exactly one member, it is a no-op on a
 * re-run, and it does not touch exports that never narrowed their charge types
 * in the first place.
 */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const TAG = "0091_cost_export_covered_usage";

const sql = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
) as {
  entries: { idx: number; tag: string }[];
};

/** The migration's statements, comments stripped, whitespace collapsed. */
const statements = sql
  .split("--> statement-breakpoint")
  .map((chunk) =>
    chunk
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  )
  .filter((s) => s.length > 0);

describe("0091 cost export commitment-covered usage", () => {
  it("is registered in the drizzle journal", () => {
    // An unregistered file is a file that never runs — and nothing else repairs
    // these configs, so every affected export would under-report forever.
    expect(journal.entries.some((e) => e.tag === TAG)).toBe(true);
  });

  it("only touches the one table that stores a charge-type list", () => {
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UPDATE "cost_exports"/);
    // Data-only: a schema change here would be invisible to drizzle's snapshot.
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|DELETE|TRUNCATE)\b/i);
  });

  it("appends to the stored array rather than replacing it", () => {
    // An assignment that does not re-read the column would discard whatever
    // else the author had selected — credits, tax, the lot.
    expect(statements[0]).toContain("(\"query\" -> 'chargeTypes') ||");
    expect(statements[0]).toContain("jsonb_set");
    expect(statements[0]).toContain("'{chargeTypes}'");
  });

  it("appends exactly the one new member", () => {
    const appended = statements[0]!.match(/\|\| '(\[[^']*\])'::jsonb/)?.[1];
    expect(appended).toBeDefined();
    expect(JSON.parse(appended!)).toEqual(["commitment_covered_usage"]);
  });

  it("only rewrites an export that was narrowed to usage", () => {
    // Absent `chargeTypes` already means every charge type — those exports
    // never lost anything and must not gain a narrowing key.
    expect(statements[0]).toContain("jsonb_typeof(\"query\" -> 'chargeTypes') = 'array'");
    expect(statements[0]).toContain("\"query\" -> 'chargeTypes' @> '[\"usage\"]'::jsonb");
  });

  it("is a no-op on a re-run", () => {
    // Re-running a migration is not supposed to happen, but appending twice
    // would leave a duplicate member in a list the API re-validates.
    expect(statements[0]).toMatch(
      /AND NOT \("query" -> 'chargeTypes' @> '\["commitment_covered_usage"\]'::jsonb\)/,
    );
  });
});
