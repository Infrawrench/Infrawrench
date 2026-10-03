import { describe, expect, it } from "vitest";
import { assertSingleSqlStatement, isSingleSqlStatement } from "../sql-statements";

describe("isSingleSqlStatement", () => {
  it("accepts a single statement, with or without trailing semicolons", () => {
    expect(isSingleSqlStatement("SELECT 1")).toBe(true);
    expect(isSingleSqlStatement("SELECT 1;")).toBe(true);
    expect(isSingleSqlStatement("SELECT * FROM t WHERE a = 'x';;  \n")).toBe(true);
  });

  it("rejects stacked statements", () => {
    expect(isSingleSqlStatement("SELECT 1; DELETE FROM t")).toBe(false);
    expect(isSingleSqlStatement("COMMIT; DROP TABLE t;")).toBe(false);
  });

  it("rejects a semicolon hidden in quotes or comments, since engines disagree on those", () => {
    expect(isSingleSqlStatement("SELECT 'x\\' ' ; DROP TABLE t; -- '")).toBe(false);
    expect(isSingleSqlStatement("SELECT 1 # '\n; DROP TABLE t; -- '")).toBe(false);
    expect(isSingleSqlStatement("SELECT 1 /*! ; DROP TABLE t */")).toBe(false);
    expect(isSingleSqlStatement("SELECT ';'")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isSingleSqlStatement("")).toBe(false);
    expect(isSingleSqlStatement(" ; ")).toBe(false);
  });

  it("assertSingleSqlStatement throws on rejection", () => {
    expect(() => assertSingleSqlStatement("SELECT 1; SELECT 2")).toThrow(/single SQL statement/);
    expect(() => assertSingleSqlStatement("SELECT 1")).not.toThrow();
  });
});
