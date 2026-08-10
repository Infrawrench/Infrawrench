import { describe, expect, it } from "vitest";
import {
  MIN_WINDOW_SAMPLES,
  compareMetric,
  judgeWindow,
  type WindowSample,
} from "../metric-alerts/window";

/**
 * The pure half of metric alert evaluation — no mocks, direct fixtures, the
 * `anomaly-detect.test.ts` stance.
 */

const NOW = Date.parse("2026-08-03T12:00:00Z");
const MINUTE = 60_000;
const WINDOW = 15 * MINUTE;

const OPTS = { comparator: ">" as const, threshold: 90, windowMs: WINDOW, nowMs: NOW };

/** One sample per minute across the whole window, all at `value`. */
function fullWindow(value: number): WindowSample[] {
  return Array.from({ length: 15 }, (_, i) => ({ tsMs: NOW - (14 - i) * MINUTE, value }));
}

describe("compareMetric", () => {
  it("implements all four comparators", () => {
    expect(compareMetric(91, ">", 90)).toBe(true);
    expect(compareMetric(90, ">", 90)).toBe(false);
    expect(compareMetric(90, ">=", 90)).toBe(true);
    expect(compareMetric(89, "<", 90)).toBe(true);
    expect(compareMetric(90, "<", 90)).toBe(false);
    expect(compareMetric(90, "<=", 90)).toBe(true);
  });
});

describe("judgeWindow", () => {
  it("is breaching when every sample across the window clears the threshold", () => {
    const verdict = judgeWindow(fullWindow(95), OPTS);
    expect(verdict).toEqual({ state: "breaching", observed: 95 });
  });

  it("reports the worst sample as observed (max for upper-bound comparators)", () => {
    const samples = fullWindow(95);
    samples[7] = { tsMs: samples[7]!.tsMs, value: 99.5 };
    const verdict = judgeWindow(samples, OPTS);
    expect(verdict).toEqual({ state: "breaching", observed: 99.5 });
  });

  it("reports the min as observed for lower-bound comparators", () => {
    const samples = fullWindow(3);
    samples[2] = { tsMs: samples[2]!.tsMs, value: 0.5 };
    const verdict = judgeWindow(samples, { ...OPTS, comparator: "<", threshold: 5 });
    expect(verdict).toEqual({ state: "breaching", observed: 0.5 });
  });

  it("is cleared the moment any sample inside the window fails the comparator", () => {
    const samples = fullWindow(95);
    samples[10] = { tsMs: samples[10]!.tsMs, value: 42 };
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "cleared" });
  });

  it("ignores samples outside the window entirely", () => {
    const samples = [
      // A non-breaching sample just before the window must not clear it…
      { tsMs: NOW - WINDOW - MINUTE, value: 10 },
      ...fullWindow(95),
      // …and a breaching one after `now` must not count either.
      { tsMs: NOW + MINUTE, value: 200 },
    ];
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "breaching", observed: 95 });
  });

  it("is no_data when the window holds no samples at all", () => {
    expect(judgeWindow([], OPTS)).toEqual({ state: "no_data" });
    expect(judgeWindow([{ tsMs: NOW - WINDOW - MINUTE, value: 95 }], OPTS)).toEqual({
      state: "no_data",
    });
  });

  it("is insufficient with fewer than MIN_WINDOW_SAMPLES breaching samples", () => {
    const samples = fullWindow(95).slice(0, MIN_WINDOW_SAMPLES - 1);
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "insufficient" });
  });

  it("is insufficient when samples cluster at the end of the window", () => {
    // Three breaching samples in the last three minutes: fresh, but nothing
    // says the condition held at the start of the window.
    const samples = [
      { tsMs: NOW - 2 * MINUTE, value: 95 },
      { tsMs: NOW - MINUTE, value: 95 },
      { tsMs: NOW, value: 95 },
    ];
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "insufficient" });
  });

  it("is insufficient when samples cluster at the start of the window (stale)", () => {
    // Breaching at the start but silent since: not evidence it still holds.
    const samples = [
      { tsMs: NOW - 14 * MINUTE, value: 95 },
      { tsMs: NOW - 13 * MINUTE, value: 95 },
      { tsMs: NOW - 12 * MINUTE, value: 95 },
    ];
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "insufficient" });
  });

  it("is breaching with sparse samples that still span the window", () => {
    const samples = [
      { tsMs: NOW - 14 * MINUTE, value: 95 },
      { tsMs: NOW - 7 * MINUTE, value: 95 },
      { tsMs: NOW - MINUTE, value: 95 },
    ];
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "breaching", observed: 95 });
  });

  it("treats a sample exactly on the threshold according to the comparator", () => {
    const samples = fullWindow(90);
    expect(judgeWindow(samples, OPTS)).toEqual({ state: "cleared" });
    expect(judgeWindow(samples, { ...OPTS, comparator: ">=" })).toEqual({
      state: "breaching",
      observed: 90,
    });
  });
});
