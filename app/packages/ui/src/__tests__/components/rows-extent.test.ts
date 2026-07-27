import { describe, expect, it } from "vitest";
import { rowsExtent } from "../../components/charts/nice-axis.js";

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
