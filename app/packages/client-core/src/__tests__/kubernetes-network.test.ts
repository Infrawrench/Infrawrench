import { describe, expect, it } from "vitest";

import { apportionBilledDay } from "../network-flows";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("apportionBilledDay", () => {
  it("hands out list estimates when billed exceeds them, keeping the rest unallocated", () => {
    const out = apportionBilledDay(
      [
        { bytes: 100, estimatedCost: 3 },
        { bytes: 50, estimatedCost: 1 },
      ],
      10,
    );
    expect(out.allocated).toEqual([3, 1]);
    expect(out.unallocated).toBe(6);
    expect(out).toMatchObject({ basis: "cost", scaled: false });
  });

  it("scales every row by the same factor when billed is below the estimate", () => {
    const out = apportionBilledDay(
      [
        { bytes: 100, estimatedCost: 3 },
        { bytes: 50, estimatedCost: 1 },
        { bytes: 999, estimatedCost: 0 },
      ],
      2,
    );
    expect(out.allocated).toEqual([1.5, 0.5, 0]);
    expect(out.unallocated).toBe(0);
    expect(out.scaled).toBe(true);
  });

  it("never hands out more than was billed, whatever the rows say", () => {
    for (const billed of [0, 0.01, 1, 5, 1e6]) {
      const out = apportionBilledDay(
        [
          { bytes: 1, estimatedCost: 2.5 },
          { bytes: 3, estimatedCost: 7.25 },
        ],
        billed,
      );
      expect(sum(out.allocated)).toBeLessThanOrEqual(billed + 1e-9);
      expect(sum(out.allocated) + out.unallocated).toBeCloseTo(billed, 9);
    }
  });

  it("falls back to bytes, labelled, when nothing could be priced", () => {
    const out = apportionBilledDay(
      [
        { bytes: 300, estimatedCost: 0 },
        { bytes: 100, estimatedCost: 0 },
      ],
      8,
    );
    expect(out.allocated).toEqual([6, 2]);
    expect(out.basis).toBe("bytes");
  });

  it("allocates nothing and keeps the bill whole when there is no traffic", () => {
    const out = apportionBilledDay([], 4);
    expect(out).toMatchObject({ allocated: [], unallocated: 4, basis: "none" });
  });
});
