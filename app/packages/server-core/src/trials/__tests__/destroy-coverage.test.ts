import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `destroy.ts` reaches Postgres and ClickHouse at import time through their
// singleton clients; this check only wants the table list off it.
vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../../clickhouse/client", () => ({
  isClickHouseConfigured: () => false,
  getClickHouseClient: () => {
    throw new Error("not used");
  },
}));

import { ORG_SCOPED_CLICKHOUSE_TABLES } from "../destroy";

/**
 * The purge list in `destroy.ts` is hand-written, which is the point — a new
 * ClickHouse table should have to be thought about rather than swept up. This
 * is what makes forgetting fail the build instead of leaking a destroyed org's
 * rows forever.
 *
 * Read from the source text rather than by importing the schema module: the
 * ClickHouse schema pulls in the driver, and this check only needs to know
 * which tables were declared and which of them carry an `organization_id`.
 */
const schemaSource = readFileSync(
  fileURLToPath(new URL("../../clickhouse/schema.ts", import.meta.url)),
  "utf8",
);

/** Every `clickhouseTable("name", {...})` block, with its column body. */
function declaredTables(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /clickhouseTable\(\s*"([a-z0-9_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(schemaSource)) !== null) {
    const name = match[1]!;
    // The block runs to the next table declaration, or to end of file.
    const start = match.index;
    re.lastIndex = match.index + match[0].length;
    const next = /clickhouseTable\(\s*"[a-z0-9_]+"/g;
    next.lastIndex = re.lastIndex;
    const following = next.exec(schemaSource);
    out.push({ name, body: schemaSource.slice(start, following ? following.index : undefined) });
  }
  return out;
}

describe("ClickHouse purge coverage", () => {
  const tables = declaredTables();

  it("finds the ClickHouse schema (guards against this check silently passing)", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it("purges every table that carries an organization_id", () => {
    const orgScoped = tables.filter((t) => t.body.includes("organization_id:")).map((t) => t.name);
    expect(orgScoped.length).toBeGreaterThan(0);

    const missing = orgScoped.filter(
      (name) => !(ORG_SCOPED_CLICKHOUSE_TABLES as readonly string[]).includes(name),
    );
    expect(
      missing,
      `these ClickHouse tables are org-scoped but would survive org destruction: ${missing.join(", ")}. ` +
        `Add them to ORG_SCOPED_CLICKHOUSE_TABLES in trials/destroy.ts.`,
    ).toEqual([]);
  });

  it("does not purge tables that no longer exist", () => {
    const declared = new Set(tables.map((t) => t.name));
    const stale = ORG_SCOPED_CLICKHOUSE_TABLES.filter((name) => !declared.has(name));
    expect(stale, `no longer in the ClickHouse schema: ${stale.join(", ")}`).toEqual([]);
  });
});
