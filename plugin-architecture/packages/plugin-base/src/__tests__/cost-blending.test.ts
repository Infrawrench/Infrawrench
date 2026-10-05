import { describe, expect, it } from "vitest";

import {
  allocateProportionally,
  blendCommitmentPools,
  type BlendMember,
} from "../cost-blending.js";

const sum = (xs: Array<number | undefined>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

describe("allocateProportionally", () => {
  it("splits in proportion and preserves the total", () => {
    const shares = allocateProportionally(100, [1, 1, 2])!;
    expect(shares[0]).toBeCloseTo(25, 12);
    expect(shares[1]).toBeCloseTo(25, 12);
    expect(shares[2]).toBeCloseTo(50, 12);
    expect(sum(shares)).toBe(100);
  });

  it("gives a zero weight nothing and the last positive weight the remainder", () => {
    const shares = allocateProportionally(10, [3, 0, 7, 0])!;
    expect(shares[1]).toBe(0);
    expect(shares[3]).toBe(0);
    expect(sum(shares)).toBe(10);
  });

  it("refuses an undefined split", () => {
    expect(allocateProportionally(10, [])).toBeNull();
    expect(allocateProportionally(10, [0, 0])).toBeNull();
    expect(allocateProportionally(10, [1, -1])).toBeNull();
    expect(allocateProportionally(10, [1, Number.NaN])).toBeNull();
    expect(allocateProportionally(Number.POSITIVE_INFINITY, [1])).toBeNull();
  });

  it("preserves awkward totals across many members", () => {
    const weights = Array.from({ length: 997 }, (_, i) => ((i * 7919) % 101) + 0.13);
    const total = 12345.6789;
    const shares = allocateProportionally(total, weights)!;
    expect(sum(shares)).toBeCloseTo(total, 9);
  });
});

describe("blendCommitmentPools", () => {
  it("gives every member of a pool the same effective rate", () => {
    // On-demand usage worth 100 billed at 100; covered usage worth 100 on demand
    // billed at 40 under a commitment. Pool: 140 effective over 200 on demand.
    const members: BlendMember[] = [
      { pool: "d1", effective: 100, weight: 100 },
      { pool: "d1", effective: 40, weight: 100, covered: true },
    ];
    const blended = blendCommitmentPools(members);
    expect(blended[0]).toBeCloseTo(70, 12);
    expect(blended[1]).toBeCloseTo(70, 12);
    expect(sum(blended)).toBeCloseTo(140, 12);
  });

  it("keeps pools apart and leaves non-members unblended", () => {
    const blended = blendCommitmentPools([
      { pool: "a", effective: 10, weight: 10 },
      { pool: "a", effective: 0, weight: 10, covered: true },
      null,
      { pool: "b", effective: 30, weight: 60, covered: true },
      { pool: "b", effective: 60, weight: 60 },
    ]);
    expect(blended[0]).toBeCloseTo(5, 12);
    expect(blended[1]).toBeCloseTo(5, 12);
    expect(blended[2]).toBeUndefined();
    expect(blended[3]).toBeCloseTo(45, 12);
    expect(blended[4]).toBeCloseTo(45, 12);
  });

  it("skips a pool with no covered member, an unknown weight, or a negative amount", () => {
    expect(
      blendCommitmentPools([
        { pool: "a", effective: 10, weight: 10 },
        { pool: "a", effective: 20, weight: 20 },
      ]),
    ).toEqual([undefined, undefined]);
    expect(
      blendCommitmentPools([
        { pool: "a", effective: 10, weight: null },
        { pool: "a", effective: 20, weight: 40, covered: true },
      ]),
    ).toEqual([undefined, undefined]);
    expect(
      blendCommitmentPools([
        { pool: "a", effective: -5, weight: 10 },
        { pool: "a", effective: 20, weight: 40, covered: true },
      ]),
    ).toEqual([undefined, undefined]);
  });

  it("moves a discount line's money into usage (weight zero)", () => {
    const blended = blendCommitmentPools([
      { pool: "a", effective: 50, weight: 50 },
      { pool: "a", effective: 25, weight: 50, covered: true },
      { pool: "a", effective: 5, weight: 0 },
    ]);
    expect(blended[2]).toBe(0);
    expect(sum(blended)).toBeCloseTo(80, 12);
  });

  it("preserves every pool's total over generated inputs", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial++) {
      const members: BlendMember[] = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => {
        const weight = rand() * 500;
        return {
          pool: `p${Math.floor(rand() * 4)}`,
          weight,
          effective: weight * (0.3 + rand() * 0.7),
          covered: rand() < 0.4,
        };
      });
      const blended = blendCommitmentPools(members);
      const totals = new Map<string, { amortized: number; blended: number }>();
      members.forEach((m, i) => {
        const t = totals.get(m.pool) ?? { amortized: 0, blended: 0 };
        t.amortized += m.effective;
        t.blended += blended[i] ?? m.effective;
        totals.set(m.pool, t);
      });
      for (const t of totals.values()) expect(t.blended).toBeCloseTo(t.amortized, 9);
    }
  });
});
