import { describe, expect, it } from "vitest";
import {
  formatCell,
  inferFormat,
  numericFilter,
  parseDateTime,
  toCsv,
  viewPlatform,
  type Units,
} from "../format";
import { checkAgainstResult, parseViewSpec } from "../spec";
import { QueryError, checkSql } from "../sql";

describe("checkSql", () => {
  it("passes reads and strips a trailing semicolon", () => {
    expect(checkSql("SELECT 1;")).toBe("SELECT 1");
    expect(checkSql("-- note\nWITH x AS (SELECT 1) SELECT * FROM x")).toContain("WITH");
    expect(checkSql("DESCRIBE TABLE prices")).toBe("DESCRIBE TABLE prices");
  });

  it("refuses writes, several statements, FORMAT and SETTINGS", () => {
    expect(() => checkSql("DROP TABLE prices")).toThrow(QueryError);
    expect(() => checkSql("SELECT 1; DROP TABLE prices")).toThrow(/one statement/);
    expect(() => checkSql("SELECT 1 FORMAT CSV")).toThrow(/FORMAT/);
    expect(() => checkSql("SELECT 1 SETTINGS max_threads = 1")).toThrow(/SETTINGS/);
  });

  it("does not mistake a semicolon in a string for a second statement", () => {
    expect(checkSql("SELECT 'a;b'")).toBe("SELECT 'a;b'");
  });
});

describe("parseViewSpec", () => {
  it("builds a table spec, dropping unknown formats", () => {
    expect(
      parseViewSpec("table", {
        title: " Cheap ARM ",
        sql: "SELECT 1",
        columns: [{ name: "a", format: "usd_hour" }, { name: "b", format: "nope" }, {}],
        sort_by: "a",
        sort_desc: true,
      }),
    ).toEqual({
      kind: "table",
      title: "Cheap ARM",
      sql: "SELECT 1",
      columns: [{ name: "a", format: "usd_hour" }, { name: "b" }],
      sort: { column: "a", direction: "desc" },
    });
  });

  it("says what is missing", () => {
    expect(
      parseViewSpec("chart", { title: "t", sql: "SELECT 1", chart_type: "pie", x: "a", y: "b" }),
    ).toMatch(/chart_type/);
    expect(parseViewSpec("table", { sql: "SELECT 1" })).toMatch(/title/);
  });

  it("checks named columns against the result", () => {
    const spec = parseViewSpec("chart", {
      title: "t",
      sql: "s",
      chart_type: "bar",
      x: "name",
      y: "price",
    });
    expect(typeof spec).toBe("object");
    expect(checkAgainstResult(spec as never, ["name", "cost"])).toMatch(/`price`/);
    expect(checkAgainstResult(spec as never, ["name", "price"])).toBeNull();
  });
});

describe("formatting", () => {
  const units: Units = {
    perHour: (p) => `${p}/hr`,
    perMonth: (p) => `${p}/mo`,
    gib: (a) => `${a} GiB`,
    yes: "Yes",
    no: "No",
  };

  it("infers formats from names and types", () => {
    expect(inferFormat("hourly_usd", "Float64")).toBe("usd_hour");
    expect(inferFormat("monthly_usd", "Float64")).toBe("usd_month");
    expect(inferFormat("memory_gib", "Nullable(Float64)")).toBe("gib");
    expect(inferFormat("instance_type", "String")).toBe("instance");
    expect(inferFormat("valid_from", "DateTime")).toBe("datetime");
    expect(inferFormat("vcpu", "Nullable(Float64)")).toBe("number");
  });

  it("formats small prices with enough digits", () => {
    expect(formatCell(0.0042, "usd_hour", "en", units)).toBe("$0.0042/hr");
    expect(formatCell(29.784, "usd_month", "en", units)).toBe("$29.78/mo");
    expect(formatCell("2026-10-29 17:56:34", "date", "en", units)).toBe("Oct 29, 2026");
  });

  it("parses numeric filters", () => {
    expect(numericFilter(">4")?.(5)).toBe(true);
    expect(numericFilter("<=0.05")?.(0.06)).toBe(false);
    expect(numericFilter("2..8")?.(8)).toBe(true);
    expect(numericFilter("graviton")).toBeNull();
  });

  it("reads ClickHouse DateTimes as UTC", () => {
    expect(parseDateTime("1970-01-02 00:00:00")).toBe(86400);
  });

  it("finds the platform a query is about", () => {
    expect(viewPlatform("SELECT * FROM prices WHERE platform = 'rds' AND current")).toBe("rds");
    expect(viewPlatform("SELECT * FROM prices WHERE platform IN ('rds','ec2')")).toBe("ec2");
  });

  it("writes CSV with quoting", () => {
    const cols = [
      { index: 0, name: "a", label: "A", format: "text" as const, numeric: false },
      { index: 1, name: "b", label: "B", format: "number" as const, numeric: true },
    ];
    expect(
      toCsv(cols, [
        ["x,y", 1],
        [null, 2],
      ]),
    ).toBe('A,B\n"x,y",1\n,2');
  });
});
