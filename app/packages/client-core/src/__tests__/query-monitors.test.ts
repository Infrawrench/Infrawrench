import { describe, expect, it } from "vitest";

import {
  QUERY_MONITOR_LIMITS,
  breaches,
  foldMonitorRun,
  monitorSqlProblem,
  normalizeMonitorSql,
  readMonitorValue,
  validateQueryMonitor,
  type QueryMonitorInput,
} from "../query-monitors";

const base: QueryMonitorInput = {
  name: "Dead letters",
  accountId: "acct-1",
  sql: "SELECT count(*) FROM dead_letters",
  mode: "scalar",
  operator: "gt",
  threshold: 0,
  intervalMinutes: 15,
};

describe("normalizeMonitorSql", () => {
  it("strips line and block comments", () => {
    expect(normalizeMonitorSql("-- note\nSELECT 1")).toBe("SELECT 1");
    expect(normalizeMonitorSql("/* note */ SELECT 1")).toBe("SELECT 1");
  });
});

describe("monitorSqlProblem", () => {
  it("accepts the read-only leading keywords", () => {
    for (const sql of [
      "SELECT count(*) FROM t",
      "with x as (select 1) select * from x",
      "SHOW TABLES",
      "EXPLAIN SELECT 1",
      "  select 1;  ",
    ]) {
      expect(monitorSqlProblem(sql)).toBeNull();
    }
  });

  it("rejects a write", () => {
    expect(monitorSqlProblem("DELETE FROM users")).toContain("may only run");
    expect(monitorSqlProblem("update t set a = 1")).toContain("may only run");
  });

  it("sees through a leading comment", () => {
    // A check that only trimmed whitespace would read the comment as the
    // statement and wave this through.
    expect(monitorSqlProblem("-- harmless\nDROP TABLE users")).toContain("may only run");
    expect(monitorSqlProblem("/* ok */ TRUNCATE t")).toContain("may only run");
  });

  it("rejects a second statement even when the first is a select", () => {
    // The leading-keyword check alone would wave this through, which is the
    // whole reason the single-statement rule exists.
    expect(monitorSqlProblem("SELECT 1; DROP TABLE users")).toContain("one statement");
  });

  it("allows a semicolon inside a string literal", () => {
    expect(monitorSqlProblem("SELECT 'a;b' FROM t")).toBeNull();
    expect(monitorSqlProblem('SELECT "a;b" FROM t')).toBeNull();
  });

  it("rejects an empty query", () => {
    expect(monitorSqlProblem("   ")).toBe("The query is empty.");
    expect(monitorSqlProblem("-- only a comment")).toBe("The query is empty.");
  });
});

describe("validateQueryMonitor", () => {
  it("accepts a sound monitor", () => {
    expect(validateQueryMonitor(base)).toBeNull();
  });

  it("requires a name and an account", () => {
    expect(validateQueryMonitor({ ...base, name: " " })).toBe("A name is required.");
    expect(validateQueryMonitor({ ...base, accountId: "" })).toContain("account");
  });

  it("bounds the interval", () => {
    expect(
      validateQueryMonitor({
        ...base,
        intervalMinutes: QUERY_MONITOR_LIMITS.minIntervalMinutes - 1,
      }),
    ).toContain("interval");
  });

  it("rejects a half-specified resource scope", () => {
    // Neither half alone can be resolved to a connection; rejecting here beats
    // a runtime "no SQL driver available".
    expect(validateQueryMonitor({ ...base, resourceId: "r1" })).toContain("both the resource");
    expect(validateQueryMonitor({ ...base, resourceTypeId: "db" })).toContain("both the resource");
    expect(validateQueryMonitor({ ...base, resourceId: "r1", resourceTypeId: "db" })).toBeNull();
  });

  it("carries the SQL guard's own message", () => {
    expect(validateQueryMonitor({ ...base, sql: "DROP TABLE t" })).toContain("may only run");
  });
});

describe("breaches", () => {
  it("is total over the operators", () => {
    expect(breaches(5, "gt", 4)).toBe(true);
    expect(breaches(4, "gt", 4)).toBe(false);
    expect(breaches(4, "gte", 4)).toBe(true);
    expect(breaches(3, "lt", 4)).toBe(true);
    expect(breaches(4, "lte", 4)).toBe(true);
    expect(breaches(4, "eq", 4)).toBe(true);
    expect(breaches(5, "neq", 4)).toBe(true);
  });
});

describe("readMonitorValue", () => {
  it("counts rows in rowCount mode", () => {
    expect(readMonitorValue([{ a: 1 }, { a: 2 }], "rowCount")).toBe(2);
    expect(readMonitorValue([], "rowCount")).toBe(0);
  });

  it("reads the first column of the first row in scalar mode", () => {
    expect(readMonitorValue([{ count: 7, other: 9 }], "scalar")).toBe(7);
  });

  it("accepts a numeric string, because bigint counts arrive as strings", () => {
    // Refusing them would make `SELECT count(*)` — the most obvious monitor
    // anybody writes — not work on Postgres.
    expect(readMonitorValue([{ count: "42" }], "scalar")).toBe(42);
  });

  it("returns null when there is nothing comparable", () => {
    expect(readMonitorValue([], "scalar")).toBeNull();
    expect(readMonitorValue([{ name: "hello" }], "scalar")).toBeNull();
    expect(readMonitorValue([{ v: null }], "scalar")).toBeNull();
  });
});

describe("foldMonitorRun", () => {
  const fold = (over: Partial<Parameters<typeof foldMonitorRun>[0]>) =>
    foldMonitorRun({
      previousStreak: 0,
      operator: "gt",
      threshold: 0,
      consecutiveBreaches: 1,
      ...over,
    });

  it("is ok below the threshold and resets the streak", () => {
    expect(fold({ value: 0, previousStreak: 3 })).toMatchObject({
      state: "ok",
      breachStreak: 0,
      shouldAlert: false,
    });
  });

  it("alerts on the run that reaches the streak, and only then", () => {
    expect(fold({ value: 5, consecutiveBreaches: 2, previousStreak: 0 })).toMatchObject({
      state: "breaching",
      breachStreak: 1,
      shouldAlert: false,
    });
    expect(fold({ value: 5, consecutiveBreaches: 2, previousStreak: 1 })).toMatchObject({
      breachStreak: 2,
      shouldAlert: true,
    });
    // Past the threshold it must not page again, or a breach becomes an hourly
    // alarm until somebody fixes it.
    expect(fold({ value: 5, consecutiveBreaches: 2, previousStreak: 2 })).toMatchObject({
      breachStreak: 3,
      shouldAlert: false,
    });
  });

  it("reports a failed query as unknown, never ok and never breaching", () => {
    // A failed query has told you nothing about the data.
    expect(fold({ error: "connection refused" })).toMatchObject({
      state: "unknown",
      value: null,
      shouldAlert: false,
    });
  });

  it("does not let a failure reset the streak", () => {
    // Breach, error, breach is two breaches; treating the error as a recovery
    // would let an intermittently failing query hold off an alert forever.
    const errored = fold({ error: "timeout", previousStreak: 1 });
    expect(errored.breachStreak).toBe(1);
    expect(
      fold({ value: 5, previousStreak: errored.breachStreak, consecutiveBreaches: 2 }),
    ).toMatchObject({ shouldAlert: true });
  });

  it("treats an uncomparable result as unknown with a reason", () => {
    expect(fold({ value: null })).toMatchObject({ state: "unknown" });
    expect(fold({ value: null }).error).toContain("no comparable number");
  });
});
