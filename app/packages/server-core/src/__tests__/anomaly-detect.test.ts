import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANOMALY_OPTIONS,
  detectSpike,
  fillDailySeries,
  optionsForCurrency,
} from "../cost/anomaly-detect";

const OPTS = { sigmas: 3, minDeltaAbs: 10, minBaselineDays: 7 };

/** A noisy-but-stable baseline around 100/day. */
const STABLE = [98, 102, 100, 97, 103, 99, 101, 100, 96, 104, 100, 99, 101, 100];

describe("detectSpike", () => {
  it("flags a clear spike over a stable baseline", () => {
    const spike = detectSpike(STABLE, 180, OPTS);
    expect(spike).not.toBeNull();
    expect(spike!.actual).toBe(180);
    expect(spike!.mean).toBeCloseTo(100, 0);
    expect(spike!.delta).toBeGreaterThanOrEqual(OPTS.minDeltaAbs);
    expect(spike!.threshold).toBeLessThan(180);
  });

  it("stays quiet on ordinary variation", () => {
    expect(detectSpike(STABLE, 105, OPTS)).toBeNull();
  });

  it("stays quiet on a dip — only spikes alert", () => {
    expect(detectSpike(STABLE, 10, OPTS)).toBeNull();
  });

  it("applies the absolute floor to penny-scale spend", () => {
    // 0.02 against a 0.001 baseline is many sigmas out but below minDeltaAbs.
    const pennies = [0.001, 0.001, 0.002, 0.001, 0.001, 0.001, 0.002, 0.001];
    expect(detectSpike(pennies, 0.02, OPTS)).toBeNull();
  });

  it("detects a jump over a perfectly flat baseline (stddev 0)", () => {
    const flat = [50, 50, 50, 50, 50, 50, 50, 50];
    const spike = detectSpike(flat, 75, OPTS);
    expect(spike).not.toBeNull();
    expect(spike!.stddev).toBe(0);
    expect(spike!.delta).toBe(25);
  });

  it("does not flag a flat baseline continuing flat", () => {
    const flat = [50, 50, 50, 50, 50, 50, 50, 50];
    expect(detectSpike(flat, 50, OPTS)).toBeNull();
  });

  it("skips keys with too few observed days", () => {
    // Only 3 nonzero days — below minBaselineDays, however big the jump.
    const sparse = [0, 0, 0, 0, 0, 20, 22, 21];
    expect(detectSpike(sparse, 500, OPTS)).toBeNull();
  });

  it("skips an all-zero baseline (brand-new key)", () => {
    expect(detectSpike([0, 0, 0, 0, 0, 0, 0, 0], 500, OPTS)).toBeNull();
  });

  it("returns null for an empty baseline", () => {
    expect(detectSpike([], 500, OPTS)).toBeNull();
  });

  it("requires both the sigma bar and the absolute floor", () => {
    // Noisy baseline: a +12 delta clears minDeltaAbs but not mean + 3σ.
    const noisy = [80, 120, 90, 110, 85, 115, 95, 105, 100, 100];
    expect(detectSpike(noisy, 112, OPTS)).toBeNull();
  });

  it("ships sane defaults", () => {
    expect(DEFAULT_ANOMALY_OPTIONS.sigmas).toBeGreaterThan(0);
    expect(DEFAULT_ANOMALY_OPTIONS.minDeltaAbs).toBeGreaterThan(0);
    expect(DEFAULT_ANOMALY_OPTIONS.minBaselineDays).toBeGreaterThan(0);
  });
});

describe("fillDailySeries", () => {
  it("zero-fills missing days across the range, oldest first", () => {
    const byDay = new Map([
      ["2026-07-01", 5],
      ["2026-07-03", 7],
    ]);
    expect(fillDailySeries(byDay, "2026-07-01", "2026-07-04")).toEqual([5, 0, 7, 0]);
  });

  it("handles a single-day range", () => {
    expect(fillDailySeries(new Map([["2026-07-01", 3]]), "2026-07-01", "2026-07-01")).toEqual([3]);
  });

  it("crosses month boundaries", () => {
    const byDay = new Map([["2026-08-01", 2]]);
    expect(fillDailySeries(byDay, "2026-07-30", "2026-08-01")).toEqual([0, 0, 2]);
  });

  it("returns empty for malformed dates", () => {
    expect(fillDailySeries(new Map(), "not-a-date", "2026-07-01")).toEqual([]);
  });
});

describe("optionsForCurrency", () => {
  it("leaves a USD-scale currency untouched", () => {
    expect(optionsForCurrency("USD", OPTS)).toEqual(OPTS);
    expect(optionsForCurrency("EUR", OPTS).minDeltaAbs).toBe(10);
  });

  it("scales the noise floor for small-unit currencies", () => {
    // ~$10 of yen, not 10 yen (~$0.07) — otherwise the floor filters nothing.
    expect(optionsForCurrency("JPY", OPTS).minDeltaAbs).toBeGreaterThan(1000);
    expect(optionsForCurrency("IDR", OPTS).minDeltaAbs).toBeGreaterThan(100_000);
  });

  it("is case-insensitive and falls back to USD scale", () => {
    expect(optionsForCurrency("jpy", OPTS).minDeltaAbs).toBe(
      optionsForCurrency("JPY", OPTS).minDeltaAbs,
    );
    expect(optionsForCurrency("ZZZ", OPTS).minDeltaAbs).toBe(OPTS.minDeltaAbs);
  });

  it("carries the dimensionless options through unchanged", () => {
    const scoped = optionsForCurrency("JPY", OPTS);
    expect(scoped.sigmas).toBe(OPTS.sigmas);
    expect(scoped.minBaselineDays).toBe(OPTS.minBaselineDays);
  });

  it("keeps a genuine JPY spike detectable while filtering yen-scale noise", () => {
    const yenBaseline = STABLE.map((v) => v * 150);
    const opts = optionsForCurrency("JPY", OPTS);
    // A ¥12,000 rise is ~$80 — a real spike.
    expect(detectSpike(yenBaseline, 27_000, opts)).not.toBeNull();
    // A ¥20 rise over a ¥15,000 baseline is pennies; the unscaled floor of
    // 10 units would have let this through on sigmas alone.
    const flatYen = new Array(14).fill(15_000);
    expect(detectSpike(flatYen, 15_020, opts)).toBeNull();
  });
});
