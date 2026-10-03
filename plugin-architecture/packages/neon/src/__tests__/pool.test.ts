import { describe, expect, it } from "vitest";
import { flatMapPooled } from "../pool.js";

describe("flatMapPooled", () => {
  it("keeps input order regardless of completion order", async () => {
    const out = await flatMapPooled([30, 10, 20], async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return [ms, ms + 1];
    });
    expect(out).toEqual([30, 31, 10, 11, 20, 21]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await flatMapPooled(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return [];
      },
      3,
    );
    expect(peak).toBe(3);
  });

  it("skips items whose call throws", async () => {
    const out = await flatMapPooled([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("404");
      return [n];
    });
    expect(out).toEqual([1, 3]);
  });
});
