import { describe, expect, it } from "vitest";
import { mapLimit } from "../pool.js";

describe("mapLimit", () => {
  it("keeps order and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (ms) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return ms * 2;
    });
    expect(out).toEqual([10, 2, 8, 4, 6, 0]);
    expect(peak).toBe(2);
  });

  it("handles nothing to do", async () => {
    await expect(mapLimit([], 3, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});
