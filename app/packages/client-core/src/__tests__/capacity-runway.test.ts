import { describe, expect, it } from "vitest";
import {
  alertableRunway,
  currentCycle,
  fitRobustTrend,
  forecastAllowance,
  forecastRunway,
  formatRunwayAmount,
  formatRunwayDays,
  parseCycleInstant,
  runwayStatus,
  sortRunwayRows,
  type RunwayPoint,
  type RunwayRow,
} from "../capacity-runway";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const DAY = 86_400_000;
const GiB = 1024 ** 3;

/** Hourly readings over `days`, ending now, from `value(dayOffset)`. */
function series(days: number, value: (d: number) => number, limit = 100 * GiB): RunwayPoint[] {
  const out: RunwayPoint[] = [];
  for (let h = days * 24; h >= 0; h--) {
    const d = -h / 24;
    out.push({
      observedAt: new Date(NOW.getTime() + d * DAY).toISOString(),
      used: value(d),
      limit,
    });
  }
  return out;
}

describe("fitRobustTrend", () => {
  it("refuses a short or same-instant series", () => {
    expect(
      fitRobustTrend([
        { t: 0, v: 1 },
        { t: 1, v: 2 },
      ]),
    ).toBeNull();
    expect(
      fitRobustTrend([
        { t: 0, v: 1 },
        { t: 0.1, v: 2 },
        { t: 0.2, v: 3 },
      ]),
    ).toBeNull();
  });

  it("recovers a clean slope and calls it ok", () => {
    const fit = fitRobustTrend(
      Array.from({ length: 30 }, (_, i) => ({ t: i / 2, v: 10 + 2 * (i / 2) })),
    );
    expect(fit?.slope).toBeCloseTo(2, 6);
    expect(fit?.confidence).toBe("ok");
  });

  it("is not dragged by one outlier the way a least-squares fit is", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ t: i, v: 100 + i }));
    points[29] = { t: 29, v: 10_000 };
    expect(fitRobustTrend(points)?.slope).toBeCloseTo(1, 6);
  });

  it("flags a trend smaller than its scatter as noisy", () => {
    const points = Array.from({ length: 48 }, (_, i) => ({
      t: i / 4,
      v: 50 + (i % 2 === 0 ? 10 : -10) + 0.01 * i,
    }));
    expect(fitRobustTrend(points)?.confidence).toBe("noisy");
  });
});

describe("forecastRunway", () => {
  it("projects a filling disk to its limit from the current reading", () => {
    // 1 GiB a day, at 80 GiB of 100 GiB now: 20 days left.
    const history = series(14, (d) => (80 + d) * GiB);
    const f = forecastRunway(history, 80 * GiB, 100 * GiB, NOW);
    expect(f.method).toBe("trend");
    expect(f.confidence).toBe("ok");
    expect(f.perDay! / GiB).toBeCloseTo(1, 3);
    expect(f.daysLeft).toBeCloseTo(20, 1);
    expect(Date.parse(f.fullAt!)).toBeGreaterThan(NOW.getTime());
  });

  it("says short, not safe, with too little history", () => {
    const f = forecastRunway(
      series(0.5, () => GiB),
      GiB,
      2 * GiB,
      NOW,
    );
    expect(f).toMatchObject({ perDay: null, daysLeft: null, confidence: "short" });
  });

  it("has no crossing for a flat or falling usage", () => {
    const f = forecastRunway(
      series(7, (d) => (50 - d) * GiB),
      50 * GiB,
      100 * GiB,
      NOW,
    );
    expect(f.perDay!).toBeLessThan(0);
    expect(f.daysLeft).toBeNull();
  });

  it("stops at the horizon", () => {
    const f = forecastRunway(
      series(7, (d) => GiB + d),
      GiB,
      100 * GiB,
      NOW,
    );
    expect(f.daysLeft).toBeNull();
    expect(f.perDay!).toBeGreaterThan(0);
  });
});

describe("cycles", () => {
  it("parses ISO, date-only and epoch seconds or milliseconds", () => {
    expect(parseCycleInstant("2026-11-01T00:00:00Z")?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(parseCycleInstant(1_793_491_200)?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(parseCycleInstant("1793491200000")?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(parseCycleInstant("")).toBeNull();
    expect(parseCycleInstant("soon")).toBeNull();
  });

  it("uses the anchor day without a reported start", () => {
    const c = currentCycle(NOW, { anchorDay: 20 });
    expect(c.start.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });

  it("takes the month before a reported reset when no start is reported", () => {
    const c = currentCycle(NOW, { end: new Date("2026-12-03T00:00:00Z"), anchorDay: 1 });
    expect(c.start.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-12-03T00:00:00.000Z");
  });

  it("rolls a stale reported start forward to this cycle", () => {
    const c = currentCycle(NOW, { start: new Date("2026-08-05T00:00:00Z") });
    expect(c.start.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-12-05T00:00:00.000Z");
  });
});

describe("forecastAllowance", () => {
  const cycle = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

  it("projects end-of-cycle usage and a crossing inside the cycle", () => {
    // 10 hours a day since the 1st: 175 used now, 300 at month end against 250.
    const history = series(17.5, (d) => 175 + 10 * d, 250);
    const { forecast, cycle: c } = forecastAllowance(history, 175, 250, cycle, NOW);
    expect(forecast.method).toBe("trend");
    expect(c.projectedUsed!).toBeCloseTo(300, 0);
    expect(forecast.daysLeft).toBeCloseTo(7.5, 1);
  });

  it("ignores last cycle's readings and falls back to the cycle average", () => {
    const history: RunwayPoint[] = [
      { observedAt: "2026-10-30T00:00:00.000Z", used: 900, limit: 1000 },
      { observedAt: "2026-11-18T00:00:00.000Z", used: 350, limit: 1000 },
    ];
    const { forecast, cycle: c } = forecastAllowance(history, 350, 1000, cycle, NOW);
    expect(forecast.method).toBe("cycle-average");
    expect(forecast.points).toBe(1);
    // 350 over 17.5 days is 20 a day; 12.5 days left makes 600.
    expect(c.projectedUsed!).toBeCloseTo(600, 6);
    expect(forecast.daysLeft).toBeNull();
  });
});

function row(overrides: Partial<RunwayRow>): RunwayRow {
  return {
    key: "storage",
    resourceId: "r1",
    resourceName: "db",
    resourceTypeId: "project",
    accountId: "a1",
    accountName: "prod",
    pluginId: "neon",
    label: "Storage",
    unit: "bytes",
    used: 50,
    limit: 100,
    utilization: 0.5,
    limitSource: "provider",
    plan: null,
    kind: "runway",
    source: "field",
    observedAt: NOW.toISOString(),
    forecast: {
      perDay: null,
      daysLeft: null,
      fullAt: null,
      method: null,
      confidence: "short",
      points: 0,
    },
    cycle: null,
    status: "ok",
    ...overrides,
  };
}

describe("runwayStatus", () => {
  const settings = { runwayDays: 14, allowanceThreshold: 0.8 };
  const trend = (daysLeft: number | null, confidence: "ok" | "noisy" | "short" = "ok") => ({
    perDay: 1,
    daysLeft,
    fullAt: null,
    method: "trend" as const,
    confidence,
    points: 20,
  });

  it("buckets runway rows by days left and trend quality", () => {
    expect(runwayStatus(row({ used: 100 }), settings)).toBe("full");
    expect(runwayStatus(row({ forecast: trend(6) }), settings)).toBe("critical");
    expect(runwayStatus(row({ forecast: trend(6, "noisy") }), settings)).toBe("watch");
    expect(runwayStatus(row({ forecast: trend(30) }), settings)).toBe("ok");
    expect(runwayStatus(row({}), settings)).toBe("ok");
  });

  it("buckets allowances by the threshold and the end-of-cycle projection", () => {
    const allowance = (used: number, projectedUsed: number | null) =>
      row({
        kind: "allowance",
        used,
        forecast: trend(null),
        cycle: { start: "", end: "", projectedUsed, projectedUtilization: null },
      });
    expect(runwayStatus(allowance(85, 90), settings)).toBe("critical");
    expect(runwayStatus(allowance(40, 120), settings)).toBe("critical");
    expect(runwayStatus(allowance(40, 70), settings)).toBe("ok");
  });

  it("never alerts on watch rows", () => {
    expect(alertableRunway([row({ status: "watch" }), row({ status: "full" })])).toHaveLength(1);
  });
});

describe("sortRunwayRows", () => {
  it("puts full rows first, then the soonest crossing, then the fullest", () => {
    const rows = [
      row({ key: "a", utilization: 0.9 }),
      row({ key: "b", forecast: { ...row({}).forecast, daysLeft: 3 } }),
      row({ key: "c", status: "full", utilization: 1 }),
      row({ key: "d", utilization: 0.2 }),
    ];
    expect(sortRunwayRows(rows).map((r) => r.key)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("formatting", () => {
  it("prints bytes as binary sizes and other units verbatim", () => {
    expect(formatRunwayAmount(12.4 * GiB, "bytes")).toBe("12.4 GiB");
    expect(formatRunwayAmount(1024, "connections")).toBe("1,024 connections");
    expect(formatRunwayAmount(81.234, "%")).toBe("81.23%");
  });

  it("coarsens the countdown as it grows", () => {
    expect(formatRunwayDays(0.4)).toBe("in under a day");
    expect(formatRunwayDays(9.2)).toBe("in 9 days");
    expect(formatRunwayDays(30)).toBe("in 4 weeks");
    expect(formatRunwayDays(200)).toBe("in 7 months");
  });
});
