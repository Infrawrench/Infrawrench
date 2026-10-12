import { describe, expect, it } from "vitest";
import { runTicksInWindow } from "./lambda-window";

/** A fake clock: `sleep` and each tick advance it instead of waiting. */
function clock(tickCostMs: number) {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    tick: async () => {
      now += tickCostMs;
    },
    sleeps,
  };
}

describe("runTicksInWindow", () => {
  it("ticks on the loop's cadence for the window", async () => {
    const c = clock(0);
    const ticks = await runTicksInWindow(c.tick, {
      tickMs: 15_000,
      windowMs: 55_000,
      now: c.now,
      sleep: c.sleep,
    });
    // 0, 15, 30, 45: a fifth at 60 would start past the window.
    expect(ticks).toBe(4);
    expect(c.sleeps).toEqual([15_000, 15_000, 15_000]);
  });

  it("schedules the next tick after the previous one settles", async () => {
    const c = clock(20_000);
    const ticks = await runTicksInWindow(c.tick, {
      tickMs: 15_000,
      windowMs: 55_000,
      now: c.now,
      sleep: c.sleep,
    });
    // 0-20, sleep to 35, 35-55: the next would start at 70.
    expect(ticks).toBe(2);
  });

  it("always runs at least one tick, even with no window", async () => {
    const c = clock(0);
    expect(
      await runTicksInWindow(c.tick, { tickMs: 15_000, windowMs: 0, now: c.now, sleep: c.sleep }),
    ).toBe(1);
  });
});
