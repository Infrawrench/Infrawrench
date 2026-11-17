import { describe, expect, it, vi } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

// `destroy.ts` reaches Postgres through its singleton client; this check only
// wants the table list off it.
vi.mock("../../db/client", () => ({ db: {} }));

import * as analyticsSchema from "../../db/analytics-schema";
import { ORG_SCOPED_ANALYTICS_TABLES } from "../destroy";

/**
 * The purge list in `destroy.ts` is hand-written, which is the point: a new
 * analytics table should have to be thought about rather than swept up. The
 * analytics tables carry no foreign key to `organizations`, so nothing else
 * deletes their rows; this is what makes forgetting fail the build instead of
 * leaking a destroyed org's rows forever.
 */
const declared = Object.values(analyticsSchema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => ({
    name: getTableConfig(table).name,
    orgScoped: "organization_id" in getTableColumns(table),
  }));

const purged = ORG_SCOPED_ANALYTICS_TABLES.map((table) => getTableConfig(table).name);

describe("analytics purge coverage", () => {
  it("finds the analytics schema (guards against this check silently passing)", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("purges every table that carries an organization_id", () => {
    const orgScoped = declared.filter((t) => t.orgScoped).map((t) => t.name);
    expect(orgScoped.length).toBeGreaterThan(0);

    const missing = orgScoped.filter((name) => !purged.includes(name));
    expect(
      missing,
      `these analytics tables are org-scoped but would survive org destruction: ${missing.join(", ")}. ` +
        `Add them to ORG_SCOPED_ANALYTICS_TABLES in trials/destroy.ts.`,
    ).toEqual([]);
  });

  it("does not purge tables that are not in the analytics schema", () => {
    const names = new Set(declared.map((t) => t.name));
    const stale = purged.filter((name) => !names.has(name));
    expect(stale, `not in the analytics schema: ${stale.join(", ")}`).toEqual([]);
  });
});
