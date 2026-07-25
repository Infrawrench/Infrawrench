import { describe, expect, it } from "vitest";
import { niceAxis, rowsExtent } from "../../components/charts/nice-axis.js";

describe("niceAxis", () => {
  it("keeps an all-positive series on a zero baseline", () => {
    // The reported bug: recharts rendered -0.90 … 2.70 for a US$2.65 max.
    const { domain, ticks } = niceAxis(0, 2.65);
    expect(domain).toEqual([0, 3]);
    expect(ticks).toEqual([0, 1, 2, 3]);
  });

  it("never clips the data", () => {
    for (const max of [0.004, 0.37, 7, 42, 99.5, 1234, 987654]) {
      const { domain, ticks } = niceAxis(0, max);
      expect(domain[0]).toBe(0);
      expect(domain[1]).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(domain[1]);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(7);
    }
  });

  it("produces evenly spaced ticks free of float drift", () => {
    const { ticks } = niceAxis(0, 0.9);
    expect(ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("extends below zero only when the data does (credits, refunds)", () => {
    const { domain, ticks } = niceAxis(-3, 8);
    expect(domain[0]).toBeLessThanOrEqual(-3);
    expect(domain[1]).toBeGreaterThanOrEqual(8);
    expect(ticks).toContain(0);
  });

  it("gives all-negative data a zero top", () => {
    const { domain } = niceAxis(-5, 0);
    expect(domain[0]).toBeLessThanOrEqual(-5);
    expect(domain[1]).toBe(0);
  });

  it("falls back to 0 … 1 for empty or all-zero data", () => {
    expect(niceAxis(0, 0)).toEqual({ domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceAxis(Number.NaN, Number.NaN).domain).toEqual([0, 1]);
  });
});

describe("rowsExtent", () => {
  const rows = [
    { bucket: "2026-07-01", s0: 1, s1: 2, __previous__: 9 },
    { bucket: "2026-07-02", s0: 4, s1: null, __previous__: null },
  ];

  it("sums stacked keys per row", () => {
    expect(rowsExtent(rows, { stackedKeys: ["s0", "s1"] })).toEqual({ min: 0, max: 4 });
  });

  it("takes the per-key max when series are not stacked", () => {
    expect(rowsExtent(rows, { keys: ["s0", "s1"] })).toEqual({ min: 0, max: 4 });
  });

  it("includes overlay lines like the previous-period comparison", () => {
    expect(rowsExtent(rows, { stackedKeys: ["s0", "s1"], keys: ["__previous__"] })).toEqual({
      min: 0,
      max: 9,
    });
  });

  it("stacks positives and negatives separately", () => {
    const mixed = [{ a: 5, b: -2, c: -3 }];
    expect(rowsExtent(mixed, { stackedKeys: ["a", "b", "c"] })).toEqual({ min: -5, max: 5 });
  });

  it("skips nulls, strings and non-finite values", () => {
    const messy = [{ a: null, b: "x", c: Number.NaN, d: Number.POSITIVE_INFINITY }];
    expect(rowsExtent(messy, { keys: ["a", "b", "c", "d"] })).toEqual({ min: 0, max: 0 });
  });

  it("returns a zero extent for no rows", () => {
    expect(rowsExtent([], { keys: ["a"] })).toEqual({ min: 0, max: 0 });
  });
});
