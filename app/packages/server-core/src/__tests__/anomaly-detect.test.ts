import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANOMALY_OPTIONS,
  detectNewSpendSource,
  detectSpike,
  fillDailySeries,
  optionsForCurrency,
} from "../cost/anomaly-detect";
import { addDays, daysBetween } from "../cost/dates";

const OPTS = { sigmas: 3, minDeltaAbs: 10, minBaselineDays: 7, minNewSourceAbs: 25 };

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
    expect(DEFAULT_ANOMALY_OPTIONS.minNewSourceAbs).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- *
   * Per-org tuning — the thresholds are parameters, not constants.
   * ---------------------------------------------------------------- */

  // mean 100, stddev 10 — so 2σ is 120 and 3σ is 130, far enough apart to
  // show a sigma change moving the bar rather than the floor doing the work.
  const VOLATILE = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110];

  it("catches a smaller spike at a lower sigma setting", () => {
    expect(detectSpike(VOLATILE, 125, OPTS)).toBeNull();
    expect(detectSpike(VOLATILE, 125, { ...OPTS, sigmas: 2 })).not.toBeNull();
  });

  it("ignores a spike a higher sigma setting no longer considers unusual", () => {
    expect(detectSpike(VOLATILE, 135, OPTS)).not.toBeNull();
    expect(detectSpike(VOLATILE, 135, { ...OPTS, sigmas: 10 })).toBeNull();
  });

  it("respects a raised absolute floor even when the sigma bar is cleared", () => {
    const flat = new Array(10).fill(50);
    // +25 over a flat baseline: many sigmas out (stddev 0) and over the $10
    // floor, but under a $50 one.
    expect(detectSpike(flat, 75, OPTS)).not.toBeNull();
    expect(detectSpike(flat, 75, { ...OPTS, minDeltaAbs: 50 })).toBeNull();
  });

  it("lets a lowered floor through what the default floor filtered", () => {
    const pennies = new Array(10).fill(0.5);
    expect(detectSpike(pennies, 3, OPTS)).toBeNull();
    expect(detectSpike(pennies, 3, { ...OPTS, minDeltaAbs: 1 })).not.toBeNull();
  });

  it("honours a relaxed baseline-day minimum", () => {
    const sparse = [0, 0, 0, 0, 0, 20, 22, 21];
    expect(detectSpike(sparse, 500, OPTS)).toBeNull();
    expect(detectSpike(sparse, 500, { ...OPTS, minBaselineDays: 3 })).not.toBeNull();
  });
});

describe("detectNewSpendSource", () => {
  const EMPTY_WINDOW = new Array(28).fill(0);
  /** Coverage of an org that has been collecting for months. */
  const ESTABLISHED = 180;

  it("flags a key that goes from nothing to real money", () => {
    const found = detectNewSpendSource(EMPTY_WINDOW, 5000, ESTABLISHED, OPTS);
    expect(found).not.toBeNull();
    expect(found!.actual).toBe(5000);
    expect(found!.baselineTotal).toBe(0);
    expect(found!.mean).toBe(0);
    expect(found!.threshold).toBe(OPTS.minNewSourceAbs);
  });

  it("catches exactly what the sigma detector cannot", () => {
    // The whole point: an all-zero baseline has no mean or deviation to
    // exceed, and the observed-days guard silences it besides.
    expect(detectSpike(EMPTY_WINDOW, 5000, OPTS)).toBeNull();
    expect(detectNewSpendSource(EMPTY_WINDOW, 5000, ESTABLISHED, OPTS)).not.toBeNull();
  });

  it("stays quiet below the new-source floor", () => {
    expect(detectNewSpendSource(EMPTY_WINDOW, 0.02, ESTABLISHED, OPTS)).toBeNull();
    expect(
      detectNewSpendSource(EMPTY_WINDOW, OPTS.minNewSourceAbs - 0.01, ESTABLISHED, OPTS),
    ).toBeNull();
    expect(
      detectNewSpendSource(EMPTY_WINDOW, OPTS.minNewSourceAbs, ESTABLISHED, OPTS),
    ).not.toBeNull();
  });

  it("tolerates rounding dust in the baseline", () => {
    // $0.30 of trial usage across a month is not a baseline.
    const dust = EMPTY_WINDOW.slice();
    dust[3] = 0.1;
    dust[9] = 0.2;
    expect(detectNewSpendSource(dust, 5000, ESTABLISHED, OPTS)).not.toBeNull();
  });

  it("does not call an established key new", () => {
    const established = new Array(28).fill(40);
    expect(detectNewSpendSource(established, 5000, ESTABLISHED, OPTS)).toBeNull();
  });

  it("honours a per-org new-source floor", () => {
    expect(detectNewSpendSource(EMPTY_WINDOW, 100, ESTABLISHED, OPTS)).not.toBeNull();
    expect(
      detectNewSpendSource(EMPTY_WINDOW, 100, ESTABLISHED, { ...OPTS, minNewSourceAbs: 500 }),
    ).toBeNull();
  });

  it("scales the floor with the series currency", () => {
    const yen = optionsForCurrency("JPY", OPTS);
    // ¥1,000 is ~$7 — a new source, but not a material one.
    expect(detectNewSpendSource(new Array(28).fill(0), 1000, ESTABLISHED, yen)).toBeNull();
    // ¥500,000 is ~$3,300.
    expect(detectNewSpendSource(new Array(28).fill(0), 500_000, ESTABLISHED, yen)).not.toBeNull();
  });

  it("never fires alongside a spike for the same day", () => {
    // Any baseline big enough for detectSpike to judge is far too big to read
    // as "no prior spend", so the two can't both return evidence.
    for (const actual of [50, 200, 5000]) {
      const both =
        detectSpike(STABLE, actual, OPTS) !== null &&
        detectNewSpendSource(STABLE, actual, ESTABLISHED, OPTS) !== null;
      expect(both).toBe(false);
    }
  });

  /* ---------------------------------------------------------------- *
   * Collection coverage — the guard that keeps day one quiet.
   *
   * Coverage is a fact about the org, passed in, because the baseline
   * cannot carry it: the caller zero-fills to a fixed width, so "we
   * collected and the key spent nothing" and "we hold no data" arrive
   * as the same 0.
   * ---------------------------------------------------------------- */

  it("refuses to judge an org with too little collection coverage", () => {
    // A dense, full-width window — exactly what `detectForDimension` builds —
    // for an org that started collecting two days ago. A `baseline.length`
    // guard sees 28 here and passes; only the coverage fact catches it.
    expect(EMPTY_WINDOW).toHaveLength(28);
    expect(detectNewSpendSource(EMPTY_WINDOW, 5000, 2, OPTS)).toBeNull();
    expect(detectNewSpendSource(EMPTY_WINDOW, 5000, 0, OPTS)).toBeNull();
  });

  it("fires at exactly minBaselineDays of coverage and not below", () => {
    expect(detectNewSpendSource(EMPTY_WINDOW, 5000, OPTS.minBaselineDays - 1, OPTS)).toBeNull();
    expect(detectNewSpendSource(EMPTY_WINDOW, 5000, OPTS.minBaselineDays, OPTS)).not.toBeNull();
  });

  it("honours a relaxed per-org baseline-day minimum", () => {
    expect(detectNewSpendSource(EMPTY_WINDOW, 5000, 3, OPTS)).toBeNull();
    expect(
      detectNewSpendSource(EMPTY_WINDOW, 5000, 3, { ...OPTS, minBaselineDays: 3 }),
    ).not.toBeNull();
  });

  it("returns null for an empty baseline whatever the coverage", () => {
    expect(detectNewSpendSource([], 5000, ESTABLISHED, OPTS)).toBeNull();
  });

  it("silences a young org's whole key set, however many keys it has", () => {
    // The day-one storm, in miniature: every key of a two-day-old org has an
    // all-zero 28-day window and material spend today.
    const day = "2026-07-14";
    const firstCollectedDay = "2026-07-13";
    const coverageDays = daysBetween(firstCollectedDay, day);
    for (const amount of [60, 900, 4000]) {
      const byDay = new Map([[day, amount]]);
      const baseline = fillDailySeries(byDay, addDays(day, -28), addDays(day, -1));
      expect(baseline).toHaveLength(28);
      expect(detectNewSpendSource(baseline, amount, coverageDays, OPTS)).toBeNull();
    }
  });

  it("still fires for a key born yesterday inside an established org", () => {
    // The same construction, the same all-zero per-key history — only the
    // org's coverage differs, and that is the entire distinction.
    const day = "2026-07-14";
    const coverageDays = daysBetween("2026-01-01", day);
    const byDay = new Map([[day, 5000]]);
    const baseline = fillDailySeries(byDay, addDays(day, -28), addDays(day, -1));
    expect(baseline).toEqual(new Array(28).fill(0));
    expect(detectNewSpendSource(baseline, 5000, coverageDays, OPTS)).not.toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts whole UTC days across a month boundary", () => {
    expect(daysBetween("2026-06-30", "2026-07-07")).toBe(7);
    expect(daysBetween("2026-07-14", "2026-07-14")).toBe(0);
  });

  it("goes negative when the range runs backwards", () => {
    expect(daysBetween("2026-07-14", "2026-07-12")).toBe(-2);
  });

  it("is unaffected by daylight saving — the inputs are UTC days", () => {
    // Europe/London springs forward on 2026-03-29.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("fails closed on malformed input", () => {
    expect(daysBetween("not-a-date", "2026-07-01")).toBe(0);
    expect(daysBetween("2026-07-01", "")).toBe(0);
    expect(daysBetween("2026-7-1", "2026-07-08")).toBe(0);
    expect(daysBetween("2026-07-01T00:00:00Z", "2026-07-08")).toBe(0);
  });

  it("fails closed on a day that does not exist, rather than rolling it over", () => {
    // `new Date("2024-02-30T00:00:00Z")` is February 30th rolled to March 1st,
    // not an Invalid Date — so a NaN check alone would accept it and report a
    // day *more* coverage than reality, which fails open.
    expect(daysBetween("2024-02-30", "2024-03-08")).toBe(0);
    expect(daysBetween("2026-02-29", "2026-03-08")).toBe(0);
    expect(daysBetween("2024-13-01", "2024-13-08")).toBe(0);
    expect(daysBetween("2026-04-31", "2026-05-08")).toBe(0);
    // A real leap day still counts.
    expect(daysBetween("2024-02-29", "2024-03-07")).toBe(7);
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
