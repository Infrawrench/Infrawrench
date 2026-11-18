import { describe, expect, it } from "vitest";
import { createMetricTimeFormatter, createMetricValueFormatter } from "../metric-units";

describe("createMetricValueFormatter", () => {
  it("humanizes bytes into a single scale chosen from the axis max", () => {
    // The reported bug: a droplet memory axis topping out around 8 GiB
    // rendered raw byte counts like "8589934592bytes" in a 50px gutter.
    const maxBytes = 8 * 1024 ** 3;
    const format = createMetricValueFormatter("bytes", maxBytes);
    expect(format(maxBytes)).toBe("8.00 GiB");
    expect(format(4 * 1024 ** 3)).toBe("4.00 GiB");
    expect(format(0)).toBe("0.00 GiB");
  });

  it("keeps every tick in the same unit instead of rescaling per value", () => {
    const format = createMetricValueFormatter("bytes", 3 * 1024 ** 3);
    // A small tick near zero must not fall back to KiB/MiB just because it's
    // small in isolation: the whole axis reads in GiB.
    expect(format(1024)).toBe("0.00 GiB");
    expect(format(1.5 * 1024 ** 3)).toBe("1.50 GiB");
  });

  it("suffixes a rate unit without treating it as a different scale", () => {
    const maxBps = 50 * 1024 * 1024; // 50 MiB/s
    const format = createMetricValueFormatter("bytes/s", maxBps);
    expect(format(maxBps)).toBe("50.0 MiB/s");
    expect(format(0)).toBe("0.00 MiB/s");
  });

  it("picks B for sub-KiB axes", () => {
    const format = createMetricValueFormatter("bytes", 512);
    expect(format(512)).toBe("512 B");
    expect(format(0)).toBe("0 B");
  });

  it("picks TiB/PiB for very large axes", () => {
    const tib = createMetricValueFormatter("bytes", 5 * 1024 ** 4);
    expect(tib(5 * 1024 ** 4)).toBe("5.00 TiB");
    const pib = createMetricValueFormatter("bytes", 2 * 1024 ** 5);
    expect(pib(2 * 1024 ** 5)).toBe("2.00 PiB");
  });

  it("keeps symbol units against the number and spaces word units (#1345)", () => {
    const percent = createMetricValueFormatter("%", 100, "en-US");
    expect(percent(45)).toBe("45%");
    expect(createMetricValueFormatter("/s", 10, "en-US")(3)).toBe("3/s");
    expect(createMetricValueFormatter("°C", 40, "en-US")(21)).toBe("21°C");
    const count = createMetricValueFormatter("connections", 42, "en-US");
    expect(count(42)).toBe("42 connections");
    expect(createMetricValueFormatter("ms", 200, "en-US")(150)).toBe("150 ms");
  });

  it("owns the spacing when a plugin pads its unit itself", () => {
    expect(createMetricValueFormatter(" cores", 8, "en-US")(4)).toBe("4 cores");
  });

  it("switches a large axis to compact notation (#1345)", () => {
    // Ticks read "8000count", "150000tokens/s" and a clipped "10000000tokens".
    const count = createMetricValueFormatter("count", 8000, "en-US");
    expect(count(8000)).toBe("8K count");
    expect(count(0)).toBe("0 count");
    expect(createMetricValueFormatter("tokens/s", 150_000, "en-US")(150_000)).toBe("150K tokens/s");
    const tokens = createMetricValueFormatter("tokens", 10_000_000, "en-US");
    expect(tokens(10_000_000)).toBe("10M tokens");
    expect(tokens(2_500_000)).toBe("2.5M tokens");
  });

  it("rounds a small axis without losing sub-unit readings", () => {
    const seconds = createMetricValueFormatter("s", 2, "en-US");
    expect(seconds(1.23456)).toBe("1.23 s");
    expect(seconds(0.004217)).toBe("0.00422 s");
    expect(createMetricValueFormatter("requests", 999, "en-US")(999)).toBe("999 requests");
  });

  it("handles a missing unit", () => {
    const format = createMetricValueFormatter("", 10, "en-US");
    expect(format(7)).toBe("7");
    expect(createMetricValueFormatter("", 50_000, "en-US")(50_000)).toBe("50K");
  });

  it("treats an all-zero axis as B rather than dividing by a zero-derived scale", () => {
    const format = createMetricValueFormatter("bytes", 0);
    expect(format(0)).toBe("0 B");
  });
});

describe("createMetricTimeFormatter", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const midnight = Date.UTC(2026, 10, 1);

  it("shows times of day for a window under a day", () => {
    const points = Array.from({ length: 12 }, (_, i) => midnight + 9 * HOUR + i * HOUR);
    const format = createMetricTimeFormatter(points, "en-US");
    const tick = format.tick(points[3]!);
    expect(tick).toMatch(/^\d{2}:00$/);
    // The tooltip still says which day.
    expect(format.tooltip(points[3]!)).toContain(tick);
    expect(format.tooltip(points[3]!)).toMatch(/(Oct|Nov) \d+/);
  });

  it("shows dates for daily buckets, read in UTC (#1345)", () => {
    // A 30-day series of daily points used to read "00:00, 00:00, 01:00…".
    const points = Array.from({ length: 30 }, (_, i) => midnight + i * DAY);
    const format = createMetricTimeFormatter(points, "en-US");
    expect(format.tick(points[0]!)).toBe("Nov 1");
    expect(format.tick(points[17]!)).toBe("Nov 18");
    expect(format.tooltip(points[17]!)).toBe("Nov 18, 2026");
  });

  it("shows weekly buckets as dates whatever order they arrive in", () => {
    const points = [midnight + 14 * DAY, midnight, midnight + 7 * DAY];
    expect(createMetricTimeFormatter(points, "en-US").tick(midnight + 7 * DAY)).toBe("Nov 8");
  });

  it("shows date and time for sub-day points over a longer window", () => {
    const points = Array.from({ length: 7 * 24 }, (_, i) => midnight + i * HOUR);
    const format = createMetricTimeFormatter(points, "en-US");
    const tick = format.tick(points[50]!);
    expect(tick).toMatch(/^(Oct|Nov) \d+, \d{2}:00$/);
    expect(format.tooltip(points[50]!)).toBe(tick);
  });

  it("labels every point when there are few", () => {
    const points = Array.from({ length: 8 }, (_, i) => midnight + i * DAY);
    expect(createMetricTimeFormatter(points, "en-US").ticks(8)).toEqual(points);
  });

  it("labels evenly spaced points ending at the newest when there are many", () => {
    const points = Array.from({ length: 30 }, (_, i) => midnight + i * DAY);
    const ticks = createMetricTimeFormatter([...points].reverse(), "en-US").ticks(8);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks[ticks.length - 1]).toBe(points[29]);
    const gaps = new Set(ticks.slice(1).map((t, i) => t - ticks[i]!));
    expect(gaps.size).toBe(1);
  });

  it("copes with a single point and with no points", () => {
    expect(createMetricTimeFormatter([midnight], "en-US").tick(midnight)).toMatch(/^\d{2}:00$/);
    expect(createMetricTimeFormatter([], "en-US").tooltip(midnight)).toMatch(
      /^(Oct|Nov) \d+, \d{2}:00$/,
    );
  });
});
