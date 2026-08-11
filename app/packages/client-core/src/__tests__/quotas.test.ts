import { describe, expect, it } from "vitest";
import {
  QUOTA_TREND_MIN_POINTS,
  alertableQuotas,
  computeQuotaTrend,
  fitQuotaSlope,
  formatDaysToExhaustion,
  formatQuotaAmount,
  formatQuotaUtilization,
  quotaSeverity,
  sortQuotaRows,
  type QuotaRow,
  type QuotaSnapshot,
} from "../quotas";

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-01T00:00:00.000Z");

/** A series climbing by a fixed utilisation step per day. */
function ramp(points: number, from: number, perDay: number): QuotaSnapshot[] {
  return Array.from({ length: points }, (_, i) => {
    const utilization = from + perDay * i;
    return {
      observedAt: new Date(T0 + i * DAY).toISOString(),
      used: utilization * 100,
      limit: 100,
      utilization,
    };
  });
}

function row(over: Partial<QuotaRow> = {}): QuotaRow {
  return {
    key: "svc/A",
    accountId: "acc-1",
    accountName: "prod",
    pluginId: "aws",
    service: "ec2",
    name: "A",
    region: null,
    limit: 100,
    used: 50,
    utilization: 0.5,
    unit: null,
    adjustable: null,
    docsUrl: null,
    observedAt: new Date(T0).toISOString(),
    severity: "ok",
    trend: { perDay: null, daysToExhaustion: null, points: 0 },
    ...over,
  };
}

describe("fitQuotaSlope", () => {
  it("recovers the slope of a clean ramp", () => {
    expect(fitQuotaSlope(ramp(10, 0.2, 0.05))).toBeCloseTo(0.05, 6);
  });

  it("is negative for a falling series", () => {
    expect(fitQuotaSlope(ramp(10, 0.9, -0.03))).toBeCloseTo(-0.03, 6);
  });

  // Two points always fit a line perfectly, and the line through two readings
  // either side of a single deploy projects that deploy repeating forever.
  it("refuses to fit fewer than the minimum points", () => {
    expect(fitQuotaSlope(ramp(QUOTA_TREND_MIN_POINTS - 1, 0.2, 0.05))).toBeNull();
    expect(fitQuotaSlope(ramp(QUOTA_TREND_MIN_POINTS, 0.2, 0.05))).not.toBeNull();
  });

  // A freshly backfilled account looks exactly like this. Not an error, but
  // not a slope either — and dividing by a zero time span produces Infinity
  // days, which renders as a confident prediction.
  it("returns null when every reading shares an instant", () => {
    const at = new Date(T0).toISOString();
    expect(
      fitQuotaSlope([
        { observedAt: at, used: 10, limit: 100, utilization: 0.1 },
        { observedAt: at, used: 20, limit: 100, utilization: 0.2 },
        { observedAt: at, used: 30, limit: 100, utilization: 0.3 },
      ]),
    ).toBeNull();
  });

  // Regression, first-vs-last would not be: the endpoints are exactly the two
  // readings most likely to be atypical. A fortnight flat at 40% with one
  // final spike to 90% must not project exhaustion tomorrow.
  it("is not dominated by a single final spike", () => {
    const flat: QuotaSnapshot[] = Array.from({ length: 13 }, (_, i) => ({
      observedAt: new Date(T0 + i * DAY).toISOString(),
      used: 40,
      limit: 100,
      utilization: 0.4,
    }));
    const spiked = [
      ...flat,
      { observedAt: new Date(T0 + 13 * DAY).toISOString(), used: 90, limit: 100, utilization: 0.9 },
    ];
    const firstVsLast = (0.9 - 0.4) / 13;
    const fitted = fitQuotaSlope(spiked)!;
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThan(firstVsLast);
  });

  it("ignores unparseable timestamps rather than producing NaN", () => {
    const series = [...ramp(5, 0.2, 0.05)];
    series.push({ observedAt: "not a date", used: 0, limit: 100, utilization: 0.5 });
    expect(fitQuotaSlope(series)).toBeCloseTo(0.05, 6);
  });
});

describe("computeQuotaTrend", () => {
  it("projects the days to exhaustion from the fitted rate", () => {
    // 0.4 headroom at 0.05/day = 8 days.
    const trend = computeQuotaTrend(ramp(10, 0.2, 0.05), 0.6);
    expect(trend.daysToExhaustion).toBeCloseTo(8, 6);
    expect(trend.points).toBe(10);
  });

  // Inventing an exhaustion date from noise around zero would put "full in 400
  // days" on a quota that is going down.
  it("reports no exhaustion date for a flat or falling trend", () => {
    expect(computeQuotaTrend(ramp(10, 0.9, -0.03), 0.6).daysToExhaustion).toBeNull();
    expect(computeQuotaTrend(ramp(10, 0.5, 0), 0.5).daysToExhaustion).toBeNull();
  });

  // A quota at 100% is `exhausted`; a days-to-exhaustion of zero would read as
  // a prediction rather than a present-tense fact.
  it("reports no exhaustion date for an already-full quota", () => {
    expect(computeQuotaTrend(ramp(10, 0.2, 0.05), 1).daysToExhaustion).toBeNull();
  });

  // A linear fit over a fortnight says something about a quota filling
  // steadily; extrapolated to a quarter it says nothing at all.
  it("declines to project beyond the horizon", () => {
    // 0.4 headroom at 0.001/day is 400 days.
    const trend = computeQuotaTrend(ramp(10, 0.2, 0.001), 0.6);
    expect(trend.perDay).not.toBeNull();
    expect(trend.daysToExhaustion).toBeNull();
  });

  // Null is "not enough history", which is rendered as such — never as "no
  // risk", because they are opposite claims and only one is true.
  it("reports null perDay, not zero, with too little history", () => {
    const trend = computeQuotaTrend(ramp(2, 0.2, 0.05), 0.25);
    expect(trend.perDay).toBeNull();
    expect(trend.points).toBe(2);
  });

  // The current row is what the rest of the page shows; projecting from a
  // different number is how a bar at 62% ends up next to "full in two days".
  it("projects from the live utilisation, not the last snapshot", () => {
    const series = ramp(10, 0.2, 0.05);
    const fromLive = computeQuotaTrend(series, 0.9).daysToExhaustion!;
    const fromLast = computeQuotaTrend(series, 0.65).daysToExhaustion!;
    expect(fromLive).toBeLessThan(fromLast);
  });
});

describe("quotaSeverity", () => {
  const rising = { perDay: 0.05, daysToExhaustion: 8, points: 10 };
  const flat = { perDay: 0, daysToExhaustion: null, points: 10 };

  // A quota at 100% is also over an 80% threshold and also trending; reporting
  // the mildest true thing about it is the least useful possible summary.
  it("orders exhausted above critical above trending", () => {
    expect(quotaSeverity(1, 0.8, rising)).toBe("exhausted");
    expect(quotaSeverity(1.4, 0.8, rising)).toBe("exhausted");
    expect(quotaSeverity(0.85, 0.8, rising)).toBe("critical");
    expect(quotaSeverity(0.4, 0.8, rising)).toBe("trending");
    expect(quotaSeverity(0.4, 0.8, flat)).toBe("ok");
  });

  it("treats the threshold itself as critical", () => {
    expect(quotaSeverity(0.8, 0.8, flat)).toBe("critical");
  });
});

describe("sortQuotaRows", () => {
  it("puts the worst first and breaks ties deterministically", () => {
    const rows = [
      row({ key: "b", severity: "ok", utilization: 0.1 }),
      row({ key: "c", severity: "critical", utilization: 0.85 }),
      row({ key: "a", severity: "exhausted", utilization: 1 }),
      row({ key: "d", severity: "critical", utilization: 0.92 }),
    ];
    expect(sortQuotaRows(rows).map((r) => r.key)).toEqual(["a", "d", "c", "b"]);
  });

  it("prefers the sooner exhaustion when utilisation ties", () => {
    const rows = [
      row({
        key: "later",
        severity: "trending",
        utilization: 0.5,
        trend: { perDay: 0.01, daysToExhaustion: 20, points: 5 },
      }),
      row({
        key: "sooner",
        severity: "trending",
        utilization: 0.5,
        trend: { perDay: 0.1, daysToExhaustion: 5, points: 5 },
      }),
    ];
    expect(sortQuotaRows(rows).map((r) => r.key)).toEqual(["sooner", "later"]);
  });

  it("does not mutate its input", () => {
    const rows = [row({ key: "b", severity: "ok" }), row({ key: "a", severity: "exhausted" })];
    sortQuotaRows(rows);
    expect(rows.map((r) => r.key)).toEqual(["b", "a"]);
  });
});

describe("alertableQuotas", () => {
  it("keeps everything but ok", () => {
    const rows = [
      row({ key: "a", severity: "exhausted" }),
      row({ key: "b", severity: "critical" }),
      row({ key: "c", severity: "trending" }),
      row({ key: "d", severity: "ok" }),
    ];
    expect(alertableQuotas(rows).map((r) => r.key)).toEqual(["a", "b", "c"]);
  });
});

describe("formatters", () => {
  it("rounds utilisation but never rounds a real value to nothing", () => {
    expect(formatQuotaUtilization(0.62)).toBe("62%");
    expect(formatQuotaUtilization(0)).toBe("0%");
    expect(formatQuotaUtilization(0.004)).toBe("<1%");
    expect(formatQuotaUtilization(1.4)).toBe("140%");
  });

  it("prints amounts with the provider's own unit", () => {
    expect(formatQuotaAmount(1024, "vCPUs")).toBe("1,024 vCPUs");
    expect(formatQuotaAmount(3, null)).toBe("3");
    expect(formatQuotaAmount(8.5, "cores")).toBe("8.5 cores");
  });

  it("says 'under a day' rather than 'in 0 days'", () => {
    expect(formatDaysToExhaustion(0.4)).toBe("in under a day");
    expect(formatDaysToExhaustion(1)).toBe("in 1 day");
    expect(formatDaysToExhaustion(8.6)).toBe("in 9 days");
  });
});
