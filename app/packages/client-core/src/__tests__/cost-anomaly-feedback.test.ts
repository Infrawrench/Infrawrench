import { describe, expect, it } from "vitest";
import {
  costAnomalyEffectiveSigmas,
  costAnomalySigmaNudge,
  costAnomalySuppressionInputError,
  defaultSuppressionExpiry,
  suppressionCoversDay,
  upcomingSuppressedDays,
} from "../cost-anomaly-feedback";

const window = { startsOn: "2026-01-01", expiresOn: "2027-12-31" };

describe("suppressionCoversDay", () => {
  it("covers every day of a one-off window, inclusive, and nothing outside it", () => {
    const s = {
      recurrence: "one_off" as const,
      anchorDay: "2026-10-01",
      startsOn: "2026-10-01",
      expiresOn: "2026-10-08",
    };
    expect(suppressionCoversDay(s, "2026-10-01")).toBe(true);
    expect(suppressionCoversDay(s, "2026-10-08")).toBe(true);
    expect(suppressionCoversDay(s, "2026-09-30")).toBe(false);
    expect(suppressionCoversDay(s, "2026-10-09")).toBe(false);
  });

  it("covers the anchor's weekday only, weekly", () => {
    // 2026-10-05 is a Monday.
    const s = { recurrence: "weekly" as const, anchorDay: "2026-10-05", ...window };
    expect(suppressionCoversDay(s, "2026-10-12")).toBe(true);
    expect(suppressionCoversDay(s, "2026-10-13")).toBe(false);
  });

  it("covers the day of the month give or take one, and falls back to month end", () => {
    const s = { recurrence: "monthly" as const, anchorDay: "2026-01-31", ...window };
    expect(suppressionCoversDay(s, "2026-02-28")).toBe(true);
    expect(suppressionCoversDay(s, "2026-03-01")).toBe(true); // one day after Feb's last day
    expect(suppressionCoversDay(s, "2026-04-30")).toBe(true);
    expect(suppressionCoversDay(s, "2026-04-15")).toBe(false);
  });

  it("covers the anniversary give or take three days, seasonal", () => {
    const s = { recurrence: "seasonal" as const, anchorDay: "2026-11-27", ...window };
    expect(suppressionCoversDay(s, "2027-11-30")).toBe(true);
    expect(suppressionCoversDay(s, "2027-12-01")).toBe(false);
    expect(suppressionCoversDay(s, "2027-06-01")).toBe(false);
  });
});

describe("upcomingSuppressedDays", () => {
  it("lists the next covered days and stops at the expiry", () => {
    const s = {
      recurrence: "weekly" as const,
      anchorDay: "2026-10-05",
      startsOn: "2026-10-05",
      expiresOn: "2026-10-20",
    };
    expect(upcomingSuppressedDays(s, "2026-10-06", 5)).toEqual(["2026-10-12", "2026-10-19"]);
  });
});

describe("defaultSuppressionExpiry", () => {
  it("uses the recurrence's lifetime", () => {
    expect(defaultSuppressionExpiry("one_off", "2026-10-01")).toBe("2026-10-08");
    expect(defaultSuppressionExpiry("weekly", "2026-10-01")).toBe("2026-12-30");
  });
});

describe("costAnomalySuppressionInputError", () => {
  const ok = {
    scope: "service" as const,
    scopeKey: "Amazon EC2",
    recurrence: "one_off" as const,
    anchorDay: "2026-10-01",
    expiresOn: "2026-10-08",
  };
  it("accepts a sound input", () => {
    expect(costAnomalySuppressionInputError(ok)).toBeNull();
  });
  it("needs a tag key for a tag scope", () => {
    expect(costAnomalySuppressionInputError({ ...ok, scope: "tag" })).not.toBeNull();
  });
  it("refuses an expiry before the start and one past three years", () => {
    expect(costAnomalySuppressionInputError({ ...ok, expiresOn: "2026-09-01" })).not.toBeNull();
    expect(costAnomalySuppressionInputError({ ...ok, expiresOn: "2030-01-01" })).not.toBeNull();
  });
  it("refuses an impossible date", () => {
    expect(costAnomalySuppressionInputError({ ...ok, anchorDay: "2026-02-30" })).not.toBeNull();
  });
});

describe("sensitivity nudge", () => {
  it("does nothing for one expected verdict, then half a σ each, capped at two", () => {
    expect(costAnomalySigmaNudge(1, 0)).toBe(0);
    expect(costAnomalySigmaNudge(2, 0)).toBe(0.5);
    expect(costAnomalySigmaNudge(3, 0)).toBe(1);
    expect(costAnomalySigmaNudge(20, 0)).toBe(2);
  });
  it("holds sensitivity once anything was marked unexpected", () => {
    expect(costAnomalySigmaNudge(5, 1)).toBe(0);
  });
  it("never passes the 10σ ceiling", () => {
    expect(costAnomalyEffectiveSigmas(9.5, 10, 0)).toBe(10);
    expect(costAnomalyEffectiveSigmas(3, 3, 0)).toBe(4);
  });
});
