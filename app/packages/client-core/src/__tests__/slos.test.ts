import { describe, expect, it } from "vitest";
import {
  SLO_BURN_POLICIES,
  buildSloHistory,
  computeSloSnapshot,
  deriveSloStatus,
  formatBudgetDuration,
  formatBurnRate,
  normalizeSloSource,
  sloBudgetRemaining,
  sloBudgetTotalMinutes,
  sloBurnRate,
  sloBurnRateThreshold,
  sloMinuteGoodness,
  validateSloInput,
  type SloBucket,
  type SloInput,
  type SloSourceFields,
} from "../slos";

const availability: SloSourceFields = {
  sliKind: "probe_availability",
  probeId: "p1",
  latencyThresholdMs: null,
  resourceId: null,
  metricKey: null,
  comparator: null,
  threshold: null,
};

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** One bucket per minute for the last `minutes`, `badMinutes` of them (the newest) bad. */
function minutes(count: number, badNewest = 0): SloBucket[] {
  const out: SloBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({ startMs: NOW - i * MIN, good: i < badNewest ? 0 : 1, total: 1 });
  }
  return out;
}

/** Hourly buckets for `hours` hours, each 60 events, with `bad` bad events in the newest `badHours`. */
function hours(count: number, badPerHour = 0, badHours = 0): SloBucket[] {
  const out: SloBucket[] = [];
  const top = Math.floor(NOW / HOUR) * HOUR;
  for (let i = count - 1; i >= 0; i--) {
    const bad = i < badHours ? badPerHour : 0;
    out.push({ startMs: top - i * HOUR, good: 60 - bad, total: 60 });
  }
  return out;
}

describe("burn-rate thresholds", () => {
  it("reproduces the SRE workbook's 14.4 / 6 / 1 for a 30-day window", () => {
    const [fast, sustained, slow] = SLO_BURN_POLICIES;
    expect(sloBurnRateThreshold(fast!, 30)).toBeCloseTo(14.4);
    expect(sloBurnRateThreshold(sustained!, 30)).toBeCloseTo(6);
    expect(sloBurnRateThreshold(slow!, 30)).toBeCloseTo(1);
  });

  it("scales with the window so the same share of budget triggers", () => {
    expect(sloBurnRateThreshold(SLO_BURN_POLICIES[0]!, 7)).toBeCloseTo(3.36);
  });
});

describe("budget arithmetic", () => {
  it("is 43.2 minutes for 99.9% over 30 days", () => {
    expect(sloBudgetTotalMinutes(99.9, 30)).toBeCloseTo(43.2);
  });

  it("burn rate is 1 exactly on budget, null with no events", () => {
    expect(sloBurnRate(999, 1000, 99.9)).toBeCloseTo(1);
    expect(sloBurnRate(0, 0, 99.9)).toBeNull();
  });

  it("budget remaining goes negative when overspent", () => {
    expect(sloBudgetRemaining(1000, 1000, 99)).toBe(1);
    expect(sloBudgetRemaining(995, 1000, 99)).toBeCloseTo(0.5);
    expect(sloBudgetRemaining(980, 1000, 99)).toBeCloseTo(-1);
    expect(sloBudgetRemaining(0, 0, 99)).toBeNull();
  });
});

describe("minute classification", () => {
  it("uses the Up average for availability", () => {
    expect(sloMinuteGoodness(availability, 0.5)).toBe(0.5);
    expect(sloMinuteGoodness(availability, 2)).toBe(1);
  });

  it("latency is good at or under the threshold", () => {
    const latency = { ...availability, sliKind: "probe_latency" as const, latencyThresholdMs: 300 };
    expect(sloMinuteGoodness(latency, 300)).toBe(1);
    expect(sloMinuteGoodness(latency, 301)).toBe(0);
  });

  it("metric thresholds honour the comparator", () => {
    const metric: SloSourceFields = {
      ...availability,
      sliKind: "metric_threshold",
      probeId: null,
      resourceId: "r",
      metricKey: "CPU %",
      comparator: "<",
      threshold: 80,
    };
    expect(sloMinuteGoodness(metric, 79)).toBe(1);
    expect(sloMinuteGoodness(metric, 80)).toBe(0);
  });
});

describe("computeSloSnapshot", () => {
  it("reports unknown with no data", () => {
    const snap = computeSloSnapshot({
      minuteBuckets: [],
      hourlyBuckets: [],
      targetPercent: 99.9,
      windowDays: 30,
      nowMs: NOW,
    });
    expect(snap.sli).toBeNull();
    expect(snap.burnAlert).toBe("none");
    expect(deriveSloStatus(snap)).toBe("unknown");
  });

  it("is ok when everything is good", () => {
    const snap = computeSloSnapshot({
      minuteBuckets: minutes(360),
      hourlyBuckets: hours(24 * 30),
      targetPercent: 99.9,
      windowDays: 30,
      nowMs: NOW,
    });
    expect(snap.sli).toBe(1);
    expect(snap.budgetRemaining).toBe(1);
    expect(deriveSloStatus(snap)).toBe("ok");
  });

  it("pages when both the 1h and 5m windows burn hard", () => {
    // Ten bad minutes out of the last hour: 1h burn = (10/60)/0.001 ≫ 14.4.
    const snap = computeSloSnapshot({
      minuteBuckets: minutes(360, 10),
      hourlyBuckets: hours(24 * 30, 10, 1),
      targetPercent: 99.9,
      windowDays: 30,
      nowMs: NOW,
    });
    expect(snap.burnAlert).toBe("fast");
  });

  it("stops paging once the short window is clean even if the long one is not", () => {
    // Bad minutes 35-45 minutes ago: the long windows still burn, both short ones are clean.
    const buckets = minutes(360).map((b) =>
      b.startMs < NOW - 35 * MIN && b.startMs >= NOW - 45 * MIN ? { ...b, good: 0 } : b,
    );
    const snap = computeSloSnapshot({
      minuteBuckets: buckets,
      hourlyBuckets: hours(24 * 30),
      targetPercent: 99.9,
      windowDays: 30,
      nowMs: NOW,
    });
    expect(snap.burnRates["1h"]).toBeGreaterThan(14.4);
    expect(snap.burnRates["5m"]).toBe(0);
    expect(snap.burnAlert).toBe("none");
  });

  it("raises a ticket on a slow, steady burn", () => {
    // 1 bad event per hour on a 99% target: burn = (1/60)/0.01 ≈ 1.67 ≥ 1, < 6.
    const minuteBuckets = minutes(360).map((b, i) => (i % 60 === 0 ? { ...b, good: 0 } : b));
    const snap = computeSloSnapshot({
      minuteBuckets,
      hourlyBuckets: hours(24 * 30, 1, 24 * 30),
      targetPercent: 99,
      windowDays: 30,
      nowMs: NOW,
    });
    expect(snap.burnAlert).toBe("slow");
  });

  it("reports exhausted when the window's budget is spent", () => {
    const snap = computeSloSnapshot({
      minuteBuckets: minutes(360),
      hourlyBuckets: hours(24 * 7, 30, 24 * 7),
      targetPercent: 99.9,
      windowDays: 7,
      nowMs: NOW,
    });
    expect(snap.budgetRemaining).toBeLessThan(0);
    expect(deriveSloStatus(snap)).toBe("exhausted");
  });
});

describe("buildSloHistory", () => {
  it("ends the burndown at the stored budget remaining", () => {
    const buckets = hours(48, 1, 10);
    const { budgetBurndown, dailySli } = buildSloHistory(buckets, 99);
    const good = buckets.reduce((s, b) => s + b.good, 0);
    const total = buckets.reduce((s, b) => s + b.total, 0);
    expect(budgetBurndown.at(-1)!.value / 100).toBeCloseTo(sloBudgetRemaining(good, total, 99)!);
    expect(dailySli.length).toBeGreaterThanOrEqual(2);
  });
});

describe("formatting", () => {
  it("formats budget durations", () => {
    expect(formatBudgetDuration(0.5)).toBe("30s");
    expect(formatBudgetDuration(43.2)).toBe("43m 12s");
    expect(formatBudgetDuration(125)).toBe("2h 5m");
    expect(formatBudgetDuration(-1500)).toBe("1d 1h");
  });

  it("formats burn rates", () => {
    expect(formatBurnRate(14.4)).toBe("14.4×");
    expect(formatBurnRate(0.5)).toBe("0.5×");
    expect(formatBurnRate(Number.POSITIVE_INFINITY)).toBe("∞");
  });
});

describe("validateSloInput", () => {
  const base: SloInput = {
    ...availability,
    name: "API availability",
    description: null,
    targetPercent: 99.9,
    windowDays: 30,
    alertsEnabled: true,
    suggestFreeze: true,
    enabled: true,
  };

  it("accepts a valid probe SLO", () => {
    expect(validateSloInput(base)).toBeNull();
  });

  it("rejects out-of-range targets and windows", () => {
    expect(validateSloInput({ ...base, targetPercent: 100 })).toMatch(/target/);
    expect(validateSloInput({ ...base, windowDays: 14 as never })).toMatch(/window/);
  });

  it("requires the metric fields for a metric SLO", () => {
    expect(
      validateSloInput({ ...base, sliKind: "metric_threshold", probeId: null, resourceId: "r" }),
    ).toMatch(/metric/);
  });

  it("normalizes away fields the kind does not use", () => {
    const n = normalizeSloSource({ ...availability, metricKey: "CPU %", threshold: 3 });
    expect(n.metricKey).toBeNull();
    expect(n.threshold).toBeNull();
    expect(n.probeId).toBe("p1");
  });
});
