import { describe, expect, it } from "vitest";
import {
  describeDrillCheck,
  drillCheckVerdict,
  drillRpoMinutes,
  drillRtoMinutes,
  validateDrillSchedule,
  type RestoreDrillScheduleInput,
} from "../restore-drill-schedules";

const base: RestoreDrillScheduleInput = {
  resourceId: "acct:neon-branch:p/br",
  intervalDays: 30,
  restorePoint: "point-in-time",
  pointInTimeHoursAgo: 6,
  verifySql: "SELECT count(*) FROM orders",
  verifyMode: "scalar",
  verifyOperator: "gt",
  verifyThreshold: 0,
  timeLimitMinutes: 60,
};

describe("validateDrillSchedule", () => {
  it("accepts a complete schedule", () => {
    expect(validateDrillSchedule(base)).toBeNull();
    expect(validateDrillSchedule({ ...base, verifySql: null })).toBeNull();
  });

  it("checks the restore point against what the provider can do", () => {
    const target = { restorePoints: ["point-in-time" as const], maxLookbackHours: 24 };
    expect(validateDrillSchedule(base, target)).toBeNull();
    expect(validateDrillSchedule({ ...base, pointInTimeHoursAgo: 48 }, target)).toMatch(
      /between 0 and 24/,
    );
    expect(
      validateDrillSchedule(
        { ...base, restorePoint: "latest-backup", pointInTimeHoursAgo: null },
        target,
      ),
    ).toMatch(/cannot restore/);
  });

  it("only takes an offset for a point-in-time drill", () => {
    expect(
      validateDrillSchedule({ ...base, restorePoint: "latest-backup", pointInTimeHoursAgo: 3 }),
    ).toMatch(/offset/);
  });

  it("refuses a check that is not read-only", () => {
    expect(validateDrillSchedule({ ...base, verifySql: "DELETE FROM orders" })).toMatch(/only run/);
  });

  it("bounds the interval and the time limit", () => {
    expect(validateDrillSchedule({ ...base, intervalDays: 0 })).toMatch(/Run every/);
    expect(validateDrillSchedule({ ...base, timeLimitMinutes: 1 })).toMatch(/time limit/);
    expect(validateDrillSchedule({ ...base, timeLimitMinutes: 10_000 })).toMatch(/time limit/);
  });
});

describe("drillCheckVerdict", () => {
  const check = { verifyMode: "scalar", verifyOperator: "gt", verifyThreshold: 0 } as const;

  it("passes when the condition holds", () => {
    expect(drillCheckVerdict(check, { value: 42, error: null })).toEqual({
      passed: true,
      detail: "Checked: value > 0 (got 42).",
    });
  });

  it("fails when it does not, or when the check could not run", () => {
    expect(drillCheckVerdict(check, { value: 0, error: null }).passed).toBe(false);
    expect(drillCheckVerdict(check, { value: null, error: null }).passed).toBe(false);
    expect(drillCheckVerdict(check, { value: null, error: "relation does not exist" })).toEqual({
      passed: false,
      detail: "The check could not run: relation does not exist",
    });
  });

  it("names row counts as such", () => {
    expect(
      describeDrillCheck({ verifyMode: "rowCount", verifyOperator: "gte", verifyThreshold: 1 }),
    ).toBe("row count ≥ 1");
  });
});

describe("clock arithmetic", () => {
  it("rounds a restore time up to whole minutes, never to zero", () => {
    expect(drillRtoMinutes(0)).toBe(1);
    expect(drillRtoMinutes(61)).toBe(2);
    expect(drillRtoMinutes(3600)).toBe(60);
  });

  it("measures restore point age from the start of the run", () => {
    expect(drillRpoMinutes("2026-11-18T08:00:00Z", "2026-11-18T10:00:00Z")).toBe(120);
    expect(drillRpoMinutes(null, "2026-11-18T10:00:00Z")).toBeNull();
    expect(drillRpoMinutes("nonsense", "2026-11-18T10:00:00Z")).toBeNull();
  });
});
