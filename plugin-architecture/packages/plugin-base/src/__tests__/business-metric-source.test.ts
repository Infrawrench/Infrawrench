import { describe, expect, it } from "vitest";

import {
  bindBusinessMetricSqlRange,
  businessMetricSqlProblem,
  localDayOf,
  rowsToBusinessMetricPoints,
  withBusinessMetricTimeout,
  zonedDayStartMs,
} from "../business-metric-source.js";

describe("businessMetricSqlProblem", () => {
  it("allows a single SELECT or WITH, with a trailing semicolon", () => {
    expect(businessMetricSqlProblem("SELECT 1;")).toBeNull();
    expect(businessMetricSqlProblem("with x as (select 1) select * from x")).toBeNull();
    expect(businessMetricSqlProblem("SELECT ';' AS v")).toBeNull();
  });
  it("refuses anything else", () => {
    expect(businessMetricSqlProblem("")).toMatch(/empty/);
    expect(businessMetricSqlProblem("UPDATE t SET a = 1")).toMatch(/SELECT or WITH/);
    expect(businessMetricSqlProblem("/* x */ DROP TABLE t")).toMatch(/SELECT or WITH/);
    expect(businessMetricSqlProblem("SELECT 1; DELETE FROM t")).toMatch(/one statement/);
  });
});

describe("bindBusinessMetricSqlRange", () => {
  it("substitutes quoted literals", () => {
    expect(
      bindBusinessMetricSqlRange(
        "WHERE d >= {{from}} AND d < {{ to_exclusive }} AND d <= {{to}} -- {{timezone}}",
        { from: "2026-02-27", to: "2026-02-28", timezone: "Europe/London" },
      ),
    ).toBe("WHERE d >= '2026-02-27' AND d < '2026-03-01' AND d <= '2026-02-28' -- 'Europe/London'");
  });
  it("refuses an unreal day or an unknown timezone", () => {
    expect(() =>
      bindBusinessMetricSqlRange("x", { from: "2026-02-30", to: "2026-03-01", timezone: "UTC" }),
    ).toThrow();
    expect(() =>
      bindBusinessMetricSqlRange("x", {
        from: "2026-01-01",
        to: "2026-01-02",
        timezone: "Mars/Base",
      }),
    ).toThrow(/timezone/);
  });
});

describe("rowsToBusinessMetricPoints", () => {
  it("reads day/value/label case-insensitively and coerces driver types", () => {
    expect(
      rowsToBusinessMetricPoints([
        { DAY: "2026-07-01", VALUE: "12.5", Label: "acme" },
        { DAY: "2026-07-02T00:00:00.000Z", VALUE: 3n, Label: null },
      ]),
    ).toEqual([
      { date: "2026-07-01", value: 12.5, label: "acme" },
      { date: "2026-07-02", value: 3 },
    ]);
  });
  it("fails the whole run on a missing column, a bad row or too many rows", () => {
    expect(() => rowsToBusinessMetricPoints([{ d: "2026-07-01", value: 1 }])).toThrow(/"day"/);
    expect(() => rowsToBusinessMetricPoints([{ day: "nope", value: 1 }])).toThrow(/Row 1/);
    expect(() =>
      rowsToBusinessMetricPoints(
        [
          { day: "2026-07-01", value: 1 },
          { day: "2026-07-02", value: 1 },
        ],
        1,
      ),
    ).toThrow(/more than 1 rows/);
  });
});

describe("timezone helpers", () => {
  it("finds local midnight across a DST change", () => {
    expect(new Date(zonedDayStartMs("2026-03-08", "America/New_York")).toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(new Date(zonedDayStartMs("2026-03-09", "America/New_York")).toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    expect(localDayOf(Date.parse("2026-03-09T03:59:59Z"), "America/New_York")).toBe("2026-03-08");
  });
  it("times out a slow source", async () => {
    await expect(
      withBusinessMetricTimeout(new Promise(() => {}), { timeoutMs: 10 }),
    ).rejects.toThrow(/did not answer/);
  });
});
