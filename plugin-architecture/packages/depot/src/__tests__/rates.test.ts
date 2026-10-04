import { describe, expect, it } from "vitest";
import { cycleBounds, cycleLengthDays, resolveRates } from "../rates.js";

describe("resolveRates", () => {
  it("uses the picked plan's allowances and the list rates", () => {
    const { plan, rates, ignored } = resolveRates("startup", "");
    expect(plan.id).toBe("startup");
    expect(rates.planFee).toBe(200);
    expect(rates.includedBuildMinutes).toBe(5000);
    expect(rates.includedActionsMinutes).toBe(20000);
    expect(rates.includedStorageGb).toBe(250);
    expect(rates.buildMinute).toBe(0.04);
    expect(rates.actionsMinute).toBe(0.006);
    expect(rates.cycleStartDay).toBe(1);
    expect(ignored).toEqual([]);
  });

  it("falls back to the default plan for an unknown id", () => {
    expect(resolveRates("nope", undefined).plan.id).toBe("developer");
    expect(resolveRates(undefined, undefined).rates.planFee).toBe(20);
  });

  it("applies overrides separated by commas or new lines, and reports the rest", () => {
    const { rates, ignored } = resolveRates(
      "business",
      "planFee=1000, buildMinute=$0.03\nincludedBuildMinutes = 30000\nbogus=1\ncycleStartDay=31\nactionsMinute=-1\nnoequals",
    );
    expect(rates.planFee).toBe(1000);
    expect(rates.buildMinute).toBe(0.03);
    expect(rates.includedBuildMinutes).toBe(30000);
    expect(rates.cycleStartDay).toBe(1);
    expect(rates.actionsMinute).toBe(0.006);
    expect(ignored).toEqual(["bogus=1", "cycleStartDay=31", "actionsMinute=-1", "noequals"]);
  });
});

describe("cycleBounds", () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

  it("uses calendar months by default", () => {
    const { startMs, endMs } = cycleBounds(day("2026-10-04"), 1);
    expect(new Date(startMs).toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(new Date(endMs).toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(cycleLengthDays(day("2026-02-10"), 1)).toBe(28);
  });

  it("rolls back to the previous month before the cycle day, across a year", () => {
    const { startMs, endMs } = cycleBounds(day("2026-01-10"), 15);
    expect(new Date(startMs).toISOString().slice(0, 10)).toBe("2025-12-15");
    expect(new Date(endMs).toISOString().slice(0, 10)).toBe("2026-01-15");
  });
});
