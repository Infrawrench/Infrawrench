import { describe, expect, it } from "vitest";
import { niceAxis } from "../chart-axis";

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

  it("flattens float drift from cancelling credits onto zero", () => {
    // sum(amount) over a day whose charges and credits cancel returns values
    // like -2.7e-17; that must not buy the axis a tick below zero.
    const { domain, ticks } = niceAxis(-2.7e-17, 2.65);
    expect(domain).toEqual([0, 3]);
    expect(ticks).toEqual([0, 1, 2, 3]);
  });

  it("keeps ticks zero-based for a credit too small to earn one", () => {
    const { domain, ticks } = niceAxis(-0.02, 2.65);
    expect(ticks).toEqual([0, 1, 2, 3]);
    // Snug, not a whole wasted step — but still low enough to draw the dip.
    expect(domain[0]).toBeLessThanOrEqual(-0.02);
    expect(domain[0]).toBeGreaterThan(-0.5);
    expect(domain[1]).toBe(3);
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
