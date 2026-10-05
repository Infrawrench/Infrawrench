import { describe, expect, it, vi } from "vitest";

import type { BusinessMetricSourceDeclaration } from "@infrawrench/plugin-base";

// The pure helpers under test touch no database; the module's imports still
// pull the client in, so it is stubbed.
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../org-accounts", () => ({ getOrgAccountClient: vi.fn() }));
vi.mock("../plugin-loader", () => ({ getPlugin: vi.fn() }));

const { nextImportRunAt, scheduledImportWindow, validateSourceParams } =
  await import("../cost/metric-importers");

const sqlSource: BusinessMetricSourceDeclaration = {
  label: "Test SQL",
  kind: "sql",
  fields: [
    { key: "database", label: "Database", type: "select" },
    { key: "sql", label: "Query", type: "sql", required: true },
  ],
};

describe("scheduledImportWindow", () => {
  it("restates closed days ending yesterday in the importer's timezone", () => {
    const now = new Date("2026-07-10T03:00:00Z");
    expect(scheduledImportWindow({ backfillDays: 7, timezone: "UTC" }, now)).toEqual({
      from: "2026-07-03",
      to: "2026-07-09",
    });
    // 03:00 UTC is still the 9th in Los Angeles, so yesterday there is the 8th.
    expect(
      scheduledImportWindow({ backfillDays: 1, timezone: "America/Los_Angeles" }, now),
    ).toEqual({ from: "2026-07-08", to: "2026-07-08" });
  });
});

describe("nextImportRunAt", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  it("waits the schedule's interval after a success", () => {
    expect(nextImportRunAt("daily", 0, now).toISOString()).toBe("2026-07-11T00:00:00.000Z");
    expect(nextImportRunAt("every_6_hours", 0, now).toISOString()).toBe("2026-07-10T06:00:00.000Z");
  });
  it("backs off from an hour after failures, capped at the interval", () => {
    expect(nextImportRunAt("daily", 1, now).toISOString()).toBe("2026-07-10T01:00:00.000Z");
    expect(nextImportRunAt("daily", 3, now).toISOString()).toBe("2026-07-10T04:00:00.000Z");
    expect(nextImportRunAt("every_6_hours", 10, now).toISOString()).toBe(
      "2026-07-10T06:00:00.000Z",
    );
  });
});

describe("validateSourceParams", () => {
  it("accepts a read query and trims non-SQL fields", () => {
    expect(
      validateSourceParams(sqlSource, { database: " prod ", sql: "SELECT 1 AS day, 2 AS value" }),
    ).toEqual({ database: "prod", sql: "SELECT 1 AS day, 2 AS value" });
  });

  it("refuses writes, smuggled statements, unknown keys and missing required fields", () => {
    expect(() => validateSourceParams(sqlSource, { sql: "DELETE FROM users" })).toThrow(
      /only run SELECT or WITH/,
    );
    expect(() => validateSourceParams(sqlSource, { sql: "SELECT 1; DROP TABLE users" })).toThrow(
      /one statement/,
    );
    expect(() => validateSourceParams(sqlSource, { sql: "-- hi\nDROP TABLE users" })).toThrow(
      /only run SELECT or WITH/,
    );
    expect(() => validateSourceParams(sqlSource, { sql: "SELECT 1", extra: "x" })).toThrow(
      /Unknown source parameter/,
    );
    expect(() => validateSourceParams(sqlSource, { database: "prod" })).toThrow(/required/);
  });
});
