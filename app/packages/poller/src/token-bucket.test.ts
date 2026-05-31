import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketRegistry, defaultBucketConfig } from "./token-bucket";

describe("defaultBucketConfig", () => {
  it("exposes the documented defaults", () => {
    expect(defaultBucketConfig).toEqual({ capacity: 60, refillPerSecond: 1 });
  });
});

describe("TokenBucketRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows consuming up to capacity then blocks", () => {
    const reg = new TokenBucketRegistry();
    const cfg = { capacity: 3, refillPerSecond: 1 };
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    // bucket now empty
    expect(reg.tryTake("p", "a", cfg)).toBe(false);
  });

  it("uses the default config when none is supplied", () => {
    const reg = new TokenBucketRegistry();
    // default capacity is 60, so 60 takes should succeed
    for (let i = 0; i < 60; i++) {
      expect(reg.tryTake("p", "a")).toBe(true);
    }
    expect(reg.tryTake("p", "a")).toBe(false);
  });

  it("keeps separate buckets per plugin/account key", () => {
    const reg = new TokenBucketRegistry();
    const cfg = { capacity: 1, refillPerSecond: 1 };
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(false);
    // different account still has a full bucket
    expect(reg.tryTake("p", "b", cfg)).toBe(true);
    // different plugin, same account id, separate bucket
    expect(reg.tryTake("q", "a", cfg)).toBe(true);
  });

  it("refills tokens over elapsed time up to capacity", () => {
    const reg = new TokenBucketRegistry();
    const cfg = { capacity: 2, refillPerSecond: 1 };
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(false);
    // advance 1s -> +1 token
    vi.advanceTimersByTime(1000);
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(false);
  });

  it("never refills above capacity", () => {
    const reg = new TokenBucketRegistry();
    const cfg = { capacity: 2, refillPerSecond: 5 };
    reg.tryTake("p", "a", cfg); // 1 left
    reg.tryTake("p", "a", cfg); // 0 left
    // advance a long time; refill 5/s capped at capacity 2
    vi.advanceTimersByTime(10_000);
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    expect(reg.tryTake("p", "a", cfg)).toBe(false);
  });

  it("does not refill when no time has elapsed", () => {
    const reg = new TokenBucketRegistry();
    const cfg = { capacity: 1, refillPerSecond: 1000 };
    expect(reg.tryTake("p", "a", cfg)).toBe(true);
    // same instant — elapsed is 0 so no refill
    expect(reg.tryTake("p", "a", cfg)).toBe(false);
  });

  it("adopts new capacity/refill when config changes for an existing bucket", () => {
    const reg = new TokenBucketRegistry();
    reg.tryTake("p", "a", { capacity: 1, refillPerSecond: 1 }); // empties bucket
    expect(reg.tryTake("p", "a", { capacity: 1, refillPerSecond: 1 })).toBe(false);
    // raise refill rate; after 1s one token comes back at new rate
    vi.advanceTimersByTime(1000);
    expect(reg.tryTake("p", "a", { capacity: 5, refillPerSecond: 1 })).toBe(true);
  });

  describe("penalize", () => {
    it("is a no-op for an unknown bucket", () => {
      const reg = new TokenBucketRegistry();
      expect(() => reg.penalize("p", "missing", 1000)).not.toThrow();
    });

    it("halves capacity and clamps current tokens", () => {
      const reg = new TokenBucketRegistry();
      const cfg = { capacity: 10, refillPerSecond: 0 };
      // create the bucket (starts full at 10)
      reg.tryTake("p", "a", cfg); // 9 left
      reg.penalize("p", "a", 60_000); // penalized capacity = 5, tokens clamped to 5
      // we should be able to take 5 then be blocked
      for (let i = 0; i < 5; i++) expect(reg.tryTake("p", "a", cfg)).toBe(true);
      expect(reg.tryTake("p", "a", cfg)).toBe(false);
    });

    it("penalized capacity floors at 1", () => {
      const reg = new TokenBucketRegistry();
      const cfg = { capacity: 1, refillPerSecond: 0 };
      reg.tryTake("p", "a", cfg); // 0 left, bucket exists
      reg.penalize("p", "a", 60_000); // floor(1/2)=0 -> max(1,0)=1
      vi.advanceTimersByTime(60_001); // refill 0/s so still 0, but tests penalty expiry path below
      expect(reg.tryTake("p", "a", cfg)).toBe(false);
    });

    it("restores full capacity after the penalty window expires", () => {
      const reg = new TokenBucketRegistry();
      const cfg = { capacity: 10, refillPerSecond: 100 };
      reg.tryTake("p", "a", cfg);
      reg.penalize("p", "a", 5_000);
      // within penalty window, capacity is clamped to 5
      vi.advanceTimersByTime(1_000);
      let taken = 0;
      while (reg.tryTake("p", "a", cfg)) taken++;
      expect(taken).toBe(5);
      // advance past the penalty; capacity restored to 10
      vi.advanceTimersByTime(5_000);
      taken = 0;
      while (reg.tryTake("p", "a", cfg)) taken++;
      expect(taken).toBe(10);
    });
  });

  describe("clear", () => {
    it("removes the bucket so it starts fresh", () => {
      const reg = new TokenBucketRegistry();
      const cfg = { capacity: 1, refillPerSecond: 0 };
      expect(reg.tryTake("p", "a", cfg)).toBe(true);
      expect(reg.tryTake("p", "a", cfg)).toBe(false);
      reg.clear("p", "a");
      // fresh bucket again at full capacity
      expect(reg.tryTake("p", "a", cfg)).toBe(true);
    });

    it("is safe to clear a non-existent bucket", () => {
      const reg = new TokenBucketRegistry();
      expect(() => reg.clear("p", "nope")).not.toThrow();
    });
  });
});
