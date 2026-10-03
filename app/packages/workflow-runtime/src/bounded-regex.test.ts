import { describe, expect, it } from "vitest";

import { RegexTimeoutError, testRegexBounded } from "./bounded-regex.js";

// Exponential under a backtracking engine, and invisible to a group-shape
// check: no quantified group at all, just adjacent optional atoms.
const EVIL_SOURCE = `${"a?".repeat(40)}${"a".repeat(40)}`;
const EVIL_INPUT = "a".repeat(40);

describe("testRegexBounded", () => {
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
});
