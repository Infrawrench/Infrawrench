import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A registry of two periodic passes: one on the shared tick, one on a loop
// of its own, as the CI status pass is.
const slow = vi.fn<() => Promise<void>>();
const own = vi.fn<() => Promise<void>>();
vi.mock("./passes", () => ({
  passesFor: () => [
    { kind: "periodic", name: "slow", runtime: "edge", run: () => slow() },
    { kind: "periodic", name: "own", runtime: "edge", ownLoopMs: 1_000, run: () => own() },
  ],
}));

const { PollerLoop } = await import("./loop");

describe("a pass on a loop of its own", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    slow.mockReset();
    own.mockReset();
    own.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("is not run by the shared tick", async () => {
    slow.mockResolvedValue(undefined);
    const loop = new PollerLoop({ tickMs: 15_000 });
    await loop.tick();
    expect(slow).toHaveBeenCalledTimes(1);
    expect(own).not.toHaveBeenCalled();
    expect(loop.ownLoops.map((l) => l.cadenceMs)).toEqual([1_000]);
  });

  it("keeps running while the shared tick is stuck, and stops with it", async () => {
    // The shared tick never settles: a cost poll that takes minutes.
    let release!: () => void;
    slow.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const loop = new PollerLoop({ tickMs: 15_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(slow).toHaveBeenCalledTimes(1);
    // Once at start, then every second after the last settled.
    expect(own.mock.calls.length).toBeGreaterThanOrEqual(5);

    release();
    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(200);
    await stopped;
    const calls = own.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(own.mock.calls.length).toBe(calls);
  });
});
