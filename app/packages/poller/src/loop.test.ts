import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- DB query-builder mock: db.select()...limit() resolves to rows ---
const limit = vi.fn();
const orderBy = vi.fn(() => ({ limit }));
const where = vi.fn(() => ({ orderBy }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock("@infrawrench/server-core/db/client", () => ({
  db: { select: (...a: unknown[]) => select(...a) },
}));

vi.mock("@infrawrench/server-core/db/schema", () => ({
  accounts: {
    id: "id",
    organizationId: "organizationId",
    pluginId: "pluginId",
    displayName: "displayName",
    pollFailureCount: "pollFailureCount",
    deletedAt: "deletedAt",
    nextPollAt: "nextPollAt",
    lastPolledAt: "lastPolledAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  asc: (a: unknown) => ({ asc: a }),
  isNull: (a: unknown) => ({ isNull: a }),
  lte: (a: unknown, b: unknown) => ({ lte: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }),
  sql: (strings: TemplateStringsArray, ...v: unknown[]) => ({ sql: [strings, v] }),
}));

const pollAccount = vi.fn();
vi.mock("./poll-account", () => ({
  pollAccount: (...a: unknown[]) => pollAccount(...a),
}));

import { PollerLoop } from "./loop";

function row(id: string) {
  return {
    id,
    organizationId: "org",
    pluginId: "aws",
    displayName: id,
    pollFailureCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  limit.mockResolvedValue([]);
  pollAccount.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PollerLoop", () => {
  it("does nothing on a tick when no rows are due", async () => {
    limit.mockResolvedValue([]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).not.toHaveBeenCalled();
    await loop.stop();
  });

  it("polls each due account on the first immediate tick", async () => {
    limit.mockResolvedValue([row("a"), row("b")]);
    const loop = new PollerLoop({ concurrency: 8 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("passes the shared bucket registry to pollAccount", async () => {
    limit.mockResolvedValue([row("a")]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      expect.anything(),
    );
    // same registry reused across ticks
    const firstReg = pollAccount.mock.calls[0]![1];
    await vi.advanceTimersByTimeAsync(15_000);
    const secondReg = pollAccount.mock.calls[pollAccount.mock.calls.length - 1]![1];
    expect(secondReg).toBe(firstReg);
    await loop.stop();
  });

  it("uses the configured limit (concurrency) when querying", async () => {
    limit.mockResolvedValue([]);
    const loop = new PollerLoop({ concurrency: 3 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(limit).toHaveBeenCalledWith(3);
    await loop.stop();
  });

  it("schedules subsequent ticks on the configured interval", async () => {
    limit.mockResolvedValue([row("a")]);
    const loop = new PollerLoop({ tickMs: 5_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0); // first immediate tick
    expect(pollAccount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); // second tick
    expect(pollAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000); // third tick
    expect(pollAccount).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it("swallows a failing pollAccount so other accounts still run", async () => {
    limit.mockResolvedValue([row("a"), row("b")]);
    pollAccount.mockRejectedValueOnce(new Error("nope"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    await loop.stop();
  });

  it("logs and recovers when the DB query throws during a tick", async () => {
    limit.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errSpy).toHaveBeenCalledWith("[poller] tick failed:", expect.any(Error));
    // next tick still works
    limit.mockResolvedValue([row("a")]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    await loop.stop();
  });

  it("start() is idempotent (does not double-schedule)", async () => {
    limit.mockResolvedValue([row("a")]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    // second start before any timer is set still returns early once timer exists
    await vi.advanceTimersByTimeAsync(15_000);
    const callsAfterTwoTicks = pollAccount.mock.calls.length;
    loop.start(); // timer already set -> no-op
    await vi.advanceTimersByTimeAsync(15_000);
    // only one additional tick worth of polls
    expect(pollAccount.mock.calls.length).toBe(callsAfterTwoTicks + 1);
    await loop.stop();
  });

  it("stop() clears the timer and prevents further ticks", async () => {
    limit.mockResolvedValue([row("a")]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollAccount).toHaveBeenCalledTimes(1);
  });

  it("stop() waits for an in-flight tick to drain", async () => {
    let resolvePoll: () => void = () => {};
    limit.mockResolvedValue([row("a")]);
    pollAccount.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolvePoll = r;
        }),
    );
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0); // tick begins, pollAccount pending
    const stopPromise = loop.stop();
    // drain loop polls every 100ms; resolve the in-flight poll then let it settle
    resolvePoll();
    await vi.advanceTimersByTimeAsync(200);
    await stopPromise;
    expect(pollAccount).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping ticks when one is still running", async () => {
    let resolvePoll: () => void = () => {};
    limit.mockResolvedValue([row("a")]);
    pollAccount.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolvePoll = r;
        }),
    );
    const loop = new PollerLoop({ tickMs: 1_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0); // first tick running, blocked on pollAccount
    // even though we advance, the running guard prevents a second concurrent tick
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    resolvePoll();
    await vi.advanceTimersByTimeAsync(0); // let the in-flight tick settle
    const stopPromise = loop.stop();
    await vi.advanceTimersByTimeAsync(200); // drain loop
    await stopPromise;
  });
});
