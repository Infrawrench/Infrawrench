import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Guards migration `0055_grandfather_workflow_permissions` — the one-time data
 * migration that writes the pre-split `dashboards:*` → `workflows:*`
 * implication into stored grants, replacing the runtime shim that used to guess
 * it from a timestamp.
 *
 * It cannot be executed here (these tests have no database), so what is checked
 * is the shape that makes it safe to run against production data: it only ever
 * appends, it only ever appends the three workflow permissions, and it never
 * touches a row that already matches the permission it would add — which is
 * what keeps a `*` holder from being rewritten into an explicit list.
 */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const TAG = "0055_grandfather_workflow_permissions";

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

describe("0055 grandfather workflow permissions", () => {
  it("is registered in the drizzle journal", () => {
    // An unregistered file is a file that never runs — and the runtime shim it
    // replaces is gone, so pre-split grants would simply lose workflow access.
    expect(journal.entries.some((e) => e.tag === TAG)).toBe(true);
  });

  it("only updates the two tables that store grants verbatim", () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^UPDATE "(roles|api_keys)"/);
    }
    // Data-only: a schema change here would be invisible to drizzle's snapshot.
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|DELETE|TRUNCATE)\b/i);
  });

  it("appends rather than replaces, and appends only workflow permissions", () => {
    for (const statement of statements) {
      // `col = col || '[...]'` — an assignment that does not re-read the column
      // would discard whatever the org had granted.
      expect(statement).toMatch(
        /SET "(permissions|scopes)" = "\1" \|\| '\["workflows:(read|write|approve)"\]'::jsonb/,
      );
    }
  });

  it("never rewrites a row that already matches the permission it would add", () => {
    for (const statement of statements) {
      const guard = statement.match(/AND NOT EXISTS \((.*?)\)\s*;?$/)?.[1];
      expect(guard).toBeDefined();
      // The bare wildcard matches every permission, so a role or key holding
      // `*` must be left exactly as it is.
      expect(guard).toContain("'*'");
      expect(guard).toContain("'*:*'");
      // …as must one that already holds the whole workflow family.
      expect(guard).toContain("'workflows:*'");
    }
  });

  it("leaves system roles alone — they resolve from code, not from the row", () => {
    for (const statement of statements.filter((s) => s.startsWith('UPDATE "roles"'))) {
      expect(statement).toContain('"is_system" = false');
    }
  });
});
