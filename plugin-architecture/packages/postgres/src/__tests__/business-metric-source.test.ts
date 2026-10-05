import { describe, it, expect, vi } from "vitest";
import type {
  BusinessMetricSourceRange,
  HostServices,
  SqlHostServices,
} from "@infrawrench/plugin-base";
import { PostgresClient } from "../client.js";
import { plugin } from "../plugin.js";

const CS = "postgresql://user:pass@db.example.com:5432/appdb";

const RANGE: BusinessMetricSourceRange = {
  from: "2026-09-01",
  to: "2026-09-03",
  timezone: "UTC",
  maxRows: 100,
  timeoutMs: 5_000,
};

function makeSql(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn(),
    execute: vi.fn(),
    queryReadOnly: vi.fn().mockResolvedValue(rows),
  };
}

function client(sql?: SqlHostServices): PostgresClient {
  return new PostgresClient({ connectionString: CS }, { sql } as HostServices);
}

describe("Postgres business-metric source", () => {
  it("declares an enforced read-only SQL source with one sql field", () => {
    const decl = plugin.manifest.businessMetricSource;
    expect(decl?.kind).toBe("sql");
    expect(decl?.readOnly).toBe("enforced");
    expect(decl?.sqlDialect).toBe("PostgreSQL");
    expect(decl?.fields.map((f) => [f.key, f.type, f.required])).toEqual([["sql", "sql", true]]);
  });

  it("binds the range and runs through queryReadOnly, never query", async () => {
    const sql = makeSql([
      { day: "2026-09-01", value: "12", label: null },
      { day: new Date(2026, 8, 2), value: 7, label: "eu" },
    ]);
    const result = await client(sql).runBusinessMetricSource(
      "acct",
      {
        sql: "SELECT d AS day, n AS value FROM t WHERE d >= {{from}} AND d < {{to_exclusive}} AND tz = {{timezone}}",
      },
      RANGE,
    );
    expect(sql.queryReadOnly).toHaveBeenCalledWith(
      "SELECT d AS day, n AS value FROM t WHERE d >= '2026-09-01' AND d < '2026-09-04' AND tz = 'UTC'",
    );
    expect(sql.query).not.toHaveBeenCalled();
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 12 },
      { date: "2026-09-02", value: 7, label: "eu" },
    ]);
  });

  it("refuses to run when the host cannot guarantee a read-only query", async () => {
    const sql = { query: vi.fn(), execute: vi.fn() };
    await expect(
      client(sql).runBusinessMetricSource("acct", { sql: "SELECT 1 AS day, 1 AS value" }, RANGE),
    ).rejects.toThrow(/cannot guarantee a read-only query/);
    expect(sql.query).not.toHaveBeenCalled();
  });

  it("rejects writes and multiple statements before reaching the database", async () => {
    const sql = makeSql();
    const c = client(sql);
    await expect(
      c.runBusinessMetricSource("acct", { sql: "DELETE FROM signups" }, RANGE),
    ).rejects.toThrow(/only run SELECT or WITH/);
    await expect(
      c.runBusinessMetricSource("acct", { sql: "SELECT 1; DROP TABLE signups" }, RANGE),
    ).rejects.toThrow(/one statement/);
    await expect(c.runBusinessMetricSource("acct", {}, RANGE)).rejects.toThrow(/empty/);
    expect(sql.queryReadOnly).not.toHaveBeenCalled();
  });

  it("throws rather than truncating past maxRows", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ day: `2026-09-0${i + 1}`, value: i }));
    await expect(
      client(makeSql(rows)).runBusinessMetricSource(
        "acct",
        { sql: "SELECT day, value FROM t" },
        { ...RANGE, maxRows: 2 },
      ),
    ).rejects.toThrow(/more than 2 rows/);
  });

  it("fails on a missing value column", async () => {
    await expect(
      client(makeSql([{ day: "2026-09-01", n: 1 }])).runBusinessMetricSource(
        "acct",
        { sql: "SELECT day, n FROM t" },
        RANGE,
      ),
    ).rejects.toThrow(/"value" column/);
  });

  it("gives up after the timeout", async () => {
    const sql = makeSql();
    sql.queryReadOnly.mockReturnValue(new Promise(() => {}));
    await expect(
      client(sql).runBusinessMetricSource(
        "acct",
        { sql: "SELECT day, value FROM t" },
        { ...RANGE, timeoutMs: 10 },
      ),
    ).rejects.toThrow(/did not answer/);
  });
});
