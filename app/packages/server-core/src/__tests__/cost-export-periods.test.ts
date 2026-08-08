import { describe, it, expect } from "vitest";
import {
  nextCostExportRunAt,
  periodContaining,
  periodsToExport,
  zonedInstant,
} from "../cost-exports/periods";

describe("periodContaining", () => {
  it("makes a daily period one day", () => {
    expect(periodContaining("daily", "2026-08-07")).toEqual({
      key: "2026-08-07",
      from: "2026-08-07",
      to: "2026-08-07",
    });
  });

  it("snaps a weekly period back to its Monday", () => {
    // 2026-08-07 is a Friday.
    expect(periodContaining("weekly", "2026-08-07")).toEqual({
      key: "2026-08-03",
      from: "2026-08-03",
      to: "2026-08-09",
    });
  });

  it("keeps a Monday as its own week start", () => {
    expect(periodContaining("weekly", "2026-08-03").from).toBe("2026-08-03");
  });

  it("handles month lengths without a lookup table", () => {
    expect(periodContaining("monthly", "2026-02-14").to).toBe("2026-02-28");
    // 2028 is a leap year.
    expect(periodContaining("monthly", "2028-02-14").to).toBe("2028-02-29");
    expect(periodContaining("monthly", "2026-12-31")).toEqual({
      key: "2026-12-01",
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });
});

describe("periodsToExport", () => {
  const now = new Date("2026-08-08T09:00:00Z");

  it("never exports today — only through yesterday", () => {
    const periods = periodsToExport({
      cadence: "daily",
      timezone: "UTC",
      restatementDays: 0,
      now,
    });
    expect(periods).toEqual([{ key: "2026-08-07", from: "2026-08-07", to: "2026-08-07" }]);
  });

  it("re-exports one period per day across the restatement window", () => {
    const periods = periodsToExport({
      cadence: "daily",
      timezone: "UTC",
      restatementDays: 7,
      now,
    });
    expect(periods.map((p) => p.key)).toEqual([
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
  });

  it("rebuilds an overlapped month IN FULL, not just the window's slice", () => {
    // The window reaches back into July, so July's object must be rewritten
    // from July 1 — a partial rewrite would truncate the file a consumer has.
    const periods = periodsToExport({
      cadence: "monthly",
      timezone: "UTC",
      restatementDays: 7,
      now,
    });
    expect(periods).toEqual([
      { key: "2026-07-01", from: "2026-07-01", to: "2026-07-31" },
      // August is still in progress, so it stops at yesterday.
      { key: "2026-08-01", from: "2026-08-01", to: "2026-08-07" },
    ]);
  });

  it("clamps an in-progress week to yesterday", () => {
    const periods = periodsToExport({
      cadence: "weekly",
      timezone: "UTC",
      restatementDays: 0,
      now,
    });
    expect(periods).toEqual([{ key: "2026-08-03", from: "2026-08-03", to: "2026-08-07" }]);
  });

  it("follows the export's own timezone for what 'yesterday' means", () => {
    // 03:00Z is already the 8th in UTC but still the evening of the 7th in
    // Los Angeles (UTC-7), so the LA export's newest complete day is the 6th.
    const earlyMorning = new Date("2026-08-08T03:00:00Z");
    const utc = periodsToExport({
      cadence: "daily",
      timezone: "UTC",
      restatementDays: 0,
      now: earlyMorning,
    });
    const la = periodsToExport({
      cadence: "daily",
      timezone: "America/Los_Angeles",
      restatementDays: 0,
      now: earlyMorning,
    });
    expect(utc[0]!.key).toBe("2026-08-07");
    expect(la[0]!.key).toBe("2026-08-06");
  });

  it("bounds the batch even at the maximum window", () => {
    const periods = periodsToExport({
      cadence: "daily",
      timezone: "UTC",
      restatementDays: 90,
      now,
    });
    expect(periods).toHaveLength(91);
  });
});

describe("zonedInstant", () => {
  it("resolves a wall-clock hour to the right instant", () => {
    expect(zonedInstant("2026-08-07", 4, "UTC").toISOString()).toBe("2026-08-07T04:00:00.000Z");
    // Berlin is UTC+2 in August.
    expect(zonedInstant("2026-08-07", 4, "Europe/Berlin").toISOString()).toBe(
      "2026-08-07T02:00:00.000Z",
    );
    // …and UTC+1 in January, which is the whole reason the offset is looked up
    // per-instant rather than cached.
    expect(zonedInstant("2026-01-07", 4, "Europe/Berlin").toISOString()).toBe(
      "2026-01-07T03:00:00.000Z",
    );
  });
});

describe("nextCostExportRunAt", () => {
  it("takes today's hour when it has not passed yet", () => {
    const from = new Date("2026-08-07T01:00:00Z");
    expect(nextCostExportRunAt("daily", 4, "UTC", from).toISOString()).toBe(
      "2026-08-07T04:00:00.000Z",
    );
  });

  it("rolls to tomorrow once the hour has passed", () => {
    const from = new Date("2026-08-07T05:00:00Z");
    expect(nextCostExportRunAt("daily", 4, "UTC", from).toISOString()).toBe(
      "2026-08-08T04:00:00.000Z",
    );
  });

  it("fires weekly on Mondays", () => {
    // 2026-08-07 is a Friday; the next Monday is the 10th.
    const from = new Date("2026-08-07T05:00:00Z");
    expect(nextCostExportRunAt("weekly", 4, "UTC", from).toISOString()).toBe(
      "2026-08-10T04:00:00.000Z",
    );
  });

  it("fires monthly on the 1st", () => {
    const from = new Date("2026-08-07T05:00:00Z");
    expect(nextCostExportRunAt("monthly", 4, "UTC", from).toISOString()).toBe(
      "2026-09-01T04:00:00.000Z",
    );
  });

  it("keeps the local hour across a DST change rather than drifting", () => {
    // Europe/Berlin springs forward on 2026-03-29. 04:00 local is 03:00Z
    // before and 02:00Z after — the same wall clock either side, which is what
    // the user asked for.
    const before = nextCostExportRunAt(
      "daily",
      4,
      "Europe/Berlin",
      new Date("2026-03-27T05:00:00Z"),
    );
    const after = nextCostExportRunAt(
      "daily",
      4,
      "Europe/Berlin",
      new Date("2026-03-29T05:00:00Z"),
    );
    expect(before.toISOString()).toBe("2026-03-28T03:00:00.000Z");
    expect(after.toISOString()).toBe("2026-03-30T02:00:00.000Z");
  });

  it("falls back to UTC for an unknown zone instead of throwing", () => {
    const from = new Date("2026-08-07T01:00:00Z");
    expect(nextCostExportRunAt("daily", 4, "Mars/Olympus", from).toISOString()).toBe(
      "2026-08-07T04:00:00.000Z",
    );
  });

  it("always returns an instant strictly after `from`", () => {
    const exact = new Date("2026-08-07T04:00:00Z");
    expect(nextCostExportRunAt("daily", 4, "UTC", exact).getTime()).toBeGreaterThan(
      exact.getTime(),
    );
  });
});
