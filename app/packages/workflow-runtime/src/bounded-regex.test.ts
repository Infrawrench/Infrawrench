import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * How long the worker takes to get a request, on top of what it really
 * takes: a stand-in for a worker thread starting on a host with every core
 * busy, which no test can order up. Zero leaves the worker alone.
 */
const slow = vi.hoisted(() => ({ startMs: 0 }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends real.Worker {
    override postMessage(...args: Parameters<InstanceType<typeof real.Worker>["postMessage"]>) {
      if (slow.startMs === 0) super.postMessage(...args);
      else setTimeout(() => super.postMessage(...args), slow.startMs);
    }
  }
  return { ...real, default: { ...real, Worker }, Worker };
});

const { RegexTimeoutError, testRegexBounded } = await import("./bounded-regex.js");

// Catastrophic under a backtracking engine, and invisible to a group-shape
// check: no quantified group at all, just adjacent optional atoms. The
// trailing `b` makes it a guaranteed non-match, so the engine has to exhaust
// every split of the ambiguous prefix (minutes on any runner); a matching
// variant finishes in a couple of seconds on a fast CPU and races the deadline.
const EVIL_SOURCE = `${"a?".repeat(60)}${"a".repeat(60)}b`;
const EVIL_INPUT = "a".repeat(60);

describe("testRegexBounded", () => {
  afterEach(() => {
    slow.startMs = 0;
  });

  it("matches each input independently", async () => {
    expect(await testRegexBounded("err(or)?", "i", ["ERROR here", "fine", "err"])).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("ignores the stateful g/y flags", async () => {
    expect(await testRegexBounded("a", "gy", ["a", "a", "a"])).toEqual([true, true, true]);
  });

  it("rejects an uncompilable pattern", async () => {
    await expect(testRegexBounded("[unclosed", "", ["x"])).rejects.toThrow(/Invalid regex/);
  });

  it("stops a catastrophic pattern at the deadline without blocking the caller", async () => {
    // A worker is up before the clock starts: how long one takes to start is
    // not what the bound below is about.
    await testRegexBounded("a", "", ["a"]);
    let ticks = 0;
    const interval = setInterval(() => ticks++, 10);
    const started = Date.now();
    try {
      await expect(
        testRegexBounded(EVIL_SOURCE, "", [EVIL_INPUT], { timeoutMs: 300 }),
      ).rejects.toBeInstanceOf(RegexTimeoutError);
    } finally {
      clearInterval(interval);
    }
    expect(Date.now() - started).toBeLessThan(5000);
    // The event loop kept turning while the worker was stuck.
    expect(ticks).toBeGreaterThan(5);
  });

  it("recovers after a timeout and serializes concurrent calls", async () => {
    const evil = testRegexBounded(EVIL_SOURCE, "", [EVIL_INPUT], { timeoutMs: 200 });
    const after = testRegexBounded("^ok$", "", ["ok", "nope"]);
    await expect(evil).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(await after).toEqual([true, false]);
  });

  it("does not count the worker's start against the pattern", async () => {
    // The worker gets the request three deadlines late. The pattern itself
    // takes microseconds, so it is answered, not blamed.
    slow.startMs = 600;
    expect(await testRegexBounded("^v[0-9]+", "", ["nope", "v2"], { timeoutMs: 200 })).toEqual([
      false,
      true,
    ]);
  });

  it("still stops a catastrophic pattern on a worker that was slow to start", async () => {
    slow.startMs = 300;
    const started = Date.now();
    await expect(
      testRegexBounded(EVIL_SOURCE, "", [EVIL_INPUT], { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(RegexTimeoutError);
    // The deadline ran from when the worker took it, not from the call.
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it("gives up on a worker that never takes the request, without blaming the pattern", async () => {
    slow.startMs = 5_000;
    const hung = testRegexBounded("a", "", ["a"], { startTimeoutMs: 100 });
    await expect(hung).rejects.toThrow("Regex worker did not start within 100 ms");
    await expect(hung).rejects.not.toBeInstanceOf(RegexTimeoutError);
    // And the next call gets a new worker.
    slow.startMs = 0;
    expect(await testRegexBounded("a", "", ["a"])).toEqual([true]);
  });
});
